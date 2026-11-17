// Ricochet Rumble — CPU tank brains. Produces the same input frames a
// controller would, so CPU tanks follow exactly the same rules as players.
//   Aiming: traces where a shell would go (bouncing off walls like the real
//   thing) and fires when that path hits an enemy without hitting itself or
//   a team-mate first. Better tanks plan bank shots.
//   Moving: wanders between open tiles at a comfortable distance from the
//   nearest enemy, steps aside from incoming shells and avoids mines.
window.RR = window.RR || {};

(function () {
  const C = RR.CFG;
  const T = RR.TILE;
  const U = RR.util;

  const rand = (a, b) => a + Math.random() * (b - a);
  const blocksShell = (t) => t === T.WALL || t === T.CRATE;
  const blocksTank = (t) => t !== T.FLOOR;

  // Where would a shell fired at `angle` from tank `t` go? Returns the first
  // tank it would hit (or null) and the distance travelled.
  function traceShot(w, t, angle, bounces, maxLen = 30) {
    const STEP = 0.11;
    const br = C.BULLET_RADIUS;
    const hitR = C.TANK_HIT_RADIUS + br + 0.04;
    let vx = Math.cos(angle), vy = Math.sin(angle);
    // the barrel must be clear (otherwise the shell fizzles)
    for (let d = 0.2; d <= C.BARREL_LEN; d += 0.1) {
      if (w.circleHits(t.x + vx * d, t.y + vy * d, br, blocksShell)) return { hit: null, len: 0, fizzle: true };
    }
    let x = t.x + vx * C.BARREL_LEN, y = t.y + vy * C.BARREL_LEN;
    let b = 0, len = 0;
    while (len < maxLen) {
      let bounced = false;
      x += vx * STEP;
      if (w.circleHits(x, y, br, blocksShell)) { x -= vx * STEP; vx = -vx; bounced = true; }
      y += vy * STEP;
      if (w.circleHits(x, y, br, blocksShell)) { y -= vy * STEP; vy = -vy; bounced = true; }
      if (bounced && ++b > bounces) return { hit: null, len };
      len += STEP;
      for (const o of w.tanks) {
        if (!o.alive) continue;
        // ignore our own hull until the shell has had a chance to leave it
        if (o === t && len < 1.2) continue;
        const dx = o.x - x, dy = o.y - y;
        if (dx * dx + dy * dy < hitR * hitR) return { hit: o, len, bounces: b };
      }
    }
    return { hit: null, len };
  }

  // Shortest route over the tile grid (4-way), avoiding tiles near mines.
  function path(w, from, to, avoid) {
    const W = C.COLS, H = C.ROWS;
    const start = Math.floor(from.y) * W + Math.floor(from.x);
    const goal = Math.floor(to.y) * W + Math.floor(to.x);
    const prev = new Int32Array(W * H).fill(-1);
    prev[start] = start;
    const q = [start];
    for (let qi = 0; qi < q.length; qi++) {
      const cur = q[qi];
      if (cur === goal) break;
      const cx = cur % W, cy = (cur / W) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = ny * W + nx;
        if (prev[n] !== -1 || blocksTank(w.tileAt(nx, ny)) || avoid(nx + 0.5, ny + 0.5)) continue;
        prev[n] = cur;
        q.push(n);
      }
    }
    if (prev[goal] === -1) return null;
    const out = [];
    for (let n = goal; n !== start; n = prev[n]) out.push({ x: (n % W) + 0.5, y: ((n / W) | 0) + 0.5 });
    return out.reverse();
  }

  function enemiesOf(w, t) {
    return w.tanks.filter((o) => o.alive && o !== t && o.team !== t.team);
  }

  function think(w, t, dt) {
    const cfg = t.ai;
    const st = t.brain || (t.brain = { fireTimer: rand(1.0, 2.0), planTimer: rand(0, 0.3), plan: null, route: [], routeTimer: 0, dodge: 0, dodgeX: 0, dodgeY: 0, mineTimer: rand(4, 7) });
    const out = { moveX: 0, moveY: 0, aimMode: 'dir', aimX: Math.cos(t.turret), aimY: Math.sin(t.turret), aimActive: true, rotate: 0, fire: 0, mine: 0, snapOnFire: false };
    if (w.frozen) return out;
    const foes = enemiesOf(w, t);
    if (!foes.length) return out;
    let target = foes[0], best = Infinity;
    for (const f of foes) {
      const d = Math.hypot(f.x - t.x, f.y - t.y);
      if (d < best) { best = d; target = f; }
    }

    // ---- aiming --------------------------------------------------------------
    st.fireTimer -= dt;
    st.planTimer -= dt;
    const bounces = t.shotBounces();
    if (st.planTimer <= 0) {
      st.planTimer = rand(0.3, 0.45);
      st.plan = null;
      const direct = Math.atan2(target.y - t.y, target.x - t.x);
      const tryAngle = (a) => {
        const r = traceShot(w, t, a, bounces);
        return r.hit && r.hit.team !== t.team ? r : null;
      };
      // straight at someone first (aimed at the closest enemy, then the rest)
      for (const f of [target, ...foes.filter((x) => x !== target)]) {
        const a = Math.atan2(f.y - t.y, f.x - t.x);
        const r = tryAngle(a);
        if (r && r.bounces === 0) { st.plan = { angle: a, len: r.len }; break; }
      }
      // then bank shots: sweep round and keep the shortest path that works
      if (!st.plan && cfg.bank > 0) {
        let found = null;
        const N = 56, off = Math.random() * (U.TAU / N);
        for (let k = 0; k < N; k++) {
          const a = off + (k / N) * U.TAU;
          const r = traceShot(w, t, a, Math.min(bounces, cfg.bank));
          if (r.hit && r.hit.team !== t.team && (!found || r.len < found.len)) found = { angle: a, len: r.len };
        }
        st.plan = found;
      }
      if (st.plan) st.plan.angle += (Math.random() - 0.5) * 2 * cfg.aimError;
      st.track = direct;
    }
    const aim = st.plan ? st.plan.angle : st.track != null ? st.track : t.turret;
    out.aimX = Math.cos(aim);
    out.aimY = Math.sin(aim);
    if (st.plan && st.fireTimer <= 0 && Math.abs(U.angleDiff(t.turret, aim)) < 0.05 && w.shellsInFlight(t.index) < t.maxShells()) {
      out.fire = 1;
      st.fireTimer = rand(cfg.every[0], cfg.every[1]);
      st.plan = null;
      st.planTimer = 0.15;
    }

    // ---- mines -------------------------------------------------------------------
    if (cfg.mines > 0 && w.minesEnabled) {
      st.mineTimer -= dt;
      if (st.mineTimer <= 0 || (best < 3.2 && st.mineTimer < 3)) {
        if (!w.mines.some((m) => Math.hypot(m.x - t.x, m.y - t.y) < 2)) {
          out.mine = 1;
          st.mineTimer = rand(6, 10);
          st.routeTimer = 0; // move off it
        }
      }
    }

    if (t.ai.speed <= 0) return out;

    // ---- dodging -------------------------------------------------------------------
    st.dodge -= dt;
    if (cfg.dodge && st.dodge <= 0) {
      for (const b of w.bullets) {
        const rx = t.x - b.x, ry = t.y - b.y;
        const sp2 = b.vx * b.vx + b.vy * b.vy;
        const tc = (rx * b.vx + ry * b.vy) / sp2;
        if (tc < 0 || tc > 0.7) continue;
        const cx = b.x + b.vx * tc - t.x, cy = b.y + b.vy * tc - t.y;
        if (cx * cx + cy * cy > 0.8 * 0.8) continue;
        // step sideways, away from the shell's line
        const sp = Math.sqrt(sp2);
        let px = -b.vy / sp, py = b.vx / sp;
        if (px * -cx + py * -cy < 0) { px = -px; py = -py; }
        if (w.circleHits(t.x + px * 0.6, t.y + py * 0.6, C.TANK_RADIUS, blocksTank)) { px = -px; py = -py; }
        st.dodge = 0.4;
        st.dodgeX = px;
        st.dodgeY = py;
        break;
      }
    }
    if (st.dodge > 0) {
      out.moveX = st.dodgeX;
      out.moveY = st.dodgeY;
      return out;
    }

    // ---- wandering -------------------------------------------------------------------
    const nearMine = (x, y) => w.mines.some((m) => Math.hypot(m.x - x, m.y - y) < (m.owner === t.index ? 1.1 : 1.6));
    st.routeTimer -= dt;
    if (st.routeTimer <= 0 || !st.route.length) {
      st.routeTimer = rand(1.5, 3.2);
      // pick an open tile nearby, ideally 4-7 tiles from the target
      let goal = null, score = -Infinity;
      for (let k = 0; k < 24; k++) {
        const gx = Math.floor(t.x + rand(-4.5, 4.5)) + 0.5, gy = Math.floor(t.y + rand(-4.5, 4.5)) + 0.5;
        if (gx < 0.5 || gy < 0.5 || gx > C.COLS - 0.5 || gy > C.ROWS - 0.5) continue;
        if (blocksTank(w.tileAt(Math.floor(gx), Math.floor(gy))) || nearMine(gx, gy)) continue;
        const d = Math.hypot(target.x - gx, target.y - gy);
        const sc = -Math.abs(d - 5.5) + Math.random() * 1.5;
        if (sc > score) { score = sc; goal = { x: gx, y: gy }; }
      }
      st.route = goal ? path(w, t, goal, nearMine) || [] : [];
    }
    if (st.route.length) {
      let wp = st.route[0];
      if (Math.hypot(wp.x - t.x, wp.y - t.y) < 0.25) {
        st.route.shift();
        wp = st.route[0];
      }
      if (wp) {
        const dx = wp.x - t.x, dy = wp.y - t.y, d = Math.hypot(dx, dy) || 1;
        // full stick; CPU speed comes from the tank's speed factor
        out.moveX = dx / d;
        out.moveY = dy / d;
      }
    }
    return out;
  }

  RR.AI = { think, traceShot, path };
})();
