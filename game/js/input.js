// Ricochet Rumble — local input sources (keyboard, mouse, gamepads).
// Every controller exposes the same interface:
//   kind, label, connected, read() -> input frame, rumble(ms, strength), dispose()
// The phone controller lives in ble.js and follows the same shape.
window.RR = window.RR || {};

(function () {
  const keys = new Set();
  const listeners = new Set();
  const mouse = { x: 0, y: 0, inside: false };
  let renderer = null;

  function onKey(e, down) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA')) return;
    if (down) {
      if (e.repeat) return;
      keys.add(e.code);
    } else {
      keys.delete(e.code);
    }
    for (const l of listeners) l.onKey && l.onKey(e.code, down, e);
  }

  const Input = {
    keys,
    mouse,
    init(canvas, r) {
      renderer = r;
      window.addEventListener('keydown', (e) => onKey(e, true));
      window.addEventListener('keyup', (e) => onKey(e, false));
      window.addEventListener('blur', () => keys.clear());
      window.addEventListener('mousemove', (e) => {
        mouse.x = e.clientX;
        mouse.y = e.clientY;
      });
      canvas.addEventListener('mousedown', (e) => {
        for (const l of listeners) l.onMouse && l.onMouse(e.button, true, e);
      });
      canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    },
    screenToWorld(x, y) {
      return renderer ? renderer.screenToWorld(x, y) : { x: 0, y: 0 };
    },
    mouseWorld() {
      return renderer ? renderer.screenToWorld(mouse.x, mouse.y) : { x: 0, y: 0 };
    },
    subscribe(l) { listeners.add(l); },
    unsubscribe(l) { listeners.delete(l); },
    gamepads() {
      return navigator.getGamepads ? Array.from(navigator.getGamepads()).filter(Boolean) : [];
    },
  };

  // Keys that the game uses; we stop the browser from scrolling etc.
  const CAPTURE = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Slash', 'Quote']);
  window.addEventListener('keydown', (e) => {
    if (CAPTURE.has(e.code) && !(e.target && e.target.tagName === 'INPUT')) e.preventDefault();
  });

  class KeyboardMouseController {
    constructor() {
      this.kind = 'kbm';
      this.label = 'Keyboard + mouse';
      this.detail = 'WASD drive · mouse aim · click fire · Space mine';
      this.connected = true;
      this.fire = 0; this.mine = 0; this.pause = 0;
      Input.subscribe(this);
    }

    onKey(code, down) {
      if (!down) return;
      if (code === 'Space' || code === 'KeyE') this.mine++;
      if (code === 'KeyF') this.fire++;
    }

    onMouse(button, down) {
      if (!down) return;
      if (button === 0) this.fire++;
      if (button === 2) this.mine++;
    }

    read() {
      const k = keys;
      const mx = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
      const my = (k.has('KeyS') ? 1 : 0) - (k.has('KeyW') ? 1 : 0);
      const m = Math.hypot(mx, my) || 1;
      const aim = Input.mouseWorld();
      const out = {
        moveX: mx / m, moveY: my / m, aimMode: 'point', aimX: aim.x, aimY: aim.y, aimActive: true,
        rotate: 0, fire: this.fire, mine: this.mine, pause: this.pause, snapOnFire: false,
      };
      this.fire = this.mine = this.pause = 0;
      return out;
    }

    rumble() {}

    dispose() {
      Input.unsubscribe(this);
    }
  }

  class KeyboardArrowsController {
    constructor() {
      this.kind = 'arrows';
      this.label = 'Arrow keys';
      this.detail = 'Arrows drive · < > turn turret · / fire · R-Shift mine';
      this.connected = true;
      this.fire = 0; this.mine = 0; this.pause = 0;
      Input.subscribe(this);
    }

    onKey(code, down) {
      if (!down) return;
      if (code === 'Slash' || code === 'Enter' || code === 'Numpad0' || code === 'NumpadEnter') this.fire++;
      if (code === 'ShiftRight' || code === 'Quote' || code === 'NumpadDecimal') this.mine++;
    }

    read() {
      const k = keys;
      const mx = (k.has('ArrowRight') ? 1 : 0) - (k.has('ArrowLeft') ? 1 : 0);
      const my = (k.has('ArrowDown') ? 1 : 0) - (k.has('ArrowUp') ? 1 : 0);
      const m = Math.hypot(mx, my) || 1;
      const rot = ((k.has('Period') || k.has('Numpad6')) ? 1 : 0) - ((k.has('Comma') || k.has('Numpad4')) ? 1 : 0);
      const out = {
        moveX: mx / m, moveY: my / m, aimMode: 'rotate', aimX: 0, aimY: 0, aimActive: rot !== 0,
        rotate: rot, fire: this.fire, mine: this.mine, pause: this.pause, snapOnFire: false,
      };
      this.fire = this.mine = this.pause = 0;
      return out;
    }

    rumble() {}

    dispose() {
      Input.unsubscribe(this);
    }
  }

  // ---- Gamepads: Xbox, PlayStation, Nintendo Switch and others ----------------
  // Browsers give most big-brand controllers the "standard" layout
  // (bottom face button 0, right 1, LB 4, RB 5, LT 6, RT 7, Start 9, D-pad
  // 12-15, sticks on axes 0-3). Pads without it (older or generic pads, a
  // single Joy-Con) get a best-effort layout: stick or hat switch to drive,
  // turret follows the drive direction when there is no second stick.
  const FAMILIES = {
    xbox: { name: 'Xbox controller', fire: 'RT / RB / A', mine: 'LT / LB / B', pause: 'Menu' },
    ps: { name: 'PlayStation controller', fire: 'R2 / R1 / ✕', mine: 'L2 / L1 / ○', pause: 'Options' },
    switch: { name: 'Switch controller', fire: 'ZR / R / B', mine: 'ZL / L / A', pause: '+' },
    joycon: { name: 'Joy-Con', fire: 'SR / face buttons', mine: 'SL', pause: '+ / −' },
    other: { name: 'Gamepad', fire: 'right trigger / bumper / bottom button', mine: 'left trigger / bumper / right button', pause: 'Start' },
  };

  function padFamily(id) {
    const s = String(id || '').toLowerCase();
    if (/joy-?con \((l|r)\)|joy-?con (l|r)\b/.test(s) && !/l\+r|\(l\/r\)/.test(s)) return 'joycon';
    if (/nintendo|joy-?con|pro controller|057e/.test(s)) return 'switch';
    if (/xbox|xinput|045e|microsoft/.test(s)) return 'xbox';
    if (/playstation|dualshock|dualsense|054c|sony|wireless controller|ps[345]/.test(s)) return 'ps';
    return 'other';
  }

  const DEAD = 0.18;
  function deadzone(x, y) {
    const m = Math.hypot(x, y);
    if (m < DEAD) return { x: 0, y: 0, m: 0 };
    const k = Math.min(1, (m - DEAD) / (1 - DEAD)) / m;
    return { x: x * k, y: y * k, m: m * k };
  }

  // A POV hat reported as one axis: -1 = up, then clockwise in steps of 2/7.
  function hat(v) {
    if (v == null || v < -1.05 || v > 1.05) return null;
    const step = Math.round((v + 1) / (2 / 7));
    if (step < 0 || step > 7) return null;
    const a = -Math.PI / 2 + step * (Math.PI / 4);
    return { x: Math.round(Math.cos(a) * 100) / 100, y: Math.round(Math.sin(a) * 100) / 100 };
  }

  // Pure: turns a Gamepad snapshot into an input frame. `st` keeps edges and aim.
  function readPad(p, st) {
    const standard = p.mapping === 'standard';
    const axes = p.axes || [];
    const ax = (i) => axes[i] || 0;
    const pressed = p.buttons.map((b) => !!(b && (b.pressed || b.value > 0.5)));
    const prev = st.prev || [];
    const edge = (i) => (pressed[i] && !prev[i] ? 1 : 0);
    const any = (list) => list.reduce((a, i) => a + edge(i), 0);
    st.prev = pressed;
    let move = deadzone(ax(0), ax(1));
    let aim = null;
    let navX = 0, navY = 0; // menus move with the D-pad only
    let fire, mine, pause;
    if (standard) {
      const dx = (pressed[15] ? 1 : 0) - (pressed[14] ? 1 : 0), dy = (pressed[13] ? 1 : 0) - (pressed[12] ? 1 : 0);
      navX = dx; navY = dy;
      if (!move.m && (dx || dy)) { const d = Math.hypot(dx, dy); move = { x: dx / d, y: dy / d, m: 1 }; }
      if (axes.length >= 4) aim = deadzone(ax(2), ax(3));
      fire = any([7, 5, 0, 3]);
      mine = any([6, 4, 1, 2]);
      pause = any([9, 8]);
      // menus: A (✕ / Switch B) presses the highlighted button, the
      // triggers and bumpers mean "I'm ready", the right face button backs out
      st.ok = edge(0); st.ready = any([7, 5]); st.back = edge(1);
    } else {
      // generic pad: hat switch (usually axis 9) when the stick is idle
      for (const hi of [9, 6, 7]) {
        const h = axes.length > hi && Math.abs(ax(hi)) <= 1.05 && Math.abs(ax(hi)) > 0.01 ? hat(ax(hi)) : null;
        if (h) {
          navX = Math.round(h.x); navY = Math.round(h.y);
          if (!move.m) move = { x: h.x, y: h.y, m: 1 };
          break;
        }
      }
      // a single Joy-Con's only stick is its D-pad
      if (st.family === 'joycon' && !navX && !navY && move.m > 0.6) { navX = move.x; navY = move.y; }
      if (axes.length >= 4 && st.family !== 'joycon') {
        // right stick is axes 2/3 on most pads, 2/5 or 3/4 on some
        const a = deadzone(ax(2), ax(axes.length > 5 && Math.abs(ax(3)) < 0.01 ? 5 : 3));
        aim = a;
      }
      if (st.family === 'joycon') {
        fire = any([0, 1, 2, 3, 5]);
        mine = any([4]);
        pause = any([8, 9, 12, 13]);
      } else {
        fire = any([0, 5, 7, 3]);
        mine = any([1, 4, 6, 2]);
        pause = any([9]);
      }
      if (st.family !== 'joycon') { st.ok = edge(0); st.ready = any([5, 7]); st.back = edge(1); }
      else { st.ok = fire; st.ready = 0; st.back = mine; }
    }
    let aimActive = false;
    if (aim && aim.m > 0.2) {
      st.lastAim = { x: aim.x, y: aim.y };
      aimActive = true;
    } else if (!aim) {
      // no second stick: the turret points where you drive
      if (move.m > 0.3) { st.lastAim = { x: move.x, y: move.y }; aimActive = true; }
    }
    const la = st.lastAim || { x: 1, y: 0 };
    return {
      moveX: move.x, moveY: move.y, aimMode: 'dir', aimX: la.x, aimY: la.y, aimActive,
      rotate: 0, fire, mine, pause, snapOnFire: false, navX, navY,
      ok: st.ok || 0, ready: st.ready || 0, back: st.back || 0,
    };
  }

  class GamepadController {
    constructor(pad, choice = 'gamepad') {
      this.kind = 'gamepad';
      this.choice = choice;
      this.index = pad.index;
      this.id = pad.id;
      this.family = padFamily(pad.id);
      if (this.family === 'other' && choice.startsWith('pad-')) this.family = choice.slice(4);
      const f = FAMILIES[this.family] || FAMILIES.other;
      this.label = f.name;
      this.detail = `${shortPadName(pad.id)} · fire ${f.fire} · mine ${f.mine}`;
      this.st = { prev: pad.buttons.map((b) => !!(b && b.pressed)), family: this.family, lastAim: { x: 1, y: 0 } };
    }

    get pad() {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      return pads[this.index] || null;
    }

    get connected() {
      const p = this.pad;
      return !!(p && p.connected);
    }

    read() {
      const p = this.pad;
      if (!p) return Object.assign({}, RR.NO_INPUT, { pause: 0 });
      return readPad(p, this.st);
    }

    rumble(ms, strength) {
      const p = this.pad;
      const act = p && p.vibrationActuator;
      if (act && act.playEffect) {
        act.playEffect('dual-rumble', { duration: ms, strongMagnitude: strength, weakMagnitude: strength * 0.6 }).catch(() => {});
      }
    }

    dispose() {}
  }

  function shortPadName(id) {
    const s = String(id || '').replace(/\(.*?(vendor|product|STANDARD GAMEPAD).*?\)/gi, '').replace(/\s+/g, ' ').trim();
    return s.length > 28 ? s.slice(0, 26) + '…' : s || 'Controller';
  }

  RR.Pad = { readPad, padFamily, hat, FAMILIES };
  RR.Input = Input;
  RR.KeyboardMouseController = KeyboardMouseController;
  RR.KeyboardArrowsController = KeyboardArrowsController;
  RR.GamepadController = GamepadController;
})();
