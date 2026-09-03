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
 * Mount/unmount detection mirrors waveform.js exactly: watch the shared
 * <style id="voice-satellite-styles"> element for whether ITS OWN CSS
 * (which contains ".vs-aria") is the currently active skin's stylesheet —
 * that's the real, minimal-plumbing contract every skin here uses.
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

  const wrapper = document.createElement('div');
  wrapper.className = 'vs-aria';
  const frame = document.createElement('iframe');
  frame.src = ORB_URL;
  frame.title = 'ARIA';
  wrapper.appendChild(frame);

  let mounted = false;
  let lastState = null;

  function post(state) {
    if (state === lastState) return;
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

  function mount() {
    if (mounted) return;
    ui.appendChild(wrapper);
    mounted = true;
    post(readState());
  }

  function unmount() {
    if (!mounted) return;
    wrapper.remove();
    mounted = false;
    lastState = null;
  }

  // Same "is my CSS the active skin's CSS" check waveform.js uses — the
  // shared style tag's own text content is the source of truth for which
  // skin is selected right now.
  function checkSkinActive() {
    const styleEl = document.getElementById('voice-satellite-styles');
    const isActive = styleEl?.textContent.includes('.vs-aria') ?? false;
    if (isActive) mount();
    else unmount();
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

  // Real state changes: the bar's own class list, event-driven — no polling
  // loop needed since the orb's own page owns its animation frame.
  if (bar) {
    new MutationObserver(() => { if (mounted) post(readState()); })
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
