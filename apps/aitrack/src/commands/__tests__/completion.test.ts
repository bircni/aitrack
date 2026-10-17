import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { buildProgram } from '../../cli/program.js';
import { COMPLETION_SHELLS, completionScript } from '../completion.js';

const hasShell = (shell: string): boolean => {
  try {
    execFileSync(shell, ['-c', 'true']);
    return true;
  } catch {
    return false;
  }
};

describe('completionScript', () => {
  it.each(COMPLETION_SHELLS)('lists commands and nested flags for %s', (shell) => {
    const script = completionScript(buildProgram(), shell);
    expect(script).toContain('usage');
    expect(script).toContain('install-opentrack');
    expect(script).toMatch(/(--| -l )providers/u);
    expect(script).toContain('today');
  });

  it.runIf(hasShell('bash'))('completes nested subcommands in bash', () => {
    const script = completionScript(buildProgram(), 'bash');
    const out = execFileSync(
      'bash',
      [
        '-c',
        `${script}\nCOMP_WORDS=(aitrack usage to); COMP_CWORD=2; _aitrack; printf '%s\\n' "\${COMPREPLY[@]}"`,
      ],
      { encoding: 'utf8' },
    );
    expect(out.split('\n')).toContain('today');
    expect(out).not.toContain('sync');
  });

  it.runIf(hasShell('bash'))('completes flags after a subcommand in bash', () => {
    const script = completionScript(buildProgram(), 'bash');
    const out = execFileSync(
      'bash',
      [
        '-c',
        `${script}\nCOMP_WORDS=(aitrack top --so); COMP_CWORD=2; _aitrack; printf '%s\\n' "\${COMPREPLY[@]}"`,
      ],
      { encoding: 'utf8' },
    );
    expect(out.trim()).toBe('--sort');
  });
});
