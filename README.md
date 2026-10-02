# redmine_niimbot_labels

A Redmine 6+ plugin that prints issue labels on a **NIIMBOT B1** straight from
the browser, over Web Bluetooth. The label carries a QR code with the issue
URL (`<protocol>://<host name>/issues/<id>`), the issue number and, optionally,
its subject. The QR codes are what
[organikum_qr_scanner](https://github.com/ndtimofeev/organikum_qr_scanner)
expects to scan.

Talking to the printer is done by [niimbluelib](https://github.com/MultiMote/niimbluelib)
(MIT), vendored under `assets/javascripts/`.

**Status: first version.** Checked against a simulated B1 (see "Tests"), not
yet on real hardware.

## Two ways to print

- **Issue page.** A label preview and a "Print label" button under the issue
  attributes. The first press on a freshly loaded page opens Chrome's device
  chooser; pick the B1 and the label prints. Further presses on the same page
  reuse the connection, but Redmine reloads the page on every navigation, so
  the next issue asks for the printer again.
- **Print page** (`/niimbot_labels`, "Label printing" in the cross-project
  menu). Connect once, then print any number of labels without picking the
  printer again. Issues get there from
  - "Print labels" in the context menu of an issue list (selected issues),
  - "Print queue" link on the issue page,
  - the "Issue number" field on the page itself (a number, several numbers,
    or a pasted issue URL).

  Each label has a copy count; "Print all" sends the whole queue as one job.
  The page shows printer state (battery, lid open, no labels), keeps the
  screen on while connected (Screen Wake Lock: Android freezes a page with the
  screen off and the Bluetooth connection drops with it) and keeps the queue
  in the URL, so reloading or bookmarking it is safe.

## Requirements

- Redmine 6.0 or newer (developed against 7.0).
- **Chrome on Android** (6.0+) or desktop Chrome/Edge. Firefox and anything on
  iOS have no Web Bluetooth.
- Redmine over **HTTPS** - browsers expose Web Bluetooth only on secure
  origins (or `localhost`).
- On the phone: Bluetooth on; Chrome allowed "Nearby devices" (Android 12+)
  or location (Android 11 and older); the B1 not connected to the NIIMBOT app
  at the same time - it accepts one connection.
- **Administration > Settings > General > Host name and Protocol** set to the
  address people actually use. QR codes are built from them (like links in
  Redmine's emails), not from whatever address the page was opened at; the
  print page warns when the two differ.

## Install

```
cd <redmine>/plugins
git clone https://github.com/ndtimofeev/redmine_niimbot_labels
```

Restart Redmine. No migrations, no gems: the QR matrix comes from `rqrcode`,
which Redmine already bundles for two-factor authentication.

Settings (*Administration > Plugins > Niimbot Labels > Configure*): label
width and height in mm (default 50 x 30), print density 1-5 (default 3),
whether to print the subject.

## Design

- **The QR code is computed on the server** (`RQRCode`), sent to the page as
  rows of `0`/`1` and drawn with a whole number of printer dots per module, so
  no JavaScript QR library is needed and modules never blur. The label is
  drawn on a canvas at printer resolution (8 dots/mm, 203 dpi) and
  thresholded to pure black and white, because niimbluelib burns every
  non-white pixel; the preview is therefore exactly what gets printed.
- **Size.** The side across the print head is cut to its width (384 dots,
  48 mm on the B1): a 50 x 30 mm label is drawn as 384 x 240 dots.
- **One print job per press**, the way NiimBlue does it: heartbeat polling is
  paused, all pages and copies go into one task, `printEnd` always runs.
- **Script delivery.** niimbluelib and `niimbot_labels.js` are served together
  by `GET /niimbot_labels/script?v=<digest>` with a one-year cache header,
  rather than through the plugin asset pipeline (which needs
  `assets:precompile`) or inlined (120 KB on every issue page).
- **Permissions.** Any logged-in user can print the label of any issue they
  can see (`Issue.visible`); there is no separate permission.
- `GET /niimbot_labels/issues/:id` returns the label data as JSON but is
  deliberately not routed with a `.json` format: Redmine treats format=json as
  an API request and ignores the session cookie for it.

## Picking the printer without a dialog (optional)

Chrome can reconnect to an already-allowed device without the chooser only
with two flags (`chrome://flags/#enable-experimental-web-platform-features`
and `#enable-web-bluetooth-new-permissions-backend`). The plugin does not use
this yet; the print page is the answer to the chooser for now.

## Tests

`test/e2e/run.js` (Playwright) drives a running Redmine in a Pixel 7
profile, with `test/e2e/fake_b1.js` replacing `navigator.bluetooth` by a
simulated B1 (answers taken from a real B1 dump in niimbluelib's tests). It
rebuilds the bitmap the "printer" received, checks it equals the preview and
decodes its QR code with organikum_qr_scanner's html5-qrcode. See the header
of `run.js` for the data it expects.

## Structure

- `init.rb` - registration, settings, the menu entry.
- `lib/redmine_niimbot_labels.rb` - label data (URL, QR rows), settings,
  script bundle; `lib/redmine_niimbot_labels/hooks.rb` - issue page and
  context menu hooks.
- `app/controllers/niimbot_labels_controller.rb` - print page, label JSON,
  script.
- `app/views/niimbot_labels/` - print page, issue page widget, context menu
  item, shared styles.
- `assets/javascripts/niimbot_labels.js` - drawing, the `Printer` wrapper
  around niimbluelib, issue widget and print page.
- `assets/javascripts/niimbluelib.min.js` + `niimbluelib.LICENSE` - niimbluelib
  0.47.0 UMD build from npm, unmodified.

niimbluelib's author notes the library is not affiliated with NIIMBOT and the
protocol is reverse-engineered: a printer firmware update may break printing.
