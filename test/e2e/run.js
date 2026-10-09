// End-to-end check against a running Redmine with this plugin and a fake B1
// (fake_b1.js) standing in for navigator.bluetooth. See README, "Tests".
//
//   bin/rails runner plugins/redmine_niimbot_labels/test/e2e/seed.rb
//   REDMINE_URL=http://localhost:3000 \
//   HTML5_QRCODE=../organikum_qr_scanner/assets/javascripts/html5-qrcode.min.js \
//   node plugins/redmine_niimbot_labels/test/e2e/run.js
//
// Uses the data seed.rb creates: project "sklad" with the module (#1-#3),
// "office" without it (#4), admin/admin12345 and ivan/ivan12345 (Developer).
const {chromium, devices} = require(process.env.PLAYWRIGHT || 'playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.REDMINE_URL || 'http://localhost:3000';
const OUT = process.env.OUT_DIR || path.join(__dirname, 'out');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake_b1.js'), 'utf8');
// The QR decoder of the organikum_qr_scanner plugin, so labels are checked
// with the same code that will scan them.
const SCANNER = fs.readFileSync(process.env.HTML5_QRCODE, 'utf8');
fs.mkdirSync(OUT, {recursive: true});

let failures = 0;
function check(name, ok, extra) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra !== undefined ? ' — ' + JSON.stringify(extra) : ''}`);
  if (!ok) failures++;
}

async function login(page, user = 'admin', password = 'admin12345', base = BASE) {
  await page.goto(base + '/login');
  await page.fill('#username', user);
  await page.fill('#password', password);
  await page.click('#login-submit');
  await page.waitForLoadState('load');
}

// Rebuilds what the fake printer received as an image and decodes it with the
// same html5-qrcode the organikum_qr_scanner plugin uses.
async function decodePrinted(page, index) {
  return page.evaluate(async ([index, scanner]) => {
    const p = window.__fakeB1.pages[index];
    const c = document.createElement('canvas');
    const pad = 40;
    c.width = p.cols + 2 * pad; c.height = p.rows + 2 * pad;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#000';
    for (let y = 0; y < p.rows; y++) for (let x = 0; x < p.cols; x++) if (p.bits[y * p.cols + x]) ctx.fillRect(x + pad, y + pad, 1, 1);
    if (!window.Html5Qrcode) (0, eval)(scanner);
    let div = document.getElementById('qr-test');
    if (!div) { div = document.createElement('div'); div.id = 'qr-test'; div.style.display = 'none'; document.body.appendChild(div); }
    const blob = await new Promise((r) => c.toBlob(r));
    const text = await new Html5Qrcode('qr-test').scanFile(new File([blob], 'l.png', {type: 'image/png'}), false);
    return {text, rows: p.rows, cols: p.cols, png: c.toDataURL()};
  }, [index, SCANNER]);
}

function savePng(dataUrl, name) {
  fs.writeFileSync(path.join(OUT, name), Buffer.from(dataUrl.split(',')[1], 'base64'));
}

const fakeState = (page) => page.evaluate(() => ({chooser: window.__fakeB1.chooserCount, pages: window.__fakeB1.pages.length, density: window.__fakeB1.density}));
const statusText = (page) => page.textContent('.niimbot-sidebar .niimbot-status');
const waitStatus = (page, re) => page.waitForFunction(
  (src) => new RegExp(src).test(document.querySelector('.niimbot-sidebar .niimbot-status').textContent),
  re.source, {timeout: 15000});

(async () => {
  const browser = await chromium.launch();
  const errors = [];

  // ---- phone: the sidebar lives behind the hamburger button
  const phone = await browser.newContext({...devices['Pixel 7'], locale: 'ru-RU'});
  await phone.addInitScript(FAKE);
  const page = await phone.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page);

  await page.goto(BASE + '/issues/1');
  check('no label widget in the issue body any more', await page.locator('#content .niimbot-issue, #content canvas').count() === 0);
  await page.click('.js-flyout-menu-toggle-button');
  await page.waitForSelector('.flyout-menu .niimbot-sidebar .niimbot-print', {state: 'visible'});
  check('on a phone the button is in the hamburger menu', true);
  await page.screenshot({path: path.join(OUT, 'phone-menu.png')});
  await page.click('.flyout-menu .niimbot-print');
  await waitStatus(page, /Напечатано/);
  let fake = await fakeState(page);
  check('first press opens the chooser once and prints one label', fake.chooser === 1 && fake.pages === 1, fake);
  check('density from settings (3) is sent', fake.density === 3, fake.density);
  const decoded = await decodePrinted(page, 0);
  savePng(decoded.png, 'printed-issue-1.png');
  check('printed label is 384x240 dots (50x30 mm on a 48 mm head)', decoded.cols === 384 && decoded.rows === 240, [decoded.cols, decoded.rows]);
  check('QR on the printed label decodes to the issue URL', decoded.text === BASE + '/issues/1', decoded.text);
  check('status shows printer and battery', /B1-.*заряд 100%/.test(await statusText(page)), await statusText(page));
  await page.screenshot({path: path.join(OUT, 'phone-printed.png')});

  await page.click('.flyout-menu .niimbot-print');
  await page.waitForFunction(() => window.__fakeB1.pages.length === 2 && !window.NiimbotLabels.printer.busy, null, {timeout: 15000});
  check('second press on the same page reuses the connection', (await fakeState(page)).chooser === 1);

  await page.evaluate(() => window.__fakeB1.dropConnection());
  await waitStatus(page, /отключился/);
  check('dropped connection is reported', true, await statusText(page));
  await page.click('.flyout-menu .niimbot-print');
  await waitStatus(page, /Напечатано/);
  fake = await fakeState(page);
  check('after a drop the next press asks for the printer again', fake.chooser === 2 && fake.pages === 3, fake);

  await page.goto(BASE + '/issues/3');
  await page.click('.js-flyout-menu-toggle-button');
  await page.click('.flyout-menu .niimbot-print');
  await waitStatus(page, /Напечатано/);
  fake = await fakeState(page);
  check('another issue: new page, chooser again', fake.chooser === 1 && fake.pages === 1, fake);
  const third = await decodePrinted(page, 0);
  savePng(third.png, 'printed-issue-3.png');
  check('...and its own URL in the QR', third.text === BASE + '/issues/3', third.text);

  // ---- desktop: the regular sidebar
  const desktop = await browser.newContext({locale: 'ru-RU', viewport: {width: 1280, height: 900}});
  const dp = await desktop.newPage();
  dp.on('pageerror', (e) => errors.push(e.message));
  await login(dp);
  await dp.goto(BASE + '/issues/1');
  check('desktop: button in the sidebar', await dp.locator('#sidebar .niimbot-sidebar .niimbot-print').isVisible());
  await dp.screenshot({path: path.join(OUT, 'desktop-issue.png')});
  check('no host warning when host name matches', await dp.locator('.niimbot-warning').count() === 0);
  await dp.goto(BASE + '/projects/sklad/issues');
  check('not on issue lists (same sidebar)', await dp.locator('.niimbot-sidebar').count() === 0);
  await dp.goto(BASE + '/projects/sklad/issues/new');
  check('not on the new issue form', await dp.locator('.niimbot-sidebar').count() === 0);
  await dp.goto(BASE + '/projects/sklad');
  check('no project menu tab any more', await dp.locator('#main-menu a.niimbot-labels').count() === 0);
  let resp = await dp.goto(BASE + '/projects/sklad/niimbot_labels');
  check('old print page is gone', resp.status() === 404, resp.status());
  await dp.goto(BASE + '/projects/sklad/issues');
  await dp.check('tr#issue-1 input[type=checkbox]');
  await dp.click('tr#issue-1 td.status', {button: 'right'});
  await dp.waitForSelector('#context-menu ul');
  check('no context menu item any more', await dp.locator('#context-menu a[href*="niimbot"]').count() === 0);
  await dp.goto(BASE + '/issues/4');
  check('not in a project without the module', await dp.locator('.niimbot-sidebar').count() === 0);

  // Admins are told when QR codes would point elsewhere than this host.
  const viaIp = BASE.replace('localhost', '127.0.0.1');
  if (viaIp !== BASE) {
    const ipc = await browser.newContext({locale: 'ru-RU'});
    const ip = await ipc.newPage();
    await login(ip, 'admin', 'admin12345', viaIp);
    await ip.goto(viaIp + '/issues/1');
    check('admin sees host warning when opened via another host', await ip.locator('.niimbot-warning').count() === 1, await ip.locator('.niimbot-warning').textContent().catch(() => null));
    await ipc.close();
  }

  // ---- a member's access follows the role permission
  const member = await browser.newContext({locale: 'ru-RU'});
  const mp = await member.newPage();
  await login(mp, 'ivan', 'ivan12345');
  await mp.goto(BASE + '/issues/1');
  check('member with the permission sees the button', await mp.locator('.niimbot-sidebar').count() === 1);
  const setPermission = async (on) => {
    await dp.goto(BASE + '/roles');
    await dp.click('table.roles a:text("Разработчик")');
    const box = dp.locator('input[name="role[permissions][]"][value="print_issue_labels"]');
    if (on) await box.check(); else await box.uncheck();
    await dp.click('input[type=submit][name=commit]');
    await dp.waitForLoadState('load');
  };
  await setPermission(false);
  await mp.goto(BASE + '/issues/1');
  check('without the permission the button is gone', await mp.locator('.niimbot-sidebar').count() === 0);
  await setPermission(true);
  await mp.goto(BASE + '/issues/1');
  check('permission back, button back', await mp.locator('.niimbot-sidebar').count() === 1);

  // ---- browser without Web Bluetooth
  const plain = await browser.newContext({locale: 'ru-RU'});
  await plain.addInitScript(() => Object.defineProperty(navigator, 'bluetooth', {value: undefined}));
  const p2 = await plain.newPage();
  await login(p2);
  await p2.goto(BASE + '/issues/1');
  await p2.waitForFunction(() => document.querySelector('.niimbot-print').getAttribute('aria-disabled') === 'true');
  check('without Web Bluetooth the button is disabled with an explanation', true, await statusText(p2));

  // ---- script endpoint
  const anon = await browser.newContext();
  const a = await anon.newPage();
  resp = await a.goto(BASE + '/niimbot_labels/script?v=1');
  check('script is served to anyone, cacheable', resp.status() === 200 && /max-age=\d{8}, public/.test(resp.headers()['cache-control']), resp.headers()['cache-control']);

  check('no JS errors on pages', errors.length === 0, errors);
  await browser.close();
  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
