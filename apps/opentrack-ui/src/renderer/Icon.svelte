<script lang="ts">
  type IconName =
    | 'back'
    | 'chevron-down'
    | 'chevron-up'
    | 'cloud'
    | 'laptop'
    | 'pin'
    | 'pin-filled'
    | 'refresh'
    | 'sliders'
    | 'sync';

  interface Props {
    name: IconName;
    size?: number;
  }

  let { name, size = 16 }: Props = $props();
</script>

<svg
  class="glyph"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.8"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#if name === 'back'}
    <path d="m14.5 5-7 7 7 7" />
  {:else if name === 'chevron-down'}
    <path d="m6 9 6 6 6-6" />
  {:else if name === 'chevron-up'}
    <path d="m6 15 6-6 6 6" />
  {:else if name === 'laptop'}
    <rect x="4.5" y="5" width="15" height="10.5" rx="1.5" /><path d="M2.5 19h19" />
  {:else if name === 'cloud'}
    <path d="M7 18a4.5 4.5 0 0 1-.4-9A6 6 0 0 1 18 9.5a4 4 0 0 1-.5 8.5Z" />
  {:else if name === 'refresh'}
    <path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" />
  {:else if name === 'sync'}
    <path d="M7 18a4.5 4.5 0 0 1-.4-9A6 6 0 0 1 18 9.5a4 4 0 0 1-.5 8.5" /><path
      d="m9 15 3-3 3 3M12 12v8"
    />
  {:else if name === 'sliders'}
    <path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle
      cx="10"
      cy="17"
      r="2"
    />
  {:else if name === 'pin'}
    <path d="M9 3h6v4.2c0 1.7.7 3.1 2 4.3V13H7v-1.5c1.3-1.2 2-2.6 2-4.3V3Z" /><path d="M12 13v8" />
  {:else if name === 'pin-filled'}
    <path
      d="M9 3h6v4.2c0 1.7.7 3.1 2 4.3V13H7v-1.5c1.3-1.2 2-2.6 2-4.3V3Z"
      fill="currentColor"
    /><path d="M12 13v8" />
  {/if}
</svg>

<style>
  .glyph {
    display: block;
    flex: 0 0 auto;
  }
</style>
