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

// ha-form's select has no "unset" entry, so an absent `destination` needs a stand-in
// in the form. It is never written to the config - see _commit().
const NO_DESTINATION = 'default';

const LABELS = {
  device: 'Scrypted device id or name',
  name: 'Name',
  aspect_ratio: 'Aspect ratio',
  autoplay: 'Start streaming immediately',
  destination: 'Stream',
  source: 'Scrypted add-on or integration entry',
  username: 'Scrypted username',
  password: 'Scrypted password',
};

const HELPERS = {
  // The editor has no Scrypted connection - that exists only once the card runs - so
  // a typo cannot be caught here and surfaces on the card as `device "..." not found`.
  device: 'The id from the Scrypted URL (/#/device/121), or the camera name. Not checked here.',
  aspect_ratio: 'Any CSS aspect-ratio value, for example 16 / 9.',
  // Three things this has to carry, because one field now stands where three did: that
  // the card chooses the route by itself, that the value means something different on
  // each of them, and that empty is the normal case. The Name-versus-host warning stays -
  // Home Assistant lists each integration entry under its *host*, so a user who reads
  // "entry" and types the host matches nothing.
  source: 'Leave empty unless the default does not fit. The card uses the koush/ha_scrypted'
    + ' integration when it is installed, otherwise the Scrypted add-on - and Scrypted'
    + ' credentials below always mean the add-on. Empty means the only integration entry,'
    + " or the add-on's usual slug. Filled in, it names that entry's Name (not the host"
    + ' Home Assistant lists it under) or the add-on slug.',
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
 * Built per mount, not once: see the module comment on the import cycle. The order is
 * the one a user fills the card in, which is why the two credential fields the warning
 * above the form is about come last.
 */
const buildSchema = () => [
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
  // One field for both routes, because the card picks the route itself - and deliberately
  // not prefilled with the add-on's default slug the way `addon` was. That default only
  // applies to one of the two routes, and showing it would put a slug in front of every
  // integration user, who then has to know it is wrong for them.
  { name: 'source', selector: { text: {} } },
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
    this.attachShadow({ mode: 'open' });
    // One note covering both modes rather than one note per mode. Written here it is
    // written once, while the selected mode is known only from setConfig() - which HA calls
    // on every keystroke - so a mode-dependent text would add a second render path to the
    // one element in this file whose whole design is about not re-rendering on an echo.
    // Nothing is lost by it: everything above the last sentence stays true in `integration`
    // mode too, because _commit() writes these two fields whatever the mode is and only the
    // *card* refuses them. The last sentence is the half that would lie, so it names the
    // exception instead of disappearing with it.
    this.shadowRoot.innerHTML = `
      <style>${STYLES}</style>
      <p class="note">
        <b>Username and password</b> are stored in this dashboard's configuration,
        which every logged-in Home Assistant user can read over the websocket API.
        Use a Scrypted viewer account limited to the cameras this card should show -
        filling these in is what stops the card seeing more than that. They also pin the
        card to the Scrypted <b>add-on</b>: the koush/ha_scrypted route always reaches
        Scrypted as the integration's own account, so there would be nothing here to
        scope it with.
      </p>`;
    this._mount();
  }

  /** Store and render. Emitting from here would feed HA's echo back into itself. */
  setConfig(config) {
    this._config = { ...config };
    this._syncForm();
  }

  set hass(hass) {
    this._hass = hass;
    // Not optional: ha-form renders nothing at all without it, which is how these
    // editors end up shipping as an empty box.
    if (this._form) this._form.hass = hass;
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
    form.schema = buildSchema();
    form.computeLabel = (item) => LABELS[item.name] || item.name;
    form.computeHelper = (item) => HELPERS[item.name];
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
  }

  /** A paragraph in place of a field there is nothing to draw. */
  _note(text) {
    const note = document.createElement('p');
    note.className = 'note';
    note.textContent = text;
    this.shadowRoot.appendChild(note);
  }

  /** The config as ha-form wants it: every field present, defaults filled in. */
  _formData() {
    const c = this._config || {};
    return {
      device: c.device || '',
      name: c.name || '',
      aspect_ratio: c.aspect_ratio || '',
      autoplay: !!c.autoplay,
      destination: c.destination || NO_DESTINATION,
      // Not filled in from a pre-0.5.0 `addon`, because the card does not read that key
      // either: showing its value here would promise a card that works. An empty field on
      // an old config is the honest rendering, and _commit() then drops the dead key.
      source: c.source || '',
      username: c.username || '',
      password: c.password || '',
    };
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
    put(config, 'source', value.source);
    // The three keys 0.5.0 dropped. None of them is read any more, so they are inert - but a
    // key sitting in the YAML reads as if it does something, and `addon` in particular used
    // to. Removing them unconditionally means one visit to this editor is enough to make a
    // config say what it actually does. It is also why the field above is not prefilled from
    // `addon`: the value is dead, and showing it would promise otherwise.
    delete config.addon;
    delete config.connection;
    delete config.integration_title;
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
