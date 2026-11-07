import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const manifest = (path: string) =>
  JSON.parse(read(`${path}/package.json`)) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    engines: { node: string };
    files: string[];
    name: string;
    version: string;
  };
const majorMinor = (version: string | undefined) => /^\d+\.\d+/u.exec(version ?? '')?.[0];
const PUBLISHED = ['libs/aitrack-lib', 'apps/aitrack'];

it('applies supported TypeScript rules to Svelte script blocks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aitrack-lint-'));
  try {
    const file = join(dir, 'Probe.svelte');
    writeFileSync(
      file,
      '<script lang="ts">let value: any = 1; const count: number = 1; export const read = () => value + count;</script>',
    );
    const result = spawnSync(
      join(root, 'node_modules/.bin/oxlint'),
      ['--config', join(root, '.oxlintrc.json'), file],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('no-explicit-any');
    expect(result.stdout + result.stderr).toContain('no-inferrable-types');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('keeps the Tauri crate and npm packages on one major.minor', () => {
  const crate = /name = "tauri"\nversion = "([^"]+)"/u.exec(read('Cargo.lock'))?.[1];
  const api = manifest('apps/opentrack-ui').dependencies['@tauri-apps/api'];
  const cli = manifest('.').devDependencies['@tauri-apps/cli'];
  expect(majorMinor(crate)).toBeDefined();
  expect(majorMinor(api)).toBe(majorMinor(crate));
  expect(majorMinor(cli)).toBe(majorMinor(crate));
});

it('asks contributors for the Node that builds, and users for the Node that runs', () => {
  const buildMajor = read('.node-version').split('.')[0];
  expect(manifest('.').engines.node).toBe(`>=${String(buildMajor)}`);
  for (const path of PUBLISHED) expect(manifest(path).engines.node).toBe('>=24');
});

it.each(['libs/aitrack-lib', 'apps/aitrack', 'apps/opentrack-ui'])(
  'isolates %s tests from the developer environment',
  (path) => {
    expect(read(`${path}/vitest.config.ts`)).toContain('env: isolatedTestEnv()');
  },
);

describe.each(PUBLISHED)('the %s tarball', (path) => {
  it('carries the licence and no build cache', () => {
    expect(read(`${path}/LICENSE`)).toBe(read('LICENSE'));

    const dir = mkdtempSync(join(tmpdir(), 'aitrack-pack-'));
    try {
      const { files, name, version } = manifest(path);
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, files }));
      cpSync(join(root, path, 'LICENSE'), join(dir, 'LICENSE'));
      mkdirSync(join(dir, 'dist'));
      writeFileSync(join(dir, 'dist/tsconfig.tsbuildinfo'), '{}');
      writeFileSync(join(dir, 'dist/index.js'), '');

      const packed = spawnSync('bun', ['pm', 'pack', '--dry-run'], { cwd: dir, encoding: 'utf8' });

      expect(packed.status).toBe(0);
      expect(packed.stdout).toContain('LICENSE');
      expect(packed.stdout).toContain('dist/index.js');
      expect(packed.stdout).not.toContain('tsbuildinfo');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the publish workflow', () => {
  const workflow = read('.github/workflows/publish.yml');
  const jobs = workflow.slice(workflow.indexOf('\njobs:\n')).split(/^ {2}(?=[\w-]+:\n)/mu);
  const job = (name: string) => jobs.find((text) => text.startsWith(`${name}:`)) ?? '';

  it('gives the npm credential only to the job that installs and validates nothing', () => {
    expect(jobs.filter((text) => text.includes('id-token: write'))).toEqual([job('publish')]);
    expect(job('publish')).not.toMatch(/\bbun\b|\bnx\b|\bvalidate\b/u);
    expect(job('publish')).toContain('needs: draft-release');
    expect(job('draft-release')).toContain('needs: [npm-tarballs, opentrack]');
  });

  it('builds Linux packages on the Ubuntu its release notes name', () => {
    const ubuntu = /built on Ubuntu (\d+\.\d+)/u.exec(workflow)?.[1];
    expect(ubuntu).toBeDefined();
    expect(job('opentrack')).toContain(`- os: ubuntu-${String(ubuntu)}`);
  });
});
