/**
 * Element volume with a gain fallback for hosts that ignore `.volume`.
 *
 * WebKit on older iOS treats `HTMLMediaElement.volume` as read-only: the
 * assignment is dropped silently, the property keeps reading back 1, and
 * playback stays at the system volume no matter what the media player
 * entity says (discussion #149 - a satellite set to 0.1 played at full
 * volume). Newer iPadOS honors it; iPadOS 17.7.11 does not and 26.5.2
 * does, with no Safari release note recording the change.
 *
 * Within iOS the split is detected, not guessed: assign, then read the
 * property back. A host that dropped the assignment gets the audio
 * re-routed through `MediaElementSource -> GainNode -> destination`, where
 * the level is ours to set. An iOS version that honors `.volume` never
 * touches Web Audio, so no version table needs keeping current.
 *
 * The whole fallback is confined to iOS. Android has never shown the bug,
 * and the readback alone is not reason enough to route its audio through
 * an extra Web Audio hop.
 *
 * Once an element is on the gain path it stays there for its lifetime -
 * its `.volume` is pinned at 1 and the gain node carries the level, so
 * later changes (including back up to full) go to the gain node.
 */

import { getMediaElementSource } from './media-element-source.js';
import { isIosHost } from './platform.js';

/** el -> GainNode, for elements that have been re-routed. */
const gainNodes = new WeakMap();

/** Readback tolerance - `volume` is a double and should round-trip exactly. */
const EPSILON = 1e-3;

/**
 * Set the playback level for a media element, honoring hosts that ignore
 * the `volume` property.
 *
 * @param {HTMLMediaElement} el - the element (ignored when absent)
 * @param {number} volume - 0..1, already curved/muted by the caller
 * @param {object} [card] - card, for the AudioContext and logger. Without
 *   it only the plain assignment is attempted.
 */
export function setElementVolume(el, volume, card) {
  if (!el) return;

  // Already re-routed: the gain node owns the level from here on.
  const existing = gainNodes.get(el);
  if (existing) {
    existing.gain.value = volume;
    el.volume = 1;
    return;
  }

  el.volume = volume;

  // iOS only. The readback below would already spare every host that
  // honors the property, but Android has never shown this bug and there
  // is no reason to put its audio through an extra Web Audio hop on the
  // strength of a readback quirk we have not seen there.
  if (!isIosHost()) return;

  // Full volume needs no fallback, and it is also the value a host that
  // ignores the property reads back - so it tells us nothing either way.
  if (volume >= 1 - EPSILON) return;
  if (Math.abs(el.volume - volume) <= EPSILON) return;

  const gain = _engageGainFallback(el, card);
  if (gain) gain.gain.value = volume;
}

/**
 * Re-route an element through a gain node. Returns null (leaving the
 * element playing at whatever the host forced) when the graph is not
 * usable - too loud is a better failure than silent.
 */
function _engageGainFallback(el, card) {
  const log = card?.logger;

  // A duck-typed handle (Kiosk Satellite's native sound exposes a volume
  // setter and no getter) is not a real element and must never reach
  // createMediaElementSource.
  if (typeof HTMLMediaElement === 'undefined' || !(el instanceof HTMLMediaElement)) {
    return null;
  }

  const ctx = card?.audio?.audioContext;
  if (!ctx) {
    log?.log('volume', 'Host ignores element volume but no AudioContext is open - cannot apply gain fallback');
    return null;
  }
  // Routing through a suspended context would make the element inaudible
  // rather than merely loud. Leave it alone until the context is running.
  if (ctx.state !== 'running') {
    log?.log('volume', `Host ignores element volume but AudioContext is ${ctx.state} - cannot apply gain fallback`);
    return null;
  }

  try {
    const source = getMediaElementSource(el, ctx);
    if (!source) {
      log?.log('volume', 'Cannot apply gain fallback - element is bound to an older AudioContext');
      return null;
    }
    const gain = ctx.createGain();
    source.connect(gain);
    gain.connect(ctx.destination);
    gainNodes.set(el, gain);
    el.volume = 1;
    log?.log('volume', 'Host ignores element volume - routed through GainNode');
    return gain;
  } catch (e) {
    log?.log('volume', `Gain fallback failed: ${e.message}`);
    return null;
  }
}

/** True when this element's level is carried by a gain node. */
export function usesGainFallback(el) {
  return !!el && gainNodes.has(el);
}
