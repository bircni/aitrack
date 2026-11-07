<script lang="ts">
  import type { ProviderState } from '../shared/types.js';
  import ProviderIcon from './ProviderIcon.svelte';

  let { provider }: { provider: ProviderState } = $props();
</script>

<span class="p-mark"><ProviderIcon provider={provider.key} size={18} /></span>
<span class="p-identity">
  <span class="p-name">{provider.label}</span>
  {#if provider.quota?.plan}<span class="p-plan">{provider.quota.plan}</span>{/if}
</span>
