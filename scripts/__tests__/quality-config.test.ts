import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
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
