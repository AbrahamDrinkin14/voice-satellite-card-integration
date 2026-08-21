/**
 * Media Playback Utility
 *
 * Shared helpers for browser audio playback and URL normalization.
 * Used by TtsManager and AnnouncementManager.
 */

/**
 * Normalize a URL path to an absolute URL.
 * Handles: full URLs (returned as-is), root-relative paths, and bare paths.
 *
 * @param {string} urlPath - URL or path to normalize
 * @returns {string} Absolute URL
 */
export function buildMediaUrl(urlPath) {
  if (urlPath.startsWith('http://') || urlPath.startsWith('https://')) {
    return urlPath;
  }
  const base = window.location.origin;
  return urlPath.startsWith('/') ? base + urlPath : `${base}/${urlPath}`;
}

/** True when the given origin's host is a loopback address. */
function isLoopbackOrigin(origin) {
  try {
    const host = new URL(origin).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch (_) {
    return false;
  }
}

/** The path (with query and fragment) of a URL or bare path, root-relative. */
function toRootRelative(urlPath) {
  if (urlPath.startsWith('http://') || urlPath.startsWith('https://')) {
    try {
      const u = new URL(urlPath);
      return u.pathname + u.search + u.hash;
    } catch (_) {
      return null;
    }
  }
  return urlPath.startsWith('/') ? urlPath : `/${urlPath}`;
}

/**
 * Normalize a URL path for a media_player.play_media handed to a device
 * OTHER than this one. Use for any URL played off-box (a remote speaker);
 * use buildMediaUrl for audio this page plays itself.
 *
 * Normally identical to buildMediaUrl. The difference is Kiosk Satellite,
 * which serves the page through an in-app loopback proxy (127.0.0.1) to
 * satisfy the secure-context requirement - an origin only this device can
 * reach, and one a speaker asked to fetch it just fails on (issue #121).
 *
 * Two ways out of that origin, in order:
 *   1. Home Assistant's own configured address (internal_url, else
 *      external_url), when the instance has one.
 *   2. Otherwise the bare path. Home Assistant resolves a root-relative
 *      media_content_id against get_url() when it hands the media to the
 *      player, which is how its own tts.speak reaches a Cast device from
 *      an instance with neither URL configured - and it signs the path on
 *      the way, so authenticated paths work too. Guessing wrongly here is
 *      not better than letting the server answer.
 *
 * @param {object} hass - hass object (for config.internal_url/external_url)
 * @param {string} urlPath - URL or path to normalize
 * @returns {string} A URL, or a root-relative path for HA to resolve
 */
export function buildRemoteMediaUrl(hass, urlPath) {
  if (!isLoopbackOrigin(window.location.origin)) {
    return buildMediaUrl(urlPath);
  }
  const configured = hass?.config?.internal_url || hass?.config?.external_url;
  const relative = toRootRelative(urlPath);
  if (!configured) {
    // Anything already pointing somewhere reachable is left alone; only the
    // loopback origin has to be escaped.
    if (relative === null) return urlPath;
    if ((urlPath.startsWith('http://') || urlPath.startsWith('https://'))
      && !isLoopbackOrigin(urlPath)) {
      return urlPath;
    }
    return relative;
  }
  const base = configured.replace(/\/+$/, '');
  if (urlPath.startsWith('http://') || urlPath.startsWith('https://')) {
    if (!isLoopbackOrigin(urlPath)) return urlPath;
    return relative === null ? urlPath : base + relative;
  }
  return base + relative;
}

/**
 * Play an audio URL in the browser using an HTML Audio element.
 *
 * @param {string} url - Full URL to play
 * @param {number} volume - Volume 0-1
 * @param {object} callbacks
 * @param {Function} callbacks.onEnd - Called on successful completion
 * @param {Function} callbacks.onError - Called on error (receives error event)
 * @param {Function} [callbacks.onStart] - Called when playback starts
 * @returns {HTMLAudioElement} The audio element (for external stop/cleanup)
 */
export function playMediaUrl(url, volume, { onEnd, onError, onStart }) {
  const audio = new Audio();
  audio.volume = volume;

  audio.onended = () => {
    onEnd();
  };

  audio.onerror = (e) => {
    onError(e);
  };

  audio.src = url;
  audio.play().then(() => {
    onStart?.();
  }).catch((e) => {
    onError(e);
  });

  return audio;
}
