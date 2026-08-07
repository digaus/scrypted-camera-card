import { connectScryptedClient } from '@scrypted/client';
import { BrowserSession } from './signaling.js';
// Imported for its side effect - it registers the editor element. build.mjs declares
// a single entry point and hacs.json names exactly one file, so an editor that is not
// reachable from here never reaches the bundle HACS serves.
import './editor.js';

const SESSION_KEEPALIVE = 300000; // supervisor ingress sessions expire
const REFRESH_MARGIN = 15000;     // extend the RTC session this early
// Bounds for the two connects in _start(). Neither underlying call brings a
// timeout of its own, and an add-on that is reachable but unresponsive never
// rejects - so without these the card sits on a spinner forever and never reaches
// _scheduleRetry(). Both numbers are reasoned, not measured; PLAN_F05
// Verification 2 is what confirms or corrects them.
// The ingress bound covers three hass.callWS round trips to the *local*
// Supervisor, which should answer in well under a second. Anything past this is a
// fault, not slowness, and a different fault from a slow add-on.
const INGRESS_TIMEOUT = 10000;
// The connect bound has to clear the slowest cold add-on start we are willing to
// support, not the average one: too aggressive is worse than the bug it fixes,
// because a healthy but slow system would then retry forever and look broken to
// its owner - on other people's hardware before ours.
const CONNECT_TIMEOUT = 45000;
// Quiet period before a connection-relevant config edit is acted on. HA's visual
// editor emits a config per keystroke and nothing in that contract says whether the
// user is still typing, so this is the only thing separating "one reconnect when the
// device id is finished" from one per character. Far longer than the gap between two
// keystrokes of even a slow typist; being generous costs nothing but how long the
// preview takes to catch up, while being tight costs a reconnect storm.
const RECONFIGURE_DELAY = 2000;
// The first retry of an outage runs immediately. The picture is black from the
// teardown until the first frame of the new stream, and a delay in front of the
// attempt most likely to succeed is the largest single piece of that gap. The
// backoff starts with the second attempt and is unchanged from there.
const RETRY_FIRST = 0;
const RETRY_BASE = 1000;          // second reconnect delay, doubled per attempt
const RETRY_MAX = 30000;          // backoff ceiling
// Consecutive failed *retries* before the outage gets words - counted separately
// from the failure that opened it, see _scheduleRetry(). Below this the spinner
// carries the outage alone: a stream that heals on the second attempt should never
// have announced itself. Deliberately a count and not a clock - a time-based
// backstop was proposed and declined, see PLAN_F03 "Accepted deviation".
const ESCALATE_AFTER_RETRIES = 3;
const DISCONNECT_GRACE = 5000;    // ICE usually heals itself, give it a moment
const STABLE_AFTER = 30000;       // a connection this old counts as healthy
const WATCHDOG_INTERVAL = 5000;
const WATCHDOG_STALL = 15000;     // no new frames for this long - stream is dead
const RPC_TIMEOUT = 2000;         // calls into a dead RPC peer never settle
// setPlayback({audio:true}) builds an RTSP server, spawns ffmpeg and opens the
// camera's talkback connection, so it is legitimately slow. It also parks
// forever if the browser never sends audio, hence the ceiling.
const INTERCOM_TIMEOUT = 10000;
// Passed to takePicture() as its own bound, and reused for the RPC race around
// it. The API's timeout is enforced inside Scrypted and cannot bound a peer that
// never answers, so both calls still need withTimeout on top.
const SNAPSHOT_TIMEOUT = 5000;
// How often to ask for the decoded frame count while waiting for the first
// picture. The watchdog polls the same stat every 5 s, which is far too coarse to
// hand over the poster without a visible gap.
const FIRST_FRAME_POLL = 100;
// getVideoStream can go through a prebuffer or spin one up, and the conversion
// behind it builds a whole signaling channel, so this is deliberately generous.
const STREAM_TIMEOUT = 10000;

// ScryptedMimeTypes.RTCSignalingChannel. Hardcoded rather than imported:
// @scrypted/types is a types package and the bundle should not grow for one string.
// Cross-check against node_modules/@scrypted/types/dist/index.js if it ever fails.
const RTC_SIGNALING_CHANNEL = 'x-scrypted/x-scrypted-rtc-signaling-channel';

// Accepted values for the `destination` config option. A deliberate subset of
// MediaStreamDestination: the two `-recorder` values select recording streams
// rather than live viewing, and `medium-resolution` is only reachable through a
// plugin-wide setting. Absent means Scrypted decides, which is what its own
// picker calls "Default".
// Exported for the editor's dropdown: a second literal there would drift from the
// validation in setConfig() and offer a value the card then refuses.
export const DESTINATIONS = ['local', 'remote', 'low-resolution'];

// The two routes _start() can take its base URL from - see _pickRoute(), which is the
// only thing that decides between them and the only thing allowed to. `ingress` asks the
// Supervisor for the add-on's ingress path and is what the card has always done.
// `integration` resolves the HTTP proxy that the koush/ha_scrypted integration
// publishes, which is the only way to a Scrypted that is not the add-on: a browser
// cannot reach one directly, because Scrypted answers the preflight without an
// Access-Control-Allow-Origin header and @scrypted/client hardcodes withCredentials -
// which rules out a wildcard too. Measured, see PLAN_F08. Everything below the base URL
// is shared: the proxy authenticates server-side and hands back the same login shape
// ingress does.
// Not a config option and no longer an exported list: 0.4.0's `connection` key is gone,
// because the card can read the one fact that decides this for itself.

// What the integration names its panel: `frontend_url_path=f"{DOMAIN}_{token}"` with
// DOMAIN = "scrypted", so the prefix is what identifies a candidate and the remainder
// is the proxy's path token - which is *not* the bearer token, the two differ.
const PANEL_PREFIX = 'scrypted_';

// Which add-on the card talks to when `source` names none. Not a guess: measured across
// several Home Assistant installations, the slug is always this, because the prefix
// derives from the add-on repository rather than the installation.
// A default here is what removes the `/addons` list call that used to resolve it - the
// one Supervisor call Home Assistant refuses to a non-admin user (measured on
// 2026.7.4), and therefore the one thing that made non-admin support a special case.
// Applied by _ingressBaseUrl() and nowhere else: it is one route's default, and since
// 0.5.0 the field it defaults is shared with the other route. That is also why the
// editor no longer prefills it - it used to show this string as its field's default, and
// a default that is meaningless on the integration route must not be written into a
// shared key. Still exported, though nothing outside this module reads it now.
export const DEFAULT_ADDON = '09e60fb6_scrypted';

// Substituted by esbuild's `define` from package.json - see build.mjs. Never a literal
// here: package.json is what the release workflow checks against the pushed tag, so
// that check is only worth anything while this is the only path to the displayed number.
// The fallback covers a consumer that bundles src/ without that define rather than a
// normal build, where the substitution always happens.
const VERSION = typeof __CARD_VERSION__ === 'string' ? __CARD_VERSION__ : 'dev';

// Stacking contract inside .wrap, bottom to top: video (in flow), poster, spinner,
// message, bar. The bar must stay on top - it was only ever on top by document
// order, so giving the message a z-index without placing the bar would put a
// full-box overlay above the buttons and swallow every click. The message also
// gets pointer-events: none, so a future reorder cannot reintroduce that.
// The spinner is a layer again - F02 had moved it into the play button. It sits
// above the poster so a snapshot cannot hide it. The version label shares both that
// layer and that corner, which only works because the two are never visible at the
// same time - see .version and _syncVersion().
const Z_POSTER = 1;
const Z_SPIN = 2;
const Z_MSG = 3;
const Z_BAR = 4;

const STYLES = `
  ha-card { overflow: hidden; position: relative; background: #000; }
  .wrap { position: relative; width: 100%; }
  video { display: block; width: 100%; height: 100%; object-fit: cover;
          background: #1d1d1d; }
  .poster { position: absolute; inset: 0; z-index: ${Z_POSTER};
            width: 100%; height: 100%; object-fit: cover; }
  .poster[hidden] { display: none; }
  /* No backdrop on purpose - it ate too much of the picture. The shadow is what
     keeps the white icons and label legible over a bright scene instead, and it
     costs no visible area. filter, not text-shadow: the icons are SVG. */
  .bar { position: absolute; inset: auto 0 0 0; z-index: ${Z_BAR};
         display: flex; align-items: center;
         gap: 4px; padding: 4px 8px; color: #fff;
         filter: drop-shadow(0 1px 2px rgba(0,0,0,.8)); }
  .bar button { all: unset; cursor: pointer; padding: 6px; border-radius: 50%;
                line-height: 0; color: #fff; }
  .bar button:hover { background: rgba(255,255,255,.15); }
  /* Only the on state repaints; off is the bar's own white, inherited, with no rule of
     its own. A grey off state was tried and dropped: opacity already belongs to the
     pulse below (and to its static reduced-motion substitute), so a dimmed grey icon
     made "off" and "waiting" the same picture and left the pulse almost no range to
     move in. Sound also crosses itself out when off; talk has this colour alone. */
  .bar button[aria-pressed="true"] { color: #ff5252; }
  .bar button[hidden] { display: none; }
  /* Waiting is slow enough here to need saying - starting talkback can take
     INTERCOM_TIMEOUT, a retry backoff can be 30 s - and the icon has to keep saying
     which state the control is in while it does, so the opacity moves and the icon
     stays. One rule for every button in the bar on purpose: the pulse then means the
     same thing wherever it appears, and it is why nothing below animates a container.
     Opacity is also the only property that can carry this - the play button stays
     pressable through the whole wait, so nothing may touch hit-testing.
     The talk button deliberately does not borrow the top-right spinner instead: that
     ring is the only sign that the picture is not live (docs/limitations.md), and it
     and a starting intercom can be true at once. */
  .bar button.busy { animation: pulse 1.2s ease-in-out infinite; }
  .label { font: 500 12px/1 var(--paper-font-body1_-_font-family, sans-serif);
           letter-spacing: .04em; text-transform: uppercase; opacity: .85; }
  .spacer { flex: 1; }
  .msg { position: absolute; inset: 0; z-index: ${Z_MSG}; pointer-events: none;
         display: flex; align-items: center;
         justify-content: center; padding: 12px; text-align: center;
         color: #888; font: 13px/1.5 var(--paper-font-body1_-_font-family, sans-serif); }
  .msg[hidden] { display: none; }
  /* Top right, over the picture, not inside the play button: the button has to
     stay a recognisable stop button so a 30 s backoff can be cut short by pressing
     it. Same drop-shadow as the bar, for the same reason - a white ring over a
     bright scene is otherwise invisible, and this ring is the only sign of an
     outage until the text escalates. */
  .spin { position: absolute; top: 8px; right: 8px; z-index: ${Z_SPIN};
          width: 20px; height: 20px; border-radius: 50%;
          border: 2px solid rgba(255,255,255,.3); border-top-color: #fff;
          animation: spin 1s linear infinite;
          filter: drop-shadow(0 1px 2px rgba(0,0,0,.8)); }
  .spin[hidden] { display: none; }
  /* The ring's own corner, same inset, deliberately overlapping it - nothing in this
     stylesheet keeps the two apart. What makes that safe is _syncVersion(): the version
     shows only while the card offers play *and* is not waiting, which is exactly when
     the ring is off, so the two can never be on screen at the same time. That mutual
     exclusion is load-bearing layout. Anyone who makes the version visible during a
     load, or gives the ring a job beyond "the card is waiting", has to move one of the
     two first - otherwise a spinner is drawn straight through a version string.
     Line height 1, not the ring's 24px: with nothing beside it to centre against, the
     label reads as misplaced unless its top sits on the same 8px inset as everything
     else in this corner.
     Same drop-shadow as the ring, for the same reason: this floats over the picture,
     and a dimmed 10px label over a bright snapshot is otherwise unreadable.
     Z_SPIN, the ring's layer: nothing is gained by separating them when they cannot
     coexist, and this stays below Z_MSG - the message box spans the whole card and
     centres its text, so a long enough error reaches up here, and an error the user may
     have to act on must win over a build number.
     Quieter than .label: the name is what the card is, the version is a footnote for
     whoever is checking which build they are looking at.
     No [hidden] rule of its own - that exists for .bar button because all: unset kills
     the UA one; nothing here sets display, so hidden still works. */
  .version { position: absolute; top: 8px; right: 8px; z-index: ${Z_SPIN};
             font: 500 10px/1 var(--paper-font-body1_-_font-family, sans-serif);
             letter-spacing: .04em; opacity: .45;
             filter: drop-shadow(0 1px 2px rgba(0,0,0,.8)); }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes pulse { 50% { opacity: .35; } }
  /* Still a visible ring and a visibly busy button, just not moving ones. */
  @media (prefers-reduced-motion: reduce) {
    .spin { animation: none; }
    .bar button.busy { animation: none; opacity: .5; }
  }
  svg { width: 20px; height: 20px; fill: currentColor; }
`;

const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
const ICON_STOP = '<svg viewBox="0 0 24 24"><path d="M6 6h12v12H6z"/></svg>';
const ICON_MIC = '<svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 003-3V5a3 3 0 00-6 0v6a3 3 0 003 3zm5-3a5 5 0 01-10 0H5a7 7 0 006 6.9V21h2v-3.1A7 7 0 0019 11z"/></svg>';
// The sound pair shows the current state, not the action a press would perform: crossed
// out means off, so an idle card renders the muted one. Talk has no such pair - the
// crossed-out microphone was tried and did not look good, so its state is colour only.
const ICON_SOUND = '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>';
const ICON_MUTED = '<svg viewBox="0 0 24 24"><path d="M4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a9 9 0 003.69-1.81L19.73 21 21 19.73 4.27 3zM12 4L9.91 6.09 12 8.18V4zm7 8c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0021 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71z"/></svg>';

/**
 * Whether a failed hass.callWS() was a refusal rather than a fault. The distinction
 * decides whether the card retries at all, so it must not be widened: Home Assistant
 * answers a call the logged-in user may not make with the code `unauthorized` (message
 * "Unauthorized" - measured), while a Supervisor that is down, restarting or slow comes
 * back as `unknown_error` or does not come back at all. Only the first cannot heal by
 * retrying. Treating the second as permanent would take self-healing away from every
 * user the card already works for, which is the more expensive mistake of the two.
 * The code and not the message: the text is human-readable and free to change between
 * versions, the code is the constant Home Assistant's websocket API answers with.
 */
const isRefusal = (err) => !!err && err.code === 'unauthorized';

/**
 * A failure of _proxyBaseUrl(), marked as one. _start()'s catch has to tell these from
 * a camera that dropped: they are counted separately and only they are bounded, because
 * a missing integration and a lost stream have nothing to do with each other. The mark
 * rides on the error rather than on a card field so that no path has to remember to
 * clear it, and none of these failures is permanent - see _latchResolver().
 */
const resolverError = (message) => Object.assign(new Error(message), { resolver: true });
const isResolverFailure = (err) => !!err && err.resolver === true;

/** A dead RPC peer swallows calls without ever rejecting, which would hang recovery. */
export const withTimeout = (promise, ms) => Promise.race([
  promise,
  new Promise((resolve) => setTimeout(resolve, ms)),
]);

class ScryptedCameraCard extends HTMLElement {
  static getStubConfig() {
    return { device: '' };
  }

  static getConfigElement() {
    return document.createElement('scrypted-camera-card-editor');
  }

  constructor() {
    super();
    this._started = false;
    this._visible = false;
    this._client = null;
    this._clientDead = false;
    this._session = null;
    this._control = null;
    this._sessionTimers = [];
    this._streamTimers = [];
    this._retryTimer = null;
    this._graceTimer = null;
    this._reconfigureTimer = null;
    // The connection keys the current client was built from, so an edit that changes
    // none of them costs nothing - see _connectionKey().
    this._connectionSig = null;
    this._retries = 0;
    // Consecutive failures of _proxyBaseUrl(), counted apart from _retries because the
    // two are different faults with different bounds. "Consecutive" is only true because
    // of the four resets: a successful resolve, the play button, _reconfigure() and
    // _teardown(). Without them this would be cumulative over the life of the page, and
    // three transient integration reloads hours apart would latch a healthy card.
    this._resolverFailures = 0;
    // The candidate panel set the last re-arm check saw, and the object it was read
    // from - see _rearmResolver().
    this._panelSig = null;
    this._panelsSeen = null;
    // The route the current connect attempt is using, shown next to the version. Written
    // in _start() from _pickRoute() - the *attempted* route, so a card that never got a
    // client can still say which door it tried - corrected by the fallback in _start()
    // when the add-on is what answered, and cleared in _dropClient(). Null before the
    // first attempt, which is when the label prints the version alone.
    this._route = null;
    this._stopped = false;      // user pressed stop - do not self-heal
    // Whether a stream is wanted. Seeded from `autoplay` in setConfig() and owned
    // by the card afterwards. `autoplay` must not be read again: _start() is
    // re-entered on every recovery that lost the RPC client, so gating playback on
    // the config option would make `autoplay: false` mean "never self-heal" and
    // leave the play button dead after an add-on restart.
    this._wantStream = false;
    this._connecting = false;
    // Attempt generation. The two bounds in _start() abandon rather than cancel,
    // so work from a superseded attempt can still be in flight and land later;
    // this is how it recognises that it lost - see _ingressBaseUrl().
    this._connectGen = 0;
    this._recovering = false;
    this._pendingRetry = false; // recovery deferred until the card is visible
    this._observer = null;
    this._posterUrl = null;
    this._posterGen = 0;
    this._live = false;   // a decoded picture is on screen
    // The last failure, kept as state so every attempt can re-render the same
    // message instead of clearing and rewriting it. See _syncStatus().
    this._outageReason = null;
    // This outage has already spoken. Latched rather than re-derived per render,
    // because _retries is reset underneath it - see _scheduleRetry().
    this._escalated = false;
    // This outage interrupted a picture that was actually working, so _stop() left
    // the last snapshot on screen and the card has something to be quiet behind.
    // False for one that never got a stream up - see _syncStatus().
    this._outageFromLive = false;
    this._showStop = false;
    // The card is waiting for something. _busy() is the only writer; it exists because
    // that fact has renderings (the ring, the play button's pulse) but no reading of
    // one of those renderings could stand in for it - see _syncVersion().
    this._waiting = false;
    this._stream = null;  // we own the inbound MediaStream, see onTrack
    this._onVisibility = () => this._syncPlayback();
    this._onOnline = () => this._onNetworkBack();
  }

  setConfig(config) {
    if (!config || !config.device) {
      throw new Error('scrypted-camera-card: "device" (Scrypted id or name) is required');
    }
    const first = !this._config;
    this._config = { autoplay: false, aspect_ratio: '16 / 9', ...config };
    // The one name the card is given, read by whichever route _pickRoute() takes: an
    // integration entry's Name, or an add-on slug. `addon` from 0.4.0 and earlier is *not*
    // accepted as an alias - a deliberate break, announced in the CHANGELOG, so there is
    // exactly one key that speaks for this and no question about which of two wins.
    // No eager default either: a default that belongs to one route must not be written
    // into the field the other route reads. Empty means "the route decides", and each has
    // its own answer - _ingressBaseUrl() falls back to DEFAULT_ADDON, _proxyBaseUrl()
    // accepts a single panel.
    this._source = this._config.source || '';
    // The first call only, and deliberately not "apply the config": from here on
    // _wantStream is the card's, for the reason spelled out in the constructor. HA's
    // visual editor calls setConfig() on every keystroke, so re-seeding it would let a
    // character typed into `name` revoke a running stream's intent to be running -
    // with the default `autoplay: false`, permanently.
    if (first) this._wantStream = !!this._config.autoplay;
    this._destination = this._config.destination || null;
    // A typo must not look like a broken feature: the plugin would pass an unknown
    // destination straight through and quietly ignore it. Recorded here and shown
    // by _start(), which then refuses to stream - retrying a permanent
    // configuration error forever would only produce a retry storm.
    this._destinationError = this._destination && !DESTINATIONS.includes(this._destination)
      ? `unknown destination "${this._destination}" - use one of ${DESTINATIONS.join(', ')}`
      : null;
    // Kept in its own field rather than folded into _destinationError, which has two
    // writers already: a route error must not be able to overwrite a destination one, or
    // the user fixes the sentence they can see and the card still refuses.
    // Nothing writes it since 0.5.0. There is no way left to configure the route wrongly:
    // 0.4.0 refused an unknown `connection` value and refused credentials on the
    // integration route, and _pickRoute() has replaced both - the route is derived, and
    // credentials select the only route they mean anything on instead of clashing with
    // one. The field and _start()'s read of it stay because that is the slot for a
    // permanent, non-retrying route error, and a future one belongs here rather than in
    // _destinationError.
    this._connectionError = null;
    // Created once, updated ever after. Replacing the shadow DOM per keystroke is what
    // used to kill a live picture: the replacement <video> carries no srcObject, and
    // onTrack only assigns one for a MediaStream it created itself, so nothing repaired
    // it. The picture, the overlay, the poster, the button state and the listeners now
    // simply survive an edit rather than being restored after it.
    // The _dropPoster() that used to open this path is gone with the rebuild, and its
    // absence is deliberate: the <img> holding the URL is no longer thrown away, so
    // there is nothing to revoke, and that call also bumped _posterGen - discarding an
    // in-flight snapshot once per keystroke. Revoking stays in _setPoster() and
    // _teardown(); at most one URL is outstanding either way, because nothing here
    // creates one.
    if (!this.shadowRoot) this._create();
    this._applyConfig();

    const key = this._connectionKey();
    // Before the first _start() there is nothing to reconcile against - it reads
    // whatever the config says at the time.
    if (!this._started) this._connectionSig = key;
    else if (key !== this._connectionSig) this._scheduleReconfigure();
  }

  set hass(hass) {
    this._hass = hass;
    // Assigned first: the re-arm reads hass.panels, and this setter is the only place
    // that learns the panel set changed at all.
    this._rearmResolver();
    if (!this._started && this.isConnected) this._start();
  }

  getCardSize() {
    return 4;
  }

  connectedCallback() {
    // Only stream while the card is actually on screen. HA keeps cards of
    // inactive views in memory, which is how the iframe approach ended up
    // holding several live streams at once.
    this._observer = new IntersectionObserver((entries) => {
      this._visible = entries.some((e) => e.isIntersecting);
      this._syncPlayback();
    }, { threshold: 0.01 });
    this._observer.observe(this);
    document.addEventListener('visibilitychange', this._onVisibility);
    // Laptop woke up or wifi came back: don't sit out the remaining backoff.
    window.addEventListener('online', this._onOnline);
    if (this._hass && !this._started) this._start();
  }

  disconnectedCallback() {
    this._teardown();
  }

  // --- rendering ----------------------------------------------------------

  /**
   * Everything here is static. The two values that come from the config are written
   * by _applyConfig() into the elements cached below, which is what lets this run
   * exactly once per card.
   *
   * The version sits over the picture in the spinner's corner, not at the right end of
   * the bar, and the two share that corner because they can never be visible together -
   * see .version and _syncVersion(). It used to be written here and never again, because
   * a build number cannot change; since 0.5.0 it also carries the route the card took,
   * which can, so both its text and its visibility are state and _syncVersion() owns
   * both. Left empty in the markup for the same reason the two buttons are: the first
   * paint comes from the same writer as every later one - _create() ends with _busy(),
   * which calls _syncVersion() - so this markup cannot disagree with it.
   * aria-hidden because it is decoration for a human reading the card: the label is the
   * card's identity, and a build number announced ahead of the controls is noise.
   */
  _create() {
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = `
      <style>${STYLES}</style>
      <ha-card>
        <div class="wrap">
          <video playsinline muted></video>
          <img class="poster" alt="" hidden>
          <div class="spin" role="status" aria-label="Loading" hidden></div>
          <span class="version" aria-hidden="true"></span>
          <div class="msg" hidden></div>
          <div class="bar">
            <button class="toggle" title="Play/Stop">${ICON_PLAY}</button>
            <span class="label"></span>
            <span class="spacer"></span>
            <button class="speaker" title="Sound" aria-pressed="false" hidden>${ICON_MUTED}</button>
            <button class="mic" title="Talk" hidden></button>
          </div>
        </div>
      </ha-card>`;

    this._wrap = this.shadowRoot.querySelector('.wrap');
    this._video = this.shadowRoot.querySelector('video');
    this._msg = this.shadowRoot.querySelector('.msg');
    this._spin = this.shadowRoot.querySelector('.spin');
    this._poster = this.shadowRoot.querySelector('.poster');
    this._toggle = this.shadowRoot.querySelector('.toggle');
    this._mic = this.shadowRoot.querySelector('.mic');
    this._speaker = this.shadowRoot.querySelector('.speaker');
    this._label = this.shadowRoot.querySelector('.label');
    this._version = this.shadowRoot.querySelector('.version');

    this._toggle.addEventListener('click', () => this._onToggle());
    this._mic.addEventListener('click', () => this._onMic());
    this._speaker.addEventListener('click', () => this._onSpeaker());

    // Both buttons' initial look comes from the same writer as every later one, so the
    // markup above cannot disagree with it. Nothing can paint in between.
    this._syncMic(false);
    this._busy(false);
  }

  _applyConfig() {
    // A style property, never markup. The value is config text and used to be
    // interpolated into a style="" attribute, where one double quote closed the
    // attribute and injected elements into the shadow root. The CSSOM takes this as a
    // value or rejects it and cannot be talked into parsing it as markup. A rejected
    // value leaves the previous ratio in place, which is also what keeps the box from
    // collapsing while a new one is half typed.
    this._wrap.style.aspectRatio = this._config.aspect_ratio;
    this._label.textContent = this._config.name || '';
  }

  /**
   * Two independent layers, not one three-state element: an in-progress hint has
   * to sit unobtrusively over whatever picture is on screen, an error has to be
   * readable in the middle. Transient states use _busy() and say nothing;
   * anything the user might have to act on gets _status() text.
   */
  _status(text) {
    this._msg.textContent = text || '';
    this._msg.hidden = !text;
  }

  /**
   * Shown for the whole outage, from the moment frames stop until they move again -
   * not as a flash on state changes. With the text withheld until the third failed
   * retry, this ring is the only sign of an outage until then, so nothing may drop
   * it early.
   *
   * The play button's pulse rides along here rather than being toggled at the ten-odd
   * call sites, because the ring and the pulse are one fact - "the card is waiting" -
   * and a second writer is how one of them would be left behind saying the opposite.
   * That it therefore also pulses in the stop position, and while the watchdog doubts
   * an apparently running stream, is the point: the pulse means waiting everywhere
   * instead of meaning something different on each button.
   * aria-busy follows for the same reason it does on the talk button - the animation
   * alone says nothing to a screen reader.
   */
  _busy(on) {
    // The fact first, its renderings after. _syncVersion() reads it back, so it has to
    // be true before anything derives from it.
    this._waiting = on;
    this._spin.hidden = !on;
    // Class and attribute only. _syncToggle() owns innerHTML and touches nothing else,
    // so neither writer can overwrite the other's half of the button.
    this._toggle.classList.toggle('busy', on);
    this._toggle.setAttribute('aria-busy', String(on));
    // The version shares this corner with the ring, so it has to go the moment the ring
    // arrives. Called, not written here - see _syncVersion().
    this._syncVersion();
  }

  /**
   * The play button has two faces and three writers (_stop, 'connected',
   * _scheduleRetry), so it gets one renderer that derives from state. Setting
   * innerHTML from each of those directly is how the icons would overwrite each
   * other.
   * The busy face is deliberately not an icon: during a wait the button has to stay a
   * recognisable stop button, because pressing it is how the user cuts a backoff short,
   * and that backoff can be 30 s long. _busy() pulses it instead, which leaves the icon
   * to mean one thing only - hence no busy branch here.
   *
   * The version is one of this button's two facts, so it is notified from here - but
   * written in _syncVersion(), which owns it, because the other fact arrives from
   * _busy().
   */
  _syncToggle() {
    this._toggle.innerHTML = this._showStop ? ICON_STOP : ICON_PLAY;
    this._syncVersion();
  }

  /**
   * The only writer of the version label - its text as well as its visibility, since the
   * text stopped being constant: `v<version> · <route>` names the door the last attempt
   * used, which is the whole diagnosis story for a card that can now pick its route
   * itself, and the route the card *tried* is exactly what a stranger cannot otherwise
   * guess. Before the first attempt there is no route and the version stands alone.
   *
   * Two facts decide the visibility and they arrive from different places - the button's
   * face from _syncToggle(), the wait from _busy() - so both call this and neither touches
   * .hidden. Same shape as _syncStatus() and for the same reason: one property written
   * from two sites is one property that will end up saying two things, and this file has
   * already paid for that twice. _start() and _dropClient() write _route and call here
   * for the same reason.
   *
   * Shown in the paused state only, which is "play is offered *and* nothing is in
   * flight". _showStop alone was not that: a first connect still offers play, so the
   * version stayed up while the card loaded. Both conditions hide it, and a retry
   * backoff hides it twice over - stop button and waiting - which is right, since that
   * case is holding a picture that was working.
   *
   * _waiting, not `!this._spin.hidden`: the ring is one rendering of the wait and the
   * play button's pulse is another, so reading the ring would make the version a
   * rendering of a rendering - wrong the moment anything gives the ring a second use, or
   * shows it for something that is not a wait. The field is the fact itself, and _busy()
   * sets it before calling here.
   */
  _syncVersion() {
    this._version.textContent = this._route ? `v${VERSION} · ${this._route}` : `v${VERSION}`;
    this._version.hidden = this._showStop || this._waiting;
  }

  /**
   * The single writer of the outage line. Every attempt used to clear it and
   * _scheduleRetry() used to write it back, so a message blinked out once per retry
   * cycle and disappeared entirely for the length of a slow _start(). Deriving the
   * text from state instead means one message survives the whole outage, and the
   * escalation rule lives in exactly one place.
   *
   * Quiet only while the card is masking an outage behind a picture, and only until
   * that outage has escalated - _scheduleRetry() owns the second half of that.
   * F04's destination errors bypass this and write _status() directly; leave them.
   */
  _syncStatus(delay) {
    const reason = this._outageReason;
    // Two conditions, and collapsing them back into one is the trap. _outageFromLive
    // is what makes the silence defensible: _stop() leaves the last snapshot on
    // screen and it looks exactly like a live picture, so an interrupted stream has
    // something to hide behind and can afford to wait three retries. A card that
    // never got a stream up is hiding nothing - and _scheduleRetry() is also the
    // funnel for `device "..." not found` and a missing RTCSignalingChannel, neither
    // of which will fix itself. Those have to speak on the first attempt.
    if (!reason || (this._outageFromLive && !this._escalated)) { this._status(''); return; }
    this._status(delay ? `${reason} - retrying in ${Math.round(delay / 1000)}s` : reason);
  }

  // --- snapshot poster ------------------------------------------------------

  /**
   * A still image for every state where no decoded video is on screen. The
   * generation token guards this method against itself: a stop and a recovery can
   * each have a snapshot in flight, and without it the slower one would overwrite
   * the newer image.
   *
   * Note who decides *visibility*: only _syncPoster(), from `_live`. A call that
   * landed late must therefore still store its image - it will be the one shown
   * after the next stop - it just must not be the one to reveal it. That is why
   * there is no `!this._session` check around the assignment below: dropping the
   * image instead would leave a card that streamed once with no poster at all for
   * the rest of the session.
   */
  async _refreshPoster() {
    if (!this._hasCamera || !this._device || !this._client) return;
    const device = this._device;
    const gen = this._posterGen += 1;
    try {
      // The API's own timeout bounds how long the camera implementation waits;
      // withTimeout bounds the RPC itself. Both are needed - see the constant.
      const mo = await withTimeout(
        device.takePicture({
          reason: 'periodic', timeout: SNAPSHOT_TIMEOUT, bulkRequest: true,
        }),
        SNAPSHOT_TIMEOUT + RPC_TIMEOUT,
      );
      // withTimeout resolves undefined instead of rejecting, so this is not
      // paranoia: without it, undefined goes into the next RPC call against a peer
      // that just proved it is not answering, and that call can hang unbounded.
      if (!mo) return;
      const buffer = await withTimeout(
        this._client.mediaManager.convertMediaObjectToBuffer(mo, 'image/jpeg'),
        SNAPSHOT_TIMEOUT,
      );
      if (!buffer) return;
      if (gen !== this._posterGen) return; // a newer intent won
      this._setPoster(URL.createObjectURL(new Blob([buffer], { type: 'image/jpeg' })));
    } catch (err) {
      // A missing poster is not worth a message on screen.
      console.warn('[scrypted-card] snapshot failed', err);
    }
  }

  _setPoster(url) {
    if (this._posterUrl) URL.revokeObjectURL(this._posterUrl);
    this._posterUrl = url || null;
    if (url) this._poster.src = url;
    else this._poster.removeAttribute('src');
    this._syncPoster();
  }

  /**
   * The single owner of poster visibility. `_live` means a frame has actually been
   * decoded (_watchFirstFrame), not that a session exists or that the peer
   * connection reached 'connected' - both are earlier than the first painted frame
   * and using either brings the black flash back.
   */
  _syncPoster() {
    this._poster.hidden = !this._posterUrl || this._live;
  }

  _dropPoster() {
    this._posterGen = (this._posterGen || 0) + 1;
    if (!this._posterUrl) return;
    URL.revokeObjectURL(this._posterUrl);
    this._posterUrl = null;
  }

  // --- connection ---------------------------------------------------------

  /**
   * The config values the live connection was built from. `name` and `aspect_ratio`
   * are not among them: _applyConfig() writes those into the existing DOM and no
   * reconnect is involved.
   *
   * `source` is, because whichever route is taken resolves its base URL from it - and it
   * is also the fix for a latched resolver, which is why _reconfigure() clears that
   * counter. The *resolved* `this._source` rather than `c.source`, so that an absent key
   * and an empty one cannot key differently for a value the card treats identically.
   *
   * The route itself is not in here and cannot be: installing the integration changes
   * the route without changing the config, so no key would notice. It does not need to -
   * see _rearmResolver() for a latched card, and a card that is streaming has no reason
   * to be torn down for a door it is no longer using.
   */
  _connectionKey() {
    const c = this._config;
    return JSON.stringify([c.device, this._source, c.destination, c.username, c.password]);
  }

  /**
   * A connection key changed, so what is connected no longer matches the config.
   * Acting on it immediately is not an option: the visual editor emits a config per
   * keystroke, and a reconnect per character is worse than the bug of never
   * reconnecting at all. Its event contract offers nothing better to key off - no
   * blur, no commit, no "the user is done" - so the quiet period is the
   * discriminator: the last config of a burst wins and one reconnect follows it.
   */
  _scheduleReconfigure() {
    this._clearTimer('_reconfigureTimer');
    this._reconfigureTimer = setTimeout(() => this._reconfigure(), RECONFIGURE_DELAY);
  }

  async _reconfigure() {
    this._reconfigureTimer = null;
    if (!this.isConnected) return;
    // A connect already in flight cannot be handed the new config half way through,
    // and tearing it down from underneath itself is worse than waiting: both of its
    // awaits are bounded, so one more quiet period always ends this.
    if (this._connecting) { this._scheduleReconfigure(); return; }
    this._connectionSig = this._connectionKey();
    this._cancelRetry();
    // What is connected was built from the old config and goes either way. A card the
    // user stopped stays stopped - but it still drops the client, because
    // _dropClient() nulls _device, and that is what makes the next press of play
    // reconnect instead of streaming the camera the config no longer names.
    await this._stop({ resetOverlay: true });
    this._dropClient();
    if (this._stopped) return;
    this._retries = 0;
    // The resolver's bound too, and this is the site neither of the other two clearing
    // mechanisms covers: `source` is part of _connectionKey(), so editing it is a
    // first-class fix for a latched card, and this path reaches _start() without going
    // through `set hass` or the play button.
    this._resolverFailures = 0;
    await this._start();
  }

  async _start() {
    if (this._connecting) return;
    // Both are card configuration and neither can heal by retrying, so they are shown
    // and nothing is scheduled. Destination first, arbitrarily but stably: a config can
    // carry both mistakes and only one sentence fits on screen.
    const configError = this._destinationError || this._connectionError;
    if (configError) {
      this._started = true;
      this._busy(false);
      this._status(configError);
      return;
    }
    this._connecting = true;
    this._started = true;
    // Bumped before _dropClient(), because the disposal below is exactly what
    // _dropClient() cannot reach - see _ingressBaseUrl().
    const gen = this._connectGen += 1;
    // A restart must not stack a second client, ingress keepalive or device
    // proxy on top of the old ones.
    this._dropClient();
    try {
      this._busy(true);
      // Not _status(''): a connect that is already an escalated outage's next attempt
      // has a message on screen, and clearing it here is what used to leave the card
      // silent for the whole length of a slow connect.
      this._syncStatus();
      // Both connects are bounded, and each failure gets its own words: a silent
      // Supervisor and a silent add-on are different faults with different fixes,
      // and this one line is all the user has to tell them apart. withTimeout
      // resolves undefined rather than rejecting, so both results are checked and
      // the checks throw - into the catch below, and from there into the normal
      // retry cycle. No new error path is needed.
      let baseUrl;
      // The attempted route, recorded before either resolver runs rather than on success:
      // a card that never gets a client is exactly the card whose owner needs to know
      // which door it tried, and that is also the only state where the label is visible.
      // _syncVersion() is called rather than left to the next state change - the label is
      // hidden behind _busy(true) right now, but nothing may depend on that.
      const route = this._pickRoute();
      this._route = route;
      this._syncVersion();
      if (route === 'integration') {
        try {
          // Neither bounded nor guarded, and both are deliberate: this is a read of
          // hass.panels with no network call behind it, so there is nothing for
          // withTimeout to bound, and it either throws or returns a string, so there is
          // no falsy result to catch. Every other await in this method is bounded, which
          // is why the asymmetry is written down rather than left to look like an
          // oversight.
          baseUrl = this._proxyBaseUrl();
        } catch (proxyErr) {
          // The fallback, and only in this direction. _pickRoute() chose the proxy
          // because a panel exists, which says nothing about whether that entry can
          // serve this camera - and the add-on may well still be installed, so a working
          // card that says which door it used beats a dead one with a precise complaint.
          // The reverse fallback would be meaningless: ingress is only chosen when there
          // is no panel at all or credentials are set, and neither is fixed by the proxy.
          // Logged, not shown: on an otherwise working card this is the only trace that
          // the integration entry is broken, and PLAN_F09 accepts that quiet degradation
          // deliberately.
          console.warn('[scrypted-card] the koush/ha_scrypted proxy could not be'
            + ' resolved, falling back to the Scrypted add-on', proxyErr);
          baseUrl = await this._ingressFallback(gen, proxyErr);
          // The route that actually produced the base URL, so a fallen-back card reads
          // "· ingress". Only on success: when both fail, the label keeps the attempted
          // route and the message below names both attempts.
          this._route = 'ingress';
          this._syncVersion();
        }
        // "Consecutive" lives here: a resolve that worked ends the run, and only the
        // failures that follow one another are allowed to reach the bound. The fallback
        // counts as worked - the card has a base URL and is about to connect.
        this._resolverFailures = 0;
      } else {
        baseUrl = await withTimeout(this._ingressBaseUrl(gen), INGRESS_TIMEOUT);
        // Inside the ingress branch, not shared: the sentence names the ingress session
        // and INGRESS_TIMEOUT, and a shared guard would let it describe a proxy failure
        // that has neither.
        if (!baseUrl) {
          throw new Error(
            `Home Assistant did not answer within ${INGRESS_TIMEOUT / 1000}s while opening the ingress session`,
          );
        }
      }
      // Kept in a variable because withTimeout abandons rather than cancels: this
      // promise may still be connecting and hand back a live client afterwards.
      const connect = connectScryptedClient({
        baseUrl,
        pluginId: '@scrypted/core',
        clientName: 'ha-scrypted-card',
        // Optional, and the reason to set them is scope rather than access: left
        // empty the add-on authenticates the ingress request as whatever it considers
        // that user, usually with full access. Filled in, the card is that Scrypted
        // user instead, so a viewer account restricted to a few cameras limits what
        // this card can show. It does not limit what the *browser* can reach - the
        // ingress session cookie authorizes the whole add-on either way.
        username: this._config.username,
        password: this._config.password,
      });
      const client = await withTimeout(connect, CONNECT_TIMEOUT);
      if (!client) {
        // Dispose of what the bound abandoned. Nothing else can: the awaiting path
        // got undefined, so the card never holds a reference to a client that
        // arrives late, and it would keep a websocket and an RPC peer open against
        // Scrypted for the rest of the page's life. Deliberately no "is this the
        // client we are using" check - on this path it never is.
        // Both outcomes are swallowed. The rejection handler is not decoration: this
        // is now the only handler on that promise, so a late failure would otherwise
        // surface as an unhandled rejection in the console of every user whose
        // add-on was merely slow to fail.
        connect.then(
          (late) => { try { late.disconnect(); } catch { /* already gone */ } },
          () => { /* it failed on its own - nothing to dispose */ },
        );
        // Names the route instead of the add-on: this connect is the one thing both
        // routes share, and on the integration route there is no add-on in the picture
        // at all - a card that blamed one would send its owner to restart the wrong
        // thing. _route, not `route`, so a fallen-back attempt blames the add-on it
        // actually reached.
        throw new Error(
          `Scrypted did not answer within ${CONNECT_TIMEOUT / 1000}s`
          + ` on the ${this._route} route`,
        );
      }
      this._client = client;
      this._clientDead = false;
      // The RPC connection dying (add-on restart, expired ingress session,
      // dropped websocket) leaves the peer connection looking fine, so this is
      // the only place that failure surfaces.
      client.onClose = () => {
        if (this._client !== client) return; // already replaced
        this._clientDead = true;
        this._recover('connection lost');
      };

      const device = this._findDevice();
      if (!device) {
        // With credentials in use there are two causes and the card cannot tell them
        // apart: a wrong id or name, or a camera this Scrypted account is not allowed
        // to see - a restricted account simply does not have it in systemManager.
        // Naming only the typo is what sends someone hunting for a mistake that is not
        // there, so both are named and neither is claimed.
        throw new Error(this._config.username
          ? `device "${this._config.device}" not found - check the id or name, or whether`
            + ` the Scrypted user "${this._config.username}" is allowed to see it`
          : `device "${this._config.device}" not found`);
      }
      if (!device.interfaces.includes('RTCSignalingChannel')) {
        throw new Error(`${device.name} has no RTCSignalingChannel - enable the WebRTC plugin`);
      }
      // Without Intercom the plugin's setPlayback returns immediately and no
      // talkback is possible, so the button must not be offered at all.
      this._intercom = device.interfaces.includes('Intercom');
      this._hasCamera = device.interfaces.includes('Camera');
      // Needed for getVideoStream. Note this is the mixin-advertised list, which is
      // not a reliable test of whether a destination can be honoured - see Step 2.3
      // in PLAN_F04. It is only used here to avoid calling a method that is absent.
      this._hasVideoCamera = device.interfaces.includes('VideoCamera');
      if (this._destination && !(await this._canPickStream(device))) {
        // Deliberately refuse rather than quietly stream the default: a card that
        // ignores its own configuration is worse than one that says it cannot honour
        // it. Not routed through _scheduleRetry - this cannot heal by retrying.
        this._destinationError =
          `${device.name} offers no selectable stream - remove "destination" from the card config`;
        this._busy(false);
        this._status(this._destinationError);
        return;
      }
      this._device = device;
      // Not awaited: the poster is decoration and must never delay the stream.
      this._refreshPoster();

      // One condition, no first-load special case: the intent flag already
      // carries `autoplay` from setConfig(), and every later caller sets it.
      if (this._wantStream) await this._play();
      // The connect succeeded, so whatever failure was on screen is over. Nothing
      // else clears it on this branch - _onPeerState('connected') never runs.
      else {
        this._busy(false);
        this._outageReason = null;
        this._escalated = false;
        this._outageFromLive = false;
        this._syncStatus();
      }
    } catch (err) {
      // Home Assistant refused the call, so retrying it will be refused too. Routed
      // exactly like the destination refusal above - shown, and not through
      // _scheduleRetry() - because that is what the loop was: every non-admin on the
      // dashboard produced one attempt every 30 s for as long as the page stayed open,
      // one loop per card. The raw refusal is the single word "Unauthorized", which
      // names neither what was refused nor what to do about it, so it goes to the
      // console and the user gets the sentence instead. Pressing play still tries
      // again - that is a person asking, not a loop.
      if (isRefusal(err)) {
        console.warn('[scrypted-card] Home Assistant refused a Supervisor call', err);
        this._busy(false);
        this._status('Home Assistant refused access to the Scrypted add-on'
          + ' - this needs an administrator account');
        return;
      }
      // The only place the latch is read, and it gates the *scheduling* of the next
      // attempt - never the entry to _start(). Gating entry is how the card ends up
      // stranded: _start() returns before doing anything, so nothing recomputes the
      // condition and no press of play gets through.
      if (isResolverFailure(err)) {
        this._resolverFailures += 1;
        // ESCALATE_AFTER_RETRIES rather than a fourth retry threshold of its own: the
        // number means the same thing here - this many failures in a row is when the
        // card stops being optimistic.
        if (this._resolverLatched()) {
          this._latchResolver(String(err.message || err));
          return;
        }
      }
      this._scheduleRetry(String(err.message || err));
    } finally {
      // Cleared here even though a timed-out attempt can still be in flight, so a
      // retry may now overlap it. Holding the flag until the abandoned promise
      // settles was the other way to stop retries stacking connects, and it is the
      // wrong one: connectScryptedClient() against a hung add-on may never settle
      // at all, and _start() returns *before* its own try/catch while this is set -
      // so nothing would ever schedule a retry again. That is precisely the silent
      // hang this step exists to remove, reintroduced one layer up. The generation
      // above neutralises the overlap instead: a superseded attempt registers no
      // keepalive and its client is disconnected on arrival, so what overlaps is
      // inert.
      this._connecting = false;
    }
  }

  /**
   * Which of the two routes this attempt takes. The single place the rule lives, and the
   * only thing allowed to branch on it - the card, the README and the editor's helper all
   * state the same rule, so it has to be true in exactly one place here:
   *
   *   The card uses the integration's proxy when that integration is installed. Otherwise
   *   the add-on. If `username`/`password` are set, always the add-on - that is the only
   *   route where they mean anything. If the proxy is installed but cannot be resolved,
   *   the add-on is tried anyway before the card gives up.
   *
   * The last sentence is _start()'s, not this method's: a route can only be picked before
   * it is tried, and the fallback is what happens after.
   *
   * Credentials first, and they decide rather than clash: the integration's proxy replaces
   * the login authorization with its own account on every request it forwards, so a card
   * that fills them in to scope itself would be silently unscoped on that route. 0.4.0
   * refused the combination; choosing the route they work on honours the same intent
   * without a message. That someone with only the integration installed now gets an
   * ingress failure instead of a silent unscoped picture is the deliberate direction.
   *
   * A local read of hass.panels, no network call and nothing to time out, which is what
   * makes this safe to call per attempt - and cheap enough for _rearmResolver() to call on
   * every hass update. `this._config` may be absent: `set hass` can arrive before
   * setConfig().
   */
  _pickRoute() {
    const c = this._config || {};
    if (c.username || c.password) return 'ingress';
    return this._scryptedPanels().length ? 'integration' : 'ingress';
  }

  /**
   * The second half of the fallback: ingress, tried after the proxy could not be
   * resolved. Separate from _ingressBaseUrl() only because of what it does when it
   * fails - the error has to name *both* attempts, or the user reads a complaint about
   * an add-on they never asked the card to use and has no idea the proxy was involved.
   *
   * Marked as a resolver failure even though it ends on the ingress side. That keeps the
   * bound reachable: without the mark this path would retry every 30 s for the life of
   * the page, which is the storm _start()'s refusal branch exists to prevent, and it
   * would also leave _latchResolver() as machinery nothing can reach.
   */
  async _ingressFallback(gen, proxyErr) {
    const both = (why) => resolverError(
      `${why} - and the koush/ha_scrypted integration could not be used either`
      + ` (${String(proxyErr.message || proxyErr)})`,
    );
    let baseUrl;
    try {
      baseUrl = await withTimeout(this._ingressBaseUrl(gen), INGRESS_TIMEOUT);
    } catch (ingressErr) {
      // A refusal keeps its code, because _start() classifies by it and wrapping would
      // hide that - the same reason _ingressBaseUrl() lets refusals through untouched.
      if (isRefusal(ingressErr)) throw ingressErr;
      throw both(String(ingressErr.message || ingressErr));
    }
    if (!baseUrl) {
      throw both(
        `Home Assistant did not answer within ${INGRESS_TIMEOUT / 1000}s while opening`
        + ' the ingress session',
      );
    }
    return baseUrl;
  }

  /**
   * Reuses the authenticated HA websocket instead of a hand-rolled connection,
   * so no long-lived access token has to live in the dashboard config.
   */
  async _ingressBaseUrl(gen) {
    const ws = (msg) => this._hass.callWS(msg);
    // This route's own default, applied here and nowhere else: `source` is shared with the
    // integration route, so nothing earlier may fill it in with a slug - see
    // DEFAULT_ADDON and setConfig(). Still never resolved by asking the Supervisor: the
    // list call that used to do that was the card's only admin-gated call.
    const slug = this._source || DEFAULT_ADDON;

    const start = async () => {
      const { session } = await ws({
        type: 'supervisor/api', endpoint: '/ingress/session', method: 'post',
      });
      // The cookie is shared browser state and only the current attempt may write
      // it - do not delete this as redundant. It guards *both* callers of start(),
      // which is why it sits here and not at either call site: a call abandoned by
      // INGRESS_TIMEOUT can still answer afterwards, and the keepalive below re-runs
      // start() from its failure path, where a tick that was already awaiting its
      // validate_session survives the clearInterval in _dropClient() and lands later
      // as well. Either would overwrite the live connection's session with one that
      // has no keepalive of its own, and that failure is invisible: the token is
      // valid, so nothing breaks at the time and the working stream dies five
      // minutes later with nothing to connect it to. Only the write is conditional -
      // an ingress session nobody uses expires on the Supervisor by itself.
      if (gen === this._connectGen) {
        document.cookie = `ingress_session=${session}; path=/api/hassio_ingress/`;
      }
      return session;
    };

    let session = await start();
    // Without this the session expires mid-stream and the RPC connection dies.
    // Session-scoped: a stream restart must not cancel the keepalive.
    //
    // Skipped once a newer attempt has taken over, and _dropClient() genuinely
    // cannot cover that case - do not delete this as redundant. _start() calls
    // _dropClient() at its *top*, before the awaits above, so a call that was
    // abandoned by INGRESS_TIMEOUT registers its interval after the clear that was
    // meant to catch it, and nothing clears it again - so the orphan would poll the
    // Supervisor for the life of the page. This guard owns that half only; the
    // cookie its failure path would rewrite is guarded inside start() instead,
    // because that path can outlive the interval itself.
    if (gen === this._connectGen) {
      this._sessionEvery(SESSION_KEEPALIVE, () => ws({
        type: 'supervisor/api',
        endpoint: '/ingress/validate_session',
        method: 'post',
        data: { session },
      }).catch(async () => { session = await start().catch(() => session); }));
    }

    // A slug that names no installed add-on is the one failure a default introduces,
    // and it is now reachable without anybody having configured anything. The
    // Supervisor reports it as a generic error whose text names neither the slug that
    // was tried nor the option that changes it, which is where the user gets stuck -
    // so it is restated here. Deliberately still a retrying failure: the very same
    // generic error covers a Supervisor that is briefly unreachable, and the two cannot
    // be told apart from here. A refusal passes through untouched, because it is
    // classified by its code in _start() and wrapping it would hide that code.
    const info = await ws({
      type: 'supervisor/api', endpoint: `/addons/${slug}/info`, method: 'get',
    }).catch((err) => {
      if (isRefusal(err)) throw err;
      throw new Error(
        `add-on "${slug}" could not be read (${String(err.message || err)})`
        + ' - set "source" in the card config to the slug of your Scrypted add-on',
      );
    });
    if (!info.ingress_entry) throw new Error(`add-on ${slug} has no ingress entry`);
    return new URL(`${info.ingress_entry}/`, location.origin).toString();
  }

  /**
   * Every panel the koush/ha_scrypted integration has registered. `hass.panels` is a
   * keyed object - { [url_path]: PanelInfo } - and not an array, so .filter() on it
   * throws; that throw would land in _start()'s catch and read as a connection failure
   * rather than as a mistake in here. Object.values() also works on an array, so this
   * holds either way, and the panel carries its own `url_path` so nothing depends on the
   * key. Neither shape can be verified from this repository - no Home Assistant frontend
   * source or types are installed.
   */
  _scryptedPanels() {
    return Object.values(this._hass?.panels || {})
      .filter((p) => p && typeof p.url_path === 'string' && p.url_path.startsWith(PANEL_PREFIX));
  }

  /**
   * The base URL of the HTTP proxy the koush/ha_scrypted integration serves, for a
   * Scrypted that is not the add-on. Everything below it is the ingress path's: the
   * proxy authenticates server-side and answers /login with the same fields
   * @scrypted/client validates, so connectScryptedClient() cannot tell the two apart.
   *
   * Deliberately no Supervisor call, no cookie and no keepalive. The symmetry with
   * _ingressBaseUrl() invites copying its session machinery across, and there is nothing
   * to copy it for: that machinery keeps a Supervisor-issued ingress session alive,
   * while the proxy view authenticates every request with the integration's own bearer
   * token and requires no session of ours. Its absence is not an oversight.
   *
   * Every failure throws a resolverError, and none of them is permanent: panel presence
   * is environment state with real transient windows, because the integration removes
   * its panel while an entry reloads and adds it back with a freshly retrieved token.
   * The bound lives in _start()'s catch and the way back in _rearmResolver().
   */
  _proxyBaseUrl() {
    const panels = this._scryptedPanels();
    const wanted = this._source;
    // A configured name never falls back to "the only panel". While one of two entries
    // reloads, the resolver sees exactly one panel and cannot tell that from a
    // single-entry installation - and silently connecting to the other Scrypted is the
    // worst outcome available here: with a same-named camera it is a picture from the
    // wrong house. Refusing costs a few seconds, guessing costs trust.
    const matched = wanted ? panels.filter((p) => p.title === wanted) : panels;
    if (!matched.length) {
      // Both texts name the integration, so a stranger can tell whose contract broke -
      // this is a third-party repository and the ingress path does not depend on it.
      // The first names *both* readings of a wrong value, which is what one shared field
      // costs: a leftover add-on slug from before 0.5.0 lands here looking like an entry
      // name, and a user who only hears "no entry is called that" has no way to see why
      // the slug they can read in their own YAML is being used as one.
      throw resolverError(wanted
        ? `no Scrypted panel named "${wanted}" - "source" is the *Name* of the`
          + ' koush/ha_scrypted integration entry, not the host its integrations entry is'
          + ' titled with. If that is an add-on slug, it is not being used as one: the'
          + ' card takes the integration while it is installed, and only names an add-on'
          + ' when it is not'
        // Unreachable as an error and kept as a guard: _pickRoute() only returns
        // 'integration' when _scryptedPanels() is non-empty and nothing awaits between
        // that call and this one, so an empty set here means the invariant broke, not
        // that the user forgot to install anything. The sentence says so rather than
        // sending them after a prerequisite they already have.
        : 'no Scrypted panel found although the card had just seen one - reload the page,'
          + ' and report this if it persists');
    }
    if (matched.length > 1) {
      // Two entries left at the default name cannot be told apart by this card at all:
      // CONF_NAME defaults to "Scrypted" for every entry, so panel.title is the same
      // string for both and no value of `source` selects one. The fix is on the
      // integration's side, and the message has to say that rather than implying the card
      // could resolve it.
      throw resolverError(wanted
        ? `${matched.length} Scrypted panels are named "${wanted}" - rename one of the`
          + ' koush/ha_scrypted entries, the card cannot tell two identically named ones'
          + ' apart'
        : `${matched.length} Scrypted panels found (${matched.map((p) => p.title).join(', ')})`
          + ' - set "source" to the Name of the koush/ha_scrypted entry this card should'
          + ' use, and rename one of the entries first if they read the same');
    }

    const panel = matched[0];
    // Prefer the path the integration publishes over deriving one: __init__.py sets
    // config._panel_custom.module_url to f"/api/{DOMAIN}/{token}/entrypoint.js", so
    // taking it stops the card depending on the token being the remainder of url_path.
    // The derivation is the fallback and is verified against
    // frontend_url_path=f"{DOMAIN}_{token}", so neither source is a guess.
    const moduleUrl = panel.config?._panel_custom?.module_url;
    const path = moduleUrl
      ? moduleUrl.replace(/entrypoint\.js$/, '')
      : `/api/scrypted/${panel.url_path.slice(PANEL_PREFIX.length)}/`;
    // The trailing slash is load-bearing, exactly as at the end of _ingressBaseUrl():
    // combineBaseUrl() in @scrypted/client drops the last segment of a base that has
    // none, which would send every request one directory up. Measured in PLAN_F06 - do
    // not remove this as untidy.
    return new URL(path.endsWith('/') ? path : `${path}/`, location.origin).toString();
  }

  /**
   * The latch is derived, never stored: a boolean beside the counter is a second piece of
   * state that can disagree with it, and every one of the four reset sites would then
   * have to clear both. Clearing the counter *is* clearing the latch.
   */
  _resolverLatched() {
    return this._resolverFailures >= ESCALATE_AFTER_RETRIES;
  }

  /**
   * Panel presence is environment state, so no resolver failure is permanent: when the
   * candidate set changes - an entry finished reloading, the second one was removed, the
   * user renamed the one this card asks for - a latched card asks again. Hung off
   * `set hass` because that setter is the only thing that sees `hass.panels` change.
   *
   * Through _retry() and not _start(), which is the whole point of doing this here:
   * _retry() carries the three guards every other self-healing path in this file carries
   * and _start() does not. It checks _stopped rather than _started - which only means
   * "has ever started", so a card the user deliberately stopped would reconnect on an
   * unrelated panel change. It defers to _pendingRetry while the card is off screen,
   * where _start() would reach `if (this._wantStream) await this._play()` and open a
   * stream nobody is looking at. And it cannot silently vanish on _connecting, which
   * would lose the re-arm for good, because the signature below has already been recorded
   * as seen. It funnels into _start() anyway, since !_client is always true after a
   * resolver failure.
   */
  _rearmResolver() {
    // Scoped to the route. This setter fires on every Home Assistant state update, on
    // every ingress card too, and the default path has to stay byte for byte what it was.
    //
    // Derived, not read off the config: 0.4.0 gated this on `connection === 'integration'`,
    // and leaving that in place while deleting the key would have made the expression
    // permanently true-by-absence in the wrong direction - the re-arm would return here on
    // every update and a latched card could never revive. That failure is invisible, which
    // is why it is written down rather than trusted to be obvious.
    if (this._pickRoute() !== 'integration') return;
    const panels = this._hass.panels;
    // Identity first, because it is free. If Home Assistant turns out to hand out a
    // fresh object per update this degenerates to computing the signature every time,
    // over a handful of panels - not a cost worth defending.
    if (panels === this._panelsSeen) return;
    this._panelsSeen = panels;
    // url_path *and* title, not the paths alone. The ambiguity failures are *about*
    // panel.title: a user told to rename the integration entry does so, the entry
    // reloads, and if the path token turns out to be stable - rotation is an inference,
    // not a measurement - a url_path-only signature would not change. The card would
    // stay latched after the user performed exactly the fix it asked for.
    const sig = JSON.stringify(this._scryptedPanels().map((p) => [p.url_path, p.title]).sort());
    if (sig === this._panelSig) return;
    this._panelSig = sig;
    // Recorded either way above, but only a latched card has anything to do about it -
    // asking a working one to _retry() would raise the spinner over a live picture.
    if (!this._resolverLatched()) return;
    this._resolverFailures = 0;
    this._retry();
  }

  _findDevice() {
    const { systemManager } = this._client;
    const key = String(this._config.device);
    return systemManager.getDeviceById(key) || systemManager.getDeviceByName(key);
  }

  _dropClient() {
    for (const clear of this._sessionTimers.splice(0)) clear();
    if (this._client) {
      this._client.onClose = undefined;
      try { this._client.disconnect(); } catch { /* already gone */ }
      this._client = null;
    }
    this._clientDead = false;
    this._device = null;
    // The label must not outlive what it describes. _reconfigure() drops the client and
    // then returns early on a stopped card, so without this a card the user stopped keeps
    // advertising the route a config it no longer has once chose.
    this._route = null;
    this._syncVersion();
  }

  // --- streaming ----------------------------------------------------------

  async _play() {
    this._wantStream = true;
    if (this._session) return;
    if (!this._device) return; // _start() failed; its message is on screen
    this._busy(true);
    // Same reason as in _start(): _retry() reaches this method too, and a bare
    // _status('') here would wipe an escalated message once per retry cycle.
    this._syncStatus();

    const session = new BrowserSession({
      onTrack: (event) => {
        // Do not trust event.streams here. The plugin adds the video and audio
        // transceivers as two independent werift tracks with no `streams` option
        // (ffmpeg-to-wrtc.ts, addTrack), so there is no shared msid: a track can
        // arrive with an empty streams array, and taking streams[0] then drops it
        // silently. That is how the camera's audio went missing while the picture
        // worked - and with two different stream ids the second track would
        // instead have replaced the first. Own the MediaStream and collect every
        // track that arrives.
        if (!this._stream) {
          this._stream = new MediaStream();
          this._video.srcObject = this._stream;
        }
        this._stream.addTrack(event.track);
        this._video.play().catch(() => {});
      },
      onStateChange: (state) => this._onPeerState(state, session),
      // Not actionable, but worth surfacing: RTCSessionControl cannot renegotiate,
      // so if this ever fires the stream is beyond saving and the log is the
      // only clue.
      onNegotiationNeeded: () => console.warn(
        '[scrypted-card] renegotiation requested, but RTCSessionControl cannot perform one',
      ),
    });
    this._session = session;
    this._live = false;
    this._syncPoster();

    try {
      this._control = await this._openControl(session);
      this._scheduleRefresh();
      this._startWatchdog();
      this._watchFirstFrame();
      this._syncPlayback();
    } catch (err) {
      // _scheduleRetry() below writes both overlay layers itself, and the retry it
      // queues must not sit behind a session end nobody is waiting for.
      await this._stop({ resetOverlay: false, awaitEnd: false });
      this._scheduleRetry(String(err.message || err));
    }
  }

  /**
   * The session control, from one of two places.
   *
   * Without a destination this is today's call, unchanged - that branch is what
   * keeps the option free of risk for a dashboard that does not set it.
   *
   * With one, the stream is requested first and converted into a signaling channel
   * for exactly that stream. The plugin's wildcard converter (`["*​/*",
   * RTCSignalingChannel]`) hands back an OnDemandSignalingChannel whose
   * startRTCSignalingSession returns a real RTCSessionControl, so setPlayback -
   * the intercom trigger - getRefreshAt, extendSession and endSession all survive.
   * The negotiated audio direction is derived from the media object's sourceId,
   * which is why signaling.js treats a missing direction as receive-capable.
   */
  /**
   * Whether a destination can do anything on this device. The advertised
   * `VideoCamera` interface is not a usable test: the WebRTC mixin adds it for
   * cameras that have native signaling (main.ts:478), and for those
   * getVideoStream falls through to a forked path that ignores `destination`
   * entirely. A device whose only stream option is the plugin's own synthetic
   * 'webrtc' one is exactly that case.
   */
  async _canPickStream(device) {
    if (!this._hasVideoCamera) return false;
    const options = await withTimeout(
      Promise.resolve(device.getVideoStreamOptions()).catch(() => null),
      RPC_TIMEOUT,
    );
    if (!Array.isArray(options) || !options.length) return false;
    return !(options.length === 1 && options[0] && options[0].id === 'webrtc');
  }

  async _openControl(session) {
    const destination = this._destination;
    // Every call below is an RPC call that can hang on a dead peer, and withTimeout
    // resolves undefined rather than rejecting - so each result is checked, and the
    // checks *throw*. An early return would leave _play() with this._session assigned
    // but no control, no watchdog and no queued retry: a spinner nothing recovers from.
    // Throwing hands it to _play()'s catch, which is what feeds the retry machinery.
    // The signaling session is the one that used to be unbounded, and it was the whole
    // of BUG01: it is also the call the bound can only abandon, not cancel. The plugin
    // may finish setting the session up afterwards and nothing will ever end it -
    // _control was never assigned, so there is no handle to call endSession() on. _stop()
    // closes the local peer connection, which is what makes the remote side fall away;
    // the session itself lingers until Scrypted expires it.
    // Each failure names the phase it timed out in, because a bound that is too tight
    // for a slow network fails on hardware we never see and arrives as a bug report.
    if (!destination) {
      const control = await withTimeout(
        this._device.startRTCSignalingSession(session),
        STREAM_TIMEOUT,
      );
      if (!control) {
        throw new Error(
          `the camera did not answer within ${STREAM_TIMEOUT / 1000}s while negotiating the WebRTC connection`,
        );
      }
      return control;
    }
    const mo = await withTimeout(
      this._device.getVideoStream({ destination }),
      STREAM_TIMEOUT,
    );
    if (!mo) throw new Error(`no "${destination}" stream from the camera`);
    const channel = await withTimeout(
      this._client.mediaManager.convertMediaObject(mo, RTC_SIGNALING_CHANNEL),
      STREAM_TIMEOUT,
    );
    if (!channel) throw new Error(`no signaling channel for the "${destination}" stream`);
    const control = await withTimeout(
      channel.startRTCSignalingSession(session),
      STREAM_TIMEOUT,
    );
    if (!control) {
      throw new Error(
        `the camera did not answer within ${STREAM_TIMEOUT / 1000}s while negotiating the WebRTC connection for the "${destination}" stream`,
      );
    }
    return control;
  }

  /**
   * Ends the stream. The options exist because _stop() is the junction of every
   * recovery path *and* of the user's stop button, and those want opposite things:
   * a recovery has to keep the spinner up across the restart and get out of the way
   * as fast as it can, while a user stop has to take the spinner down and can afford
   * to end the session properly first. There is no reliable implicit discriminator -
   * `_stopped` is set by _onToggle() but not by _teardown() - so the caller says
   * which it is. The defaults describe a stop that is not part of a recovery.
   *
   * It cannot reject, and that is a contract rather than an accident. All four
   * callers - _recover(), _play()'s catch, _onToggle() and _teardown() - already
   * treat it as infallible, and each fails differently if it is not: no retry ever
   * gets scheduled again, the stop button dies permanently and throws again on the
   * next press, and the teardown skips _dropClient() and _dropPoster() and leaks an
   * RPC client, a websocket and an object URL every time HA removes the card.
   * Teaching four callers to expect a throw is bigger than making the assumption
   * true, so it is made true here.
   */
  async _stop({ resetOverlay = true, awaitEnd = true } = {}) {
    for (const clear of this._streamTimers.splice(0)) clear();
    this._clearTimer('_graceTimer');
    this._stableTimer = false;
    // The two teardown calls below are the only things here that can throw, and a
    // "should never happen" that stays invisible when it does happen is what made
    // the original failure impossible to report. Each gets its own guard and its own
    // log line - they fail for different reasons - and the first one is kept for the
    // user-facing message at the end.
    let failure = null;
    if (this._control) {
      const control = this._control;
      this._control = null;
      let ended = null;
      try {
        // The call belongs *inside* the guard, not merely under an appended
        // .catch(): control.endSession() is evaluated before .catch attaches, so a
        // dead @scrypted/client RPC proxy that throws on property access or on
        // invocation escapes it synchronously.
        // Never await a dead peer *unbounded* either: endSession() against one never
        // settles, hence withTimeout on top.
        ended = withTimeout(control.endSession().catch(() => {}), RPC_TIMEOUT);
      } catch (err) {
        console.warn('[scrypted-card] ending the session failed', err);
        failure = String(err.message || err);
      }
      // On a recovery not even the bounded wait is worth it: the session is already
      // gone, nothing the user can see improves by ending it cleanly, and up to
      // RPC_TIMEOUT of that wait is black picture. The other two callers do wait -
      // endSession() is what releases the camera's exclusive talkback channel, and
      // _teardown() drops the RPC client immediately afterwards, which would kill
      // the call in flight and leave the channel occupied.
      if (awaitEnd && ended) await ended;
    }
    if (this._session) {
      const session = this._session;
      // Nulled before close(), not after. close() is the second call that can throw,
      // and on that path the old order skipped this line - leaving a card that looks
      // like it still has a session, so the next _play() returns early on one that is
      // already gone. The card must end up in the same state either way.
      this._session = null;
      try {
        session.close();
      } catch (err) {
        console.warn('[scrypted-card] closing the peer connection failed', err);
        // The earlier cause is the more useful one to show.
        failure = failure || String(err.message || err);
      }
    }
    // Reveals whatever the poster still holds - the last snapshot, if one was ever
    // taken - at the same moment the video element stops carrying a picture.
    this._live = false;
    this._syncPoster();
    this._video.srcObject = null;
    this._stream = null;
    this._showStop = false;
    this._syncToggle();
    this._mic.hidden = true;
    this._syncMic(false);
    this._speaker.hidden = true;
    this._video.muted = true;
    this._syncSpeaker();
    // Was unconditional, and safe only because every recovery caller re-establishes
    // both layers on the next line. Now the caller decides. Skipping the reset is
    // still observably identical for the recovery callers - _recover() and _play()'s
    // catch both call _scheduleRetry() right after, which rewrites spinner and text
    // synchronously in either of its branches, so nothing can render in between.
    // What changes is ownership: the spinner is the only sign of an outage until the
    // text escalates, and must not be dropped and re-raised here.
    if (resetOverlay) {
      this._busy(false);
      // The card has stopped trying, so the outage it was reporting is over as far
      // as the user is concerned. Both callers that ask for the reset - the stop
      // button and _teardown() - mean exactly that.
      this._outageReason = null;
      this._escalated = false;
      this._outageFromLive = false;
      this._syncStatus();
      // Swallowing the throw must not mean swallowing the reason. This is the only
      // branch that can carry it: a recovery's caller writes the outage reason
      // immediately afterwards and that reason is the more useful of the two, while
      // here the card has just gone quiet and would otherwise say nothing at all.
      // It matters more than a log line - a session that could not be ended may
      // still be holding the camera's exclusive talkback channel.
      if (failure) this._status(`stopping the stream failed: ${failure}`);
    }
  }

  /**
   * Scrypted sessions have a lifetime; a dashboard that runs for days has to
   * extend them or the stream dies without any error.
   */
  async _scheduleRefresh() {
    if (!this._control) return;
    const at = await this._control.getRefreshAt().catch(() => null);
    if (!at) return;
    const delay = Math.max(1000, at - Date.now() - REFRESH_MARGIN);
    this._after(delay, async () => {
      if (!this._control) return;
      await this._control.extendSession().catch(() => {});
      this._scheduleRefresh();
    });
  }

  // --- self-healing -------------------------------------------------------

  _onPeerState(state, session) {
    if (this._session !== session) return; // state from a superseded attempt

    if (state === 'connected') {
      this._showStop = true;
      this._syncToggle();
      // Deliberately nothing about the outage message here, and this used to clear it.
      // 'connected' means the peer connection is up, not that a frame has been painted -
      // which is why the spinner, the poster and _outageFromLive all already wait for
      // _watchFirstFrame() instead. The message was the one signal not held to that
      // rule, so the card said "over" in text while the spinner beside it still said
      // "waiting". BUG02 is what made that matter: a connection that reaches 'connected'
      // and never delivers a frame reaches it once per attempt, so clearing here wiped
      // the reason each time and the message blinked instead of standing. The clear now
      // lives with the first decoded frame, beside the other three.
      // Deliberately no _busy(false) and no poster hide here: 'connected' means
      // the peer connection is up, not that a frame has been painted. Both happen
      // on the first decoded frame instead - see _watchFirstFrame.
      // Both sides have to agree: the plugin must have given us a send-capable
      // audio direction, and the camera must be able to play it back.
      this._mic.hidden = !(session.canTalk && this._intercom);
      // Every new stream starts muted, so a session that healed itself while the
      // dashboard was unattended never comes back unexpectedly loud.
      this._video.muted = true;
      this._syncSpeaker();
      this._speaker.hidden = !session.canListen;
      this._clearTimer('_graceTimer');
      // Only a connection that holds counts as recovered. Resetting the backoff
      // on every 'connected' would turn a flapping camera into a retry storm.
      // Once per stream: a connection that flaps inside the grace window must
      // not queue a timer per flap.
      if (!this._stableTimer) {
        this._stableTimer = true;
        this._after(STABLE_AFTER, () => { this._retries = 0; });
      }
      return;
    }

    if (state === 'disconnected') {
      // Wifi roaming and short packet loss recover on their own within a few
      // seconds; throwing the session away immediately is slower than waiting.
      this._busy(true);
      if (this._graceTimer) return;
      this._graceTimer = setTimeout(() => {
        this._graceTimer = null;
        if (this._session === session) this._recover('connection lost');
      }, DISCONNECT_GRACE);
      return;
    }

    if (state === 'failed' || state === 'closed') {
      this._recover(`connection ${state}`);
    }
  }

  /**
   * Hand the picture over from the poster to the video only once a frame has
   * actually been decoded. 'connected' is too early - it says the peer connection
   * is up - and loadeddata / canplay / playing are too early as well: on a WebRTC
   * srcObject they can all fire before anything has been painted, which is the
   * black flash this exists to remove. Stops itself on the first frame; the
   * watchdog takes over the same stat from there at its own, coarser rate.
   */
  _watchFirstFrame() {
    const session = this._session;
    // The deadline belongs here, beside the wait it bounds. The poll below reads a
    // missing measurement as "not yet" and would do so forever: framesDecoded()
    // returns null while getStats() carries no inbound-rtp video report at all, and a
    // peer connection that reaches 'connected' without one never produces a frame,
    // never fails and never stalls - so without this nothing in this file ever speaks.
    // That was BUG02: a live session behind a permanent spinner and no message.
    // Through _recover() rather than a new failure path, so the outcome is the ordinary
    // retry cycle with the reason on screen.
    // WATCHDOG_STALL rather than a constant of its own: this is the question that
    // constant already answers - how long without frames before the stream is dead -
    // asked at the start of a stream instead of in the middle of one. Deliberately not
    // tighter: too long only wastes time in an already broken state, while too short
    // tears down and rebuilds a merely slow camera forever, which is worse than the
    // hang it replaces.
    //
    // It measures *visible* time, and that is not optional. Playback is deliberately
    // paused off screen and no frames are expected there - the watchdog says so at its
    // own visibility guard - and an autoplay card below the fold opens its session
    // while hidden, because _start() reaches _play() with no visibility gate. A
    // deadline that counted hidden time would tear that session down and hand the user
    // a cold negotiation on scroll, destroying exactly what _syncPlayback() exists to
    // protect: the session survives a view switch so that coming back is instant.
    // Re-arming rather than recovering is what keeps both true.
    let deadline = null;
    const arm = () => {
      deadline = setTimeout(() => {
        if (this._session !== session || this._live) return;
        if (!this._isVisible()) { arm(); return; }
        this._recover('the camera connected but sent no video');
      }, WATCHDOG_STALL);
    };
    arm();
    // One cleanup entry, not one per re-arm, which is why this does not go through
    // _after(): a card that stays hidden re-arms every WATCHDOG_STALL for as long as
    // it stays hidden, and _after() would push a cancel into _streamTimers each time -
    // an array growing without bound for the life of the stream. Closing over the
    // handle keeps a single entry pointing at whichever timer is current.
    this._streamTimers.push(() => clearTimeout(deadline));
    const id = setInterval(async () => {
      if (this._session !== session) { clearInterval(id); return; }
      const frames = await session.framesDecoded().catch(() => null);
      if (this._session !== session) { clearInterval(id); return; }
      if (!frames) return; // null: no inbound video report yet, 0: nothing decoded
      clearInterval(id);
      this._live = true;
      // Frames are moving again, so the outage that escalated is genuinely over -
      // and the poster it was hiding behind is behind a live picture now. The reason
      // joins the other two here rather than being dropped at 'connected': a frame on
      // screen is the first moment the user can see for themselves that it is over,
      // and until then the text and the spinner have to agree. Every writer of
      // _outageReason funnels back through _play(), which always calls this method, so
      // nothing can strand a message by taking another route.
      this._outageReason = null;
      this._escalated = false;
      this._outageFromLive = false;
      this._syncPoster();
      this._busy(false);
      this._syncStatus();
    }, FIRST_FRAME_POLL);
    this._streamTimers.push(() => clearInterval(id));
  }

  /**
   * The stream can die while every state machine still reports success, so the
   * frame counter is the only reliable liveness signal.
   */
  _startWatchdog() {
    let frames = null;
    let moved = Date.now();
    this._every(WATCHDOG_INTERVAL, async () => {
      const session = this._session;
      if (!session) return;
      // Playback is deliberately paused off-screen, so no frames is expected.
      if (!this._isVisible()) { moved = Date.now(); return; }
      const current = await session.framesDecoded().catch(() => null);
      if (this._session !== session) return;
      if (current === null) {
        // Only before the first measurement is a missing report "too early", and that
        // window belongs to the deadline in _watchFirstFrame(). Afterwards the report
        // vanished from under a running stream, which is precisely the death this loop
        // exists to catch - so fall through to the stall check without touching `moved`.
        // Not folded into the comparison below: `null !== <number>` is true, so a
        // shared path would read a disappearing report as "frames moved", stamp `moved`
        // and reset the stall clock on every tick, forever.
        if (frames === null) return;
      } else if (current !== frames) {
        frames = current;
        moved = Date.now();
        this._busy(false);
        return;
      }
      // The stall is only declared after WATCHDOG_STALL, but the loop knows on
      // this very tick that frames stopped moving. Without saying so, the card
      // shows a frozen picture and no hint for 15-20 seconds, which looks exactly
      // like a working stream. connectionState stays 'connected' throughout, so
      // _onPeerState never runs and nothing else would speak up.
      this._busy(true);
      if (Date.now() - moved > WATCHDOG_STALL) this._recover('stream stalled');
    });
  }

  /** Tear the stream down and queue a fresh attempt. */
  async _recover(reason) {
    if (this._stopped || !this.isConnected || this._recovering) return;
    this._recovering = true;
    try {
      // Read before _stop() clears _live, and gated on it rather than on merely
      // getting here: all four entry points - grace expiry, watchdog stall,
      // 'failed'/'closed', client.onClose - can also fire during the very first
      // negotiation, before a single frame. Reaching _recover() is therefore no
      // evidence that anything ever worked, and only something that worked is worth
      // being quiet about. See _syncStatus().
      if (this._live) this._outageFromLive = true;
      // The spinner has to survive the restart, and the restart itself has to be as
      // short as it can be: the card is black from here until the first new frame.
      await this._stop({ resetOverlay: false, awaitEnd: false });
      this._scheduleRetry(reason);
    } finally {
      this._recovering = false;
    }
  }

  _scheduleRetry(reason) {
    this._outageReason = String(reason || 'connection lost');
    // Two deliberately distinct states: the bare reason for a card that will not
    // retry, and the countdown below for one that will. Both go through the same
    // renderer, so the escalation rule cannot end up applied to only one of them.
    this._syncStatus();
    if (this._stopped || !this.isConnected) { this._busy(false); return; }
    // The first retry of an outage goes immediately; the backoff picks up from the
    // second, with the same sequence it had before - hence the -1 in the exponent.
    const delay = this._retries === 0
      ? RETRY_FIRST
      : Math.min(RETRY_MAX, RETRY_BASE * (2 ** (this._retries - 1)));
    this._retries += 1;
    // The threshold is checked in the one place the count changes. Mind the
    // off-by-one and do not "simplify" it away: _retries counts calls to this
    // method, and the first of those is the failure that *opened* the outage, not a
    // retry - so one fewer retry has actually failed than the counter reads.
    // `_retries >= ESCALATE_AFTER_RETRIES` would escalate a whole attempt early.
    // Latched, not re-derived on every render: _onNetworkBack() sets _retries back to
    // 0 on every `online` event, and flaky wifi fires those repeatedly. A card that
    // has already named a failure must not fall silent again mid-outage.
    if (this._retries - 1 >= ESCALATE_AFTER_RETRIES) this._escalated = true;
    this._clearTimer('_retryTimer');
    // The spinner always, the text only once the outage has earned it: the spinner
    // says the card has not given up, and for an outage that heals in a couple of
    // attempts that is all it should say. This is also the path a failed _start()
    // takes, where nothing has turned the spinner on yet.
    this._busy(true);
    this._syncStatus(delay);
    // Still working, so the button stays a stop button and the retry stays
    // cancellable.
    this._showStop = true;
    this._syncToggle();
    this._retryTimer = setTimeout(() => this._retry(), delay);
  }

  /**
   * The resolver has failed ESCALATE_AFTER_RETRIES times in a row: leave the message on
   * screen and schedule nothing, because an integration that is not there will not
   * appear because we asked a fourth time, and an unbounded retry rebuilds exactly the
   * storm the refusal branch in _start() records - one attempt every 30 s for as long as
   * the page stays open, one loop per card.
   *
   * Three writes, and none of them is optional: _scheduleRetry() is what paints this
   * state today, so declining to arm its timer declines all of it.
   */
  _latchResolver(reason) {
    this._outageReason = String(reason);
    // Without this the card can end up silent. _syncStatus() returns without writing
    // while `_outageFromLive && !_escalated`, and _escalated is otherwise set only by
    // _scheduleRetry() once it has counted three retries - which is one more than this
    // path ever schedules. So on an outage that interrupted a working stream there would
    // be no retry pending and no text: a dead card behind a stale poster. Not _status()
    // directly, unlike the two other non-retrying paths: those are only reachable on a
    // first connect, while this state can be reached with an outage live, and a later
    // _syncStatus() from _recover() or _onNetworkBack() would overwrite a bare _status().
    this._escalated = true;
    this._syncStatus();
    // Nothing is coming, so the ring and the play button's pulse must stop claiming the
    // card is still working - they would otherwise say it forever.
    this._busy(false);
    // _scheduleRetry() left a stop icon behind, and _onToggle()'s cancel branch is now
    // false on all three of _session, _retryTimer and _pendingRetry - so the button would
    // *start* a connect while *showing* a stop. The two other non-retrying paths never
    // hit this because both are reachable only on a first connect.
    this._showStop = false;
    this._syncToggle();
  }

  async _retry() {
    this._retryTimer = null;
    if (this._stopped || !this.isConnected) return;
    // Reconnecting behind a hidden dashboard burns requests for a picture
    // nobody sees; _syncPlayback() picks this up the moment the card is back.
    if (!this._isVisible()) { this._pendingRetry = true; return; }
    this._pendingRetry = false;
    this._busy(true);
    // Drops the countdown, keeps the reason: the wait is over, the outage is not.
    this._syncStatus();
    if (!this._client || this._clientDead) await this._start();
    else await this._play();
  }

  _cancelRetry() {
    this._clearTimer('_retryTimer');
    this._clearTimer('_graceTimer');
    this._pendingRetry = false;
  }

  _onNetworkBack() {
    if (this._stopped || this._session || !this.isConnected) return;
    if (!this._retryTimer && !this._pendingRetry) return;
    this._clearTimer('_retryTimer');
    this._retries = 0; // the known cause is gone, start from the short delay
    this._retry();
  }

  _isVisible() {
    return this._visible && !document.hidden;
  }

  // Pausing beats tearing down: the session survives a view switch, so coming
  // back is instant instead of a fresh negotiation.
  _syncPlayback() {
    const on = this._isVisible();
    if (on && this._pendingRetry) {
      this._pendingRetry = false;
      this._retry();
      return;
    }
    if (!this._control) return;
    // Talkback must not survive going off screen: the camera's channel is
    // exclusive, and an invisible card holding it is invisible breakage.
    // _stopTalkback issues its own setPlayback; nothing else here does.
    if (!on && this._session && this._session.micEnabled) {
      this._stopTalkback();
    }
    // Deliberately no setPlayback while the microphone is off. The plugin's
    // setPlaybackInternal ignores the `video` flag entirely, so such a call
    // cannot pause anything - but it does park on the browser's audio track
    // arriving. Pressing talk makes it arrive, and the parked call then wakes up
    // next to the real one and races it: it unsubscribes the RTP forwarder and
    // stops the intercom that the talk press just started, which leaves ffmpeg
    // reading an empty input. Playback is paused locally instead.
    if (!on) this._video.pause();
    else this._resumePlayback();
  }

  /**
   * Resuming is not a user gesture, so an unmuted play() may be refused by the
   * autoplay policy - strictly so in Safari. Swallowing that leaves a frozen
   * picture and no explanation, and the watchdog cannot help because it triggers
   * on frames, not on visibility. Give up the sound rather than the picture, and
   * say so.
   */
  async _resumePlayback() {
    try {
      await this._video.play();
    } catch {
      if (this._video.muted) return; // refused for some other reason
      this._video.muted = true;
      this._syncSpeaker();
      this._status('sound off - the browser refused to resume it, press speaker');
      await this._video.play().catch(() => {});
    }
  }

  _onSpeaker() {
    this._video.muted = !this._video.muted;
    this._syncSpeaker();
    if (!this._video.muted) this._resumePlayback();
  }

  _syncSpeaker() {
    const on = !this._video.muted;
    // Icon and aria-pressed from the one state, in the one place: the crossed-out
    // speaker is what a sighted user reads, aria-pressed what the stylesheet and a
    // screen reader read, and they cannot drift while both are written here.
    this._speaker.innerHTML = on ? ICON_SOUND : ICON_MUTED;
    this._speaker.setAttribute('aria-pressed', String(on));
  }

  /**
   * The speaker reads its state back off the video element; talkback has no such
   * element to ask, and session.micEnabled is the wrong thing to read - every caller
   * that turns talkback off runs while it still says true, or with the session
   * already gone. So the state is passed in, and this stays the only place that
   * writes the button, which is what keeps aria-pressed - the state itself, now that
   * the icon is the same either way - from drifting from the session.
   *
   * `starting` follows for the same reason - there is nothing to read it back off
   * either - and it defaults to off so that every call that ends an attempt clears
   * the pulse without having to know it exists. aria-busy comes along because the
   * pulse alone says nothing to a screen reader, and the user just pressed this.
   */
  _syncMic(on, starting = false) {
    this._mic.innerHTML = ICON_MIC;
    this._mic.setAttribute('aria-pressed', String(on));
    this._mic.classList.toggle('busy', starting);
    this._mic.setAttribute('aria-busy', String(starting));
  }

  async _onToggle() {
    // A queued retry counts as running: the button cancels it instead of
    // starting a second attempt next to it.
    if (this._session || this._retryTimer || this._pendingRetry) {
      this._stopped = true;
      this._wantStream = false;
      this._cancelRetry();
      await this._stop({ resetOverlay: true });
      // A deliberately stopped card should not show a minutes-old picture. Only
      // this path refreshes: _stop() is also every recovery path, where the device
      // is usually unreachable precisely because it is reconnecting, and a
      // takePicture() there would burn its full timeout once per cycle - and
      // _dropClient() has already nulled _device in the onClose case.
      this._refreshPoster();
      return;
    }
    this._stopped = false;
    this._wantStream = true;
    this._retries = 0;
    // The resolver's bound as well, for the reason the comment above the refusal branch
    // in _start() states: that is a person asking, not a loop. Without this the first
    // failure after the press re-latches immediately and the press bought one attempt
    // instead of the bounded three.
    this._resolverFailures = 0;
    // If the initial connect failed there is no device to stream from. Retry the
    // whole connect from here rather than letting _play() fail on undefined -
    // that produced a misleading "cannot read startRTCSignalingSession" and hid
    // the real error.
    if (!this._device || this._clientDead) await this._start();
    else await this._play();
  }

  /**
   * Talkback is driven by setPlayback({audio}) on the session control - that is
   * what makes the plugin start and stop the camera's intercom. Ordering is not
   * cosmetic: setPlayback waits for the browser's audio track to actually arrive
   * before it does anything, so the microphone has to be live first, otherwise
   * the call never settles.
   */
  async _onMic() {
    if (!this._session || !this._control) return;
    const session = this._session;
    const control = this._control;

    if (session.micEnabled) {
      await this._stopTalkback();
      return;
    }

    // Before either call, not just before the slow one: setMicrophone() can sit on a
    // permission prompt of its own, and both are inside the window where the button
    // would otherwise look untouched. Still the off icon - talkback is not on yet.
    this._syncMic(false, true);
    try {
      await session.setMicrophone(true);
      const started = await withTimeout(
        control.setPlayback({ audio: true, video: this._isVisible() }).then(() => true),
        INTERCOM_TIMEOUT,
      );
      if (!started) throw new Error('camera did not start talkback');
      // Stream was replaced meanwhile. The pulse is already gone without this path
      // touching the button: _play() refuses to build a session while one is set, so
      // the replacement went through _stop(), which resets the talk button.
      if (this._session !== session) return;
      this._syncMic(true);
      this._status('');
    } catch (err) {
      await this._stopTalkback();
      this._status(`talkback: ${err.message || err}`);
    }
  }

  /**
   * Releases the camera's talkback channel. It is exclusive per camera, so this
   * has to run on every path that ends talking - not just the button.
   */
  async _stopTalkback() {
    const session = this._session;
    const control = this._control;
    this._syncMic(false);
    if (session) await session.setMicrophone(false).catch(() => {});
    if (!control) return;
    await withTimeout(
      control.setPlayback({ audio: false, video: this._isVisible() }).catch(() => {}),
      RPC_TIMEOUT,
    );
  }

  // --- teardown -----------------------------------------------------------

  async _teardown() {
    if (this._observer) { this._observer.disconnect(); this._observer = null; }
    document.removeEventListener('visibilitychange', this._onVisibility);
    window.removeEventListener('online', this._onOnline);
    this._cancelRetry();
    this._clearTimer('_reconfigureTimer');
    // Ordered on purpose: _stop() ends the RTC session, which is what releases
    // the camera's talkback channel. Dropping the client first would kill the
    // RPC peer with that call still in flight and leave the channel occupied. That
    // is also why this path keeps awaiting the session end - see _stop().
    await this._stop({ resetOverlay: true });
    this._dropClient();
    this._dropPoster();
    this._started = false;
    this._retries = 0;
    // So a card Home Assistant removes and re-adds does not inherit a latch. The panel
    // signature goes with it: a re-added card must record what it sees now rather than
    // measure a change against a set it never acted on.
    this._resolverFailures = 0;
    this._panelSig = null;
    this._panelsSeen = null;
  }

  _clearTimer(field) {
    if (!this[field]) return;
    clearTimeout(this[field]);
    this[field] = null;
  }

  // Stream-scoped: cleared on every stop, including a recovery restart.
  _after(delay, fn) {
    const id = setTimeout(fn, delay);
    this._streamTimers.push(() => clearTimeout(id));
  }

  _every(delay, fn) {
    const id = setInterval(fn, delay);
    this._streamTimers.push(() => clearInterval(id));
  }

  // Session-scoped: survives stream restarts, cleared with the client.
  _sessionEvery(delay, fn) {
    const id = setInterval(fn, delay);
    this._sessionTimers.push(() => clearInterval(id));
  }
}

customElements.define('scrypted-camera-card', ScryptedCameraCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'scrypted-camera-card',
  name: 'Scrypted Camera',
  description: 'Native WebRTC camera card with two-way audio, talking directly to Scrypted.',
  preview: false,
});
