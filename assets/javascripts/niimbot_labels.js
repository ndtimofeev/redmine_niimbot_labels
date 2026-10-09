/* Niimbot Labels for Redmine: draws issue labels and prints them on a
 * NIIMBOT B1 over Web Bluetooth, using niimbluelib (loaded right before
 * this file, as the global `niimbluelib`). */
(function () {
  'use strict';

  var lib = window.niimbluelib;
  var DOTS_PER_MM = 8;          // 203 dpi
  var DEFAULT_HEAD_DOTS = 384;  // B1 print head, 48 mm
  var DEFAULT_DIRECTION = 'top';

  function format(template, values) {
    return String(template).replace(/%\{(\w+)\}/g, function (_, key) {
      return values && key in values ? values[key] : '';
    });
  }

  function isSupported() {
    return !!(window.isSecureContext && navigator.bluetooth && lib);
  }

  // ---------------------------------------------------------------- drawing

  // Canvas size in printer dots. The side that runs across the print head
  // is cut to the head width: a 50 mm label on a 48 mm head prints its
  // middle 48 mm.
  function canvasSize(settings, meta) {
    var head = (meta && meta.printheadPixels) || DEFAULT_HEAD_DOTS;
    var direction = (meta && meta.printDirection) || DEFAULT_DIRECTION;
    var width = Math.round(settings.width_mm * DOTS_PER_MM);
    var height = Math.round(settings.height_mm * DOTS_PER_MM);
    if (direction === 'top') width = Math.min(width, head);
    else height = Math.min(height, head);
    return {width: width, height: height};
  }

  // Lines of text that fit into maxWidth; overlong words are cut by letters.
  function wrap(ctx, text, maxWidth) {
    var lines = [];
    var line = '';
    String(text).split(/\s+/).forEach(function (word) {
      if (!word) return;
      var candidate = line ? line + ' ' + word : word;
      if (ctx.measureText(candidate).width <= maxWidth) {
        line = candidate;
        return;
      }
      if (line) lines.push(line);
      line = '';
      while (ctx.measureText(word).width > maxWidth && word.length > 1) {
        var n = word.length - 1;
        while (n > 1 && ctx.measureText(word.slice(0, n)).width > maxWidth) n--;
        lines.push(word.slice(0, n));
        word = word.slice(n);
      }
      line = word;
    });
    if (line) lines.push(line);
    return lines;
  }

  // The printer has no grey: every pixel that is not pure white is burnt
  // black. Thresholding here keeps text crisp and makes the preview show
  // exactly what will be printed.
  function threshold(ctx, width, height) {
    var image = ctx.getImageData(0, 0, width, height);
    var d = image.data;
    for (var i = 0; i < d.length; i += 4) {
      var dark = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114 < 160;
      d[i] = d[i + 1] = d[i + 2] = dark ? 0 : 255;
      d[i + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
  }

  // QR code on the left, as large as the label height allows; issue number
  // and (optionally) subject to the right of it.
  function render(canvas, label, settings, meta) {
    var size = canvasSize(settings, meta);
    var W = canvas.width = size.width;
    var H = canvas.height = size.height;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#000';

    var n = label.qr.length;
    var margin = Math.round(1.5 * DOTS_PER_MM);
    var short = Math.min(W, H);
    // Whole dots per module, with a quiet zone of at least two modules.
    var module = Math.max(1, Math.min(Math.floor(short / (n + 4)), Math.floor((short - 2 * margin) / n)));
    var qrSize = module * n;
    var qrY = Math.floor((H - qrSize) / 2);
    var qrX = Math.min(qrY, Math.floor((W - qrSize) / 2));
    label.qr.forEach(function (row, y) {
      for (var x = 0; x < row.length; x++) {
        if (row.charAt(x) === '1') ctx.fillRect(qrX + x * module, qrY + y * module, module, module);
      }
    });

    var textX = qrX + qrSize + Math.max(2 * module, margin);
    var textWidth = W - textX - margin;
    if (textWidth >= 5 * DOTS_PER_MM) {
      ctx.textBaseline = 'top';
      var numberText = '#' + label.id;
      var numberSize = Math.floor(H / 4);
      ctx.font = 'bold ' + numberSize + 'px sans-serif';
      while (numberSize > 12 && ctx.measureText(numberText).width > textWidth) {
        numberSize -= 2;
        ctx.font = 'bold ' + numberSize + 'px sans-serif';
      }
      var y = margin;
      ctx.fillText(numberText, textX, y);
      y += Math.round(numberSize * 1.25);

      if (settings.show_subject && label.subject) {
        // Shrink the font until the longest word fits, so words are only
        // cut when even the smallest size is too wide.
        var fontSize = Math.max(16, Math.round(H / 11));
        var longest = String(label.subject).split(/\s+/).reduce(function (a, b) { return b.length > a.length ? b : a; }, '');
        ctx.font = fontSize + 'px sans-serif';
        while (fontSize > 16 && ctx.measureText(longest).width > textWidth) {
          fontSize--;
          ctx.font = fontSize + 'px sans-serif';
        }
        var lineHeight = Math.round(fontSize * 1.2);
        var maxLines = Math.floor((H - margin - y) / lineHeight);
        var lines = wrap(ctx, label.subject, textWidth);
        if (lines.length > maxLines && maxLines > 0) {
          lines = lines.slice(0, maxLines);
          var last = lines[maxLines - 1];
          while (last.length > 1 && ctx.measureText(last + '…').width > textWidth) last = last.slice(0, -1);
          lines[maxLines - 1] = last + '…';
        }
        lines.slice(0, Math.max(maxLines, 0)).forEach(function (line, i) {
          ctx.fillText(line, textX, y + i * lineHeight);
        });
      }
    }

    threshold(ctx, W, H);
    return canvas;
  }

  // ---------------------------------------------------------------- printer

  // One Bluetooth connection to the printer. It lives as long as the page:
  // Redmine reloads the page on every click, so after moving to another issue
  // the printer has to be picked again.
  function emptyState() {
    return {connected: false, name: '', battery: null, lidClosed: null, paper: null, labelsLeft: null, labelsAll: null};
  }

  function Printer() {
    this.client = null;
    this.state = emptyState();
    this.listeners = [];
    this.busy = false;
  }

  Printer.prototype.onChange = function (fn) {
    this.listeners.push(fn);
  };

  Printer.prototype.emit = function (event) {
    var self = this;
    this.listeners.forEach(function (fn) { fn(self.state, event); });
  };

  Printer.prototype.meta = function () {
    return this.client && this.client.isConnected() ? this.client.getModelMetadata() : null;
  };

  // Shows Chrome's device chooser, so it must be called from a click handler.
  Printer.prototype.connect = async function () {
    await this.disconnect();
    var self = this;
    var client = lib.instantiateClient('bluetooth');

    client.on('disconnect', function () {
      if (self.client !== client) return;
      self.client = null;
      self.state = emptyState();
      self.emit('disconnect');
    });
    client.on('heartbeat', function (e) {
      var d = e.data || {};
      if (d.batteryPercents !== undefined) self.state.battery = d.batteryPercents;
      if (d.lidClosed !== undefined) self.state.lidClosed = d.lidClosed;
      if (d.paperInserted !== undefined) self.state.paper = d.paperInserted;
      self.emit('heartbeat');
    });
    // Read from the RFID tag of the label roll on connect and after printing.
    client.on('rfidinfofetched', function (e) {
      var r = e.info && e.info.labelRfidInfo;
      if (r && r.tagPresent && r.allPaper > 0) {
        self.state.labelsAll = r.allPaper;
        self.state.labelsLeft = Math.max(r.allPaper - r.usedPaper, 0);
      } else {
        self.state.labelsAll = self.state.labelsLeft = null;
      }
      self.emit('rfid');
    });

    var info = await client.connect();
    this.client = client;
    this.state.connected = true;
    this.state.name = info.deviceName || '';
    var printerInfo = client.getPrinterInfo();
    if (printerInfo.batteryPercents !== undefined) this.state.battery = printerInfo.batteryPercents;
    this.emit('connect');
    // Lid and labels come with the heartbeat, polled every 2 s; ask once now
    // so the dialog shows them right away.
    await client.fetchHeartbeatData();
  };

  Printer.prototype.disconnect = async function () {
    var client = this.client;
    if (!client) return;
    this.client = null;
    try { await client.disconnect(); } catch (e) { /* already gone */ }
    this.state = emptyState();
    this.emit('disconnect');
  };

  // pages: [{canvas, quantity}]. One print job for all of them, the way
  // NiimBlue does it; heartbeat polling is paused meanwhile.
  Printer.prototype.print = async function (pages, density, onProgress) {
    var client = this.client;
    if (!client || !client.isConnected()) throw new Error('not connected');
    if (this.busy) throw new Error('busy');
    this.busy = true;

    var meta = client.getModelMetadata();
    var direction = (meta && meta.printDirection) || DEFAULT_DIRECTION;
    if (meta) density = Math.min(Math.max(density, meta.densityMin), meta.densityMax);
    var total = pages.reduce(function (sum, page) { return sum + page.quantity; }, 0);
    var color = lib.PageColorType.SingleColor;

    var progress = function (e) { if (onProgress) onProgress(Math.min(e.page, total), total); };
    client.stopHeartbeat();
    client.on('printprogress', progress);
    var task = client.protocol.newPrintTask(client.getPrintTaskType() || 'B1', {
      totalPages: total,
      density: density,
      pageColor: color,
      statusPollIntervalMs: 100,
      statusTimeoutMs: 8000
    });

    try {
      await task.printInit();
      for (var i = 0; i < pages.length; i++) {
        var encoded = lib.ImageEncoder.encodeCanvas(pages[i].canvas, color, direction);
        await task.printPage(encoded, pages[i].quantity);
        await task.waitForPageFinished();
      }
      await task.waitForFinished();
    } finally {
      try {
        if (client.isConnected()) await task.printEnd();
      } catch (e) {
        console.warn('niimbot_labels: printEnd failed', e);
      }
      client.off('printprogress', progress);
      if (client.isConnected()) client.startHeartbeat();
      this.busy = false;
    }
  };

  // ------------------------------------------------------------------ dialog

  // "Print label…" in the issue sidebar opens a dialog (Redmine's own
  // showModal) with the printer state, the number of copies and "Print".
  // The printer stays connected while the page is open, so reopening the
  // dialog does not ask for it again.
  var printer = new Printer();
  var modal = null;

  function $q(selector) { return modal.el.querySelector(selector); }

  function message(text, isError) {
    var el = $q('.niimbot-message');
    el.textContent = text || '';
    el.classList.toggle('niimbot-error', !!isError);
  }

  function copies() {
    var n = parseInt($q('#niimbot-copies').value, 10);
    return isNaN(n) ? 1 : Math.min(Math.max(n, 1), 99);
  }

  function cell(selector, text, bad) {
    var el = $q(selector);
    el.textContent = text;
    el.classList.toggle('niimbot-bad', !!bad);
  }

  function refresh() {
    if (!modal) return;
    var t = modal.t, s = printer.state, connected = s.connected;
    cell('.niimbot-name', connected ? (s.name || 'NIIMBOT') : t.not_connected, false);
    $q('.niimbot-connect').hidden = connected;
    $q('.niimbot-disconnect').hidden = !connected;
    modal.el.querySelectorAll('.niimbot-connected-only').forEach(function (row) { row.hidden = !connected; });
    if (connected) {
      cell('.niimbot-battery', s.battery === null ? t.unknown : s.battery + '%', s.battery !== null && s.battery <= 25);
      cell('.niimbot-lid', s.lidClosed === null ? t.unknown : (s.lidClosed ? t.lid_closed : t.lid_open), s.lidClosed === false);
      var paper = t.unknown;
      if (s.paper === false) paper = t.paper_out;
      else if (s.labelsLeft !== null) paper = format(t.paper_left, {left: s.labelsLeft, all: s.labelsAll});
      else if (s.paper === true) paper = t.paper_in;
      cell('.niimbot-paper', paper, s.paper === false || s.labelsLeft === 0);
    }
    var supported = isSupported();
    $q('.niimbot-connect').disabled = !supported || modal.working;
    $q('.niimbot-print').disabled = !supported || modal.working;
    $q('.niimbot-disconnect').disabled = modal.working;
  }

  function errorText(t, e) {
    if (e && e.name === 'NotFoundError') return t.not_chosen;  // chooser closed
    return format(t.error, {message: (e && e.message) || String(e)});
  }

  async function connect() {
    var t = modal.t;
    modal.working = true;
    message(t.connecting);
    refresh();
    try {
      await printer.connect();
      message('');
    } catch (e) {
      message(errorText(t, e), true);
    } finally {
      modal.working = false;
      refresh();
    }
  }

  async function print() {
    var t = modal.t, n = copies();
    $q('#niimbot-copies').value = n;
    if (!printer.state.connected) {
      await connect();
      if (!printer.state.connected) return;
    }
    modal.working = true;
    message(format(t.printing, {done: 0, total: n}));
    refresh();
    try {
      var canvas = render(document.createElement('canvas'), modal.label, modal.config.settings, printer.meta());
      await printer.print([{canvas: canvas, quantity: n}], modal.config.settings.density, function (done, total) {
        message(format(t.printing, {done: done, total: total}));
      });
      message(format(t.printed, {n: n}));
      $q('.niimbot-close').textContent = t.close;
    } catch (e) {
      message(errorText(t, e), true);
    } finally {
      modal.working = false;
      refresh();
    }
  }

  function setUp(el) {
    var config = JSON.parse(el.getAttribute('data-config'));
    modal = {el: el, config: config, t: config.strings, label: JSON.parse(el.getAttribute('data-label')), working: false};
    var input = $q('#niimbot-copies');
    $q('.niimbot-minus').addEventListener('click', function () { input.value = Math.max(copies() - 1, 1); });
    $q('.niimbot-plus').addEventListener('click', function () { input.value = Math.min(copies() + 1, 99); });
    input.addEventListener('change', function () { input.value = copies(); });
    $q('.niimbot-connect').addEventListener('click', connect);
    $q('.niimbot-disconnect').addEventListener('click', function () { printer.disconnect(); });
    $q('.niimbot-print').addEventListener('click', print);
    // hideModal looks for the dialog among the parents of what it is given.
    $q('.niimbot-close').addEventListener('click', function () { window.hideModal($q('.niimbot-close')); });
    printer.onChange(function (state, event) {
      if (event === 'disconnect' && !modal.working) message(modal.t.disconnected, true);
      refresh();
    });
  }

  function open() {
    if (!modal) return;
    // On a phone the link sits in the hamburger menu; close it first.
    if (typeof window.closeFlyout === 'function') window.closeFlyout();
    if (!modal.working) {
      message(isSupported() ? '' : modal.t.unsupported, !isSupported());
      $q('.niimbot-close').textContent = modal.t.cancel;
    }
    refresh();
    window.showModal('niimbot-modal', '420px');
  }

  document.addEventListener('click', function (e) {
    var link = e.target.closest && e.target.closest('.niimbot-open');
    if (!link) return;
    e.preventDefault();
    open();
  });

  function init() {
    var el = document.getElementById('niimbot-modal');
    if (el) setUp(el);
  }

  window.NiimbotLabels = {render: render, canvasSize: canvasSize, Printer: Printer, printer: printer};

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
