// @vitest-environment jsdom
import { mount, unmount } from 'svelte';
import { expect, it, vi } from 'vitest';
vi.mock('../assets/claude.svg?raw', () => ({ default: '<svg></svg>' }));
import ProviderIcon from '../ProviderIcon.svelte';

it('renders a safe empty mark if an asset has no path or viewBox', async () => {
  const target = document.createElement('div');
  const component = mount(ProviderIcon, { target, props: { provider: 'claude_code' } });
  expect(target.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 100 100');
  expect(target.querySelector('path')?.getAttribute('d')).toBe('');
  await unmount(component);
});
