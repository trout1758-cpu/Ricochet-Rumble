// Ricochet Rumble — real Wii Remotes (+ Nunchuk) over WebHID, with the
// classic Wii Play Tanks controls:
//   Nunchuk stick: drive · point the Wii Remote at the screen: aim
//   B (trigger): fire · A: lay a mine · +: pause
//   (Z also fires and C also lays a mine.)
// Aiming uses the IR camera and a sensor bar. With no sensor bar in view the
// remote falls back to tilt aiming: tip and twist it to swing the turret.
// In menus the pointer is a cursor and A clicks whatever it points at.
//
// Works in Chrome / Edge with a Mayflash DolphinBar in mode 4 (it passes each
// Wii Remote through as a USB HID device and doubles as the sensor bar), or
// with the remote paired straight over Bluetooth. The DolphinBar always shows
// four slots, even empty ones, so connecting probes every slot and keeps the
// one with a remote in it (or the one you press a button on). The page must
// be served from localhost (the start scripts do it).
window.RR = window.RR || {};

(function () {
  const VENDOR = 0x057e;
  const PRODUCTS = [0x0306, 0x0330]; // RVL-CNT-01, RVL-CNT-01-TR (MotionPlus inside)
  const LEDS = [0x10, 0x20, 0x40, 0x80];

  // ---- pure helpers (also used by the tests) ----------------------------------
  const BTN = {
    LEFT: 0x0001, RIGHT: 0x0002, DOWN: 0x0004, UP: 0x0008, PLUS: 0x0010,
    TWO: 0x0100, ONE: 0x0200, B: 0x0400, A: 0x0800, MINUS: 0x1000, HOME: 0x8000,
  };

  // Report 0x37: buttons(2) accel(3) IR basic(10) extension(6). `d` is the
  // report data without the report id.
  function parseReport37(d) {
    const buttons = (d[0] | (d[1] << 8)) & 0x9f1f;
    const accel = { x: (d[2] - 128) / 26, y: (d[3] - 128) / 26, z: (d[4] - 128) / 26 };
    const ir = [];
    for (const o of [5, 10]) {
      const hi = d[o + 2];
      const x1 = d[o] | ((hi >> 4) & 3) << 8, y1 = d[o + 1] | ((hi >> 6) & 3) << 8;
      const x2 = d[o + 3] | (hi & 3) << 8, y2 = d[o + 4] | ((hi >> 2) & 3) << 8;
      if (x1 < 1023 && y1 < 1023) ir.push({ x: x1, y: y1 });
      if (x2 < 1023 && y2 < 1023) ir.push({ x: x2, y: y2 });
    }
    const e = d.slice(15, 21);
    let nunchuk = null;
    if (e.length === 6 && !(e[0] === 0xff && e[1] === 0xff && e[5] === 0xff) && !(e[0] === 0 && e[1] === 0 && e[5] === 0)) {
      const stick = (v) => Math.max(-1, Math.min(1, (v - 128) / 96));
      nunchuk = { x: stick(e[0]), y: -stick(e[1]), z: !(e[5] & 1), c: !(e[5] & 2) };
    }
    return { buttons, accel, ir, nunchuk };
  }

  // The two brightest IR dots (the sensor bar's ends) -> pointer position in
  // 0..1 screen coordinates, compensating for the remote being twisted.
  function irToPointer(dots, state) {
    let mid = null;
    if (dots.length >= 2) {
      let a = dots[0], b = dots[1];
      if (dots.length > 2) {
        // keep the pair that is furthest apart (the bar's two ends)
        let best = -1;
        for (let i = 0; i < dots.length; i++) for (let j = i + 1; j < dots.length; j++) {
          const d = Math.hypot(dots[i].x - dots[j].x, dots[i].y - dots[j].y);
          if (d > best) { best = d; a = dots[i]; b = dots[j]; }
        }
      }
      if (a.x > b.x) [a, b] = [b, a];
      mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      state.roll = Math.atan2(b.y - a.y, b.x - a.x);
      state.half = { x: (b.x - a.x) / 2, y: (b.y - a.y) / 2 };
      state.lastDots = [a, b];
    } else if (dots.length === 1 && state.lastDots) {
      // one end out of view: assume the bar kept its size, take the nearer end
      const d = dots[0];
      const [a, b] = state.lastDots;
      const nearA = Math.hypot(d.x - a.x, d.y - a.y) < Math.hypot(d.x - b.x, d.y - b.y);
      mid = nearA ? { x: d.x + state.half.x, y: d.y + state.half.y } : { x: d.x - state.half.x, y: d.y - state.half.y };
      state.lastDots = nearA ? [d, { x: d.x + 2 * state.half.x, y: d.y + 2 * state.half.y }] : [{ x: d.x - 2 * state.half.x, y: d.y - 2 * state.half.y }, d];
    }
    if (!mid) return null;
    // undo the remote's twist around the centre of the camera image
    const cx = 512, cy = 384, r = -(state.roll || 0);
    const dx = mid.x - cx, dy = mid.y - cy;
    const rx = cx + dx * Math.cos(r) - dy * Math.sin(r);
    const ry = cy + dx * Math.sin(r) + dy * Math.cos(r);
    // the camera sees the bar move the opposite way to where you point
    const x = 1 - rx / 1024, y = ry / 768;
    // a little gain so the whole screen is reachable without big arm movements
    const G = 1.45;
    return { x: 0.5 + (x - 0.5) * G, y: 0.5 + (y - 0.5) * G };
  }

  // ---- the controller -----------------------------------------------------------
  class WiimoteController {
    constructor(device) {
      this.kind = 'wiimote';
      this.device = device;
      this.label = 'Wii Remote';
      this.detail = 'Connecting…';
      this.linked = true;          // the HID device is there (always true on a DolphinBar)
      this.lastReportAt = 0;
      this.lastRestart = 0;
      this.wasLive = true;
      this.fire = 0; this.mine = 0; this.pause = 0; this.click = 0;
      this.prevButtons = 0;
      this.state = { buttons: 0, accel: { x: 0, y: 0, z: 1 }, ir: [], nunchuk: null };
      this.ext = false;
      this.player = -1;
      this.rumbleOn = false;
      this.rumbleTimer = 0;
      this.ptr = { roll: 0 };
      this.cursor = null;          // smoothed pointer, 0..1 screen coords
      this.lastIrAt = 0;
      this.tiltAim = { x: 1, y: 0 };
      this.battery = null;
      this.onReport = (e) => this.handle(e.reportId, new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength));
      device.addEventListener('inputreport', this.onReport);
    }

    // A DolphinBar slot stays plugged in when its remote powers off, so we also
    // treat a remote that has gone quiet (reports stream ~100 a second) as gone.
    get connected() {
      if (!this.linked) return false;
      return !this.started || performance.now() - this.lastReportAt < 2500;
    }
    set connected(v) { this.linked = !!v; }

    // called every frame or so; tells the game when the remote drops or returns
    tick() {
      const live = this.connected;
      if (live !== this.wasLive) {
        this.wasLive = live;
        if (this.onchange) this.onchange();
      }
    }

    async start() {
      this.started = false;
      this.lastReportAt = performance.now();
      if (!this.device.opened) await this.device.open();
      await this.setLeds();
      await this.send(0x15, [0x00]); // status: is a Nunchuk plugged in?
      await this.initIR();
      this.started = true;
      if (this.ext) await this.initExtension();
      else await this.setMode();
      this.updateDetail();
    }

    // Everything sent to the remote goes through one queue, in order, with a
    // pause after each register write so the remote can keep up.
    enqueue(job) {
      this.queue = (this.queue || Promise.resolve()).then(job).catch(() => {});
      return this.queue;
    }

    rawSend(id, bytes) {
      const data = Uint8Array.from(bytes);
      data[0] = (data[0] & 0xfe) | (this.rumbleOn ? 1 : 0);
      return this.device.sendReport(id, data);
    }

    send(id, bytes) {
      return this.enqueue(() => this.rawSend(id, bytes));
    }

    write(addr, bytes) {
      const data = new Uint8Array(21);
      data[0] = 0x04; // control registers
      data[1] = (addr >> 16) & 0xff; data[2] = (addr >> 8) & 0xff; data[3] = addr & 0xff;
      data[4] = bytes.length;
      data.set(bytes, 5);
      return this.enqueue(async () => { await this.rawSend(0x16, data); await wait(40); });
    }

    async initIR() {
      this.enqueue(async () => { await this.rawSend(0x13, [0x04]); await wait(30); await this.rawSend(0x1a, [0x04]); await wait(30); });
      await this.write(0xb00030, [0x08]);
      await this.write(0xb00000, [0x02, 0x00, 0x00, 0x71, 0x01, 0x00, 0xaa, 0x00, 0x64]);
      await this.write(0xb0001a, [0x63, 0x03]);
      await this.write(0xb00033, [0x01]); // basic mode: 10 IR bytes
      await this.write(0xb00030, [0x08]);
    }

    async initExtension() {
      await this.write(0xa400f0, [0x55]);
      await this.write(0xa400fb, [0x00]);
      await this.setMode();
    }

    setMode() { return this.send(0x12, [0x04, 0x37]); }

    setLeds() {
      const led = this.player >= 0 ? LEDS[this.player % 4] : LEDS[0] | LEDS[3];
      return this.send(0x11, [led]);
    }

    assign(index) {
      this.player = index;
      this.setLeds();
      this.updateDetail();
    }

    handle(id, d) {
      const now = performance.now();
      const quiet = now - this.lastReportAt;
      this.lastReportAt = now;
      // The remote came back (after powering off, or re-syncing to the
      // DolphinBar): it has forgotten its report mode and IR set-up.
      if (this.started && !this.restarting && (quiet > 1500 || (id >= 0x30 && id <= 0x3f && id !== 0x37)) && now - this.lastRestart > 2000) {
        this.lastRestart = now;
        this.restarting = true;
        this.queue = Promise.resolve();
        this.start().catch((err) => console.warn(err)).finally(() => { this.restarting = false; });
      }
      this.tick();
      if (id === 0x20) {
        // status report: the remote also drops back to buttons-only mode
        const ext = !!(d[2] & 0x02);
        this.battery = d[5];
        if (this.started) {
          if (ext && !this.ext) this.initExtension();
          else this.setMode();
        }
        const changed = ext !== this.ext;
        this.ext = ext;
        this.updateDetail();
        if (changed && this.onext) this.onext();
        return;
      }
      if (id !== 0x37) return;
      const s = parseReport37(d);
      if (!this.ext) s.nunchuk = null;
      this.state = s;
      const pressed = s.buttons & ~this.prevButtons;
      this.prevButtons = s.buttons;
      const n = s.nunchuk;
      if (n) {
        if (n.z && !this.prevZ) this.fire++;
        if (n.c && !this.prevC) this.mine++;
        this.prevZ = n.z; this.prevC = n.c;
      }
      if (pressed & BTN.B) this.fire++;
      if (pressed & BTN.A) { this.mine++; this.click++; }
      if (pressed & (BTN.PLUS | BTN.HOME)) this.pause++;
      if (pressed & BTN.MINUS) this.back = (this.back || 0) + 1;
      const p = irToPointer(s.ir, this.ptr);
      if (p) {
        this.lastIrAt = performance.now();
        this.cursor = this.cursor ? { x: this.cursor.x + (p.x - this.cursor.x) * 0.45, y: this.cursor.y + (p.y - this.cursor.y) * 0.45 } : p;
      }
    }

    get pointing() { return performance.now() - this.lastIrAt < 600; }

    updateDetail() {
      const bits = [this.ext ? 'Nunchuk ✓' : 'plug in the Nunchuk'];
      if (this.battery != null) bits.push(`battery ${Math.min(100, Math.round((this.battery / 200) * 100))}%`);
      this.detail = bits.join(' · ');
    }

    read() {
      const s = this.state;
      let mx = 0, my = 0;
      if (s.nunchuk) {
        mx = s.nunchuk.x; my = s.nunchuk.y;
        const m = Math.hypot(mx, my);
        if (m < 0.18) { mx = 0; my = 0; } else if (m > 1) { mx /= m; my /= m; }
      } else {
        // no Nunchuk: the D-pad drives (remote held pointing at the screen)
        mx = (s.buttons & BTN.RIGHT ? 1 : 0) - (s.buttons & BTN.LEFT ? 1 : 0);
        my = (s.buttons & BTN.DOWN ? 1 : 0) - (s.buttons & BTN.UP ? 1 : 0);
        const m = Math.hypot(mx, my) || 1;
        mx /= m; my /= m;
      }
      const out = { moveX: mx, moveY: my, rotate: 0, fire: this.fire, mine: this.mine, pause: this.pause, snapOnFire: false, click: this.click,
        // menus: D-pad moves, A presses, B (trigger) means ready, − backs out
        ok: this.click, ready: this.fire, back: this.back || 0,
        navX: (s.buttons & BTN.RIGHT ? 1 : 0) - (s.buttons & BTN.LEFT ? 1 : 0),
        navY: (s.buttons & BTN.DOWN ? 1 : 0) - (s.buttons & BTN.UP ? 1 : 0) };
      this.fire = this.mine = this.pause = this.click = this.back = 0;
      if (this.pointing && this.cursor) {
        const sx = this.cursor.x * window.innerWidth, sy = this.cursor.y * window.innerHeight;
        const wpt = RR.Input.screenToWorld(sx, sy);
        Object.assign(out, { aimMode: 'point', aimX: wpt.x, aimY: wpt.y, aimActive: true, screenX: sx, screenY: sy });
      } else {
        // tilt aiming: tip the remote forward/back and twist it left/right
        const a = s.accel;
        const roll = Math.atan2(a.x, Math.max(0.2, a.z));
        const pitch = Math.atan2(a.y, Math.max(0.2, a.z));
        const ax = roll, ay = -pitch;
        const m = Math.hypot(ax, ay);
        const active = m > 0.3;
        if (active) this.tiltAim = { x: ax / m, y: ay / m };
        Object.assign(out, { aimMode: 'dir', aimX: this.tiltAim.x, aimY: this.tiltAim.y, aimActive: active });
      }
      return out;
    }

    rumble(ms, strength) {
      if (strength < 0.15) return;
      clearTimeout(this.rumbleTimer);
      this.rumbleOn = true;
      this.setLeds();
      this.rumbleTimer = setTimeout(() => {
        this.rumbleOn = false;
        this.setLeds();
      }, Math.max(40, Math.min(600, ms)));
    }

    dispose() {
      clearTimeout(this.rumbleTimer);
      this.rumbleOn = false;
      this.device.removeEventListener('inputreport', this.onReport);
      this.send(0x11, [0x00]).finally(() => this.device.close().catch(() => {}));
      this.disposed = true;
    }
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const active = new Set();

  const withTimeout = (promise, ms) => Promise.race([promise, wait(ms).then(() => { throw new Error('timeout'); })]);

  // Does this HID device have a Wii Remote behind it? Asks for a status report;
  // an empty DolphinBar slot refuses the write or never answers.
  async function probe(dev) {
    try {
      if (!dev.opened) await withTimeout(dev.open(), 1500);
    } catch (e) {
      return false;
    }
    let answered = false;
    const on = () => { answered = true; };
    dev.addEventListener('inputreport', on);
    try {
      await withTimeout(dev.sendReport(0x15, Uint8Array.from([0x00])), 800);
      for (let k = 0; k < 10 && !answered; k++) await wait(50);
    } catch (e) {
      /* empty slot */
    }
    dev.removeEventListener('inputreport', on);
    return answered;
  }

  // Several remotes answering: the first one to press a button wins.
  function firstPress(devs, ms) {
    return new Promise((resolve) => {
      const offs = [];
      const done = (d) => { offs.forEach((f) => f()); clearTimeout(t); resolve(d); };
      const t = setTimeout(() => done(null), ms);
      for (const d of devs) {
        const f = (e) => {
          const b = new Uint8Array(e.data.buffer, e.data.byteOffset, Math.min(2, e.data.byteLength));
          if (e.reportId >= 0x30 && e.reportId <= 0x3f && b.length === 2 && ((b[0] | (b[1] << 8)) & 0x9f1f)) done(d);
        };
        d.addEventListener('inputreport', f);
        offs.push(() => d.removeEventListener('inputreport', f));
      }
    });
  }

  // ---- press a button on a Wii Remote to join -----------------------------------
  // Remotes the browser already allowed (no mouse needed after the first time)
  // are listened to while the title or lobby is up; a button press joins.
  const watched = new Map(); // device -> listener
  function unwatch(dev) {
    const f = watched.get(dev);
    if (f) { dev.removeEventListener('inputreport', f); watched.delete(dev); }
  }
  let joinCb = null, joinWhen = () => false, scanning = false;
  async function scanJoin() {
    if (scanning || !joinCb || !joinWhen() || Wiimote.busy || !('hid' in navigator)) return;
    scanning = true;
    try {
      const devs = (await navigator.hid.getDevices()).filter((d) => d.vendorId === VENDOR && PRODUCTS.includes(d.productId));
      for (const d of devs) {
        if (watched.has(d) || [...active].some((c) => c.device === d)) continue;
        try { if (!d.opened) await withTimeout(d.open(), 1500); } catch (e) { continue; }
        const f = (e) => {
          if (Wiimote.busy || !joinWhen() || [...active].some((c) => c.device === d)) return;
          const b = new Uint8Array(e.data.buffer, e.data.byteOffset, Math.min(2, e.data.byteLength));
          if (e.reportId >= 0x30 && e.reportId <= 0x3f && b.length === 2 && ((b[0] | (b[1] << 8)) & 0x9f1f)) {
            unwatch(d);
            joinCb(d);
          }
        };
        watched.set(d, f);
        d.addEventListener('inputreport', f);
      }
    } catch (e) {
      console.warn(e);
    } finally {
      scanning = false;
    }
  }

  const Wiimote = {
    busy: false,

    watchJoin(cb, when) {
      joinCb = cb;
      joinWhen = when;
      scanJoin();
      setInterval(scanJoin, 2000);
    },

    problem() {
      if (!('hid' in navigator)) return 'This browser can’t talk to Wii Remotes. Use Google Chrome or Microsoft Edge on a computer.';
      if (!window.isSecureContext) return 'Open the game with the start script (start-game.bat / start-game.sh) to use Wii Remotes.';
      return '';
    },

    // Find a free Wii Remote. Uses the devices the browser already allowed
    // (all four DolphinBar slots come together); shows the browser's device
    // picker only when none of those has a free remote behind it.
    //   onChoose(): called when several remotes are free and one must be picked
    //   by pressing a button on it.
    async connect({ onChoose } = {}) {
      Wiimote.busy = true;
      try {
        return await this.connectInner(onChoose);
      } finally {
        Wiimote.busy = false;
      }
    },

    async connectInner(onChoose) {
      const filters = PRODUCTS.map((productId) => ({ vendorId: VENDOR, productId }));
      const isWii = (d) => d.vendorId === VENDOR && PRODUCTS.includes(d.productId);
      const free = (list) => list.filter((d) => isWii(d) && ![...active].some((c) => c.device === d));
      const live = async (list) => {
        const ok = await Promise.all(list.map(probe));
        const out = list.filter((_, k) => ok[k]);
        // leave empty slots closed so they don't hold anything open
        list.forEach((d, k) => { if (!ok[k] && d.opened) d.close().catch(() => {}); });
        return out;
      };
      let found = await live(free(await navigator.hid.getDevices()));
      if (!found.length) {
        const picked = free(await navigator.hid.requestDevice({ filters }));
        if (!picked.length) {
          const err = new Error('No Wii Remote picked.');
          err.name = 'NotFoundError';
          throw err;
        }
        // the picker may hand back just one slot; the bar's others come with it
        const all = free(await navigator.hid.getDevices());
        found = await live(all.length >= picked.length ? all : picked);
      }
      if (!found.length) {
        const err = new Error('No Wii Remote answered. Press a button on it so it links up (the DolphinBar light for its slot comes on), check the DolphinBar is in mode 4, then try again.');
        err.name = 'NoRemote';
        throw err;
      }
      let dev = found[0];
      if (found.length > 1) {
        if (onChoose) onChoose(found.length);
        dev = await firstPress(found, 15000);
        if (!dev) {
          const err = new Error('No button pressed. Press A on the Wii Remote you want, right after picking it.');
          err.name = 'NoRemote';
          throw err;
        }
      }
      found.forEach((d) => { if (d !== dev && d.opened && !watched.has(d)) d.close().catch(() => {}); });
      return this.adopt(dev);
    },

    // Turn an allowed HID device into a controller for the game.
    async adopt(dev) {
      unwatch(dev);
      const ctl = new WiimoteController(dev);
      await ctl.start();
      active.add(ctl);
      const dispose = ctl.dispose.bind(ctl);
      ctl.dispose = () => { active.delete(ctl); dispose(); };
      return ctl;
    },
  };

  if (typeof navigator !== 'undefined' && 'hid' in navigator) {
    navigator.hid.addEventListener('disconnect', (e) => {
      for (const c of active) if (c.device === e.device) { c.connected = false; if (c.onchange) c.onchange(); }
    });
    navigator.hid.addEventListener('connect', async (e) => {
      for (const c of active) {
        if (c.device === e.device || (c.device.productId === e.device.productId && !c.connected && !c.device.opened)) {
          c.device.removeEventListener('inputreport', c.onReport);
          c.device = e.device;
          c.device.addEventListener('inputreport', c.onReport);
          c.connected = true;
          try { await c.start(); } catch (err) { console.warn(err); }
          if (c.onchange) c.onchange();
          return;
        }
      }
    });
  }

  // ---- on-screen pointers for menus ---------------------------------------------
  // Draws each Wii Remote's pointer as a coloured hand cursor outside of play,
  // and turns an A press into a click on whatever it points at.
  const cursors = [];
  function cursorEl(i, color) {
    if (!cursors[i]) {
      const el = document.createElement('div');
      el.className = 'wii-cursor';
      el.innerHTML = '<svg viewBox="0 0 32 32" width="36" height="36"><path d="M12 3c1.7 0 3 1.3 3 3v8l1-.1V9c0-1.6 1.3-2.9 3-2.9s3 1.3 3 2.9v5.4c1.6-.4 3.3.6 3.6 2.3l.4 3.6c.3 4.9-3.4 9.7-8.4 9.7h-1.8c-2.8 0-5.2-1.4-6.6-3.7L4.5 20c-.8-1.4-.3-3.2 1.1-4 1.3-.8 3-.4 3.9.8L9 17V6c0-1.7 1.3-3 3-3z" fill="currentColor" stroke="#1d1a24" stroke-width="2" stroke-linejoin="round"/></svg><b></b>';
      document.body.appendChild(el);
      cursors[i] = el;
    }
    cursors[i].style.color = color;
    cursors[i].style.setProperty('--pc', color);
    return cursors[i];
  }

  Wiimote.updatePointers = function (players, inputs, menusActive, colorOf) {
    players.forEach((p, i) => {
      const c = p.controller;
      const inp = inputs[i];
      // hidden while that player steers the menus with the D-pad
      const on = menusActive && c && c.kind === 'wiimote' && inp && inp.screenX != null && !(RR.MenuNav && RR.MenuNav.dpadMode(i));
      const el = on || cursors[i] ? cursorEl(i, colorOf(i).body) : null;
      if (!el) return;
      el.classList.toggle('hidden', !on);
      if (!on) return;
      el.style.transform = `translate(${inp.screenX - 10}px, ${inp.screenY - 4}px)`;
      el.querySelector('b').textContent = 'P' + (i + 1);
      if (inp.click > 0) {
        el.style.visibility = 'hidden';
        const target = document.elementFromPoint(inp.screenX, inp.screenY);
        el.style.visibility = '';
        const btn = target && target.closest('button, select, input, a, [data-click]');
        if (btn && !btn.disabled) {
          // a drop-down opens the on-screen picker (a pointer can't use the browser's list)
          if (btn.tagName === 'SELECT' && RR.MenuNav) RR.MenuNav.openPicker(btn, i);
          else if (btn.tagName === 'INPUT') btn.focus();
          else btn.click();
          c.rumble(40, 0.4);
        }
      }
    });
  };

  RR.Wiimote = Wiimote;
  RR.WiimoteController = WiimoteController;
  RR.WiimoteParse = { parseReport37, irToPointer, BTN };
})();
