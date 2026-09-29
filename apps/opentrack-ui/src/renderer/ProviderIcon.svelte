<script lang="ts">
  import type { QuotaProviderKey } from '../shared/types.js';
  import claude from './assets/claude.svg?raw';
  import codex from './assets/codex.svg?raw';
  import cursor from './assets/cursor.svg?raw';

  interface Props {
    provider: QuotaProviderKey;
    size?: number;
  }

  let { provider, size = 17 }: Props = $props();

  // Marks from OpenQuota (MIT); each is a single path.
  const SOURCES: Record<QuotaProviderKey, string> = { claude_code: claude, codex, cursor };
  const source = $derived(SOURCES[provider]);
  const path = $derived(/ d="([^"]+)"/u.exec(source)?.[1] ?? '');
  const viewBox = $derived(/viewBox="([^"]+)"/u.exec(source)?.[1] ?? '0 0 100 100');
</script>

<svg
  class="provider-icon provider-icon--{provider}"
  width={size}
  height={size}
  {viewBox}
  aria-hidden="true"
>
  <path d={path} fill="currentColor" />
</svg>

<style>
  .provider-icon {
    display: block;
    flex: 0 0 auto;
    color: var(--ink);
  }

  .provider-icon--claude_code {
    color: var(--provider-claude);
  }
</style>
