import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { readPackageVersion } from '../version.js';

it('uses a placeholder for invalid package metadata and the injected version for bundled builds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aitrack-version-'));
  try {
    for (const value of ['null', '"text"', '{}', '{"version":42}', '{"version":""}', '{']) {
      writeFileSync(join(dir, 'package.json'), value);
      expect(readPackageVersion(join(dir, 'src'))).toBe('0.0.0');
    }
    writeFileSync(join(dir, 'package.json'), '{"version":"1.2.3"}');
    expect(readPackageVersion(join(dir, 'src'))).toBe('1.2.3');
    vi.stubGlobal('__AITRACK_LIB_VERSION__', '9.0.0');
    vi.resetModules();
    const bundled = await import('../version.js');
    expect(bundled.packageVersion()).toBe('9.0.0');
  } finally {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  }
});
