// End-to-end check against a running Redmine with this plugin and a fake B1
// (fake_b1.js) standing in for navigator.bluetooth. See README, "Tests".
//
//   bin/rails runner plugins/redmine_niimbot_labels/test/e2e/seed.rb
//   REDMINE_URL=http://localhost:3000 \
//   HTML5_QRCODE=../organikum_qr_scanner/assets/javascripts/html5-qrcode.min.js \
//   node plugins/redmine_niimbot_labels/test/e2e/run.js
//
// Uses the data seed.rb creates: project "sklad" with the module (#1-#3),
// "office" without it (#4), admin/admin12345 and ivan/ivan12345 (Developer),
// and the "Название для этикетки" field filled on #2 and chosen as the title.
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

const fakeState = (page) => page.evaluate(() => ({
  chooser: window.__fakeB1.chooserCount, pages: window.__fakeB1.pages.map((p) => p.copies),
  total: window.__fakeB1.totalPages, density: window.__fakeB1.density}));
const dialog = '.ui-dialog:has(#niimbot-modal)';
const text = (page, sel) => page.textContent('#niimbot-modal ' + sel).then((s) => s.trim());
const waitMessage = (page, re) => page.waitForFunction(
  (src) => new RegExp(src).test(document.querySelector('#niimbot-modal .niimbot-message').textContent),
  re.source, {timeout: 15000});
const idle = (page) => page.waitForFunction(() => !window.NiimbotLabels.printer.busy &&
  !document.querySelector('#niimbot-modal .niimbot-print').disabled, null, {timeout: 15000});

(async () => {
  const browser = await chromium.launch();
  const errors = [];

  // ---- phone: the link lives behind the hamburger button, the dialog on top
  const phone = await browser.newContext({...devices['Pixel 7'], locale: 'ru-RU'});
  await phone.addInitScript(FAKE);
  const page = await phone.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page);

  await page.goto(BASE + '/issues/1');
  check('no label widget in the issue body', await page.locator('#content .niimbot-issue, #content canvas').count() === 0);
  await page.click('.js-flyout-menu-toggle-button');
  await page.waitForSelector('.flyout-menu .niimbot-open', {state: 'visible'});
  await page.screenshot({path: path.join(OUT, 'phone-menu.png')});
  await page.click('.flyout-menu .niimbot-open');
  await page.waitForSelector(dialog, {state: 'visible'});
  check('the link opens the dialog and closes the hamburger menu',
        !(await page.evaluate(() => document.documentElement.classList.contains('flyout-is-active'))));
  check('dialog title names the issue', /#1/.test(await page.textContent(dialog + ' .ui-dialog-title')), await page.textContent(dialog + ' .ui-dialog-title'));
  check('printer shown as not connected, details hidden',
        (await text(page, '.niimbot-name')) === 'не подключён' && !(await page.isVisible('#niimbot-modal .niimbot-battery')));
  const box = await page.locator(dialog).boundingBox();
  check('dialog fits the phone screen', box.width <= devices['Pixel 7'].viewport.width, box);
  await page.screenshot({path: path.join(OUT, 'phone-dialog-disconnected.png')});

  await page.click('#niimbot-modal .niimbot-minus');
  check('copies never go below 1', (await page.inputValue('#niimbot-copies')) === '1');
  await page.click('#niimbot-modal .niimbot-plus');
  await page.click('#niimbot-modal .niimbot-plus');
  check('plus button counts up', (await page.inputValue('#niimbot-copies')) === '3');
  await page.click('#niimbot-modal .niimbot-print');
  await waitMessage(page, /Напечатано: 3/);
  await idle(page);
  let fake = await fakeState(page);
  check('"Print" connects (chooser once) and prints 3 copies in one job', fake.chooser === 1 && fake.pages.join() === '3' && fake.total === 3, fake);
  check('density from settings (3) is sent', fake.density === 3, fake.density);
  const decoded = await decodePrinted(page, 0);
  savePng(decoded.png, 'printed-issue-1.png');
  check('printed label is 384x240 dots (50x30 mm on a 48 mm head)', decoded.cols === 384 && decoded.rows === 240, [decoded.cols, decoded.rows]);
  check('QR on the printed label decodes to the issue URL', decoded.text === BASE + '/issues/1', decoded.text);
  const state = {
    name: await text(page, '.niimbot-name'), battery: await text(page, '.niimbot-battery'),
    lid: await text(page, '.niimbot-lid'), paper: await text(page, '.niimbot-paper')};
  check('printer state: name, battery, lid, labels left', /^B1-/.test(state.name) && /%$/.test(state.battery) &&
        /закрыта|открыта/.test(state.lid) && /осталось \d+ из \d+|вставлены|нет/.test(state.paper), state);
  check('"Cancel" turned into "Close"', (await text(page, '.niimbot-close')) === 'Закрыть');
  await page.screenshot({path: path.join(OUT, 'phone-dialog-printed.png')});

  await page.click('#niimbot-modal .niimbot-close');
  check('"Close" closes the dialog', !(await page.isVisible(dialog)));
  await page.click('.js-flyout-menu-toggle-button');
  await page.click('.flyout-menu .niimbot-open');
  await page.waitForSelector(dialog, {state: 'visible'});
  check('reopened dialog: still connected, message cleared, "Cancel" again',
        /^B1-/.test(await text(page, '.niimbot-name')) && (await text(page, '.niimbot-message')) === '' &&
        (await text(page, '.niimbot-close')) === 'Отмена');
  await page.fill('#niimbot-copies', '150');
  await page.click('#niimbot-modal .niimbot-print');
  await waitMessage(page, /Напечатано: 99/);
  await idle(page);
  fake = await fakeState(page);
  check('typed 150 is clamped to 99, no chooser on reprint', fake.chooser === 1 && fake.pages.join() === '3,99', fake);

  await page.evaluate(() => window.__fakeB1.dropConnection());
  await waitMessage(page, /отключился/);
  check('dropped connection: reported, "Connect" back, details hidden',
        await page.isVisible('#niimbot-modal .niimbot-connect') && !(await page.isVisible('#niimbot-modal .niimbot-battery')));
  await page.evaluate(() => { window.__fakeB1.cancelChooser = true; });
  await page.click('#niimbot-modal .niimbot-connect');
  await waitMessage(page, /не выбран/);
  check('closing the chooser says "no printer chosen"', true, await text(page, '.niimbot-message'));
  await page.click('#niimbot-modal .niimbot-connect');
  await page.waitForFunction(() => /^B1-/.test(document.querySelector('#niimbot-modal .niimbot-name').textContent));
  check('"Connect" alone connects without printing', (await fakeState(page)).pages.length === 2);
  await page.screenshot({path: path.join(OUT, 'phone-dialog-connected.png')});

  // Label data: title from the chosen field when filled, subject otherwise;
  // creation date in Redmine's format for the user (Russian: dd.mm.yyyy).
  const labelData = (id) => page.goto(BASE + '/issues/' + id).then(() =>
    page.evaluate(() => JSON.parse(document.getElementById('niimbot-modal').getAttribute('data-label'))));
  let data = await labelData(1);
  check('title is the subject when the field is empty', data.title === 'Осциллограф Tektronix TDS2012C, инв. 0451', data.title);
  check('creation date in the user\'s format', /^\d\d\.\d\d\.\d{4}$/.test(data.date), data.date);
  data = await labelData(2);
  check('title comes from the chosen custom field when filled', data.title === 'Паяльная станция Hakko FX-888D, стол 3', data.title);

  await page.goto(BASE + '/issues/3');
  await page.click('.js-flyout-menu-toggle-button');
  await page.click('.flyout-menu .niimbot-open');
  await page.click('#niimbot-modal .niimbot-print');
  await waitMessage(page, /Напечатано: 1/);
  fake = await fakeState(page);
  check('another issue: new page, chooser again', fake.chooser === 1 && fake.pages.join() === '1', fake);
  const third = await decodePrinted(page, 0);
  savePng(third.png, 'printed-issue-3.png');
  check('...and its own URL in the QR', third.text === BASE + '/issues/3', third.text);

  // ---- desktop: the regular sidebar
  const desktop = await browser.newContext({locale: 'ru-RU', viewport: {width: 1280, height: 900}});
  const dp = await desktop.newPage();
  dp.on('pageerror', (e) => errors.push(e.message));
  await login(dp);
  await dp.goto(BASE + '/issues/1');
  check('desktop: link in the sidebar', await dp.locator('#sidebar .niimbot-sidebar .niimbot-open').isVisible());
  await dp.click('#sidebar .niimbot-open');
  await dp.waitForSelector(dialog, {state: 'visible'});
  await dp.screenshot({path: path.join(OUT, 'desktop-dialog.png')});
  await dp.keyboard.press('Escape');
  check('Escape closes the dialog', !(await dp.isVisible(dialog)));
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

  // ---- plugin settings offer string and text fields for the title
  await dp.goto(BASE + '/settings/plugin/redmine_niimbot_labels');
  const options = await dp.locator('#settings_title_field_id option').allTextContents();
  check('settings: title field select lists "Issue subject" and the text field',
        options[0] === 'Тема задачи' && options.includes('Название для этикетки'), options);
  check('settings: the configured field is selected',
        (await dp.locator('#settings_title_field_id option:checked').textContent()) === 'Название для этикетки');

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
  await p2.click('#sidebar .niimbot-open');
  await p2.waitForSelector(dialog, {state: 'visible'});
  check('without Web Bluetooth: "Print" and "Connect" disabled, with an explanation',
        await p2.isDisabled('#niimbot-modal .niimbot-print') && await p2.isDisabled('#niimbot-modal .niimbot-connect') &&
        /недоступна/.test(await text(p2, '.niimbot-message')), await text(p2, '.niimbot-message'));

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
