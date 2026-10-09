# redmine_niimbot_labels

A Redmine 6+ plugin that prints issue labels on a **NIIMBOT B1** straight from
the browser, over Web Bluetooth. The label carries the issue title, a QR
code with the issue URL (`<protocol>://<host name>/issues/<id>`), the issue
number and its creation date. The QR codes are what
[organikum_qr_scanner](https://github.com/ndtimofeev/organikum_qr_scanner)
expects to scan.

Label printing is a **project module**: it appears only in projects that
have it enabled, and only for roles that have the permission (see "Where it
shows up").

Talking to the printer is done by [niimbluelib](https://github.com/MultiMote/niimbluelib)
(MIT), vendored under `assets/javascripts/`.

**Status:** checked against a simulated B1 (see "Tests"), not yet on real
hardware.

## Printing

On an issue page, the sidebar has a **Label** block with **Print label…**.
On a phone Redmine moves the sidebar into the menu behind the hamburger
button, so the link is there; tapping it closes that menu.

The link opens a dialog with:

- **Printer** - "not connected" with a **Connect** button, or the printer
  name with **Disconnect**. Once connected: battery, lid (closed / open) and
  labels (loaded, how many are left on the roll according to its RFID tag,
  or none). Problems are shown in red. The state refreshes every 2 seconds.
- **Copies** - 1 to 99, with − / + buttons so a phone needs no keyboard.
- **Print** - connects first if needed (Chrome's device chooser), then prints
  all copies as one job, showing "Printing… 2 of 3", then "Printed: 3".
- **Cancel** (**Close** after printing), the × or Escape close the dialog.

The printer stays connected while the page is open, so reopening the dialog
or printing again does not ask for it. Redmine reloads the page on every
navigation, so on the next issue Chrome asks for the printer again.

On phones (Redmine's mobile layout, below 900 px) the dialog takes the
screen width and its buttons are at least 44 px high.

## The label

```
+--------------------------------------+
| Title across the whole width, up to  |
| two lines                            |
| +--------+  #123                     |
| |   QR   |  02.10.2026               |
| +--------+                           |
+--------------------------------------+
```

- **Title**: the issue subject, or the value of the custom field chosen in
  the plugin settings when the issue has it, the user may see it and it is
  not empty. Bold, as large as fits into two lines; longer titles get an
  ellipsis.
- **QR code** under the title, as large as the remaining height allows.
- **Issue number** and **creation date** to the right of the QR code. The
  date uses Redmine's date format (*Administration > Settings > Display*), or
  the user's language when that is "Based on user's language".

## Where it shows up

- *Project > Settings > Modules > Label printing* switches it on per project.
  Subprojects are separate projects and need it ticked too.
- *Administration > Roles and permissions > Label printing > Print issue
  labels* decides who may print where it is on. Installing the plugin gives
  this permission to every role that can view issues (except Anonymous), so
  ticking the module is enough to start; take it away from roles as needed.
- Where both hold, the issue page sidebar has the link. Everywhere else
  (other projects, issue lists, the new issue form) there is no trace of the
  plugin.
- Closed projects keep printing: the permission is a read permission, as
  printing a label changes nothing in Redmine.

## Requirements

- Redmine 6.0 or newer (developed against 7.0).
- **Chrome on Android** (6.0+) or desktop Chrome/Edge. Firefox and anything on
  iOS have no Web Bluetooth.
- Redmine over **HTTPS** - browsers expose Web Bluetooth only on secure
  origins (or `localhost`).
- On the phone: Bluetooth on; Chrome allowed "Nearby devices" (Android 12+)
  or location (Android 11 and older); the B1 not connected to the NIIMBOT app
  at the same time - it accepts one connection and stays invisible while it
  has one.
- **Administration > Settings > General > Host name and Protocol** set to the
  address people actually use. QR codes are built from them (like links in
  Redmine's emails), not from whatever address the page was opened at; admins
  get a warning under the link when the two differ.

## Install

```
cd <redmine>/plugins
git clone https://github.com/ndtimofeev/redmine_niimbot_labels
cd <redmine>
bundle exec rake redmine:plugins:migrate RAILS_ENV=production
```

Restart Redmine, then enable *Label printing* in the modules of the projects
that need it. The migration only grants the permission (see "Where it shows
up"); rolling it back (`NAME=redmine_niimbot_labels VERSION=0`) removes the
permission from all roles. No gems: the QR matrix comes from `rqrcode`, which
Redmine already bundles for two-factor authentication.

Settings (*Administration > Plugins > Niimbot Labels > Configure*):

- label width and height in mm (default 50 x 30);
- print density 1-5 (default 3);
- **Title on the label**: "Issue subject" or an issue custom field of the
  *Text* or *Long text* format, printed instead of the subject when filled in
  (line breaks of a long text are folded into spaces).

## Design

- **The QR code is computed on the server** (`RQRCode`), embedded in the page
  as rows of `0`/`1` and drawn with a whole number of printer dots per module,
  so no JavaScript QR library is needed and modules never blur. The label is
  drawn on an off-screen canvas at printer resolution (8 dots/mm, 203 dpi)
  and thresholded to pure black and white, because niimbluelib burns every
  non-white pixel.
- **Size.** The side across the print head is cut to its width (384 dots,
  48 mm on the B1): a 50 x 30 mm label is drawn as 384 x 240 dots.
- **Layout.** The title takes what it needs at the top, but never squeezes
  the QR code below 5 dots (0.6 mm) per module, a margin against thermal
  bleed; the QR code gets the rest of the height with a whole number of dots
  per module and a quiet zone of at least two modules; number and date are fitted into the space to its
  right. Title text, date and the QR matrix are prepared on the server
  (`RedmineNiimbotLabels.label`), the drawing is done in the browser.
- **One print job per press**, all copies in it, the way NiimBlue does it:
  heartbeat polling is paused meanwhile and `printEnd` always runs.
- **The link** is rendered by the `view_issues_sidebar_issues_bottom` hook,
  only on the page of a saved issue (the same sidebar is shown on issue
  lists). Its click is handled by a delegated listener, as on a phone Redmine
  moves the sidebar into the hamburger menu. Redmine's icon sprite has no
  printer, so the Tabler "printer" icon is inlined.
- **The dialog** is Redmine's own `showModal` (a jQuery UI dialog, like "Add
  watchers"), so it looks and closes like the rest of Redmine, and Redmine's
  mobile styles already fit it to the screen. Printer state comes from
  niimbluelib's heartbeat (battery, lid, labels) and the roll's RFID tag
  (labels left).
- **Script delivery.** niimbluelib and `niimbot_labels.js` are served together
  by `GET /niimbot_labels/script?v=<digest>` with a one-year cache header,
  rather than through the plugin asset pipeline (which needs
  `assets:precompile`) or inlined (120 KB on every issue page).
- **Permissions.** An issue is printable when the user can see it and has
  `:print_issue_labels` in the issue's project
  (`RedmineNiimbotLabels.printable?`).

## Picking the printer without a dialog (optional)

Chrome can reconnect to an already-allowed device without the chooser only
with two flags (`chrome://flags/#enable-experimental-web-platform-features`
and `#enable-web-bluetooth-new-permissions-backend`). The plugin does not use
this yet.

## Tests

`test/e2e/seed.rb` creates the test data (a project with the module, one
without, a Developer member, a title custom field filled on one issue); `test/e2e/run.js` (Playwright) drives a running
Redmine, in a Pixel 7 profile (link in the hamburger menu, dialog) and on desktop,
with `test/e2e/fake_b1.js` replacing `navigator.bluetooth` by a simulated B1
(answers taken from a real B1 dump in niimbluelib's tests). It rebuilds the
bitmap the "printer" received and decodes its QR code with
organikum_qr_scanner's html5-qrcode, and checks the module and permission
scoping, toggling the permission on the Developer role through the admin UI.
See the header of `run.js` for how to run it.

## Structure

- `init.rb` - registration, settings, the project module with its permission.
- `db/migrate/001_grant_print_issue_labels.rb` - grants the permission to
  roles that can view issues.
- `lib/redmine_niimbot_labels.rb` - label data (URL, QR rows), settings,
  script bundle, the printer icon; `lib/redmine_niimbot_labels/hooks.rb` -
  the sidebar hook.
- `app/views/niimbot_labels/_sidebar.html.erb` - the Label block and the
  dialog.
- `app/controllers/niimbot_labels_controller.rb` - serves the script.
- `assets/javascripts/niimbot_labels.js` - drawing, the `Printer` wrapper
  around niimbluelib, the dialog.
- `assets/javascripts/niimbluelib.min.js` + `niimbluelib.LICENSE` - niimbluelib
  0.47.0 UMD build from npm, unmodified.

niimbluelib's author notes the library is not affiliated with NIIMBOT and the
protocol is reverse-engineered: a printer firmware update may break printing.
