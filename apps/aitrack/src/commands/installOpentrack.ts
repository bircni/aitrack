import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isRecord } from 'aitrack-lib/data/guards';
import { log } from 'aitrack-lib/output';

import { OPENTRACK_PUBLIC_KEY, verifyMinisign } from '../minisign.js';

/** The manifest opentrack's own updater reads; prereleases never become "latest". */
const MANIFEST_URL = 'https://github.com/bircni/aitrack/releases/latest/download/latest.json';
const MANIFEST_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const APP_NAME = 'opentrack.app';

export interface InstallOpentrackOptions {
  /** macOS: the folder opentrack.app goes into. */
  dir?: string;
}

interface Release {
  version: string;
  url: string;
  signature: string;
}

/** Tauri's updater target for this machine; only those the release workflow builds. */
function updaterTarget(): string {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'darwin-aarch64';
  if (process.platform === 'win32' && process.arch === 'x64') return 'windows-x86_64';
  throw new Error(
    `opentrack has no build for ${process.platform} ${process.arch}; releases cover Apple Silicon Macs and 64-bit Windows.`,
  );
}

async function latestRelease(target: string): Promise<Release> {
  const response = await fetch(MANIFEST_URL, { signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(
      `Could not find the latest opentrack release (HTTP ${String(response.status)}).`,
    );
  }
  const manifest: unknown = await response.json();
  const platforms = isRecord(manifest) && isRecord(manifest.platforms) ? manifest.platforms : {};
  const asset = platforms[target];
  if (
    !isRecord(manifest) ||
    typeof manifest.version !== 'string' ||
    !isRecord(asset) ||
    typeof asset.url !== 'string' ||
    typeof asset.signature !== 'string'
  ) {
    throw new Error(`The latest opentrack release has no ${target} build.`);
  }
  return { version: manifest.version, url: asset.url, signature: asset.signature };
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Download failed (HTTP ${String(response.status)}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

function run(command: string, args: string[], stdio: 'inherit' | 'pipe'): void {
  const result = spawnSync(command, args, { stdio, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    throw new Error(
      `${command} exited with code ${String(result.status)}${detail ? `: ${detail}` : ''}`,
    );
  }
}

/** Unpacks next to the destination so swapping in the new app is a same-volume rename. */
function installMacApp(archive: Buffer, dir: string): string {
  const staging = mkdtempSync(join(dir, '.opentrack-install-'));
  try {
    const archivePath = join(staging, 'opentrack.app.tar.gz');
    writeFileSync(archivePath, archive);
    run('tar', ['-xzf', archivePath, '-C', staging], 'pipe');
    const destination = join(dir, APP_NAME);
    const previous = join(staging, 'previous.app');
    if (existsSync(destination)) renameSync(destination, previous);
    try {
      renameSync(join(staging, APP_NAME), destination);
    } catch (error) {
      if (existsSync(previous)) renameSync(previous, destination);
      throw error;
    }
    return destination;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function runWindowsInstaller(installer: Buffer): void {
  const directory = mkdtempSync(join(tmpdir(), 'aitrack-opentrack-'));
  try {
    const path = join(directory, 'opentrack-setup.exe');
    writeFileSync(path, installer);
    run(path, [], 'inherit');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function installOpentrackCommand(
  options: InstallOpentrackOptions = {},
): Promise<void> {
  const target = updaterTarget();
  const release = await latestRelease(target);
  log.info(`Downloading opentrack ${release.version}...`);
  const file = await download(release.url);
  if (!verifyMinisign(file, release.signature, OPENTRACK_PUBLIC_KEY)) {
    throw new Error('The download does not match its release signature; nothing was installed.');
  }
  if (process.platform === 'win32') {
    log.info('Running the opentrack installer...');
    runWindowsInstaller(file);
    log.info(`Installed opentrack ${release.version}.`);
    return;
  }
  const path = installMacApp(file, options.dir ?? '/Applications');
  log.info(`Installed opentrack ${release.version} to ${path}.`);
  log.info('It updates itself from now on. If it was running, quit and reopen it.');
}
