import { describe, expect, it } from 'vitest';

import { collectDoctorChecks } from '../doctor.js';

describe('collectDoctorChecks', () => {
  it('reports the runtime, git, config, and the data repo', async () => {
    const checks = await collectDoctorChecks();
    const labels = checks.map((check) => check.label);
    expect(labels).toContain('Node.js');
    expect(labels).toContain('git');
    expect(labels).toContain('Config');
    expect(labels).toContain('Data repo');
    expect(checks.find((check) => check.label === 'Node.js')?.status).toBe('ok');
    expect(checks.find((check) => check.label === 'git')?.status).toBe('ok');
    expect(checks.every((check) => check.detail.length > 0)).toBe(true);
  });
});
