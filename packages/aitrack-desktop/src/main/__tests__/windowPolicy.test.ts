import { expect, it } from 'vitest';

import { shouldOpenWindow } from '../windowPolicy.js';

it('leaves the renderer unloaded for a returning menu-bar session', () => {
  expect(shouldOpenWindow({ forceShow: false, onboarded: true, menuBarOnly: true })).toBe(false);
});

it('opens the window for a first launch, a forced show, or a normal dock app', () => {
  expect(shouldOpenWindow({ forceShow: false, onboarded: false, menuBarOnly: true })).toBe(true);
  expect(shouldOpenWindow({ forceShow: true, onboarded: true, menuBarOnly: true })).toBe(true);
  expect(shouldOpenWindow({ forceShow: false, onboarded: true, menuBarOnly: false })).toBe(true);
});
