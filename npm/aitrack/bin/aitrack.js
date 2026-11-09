#!/usr/bin/env node
'use strict';
// Runs the native binary from this platform's package; without it (npm can skip optional
// dependencies), downloads the same binary from the GitHub release and checks its SHA-256.

const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { version } = require('../package.json');
const TARGETS = require('../targets.json');

const target = `${process.platform}-${process.arch}`;
const binary = process.platform === 'win32' ? 'aitrack.exe' : 'aitrack';

function fail(message) {
  console.error(`aitrack: ${message}`);
  process.exit(1);
}

function installedBinary() {
  try {
    return require.resolve(`${TARGETS[target]}/bin/${binary}`);
  } catch {
    return null;
  }
}

function cacheDir() {
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
      : process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'aitrack', version);
}

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) fail(`download failed (HTTP ${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function downloadedBinary() {
  const destination = path.join(cacheDir(), binary);
  if (fs.existsSync(destination)) return destination;
  const asset = `aitrack-${target}${process.platform === 'win32' ? '.exe' : ''}`;
  const base = `https://github.com/bircni/aitrack/releases/download/v${version}`;
  console.error(
    `aitrack: ${TARGETS[target]} is not installed; downloading ${asset} from the v${version} release.`,
  );
  const [data, sums] = await Promise.all([
    download(`${base}/${asset}`),
    download(`${base}/checksums.txt`),
  ]);
  const line = sums
    .toString('utf8')
    .split('\n')
    .find((l) => l.trim().endsWith(` ${asset}`) || l.trim().endsWith(`*${asset}`));
  const expected = line?.trim().split(/\s+/)[0];
  if (expected !== createHash('sha256').update(data).digest('hex'))
    fail(`${asset} does not match checksums.txt`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const staging = `${destination}.${process.pid}.download`;
  fs.writeFileSync(staging, data, { mode: 0o755 });
  fs.renameSync(staging, destination);
  return destination;
}

async function main() {
  if (!(target in TARGETS)) {
    fail(
      `no build for ${process.platform} ${process.arch}; releases cover ${Object.keys(TARGETS).join(', ')}.`,
    );
  }
  const executable = installedBinary() ?? (await downloadedBinary());
  const result = spawnSync(executable, process.argv.slice(2), { stdio: 'inherit' });
  if (result.error) fail(result.error.message);
  if (result.signal) process.kill(process.pid, result.signal);
  process.exit(result.status ?? 1);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
