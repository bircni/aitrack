import { expect, it } from 'vitest';

import { PROVIDERS } from '../../../providers/index.js';
import { getProviderTheme, providerCells } from '../themes.js';

it('uses a provider ramp when it has one and the default otherwise', () => {
  const [provider] = PROVIDERS;
  expect(providerCells(provider?.descriptor.key ?? '', 'dark')).toEqual(provider?.heatmap.dark);
  expect(providerCells('unknown', 'light')).toEqual(providerCells('_default', 'light'));
  expect(getProviderTheme('unknown').cells).toEqual(providerCells('_default', 'light'));
  expect(getProviderTheme('unknown', true).cells).toEqual(providerCells('_default', 'dark'));
});
