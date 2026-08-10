/**
 * Top-Layer Promotion Helpers
 *
 * Recent Home Assistant frontend menus (ha-dropdown and friends) render
 * through the native Popover API, which paints in the browser top layer,
 * above every z-index on the page. No z-index can cover them (#126); the
 * only way for our full-screen overlays to win is to join the top layer
 * themselves. Within the top layer, whichever popover was shown last
 * paints on top, so re-showing an element moves it to the front.
 *
 * Old kiosk WebViews (pre-Chromium 114) lack the Popover API; there these
 * helpers are no-ops and stacking falls back to plain z-index, which is
 * also all those engines' menus use.
 */

export function supportsTopLayer() {
  return typeof HTMLElement.prototype.showPopover === 'function';
}

/**
 * Move `el` to the front of the browser top layer, converting it into a
 * manual popover if it is not one yet. Manual popovers ignore Esc and
 * outside clicks and do not close other popovers when shown. Returns
 * true when the element is in the top layer afterwards.
 */
export function promoteToTopLayer(el) {
  if (!el || !el.isConnected || !supportsTopLayer()) return false;
  try {
    if (el.popover !== 'manual') el.popover = 'manual';
    if (el.matches(':popover-open')) el.hidePopover();
    el.showPopover();
    return true;
  } catch (_e) {
    // A popover attribute on a closed popover means display:none, which
    // would blank the element for good -- drop back to z-index stacking.
    try { el.removeAttribute('popover'); } catch (_e2) { /* ignore */ }
    return false;
  }
}

/** Remove `el` from the top layer. No-op if it is not there. */
export function demoteFromTopLayer(el) {
  if (!el || !supportsTopLayer()) return;
  try {
    if (el.matches(':popover-open')) el.hidePopover();
  } catch (_e) {
    // Already hidden or disconnected -- nothing to do.
  }
}
