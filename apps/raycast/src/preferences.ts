import { getPreferenceValues } from '@raycast/api';
import type { QuotaProviderKey } from 'aitrack-lib/quota/types';

import type { LimitDisplay, ResetDisplay } from './format.js';

interface ExtensionPreferences {
  claude: boolean;
  codex: boolean;
  cursor: boolean;
  display: LimitDisplay;
  resetDisplay: ResetDisplay;
}

export interface Preferences {
  providers: QuotaProviderKey[];
  display: LimitDisplay;
  resetDisplay: ResetDisplay;
}

export function preferences(): Preferences {
  const values = getPreferenceValues<ExtensionPreferences>();
  const enabled: Record<QuotaProviderKey, boolean> = {
    claude_code: values.claude,
    codex: values.codex,
    cursor: values.cursor,
  };
  return {
    providers: (Object.keys(enabled) as QuotaProviderKey[]).filter((key) => enabled[key]),
    display: values.display,
    resetDisplay: values.resetDisplay,
  };
}
