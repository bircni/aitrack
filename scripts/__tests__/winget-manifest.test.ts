import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../winget-manifest.ts', import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('writes the winget-pkgs manifests for a release installer', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aitrack-winget-manifest-'));
  temporaryDirectories.push(directory);
  const installer = join(directory, 'opentrack_3.2.0_x64-setup.exe');
  writeFileSync(installer, 'installer');

  const result = spawnSync(process.execPath, [SCRIPT, 'v3.2.0', installer, directory], {
    encoding: 'utf8',
  });

  expect(result.status).toBe(0);
  const manifests = join(directory, 'manifests/b/bircni/opentrack/3.2.0');
  expect(readdirSync(manifests).toSorted()).toEqual([
    'bircni.opentrack.installer.yaml',
    'bircni.opentrack.locale.en-US.yaml',
    'bircni.opentrack.yaml',
  ]);
  const installerManifest = readFileSync(
    join(manifests, 'bircni.opentrack.installer.yaml'),
    'utf8',
  );
  expect(installerManifest).toContain(
    'InstallerUrl: https://github.com/bircni/aitrack/releases/download/v3.2.0/opentrack_3.2.0_x64-setup.exe',
  );
  expect(installerManifest).toContain(
    'InstallerSha256: 9C0D294C05FC1D88D698034609BB81C0C69196327594E4C69D2915C80FD9850C',
  );
});
