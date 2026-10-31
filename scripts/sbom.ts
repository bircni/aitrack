#!/usr/bin/env tsx
// Bun has no SBOM command. npm resolves the packed manifests (workspace: and catalog:
// already rewritten) side by side, so the CLI finds the not yet published library.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { runMain } from './runMain.ts';

interface Manifest {
  name: string;
  version: string;
  devDependencies?: unknown;
}

interface Component {
  'bom-ref'?: string;
  name?: string;
  version?: string;
}

interface Bom {
  metadata: { component?: Component };
  components?: Component[];
  dependencies?: Array<{ ref: string }>;
}

function main(): void {
  const [outDirectory, ...tarballs] = process.argv.slice(2);
  if (outDirectory === undefined || tarballs.length === 0) {
    throw new Error('Usage: sbom.ts <out-dir> <package.tgz>...');
  }
  const workspace = mkdtempSync(join(tmpdir(), 'aitrack-sbom-'));
  try {
    const manifests = tarballs.map((tarball) => {
      const manifest = JSON.parse(
        execFileSync('tar', ['-xzOf', resolve(tarball), 'package/package.json'], {
          encoding: 'utf8',
        }),
      ) as Manifest;
      delete manifest.devDependencies;
      const directory = manifest.name.replaceAll('/', '__');
      mkdirSync(join(workspace, directory));
      writeFileSync(join(workspace, directory, 'package.json'), JSON.stringify(manifest));
      return { directory, manifest };
    });
    writeFileSync(
      join(workspace, 'package.json'),
      JSON.stringify({
        name: 'sbom',
        version: '0.0.0',
        private: true,
        workspaces: manifests.map(({ directory }) => directory),
      }),
    );
    const npm = (arguments_: string[]) =>
      execFileSync('npm', arguments_, { cwd: workspace, encoding: 'utf8', maxBuffer: 1 << 26 });
    npm(['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund']);

    mkdirSync(outDirectory, { recursive: true });
    for (const { directory, manifest } of manifests) {
      const bom = JSON.parse(
        npm([
          'sbom',
          '--sbom-format',
          'cyclonedx',
          '--package-lock-only',
          '--omit',
          'dev',
          '-w',
          directory,
        ]),
      ) as Bom;
      const root = bom.metadata.component?.['bom-ref'];
      // npm describes the temporary workspace root; describe the package instead.
      const self = bom.components?.find(
        ({ name, version }) => name === manifest.name && version === manifest.version,
      );
      if (self === undefined) throw new Error(`${manifest.name} missing from its own SBOM`);
      bom.metadata.component = self;
      bom.components = bom.components?.filter((component) => component !== self);
      bom.dependencies = bom.dependencies?.filter(({ ref }) => ref !== root);
      const file = join(outDirectory, `${manifest.name}-${manifest.version}.cdx.json`);
      writeFileSync(file, `${JSON.stringify(bom, undefined, 2)}\n`);
      console.log(file);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

runMain(import.meta.url, main);
