/**
 * A chat screen owns the whole window, so the app-wide navigation lives behind
 * one button in the chat header instead of a permanent sidebar. The button does
 * not own the drawer — the shell does — so it asks for it with an event; this
 * keeps the screen free of shell state and works the same on desktop and phone.
 */
export const OPEN_APP_NAV_EVENT = "air:open-app-nav";

export function openAppNav(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(OPEN_APP_NAV_EVENT));
}
