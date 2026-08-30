/**
 * Shared MediaElementAudioSourceNode cache.
 *
 * `createMediaElementSource` may be called only ONCE per element for the
 * life of the document - a second call throws and permanently breaks that
 * element. Two features need the node (the output analyser and the
 * read-only-volume gain fallback), so both go through here rather than
 * keeping private caches that would collide.
 *
 * Nodes are keyed per element and remembered with the context they were
 * created on, because a node cannot be moved between AudioContexts.
 */

/** el -> { node, context } */
const cache = new WeakMap();

/**
 * Get (or create) the source node for an element.
 *
 * @param {HTMLMediaElement} el
 * @param {AudioContext} ctx
 * @returns {MediaElementAudioSourceNode|null} null when the element is
 *   already bound to a different (older) AudioContext, which is
 *   unrecoverable for that element.
 */
export function getMediaElementSource(el, ctx) {
  if (!el || !ctx) return null;
  const cached = cache.get(el);
  if (cached) {
    return cached.context === ctx ? cached.node : null;
  }
  const node = ctx.createMediaElementSource(el);
  cache.set(el, { node, context: ctx });
  return node;
}

/** True when this element already has a source node on this context. */
export function hasMediaElementSource(el, ctx) {
  const cached = cache.get(el);
  return !!cached && cached.context === ctx;
}
