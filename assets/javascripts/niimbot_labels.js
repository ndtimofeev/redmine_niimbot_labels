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

  // One Bluetooth connection to the printer. The connection lives as long as
  // the page: Redmine reloads the page on every click, so on the issue page
  // the printer has to be picked again after each navigation, while the
  // print page keeps it for a whole session.
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
    if (!state.connected) return t.not_connected;
    var parts = [format(t.connected, {name: state.name || 'NIIMBOT'})];
    if (state.battery !== null) parts.push(format(t.battery, {n: state.battery}));
    if (state.lidClosed === false) parts.push(t.lid_open);
    if (state.paper === false) parts.push(t.no_paper);
    return parts.join(' · ');
  }

  function errorText(t, e) {
    return format(t.error, {message: (e && e.message) || String(e)});
  }

  // Keeps the screen on while a printer is connected: Android freezes a page
  // with the screen off, and the Bluetooth connection goes with it.
  function keepScreenOn(printer) {
    var lock = null;
    async function update() {
      try {
        if (printer.state.connected && document.visibilityState === 'visible' && !lock && navigator.wakeLock) {
          lock = await navigator.wakeLock.request('screen');
          lock.addEventListener('release', function () { lock = null; });
        } else if (!printer.state.connected && lock) {
          await lock.release();
          lock = null;
        }
      } catch (e) {
        lock = null;
      }
    }
    printer.onChange(update);
    document.addEventListener('visibilitychange', update);
  }

  // ------------------------------------------------------------ issue page

  // A button under the issue attributes. The first press on a freshly loaded
  // page opens the device chooser; later presses on the same page reuse the
  // connection.
  function initIssueWidget(root) {
    var config = JSON.parse(root.getAttribute('data-config'));
    var label = JSON.parse(root.getAttribute('data-label'));
    var t = config.strings;
    var canvas = root.querySelector('canvas');
    var button = root.querySelector('.niimbot-print');
    var status = root.querySelector('.niimbot-status');
    var printer = new Printer();

    render(canvas, label, config.settings, null);
    if (!isSupported()) {
      button.disabled = true;
      status.textContent = t.unsupported;
      return;
    }
    printer.onChange(function (state, event) {
      if (event === 'disconnect' && !button.disabled) status.textContent = t.disconnected;
    });

    button.addEventListener('click', async function () {
      button.disabled = true;
      try {
        if (!printer.state.connected) {
          status.textContent = t.connecting;
          await printer.connect();
          render(canvas, label, config.settings, printer.meta());
        }
        status.textContent = format(t.printing, {done: 0, total: 1});
        await printer.print([{canvas: canvas, quantity: 1}], config.settings.density);
        status.textContent = t.printed + ' · ' + describe(printer.state, t);
      } catch (e) {
        status.textContent = errorText(t, e);
      } finally {
        button.disabled = false;
      }
    });
  }

  // ------------------------------------------------------------ print page

  function initPrintPage(root) {
    var config = JSON.parse(root.getAttribute('data-config'));
    var t = config.strings;
    var labelUrl = root.getAttribute('data-label-url');
    var printer = new Printer();
    var queue = [];

    var statusEl = root.querySelector('.niimbot-printer-status');
    var messageEl = root.querySelector('.niimbot-message');
    var connectBtn = root.querySelector('.niimbot-connect');
    var disconnectBtn = root.querySelector('.niimbot-disconnect');
    var printAllBtn = root.querySelector('.niimbot-print-all');
    var list = root.querySelector('.niimbot-queue');
    var emptyEl = root.querySelector('.niimbot-empty');
    var form = root.querySelector('.niimbot-add');
    var input = form.querySelector('input');

    function message(text, isError) {
      messageEl.textContent = text || '';
      messageEl.className = 'niimbot-message' + (isError ? ' niimbot-error' : '');
    }

    function syncUrl() {
      var url = new URL(window.location.href);
      if (queue.length) url.searchParams.set('ids', queue.map(function (item) { return item.label.id; }).join(','));
      else url.searchParams.delete('ids');
      window.history.replaceState(null, '', url.toString());
    }

    function refresh() {
      var connected = printer.state.connected;
      statusEl.textContent = describe(printer.state, t);
      connectBtn.hidden = connected;
      disconnectBtn.hidden = !connected;
      printAllBtn.disabled = !connected || printer.busy || !queue.length;
      emptyEl.hidden = queue.length > 0;
      queue.forEach(function (item) {
        item.printBtn.disabled = !connected || printer.busy;
      });
    }

    function rerender() {
      var meta = printer.meta();
      queue.forEach(function (item) { render(item.canvas, item.label, config.settings, meta); });
    }

    function addLabel(label) {
      if (queue.some(function (item) { return item.label.id === label.id; })) return;
      var li = document.createElement('li');
      li.className = 'niimbot-item';
      var canvas = document.createElement('canvas');
      canvas.className = 'niimbot-preview';
      var info = document.createElement('div');
      info.className = 'niimbot-item-info';
      var title = document.createElement('a');
      title.href = label.url;
      title.textContent = '#' + label.id + ' ' + label.subject;
      var done = document.createElement('span');
      done.className = 'niimbot-done';
      var controls = document.createElement('div');
      controls.className = 'niimbot-item-controls';
      var qtyLabel = document.createElement('label');
      qtyLabel.textContent = t.quantity + ' ';
      var qty = document.createElement('input');
      qty.type = 'number';
      qty.min = '1';
      qty.max = '99';
      qty.value = '1';
      qty.inputMode = 'numeric';
      qtyLabel.appendChild(qty);
      var printBtn = document.createElement('button');
      printBtn.type = 'button';
      printBtn.textContent = t.print;
      var removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'niimbot-remove';
      removeBtn.textContent = t.remove;
      controls.append(qtyLabel, printBtn, removeBtn);
      info.append(title, done, controls);
      li.append(canvas, info);
      list.appendChild(li);

      var item = {label: label, canvas: canvas, li: li, qty: qty, printBtn: printBtn, done: done, printed: 0};
      render(canvas, label, config.settings, printer.meta());
      printBtn.addEventListener('click', function () { printItems([item]); });
      removeBtn.addEventListener('click', function () {
        queue = queue.filter(function (other) { return other !== item; });
        li.remove();
        syncUrl();
        refresh();
      });
      queue.push(item);
    }

    function quantity(item) {
      var n = parseInt(item.qty.value, 10);
      return n >= 1 && n <= 99 ? n : 1;
    }

    async function printItems(items) {
      if (!items.length || printer.busy) return;
      var pages = items.map(function (item) { return {canvas: item.canvas, quantity: quantity(item)}; });
      var total = pages.reduce(function (sum, page) { return sum + page.quantity; }, 0);
      message(format(t.printing, {done: 0, total: total}));
      var job = printer.print(pages, config.settings.density, function (done, all) {
        message(format(t.printing, {done: done, total: all}));
      });
      refresh();
      try {
        await job;
        items.forEach(function (item, i) {
          item.printed += pages[i].quantity;
          item.done.textContent = format(t.printed_times, {n: item.printed});
        });
        message(t.printed);
      } catch (e) {
        message(errorText(t, e), true);
      } finally {
        refresh();
      }
    }

    async function addIssues(text) {
      var urlMatch = text.match(/\/issues\/(\d+)/);
      var ids = urlMatch ? [urlMatch[1]] : (text.match(/\d+/g) || []);
      for (var i = 0; i < ids.length; i++) {
        try {
          var response = await fetch(labelUrl.replace('ID', ids[i]), {
            headers: {Accept: 'application/json'},
            credentials: 'same-origin'
          });
          var data = await response.json();
          if (!response.ok) throw new Error(data.error || response.statusText);
          addLabel(data);
          message('');
        } catch (e) {
          message(errorText(t, e), true);
        }
      }
      syncUrl();
      refresh();
    }

    config.labels.forEach(addLabel);
    printer.onChange(function (state, event) {
      if (event === 'connect') rerender();
      if (event === 'disconnect') message(t.disconnected, true);
      refresh();
    });
    keepScreenOn(printer);

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = input.value.trim();
      input.value = '';
      if (text) addIssues(text);
    });
    printAllBtn.addEventListener('click', function () { printItems(queue.slice()); });
    disconnectBtn.addEventListener('click', function () { printer.disconnect(); });
    connectBtn.addEventListener('click', async function () {
      connectBtn.disabled = true;
      message(t.connecting);
      try {
        await printer.connect();
        message('');
      } catch (e) {
        message(errorText(t, e), true);
      } finally {
        connectBtn.disabled = false;
        refresh();
      }
    });

    if (!isSupported()) {
      connectBtn.disabled = true;
      message(t.unsupported, true);
    }
    refresh();
  }

  window.NiimbotLabels = {render: render, canvasSize: canvasSize, Printer: Printer};

  function init() {
    document.querySelectorAll('[data-niimbot-issue]').forEach(initIssueWidget);
    document.querySelectorAll('[data-niimbot-print-page]').forEach(initPrintPage);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
