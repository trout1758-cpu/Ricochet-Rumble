// Ricochet Rumble — phone controllers over Wi-Fi.
// The local server (launcher/) relays WebSocket messages between this page and
// phones running game/pad/. Messages use the same bytes as the Bluetooth
// protocol (see docs/PROTOCOL.md), so WifiPadController reuses PhoneController.
window.RR = window.RR || {};

(function () {
  const MSG_HEARTBEAT = 0;
  const MSG_KICK = 4;
  const STALE_MS = 1500; // phones send at least every 200 ms

  const Wifi = {
    ws: null,
    hubConnected: false,
    urls: [],
    pads: new Map(),   // phone id -> WifiPadController
    byNum: new Map(),  // relay pad number -> WifiPadController
    onNewPad: null,    // (controller, slot) => void, set by main.js
    onUrls: null,

    // Wi-Fi phones only work when the page came from the launcher's server.
    supported() {
      return location.protocol === 'http:' || location.protocol === 'https:';
    },

    start() {
      if (!this.supported()) return;
      this.connect();
      setInterval(() => this.tick(), 250);
    },

    connect() {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?role=game`);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.onopen = () => { this.hubConnected = true; };
      ws.onmessage = (e) => this.onMessage(e.data);
      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.hubConnected = false;
        this.ws = null;
        for (const pad of this.pads.values()) pad.open = false;
        this.byNum.clear();
        setTimeout(() => this.connect(), 2000);
      };
    },

    refreshUrls() {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'urls' }));
    },

    onMessage(data) {
      if (typeof data !== 'string') {
        const u8 = new Uint8Array(data);
        const pad = this.byNum.get(u8[0]);
        if (pad) pad.handlePacket(new DataView(data, 1));
        return;
      }
      let msg;
      try { msg = JSON.parse(data); } catch (e) { return; }
      if (msg.t === 'hello') {
        this.urls = msg.urls || [];
        if (this.onUrls) this.onUrls(this.urls);
      } else if (msg.t === 'join') {
        let pad = msg.id && this.pads.get(msg.id);
        const known = pad && !pad.disposed;
        if (!known) {
          pad = new WifiPadController(msg.id || String(msg.pad), msg.name);
          if (msg.id) this.pads.set(msg.id, pad);
        }
        if (pad.num) this.byNum.delete(pad.num);
        pad.num = msg.pad;
        pad.open = true;
        pad.lastPacketAt = performance.now();
        this.byNum.set(msg.pad, pad);
        if (known) {
          pad.resync();
        } else if (this.onNewPad) {
          this.onNewPad(pad, msg.slot);
        }
      } else if (msg.t === 'leave') {
        const pad = this.byNum.get(msg.pad);
        if (pad) {
          pad.open = false;
          this.byNum.delete(msg.pad);
        }
      }
    },

    send(num, bytes) {
      if (!num || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const out = new Uint8Array(bytes.length + 1);
      out[0] = num;
      out.set(bytes, 1);
      this.ws.send(out);
    },

    // Heartbeats let phones notice a dead Wi-Fi link; also report
    // connection changes (dropped / back) to the game.
    tick() {
      for (const pad of this.byNum.values()) this.send(pad.num, [MSG_HEARTBEAT]);
      for (const pad of this.pads.values()) {
        const now = pad.connected;
        if (now !== pad.wasConnected) {
          pad.wasConnected = now;
          if (pad.onchange) pad.onchange(pad);
        }
      }
    },
  };

  class WifiPadController extends RR.PhoneController {
    constructor(id, name) {
      super(null);
      this.kind = 'wifi';
      this.label = 'Phone (Wi-Fi)';
      this.detail = name || 'Phone';
      this.id = id;
      this.num = 0;
      this.open = false;
      this.wasConnected = true;
    }

    // Connected = socket open AND packets still arriving (Wi-Fi can drop
    // silently without the socket closing).
    get connected() {
      return this.open && !this.disposed && performance.now() - this.lastPacketAt < STALE_MS;
    }

    set connected(v) { /* derived; PhoneController's constructor assigns it */ }

    send(bytes) {
      if (this.open) Wifi.send(this.num, bytes);
    }

    // Phone came back on the same id: resend everything it needs.
    resync() {
      this.last = null;
      this.lastStatusKey = null;
      this.lastLobbyKey = null;
      if (this.assignMsg) this.send(this.assignMsg);
    }

    reject() {
      this.send(new Uint8Array([MSG_KICK, 1]));
      this.disposed = true;
      Wifi.pads.delete(this.id);
    }

    dispose() {
      this.send(new Uint8Array([MSG_KICK, 0]));
      this.disposed = true;
      Wifi.pads.delete(this.id);
    }
  }

  RR.Wifi = Wifi;
  RR.WifiPadController = WifiPadController;
})();
