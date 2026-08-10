/**
 * Redaction Helpers
 *
 * Everything the user copies out of the diagnostics panel (Copy report,
 * Copy session logs) is destined for a public GitHub issue, so hostnames
 * must not leak (#127): they announce the reporter's Home Assistant
 * address alongside its version. Redaction happens at export time only;
 * live console output keeps full URLs for real-time debugging.
 *
 * Hosts are replaced with a classifying placeholder instead of being
 * blanked, because the *kind* of host is exactly what URL bugs hinge on
 * (mixed content, LAN fallback, Nabu Casa remote). Ports and schemes are
 * kept for the same reason. Query strings are dropped entirely: signed
 * media and TTS URLs carry auth tokens there.
 */

// scheme://host[:port][rest] — host is a bracketed IPv6 literal or any
// run of non-delimiter characters; rest picks up path/query/hash.
const _URL_RE = /\b(https?|wss?):\/\/(\[[^\s\]]+\]|[^\s/:?#"'<>()[\]]+)(:\d+)?([^\s"'<>()[\]]*)/gi;

const _LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function _isPrivateIpv4(host) {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    a === 127
  );
}

/**
 * Replace a hostname with a placeholder that still says what kind of
 * host it was. Loopback is kept verbatim -- it identifies nobody and
 * "localhost" is load-bearing in secure-context diagnostics.
 */
export function redactHost(host) {
  const h = String(host || '').toLowerCase();
  if (_LOOPBACK.has(h)) return host;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    return _isPrivateIpv4(h) ? '<private-ip>' : '<public-ip>';
  }
  if (h.startsWith('[')) return '<redacted-ip>';
  if (h.endsWith('.local')) return '<mdns-host>';
  if (h.endsWith('.ui.nabu.casa')) return '<nabu-casa-host>';
  return '<redacted-host>';
}

/**
 * Redact every absolute URL in a blob of text: host classified, port
 * and path kept, query/hash dropped (auth tokens live there).
 */
export function redactText(text) {
  return String(text ?? '').replace(_URL_RE, (_all, scheme, host, port, rest) => {
    let tail = rest || '';
    const cut = Math.min(
      ...['?', '#'].map((c) => {
        const i = tail.indexOf(c);
        return i === -1 ? Infinity : i;
      }),
    );
    if (cut !== Infinity) tail = `${tail.slice(0, cut)}?<redacted-query>`;
    return `${scheme}://${redactHost(host)}${port || ''}${tail}`;
  });
}

/** Redact a single URL string. Non-URLs are returned unchanged. */
export function redactUrl(url) {
  return redactText(url);
}
