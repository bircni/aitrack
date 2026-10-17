import { expect, it, vi } from 'vitest';

import { createLogger, log, routeInfoToStderr } from '../output.js';

it('suppresses only progress when quiet and preserves stdout/stderr routing', () => {
  const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const quiet = createLogger({ quiet: true });
  quiet.info('hidden');
  quiet.warn('warning');
  quiet.error('failure');
  expect(info).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledWith('warning');
  expect(error).toHaveBeenCalledWith('failure');
  log.info('visible');
  expect(info).toHaveBeenCalledWith('visible');
  vi.restoreAllMocks();
});

it('moves progress to stderr for --json runs', () => {
  const original = log.info;
  const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  routeInfoToStderr();
  log.info('progress');
  log.info = original;
  expect(out).not.toHaveBeenCalled();
  expect(err).toHaveBeenCalledWith('progress');
  vi.restoreAllMocks();
});
