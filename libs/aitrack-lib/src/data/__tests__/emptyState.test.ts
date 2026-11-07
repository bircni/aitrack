import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ tryLoadConfig: vi.fn(), isCloned: vi.fn() }));
vi.mock('../../config.js', () => ({ tryLoadConfig: mocks.tryLoadConfig }));
vi.mock('../../git.js', () => ({ isCloned: mocks.isCloned }));
import { isUsageNotConfigured, usageEmptyMessage, usageEmptyWindowMessage } from '../emptyState.js';

it('distinguishes setup, missing usage and empty calendar windows', () => {
  expect(isUsageNotConfigured()).toBe(true);
  mocks.tryLoadConfig.mockReturnValue({ repoUrl: 'repo' });
  expect(isUsageNotConfigured()).toBe(true);
  mocks.isCloned.mockReturnValue(true);
  expect(isUsageNotConfigured()).toBe(false);
  expect(usageEmptyMessage(true)).toContain('init');
  expect(usageEmptyMessage(true)).toContain('doctor');
  expect(usageEmptyMessage()).toContain('sync');
  expect(usageEmptyMessage(false, ['cursor', 'codex'])).toBe(
    'No usage found for Cursor, Codex. Run: npx aitrack doctor to see which sources were checked.',
  );
  expect(usageEmptyWindowMessage('today')).toBe('No usage recorded for today.');
  expect(usageEmptyWindowMessage()).toBe('No usage recorded.');
});
