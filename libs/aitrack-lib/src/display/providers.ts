/**
 * Public subpath for provider labels and ordering.
 *
 * The implementation lives on the registry — this file exists so
 * `aitrack-lib/display/providers` keeps working.
 */
export {
  activeProviderKeys,
  costColumnLabel,
  normalizeProviderKey,
  orderedProviderKeys,
  PROVIDER_LABELS,
  providerLabel,
  sortProviderKeys,
} from '../providers/registry.js';
