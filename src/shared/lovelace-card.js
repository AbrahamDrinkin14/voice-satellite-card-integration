/**
 * Lovelace card mounting for LLM tool results.
 *
 * A tool result carrying a `card` key (a Lovelace card config) paints
 * that card into the media panel, the same way `featured_image` paints
 * an image.  No tool-name coupling: any tool, from any integration, gets
 * the panel by returning the key.  Assistants without a screen ignore it.
 *
 * Two things the HA frontend does for us on a dashboard but not on a
 * bare page, and that this module has to arrange:
 *
 *   1. `window.loadCardHelpers` only exists once a Lovelace panel has
 *      loaded.  On /voice-satellite (and on a dashboard the user hasn't
 *      visited yet this session) it is missing, so we drive the frontend
 *      into loading it - the same bootstrap the settings panel uses to
 *      get `ha-form`.
 *   2. Custom cards live in the user's registered Lovelace resources,
 *      which are only injected on a dashboard.  We fetch that list over
 *      the websocket and import it ourselves.
 *
 * Resource URLs come from the registry, never from the tool result: a
 * module URL chosen by a model would be arbitrary code execution in the
 * HA frontend origin.  A custom card the user has not registered simply
 * renders as HA's "Custom element doesn't exist" error card.
 */

// Card types whose whole point is a picture: they read badly in a
// narrow column and are what someone means by "show me". Everything
// else (tiles, entity lists, graphs) is fine at the default width.
const WIDE_CARD_TYPES = new Set([
  'picture',
  'picture-entity',
  'picture-glance',
  'picture-elements',
  'iframe',
  'map',
]);

/**
 * Size bucket for a card: 'wide' or 'compact'.
 *
 * An explicit hint from the tool wins, since only the tool knows what it
 * meant to show. Without one, the card type decides, so a camera fills
 * the panel without every tool having to opt in.
 *
 * @param {object} config - Lovelace card config
 * @param {string} [hint] - 'wide' | 'compact' from the tool result
 * @returns {string} 'wide' or 'compact'
 */
export function inferCardSize(config, hint) {
  if (hint === 'wide' || hint === 'compact') return hint;
  const type = String(config?.type || '');
  if (WIDE_CARD_TYPES.has(type)) return 'wide';
  // Custom camera cards (webrtc-camera, frigate-card, advanced-camera-card)
  // all carry "camera" in the type and want the same treatment.
  if (type.startsWith('custom:') && type.includes('camera')) return 'wide';
  return 'compact';
}

let _helpersPromise = null;
let _resourcesPromise = null;

// Ceiling on waiting for a card module to define its element. Only hit
// when the type never resolves (a custom card the user has not
// registered), where mounting anyway yields HA's missing-element card.
const CARD_DEFINE_TIMEOUT_MS = 5000;

/**
 * Resolve HA's card helpers, bootstrapping the Lovelace bundle first
 * when the page never loaded a dashboard.
 *
 * @returns {Promise<object>} HA card helpers
 */
export function ensureCardHelpers() {
  if (_helpersPromise) return _helpersPromise;

  _helpersPromise = (async () => {
    if (!window.loadCardHelpers) {
      // Same trick as the settings panel's _loadComponents(): resolving
      // a fake lovelace route makes the frontend import the Lovelace
      // bundle, which is what defines window.loadCardHelpers.
      await customElements.whenDefined('partial-panel-resolver');
      const resolver = document.createElement('partial-panel-resolver');
      const routes = resolver._getRoutes?.([
        { component_name: 'lovelace', url_path: 'a' },
      ]);
      await routes?.routes?.a?.load?.();
    }
    if (!window.loadCardHelpers) {
      throw new Error('Lovelace card helpers are unavailable in this frontend');
    }
    return window.loadCardHelpers();
  })();

  // Let a later card retry rather than caching the failure forever.
  _helpersPromise.catch(() => { _helpersPromise = null; });
  return _helpersPromise;
}

/**
 * Import the user's registered Lovelace module resources once, so
 * `custom:` card types resolve.  Best-effort: a resource that fails to
 * load leaves its card to render as HA's missing-element error card,
 * which is more useful than failing the whole mount.
 *
 * @param {object} hass - HA frontend object
 * @param {object} [log] - Logger
 * @returns {Promise<void>}
 */
function ensureLovelaceResources(hass, log) {
  if (_resourcesPromise) return _resourcesPromise;

  _resourcesPromise = (async () => {
    const resources = await hass.connection.sendMessagePromise({
      type: 'lovelace/resources',
    });
    if (!Array.isArray(resources)) return;

    for (const resource of resources) {
      // Only ES modules. The legacy 'js' / 'html' resource types predate
      // HA 2021 and are not loadable this way.
      if (resource?.type !== 'module' || !resource.url) continue;
      try {
        await import(/* webpackIgnore: true */ resource.url);
      } catch (e) {
        log?.log?.('lovelace', `Resource failed to load: ${resource.url} (${e?.message || e})`);
      }
    }
  })();

  _resourcesPromise.catch(() => { _resourcesPromise = null; });
  return _resourcesPromise;
}

/**
 * Make sure the element class for this card type is defined before we
 * build the element we intend to mount.
 *
 * HA lazy-loads card modules: the first createCardElement() for a type
 * starts the import and re-applies the config when it lands. That
 * re-apply renders the card, and it can beat an `el.hass = ...` written
 * against the not-yet-upgraded element, leaving the card to render with
 * no hass at all. Most cards shrug that off and recover on the next
 * update; ha-camera-stream calls hass.callWS() from willUpdate and
 * throws. Creating a throwaway element first pays for the import, so the
 * element we keep is upgraded and takes hass synchronously.
 *
 * @param {object} helpers - HA card helpers
 * @param {object} config - Lovelace card config
 * @returns {Promise<void>}
 */
async function ensureCardDefined(helpers, config) {
  let probe;
  try {
    probe = helpers.createCardElement(config);
  } catch (_) {
    return null; // invalid config - the real call renders HA's error card
  }
  const tag = probe?.localName;
  if (!tag) return null;
  // HA hands back its own error card for a type it cannot resolve. That
  // element is defined, so it would pass the check below and then be fed
  // the original config, which it has no idea what to do with. Report no
  // tag instead and let the caller ask HA to build the error card
  // properly, message and all.
  if (tag === 'hui-error-card') return null;
  if (customElements.get(tag)) return tag;

  await Promise.race([
    customElements.whenDefined(tag),
    new Promise((resolve) => setTimeout(resolve, CARD_DEFINE_TIMEOUT_MS)),
  ]);
  return customElements.get(tag) ? tag : null;
}

/**
 * Relay Lit context requests from our overlay to the frontend root.
 *
 * Modern HA components do not all take a `hass` property.
 * ha-camera-stream consumes `apiContext`, `connectionContext` and
 * `configContext` via @consume, and a context resolves by bubbling a
 * `context-request` event up the DOM to a provider. Every provider lives
 * on the <home-assistant> element (src/state/context-mixin.ts). Our
 * overlay hangs off document.body, outside that element, so requests
 * from a card we mount reach no provider and the consumer keeps an
 * undefined value - which is why ha-camera-stream threw on
 * `_api.callWS` no matter what we did with hass.
 *
 * Forwarding each request to the root element gets the same answer a
 * dashboard card would, subscriptions included, since the consumer's own
 * callback is what we hand over.
 *
 * @param {HTMLElement} host - Element containing the mounted cards
 */
/**
 * A hidden node parented to <home-assistant>, used as the origin for
 * relayed context requests.
 *
 * The relay cannot be dispatched on the root element itself: @lit/context
 * providers skip any request whose consumer resolves to their own host
 * (`ev.contextTarget ?? ev.composedPath()[0]`), a guard against an
 * element that both provides and consumes a context registering with
 * itself. Dispatching from a child clears that check and still bubbles
 * into the provider. The node is a light-DOM child of an element that
 * renders through a shadow root, so it never appears on screen.
 *
 * @returns {HTMLElement|null} The anchor, or null without a frontend root
 */
function contextAnchor() {
  const root = document.querySelector('home-assistant');
  if (!root) return null;
  if (root._vsContextAnchor?.isConnected) return root._vsContextAnchor;

  const anchor = document.createElement('span');
  anchor.style.display = 'none';
  root.appendChild(anchor);
  root._vsContextAnchor = anchor;
  return anchor;
}

function bridgeContexts(host, log) {
  if (host._vsContextBridge) return;
  host._vsContextBridge = true;

  host.addEventListener('context-request', (ev) => {
    const anchor = contextAnchor();
    if (!anchor) return;
    ev.stopPropagation();
    // A fresh event: the original is mid-dispatch and cannot be
    // redispatched. Providers read only these fields.
    const relay = new Event('context-request', { bubbles: true, composed: true });
    relay.context = ev.context;
    relay.subscribe = ev.subscribe;
    // Name the real consumer, so a provider that reads contextTarget
    // attributes the subscription to the card rather than the anchor.
    relay.contextTarget = ev.contextTarget ?? ev.target;
    let answered = false;
    relay.callback = (...args) => {
      answered = true;
      ev.callback(...args);
    };
    anchor.dispatchEvent(relay);
    // Only the failure is worth logging: an unanswered request means the
    // card will render with an undefined value and usually throw from
    // inside HA, which is otherwise hard to trace back to here.
    if (!answered) {
      log?.log?.(
        'lovelace',
        `Unanswered context ${String(ev.context?.name ?? ev.context)} `
        + `for ${ev.target?.localName}`,
      );
    }
  });
}

/**
 * The live hass object, preferring the caller's and falling back to the
 * frontend's root element.
 *
 * A Lovelace card is useless without hass, and some of them reach for it
 * the moment they upgrade: ha-camera-stream calls hass.callWS() straight
 * out of willUpdate, so an undefined hass is an uncaught TypeError deep
 * in HA's code rather than a card that renders empty and recovers on the
 * next update.  <home-assistant> always carries the current object (it is
 * where dashboard cards ultimately get theirs), so it is a safe backstop
 * for any path where the card instance has not been handed one yet.
 *
 * @param {object} [hass] - Caller's hass, if it has one
 * @param {object} [log] - Logger
 * @returns {object|null} A hass object, or null if the frontend has none
 */
function resolveHass(hass, log) {
  if (hass) return hass;
  const root = document.querySelector('home-assistant')?.hass || null;
  if (root) {
    log?.log?.('lovelace', 'Card mounted with hass from <home-assistant>');
  }
  return root;
}

/**
 * Mount a Lovelace card config inside a container element.
 *
 * The container must already be in the document: the element is attached
 * before it is configured, because context consumers dispatch their
 * request from connectedCallback and the card's first render has to see
 * the resolved values. A bad config or a missing custom card mounts HA's
 * own error card instead, so the panel shows the same rectangle a
 * dashboard would.
 *
 * @param {HTMLElement} container - Attached element to mount into
 * @param {object} hass - HA frontend object
 * @param {object} config - Lovelace card config
 * @param {object} [log] - Logger
 * @returns {Promise<HTMLElement|null>} The mounted element, or null if
 *   the container was detached before mounting finished
 */
export async function mountLovelaceCard(container, hass, config, log) {
  const helpers = await ensureCardHelpers();
  const live = resolveHass(hass, log);

  if (String(config?.type || '').startsWith('custom:')) {
    try {
      await ensureLovelaceResources(live, log);
    } catch (e) {
      log?.log?.('lovelace', `Resource registry unavailable: ${e?.message || e}`);
    }
  }

  const mountError = (message) => {
    const el = helpers.createCardElement({
      type: 'error',
      error: message,
      origConfig: config,
    });
    el.hass = live;
    container.appendChild(el);
    return el;
  };

  if (!container.isConnected) return null; // turn cleared while loading

  if (!live) {
    return mountError('No Home Assistant connection available to render this card');
  }

  bridgeContexts(container, log);

  const tag = await ensureCardDefined(helpers, config);
  if (!container.isConnected) return null;

  if (!tag) {
    // Unregistered custom card: let HA build its missing-element card.
    const el = helpers.createCardElement(config);
    el.hass = live;
    container.appendChild(el);
    return el;
  }

  const el = document.createElement(tag);
  // Attach first: connecting resolves the card's contexts through the
  // bridge above, and the first render needs them in place.
  container.appendChild(el);
  try {
    // Config before hass, the order HA itself uses. Cards are written
    // against it: mini-graph-card's hass setter walks config.entities and
    // throws outright when hass lands first.
    el.setConfig(config);
    el.hass = live;
  } catch (e) {
    log?.log?.('lovelace', `Card rejected its config: ${e?.message || e}`);
    el.remove();
    return mountError(e?.message || String(e));
  }
  return el;
}
