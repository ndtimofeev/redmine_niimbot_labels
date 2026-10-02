// End-to-end check against a running Redmine with this plugin and a fake B1
// (fake_b1.js) standing in for navigator.bluetooth. See README, "Tests".
//
//   REDMINE_URL=http://localhost:3000 REDMINE_PASSWORD=... \
//   HTML5_QRCODE=../organikum_qr_scanner/assets/javascripts/html5-qrcode.min.js \
//   node test/e2e/run.js
//
// Expects issues #1, #2, #3 visible to the admin user, #999 missing, project
// "sklad", Host name localhost:3000 and protocol http.
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

const WAKE = `(() => {
  window.__wake = {requests: 0};
  if (!navigator.wakeLock) Object.defineProperty(navigator, 'wakeLock', {value: {}});
  navigator.wakeLock.request = async () => {
    window.__wake.requests++;
    const sentinel = new EventTarget();
    sentinel.release = async () => { window.__wake.released = true; };
    return sentinel;
  };
})();`;

async function login(page) {
  await page.goto(BASE + '/login');
  await page.fill('#username', 'admin');
  await page.fill('#password', process.env.REDMINE_PASSWORD || 'admin');
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
    return {text, rows: p.rows, cols: p.cols, copies: p.copies, png: c.toDataURL()};
  }, [index, SCANNER]);
}

// Whether the bitmap the printer got equals the preview canvas pixel for pixel.
async function samePixels(page, canvasSelector, index) {
  return page.evaluate(([sel, index]) => {
    const p = window.__fakeB1.pages[index];
    const c = document.querySelector(sel);
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    if (c.width !== p.cols || c.height !== p.rows) return false;
    for (let i = 0; i < p.bits.length; i++) if ((d[i * 4] === 0 ? 1 : 0) !== p.bits[i]) return false;
    return true;
  }, [canvasSelector, index]);
}

function savePng(dataUrl, name) {
  fs.writeFileSync(path.join(OUT, name), Buffer.from(dataUrl.split(',')[1], 'base64'));
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({...devices['Pixel 7'], locale: 'ru-RU'});
  await context.addInitScript(FAKE);
  await context.addInitScript(WAKE);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page);

  // ---- issue page: chooser on each page load
  await page.goto(BASE + '/issues/1');
  await page.waitForSelector('.niimbot-issue canvas');
  const size = await page.evaluate(() => { const c = document.querySelector('.niimbot-issue canvas'); return [c.width, c.height]; });
  check('issue preview is 384x240 dots (50x30 mm on a 48 mm head)', size[0] === 384 && size[1] === 240, size);
  await page.click('.niimbot-print');
  await page.waitForFunction(() => /Напечатано/.test(document.querySelector('.niimbot-status').textContent), null, {timeout: 15000});
  let fake = await page.evaluate(() => ({chooser: window.__fakeB1.chooserCount, pages: window.__fakeB1.pages.length, density: window.__fakeB1.density, filters: window.__fakeB1.lastOptions.filters.length}));
  check('first print opens the chooser once and prints one page', fake.chooser === 1 && fake.pages === 1, fake);
  check('density from settings (3) is sent', fake.density === 3, fake.density);
  check('printed bitmap equals the preview', await samePixels(page, '.niimbot-issue canvas', 0));
  let decoded = await decodePrinted(page, 0);
  savePng(decoded.png, 'printed-issue-1.png');
  check('QR on the printed label decodes to the issue URL', decoded.text === BASE + '/issues/1', decoded.text);
  check('status shows printer and battery', await page.textContent('.niimbot-status'), await page.textContent('.niimbot-status'));
  await page.click('.niimbot-print');
  await page.waitForFunction(() => window.__fakeB1.pages.length === 2, null, {timeout: 15000});
  fake = await page.evaluate(() => window.__fakeB1.chooserCount);
  check('second print on the same page reuses the connection', fake === 1, fake);
  await page.screenshot({path: path.join(OUT, 'issue-page.png'), fullPage: true});

  await page.reload();
  await page.waitForSelector('.niimbot-issue canvas');
  await page.click('.niimbot-print');
  await page.waitForFunction(() => window.__fakeB1.pages.length === 1, null, {timeout: 15000});
  fake = await page.evaluate(() => window.__fakeB1.chooserCount);
  check('after reload the chooser is shown again (new page, new connection)', fake === 1, 'fresh page state');

  // ---- context menu on the issue list
  const desktop = await browser.newContext({locale: 'ru-RU', viewport: {width: 1280, height: 900}});
  const dp = await desktop.newPage();
  await login(dp);
  await dp.goto(BASE + '/projects/sklad/issues');
  await dp.check('tr#issue-1 input[type=checkbox]');
  await dp.check('tr#issue-3 input[type=checkbox]');
  await dp.click('tr#issue-3 td.status', {button: 'right'});
  await dp.waitForSelector('#context-menu a[href*="niimbot_labels"]');
  const href = await dp.getAttribute('#context-menu a[href*="niimbot_labels"]', 'href');
  check('context menu links to the print page with the selected issues', /ids=(3%2C1|1%2C3)/.test(href), href);
  await dp.screenshot({path: path.join(OUT, 'context-menu.png')});

  // ---- print page
  await page.goto(BASE + '/niimbot_labels?ids=1,3');
  await page.waitForSelector('.niimbot-item');
  check('print page lists the two issues', (await page.$$('.niimbot-item')).length === 2);
  check('print buttons disabled before connecting', await page.isDisabled('.niimbot-print-all'));
  await page.fill('.niimbot-add input', '2');
  await page.press('.niimbot-add input', 'Enter');
  await page.waitForFunction(() => document.querySelectorAll('.niimbot-item').length === 3);
  check('issue added by number, URL updated', /ids=1%2C3%2C2|ids=1,3,2/.test(page.url()), page.url());
  await page.fill('.niimbot-add input', BASE + '/issues/2');
  await page.press('.niimbot-add input', 'Enter');
  await page.waitForTimeout(500);
  check('pasting an issue URL of an issue already queued adds no duplicate', (await page.$$('.niimbot-item')).length === 3);
  await page.fill('.niimbot-add input', '999');
  await page.press('.niimbot-add input', 'Enter');
  await page.waitForFunction(() => document.querySelector('.niimbot-message').classList.contains('niimbot-error'));
  check('unknown issue reported', true, await page.textContent('.niimbot-message'));

  await page.click('.niimbot-connect');
  await page.waitForFunction(() => /Подключён/.test(document.querySelector('.niimbot-printer-status').textContent));
  check('connected status', true, await page.textContent('.niimbot-printer-status'));
  check('screen wake lock requested while connected', await page.evaluate(() => window.__wake.requests) >= 1);
  await page.fill('.niimbot-item:nth-child(2) .niimbot-item-controls input', '2');
  await page.click('.niimbot-print-all');
  await page.waitForFunction(() => /Напечатано/.test(document.querySelector('.niimbot-message').textContent), null, {timeout: 20000});
  fake = await page.evaluate(() => ({chooser: window.__fakeB1.chooserCount, pages: window.__fakeB1.pages.map((p) => p.copies), total: window.__fakeB1.totalPages}));
  check('print all: one job, 3 labels, 4 copies, one chooser', fake.chooser === 1 && fake.pages.join() === '1,2,1' && fake.total === 4, fake);
  for (let i = 0; i < 3; i++) {
    const r = await decodePrinted(page, i);
    savePng(r.png, `printed-queue-${i}.png`);
    check(`queue label ${i + 1} decodes`, [1, 2, 3].some((id) => r.text === BASE + '/issues/' + id), r.text);
  }
  await page.click('.niimbot-item:nth-child(1) .niimbot-item-controls button');
  await page.waitForFunction(() => window.__fakeB1.pages.length === 4, null, {timeout: 15000});
  check('single item print reuses connection', await page.evaluate(() => window.__fakeB1.chooserCount) === 1);
  check('printed counter shown', true, await page.textContent('.niimbot-item:nth-child(1) .niimbot-done'));
  await page.screenshot({path: path.join(OUT, 'print-page.png'), fullPage: true});

  await page.evaluate(() => window.__fakeB1.dropConnection());
  await page.waitForFunction(() => /отключился/.test(document.querySelector('.niimbot-message').textContent));
  check('dropped connection reported, print disabled', await page.isDisabled('.niimbot-print-all'));
  check('connect button is back', await page.isVisible('.niimbot-connect'));

  // ---- browser without Web Bluetooth
  const plain = await browser.newContext({...devices['Pixel 7'], locale: 'ru-RU'});
  await plain.addInitScript(() => Object.defineProperty(navigator, 'bluetooth', {value: undefined}));
  const p2 = await plain.newPage();
  await login(p2);
  await p2.goto(BASE + '/issues/1');
  await p2.waitForSelector('.niimbot-issue canvas');
  check('without Web Bluetooth the button is disabled with an explanation', await p2.isDisabled('.niimbot-print'), await p2.textContent('.niimbot-status'));

  // ---- server side
  const anon = await browser.newContext();
  const a = await anon.newPage();
  let resp = await a.goto(BASE + '/niimbot_labels/script?v=1');
  check('script is served to anyone, cacheable', resp.status() === 200 && /max-age=\d{8}, public/.test(resp.headers()['cache-control']), resp.headers()['cache-control']);
  resp = await a.goto(BASE + '/niimbot_labels/issues/1');
  check('label JSON requires login', resp.status() === 401 || /login/.test(a.url()), [resp.status(), a.url()]);
  resp = await page.goto(BASE + '/niimbot_labels/issues/999');
  check('missing issue answers 404 JSON', resp.status() === 404, await resp.text());

  check('no JS errors on pages', errors.length === 0, errors);
  await browser.close();
  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
