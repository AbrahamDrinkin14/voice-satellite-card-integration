/**
 * Reading-paced auto-scroll for overflowing response text.
 *
 * Pinning the text to its last line (the old behavior) means a response
 * taller than the container is read out by TTS from the top while the
 * screen shows the bottom.  Instead the scroll is paced so the text
 * reaches the end roughly when the speech does: each frame the speed
 * eases toward "pixels left / seconds of audio left", which self-corrects
 * as the real playback clock advances.  Word-by-word sync is not the goal
 * (voices and pronunciations make that unachievable) - keeping the line
 * being spoken somewhere on screen is.
 *
 * With no audio clock available the word-count estimate below stands in,
 * so text-only turns still scroll at a readable pace instead of jumping.
 */

// px/s bounds. The floor keeps a long response from looking frozen; the
// ceiling keeps a short one from flying past. Overshooting the audio is
// recoverable - the loop keeps running after playback ends.
const MIN_SPEED = 10;
const MAX_SPEED = 200;
const START_SPEED = 30;
// Per-frame easing toward the target speed. Low enough that a duration
// event arriving mid-scroll doesn't visibly jerk the text.
const EASE = 0.12;
// Ignore frame gaps larger than this (background tab, long GC pause) so a
// stalled RAF doesn't translate into one huge scroll jump.
const MAX_FRAME_MS = 100;

/**
 * Rough spoken duration of a text, in seconds. Numbers get extra time
 * because TTS expands them ("1,250" -> "one thousand two hundred fifty").
 * @param {string} text
 * @returns {number} seconds (0 for empty text)
 */
export function estimateSpeechDuration(text) {
  if (!text || !text.trim()) return 0;
  const words = text.trim().split(/\s+/).length;
  const nums = (text.match(/\d[\d,.]*%?/g) || []).length;
  return Math.max(3, (words / 2.8) + (nums * 0.7));
}

export class PacedScroller {
  /**
   * @param {() => ({elapsed: number, duration: number}|null)} getProgress
   *   Audio playback progress in seconds, or null when nothing is playing.
   */
  constructor(getProgress) {
    this._getProgress = getProgress;
    this._el = null;
    this._raf = null;
    this._lastTs = 0;
    this._pos = 0;
    this._speed = 0;
    // Set once the response text is complete: from then on the scroll runs
    // off the audio clock, or off the estimate when there is no audio.
    this._final = false;
    this._estimate = 0;
    this._estimateStart = 0;
  }

  /**
   * A new response is starting. A new element (the card's per-response
   * bubble) starts from scratch; the same element again (mini's shared
   * transcript container) keeps its scroll position but drops the previous
   * turn's pacing clock.
   */
  begin(el) {
    if (el !== this._el) {
      this.reset();
      this._el = el;
      return;
    }
    this.stop();
    this._speed = 0;
    this._final = false;
    this._estimate = 0;
    this._estimateStart = 0;
  }

  /**
   * Content grew. While the response is still streaming and no audio is
   * playing yet, hold position - speech starts at the top of the text, so
   * following the tail would only scroll past what is about to be read.
   */
  nudge() {
    if (!this._el) return;
    if (this._final || this._getProgress()) this._start();
  }

  /**
   * The response text is complete. Paces off the audio clock once playback
   * reports progress, and off the word-count estimate until then (or for
   * the whole response when TTS never plays).
   * @param {string} text - the full response text
   */
  finalize(text) {
    if (!this._el) return;
    this._final = true;
    this._estimate = estimateSpeechDuration(text);
    this._estimateStart = 0;
    this._start();
  }

  /** Stop the loop but keep the current position (content may grow again). */
  stop() {
    if (this._raf) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
    }
    this._lastTs = 0;
  }

  /** Full teardown - new conversation or cleared chat. */
  reset() {
    this.stop();
    this._el = null;
    this._pos = 0;
    this._speed = 0;
    this._final = false;
    this._estimate = 0;
    this._estimateStart = 0;
  }

  _start() {
    if (this._raf) return;
    this._raf = requestAnimationFrame((ts) => this._tick(ts));
  }

  /** Seconds of speech left, from the audio clock or the estimate. */
  _remaining(ts) {
    const progress = this._getProgress();
    if (progress && progress.duration > 0) {
      // A live clock supersedes the estimate: re-base it so that if
      // playback ends early the estimate doesn't resume mid-way.
      this._estimateStart = 0;
      return progress.duration - progress.elapsed;
    }
    if (!this._estimate) return 0;
    if (!this._estimateStart) this._estimateStart = ts;
    return this._estimate - (ts - this._estimateStart) / 1000;
  }

  _tick(ts) {
    this._raf = null;
    const el = this._el;
    if (!el) return;

    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) {
      // Nothing overflows yet. A later nudge() restarts the loop.
      this._lastTs = 0;
      return;
    }

    if (!this._lastTs) {
      this._lastTs = ts;
      // Re-read rather than trusting _pos: the container may have been
      // jumped elsewhere (a new message) since the last run.
      this._pos = el.scrollTop;
      if (!this._speed) this._speed = START_SPEED;
    }
    const dt = Math.min(MAX_FRAME_MS, ts - this._lastTs);
    this._lastTs = ts;

    const remaining = this._remaining(ts);
    const pxLeft = max - this._pos;
    if (remaining > 0.1 && pxLeft > 0) {
      const target = Math.max(MIN_SPEED, Math.min(MAX_SPEED, pxLeft / remaining));
      this._speed += (target - this._speed) * EASE;
    }

    this._pos = Math.min(max, this._pos + this._speed * dt / 1000);
    el.scrollTop = this._pos;

    if (this._pos >= max) {
      // At the end. Streaming text that grows past this point restarts the
      // loop through nudge().
      this._lastTs = 0;
      return;
    }
    this._raf = requestAnimationFrame((nextTs) => this._tick(nextTs));
  }
}
