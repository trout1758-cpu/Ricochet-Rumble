// Ricochet Rumble — drive the menus with any controller.
// Each player gets a coloured highlight. The D-pad (arrow keys, or the stick
// on a phone, which has no D-pad) moves it to the nearest button in that direction, fire (A on a Wii Remote) presses it.
// On a drop-down, left/right changes the value. Drop-downs marked
// data-nav-commit (the controller pickers) only apply on fire, so scrolling
// through them doesn't connect anything by accident.
window.RR = window.RR || {};

(function () {
  const SEL = 'button, select, [data-nav]';

  function usable(el) {
    if (el.disabled || el.closest('.hidden') || el.closest('[data-nonav]')) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) {
      // allow things in a scrolling panel
      if (!el.closest('.panel')) return false;
    }
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  // nearest item from `from` in direction `dir`
  function pick(from, items, dir) {
    const a = from.getBoundingClientRect();
    const acx = a.left + a.width / 2, acy = a.top + a.height / 2;
    let best = null, bs = Infinity;
    for (const el of items) {
      if (el === from) continue;
      const b = el.getBoundingClientRect();
      const bcx = b.left + b.width / 2, bcy = b.top + b.height / 2;
      let along, gap, off;
      if (dir === 'down') { along = b.top - a.bottom; gap = Math.max(0, Math.max(a.left, b.left) - Math.min(a.right, b.right)); off = Math.abs(bcx - acx); if (bcy <= acy + 4) continue; }
      else if (dir === 'up') { along = a.top - b.bottom; gap = Math.max(0, Math.max(a.left, b.left) - Math.min(a.right, b.right)); off = Math.abs(bcx - acx); if (bcy >= acy - 4) continue; }
      else if (dir === 'right') { along = b.left - a.right; gap = Math.max(0, Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom)); off = Math.abs(bcy - acy); if (bcx <= acx + 4) continue; }
      else { along = a.left - b.right; gap = Math.max(0, Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom)); off = Math.abs(bcy - acy); if (bcx >= acx - 4) continue; }
      const score = Math.max(-8, along) + gap * 3 + off * 0.15;
      if (score < bs) { bs = score; best = el; }
    }
    return best;
  }

  function options(sel) {
    return Array.from(sel.options).filter((o) => !o.hidden && !o.disabled);
  }

  function cycle(sel, d, commit) {
    const opts = options(sel);
    if (!opts.length) return;
    let k = opts.findIndex((o) => o.value === sel.value);
    k = (k + d + opts.length) % opts.length;
    sel.value = opts[k].value;
    if (commit) sel.dispatchEvent(new Event('change', { bubbles: true }));
    else sel.dataset.pending = '1';
  }

  function dropPending(el) {
    if (el && el.tagName === 'SELECT' && el.dataset.pending) {
      delete el.dataset.pending;
      if (Nav.onRevert) Nav.onRevert(el);
    }
  }

  const st = [];
  function ringFor(i) {
    const s = st[i];
    if (!s.ring) {
      s.ring = document.createElement('div');
      s.ring.className = 'nav-ring hidden';
      s.ring.innerHTML = '<b></b>';
      document.body.appendChild(s.ring);
    }
    return s.ring;
  }

  const Nav = {
    onMove: null,      // () => sound
    onRevert: null,    // (select) => put back the real value
    // i: player index · inp: its input frame (null = none) · scope: element
    // to move within (null = off) · def: default element · color/label: ring
    update(dt, i, inp, scope, def, color, label) {
      const s = st[i] || (st[i] = { el: null, dir: null, t: 0, ring: null });
      const ring = s.ring;
      if (!inp || !scope) {
        if (ring) ring.classList.add('hidden');
        dropPending(s.el);
        s.el = null;
        s.dir = null;
        return false;
      }
      const items = Array.from(scope.querySelectorAll(SEL)).filter(usable);
      if (!s.el || !items.includes(s.el)) {
        dropPending(s.el);
        s.el = def && items.includes(def) ? def : items[0] || null;
      }
      // a Wii Remote pointing at the screen clicks with its pointer instead
      const pointing = inp.screenX != null;
      let dir = null;
      const dpad = inp.navX != null;
      const x = (dpad ? inp.navX : inp.moveX) || 0, y = (dpad ? inp.navY : inp.moveY) || 0;
      if (Math.hypot(x, y) > 0.6) dir = Math.abs(x) > Math.abs(y) ? (x > 0 ? 'right' : 'left') : (y > 0 ? 'down' : 'up');
      let stepNow = false;
      if (dir !== s.dir) { s.dir = dir; s.t = 0.4; stepNow = !!dir; }
      else if (dir) { s.t -= dt; if (s.t <= 0) { s.t = 0.14; stepNow = true; } }
      let acted = false;
      if (stepNow && s.el) {
        if (s.el.tagName === 'SELECT' && (dir === 'left' || dir === 'right')) {
          cycle(s.el, dir === 'right' ? 1 : -1, !s.el.hasAttribute('data-nav-commit'));
          if (Nav.onMove) Nav.onMove();
        } else {
          const n = pick(s.el, items, dir);
          if (n) {
            dropPending(s.el);
            s.el = n;
            if (n.closest('.panel')) n.scrollIntoView({ block: 'nearest' });
            if (Nav.onMove) Nav.onMove();
          }
        }
      }
      const press = 'click' in inp ? inp.click : inp.fire;
      if (press > 0 && s.el && !pointing) {
        const el = s.el;
        if (el.tagName === 'SELECT') {
          if (el.dataset.pending) { delete el.dataset.pending; el.dispatchEvent(new Event('change', { bubbles: true })); }
          else cycle(el, 1, !el.hasAttribute('data-nav-commit'));
        } else {
          el.click();
        }
        acted = true;
      }
      // draw the highlight
      const r = ringFor(i);
      if (s.el && !pointing) {
        const b = s.el.getBoundingClientRect();
        r.classList.remove('hidden');
        r.style.transform = `translate(${b.left - 5}px, ${b.top - 5}px)`;
        r.style.width = `${b.width + 10}px`;
        r.style.height = `${b.height + 10}px`;
        r.style.setProperty('--pc', color);
        r.querySelector('b').textContent = label;
      } else {
        r.classList.add('hidden');
      }
      return acted;
    },
    current(i) { return st[i] ? st[i].el : null; },
  };

  RR.MenuNav = Nav;
})();
