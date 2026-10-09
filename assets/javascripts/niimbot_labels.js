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
  function Printer() {
    this.client = null;
    this.state = {connected: false, name: '', battery: null, lidClosed: null, paper: null};
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
      self.state = {connected: false, name: '', battery: null, lidClosed: null, paper: null};
      self.emit('disconnect');
    });
    client.on('heartbeat', function (e) {
      var d = e.data || {};
      if (d.batteryPercents !== undefined) self.state.battery = d.batteryPercents;
      if (d.lidClosed !== undefined) self.state.lidClosed = d.lidClosed;
      if (d.paperInserted !== undefined) self.state.paper = d.paperInserted;
      self.emit('heartbeat');
    });

    var info = await client.connect();
    this.client = client;
    this.state.connected = true;
    this.state.name = info.deviceName || '';
    var printerInfo = client.getPrinterInfo();
    if (printerInfo.batteryPercents !== undefined) this.state.battery = printerInfo.batteryPercents;
    this.emit('connect');
  };

  Printer.prototype.disconnect = async function () {
    var client = this.client;
    if (!client) return;
    this.client = null;
    try { await client.disconnect(); } catch (e) { /* already gone */ }
    this.state = {connected: false, name: '', battery: null, lidClosed: null, paper: null};
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

  function describe(state, t) {
    var parts = [format(t.connected, {name: state.name || 'NIIMBOT'})];
    if (state.battery !== null) parts.push(format(t.battery, {n: state.battery}));
    if (state.lidClosed === false) parts.push(t.lid_open);
    if (state.paper === false) parts.push(t.no_paper);
    return parts.join(' · ');
  }

  // ---------------------------------------------------------------- sidebar

  // "Print label" in the issue sidebar. The first press on a freshly loaded
  // page opens Chrome's device chooser; later presses reuse the connection.
  // The click is delegated because on a phone Redmine moves the sidebar into
  // the hamburger menu.
  var printer = new Printer();

  function setStatus(box, text, isError) {
    var status = box.querySelector('.niimbot-status');
    status.textContent = text || '';
    status.classList.toggle('niimbot-error', !!isError);
  }

  function setBusy(box, busy) {
    var link = box.querySelector('.niimbot-print');
    if (busy) link.setAttribute('aria-disabled', 'true');
    else link.removeAttribute('aria-disabled');
  }

  async function printFrom(box) {
    var config = JSON.parse(box.getAttribute('data-config'));
    var label = JSON.parse(box.getAttribute('data-label'));
    var t = config.strings;
    if (printer.busy) return;
    setBusy(box, true);
    try {
      if (!printer.state.connected) {
        setStatus(box, t.connecting);
        await printer.connect();
      }
      setStatus(box, t.printing);
      var canvas = render(document.createElement('canvas'), label, config.settings, printer.meta());
      await printer.print([{canvas: canvas, quantity: 1}], config.settings.density);
      setStatus(box, t.printed + ' · ' + describe(printer.state, t));
    } catch (e) {
      setStatus(box, format(t.error, {message: (e && e.message) || String(e)}), true);
    } finally {
      setBusy(box, false);
    }
  }

  function init() {
    document.querySelectorAll('.niimbot-sidebar').forEach(function (box) {
      if (isSupported()) return;
      var t = JSON.parse(box.getAttribute('data-config')).strings;
      setBusy(box, true);
      setStatus(box, t.unsupported, true);
    });
    printer.onChange(function (state, event) {
      if (event !== 'disconnect' || printer.busy) return;
      document.querySelectorAll('.niimbot-sidebar').forEach(function (box) {
        setStatus(box, JSON.parse(box.getAttribute('data-config')).strings.disconnected);
      });
    });
  }

  document.addEventListener('click', function (e) {
    var link = e.target.closest && e.target.closest('.niimbot-print');
    if (!link) return;
    e.preventDefault();
    if (link.getAttribute('aria-disabled') === 'true') return;
    printFrom(link.closest('.niimbot-sidebar'));
  });

  window.NiimbotLabels = {render: render, canvasSize: canvasSize, Printer: Printer, printer: printer};

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
