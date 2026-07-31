import { DESTINATIONS, withTimeout } from './card.js';

/**
 * The Lovelace visual editor for the card. HA constructs it via
 * ScryptedCameraCard.getConfigElement(), assigns `hass`, calls setConfig() with the
 * current card config and listens for `config-changed`. Everything beyond that is
 * convention taken from Home Assistant's own card editors.
 *
 * card.js imports this module, which makes the pair circular: this file is evaluated
 * first and both imports above are still in their temporal dead zone while it runs.
 * Nothing here may read them at module scope - hence the schema built per mount
 * rather than once at load.
 */

// ha-form is loaded on demand by HA, so it is routinely still undefined while this
// element is being constructed. This bounds how long the editor waits before it gives
// up and points at YAML; it can only ever delay that message, because whenDefined()
// resolves in a microtask once the element is registered.
const HA_FORM_TIMEOUT = 5000;

// Bound on the add-on query, for the reason the card bounds its own Supervisor calls:
// it is a local round trip and anything past this is a fault, not slowness. A call
// that never answers would otherwise leave the interim text field for `addon` on
// screen for the life of the dialog - see _loadAddons().
const ADDON_QUERY_TIMEOUT = 10000;

// ha-form's select has no "unset" entry, so an absent `destination` needs a stand-in
// in the form. It is never written to the config - see _commit().
const NO_DESTINATION = 'default';

// The same trick for an absent `addon`, which is what the card reads as "detect it".
// A collision would need an installed add-on whose slug is literally `automatic`.
const AUTO_ADDON = 'automatic';

// A copy of the card's add-on filter, kept in step with src/card.js by hand. This is a
// decision rather than a technical limit - DESTINATIONS and withTimeout are already
// imported from there, so this predicate could be too. Left duplicated deliberately
// (2026-07-31). If the test changes in card.js it has to change here, or the editor
// will hide the candidate the card picks - or offer one the card refuses to consider.
const isScryptedAddon = (addon) => /scrypted/i.test(addon.slug) || /scrypted/i.test(addon.name);

const LABELS = {
  device: 'Scrypted device id or name',
  name: 'Name',
  aspect_ratio: 'Aspect ratio',
  autoplay: 'Start streaming immediately',
  destination: 'Stream',
  addon: 'Scrypted add-on',
  username: 'Scrypted username',
  password: 'Scrypted password',
};

const HELPERS = {
  // The editor has no Scrypted connection - that exists only once the card runs - so
  // a typo cannot be caught here and surfaces on the card as `device "..." not found`.
  device: 'The id from the Scrypted URL (/#/device/121), or the camera name. Not checked here.',
  aspect_ratio: 'Any CSS aspect-ratio value, for example 16 / 9.',
  addon: 'Only needed if add-on auto-detection picks the wrong one.',
};

const STYLES = `
  :host { display: block; }
  .note { margin: 0 0 16px; padding: 8px 12px;
          border-left: 4px solid var(--warning-color, #ffa726);
          border-radius: 4px;
          background: var(--secondary-background-color, rgba(0,0,0,.05));
          color: var(--primary-text-color, #212121);
          font: 13px/1.5 var(--paper-font-body1_-_font-family, sans-serif); }
`;

/**
 * What `addon` looks like until the add-on list arrives. The schema is built
 * synchronously per mount (see the module comment) while the query is a websocket
 * round trip, so the form is rendered with this and upgraded afterwards - an editor
 * that draws nothing until the Supervisor answers looks broken.
 */
const ADDON_TEXT = { name: 'addon', selector: { text: {} } };

/**
 * The `addon` field once the installed add-ons are known, always a select and never
 * free text. What it offers depends on how many of them look like Scrypted, because
 * the three counts mean different things:
 * - several: the candidates and nothing else. This is the case the card refuses to
 *   guess in, so the editor must not offer "automatic" either - automatic is the
 *   ambiguity, not the way out of it.
 * - exactly one: "automatic" plus that candidate. Automatic is unambiguous here and
 *   stays the default, which keeps the key out of the YAML the user reads.
 * - none: every installed add-on. An add-on named something the filter misses is
 *   exactly the case that needs picking by hand, and the full list is still a list.
 *   "Automatic" stays offered because it is what an unset `addon` already means and
 *   the form has to be able to show that; it fails with the card's own message.
 * Labels carry the name and the slug: the slug alone is not recognisable, and the name
 * alone is not what gets written into the config.
 */
const addonField = (addons) => {
  const candidates = addons.filter(isScryptedAddon);
  const options = (candidates.length ? candidates : addons)
    .map((a) => ({ value: a.slug, label: `${a.name} (${a.slug})` }));
  if (candidates.length < 2) {
    options.unshift({ value: AUTO_ADDON, label: 'Automatic (detect the Scrypted add-on)' });
  }
  let helper = HELPERS.addon;
  if (candidates.length > 1) {
    helper = 'Several installed add-ons match "scrypted", so the card cannot pick one'
      + ' for you - choose the one this card should stream from.';
  } else if (!candidates.length) {
    helper = 'No installed add-on matches "scrypted" - pick the one running Scrypted.';
  }
  return {
    field: { name: 'addon', selector: { select: { mode: 'dropdown', options } } },
    helper,
  };
};

/**
 * Built per mount, not once: see the module comment on the import cycle. The order is
 * the one a user fills the card in, which is why the two credential fields the warning
 * above the form is about come last. `addon` is passed in because it changes shape
 * once the add-on list is known, and disappears entirely if it cannot be read.
 */
const buildSchema = (addon) => [
  { name: 'device', required: true, selector: { text: {} } },
  { name: 'name', selector: { text: {} } },
  { name: 'aspect_ratio', selector: { text: {} } },
  { name: 'autoplay', selector: { boolean: {} } },
  {
    name: 'destination',
    selector: {
      select: {
        mode: 'dropdown',
        options: [
          { value: NO_DESTINATION, label: 'Default (Scrypted decides)' },
          ...DESTINATIONS.map((value) => ({ value, label: value })),
        ],
      },
    },
  },
  ...(addon ? [addon] : []),
  { name: 'username', selector: { text: {} } },
  // A password selector rather than a text one: the field sits next to a dashboard
  // preview, in a dialog that is routinely open on a screen someone else can see.
  { name: 'password', selector: { text: { type: 'password' } } },
];

/**
 * An empty value deletes its key instead of writing it, so the YAML a user reads
 * carries only the options they actually set. `false` counts as empty on purpose:
 * every boolean option here defaults to false, so writing it carries no information.
 */
const put = (config, key, value) => {
  if (value === '' || value === false || value === undefined || value === null) {
    delete config[key];
  } else {
    config[key] = value;
  }
};

class ScryptedCameraCardEditor extends HTMLElement {
  constructor() {
    super();
    this._config = null;
    this._hass = undefined;
    this._form = null;
    // Every config this editor has emitted. HA echoes each one back through
    // setConfig(), and rebuilds the object on the way, so identity is no use;
    // comparing against the latest emit alone is not enough either, because a burst of
    // keystrokes produces a queue of echoes and each older one would look like an
    // outside change and re-render the field a character or two behind the user. What
    // is not in here came from somewhere else - the YAML tab, another browser - and
    // belongs in the form. See _syncForm().
    this._echoes = new Set();
    // What the `addon` field currently is: 'text' until the add-on list arrives,
    // 'select' once it has, 'none' if it could not be read. Both _formData() and
    // _commit() have to know, because a key in the form's value with no field in the
    // schema still comes back through value-changed.
    this._addon = 'text';
    this._addonsQueried = false; // the list is read once per editor, not per render
    // computeLabel/computeHelper are assigned once but read per render, so the
    // add-on helper can be rewritten when the list decides what it should say.
    this._helpers = { ...HELPERS };
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = `
      <style>${STYLES}</style>
      <p class="note">
        <b>Username and password</b> are stored in this dashboard's configuration,
        which every logged-in Home Assistant user can read over the websocket API.
        Leave both empty unless your Scrypted add-on does not trust the ingress user.
      </p>`;
    this._mount();
  }

  /** Store and render. Emitting from here would feed HA's echo back into itself. */
  setConfig(config) {
    this._config = { ...config };
    this._syncForm();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    // Not optional: ha-form renders nothing at all without it, which is how these
    // editors end up shipping as an empty box.
    if (this._form) this._form.hass = hass;
    // The add-on query needs a connection, and HA assigns `hass` at some point after
    // construction - before or after _mount() has finished waiting for ha-form.
    // Whichever of the two happens second starts the query; _loadAddons() only runs
    // once.
    if (first) this._loadAddons();
  }

  get hass() {
    return this._hass;
  }

  async _mount() {
    // customElements.get() on its own is the trap: HA loads ha-form on demand, so it is
    // usually undefined at construction time and a plain check would ship the YAML
    // fallback to everyone, permanently. Wait for it - and then ask the registry rather
    // than trust what the race resolved with, because whenDefined() resolves with
    // undefined on older browsers and withTimeout cannot tell that from its own bound.
    await withTimeout(customElements.whenDefined('ha-form'), HA_FORM_TIMEOUT);
    if (!customElements.get('ha-form')) {
      this._note("Home Assistant's form element did not load, so there is "
        + 'nothing to draw the fields with. Configure this card in YAML instead - the '
        + "options are listed in the card's documentation.");
      return;
    }

    const form = document.createElement('ha-form');
    form.schema = buildSchema(ADDON_TEXT);
    form.computeLabel = (item) => LABELS[item.name] || item.name;
    form.computeHelper = (item) => this._helpers[item.name];
    form.hass = this._hass;
    form.data = this._formData();
    form.addEventListener('value-changed', (ev) => {
      // HA's dialog listens for config-changed; the inner form's own event is not
      // meant to leave this element.
      ev.stopPropagation();
      this._commit(ev.detail.value);
    });
    this.shadowRoot.appendChild(form);
    this._form = form;
    this._loadAddons();
  }

  /** A paragraph in place of a field there is nothing to draw. */
  _note(text) {
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = text;
    this.shadowRoot.appendChild(note);
  }

  /**
   * Turns `addon` from the interim text field into a select over the installed
   * add-ons. Runs after the form is on screen rather than before it, because the
   * schema is built synchronously per mount (see the module comment) and this is a
   * websocket round trip.
   */
  async _loadAddons() {
    if (this._addonsQueried || !this._form || !this._hass) return;
    this._addonsQueried = true;
    let addons;
    try {
      const answer = await withTimeout(this._hass.callWS({
        type: 'supervisor/api', endpoint: '/addons', method: 'get',
      }), ADDON_QUERY_TIMEOUT);
      // withTimeout resolves undefined instead of rejecting, so a Supervisor that
      // never answers has to be turned into a failure here.
      if (!answer) throw new Error(`no answer within ${ADDON_QUERY_TIMEOUT / 1000}s`);
      addons = answer.addons || [];
    } catch (err) {
      // Non-admin users, installs without a Supervisor and any Supervisor error all
      // land here. There is nothing to select from, so the field goes and a sentence
      // takes its place: an empty dropdown reads as a broken editor, and free text is
      // what this field stopped being. Every other field keeps working, and an `addon`
      // already in the config is left untouched - see _commit().
      console.warn('[scrypted-card] add-on list unavailable', err);
      this._addon = 'none';
      this._render(null);
      this._note('The list of installed add-ons could not be read, so the Scrypted '
        + 'add-on cannot be offered here. Leave it to auto-detection, or set "addon" in '
        + 'the YAML editor.');
      return;
    }
    const { field, helper } = addonField(addons);
    this._addon = 'select';
    this._helpers.addon = helper;
    this._render(field);
  }

  /**
   * Re-renders the form around a changed `addon` field. The data goes with the schema
   * because the key set changes with it. Not an emit: nothing the user did caused this.
   */
  _render(addon) {
    this._form.schema = buildSchema(addon);
    this._form.data = this._formData();
  }

  /** The config as ha-form wants it: every field present, defaults filled in. */
  _formData() {
    const c = this._config || {};
    const data = {
      device: c.device || '',
      name: c.name || '',
      aspect_ratio: c.aspect_ratio || '',
      autoplay: !!c.autoplay,
      destination: c.destination || NO_DESTINATION,
      username: c.username || '',
      password: c.password || '',
    };
    // Nothing at all while the field is not in the schema: value-changed hands back
    // whatever is in `data`, so a key without a field would still reach _commit().
    // The select's stand-in for an absent add-on is AUTO_ADDON; the interim text field
    // shows the empty string instead, because a box reading "automatic" is not
    // something the user typed.
    if (this._addon === 'select') data.addon = c.addon || AUTO_ADDON;
    else if (this._addon === 'text') data.addon = c.addon || '';
    return data;
  }

  /**
   * Writing the form's value on every setConfig() is what makes these editors fight
   * the caret: HA's echo can land a keystroke behind, and assigning `data` re-renders
   * the field with the older text and the cursor at its end. A re-entrancy flag around
   * the emit does not help - the echo is asynchronous and arrives long after any flag
   * is cleared. The structure is the fix: the form is written only for a config this
   * editor did not produce.
   */
  _syncForm() {
    if (!this._form) return; // still mounting; _mount() reads the config itself
    const data = JSON.stringify(this._formData());
    if (this._echoes.has(data)) return;
    this._form.data = JSON.parse(data);
  }

  _commit(value) {
    // Built on top of the stored config, not from scratch: `type` lives there, and so
    // does anything HA itself added - view_layout, grid_options - which this editor
    // does not know about and must not drop.
    const config = { ...(this._config || {}) };
    // The one key written even when empty. The card's setConfig() then throws and HA
    // renders that message in the preview, which is the feedback a half-filled card
    // should give.
    config.device = value.device || '';
    put(config, 'name', value.name);
    put(config, 'aspect_ratio', value.aspect_ratio);
    put(config, 'autoplay', value.autoplay);
    // Absent, never empty: an absent `destination` is what "Scrypted decides" means,
    // and the YAML should not carry a key the user did not set.
    put(config, 'destination', value.destination === NO_DESTINATION ? '' : value.destination);
    // Same rule as `destination`: automatic means the key is absent, never present and
    // empty. Skipped entirely while there is no field - an `addon` that came from YAML
    // is not the editor's to drop just because it cannot show it.
    if (this._addon !== 'none') {
      put(config, 'addon', value.addon === AUTO_ADDON ? '' : value.addon);
    }
    put(config, 'username', value.username);
    put(config, 'password', value.password);

    this._config = config;
    this._echoes.add(JSON.stringify(this._formData()));
    this.dispatchEvent(new CustomEvent('config-changed', {
      detail: { config },
      bubbles: true,
      composed: true,
    }));
  }
}

customElements.define('scrypted-camera-card-editor', ScryptedCameraCardEditor);
