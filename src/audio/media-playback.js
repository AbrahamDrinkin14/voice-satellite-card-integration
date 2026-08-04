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

/**
 * Normalize a URL path to an absolute URL that devices OTHER than this one
 * can fetch. Use for any URL handed off externally (media_player.play_media
 * on a remote speaker); use buildMediaUrl for URLs played on this device.
 *
 * Normally identical to buildMediaUrl. The difference is Kiosk Satellite,
 * which serves the page through an in-app loopback proxy (127.0.0.1) to
 * satisfy the secure-context requirement - an origin only this device can
 * reach. In that case relative paths resolve against Home Assistant's real
 * network address (internal_url, else external_url) instead, and absolute
 * loopback URLs (e.g. a retry of a previously built URL) are re-based the
 * same way.
 *
 * @param {object} hass - hass object (for config.internal_url/external_url)
 * @param {string} urlPath - URL or path to normalize
 * @returns {string} Absolute URL reachable from other devices
 */
export function buildRemoteMediaUrl(hass, urlPath) {
  if (!isLoopbackOrigin(window.location.origin)) {
    return buildMediaUrl(urlPath);
  }
  const configured = hass?.config?.internal_url || hass?.config?.external_url;
  if (!configured) {
    // No better base known - keep the old behavior rather than emit garbage.
    return buildMediaUrl(urlPath);
  }
  const base = configured.replace(/\/+$/, '');
  if (urlPath.startsWith('http://') || urlPath.startsWith('https://')) {
    if (!isLoopbackOrigin(urlPath)) return urlPath;
    try {
      const u = new URL(urlPath);
      return base + u.pathname + u.search + u.hash;
    } catch (_) {
      return urlPath;
    }
  }
  return urlPath.startsWith('/') ? base + urlPath : `${base}/${urlPath}`;
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
