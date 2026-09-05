import { filterProviderDataByYear } from '../../data/dayMap.js';
import type { ProviderData } from '../../data/types.js';
import { activeProviderKeys } from '../providers.js';
import { mergeAllProviderDayMaps } from './merge.js';

export interface ProviderLayoutOptions {
  all?: boolean;
  year?: number;
}

export interface ProviderLayout {
  layoutData: ProviderData;
  keys: string[];
}

export function resolveProviderLayout(
  providerData: ProviderData,
  options: ProviderLayoutOptions = {},
): ProviderLayout {
  const filtered =
    options.year === undefined
      ? providerData
      : filterProviderDataByYear(providerData, options.year);

  if (options.all) {
    const merged = mergeAllProviderDayMaps(filtered);
    if (merged.size === 0) {
      return { layoutData: {}, keys: [] };
    }
    return { layoutData: { all: merged }, keys: ['all'] };
  }

  return { layoutData: filtered, keys: activeProviderKeys(filtered) };
}
