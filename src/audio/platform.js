/**
 * Audio-relevant host detection.
 *
 * Kept in one place because two different audio workarounds key off the
 * same platform facts and must not drift apart.
 */

/**
 * True on iPhone/iPad/iPod, including the iPadOS "Request Desktop Site"
 * case where Safari masquerades as macOS (MacIntel plus touch points is
 * the only reliable tell there).
 */
export function isIosHost() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /iPhone|iPad|iPod/.test(ua)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** True in Safari proper (desktop or iOS), excluding Chromium and Android. */
export function isSafariHost() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /AppleWebKit/.test(ua) && !/Chrome|Chromium|Android/.test(ua);
}
