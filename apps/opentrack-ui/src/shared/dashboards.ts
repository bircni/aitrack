import dashboards from './provider-dashboards.json' with { type: 'json' };
import type { QuotaProviderKey } from './types.js';

/** Browser consoles for re-auth; same file the Tauri shell embeds. */
export const PROVIDER_DASHBOARDS: Record<QuotaProviderKey, string> = dashboards;
