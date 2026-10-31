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

  // Standard-mapping gamepad (Xbox / PlayStation / Switch Pro over USB or BT).
  class GamepadController {
    constructor(pad) {
      this.kind = 'gamepad';
      this.index = pad.index;
      this.id = pad.id;
      this.label = 'Gamepad ' + (pad.index + 1);
      this.detail = shortPadName(pad.id);
      this.prev = pad.buttons.map((b) => b.pressed);
      this.lastAim = { x: 1, y: 0 };
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
      const ax = (i) => (p.axes[i] || 0);
      const pressed = p.buttons.map((b) => b.pressed || b.value > 0.5);
      const edge = (i) => (pressed[i] && !this.prev[i] ? 1 : 0);
      let fire = edge(7) + edge(5) + edge(0);
      let mine = edge(6) + edge(4) + edge(1);
      const pause = edge(9);
      this.prev = pressed;
      const rx = ax(2), ry = ax(3);
      const aimActive = Math.hypot(rx, ry) > 0.35;
      if (aimActive) this.lastAim = { x: rx, y: ry };
      return {
        moveX: ax(0), moveY: ax(1), aimMode: 'dir', aimX: this.lastAim.x, aimY: this.lastAim.y, aimActive,
        rotate: 0, fire, mine, pause, snapOnFire: false,
      };
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
    const s = String(id || '').replace(/\(.*?\)/g, '').trim();
    return s.length > 28 ? s.slice(0, 26) + '…' : s || 'Controller';
  }

  RR.Input = Input;
  RR.KeyboardMouseController = KeyboardMouseController;
  RR.KeyboardArrowsController = KeyboardArrowsController;
  RR.GamepadController = GamepadController;
})();
