/**
 * Satellite State Helpers
 *
 * Read satellite entity attributes and sibling switch states
 * from the HA frontend cache. These are pure lookups with no
 * side-effects, shared across all managers.
 *
 * Sibling lookups go through a per-device index instead of walking
 * hass.entities. Every helper here answers "which entity on the
 * satellite's device has this translation_key?", and each used to
 * answer it with a full registry walk per call. updateHass() asks a
 * dozen such questions on every state batch, and on a ~5000-entity
 * instance that added up to 200-300ms of main-thread work per tick,
 * felt as UI stutter at exactly the interaction transitions (wake,
 * chime end, TTS start) because those are when state batches arrive.
 */

/**
 * Sibling index, keyed on the hass.entities object itself.
 *
 * hass.entities is the frontend's entity-registry cache: state updates
 * replace hass but keep the same hass.entities reference, which only
 * changes when the registry itself changes. Keying the WeakMap on it
 * means no invalidation logic at all: a registry change simply misses
 * and rebuilds (one walk), and the old index is garbage.
 */
const _siblingIndex = new WeakMap();

const _noSiblings = [];

/**
 * All of the integration's own entities on the satellite's device, as
 * [entityId, registryEntry] pairs in registry order. Registry order is
 * preserved so first-match semantics are identical to the full walks
 * these lookups replaced.
 *
 * @param {object} hass - HA frontend object
 * @param {string} satelliteId - Satellite entity ID
 * @returns {Array<[string, object]>} Sibling entries, empty if unknown
 */
export function getSiblingEntities(hass, satelliteId) {
  if (!hass?.entities || !satelliteId) return _noSiblings;
  const satellite = hass.entities[satelliteId];
  if (!satellite?.device_id) return _noSiblings;
  let byDevice = _siblingIndex.get(hass.entities);
  if (!byDevice) {
    byDevice = new Map();
    for (const eid in hass.entities) {
      const entry = hass.entities[eid];
      if (entry?.platform !== 'voice_satellite' || !entry.device_id) continue;
      let list = byDevice.get(entry.device_id);
      if (!list) byDevice.set(entry.device_id, (list = []));
      list.push([eid, entry]);
    }
    _siblingIndex.set(hass.entities, byDevice);
  }
  return byDevice.get(satellite.device_id) || _noSiblings;
}

/**
 * Read an attribute from the satellite entity's HA state.
 * @param {object} hass - HA frontend object
 * @param {string} entityId - Satellite entity ID
 * @param {string} name - Attribute name
 * @returns {*} Attribute value, or undefined if unavailable
 */
export function getSatelliteAttr(hass, entityId, name) {
  if (!hass || !entityId) return undefined;
  const state = hass.states[entityId];
  return state?.attributes?.[name];
}

/**
 * Read a select entity's resolved entity_id attribute from the entity registry.
 * @param {object} hass - HA frontend object
 * @param {string} satelliteId - Satellite entity ID
 * @param {string} translationKey - Select translation_key (e.g. 'tts_output')
 * @returns {string|undefined} The entity_id attribute value, or undefined if not found
 */
export function getSelectEntityId(hass, satelliteId, translationKey) {
  for (const [eid, entry] of getSiblingEntities(hass, satelliteId)) {
    if (entry.translation_key === translationKey) {
      return hass.states[eid]?.attributes?.entity_id || '';
    }
  }
  return undefined;
}

/**
 * Read a number entity's numeric value from the entity registry.
 * @param {object} hass - HA frontend object
 * @param {string} satelliteId - Satellite entity ID
 * @param {string} translationKey - Number translation_key
 * @param {number} defaultValue - Fallback if not found
 * @returns {number} The numeric value, or defaultValue if not found
 */
export function getNumberState(hass, satelliteId, translationKey, defaultValue) {
  for (const [eid, entry] of getSiblingEntities(hass, satelliteId)) {
    if (entry.translation_key === translationKey) {
      const val = parseFloat(hass.states[eid]?.state);
      if (!isNaN(val)) return val;
      break;
    }
  }

  // Fallback to the satellite entity attribute exposed by the integration.
  // This is more resilient on HA versions/frontends where hass.entities
  // metadata (translation_key/device cache) may not be ready yet.
  const attrVal = parseFloat(getSatelliteAttr(hass, satelliteId, translationKey));
  return isNaN(attrVal) ? defaultValue : attrVal;
}

/**
 * Read a select entity's state value directly from the entity registry.
 * Unlike getSelectEntityId (which reads the entity_id attribute), this
 * returns the select entity's display state (e.g. "Home Assistant", "ok_nabu").
 *
 * @param {object} hass - HA frontend object
 * @param {string} satelliteId - Satellite entity ID
 * @param {string} translationKey - Select translation_key
 * @param {string} [defaultValue] - Fallback if not found
 * @returns {string|undefined} The select state value, or defaultValue
 */
export function getSelectState(hass, satelliteId, translationKey, defaultValue) {
  for (const [eid, entry] of getSiblingEntities(hass, satelliteId)) {
    if (entry.translation_key === translationKey) {
      const val = hass.states[eid]?.state;
      if (val && val !== 'unknown' && val !== 'unavailable') return val;
      break;
    }
  }

  // Fallback to satellite extra_state_attributes
  const attrVal = getSatelliteAttr(hass, satelliteId, translationKey);
  return attrVal !== undefined ? attrVal : defaultValue;
}

/**
 * Read a select entity's options list from its HA state attributes.
 * @param {object} hass - HA frontend object
 * @param {string} satelliteId - Satellite entity ID
 * @param {string} translationKey - Select translation_key (e.g. 'wake_word_model')
 * @returns {string[]} The options array, or empty array if not found
 */
export function getSelectOptions(hass, satelliteId, translationKey) {
  for (const [eid, entry] of getSiblingEntities(hass, satelliteId)) {
    if (entry.translation_key === translationKey) {
      const options = hass.states[eid]?.attributes?.options;
      return Array.isArray(options) ? options : [];
    }
  }
  return [];
}

/**
 * Read an arbitrary attribute from a select entity (located via its
 * translation_key on the same device as the satellite entity).  Used
 * by the panel tester to read both engine catalogs (mww_models +
 * oww_models) from the wake_word_model entity regardless of which
 * detection mode is currently active.
 *
 * @param {object} hass
 * @param {string} satelliteId
 * @param {string} translationKey
 * @param {string} attrName
 * @returns {*} The attribute value or undefined.
 */
export function getSelectAttribute(hass, satelliteId, translationKey, attrName) {
  for (const [eid, entry] of getSiblingEntities(hass, satelliteId)) {
    if (entry.translation_key === translationKey) {
      return hass.states[eid]?.attributes?.[attrName];
    }
  }
  return undefined;
}

/**
 * Read a switch entity's on/off state directly from the entity registry
 * and state cache, bypassing satellite extra_state_attributes (which can
 * be stale if the state-change listener wasn't set up in time).
 *
 * @param {object} hass - HA frontend object
 * @param {string} satelliteId - Satellite entity ID
 * @param {string} translationKey - Switch translation_key ('mute' | 'wake_sound')
 * @returns {boolean|undefined} true if switch is on, false if off, undefined if not found
 */
export function getSwitchState(hass, satelliteId, translationKey) {
  const eid = getSwitchEntityId(hass, satelliteId, translationKey);
  if (eid) {
    const state = hass.states[eid]?.state;
    // 'unavailable'/'unknown' (integration reloading, HA restarting)
    // falls through to the fallbacks so a transient outage doesn't
    // read as "off" and flap consumers like the screensaver.
    if (state === 'on' || state === 'off') return state === 'on';
  }

  // Fallback: satellite extra_state_attributes (may be stale)
  const attrName = translationKey === 'mute' ? 'muted' : translationKey;
  const val = getSatelliteAttr(hass, satelliteId, attrName);
  return val !== undefined ? val === true : undefined;
}

/**
 * Find a sibling switch entity's entity_id via the frontend entity
 * registry cache.  Restricted to the switch domain so translation keys
 * shared with other platforms (e.g. 'screensaver' switch vs
 * 'screensaver_active' binary sensor) can't mismatch.
 *
 * @param {object} hass - HA frontend object
 * @param {string} satelliteId - Satellite entity ID
 * @param {string} translationKey - Switch translation_key
 * @returns {string|undefined} The switch entity_id, or undefined if not found
 */
export function getSwitchEntityId(hass, satelliteId, translationKey) {
  for (const [eid, entry] of getSiblingEntities(hass, satelliteId)) {
    if (eid.startsWith('switch.') &&
        entry.translation_key === translationKey) {
      return eid;
    }
  }
  return undefined;
}
