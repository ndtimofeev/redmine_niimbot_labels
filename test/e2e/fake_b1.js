// Fake NIIMBOT B1 behind a fake navigator.bluetooth. Answers are taken from a
// real B1 (fw 5.22) dump in niimbluelib's tests; printing is simulated and the
// received bitmap is kept in window.__fakeB1.pages for checks.
(() => {
  const hex = (s) => s.trim().split(/\s+/).map((b) => parseInt(b, 16));
  const INFO = {
    0x08: [0x48, hex('10 00')],
    0x0b: [0x4b, hex('47 33 32 37 30 37 31 31 38 35')],
    0x0d: [0x4d, hex('27 03 07 17 6e 82')],
    0x0a: [0x4a, hex('04')],
    0x07: [0x47, hex('01')],
    0x03: [0x43, hex('01')],
    0x0c: [0x4c, hex('05 0a')],
    0x09: [0x49, hex('05 16')],
  };
  const state = {
    log: [], pages: [], requestCount: 0, chooserCount: 0, connected: false,
    current: null, printedPages: 0, failNextPrintStatus: false,
  };
  window.__fakeB1 = state;

  function packet(cmd, data) {
    let sum = cmd ^ data.length;
    data.forEach((b) => (sum ^= b));
    return new Uint8Array([0x55, 0x55, cmd, data.length, ...data, sum, 0xaa, 0xaa]);
  }

  function handle(cmd, d) {
    state.log.push(cmd);
    switch (cmd) {
      case 0xc1: return packet(0xc2, [0x03]);
      case 0xa5: return packet(0xb5, hex('30 30 03 20 00 c8 00 00 00 0f 01 02 04 01 98 00'));
      case 0x40: { const r = INFO[d[0]]; return r ? packet(r[0], r[1]) : packet(0x00, [0x01]); }
      case 0xdc:
        if (d[0] === 0x03) return packet(0xde, hex('05 0a 05 16 01 80 02 02 01 00'));
        return packet(0xd9, hex('20 41 04 4d 00 00 01 00 00'));
      case 0x1a: return packet(0x1b, hex('88 1d 7e 4f d9 97 00 00 08 31 30 32 36 32 32 36 30 10 50 5a 31 47 32 32 31 33 32 32 30 30 34 32 30 35 01 14 00 99 01'));
      case 0x21: state.density = d[0]; return packet(0x31, [0x01]);
      case 0x23: return packet(0x33, [0x01]);
      case 0x01: state.printedPages = 0; state.totalPages = (d[0] << 8) | d[1]; return packet(0x02, [0x01]);
      case 0x03: return packet(0x04, [0x01]);
      case 0x13: {
        const rows = (d[0] << 8) | d[1], cols = (d[2] << 8) | d[3], copies = (d[4] << 8) | d[5];
        state.current = {rows, cols, copies, bits: new Uint8Array(rows * cols)};
        return packet(0x14, [0x01]);
      }
      case 0x85: case 0x83: case 0x84: {
        const p = state.current, row = (d[0] << 8) | d[1];
        if (cmd === 0x84) return null;
        const repeat = d[5];
        for (let r = row; r < row + repeat; r++) {
          if (cmd === 0x85) {
            for (let x = 0; x < p.cols; x++) {
              if (d[6 + (x >> 3)] & (0x80 >> (x & 7))) p.bits[r * p.cols + x] = 1;
            }
          } else {
            for (let i = 6; i + 1 < d.length; i += 2) p.bits[r * p.cols + ((d[i] << 8) | d[i + 1])] = 1;
          }
        }
        return null;
      }
      case 0xe3:
        state.pages.push(state.current);
        state.printedPages += state.current.copies;
        return packet(0xe4, [0x01]);
      case 0xa3: {
        const n = state.printedPages;
        return packet(0xb3, [n >> 8, n & 0xff, 100, 100]);
      }
      case 0xf3: return packet(0xf4, [0x01]);
      default: return packet(0x00, [0x01]);
    }
  }

  function makeDevice() {
    const deviceListeners = {};
    const characteristic = {
      uuid: 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f',
      properties: {notify: true, writeWithoutResponse: true},
      listeners: [],
      addEventListener(type, fn) { if (type === 'characteristicvaluechanged') this.listeners.push(fn); },
      removeEventListener() {},
      async startNotifications() {},
      async writeValueWithoutResponse(buffer) {
        if (!state.connected) throw new Error('GATT disconnected');
        let bytes = new Uint8Array(buffer);
        if (bytes[0] === 0x03) bytes = bytes.slice(1);
        const cmd = bytes[2], len = bytes[3];
        const reply = handle(cmd, Array.from(bytes.slice(4, 4 + len)));
        if (reply) {
          setTimeout(() => {
            const value = new DataView(reply.buffer);
            this.listeners.forEach((fn) => fn({target: {value}}));
          }, 2);
        }
      },
    };
    const server = {
      async getPrimaryServices() {
        return [
          {uuid: '1800', async getCharacteristics() { return []; }},
          {uuid: 'e7810a71-73ae-499d-8c15-faa9aef0c3f2', async getCharacteristics() { return [characteristic]; }},
        ];
      },
      disconnect() {
        if (!state.connected) return;
        state.connected = false;
        (deviceListeners.gattserverdisconnected || []).forEach((fn) => fn());
      },
    };
    const device = {
      name: 'B1-G327071185',
      gatt: {async connect() { state.connected = true; return server; }},
      addEventListener(type, fn) { (deviceListeners[type] = deviceListeners[type] || []).push(fn); },
      removeEventListener(type, fn) { deviceListeners[type] = (deviceListeners[type] || []).filter((f) => f !== fn); },
    };
    state.dropConnection = () => server.disconnect();
    return device;
  }

  Object.defineProperty(navigator, 'bluetooth', {
    value: {
      async requestDevice(options) {
        // Real Chrome refuses without a user gesture; mimic that.
        if (!navigator.userActivation || !navigator.userActivation.isActive) {
          throw new DOMException('Must be handling a user gesture to show a permission request.', 'SecurityError');
        }
        state.chooserCount++;
        state.lastOptions = options;
        return makeDevice();
      },
    },
  });
})();
