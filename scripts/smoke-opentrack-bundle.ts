import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { globSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getWorkspaceVersion } from './workspace-version.ts';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const version = getWorkspaceVersion();
const bundleRoot = join(repoRoot, 'target/release/bundle');
const temporary = mkdtempSync(join(tmpdir(), 'opentrack-bundle-smoke-'));
const cleanup: Array<() => void> = [];
const mountPoint = join(temporary, 'volume');

function onlyMatch(pattern: string, cwd: string): string {
  const matches = globSync(pattern, { cwd });
  assert.equal(matches.length, 1, `Expected exactly one ${pattern} in ${cwd}`);
  const match = matches[0];
  assert.ok(match);
  return join(cwd, match);
}

function extractApps(): string[] {
  if (process.platform === 'darwin') {
    const arch = process.arch === 'arm64' ? 'aarch64' : process.arch;
    const installer = onlyMatch(`opentrack_${version}_${arch}.dmg`, join(bundleRoot, 'dmg'));
    mkdirSync(mountPoint);
    execFileSync(
      'hdiutil',
      ['attach', installer, '-readonly', '-nobrowse', '-mountpoint', mountPoint],
      {
        stdio: 'pipe',
      },
    );
    cleanup.push(() => {
      execFileSync('hdiutil', ['detach', mountPoint], { stdio: 'pipe' });
    });
    return [onlyMatch('*.app/Contents/MacOS/opentrack', mountPoint)];
  }
  if (process.platform === 'linux') {
    const deb = onlyMatch(`opentrack_${version}_amd64.deb`, join(bundleRoot, 'deb'));
    const debRoot = join(temporary, 'deb');
    execFileSync('dpkg-deb', ['-x', deb, debRoot], { stdio: 'pipe' });
    const appImage = onlyMatch(`opentrack_${version}_amd64.AppImage`, join(bundleRoot, 'appimage'));
    // Runs only the AppImage runtime, which unpacks to ./squashfs-root without FUSE.
    execFileSync(appImage, ['--appimage-extract'], { cwd: temporary, stdio: 'pipe' });
    return [
      onlyMatch('usr/bin/opentrack', debRoot),
      onlyMatch('squashfs-root/usr/bin/opentrack', temporary),
    ];
  }
  assert.equal(process.platform, 'win32', 'Installer smoke checks require macOS, Linux or Windows');
  const installer = onlyMatch(`opentrack_${version}_x64-setup.exe`, join(bundleRoot, 'nsis'));
  const extracted = join(temporary, 'installer');
  // Unpack the installer without registering or launching an installed app.
  execFileSync('7z', ['x', installer, `-o${extracted}`, '-y'], { stdio: 'pipe' });
  return [onlyMatch('**/opentrack.exe', extracted)];
}

/** Starts the packaged app in its smoke-test mode, which answers before any window or tray exists. */
function checkApp(program: string, dataDir: string): void {
  mkdirSync(dataDir);
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ theme: 'dark' }));
  const result = spawnSync(program, ['--smoke-test', '--data-dir', dataDir], {
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `Packaged app failed: ${result.stderr}`);
  const messages: unknown[] = result.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown);
  assert.equal(messages.length, 2, 'Expected the settings and the state');
  const [settings, state] = messages as [
    { id: number; result?: { theme?: string } },
    { id: number; result?: { providers?: unknown[]; refreshing?: boolean } },
  ];
  assert.equal(settings.id, 1);
  assert.equal(settings.result?.theme, 'dark');
  assert.equal(state.id, 2);
  assert.ok(state.result);
  assert.equal(state.result.providers?.length, 3);
  assert.equal(state.result.refreshing, false);
  assert.deepEqual(JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')), {
    theme: 'dark',
  });
}

try {
  for (const [index, program] of extractApps().entries()) {
    checkApp(program, join(temporary, `data-${String(index)}`));
  }
  console.log('Packaged app started, read isolated settings and reported its state.');
} finally {
  for (const clean of cleanup) clean();
  // Windows can keep the exited app's image locked for a moment.
  rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
