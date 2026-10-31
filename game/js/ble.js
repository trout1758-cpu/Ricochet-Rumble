// Ricochet Rumble — phone controllers over Bluetooth LE (Web Bluetooth).
// The Android app advertises a GATT service; the browser connects to it as a
// central, subscribes to input notifications and writes feedback (player
// colour, rumble, score) back.
window.RR = window.RR || {};

(function () {
  const P = RR.PROTO;

  const BLE = {
    supported() {
      return !!(navigator.bluetooth && navigator.bluetooth.requestDevice);
    },

    // Explains why Bluetooth can't be used, or returns null if it can.
    problem() {
      if (!window.isSecureContext) {
        return 'Bluetooth only works when the game is opened through the start script (an http://localhost address), not by double-clicking index.html.';
      }
      if (!BLE.supported()) {
        return 'This browser has no Web Bluetooth. Use Google Chrome or Microsoft Edge on Windows, macOS or ChromeOS. (On Linux enable chrome://flags/#enable-experimental-web-platform-features.)';
      }
      return null;
    },

    // Must be called from a click handler (browser rule for the device picker).
    async connect() {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [P.SERVICE_UUID] }],
      });
      const ctl = new PhoneController(device);
      await ctl.open();
      return ctl;
    },
  };

  class PhoneController {
    constructor(device) {
      this.kind = 'phone';
      this.device = device;
      this.label = 'Phone';
      this.detail = device ? device.name || 'Android phone' : 'Phone';
      this.connected = false;
      this.reconnecting = false;
      this.disposed = false;
      this.state = null;
      this.last = null;
      this.queue = [];
      this.writing = false;
      this.onchange = null;
      this.lastPacketAt = 0;
      this.onDisconnected = this.onDisconnected.bind(this);
      this.onNotify = this.onNotify.bind(this);
      if (device) device.addEventListener('gattserverdisconnected', this.onDisconnected);
    }

    async open() {
      const server = await this.device.gatt.connect();
      const service = await server.getPrimaryService(P.SERVICE_UUID);
      this.inputChar = await service.getCharacteristic(P.INPUT_UUID);
      this.feedbackChar = await service.getCharacteristic(P.FEEDBACK_UUID);
      this.inputChar.addEventListener('characteristicvaluechanged', this.onNotify);
      await this.inputChar.startNotifications();
      this.connected = true;
      this.reconnecting = false;
      this.last = null; // re-baseline counters after (re)connecting
      if (this.assignMsg) this.send(this.assignMsg);
      this.emitChange();
    }

    onNotify(e) {
      this.handlePacket(e.target.value);
    }

    handlePacket(dv) {
      if (dv.byteLength && dv.getUint8(0) === P.PROFILE) {
        const profile = P.decodeProfile(dv);
        if (profile && this.onprofile) this.onprofile(profile);
        return;
      }
      const pkt = P.decodeInput(dv);
      if (!pkt) return;
      this.lastPacketAt = performance.now();
      if (!this.last) {
        this.last = { fire: pkt.fireCount, mine: pkt.mineCount, pause: pkt.pauseCount };
        this.pending = { fire: 0, mine: 0, pause: 0 };
      } else {
        this.pending.fire += P.counterDelta(this.last.fire, pkt.fireCount);
        this.pending.mine += P.counterDelta(this.last.mine, pkt.mineCount);
        this.pending.pause += P.counterDelta(this.last.pause, pkt.pauseCount);
        this.last.fire = pkt.fireCount;
        this.last.mine = pkt.mineCount;
        this.last.pause = pkt.pauseCount;
      }
      this.state = pkt;
    }

    read() {
      const s = this.state;
      if (!s || !this.connected) return Object.assign({}, RR.NO_INPUT, { pause: 0 });
      const out = {
        moveX: s.moveX, moveY: s.moveY, aimMode: 'dir', aimX: s.aimX, aimY: s.aimY, aimActive: s.aimHeld,
        rotate: 0, fire: this.pending.fire, mine: this.pending.mine, pause: this.pending.pause, snapOnFire: true,
      };
      this.pending.fire = this.pending.mine = this.pending.pause = 0;
      return out;
    }

    // ---- feedback to the phone -----------------------------------------------------------
    assign(playerIndex, rgb) {
      this.assignMsg = new Uint8Array([P.MSG_ASSIGN, playerIndex, rgb[0], rgb[1], rgb[2]]);
      this.send(this.assignMsg);
    }

    rumble(ms, strength) {
      this.send(new Uint8Array([P.MSG_RUMBLE, Math.min(255, Math.round(ms / 10)), Math.max(1, Math.min(255, Math.round(strength * 255)))]));
    }

    status(state, myWins, theirWins, winsNeeded, shellsLeft, minesLeft, ready, shellsMax) {
      const msg = new Uint8Array([P.MSG_STATUS, state, myWins, theirWins, winsNeeded, shellsLeft, minesLeft, ready ? 1 : 0, shellsMax]);
      const key = msg.join(',');
      if (key === this.lastStatusKey) return;
      this.lastStatusKey = key;
      // Only the newest status matters; drop stale ones still waiting.
      this.queue = this.queue.filter((m) => m[0] !== P.MSG_STATUS);
      this.send(msg);
    }

    // Name/colour info for the phone's lobby editor.
    lobby(myColor, otherColor, name) {
      const nb = P.nameBytes(name, 16);
      const msg = new Uint8Array(4 + nb.length);
      msg.set([P.MSG_LOBBY, myColor, otherColor, nb.length]);
      msg.set(nb, 4);
      const key = msg.join(',');
      if (key === this.lastLobbyKey) return;
      this.lastLobbyKey = key;
      this.send(msg);
    }

    send(bytes) {
      if (!this.connected || !this.feedbackChar) return;
      if (this.queue.length > 12) this.queue.shift();
      this.queue.push(bytes);
      this.pump();
    }

    async pump() {
      if (this.writing) return;
      this.writing = true;
      try {
        while (this.queue.length && this.connected) {
          const msg = this.queue.shift();
          try {
            if (this.feedbackChar.writeValueWithoutResponse) await this.feedbackChar.writeValueWithoutResponse(msg);
            else await this.feedbackChar.writeValue(msg);
          } catch (err) {
            console.warn('BLE feedback write failed', err);
          }
        }
      } finally {
        this.writing = false;
      }
    }

    // ---- connection lifecycle ---------------------------------------------------------------
    onDisconnected() {
      if (!this.connected && this.reconnecting) return;
      this.connected = false;
      this.state = null;
      this.queue = [];
      this.lastStatusKey = null;
      this.lastLobbyKey = null;
      this.emitChange();
      if (!this.disposed) this.reconnect();
    }

    async reconnect() {
      this.reconnecting = true;
      this.emitChange();
      let delay = 1000;
      while (!this.disposed && !this.connected) {
        try {
          await this.open();
          return;
        } catch (err) {
          await new Promise((r) => setTimeout(r, delay));
          delay = Math.min(5000, delay * 1.5);
        }
      }
    }

    emitChange() {
      if (this.onchange) this.onchange(this);
    }

    dispose() {
      this.disposed = true;
      this.connected = false;
      if (this.device) {
        this.device.removeEventListener('gattserverdisconnected', this.onDisconnected);
        try { if (this.device.gatt.connected) this.device.gatt.disconnect(); } catch (e) { /* ignore */ }
      }
    }
  }

  RR.BLE = BLE;
  RR.PhoneController = PhoneController;
})();
