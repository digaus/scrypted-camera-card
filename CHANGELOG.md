# Changelog

All notable changes to this card. Format per
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning per
[Semantic Versioning](https://semver.org/).

Entries are added once an implementation is verified — not when it is merely
implemented. Version and date are filled in at release time.

## [0.5.2] - 2026-08-05

### Fixed

- **The `source` dropdown from 0.5.1 never appeared** — the field stayed free text even with
  Scrypted integrations and the add-on installed, so that release delivered nothing. The list
  was assembled while the editor was still being constructed, before Home Assistant had handed
  it the information it needed. It is now assembled once both are present.

## [0.5.1] - 2026-08-05

### Changed

- **The visual editor offers `source` as a list of what is installed** instead of asking for a
  name in free text: each `koush/ha_scrypted` entry by its Name, plus the Scrypted add-on,
  plus "Automatic" for the usual case. This removes the field's real trap — the integration
  entry is identified by its **Name**, while Home Assistant lists that entry under its
  **host**, so the value that looked obvious was the wrong one.

  The add-on's slug is not read from the Supervisor's `/addons` endpoint; it comes out of the
  update entity the Supervisor creates per add-on, which costs no round trip and works even
  where there is no Supervisor.

  Where nothing can be discovered — no integration entry, no Scrypted add-on — the field stays
  free text and behaves exactly as in 0.5.0. Same for a `source` set in YAML that the list does
  not contain: the field stays text so that opening the editor cannot overwrite it.

## [0.5.0] - 2026-08-04

### ⚠ Breaking

**Three config keys are gone: `addon`, `connection` and `integration_title`.** They are
replaced by one, `source`, and **no alias is kept** — a card that relies on any of them will
not work as configured after this update.

What to do, and for most installations it is nothing:

- **`addon` set to the default `09e60fb6_scrypted`, or not set at all** — delete it, or leave
  it, either is fine. The card resolves the add-on route to that slug on its own.
- **`addon` set to something else** — rename the key to `source`. This is the case that
  breaks: the card no longer reads `addon`, so it would look for the default add-on instead of
  yours and report that it cannot read it.
- **`connection` or `integration_title` (from 0.4.0, released the same day)** — delete them.
  They are ignored.

Opening the card once in the visual editor removes all three keys from the YAML for you.

### Changed

- **The card now picks how it reaches Scrypted by itself, and the three options from 0.4.0
  become one.** The rule:

  > The `koush/ha_scrypted` integration's proxy when that integration is installed. Otherwise
  > the Scrypted add-on. If Scrypted `username`/`password` are set, always the add-on — that
  > is the only route where they mean anything. If the proxy is installed but cannot be
  > resolved, the add-on is tried anyway before the card gives up.

  So a Scrypted outside the add-on needs nothing in the card configuration at all: install the
  integration and the card uses it. Which route it took is shown next to the version number
  while the card is paused — `v0.5.0 · integration` or `· ingress`.

- **`connection` is gone**, hours after 0.4.0 introduced it. Three keys for one question was
  clutter, and detection turned out to need no switch: the presence of the integration's
  sidebar panel is a local read, not a network call that has to fail first. A leftover
  `connection:` in a config is ignored.

- **`addon` and `integration_title` become one key, `source`** (see _Breaking_ above). It names
  the add-on slug or the integration entry's Name, depending on the route the card chose —
  which is unambiguous because the route is decided first. **You normally leave it empty**; it
  is no longer prefilled with the add-on's default slug, because that default applies to only
  one of the two routes.

- Setting `username`/`password` no longer produces an error on the integration route; it
  selects the add-on route instead, which is what those values were asking for.

## [0.4.0] - 2026-08-04

### Added

- **`connection: integration`** — reach a Scrypted that is **not** the Home Assistant
  add-on. The card routes through the HTTP proxy of the
  [`koush/ha_scrypted`](https://github.com/koush/ha_scrypted) integration, which must be
  installed and configured with your Scrypted host. The default, `connection: ingress`, is
  unchanged and still expects the add-on.

  Connecting straight to a Scrypted URL is not possible from a dashboard and never will be:
  the browser blocks it before the request leaves, because Scrypted answers the CORS
  preflight without an `Access-Control-Allow-Origin` header and the client library forces the
  credentialed request mode where no wildcard is accepted either. The integration's proxy
  runs on the Home Assistant side, so there is no cross-origin request at all — and it
  authenticates for us, which is why `username`/`password` are **refused** in this mode: the
  proxy overwrites that header, so credentials there would look like they scope the card
  while scoping nothing.

  `integration_title` picks one when several Scrypted integration entries exist. It matches
  the **Name** of the entry, whose default is `Scrypted` for all of them — two entries left
  at the default cannot be told apart, and one of them has to be renamed.

  Both options are in the visual editor. A connection that cannot be resolved — no such
  integration, or an ambiguous one — retries a few times and then stops with a message
  naming what to change, rather than retrying for as long as the page stays open. It picks
  itself up again when the integration appears, without a reload.

  Released as `0.4.0-beta.1` first and tested on that build before this release.

## [0.3.1] - 2026-08-03

### Changed

- **The grey off state from 0.3.0 is reverted.** The talk and sound buttons are white
  again when off, and the sound button is crossed out when muted, as it was before 0.3.0.
  The microphone keeps a single icon and shows its state through colour only. Both
  alternatives tried on the way — a crossed-out microphone in 0.2.2, grey buttons in
  0.3.0 — were rejected on appearance.
- **The version number moved to the top right**, and now shows only while the card is
  paused. It used to sit in the bar at the bottom and stayed visible while connecting,
  where it shared the corner with the loading indicator.

## [0.3.0] - 2026-08-03

### Changed

- **The talk and sound buttons now grey out when they are off** instead of showing a
  crossed-out icon. The crossed-out microphone shipped one version earlier and did not
  look good next to the rest of the bar. Both buttons keep their plain icon in both
  states and the colour carries the state: grey off, red on.

  The trade-off, since it is a real one: grey and red differ mostly in hue and barely in
  brightness, so the two states are harder to tell apart than a crossed-out icon was —
  noticeably so with a red-weak colour vision. The buttons still report their state to
  screen readers, which is unaffected.

  A button that is *waiting* now turns plain white rather than staying grey, which also
  keeps it legible on systems set to reduced motion, where the pulse is replaced by a
  dimmed icon.

### Added

- **The version number is shown in the bottom right while the card is not streaming**,
  small and light grey. It disappears as soon as the picture is live. Useful for telling
  at a glance whether a dashboard is actually running the version you just installed —
  browsers cache this file aggressively.

  It is taken from the build, not typed in, and a release now refuses to publish if the
  tag and the version in the package do not match, so the number the card shows cannot
  drift from the release it came from.

## [0.2.2] - 2026-08-03

### Changed

- **The microphone button now shows whether talkback is on**, crossed out when it is off,
  the way the speaker button already did. Both icons now describe the current state
  rather than the action a press would perform.
- **Buttons pulse while the card is waiting.** Pressing talk can take up to ten seconds
  before the camera's audio channel is actually open — the add-on starts a stream server
  and a transcoder first — and until now nothing on the button changed in that window, so
  a press looked like it had been ignored. The play/stop button pulses on the same
  principle whenever the card is connecting, reconnecting or has stopped trusting the
  picture, which makes it a second sign of that state next to the loading indicator.

  The icon stays readable throughout, since it is also what says which state the control
  is in. Buttons remain pressable while pulsing, so a long reconnect backoff can still be
  cut short. Systems set to reduced motion get a dimmed button instead of a moving one.

## [0.2.1] - 2026-08-03

### Fixed

- **The stream could stop and stay stopped**, showing the loading indicator and the play
  button together with no message at all — sometimes for hours. Pressing play twice
  started it again.

  The call that negotiates the WebRTC connection was the one call in that path with no
  time limit, so a Scrypted peer that accepted the request and then never answered left
  the card waiting indefinitely. Everything that would have noticed — the stream
  watchdog, the first-frame check, the session refresh — is only started *after* that
  call returns, so nothing was watching. It is now bounded like the calls around it, and
  a timeout goes into the normal reconnect cycle with a message naming the step that
  timed out.
- The "Before you install" section of the README rendered as a mangled bullet list in
  0.2.0.

## [0.2.0] - 2026-07-31

### Changed

- **Non-admin Home Assistant users can now use the card.** Measured: of the three
  Supervisor calls the card made, only the add-on *list* was admin-gated. `addon` now
  defaults to `09e60fb6_scrypted`, which removes that call entirely — so non-admin
  access is the ordinary path rather than a special case, and administrator rights are
  no longer required at all.
- **`username` / `password` are now the way to scope what the card shows.** Left empty
  the card connects as whatever the add-on considers an ingress request, usually an
  account with full access. Filled in with a Scrypted viewer account restricted to a few
  cameras, the card is limited to those. Documented as such; the editor previously
  advised leaving them empty.

### Removed

- **Add-on auto-detection, and the add-on dropdown in the editor.** Both needed the
  admin-only list call, so the dropdown could never work for the users this release is
  for. `addon` is a plain text field showing the default.

  **If your Scrypted add-on's slug differs from the default** — a different add-on
  repository, a fork, or a locally installed add-on — set `addon` in the card config.
  The slug was checked across several Home Assistant installations and was always the
  same, because the prefix derives from the add-on repository rather than the
  installation, so this should affect very few setups. If it affects yours, the card
  names both the slug it tried and `addon` as the fix.

### Fixed

- An authorization refusal from Home Assistant no longer retries forever. It used to go
  into the normal reconnect machinery, so a non-admin viewing a dashboard produced an
  attempt every 30 seconds for as long as the page was open — once per card.
- When credentials are in use and the camera is not found, the message now says it may
  be outside that Scrypted account's permissions rather than only suggesting a typo. The
  card cannot tell the two apart, so it names both.

### Security

- Documented that a Home Assistant account is effectively Scrypted access: creating an
  ingress session is not admin-gated, so any logged-in user can open Scrypted's
  interface directly, with or without this card. Credentials in the card scope what the
  *card* shows and do not restrict Scrypted itself.

## [0.1.1] - 2026-07-31

Documentation only — the card itself is unchanged. Released rather than pushed,
because HACS appears to render the README from the release rather than from the
default branch, so a branch-only fix never reaches anyone.

### Fixed

- The installation instructions claimed HACS registers the Lovelace resource by
  itself and that nothing needs adding by hand. That holds for storage-mode
  dashboards only. On a **YAML-mode** dashboard HACS cannot register resources at
  all, and the entry has to go into `configuration.yaml` — documented now, together
  with the `?v=` cache-busting query a hand-written entry needs and HACS's own
  registration provides.

### Added

- A screenshot of the card in Home Assistant's card editor.

## [0.1.0] - 2026-07-31

First public release. The list below describes what the card does rather than the
steps taken to get there: there is no published predecessor to mark things as
"changed" or "fixed" against.

### Added

- Streams a Scrypted camera over WebRTC straight into the dashboard. No iframe, no
  Scrypted UI, no scraped selectors.
- **Two-way audio** on cameras exposing `Intercom`. The microphone is requested when
  the talk button is pressed, not before, and released again when it is switched off —
  the browser's recording indicator does not stay lit. The camera's exclusive return
  channel is also released when the view is left and when the card is removed.
- **Speaker button** for the camera's audio.
- **Still image** while no stream is running.
- **`autoplay`** (default `false`): the card shows the still image on load and streams
  on demand. `true` streams immediately.
- **`destination`**: picks the camera stream — `local`, `remote` or `low-resolution`.
  Omit it and Scrypted decides. The value is a hint, not an instruction; a camera with
  no matching substream returns something else. On an unknown value, or a camera with
  no selectable stream, the card refuses to stream and says why.
- **Self-healing**: the stream comes back by itself after an add-on restart, a lost
  connection or a network outage. The session is extended in the background, and a
  frozen stream is detected within seconds.
- **Visual editor** for the card configuration, including a dropdown of the installed
  Scrypted add-ons. The `device` field is free text — the editor has no Scrypted
  connection and cannot check it.
- **Loading indicator** top right, over the picture. The play/stop button stays usable
  while it shows, so a long backoff can be cut short and reconnected immediately.
- "Connection lost" appears only after three consecutive failed retries; short blips
  pass without comment. Errors at startup — wrong device, missing camera interface,
  invalid `destination` — are reported at once.
- Installation through HACS as a custom repository.

### Known limitations

Written up in full in `README.md`; the ones that matter before installing:

- Requires **Home Assistant Supervised or HA OS**, **Scrypted as an HA add-on**, and an
  **administrator** as the viewer. There is no way to point the card at a Scrypted URL
  directly.
- Tested against Scrypted 0.143.0. Scrypted's RPC interfaces are internal and not
  publicly documented; a Scrypted update can break this card.
- During a recovery, cameras exposing the `Camera` interface show the most recent still
  image. It can be several minutes old and is indistinguishable from a live picture,
  apart from the loading indicator.
