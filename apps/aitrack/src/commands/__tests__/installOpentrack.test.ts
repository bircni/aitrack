import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawnSync: vi.fn(), verifyMinisign: vi.fn() }));
vi.mock('node:child_process', () => ({ spawnSync: mocks.spawnSync }));
vi.mock('../../minisign.js', () => ({
  OPENTRACK_PUBLIC_KEY: 'release-key',
  verifyMinisign: mocks.verifyMinisign,
}));

import { installOpentrackCommand } from '../installOpentrack.js';

const MANIFEST = {
  version: '3.1.0',
  platforms: {
    'darwin-aarch64': { url: 'https://example.test/opentrack.app.tar.gz', signature: 'mac-sig' },
    'windows-x86_64': { url: 'https://example.test/opentrack-setup.exe', signature: 'win-sig' },
  },
};

let dir: string;
const fetchMock = vi.fn<typeof fetch>();
const originals = {
  platform: Object.getOwnPropertyDescriptor(process, 'platform'),
  arch: Object.getOwnPropertyDescriptor(process, 'arch'),
};

function onMachine(platform: NodeJS.Platform, arch: NodeJS.Architecture): void {
  Object.defineProperty(process, 'platform', { value: platform });
  Object.defineProperty(process, 'arch', { value: arch });
}

function serve(manifest: unknown = MANIFEST): void {
  fetchMock.mockImplementation((input) =>
    Promise.resolve(
      input === 'https://github.com/bircni/aitrack/releases/latest/download/latest.json'
        ? Response.json(manifest)
        : new Response(Buffer.from('package')),
    ),
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aitrack-install-opentrack-'));
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  mocks.verifyMinisign.mockReturnValue(true);
  // Stands in for tar: unpack a fresh app bundle into the -C folder.
  mocks.spawnSync.mockImplementation((command: string, args: string[]) => {
    if (command === 'tar') {
      const app = join(args[3] ?? '', 'opentrack.app');
      mkdirSync(app);
      writeFileSync(join(app, 'version'), '3.1.0');
    }
    return { status: 0, stderr: '' };
  });
  serve();
});

afterEach(() => {
  for (const [key, descriptor] of Object.entries(originals)) {
    if (descriptor) Object.defineProperty(process, key, descriptor);
  }
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('installOpentrackCommand', () => {
  it('replaces the app on a Mac with the verified release, leaving nothing staged', async () => {
    onMachine('darwin', 'arm64');
    mkdirSync(join(dir, 'opentrack.app'));
    writeFileSync(join(dir, 'opentrack.app', 'version'), '3.0.0');

    await installOpentrackCommand({ dir });

    expect(mocks.verifyMinisign).toHaveBeenCalledWith(
      Buffer.from('package'),
      'mac-sig',
      'release-key',
    );
    expect(readFileSync(join(dir, 'opentrack.app', 'version'), 'utf8')).toBe('3.1.0');
    expect(readdirSync(dir)).toEqual(['opentrack.app']);
  });

  it('restores the previous app when the new one cannot be moved into place', async () => {
    onMachine('darwin', 'arm64');
    mkdirSync(join(dir, 'opentrack.app'));
    writeFileSync(join(dir, 'opentrack.app', 'version'), '3.0.0');
    mocks.spawnSync.mockReturnValue({ status: 0, stderr: '' }); // tar "succeeds" without extracting

    await expect(installOpentrackCommand({ dir })).rejects.toThrow('ENOENT');
    expect(readFileSync(join(dir, 'opentrack.app', 'version'), 'utf8')).toBe('3.0.0');
    expect(readdirSync(dir)).toEqual(['opentrack.app']);
  });

  it('installs nothing when the download does not match its signature', async () => {
    onMachine('darwin', 'arm64');
    mocks.verifyMinisign.mockReturnValue(false);

    await expect(installOpentrackCommand({ dir })).rejects.toThrow(
      'does not match its release signature',
    );
    expect(mocks.spawnSync).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'opentrack.app'))).toBe(false);
  });

  it('reports failed downloads and unpacking without leaving files behind', async () => {
    onMachine('darwin', 'arm64');
    mocks.spawnSync.mockReturnValue({ status: 1, stderr: 'tar: truncated input\n' });
    await expect(installOpentrackCommand({ dir })).rejects.toThrow(
      'tar exited with code 1: tar: truncated input',
    );
    mocks.spawnSync.mockReturnValue({ error: new Error('spawn tar ENOENT') });
    await expect(installOpentrackCommand({ dir })).rejects.toThrow('spawn tar ENOENT');
    expect(readdirSync(dir)).toEqual([]);

    fetchMock.mockResolvedValueOnce(Response.json(MANIFEST));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(installOpentrackCommand({ dir })).rejects.toThrow('Download failed (HTTP 503)');
  });

  it('runs the Windows installer and reports when it fails', async () => {
    onMachine('win32', 'x64');

    await installOpentrackCommand();
    expect(mocks.spawnSync).toHaveBeenCalledWith(
      expect.stringContaining('opentrack-setup.exe'),
      [],
      expect.objectContaining({ stdio: 'inherit' }),
    );
    expect(mocks.verifyMinisign).toHaveBeenCalledWith(expect.any(Buffer), 'win-sig', 'release-key');

    mocks.spawnSync.mockReturnValue({ status: 2 });
    await expect(installOpentrackCommand()).rejects.toThrow('exited with code 2');
    await expect(installOpentrackCommand({ dir })).rejects.toThrow('--dir applies to macOS only');
  });

  it('explains machines and releases it cannot install on', async () => {
    onMachine('linux', 'x64');
    await expect(installOpentrackCommand()).rejects.toThrow('opentrack has no build for linux x64');

    onMachine('win32', 'x64');
    serve({ version: '3.1.0', platforms: {} });
    await expect(installOpentrackCommand()).rejects.toThrow('has no windows-x86_64 build');

    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    await expect(installOpentrackCommand()).rejects.toThrow('HTTP 404');
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });
});
