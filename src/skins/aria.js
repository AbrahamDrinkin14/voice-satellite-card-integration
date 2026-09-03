/**
 * ARIA Skin
 *
 * Puts the real ARIA neural orb — the same WebGL renderer that ships inside
 * the ARIA Swift apps, see /local/aria-orb/ — in the overlay's background,
 * driven by the bar's own state classes. No native rainbow bar, no local
 * animation loop of our own: the iframe owns its render loop entirely; this
 * module only mounts/unmounts it and forwards state changes.
 *
 * Full-bleed rather than the banded `.vs-waveform` convention other skins
 * use — the orb is meant to be the main focus of the screen, with the
 * existing chat text (z-index above this layer, untouched) streaming over
 * it, not confined to a middle strip.
 *
 * IFRAME LIFECYCLE — deliberately stricter than a canvas-based skin needs:
 * #voice-satellite-ui is a GLOBAL element present on every HA page (per the
 * integration's own README: "loads globally on every page"), not something
 * scoped to an active voice session. A canvas-based skin can safely stay
 * mounted at opacity:0/pointer-events:none the whole time a household is
 * just browsing dashboards, because a plain element's pointer-events is
 * unambiguous. An iframe is a separate browsing context, and real-world
 * mobile WebViews (including the HA Companion App) do not always honor an
 * ancestor's pointer-events:none for an iframe reliably -- confirmed by
 * hitting this directly: an always-mounted iframe here blocked page
 * scrolling everywhere in HA while the ARIA skin was merely selected, not
 * even while a voice session was open.
 *
 * Fix: only create the iframe while BOTH the ARIA skin is active AND the
 * overlay is genuinely visible (.vs-blur-overlay.visible, the same signal
 * every skin's own expensive-work gating already keys off). The moment
 * either goes false, the iframe is torn down completely, not just hidden --
 * there is never an idle iframe sitting in the page.
 *
 * Mount/unmount CSS-active detection mirrors waveform.js: watch the shared
 * <style id="voice-satellite-styles"> element for whether ITS OWN CSS
 * (which contains ".vs-aria") is the currently active skin's stylesheet.
 */

import css from './aria.css';
import previewCSS from './aria-preview.css';

// Where the shared orb asset lives — see homeassistant/aria-orb/README.md.
// It auto-picks its own render preset (particle/filament density) from the
// iframe's actual measured size, so no ?preset= override is passed here.
const ORB_URL = '/local/aria-orb/aria-orb.html';

// Bar animation class -> orb state. 'connecting' (brief, right after wake
// word, before STT starts streaming) has no distinct orb state of its own;
// 'listening' is the closest honest fit. There is no live "error" signal on
// this element — ui.js's own comment: runtime errors surface through the
// toast component instead — so the orb's error state is never driven here.
const STATE_MAP = {
  connecting: 'listening',
  listening: 'listening',
  processing: 'thinking',
  speaking: 'speaking',
};

let _setupDone = false;

function setup() {
  const ui = document.getElementById('voice-satellite-ui');
  if (!ui) return false;
  if (_setupDone) return true;
  _setupDone = true;

  const bar = ui.querySelector('.vs-rainbow-bar');
  const overlayEl = ui.querySelector('.vs-blur-overlay');

  let wrapper = null;   // null whenever the iframe does not exist
  let frame = null;
  let skinActive = false;
  let overlayVisible = false;
  let lastState = null;

  function post(state) {
    if (!frame || state === lastState) return;
    lastState = state;
    frame.contentWindow?.postMessage({ type: 'aria-orb', state }, '*');
  }

  function readState() {
    if (!bar || !bar.classList.contains('visible')) return 'idle';
    for (const cls of Object.keys(STATE_MAP)) {
      if (bar.classList.contains(cls)) return STATE_MAP[cls];
    }
    return 'listening'; // visible, but no recognized animation class yet
  }

  function ensureMounted() {
    if (wrapper) return;
    wrapper = document.createElement('div');
    wrapper.className = 'vs-aria';
    frame = document.createElement('iframe');
    frame.src = ORB_URL;
    frame.title = 'ARIA';
    wrapper.appendChild(frame);
    ui.appendChild(wrapper);
    lastState = null;
  }

  function teardown() {
    if (!wrapper) return;
    wrapper.remove();
    wrapper = null;
    frame = null;
    lastState = null;
  }

  // The single place both signals (skin selected, overlay open) combine.
  // Only ever mounted while both are true.
  function sync() {
    if (skinActive && overlayVisible) {
      ensureMounted();
      post(readState());
    } else {
      teardown();
    }
  }

  // Same "is my CSS the active skin's CSS" check waveform.js uses — the
  // shared style tag's own text content is the source of truth for which
  // skin is selected right now.
  function checkSkinActive() {
    const styleEl = document.getElementById('voice-satellite-styles');
    skinActive = styleEl?.textContent.includes('.vs-aria') ?? false;
    sync();
  }

  function observeStyleEl() {
    const el = document.getElementById('voice-satellite-styles');
    if (el) {
      new MutationObserver(checkSkinActive).observe(el, { childList: true, characterData: true, subtree: true });
      checkSkinActive();
      return;
    }
    // Style element doesn't exist yet — watch <head> for its creation.
    const headObs = new MutationObserver(() => {
      const created = document.getElementById('voice-satellite-styles');
      if (created) {
        headObs.disconnect();
        new MutationObserver(checkSkinActive).observe(created, { childList: true, characterData: true, subtree: true });
        checkSkinActive();
      }
    });
    headObs.observe(document.head, { childList: true });
  }
  observeStyleEl();

  // The overlay's own open/close signal — mirrors waveform.js's overlayEl
  // pattern exactly, since this is the same gate every skin's real work
  // already keys off, just applied here to mounting the iframe at all
  // rather than only to starting/stopping a render loop.
  if (overlayEl) {
    overlayVisible = overlayEl.classList.contains('visible');
    new MutationObserver(() => {
      overlayVisible = overlayEl.classList.contains('visible');
      sync();
    }).observe(overlayEl, { attributes: true, attributeFilter: ['class'] });
  }

  // Real state changes: the bar's own class list, event-driven — no polling
  // loop needed since the orb's own page owns its animation frame.
  if (bar) {
    new MutationObserver(() => { if (wrapper) post(readState()); })
      .observe(bar, { attributes: true, attributeFilter: ['class'] });
  }

  return true;
}

export function ensureAriaSkinRuntime() {
  if (setup()) return;
  const bodyObs = new MutationObserver(() => {
    if (document.getElementById('voice-satellite-ui')) {
      bodyObs.disconnect();
      setup();
    }
  });
  bodyObs.observe(document.body, { childList: true });
}

// ── Skin export ──────────────────────────────────────────────────────

export const ariaSkin = {
  id: 'aria',
  name: 'ARIA',
  css,
  // Doesn't read --vs-audio-level — orb state is driven by discrete bar
  // classes (listening/processing/speaking), not live amplitude.
  reactiveBar: false,
  overlayColor: [6, 13, 33],       // ARIA navyBase, dark-first by design
  darkOverlayColor: [6, 13, 33],
  defaultOpacity: 1,
  darkDefaultOpacity: 1,
  previewCSS,
};
