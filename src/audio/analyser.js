/**
 * AnalyserManager
 *
 * Provides real-time audio level analysis for reactive bar animations.
 * Uses two separate AnalyserNodes - one for microphone input, one for
 * audio output (TTS / notifications) - so the mic can never be routed
 * to the speakers through the analyser graph.
 *
 * The mic analyser is never connected to AudioContext.destination;
 * the audio analyser routes through to destination for playback.
 * _activeAnalyser points to whichever node _tick() should read from.
 *
 * On WebKit hosts (Safari, and every iOS browser/webview, since they are
 * all WKWebView underneath) the media-element tap is unreliable: the
 * element keeps playing audibly while the MediaElementSourceNode feeds
 * the analyser silence, so the bar never moves during playback. There,
 * attachAudio() falls back to fetching and decoding the audio itself,
 * precomputing an amplitude envelope, and driving the bar through the
 * external-level path keyed to the element's currentTime.
 *
 * Skins opt in via `reactiveBar: true` in their definition.
 */

import { getMediaElementSource } from './media-element-source.js';
import { usesGainFallback } from './element-volume.js';
import { isIosHost, isSafariHost } from './platform.js';

/**
 * True where createMediaElementSource cannot be trusted to deliver samples
 * to an AnalyserNode. Chrome on iOS reports CriOS but runs WKWebView, so
 * the test is "WebKit and not a real Chromium/Android", plus the iPadOS
 * desktop-UA case where Safari masquerades as macOS.
 */
function mediaElementTapUnreliable() {
  return isIosHost() || isSafariHost();
}

export class AnalyserManager {
  constructor(card) {
    this._card = card;
    this._log = card.logger;

    // Mic path: sourceNode -> _micAnalyser (no destination)
    this._micAnalyser = null;
    this._micSourceNode = null;

    // Audio path: mediaElementSource -> _audioAnalyser -> destination
    this._audioAnalyser = null;
    this._mediaSourceNode = null;
    this._mediaSourceEl = null;

    // Which analyser _tick() reads from
    this._activeAnalyser = null;
    this._dataArray = null;
    this._freqDataArray = null;
    this._floatDataArray = null;

    // Adaptive mic references (see _normalizeMicLevel). Kept for the
    // manager's lifetime: they describe the device, not one voice turn.
    this._micFloor = null;
    this._micPeakEnv = 0;
    this._micAdaptive = false;

    // External level mode: playback that never enters the Web Audio graph
    // (Kiosk Satellite native playback) pushes its measured level here and
    // _tick() reads it instead of an AnalyserNode. Same meanAbs semantics
    // as getByteTimeDomainData (mean |amplitude| normalized 0..1), so the
    // visual mapping is shared.
    this._external = false;
    this._externalIsMic = false;
    this._externalLevel = 0;
    this._lastMicPushAt = 0;
    this._micBands = null;
    this._analyserBuffers = new WeakMap();
    this._analyserFrequencyBuffers = new WeakMap();

    // Decoded-envelope fallback (WebKit): _tick() reads the precomputed
    // envelope at the element's currentTime instead of _externalLevel.
    this._decodedEl = null;
    this._decodedEnvelope = null;
    this._envelopeCache = new Map();
    this._decodeContext = null;

    this._rafId = null;
    this._timerId = null;
    this._barEl = null;
    this._visibilityHandler = null;
    this._lastLevel = -1;
    this._lastTick = 0;
    this._defaultIntervalMs = 0;

    // Bound tick for RAF to avoid creating a new closure per frame
    this._boundTick = () => this._tick();
  }

  /**
   * Connect analyser as a parallel tap on the mic source node.
   * The mic analyser is never connected to destination - it only
   * provides FFT data for the reactive bar.
   */
  attachMic(sourceNode, audioContext) {
    this._micSourceNode = sourceNode;
    if (this._micAnalyser && this._micAnalyser.context !== audioContext) {
      this._micAnalyser = null;
    }
    if (!this._micAnalyser) {
      this._micAnalyser = this._createAnalyser(audioContext);
    }
    try {
      sourceNode.connect(this._micAnalyser);
      this._log.log('analyser', 'Mic -> micAnalyser connected');
    } catch (e) {
      this._log.log('analyser', `Failed to attach mic: ${e.message}`);
    }
    // Default to mic analyser when no audio is playing
    if (!this._activeAnalyser) {
      this._setActiveAnalyser(this._micAnalyser);
      this._log.log('analyser', 'Active -> micAnalyser (initial)');
    }
  }

  /**
   * Disconnect mic tap.
   */
  detachMic(sourceNode) {
    this._micSourceNode = null;
    if (!this._micAnalyser) return;
    try {
      sourceNode.disconnect(this._micAnalyser);
      this._log.log('analyser', 'Mic -> micAnalyser disconnected');
    } catch {
      // Already disconnected
    }
    if (this._activeAnalyser === this._micAnalyser) {
      this._activeAnalyser = null;
      this._log.log('analyser', 'Active -> none (mic detached)');
    }
  }

  /**
   * Route an HTML Audio element through the audio analyser for output
   * analysis. createMediaElementSource reroutes audio through the Web
   * Audio graph, so we connect through to destination for audibility.
   *
   * Uses a separate analyser from the mic - the mic analyser has no
   * path to destination, so feedback is structurally impossible.
   */
  attachAudio(audioEl, audioContext) {
    if (!audioEl || !audioContext) return;

    // The volume gain fallback already owns this element's routing
    // (source -> gain -> destination). Tapping the same source here would
    // add a second path to the speakers that bypasses the gain node -
    // louder, and deaf to the very volume setting it works around.
    if (usesGainFallback(audioEl)) {
      this._attachDecodedLevels(audioEl);
      return;
    }

    // WebKit: don't reroute the element at all - the tap reads silence
    // there (and rerouting risks degrading playback). Compute levels from
    // the decoded bytes instead.
    if (mediaElementTapUnreliable()) {
      this._attachDecodedLevels(audioEl);
      return;
    }

    this._detachAudio();

    try {
      if (this._audioAnalyser && this._audioAnalyser.context !== audioContext) {
        this._audioAnalyser = null;
        this._mediaSourceNode = null;
        this._mediaSourceEl = null;
      }
      if (!this._audioAnalyser) {
        this._audioAnalyser = this._createAnalyser(audioContext);
      }
      // createMediaElementSource can only be called once per element for
      // the life of the document, so the node comes from the shared cache
      // (see media-element-source.js) that the volume gain fallback also
      // uses - two private caches would race to the second call, which
      // throws and breaks the element for good.
      if (this._mediaSourceEl !== audioEl) {
        const node = getMediaElementSource(audioEl, audioContext);
        if (!node) {
          this._log.log('analyser', 'Skipping audio analyser attach - media element is bound to an old AudioContext');
          return;
        }
        this._mediaSourceNode = node;
        this._mediaSourceEl = audioEl;
      }
      this._mediaSourceNode.connect(this._audioAnalyser);
      this._audioAnalyser.connect(audioContext.destination);

      // Switch reactive bar to read from audio analyser during playback
      this._setActiveAnalyser(this._audioAnalyser);
      this._log.log('analyser', 'Audio -> audioAnalyser -> destination connected, active -> audioAnalyser');

      // Auto-start tick loop if a bar element is waiting (deferred start
      // from onNotificationStart — bar was prepared but loop deferred
      // until audio was attached).
      if (this._barEl && !this._isTicking()) {
        this._log.log('analyser', 'Auto-starting tick loop (deferred bar ready)');
        this._tick();
      }
    } catch (e) {
      this._log.log('analyser', `Failed to attach audio: ${e.message}`);
      if (this._mediaSourceEl === audioEl) {
        this._mediaSourceNode = null;
        this._mediaSourceEl = null;
      }
    }
  }

  /**
   * Disconnect audio element routing. Also leaves external-level mode, so
   * the generic teardown call sites (TTS _onComplete/stop, notification
   * cleanup) need no native-specific step.
   */
  detachAudio() {
    this._detachAudio();
    this.detachExternal();
  }

  /**
   * Switch the bar to externally-supplied levels (native playback: the
   * audio never enters the page, the app measures it and streams levels
   * over). Mirrors attachAudio's role for element playback.
   */
  attachExternal() {
    this._detachAudio();
    this._external = true;
    // Playback takes over the external channel: without this, TTS levels
    // arriving while the delegated mic is still attached render through
    // the mic mapping and its adaptive boost slams the bar to full.
    this._externalIsMic = false;
    this._externalLevel = 0;
    this._decodedEl = null;
    this._decodedEnvelope = null;
    this._log.log('analyser', 'Active -> external (native playback levels)');
    if (this._barEl && !this._isTicking()) {
      this._tick();
    }
  }

  /** Feed one externally measured level (meanAbs, 0..1). */
  setExternalLevel(level) {
    this._externalLevel = Number(level) || 0;
  }

  /**
   * External mode for the DELEGATED MIC (Kiosk Satellite streams PCM chunks
   * into the page): levels are computed per chunk in [pushMicPcm] and read
   * here with hold-last-value semantics. This deliberately does not go
   * through a Web Audio graph: chunk events ride evaluateJavascript onto
   * the page's main thread, and on slow devices they arrive in clumps - a
   * realtime worklet starves between clumps and renders the gaps as
   * silence, which reads as a dead bar (seen on the Echo Show 5). A held
   * level cannot fake silence, and a chunk is ~80 ms, the bar's own update
   * cadence anyway.
   */
  attachExternalMic() {
    this._detachAudio();
    this._external = true;
    this._externalIsMic = true;
    this._externalLevel = 0;
    this._lastMicPushAt = 0;
    this._micBands = null;
    this._decodedEl = null;
    this._decodedEnvelope = null;
    this._log.log('analyser', 'Active -> external mic (delegated PCM levels)');
    if (this._barEl && !this._isTicking()) {
      this._tick();
    }
  }

  /**
   * One chunk of delegated mic PCM (Float32Array, [-1, 1], 16 kHz mono).
   * Computes the weighted level the analyser-tap path would have produced:
   * meanAbs shaped by a speech-band weight from two one-pole band splits
   * (the graph path used FFT bins for this; one-poles are plenty for a
   * 3-band rumble/voice/air split and cost microseconds per chunk).
   */
  pushMicPcm(samples) {
    if (!this._external || !this._externalIsMic || !samples || !samples.length) return;
    let b = this._micBands;
    if (!b) {
      // One-pole low-pass coefficients at 16 kHz: exp(-2*pi*fc/fs)
      b = this._micBands = { lp180: 0, lp3400: 0, a180: 0.9318, a3400: 0.2628 };
    }
    let l180 = b.lp180;
    let l3400 = b.lp3400;
    let sumAll = 0;
    let sumLow = 0;
    let sumMid = 0;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      l180 = b.a180 * l180 + (1 - b.a180) * x;
      l3400 = b.a3400 * l3400 + (1 - b.a3400) * x;
      sumAll += Math.abs(x);
      sumLow += Math.abs(l180);
      sumMid += Math.abs(l3400);
    }
    b.lp180 = l180;
    b.lp3400 = l3400;
    const n = samples.length;
    const all = sumAll / n;
    const low = sumLow / n;
    const mid = sumMid / n;
    const voice = Math.max(0, mid - low);
    const air = Math.max(0, all - mid);
    // Same intent as _getMicSpeechWeight: favor the speech band, suppress
    // steady rumble/hiss. The ratio term is scale-free, which matters here
    // because these are time-domain band levels, not FFT bin magnitudes.
    const ratio = voice / Math.max(1e-4, low + air + voice);
    const weight = Math.max(0.18, Math.min(1, ratio * 1.2));
    this._externalLevel = all * weight;
    this._lastMicPushAt = performance.now();
  }

  /**
   * One pre-computed level for the DELEGATED PIPELINE (Kiosk Satellite
   * uploads the audio natively and the page never sees PCM): the app runs
   * the same band-split speech weighting pushMicPcm applies and hands us
   * the finished number. Same freshness stamp, so the hold-last-value
   * decay in the tick loop treats it exactly like a locally computed
   * chunk level.
   */
  pushExternalMicLevel(level) {
    if (!this._external || !this._externalIsMic) return;
    this._externalLevel = Number(level) || 0;
    this._lastMicPushAt = performance.now();
  }

  /** Leave external mode and darken the bar, like _detachAudio does. */
  detachExternal() {
    if (!this._external) return;
    this._external = false;
    this._externalIsMic = false;
    this._externalLevel = 0;
    this._decodedEl = null;
    this._decodedEnvelope = null;
    if (this._barEl) {
      this._lastLevel = 0;
      this._barEl.style.setProperty('--vs-audio-level', '0');
    }
    this._log.log('analyser', 'Active -> none (external detached)');
  }

  /**
   * WebKit fallback for attachAudio: enter external mode immediately (so
   * the tick loop runs and the bar is live the moment data lands), then
   * fetch and decode the element's source and precompute an amplitude
   * envelope. _tick() reads the envelope at the element's currentTime.
   *
   * The fetch hits the same URL the element is already playing, so for
   * local assets (chimes) it comes from cache; TTS costs one extra
   * request to a file HA just generated. If the fetch or decode fails
   * the bar simply stays dark, which is what WebKit showed before.
   */
  async _attachDecodedLevels(audioEl) {
    const url = audioEl.currentSrc || audioEl.src;
    if (!url) return;
    this._detachAudio();
    this._external = true;
    this._externalLevel = 0;
    this._decodedEl = audioEl;
    this._decodedEnvelope = null;
    this._log.log('analyser', 'Active -> decoded levels (WebKit media tap fallback)');
    if (this._barEl && !this._isTicking()) {
      this._tick();
    }
    try {
      const envelope = await this._getEnvelope(url);
      // Superseded while decoding (new playback attached, or detached)
      if (this._decodedEl !== audioEl || !this._external) return;
      this._decodedEnvelope = envelope;
    } catch (e) {
      this._log.log('analyser', `Decoded-level fallback failed: ${e?.message || e}`);
    }
  }

  /** Envelope meanAbs at the element's playhead, 0 when paused/ended. */
  _decodedLevelNow() {
    const el = this._decodedEl;
    const env = this._decodedEnvelope;
    if (!el || !env || el.paused) return 0;
    const idx = Math.floor(el.currentTime / env.windowSec);
    return idx >= 0 && idx < env.levels.length ? env.levels[idx] : 0;
  }

  async _getEnvelope(url) {
    const cached = this._envelopeCache.get(url);
    if (cached) {
      // Refresh LRU position - repeated chime URLs stay resident while
      // one-shot TTS URLs age out.
      this._envelopeCache.delete(url);
      this._envelopeCache.set(url, cached);
      return cached;
    }
    const resp = await fetch(url, { credentials: 'same-origin' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const bytes = await resp.arrayBuffer();
    const buf = await this._decodeAudio(bytes);
    const envelope = this._computeEnvelope(buf);
    this._envelopeCache.set(url, envelope);
    while (this._envelopeCache.size > 8) {
      this._envelopeCache.delete(this._envelopeCache.keys().next().value);
    }
    return envelope;
  }

  _decodeAudio(bytes) {
    // Reuse the capture context when one exists - decodeAudioData works
    // even on a suspended context. Otherwise keep one lazy context that
    // only ever decodes and never routes audio anywhere.
    let ctx = this._card?.audio?.audioContext;
    if (!ctx || ctx.state === 'closed') {
      if (!this._decodeContext || this._decodeContext.state === 'closed') {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        this._decodeContext = new Ctor();
      }
      ctx = this._decodeContext;
    }
    // Callback form: older WebKit predates the promise variant. Swallow
    // the parallel promise rejection where both are supported so the
    // failure only surfaces through the callback path.
    return new Promise((resolve, reject) => {
      const p = ctx.decodeAudioData(bytes, resolve, reject);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    });
  }

  _computeEnvelope(audioBuffer) {
    // Mean |amplitude| per 50ms window - the same meanAbs semantics as
    // getByteTimeDomainData in _tick(), so _mapVisualLevel applies
    // unchanged and WebKit renders the same bar Chrome does.
    const windowSec = 0.05;
    const data = audioBuffer.getChannelData(0);
    const perWindow = Math.max(1, Math.round(audioBuffer.sampleRate * windowSec));
    const count = Math.max(1, Math.ceil(data.length / perWindow));
    const levels = new Float32Array(count);
    for (let w = 0; w < count; w++) {
      const start = w * perWindow;
      const end = Math.min(data.length, start + perWindow);
      let sum = 0;
      for (let i = start; i < end; i++) sum += Math.abs(data[i]);
      levels[w] = end > start ? sum / (end - start) : 0;
    }
    return { levels, windowSec };
  }

  /**
   * Switch the reactive bar back to reading from the mic analyser.
   * The mic source stays connected to its analyser at all times  - 
   * this just changes which analyser _tick() reads FFT data from.
   *
   * No-op while audio is routed through the audio analyser - callers
   * like updateForState fire for all bar-visible states (including TTS),
   * and switching away from the audio analyser mid-playback would make
   * the bar show mic levels instead of TTS levels.
   */
  reconnectMic() {
    if (this._activeAnalyser === this._audioAnalyser || this._external) {
      this._log.log('analyser', 'reconnectMic skipped - audio still attached');
      return;
    }
    if (this._micAnalyser) {
      this._setActiveAnalyser(this._micAnalyser);
      this._log.log('analyser', 'Active -> micAnalyser (reconnectMic)');
    }
  }

  /**
   * Start the animation frame loop that updates --vs-audio-level.
   * @param {HTMLElement} barEl - The bar element to update
   * @param {object} [opts]
   * @param {boolean} [opts.deferred] - Store bar element but don't start
   *   the tick loop yet.  Used by notification playback: the bar enters
   *   reactive/speaking mode immediately, but the tick loop should only
   *   run once attachAudio() switches to the audio analyser — otherwise
   *   the bar would react to mic input during the pre-announce chime.
   */
  start(barEl, { deferred, warmupMs } = {}) {
    this._barEl = barEl;
    // Warmup window: discard the first `warmupMs` of output writes.  Used
    // right after the mic is unmuted to hide the activation transient —
    // when a MediaStreamTrack flips from enabled=false to true, the first
    // few hundred samples often carry a DC step or driver-level click
    // which the speech-band weighting (`_getMicSpeechWeight`) amplifies
    // into a visible glow "bleep" on the reactive bar before the real
    // signal settles.  Ticks still run so the analyser's smoothing fills
    // with live data during the warmup — only the CSS-var write is
    // suppressed.
    this._warmupUntil = (typeof warmupMs === 'number' && warmupMs > 0)
      ? performance.now() + warmupMs
      : 0;
    if (!this._visibilityHandler) {
      this._visibilityHandler = () => {
        if (document.hidden) {
          this._cancelScheduledTick();
        } else if (this._barEl && !this._isTicking()) {
          this._tick();
        }
      };
      document.addEventListener('visibilitychange', this._visibilityHandler);
    }
    if (this._isTicking()) return; // Already running
    if (!deferred) this._tick();
  }

  /**
   * Stop the animation frame loop and reset the CSS variable.
   */
  stop() {
    this._cancelScheduledTick();
    if (this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }
    if (this._barEl) {
      this._barEl.style.setProperty('--vs-audio-level', '0');
      this._barEl = null;
      this._log.log('analyser', 'Tick loop stopped');
    }
  }
  _createAnalyser(audioContext) {
    const analyser = audioContext.createAnalyser();
    // Keep this lightweight, but use enough bins to distinguish broad speech
    // energy from low-frequency environmental hum in the mic path.
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.6;
    return analyser;
  }

  _detachAudio() {
    if (this._mediaSourceNode) {
      try { this._mediaSourceNode.disconnect(); } catch {}
      // Don't null _mediaSourceNode - it's reusable for the same element
      this._log.log('analyser', 'Audio -> audioAnalyser disconnected');
    }
    if (this._audioAnalyser) {
      try { this._audioAnalyser.disconnect(); } catch {}
      this._log.log('analyser', 'audioAnalyser -> destination disconnected');
    }
    // Clear active analyser — the tick loop will stop on the next frame.
    // Don't revert to mic: callers like playMediaFor detach audio when
    // notification media ends, and the bar would react to mic input
    // during the cleanup/linger period.  reconnectMic() restores mic
    // explicitly when the pipeline needs it (e.g. updateForState).
    this._setActiveAnalyser(null);
    if (this._barEl) {
      this._lastLevel = 0;
      this._barEl.style.setProperty('--vs-audio-level', '0');
    }
    this._log.log('analyser', 'Active -> none (audio detached)');
  }

  /**
   * Invalidate the "last level" cache so the next `_tick()` writes its
   * computed value to `--vs-audio-level` unconditionally.  The tick
   * otherwise skips writes when the level hasn't changed, which leaves
   * the bar stuck on whatever value was in the CSS variable when the
   * analyser started — e.g. a residual synthetic pulse value written by
   * the wake-word "breathing" animation.
   */
  invalidateLastLevel() {
    this._lastLevel = -1;
  }

  _tick() {
    this._rafId = null;
    if (!this._barEl || (!this._activeAnalyser && !this._external)) {
      return;
    }

    // Pace to the update interval - CSS transitions smooth the gaps and
    // this saves CPU significantly on low-end Android wall tablets.
    const now = performance.now();
    const targetIntervalMs = this._getUpdateIntervalMs();
    const elapsed = now - this._lastTick;
    if (elapsed < targetIntervalMs) {
      this._scheduleTick(targetIntervalMs - elapsed);
      return;
    }

    this._lastTick = now;

    let isMic = false;
    let meanAbs;
    let isNativeLevel = false;
    if (this._external) {
      // Native playback pushes measured levels; the WebKit fallback reads
      // the decoded envelope at the element's playhead instead.
      if (this._decodedEnvelope || this._decodedEl) {
        meanAbs = this._decodedLevelNow();
      } else if (this._externalIsMic) {
        // Held chunk level; decays to silence when chunks stop arriving
        // (stream hiccup) so the bar cannot freeze lit.
        meanAbs = now - this._lastMicPushAt > 250 ? 0 : this._externalLevel;
        isMic = true;
      } else {
        meanAbs = this._externalLevel;
        isNativeLevel = true;
      }
    } else {
      isMic = this._activeAnalyser === this._micAnalyser;
      if (isMic && typeof this._activeAnalyser.getFloatTimeDomainData === 'function') {
        // Float resolution for the mic: an uncalibrated capture can sit
        // 30 dB down (Echo Show 5 under LineageOS), where 8-bit samples
        // round to flat silence and the adaptive mapping in
        // _normalizeMicLevel has nothing to work with.
        let f = this._floatDataArray;
        if (!f || f.length !== this._activeAnalyser.fftSize) {
          f = new Float32Array(this._activeAnalyser.fftSize);
          this._floatDataArray = f;
        }
        this._activeAnalyser.getFloatTimeDomainData(f);
        let sum = 0;
        for (let i = 0; i < f.length; i++) sum += Math.abs(f[i]);
        meanAbs = sum / f.length;
      } else {
        // Use time-domain waveform amplitude for a simple level meter. This is
        // cheaper than FFT/frequency analysis and visually sufficient here.
        this._activeAnalyser.getByteTimeDomainData(this._dataArray);

        // Compute mean absolute amplitude normalized to 0-1, then quantize to
        // skip redundant CSS updates when the level barely changes.
        let sum = 0;
        for (let i = 0; i < this._dataArray.length; i++) {
          sum += Math.abs(this._dataArray[i] - 128);
        }
        meanAbs = (sum / this._dataArray.length) / 128;
      }

      if (isMic && this._freqDataArray) {
        this._activeAnalyser.getByteFrequencyData(this._freqDataArray);
        meanAbs *= this._getMicSpeechWeight(this._activeAnalyser, this._freqDataArray);
      }
    }

    // During the post-unmute warmup window, keep the analyser reads running
    // (so smoothing converges on live audio) but skip the visual mapping
    // entirely — any transient "bleep" from mic activation, or the wake
    // chime's tail on AEC-less delegated captures, is neither rendered nor
    // learned by the adaptive mic references.  When the window ends we
    // force the next real value through by resetting _lastLevel, so the
    // "skip-write-when-unchanged" optimization doesn't leave the bar
    // stuck on whatever pre-warmup value was there.
    if (this._warmupUntil) {
      if (now < this._warmupUntil) {
        this._scheduleTick(targetIntervalMs);
        return;
      }
      this._warmupUntil = 0;
      this._lastLevel = -1;
    }

    const level = Math.min(1, Math.round(this._mapVisualLevel(meanAbs, isMic, isNativeLevel) * 20) / 20);

    if (level !== this._lastLevel) {
      this._lastLevel = level;
      this._barEl.style.setProperty('--vs-audio-level', level.toFixed(2));
    }

    this._scheduleTick(targetIntervalMs);
  }

  /**
   * Queue the next tick: a timer to just before the due time, then one RAF
   * hop so the write lands with frame production. The old loop re-entered
   * RAF every vsync and discarded most frames against the interval check,
   * which kept the main thread waking at 60 Hz for 20-30 Hz of work.
   */
  _scheduleTick(delayMs) {
    this._timerId = setTimeout(() => {
      this._timerId = null;
      this._rafId = requestAnimationFrame(this._boundTick);
    }, Math.max(0, delayMs - 2));
  }

  _isTicking() {
    return !!(this._rafId || this._timerId);
  }

  _cancelScheduledTick() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    if (this._timerId) {
      clearTimeout(this._timerId);
      this._timerId = null;
    }
  }

  _setActiveAnalyser(analyser) {
    this._activeAnalyser = analyser;
    if (!analyser) {
      this._dataArray = null;
      this._freqDataArray = null;
      return;
    }
    let buf = this._analyserBuffers.get(analyser);
    if (!buf || buf.length !== analyser.fftSize) {
      buf = new Uint8Array(analyser.fftSize);
      this._analyserBuffers.set(analyser, buf);
    }
    this._dataArray = buf;
    let freqBuf = this._analyserFrequencyBuffers.get(analyser);
    if (!freqBuf || freqBuf.length !== analyser.frequencyBinCount) {
      freqBuf = new Uint8Array(analyser.frequencyBinCount);
      this._analyserFrequencyBuffers.set(analyser, freqBuf);
    }
    this._freqDataArray = freqBuf;
  }

  _getUpdateIntervalMs() {
    const raw = Number(this._card?.config?.reactive_bar_update_interval_ms);
    if (!Number.isFinite(raw)) {
      // ~30 fps by default; ~20 fps where the hardware advertises itself
      // as weak (Echo Show-class tablets: <=2 GB RAM or <=4 cores). The
      // CSS transitions smooth either cadence.
      if (!this._defaultIntervalMs) {
        const lowEnd = (navigator.deviceMemory && navigator.deviceMemory <= 2)
          || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4);
        this._defaultIntervalMs = lowEnd ? 50 : 33;
      }
      return this._defaultIntervalMs;
    }
    // Cap at 60fps max (minimum interval ~16.67ms, rounded to 17ms).
    return Math.max(17, raw);
  }

  _mapVisualLevel(meanAbs, isMic, isNativeLevel = false) {
    // This is visual-only remapping for reactive skins. It does not affect
    // wake word, VAD, or any uploaded audio — only the shared CSS level.

    // Kiosk Satellite streams levels it measured from the decoded source
    // at full scale, before its player applies the volume, so they run
    // hot compared to what the analyser reads off an element. The
    // standard playback gain of 5 clips everything above 0.2 to a maxed
    // bar, leaving TTS pinned at full size for whole utterances. Use a
    // gentler gain with a near-linear curve so speech keeps its dynamics.
    if (isNativeLevel) {
      return Math.min(1, meanAbs * 2.2);
    }

    // Mic levels are first re-referenced to the capture's own floor and
    // speech envelope, so the absolute mapping below behaves the same on a
    // quiet ROM capture as on a calibrated one.
    if (isMic) {
      meanAbs = this._normalizeMicLevel(meanAbs);
      if (meanAbs === 0) return 0;
    }

    // Mic input tends to sit much lower than local/remote playback, so give
    // it a slightly stronger lift plus a small visible floor once real input
    // is present. The nonlinear curve keeps quiet speech readable without
    // flattening louder speech into a constant maxed-out bar.
    const gain = isMic ? 7.5 : 5;
    const scaled = Math.min(1, meanAbs * gain);
    const curved = Math.pow(scaled, isMic ? 0.6 : 0.8);

    if (isMic) {
      // Noise gate: values at or below this are ambient room noise
      // (HVAC, fan, AC hum, distant traffic) and must render as fully
      // dark — users expect "no sound → no glow".  The old threshold
      // of 0.015 was set low enough that any quiet room passed it,
      // and the floor of 0.12 kept a visible glow on through silence.
      // On quiet captures the adaptive gate in _normalizeMicLevel has
      // already made this call relative to the device's own floor.
      if (curved <= 0.06 && !this._micAdaptive) return 0;
      // Above the gate, lift soft voices with a small visible floor
      // that's low enough not to read as "always on" when the mic
      // briefly clips a keyboard click or door close.
      const floored = 0.05 + curved * 0.95;
      return Math.min(1, floored);
    }

    return curved;
  }

  /**
   * Device-independent mic level. The absolute mapping in _mapVisualLevel
   * assumes a roughly calibrated capture, but some ROM ports record
   * 20-30 dB low (Echo Show 5 under LineageOS): real speech then never
   * clears the noise gate and the bar reads as dead, even though wake word
   * detection and STT, which normalize per-feature, work fine.
   *
   * Two references, both learned from the capture itself:
   *  - a noise floor that follows drops immediately and creeps up slowly.
   *    Anything under 3x the floor is ambient and renders dark whatever
   *    its absolute level, on every device.
   *  - a slow envelope of the peaks above that gate (speech evidence -
   *    silence between utterances cannot feed it). When it shows the
   *    capture runs quiet, levels are boosted up to 16x toward what a
   *    healthy capture produces, so the visual mapping applies unchanged.
   *    A healthy capture's envelope keeps the boost at 1.
   */
  _normalizeMicLevel(meanAbs) {
    // Absolute epsilon so a digitally silent capture cannot drive the
    // floor to zero and turn dither into "speech".
    const EPS = 1e-4;
    const prev = this._micFloor;
    if (prev == null || meanAbs < prev) {
      this._micFloor = Math.max(meanAbs, EPS);
    } else {
      // Capped below speech levels so a long utterance can never become
      // its own floor.
      this._micFloor = Math.min(prev * 1.002, 0.05);
    }
    if (meanAbs <= this._micFloor * 3) {
      this._micAdaptive = false;
      return 0;
    }

    // Up to 64x (36 dB): far-field speech on the quietest captures sits
    // around 3e-4 after weighting and must still reach the mapping's
    // working range. The envelope decay recovers sensitivity within a few
    // seconds of a loud moment instead of tens.
    const REF = 0.05;
    const MAX_BOOST = 64;
    this._micPeakEnv = Math.max(this._micPeakEnv * 0.997, meanAbs);
    const boost = Math.min(MAX_BOOST, Math.max(1, REF / Math.max(this._micPeakEnv, REF / MAX_BOOST)));
    // When the boost is doing real work, the adaptive gate above has
    // already separated speech from ambient; the absolute gate in
    // _mapVisualLevel is tuned for calibrated captures and would eat the
    // boosted signal, so it stands down (see _micAdaptive there).
    this._micAdaptive = boost > 1.01;
    return meanAbs * boost;
  }

  _getMicSpeechWeight(analyser, freqData) {
    const voice = this._getBandAverage(analyser, freqData, 180, 3400);
    const low = this._getBandAverage(analyser, freqData, 20, 180);
    const air = this._getBandAverage(analyser, freqData, 3400, 7000);

    // Favor the speech band and suppress steady HVAC-style rumble/hiss.
    const speechScore = Math.max(0, voice - low * 0.85 - air * 0.25);
    const ratio = voice / Math.max(0.05, low + air + voice);

    // Keep some baseline responsiveness so soft voices still register,
    // but make broad low-frequency noise much less visually dominant.
    return Math.max(0.18, Math.min(1, speechScore * 1.8 + ratio * 0.9));
  }

  _getBandAverage(analyser, freqData, fromHz, toHz) {
    const nyquist = analyser.context.sampleRate / 2;
    const maxIndex = freqData.length - 1;
    const start = Math.max(0, Math.min(maxIndex, Math.floor((fromHz / nyquist) * maxIndex)));
    const end = Math.max(start, Math.min(maxIndex, Math.ceil((toHz / nyquist) * maxIndex)));

    let sum = 0;
    let count = 0;
    for (let i = start; i <= end; i++) {
      sum += freqData[i] / 255;
      count += 1;
    }
    return count ? sum / count : 0;
  }
}
