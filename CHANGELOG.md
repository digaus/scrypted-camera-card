# Changelog

All notable changes to this card. Format per
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning per
[Semantic Versioning](https://semver.org/).

Entries are added once an implementation is verified — not when it is merely
implemented. Version and date are filled in at release time.

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
