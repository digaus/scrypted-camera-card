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

// The same trick for `source`, and mapped back only while that field is a dropdown: in text
// mode this string is a value a user could conceivably type, and turning it into "unset"
// there would delete an add-on slug that happened to read like it. See _commit().
const NO_SOURCE = 'auto';

// The slug is not exposed as a field anywhere a non-admin may look, but the Supervisor's
// per-add-on update entity carries it in its icon URL:
//   update.scrypted_update | Scrypted | /api/hassio/addons/09e60fb6_scrypted/icon
// Measured 2026-08-05 on a non-admin account, which is the whole point - `/addons`, the
// endpoint that would answer this properly, is the one admin-gated call this card ever made
// and is deliberately still not used. A heuristic on an internal detail, so the feature is
// built to lose nothing when it stops matching: no candidates means the field is free text,
// exactly as it was before.
const ADDON_ICON = /^\/api\/hassio\/addons\/([^/]+)\/icon/;

// Duplicated from the card's own _scryptedPanels() rather than imported: neither it nor its
// prefix are exported, and widening the card's export surface for the editor's convenience is
// worse than four lines that say the same thing in one place per file.
const PANEL_PREFIX = 'scrypted_';

/**
 * Every Scrypted source this Home Assistant can be seen to have, as ha-form options. Both
 * lists come out of `hass` with no network call, so this works for the non-admin accounts
 * this card is meant to serve.
 *
 * Integration entries first: with the integration installed that is the route the card takes
 * (see _pickRoute() in card.js), so the likely answer belongs at the top of the list.
 *
 * The add-on side is filtered to Scrypted by name, because unfiltered it would offer esphome,
 * ssh and vscode as the source of a camera - a wrong choice invited is worse than a missing
 * one offered. The cost is that a Scrypted add-on named nothing like Scrypted cannot be
 * *selected*; it can still be set in YAML, and docs/limitations.md says so.
 */
const scryptedSources = (hass) => {
  const out = [];
  const seen = new Set();
  const add = (value, label) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    out.push({ value, label });
  };
  // Tolerant of everything missing: this runs while the dialog is still opening.
  for (const panel of Object.values(hass?.panels || {})) {
    if (typeof panel?.url_path === 'string' && panel.url_path.startsWith(PANEL_PREFIX)) {
      // The *title*, because that is what the card matches on - and the reason this list
      // exists at all: Home Assistant lists the same entry under its host, so the value a
      // user would have typed is the wrong one.
      add(panel.title, `${panel.title} - koush/ha_scrypted entry`);
    }
  }
  for (const state of Object.values(hass?.states || {})) {
    const slug = (ADDON_ICON.exec(state?.attributes?.entity_picture || '') || [])[1];
    if (!slug) continue; // not an add-on entity; some update entities carry no picture at all
    const title = state.attributes.title || slug;
    if (!/scrypted/i.test(slug) && !/scrypted/i.test(title)) continue;
    add(slug, `${title} - add-on (${slug})`);
  }
  return out;
};

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
  // Shorter than it was, because the list now carries what the prose used to: with a
  // dropdown of real names there is no Name-versus-host confusion left to warn about. What
  // remains is what "Automatic" means and the one thing the field cannot show - that
  // credentials decide the route, not this.
  source: 'Which Scrypted this card talks to. "Automatic" is right unless you have more than'
    + ' one: it takes the only koush/ha_scrypted entry, or the Scrypted add-on. Filling in'
    + ' Scrypted credentials below always means the add-on, whatever is chosen here.',
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
 *
 * `sources` decides what `source` is drawn as. A dropdown is only offered when the list can
 * express the value the card already has - see _mount() for why that condition is not just
 * "the list is non-empty".
 */
const buildSchema = (sources) => [
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
  // One field for both routes, because the card picks the route itself. A list of what is
  // installed where there is one, free text where there is not - and no `custom_value`
  // combobox in between: a list that can also be typed into is a list nobody reads.
  sources.length
    ? {
      name: 'source',
      selector: {
        select: {
          mode: 'dropdown',
          options: [
            { value: NO_SOURCE, label: 'Automatic (the only entry, or the default add-on)' },
            ...sources,
          ],
        },
      },
    }
    // Exactly the field 0.5.0 shipped, so an installation neither heuristic can see is no
    // worse off than before they existed.
    : { name: 'source', selector: { text: {} } },
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
    // Whether `source` is drawn as a dropdown, and the options if so. Decided in
    // _decideSource() once `hass` and the config have both arrived - which is *after* this
    // constructor and after _mount()'s first pass. Seeded to the text field so the form can
    // render before that happens rather than waiting for it.
    this._sourceSelect = false;
    this._sources = [];
    this._decided = false;
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
    this._decideSource();
  }

  set hass(hass) {
    this._hass = hass;
    // Not optional: ha-form renders nothing at all without it, which is how these
    // editors end up shipping as an empty box.
    if (this._form) this._form.hass = hass;
    this._decideSource();
  }

  get hass() {
    return this._hass;
  }

  /**
   * Which control `source` gets, decided once - but only once both `hass` and the config are
   * here. 0.5.1 decided it in _mount(), which runs from the constructor: Home Assistant
   * assigns `hass` and calls setConfig() *after* that, so the scan ran against nothing and
   * every installation got the text field. The plan said to tolerate a missing `hass`; what
   * it missed is that tolerating absence is worthless if the answer is then kept.
   *
   * Still exactly once, because the alternative is a scan of `hass.states` on every state
   * update - thousands of entities, several times a second - and a field that could change
   * shape under the user's cursor.
   *
   * `_decided` rather than a truthiness check on `_sources`: "nothing is installed" is a real
   * answer and must not be retried forever.
   */
  _decideSource() {
    if (this._decided || !this._hass || !this._config) return;
    this._decided = true;
    const sources = scryptedSources(this._hass);
    const current = this._config.source || '';
    // Not simply "any candidates were found". A `source` the list cannot express - a slug set
    // in YAML, a renamed add-on, an entry that is not loaded right now - must stay text, or
    // ha-form would render the dropdown with nothing selected and the first edit of any other
    // field would commit that emptiness over a working configuration.
    this._sourceSelect = sources.length > 0
      && (!current || sources.some((s) => s.value === current));
    this._sources = this._sourceSelect ? sources : [];
    // The form may already be mounted with the text field: whichever of the two setters is
    // last does this, and _mount() can finish before either. Reassigning `data` alongside the
    // schema is deliberate - the stand-in for "empty" only exists in the dropdown - and safe
    // here in a way _syncForm() is not: this fires once, at open, before anyone has typed.
    if (this._form) {
      this._form.schema = buildSchema(this._sources);
      this._form.data = this._formData();
    }
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
    form.schema = buildSchema(this._sources);
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
      // The stand-in only where the field is a dropdown, because only a dropdown needs one.
      // Not filled in from a pre-0.5.0 `addon` either: the card does not read that key, so
      // showing its value would promise a card that works. _commit() drops the dead key.
      source: c.source || (this._sourceSelect ? NO_SOURCE : ''),
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
    // The stand-in maps back to absent, and only in dropdown mode: in text mode "auto" is a
    // string a user could have typed as a slug, and deleting their key for it would be a
    // silent edit of a config that was never wrong.
    put(config, 'source',
      this._sourceSelect && value.source === NO_SOURCE ? '' : value.source);
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
