/**
 * The tray can run with no renderer. Open the window for a first launch, an
 * explicit show request, or when menu-bar-only mode is off.
 */
export function shouldOpenWindow(input: {
  forceShow: boolean;
  onboarded: boolean;
  menuBarOnly: boolean;
}): boolean {
  if (input.forceShow || !input.onboarded) return true;
  return !input.menuBarOnly;
}
