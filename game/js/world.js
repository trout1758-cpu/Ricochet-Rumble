// Ricochet Rumble — game simulation. No rendering or DOM in here, so it can
// run headless in the tests (see tests/run.js).
window.RR = window.RR || {};

(function () {
  const C = RR.CFG;
  const T = RR.TILE;
  const U = RR.util;

  const NO_INPUT = Object.freeze({
    moveX: 0, moveY: 0, aimMode: 'none', aimX: 0, aimY: 0, aimActive: false,
    rotate: 0, fire: 0, mine: 0, snapOnFire: false,
  });

  // 0..1 level for a repeating calm / rising / high / falling cycle.
  function cycleLevel(clock, [calm, rise, high, fall]) {
    const t = clock % (calm + rise + high + fall);
    if (t < calm) return 0;
    if (t < calm + rise) return (t - calm) / rise;
    if (t < calm + rise + high) return 1;
    return 1 - (t - calm - rise - high) / fall;
  }

  class Tank {
    constructor(index, spawn, color) {
      this.index = index;
      this.color = color;
      this.x = spawn.x;
      this.y = spawn.y;
      this.vx = 0;
      this.vy = 0;
      this.angle = spawn.angle;
      this.turret = spawn.angle;
      this.turretTarget = spawn.angle;
      this.alive = true;
      this.cooldown = 0;
      this.mineCooldown = 0;
      this.driveDir = 1;
      this.speed = 0;
      this.turning = 0;
      this.recoil = 0;
      this.treadPhase = 0;
      this.markDist = 0;
    }
  }

  class World {
    // opts: { ammo, minesEnabled, effects, colors: [color, color] }
    constructor(arenaDef, opts) {
      const arena = RR.buildArena(arenaDef);
      this.arena = arena;
      this.theme = arena.theme;
      this.grid = arena.grid;
      this.gridVersion = 0;
      this.ammo = opts.ammo || C.AMMO.classic;
      this.minesEnabled = opts.minesEnabled !== false;
      this.tanks = arena.spawns.map((s, i) => new Tank(i, s, opts.colors[i]));
      this.bullets = [];
      this.mines = [];
      this.events = [];
      this.time = 0;
      this.frozen = true; // tanks can aim but not drive or shoot (round intro)
      this.nextId = 1;
      this.setupMechanic(opts.effects === false ? null : arena.themeKey);
    }

    // ---- theme mechanics -----------------------------------------------------------
    setupMechanic(key) {
      this.mechKey = null;
      this.holes = [];
      this.lavaTiles = [];
      this.shallow = new Uint8Array(C.COLS * C.ROWS);
      this.eruptions = [];
      this.regrow = [];
      this.tide = 0;
      this.storm = 0;
      this.mechClock = 0;
      if (!key || !C.MECH[key]) {
        this.mechanic = null;
        return;
      }
      let pits = 0, crates = 0, shallow = 0;
      for (let r = 0; r < C.ROWS; r++) {
        for (let c = 0; c < C.COLS; c++) {
          const t = this.tileAt(c, r);
          if (t === T.CRATE) crates++;
          if (t !== T.PIT) continue;
          pits++;
          if (key === 'space') this.holes.push({ x: c + 0.5, y: r + 0.5 });
          if (key === 'volcano') this.lavaTiles.push({ x: c + 0.5, y: r + 0.5 });
          if (key === 'beach') {
            for (let dr = -1; dr <= 1; dr++) {
              for (let dc = -1; dc <= 1; dc++) {
                if (this.tileAt(c + dc, r + dr) === T.FLOOR && !this.shallow[(r + dr) * C.COLS + c + dc]) {
                  this.shallow[(r + dr) * C.COLS + c + dc] = 1;
                  shallow++;
                }
              }
            }
          }
        }
      }
      const applies = {
        space: pits > 0, volcano: pits > 0, beach: shallow > 0, garden: crates > 0,
      }[key];
      if (applies === false) {
        this.mechanic = null;
        return;
      }
      this.mechKey = key;
      this.mechanic = C.MECH[key];
      this.eruptTimer = C.ERUPT_FIRST;
    }

    updateMechanic(dt) {
      this.mechClock += dt;
      switch (this.mechKey) {
        case 'beach':
          this.tide = cycleLevel(this.mechClock, C.TIDE_CYCLE);
          break;
        case 'sandbox':
          this.storm = cycleLevel(this.mechClock, C.STORM_CYCLE);
          break;
        case 'volcano':
          this.updateEruptions(dt);
          break;
        case 'garden':
          this.updateRegrow(dt);
          break;
      }
    }

    // Opposite point for the arena's symmetry, so random events stay fair.
    mirrorPoint(x, y) {
      return this.arena.sym === 'rotate' ? [C.COLS - x, C.ROWS - y] : [C.COLS - x, y];
    }

    updateEruptions(dt) {
      this.eruptTimer -= dt;
      if (this.eruptTimer <= 0) {
        const [lo, hi] = C.ERUPT_EVERY;
        this.eruptTimer = lo + Math.random() * (hi - lo);
        this.spawnEruption();
      }
      for (const e of this.eruptions) {
        e.t += dt;
        if (e.t >= e.fuse && !e.done) {
          e.done = true;
          this.blast(e.tx, e.ty, C.ERUPT_RADIUS, null, 'eruption');
        }
      }
      this.eruptions = this.eruptions.filter((e) => !e.done);
    }

    spawnEruption(target) {
      const src = this.lavaTiles[Math.floor(Math.random() * this.lavaTiles.length)];
      let tx = null, ty = null;
      if (target) {
        tx = target.x;
        ty = target.y;
      } else {
        for (let i = 0; i < 16 && tx === null; i++) {
          const a = Math.random() * U.TAU, d = 2 + Math.random() * 3.5;
          const x = src.x + Math.cos(a) * d, y = src.y + Math.sin(a) * d;
          if (x < 0.7 || y < 0.7 || x > C.COLS - 0.7 || y > C.ROWS - 0.7) continue;
          if (this.tileAt(Math.floor(x), Math.floor(y)) !== T.FLOOR) continue;
          tx = x;
          ty = y;
        }
        if (tx === null) return;
      }
      const [mtx, mty] = this.mirrorPoint(tx, ty);
      const [msx, msy] = this.mirrorPoint(src.x, src.y);
      const pair = [
        { fx: src.x, fy: src.y, tx, ty, t: 0, fuse: C.ERUPT_FUSE },
        { fx: msx, fy: msy, tx: mtx, ty: mty, t: 0, fuse: C.ERUPT_FUSE },
      ];
      // Targets on the symmetry line would overlap; one is enough.
      if (Math.hypot(tx - mtx, ty - mty) < 0.5) pair.pop();
      for (const e of pair) {
        this.eruptions.push(e);
        this.emit({ type: 'eruption', x: e.fx, y: e.fy, tx: e.tx, ty: e.ty });
      }
    }

    updateRegrow(dt) {
      const r = C.TANK_RADIUS;
      for (const g of this.regrow) {
        g.t -= dt;
        if (g.t > 0) continue;
        // Wait until nothing is sitting on the tile.
        const blocked = this.tanks.some((t) => {
          if (!t.alive) return false;
          const nx = U.clamp(t.x, g.c, g.c + 1), ny = U.clamp(t.y, g.r, g.r + 1);
          return Math.hypot(t.x - nx, t.y - ny) < r + 0.05;
        }) || this.mines.some((m) => Math.floor(m.x) === g.c && Math.floor(m.y) === g.r)
          || this.bullets.some((b) => Math.floor(b.x) === g.c && Math.floor(b.y) === g.r);
        if (blocked) continue;
        this.setTile(g.c, g.r, T.CRATE);
        g.done = true;
        this.emit({ type: 'crateRegrow', c: g.c, r: g.r });
      }
      this.regrow = this.regrow.filter((g) => !g.done);
    }

    inShallows(t) {
      if (this.mechKey !== 'beach' || this.tide < 0.5) return false;
      return this.shallow[Math.floor(t.y) * C.COLS + Math.floor(t.x)] === 1;
    }

    // ---- tiles -------------------------------------------------------------
    tileAt(c, r) {
      if (c < 0 || r < 0 || c >= C.COLS || r >= C.ROWS) return T.WALL;
      return this.grid[r * C.COLS + c];
    }

    setTile(c, r, t) {
      this.grid[r * C.COLS + c] = t;
      this.gridVersion++;
    }

    static blocksShell(t) {
      return t === T.WALL || t === T.CRATE;
    }

    static blocksTank(t) {
      return t !== T.FLOOR;
    }

    circleHits(x, y, r, blocks) {
      const c0 = Math.floor(x - r), c1 = Math.floor(x + r);
      const r0 = Math.floor(y - r), r1 = Math.floor(y + r);
      for (let row = r0; row <= r1; row++) {
        for (let col = c0; col <= c1; col++) {
          if (!blocks(this.tileAt(col, row))) continue;
          const nx = U.clamp(x, col, col + 1);
          const ny = U.clamp(y, row, row + 1);
          const dx = x - nx, dy = y - ny;
          if (dx * dx + dy * dy < r * r) return true;
        }
      }
      return false;
    }

    // Push a circle out of any tiles that block tanks.
    resolveTank(t) {
      const r = C.TANK_RADIUS;
      for (let iter = 0; iter < 4; iter++) {
        let moved = false;
        const c0 = Math.floor(t.x - r), c1 = Math.floor(t.x + r);
        const r0 = Math.floor(t.y - r), r1 = Math.floor(t.y + r);
        for (let row = r0; row <= r1; row++) {
          for (let col = c0; col <= c1; col++) {
            if (!World.blocksTank(this.tileAt(col, row))) continue;
            const nx = U.clamp(t.x, col, col + 1);
            const ny = U.clamp(t.y, row, row + 1);
            const dx = t.x - nx, dy = t.y - ny;
            const d2 = dx * dx + dy * dy;
            if (d2 >= r * r) continue;
            if (d2 > 1e-10) {
              const d = Math.sqrt(d2);
              const push = (r - d) / d;
              t.x += dx * push;
              t.y += dy * push;
            } else {
              // Centre is inside the tile: leave through the nearest edge.
              const left = t.x - col, right = col + 1 - t.x;
              const top = t.y - row, bottom = row + 1 - t.y;
              const m = Math.min(left, right, top, bottom);
              if (m === left) t.x = col - r;
              else if (m === right) t.x = col + 1 + r;
              else if (m === top) t.y = row - r;
              else t.y = row + 1 + r;
            }
            moved = true;
          }
        }
        if (!moved) break;
      }
    }

    // ---- queries used by the HUD ----------------------------------------------
    shellsInFlight(i) {
      let n = 0;
      for (const b of this.bullets) if (b.owner === i) n++;
      return n;
    }

    shellsLeft(i) {
      return this.ammo.max - this.shellsInFlight(i);
    }

    minesLeft(i) {
      if (!this.minesEnabled) return 0;
      let n = 0;
      for (const m of this.mines) if (m.owner === i) n++;
      return C.MINE_MAX - n;
    }

    aliveTanks() {
      return this.tanks.filter((t) => t.alive);
    }

    emit(ev) {
      ev.time = this.time;
      this.events.push(ev);
    }

    // ---- simulation -------------------------------------------------------------
    update(dt, inputs) {
      this.time += dt;
      for (const t of this.tanks) {
        if (t.alive) this.updateTank(t, inputs[t.index] || NO_INPUT, dt);
      }
      this.collideTanks();
      if (!this.frozen && this.mechKey) this.updateMechanic(dt);
      this.updateBullets(dt);
      this.updateMines(dt);
    }

    updateTank(t, inp, dt) {
      t.cooldown -= dt;
      t.mineCooldown -= dt;
      t.recoil = Math.max(0, t.recoil - dt * 5);

      // Turret
      if (inp.aimMode === 'point') {
        const dx = inp.aimX - t.x, dy = inp.aimY - t.y;
        if (dx * dx + dy * dy > 0.01) t.turretTarget = Math.atan2(dy, dx);
      } else if (inp.aimMode === 'dir') {
        if (inp.aimActive && Math.hypot(inp.aimX, inp.aimY) > 0.2) {
          t.turretTarget = Math.atan2(inp.aimY, inp.aimX);
        }
      } else if (inp.aimMode === 'rotate') {
        t.turretTarget = U.wrapAngle(t.turret + inp.rotate * C.TURRET_TURN_RATE * 0.3 * dt);
      }
      t.turret = U.approachAngle(t.turret, t.turretTarget, C.TURRET_TURN_RATE * dt);

      if (this.frozen) {
        t.speed = 0;
        t.turning = 0;
        t.vx = t.vy = 0;
        return;
      }

      // Hull: steer toward the stick direction, driving forwards or in
      // reverse — whichever needs less turning.
      let mx = inp.moveX, my = inp.moveY;
      let m = Math.hypot(mx, my);
      let wantVx = 0, wantVy = 0;
      t.speed = 0;
      t.turning = 0;
      if (m > 0.18) {
        mx /= m; my /= m;
        m = U.clamp((m - 0.18) / 0.67, 0, 1);
        const target = Math.atan2(my, mx);
        const dF = U.angleDiff(target, t.angle);
        const dB = U.angleDiff(target, t.angle + Math.PI);
        const cur = t.driveDir === 1 ? dF : dB;
        const other = t.driveDir === 1 ? dB : dF;
        if (Math.abs(other) + 0.35 < Math.abs(cur)) t.driveDir = -t.driveDir;
        const diff = t.driveDir === 1 ? dF : dB;
        const turn = U.clamp(diff, -C.TANK_TURN_RATE * dt, C.TANK_TURN_RATE * dt);
        t.angle = U.wrapAngle(t.angle + turn);
        t.turning = turn / dt;
        const rem = Math.abs(diff - turn);
        const align = rem < 0.3 ? 1 : rem > 1.15 ? 0 : 1 - (rem - 0.3) / 0.85;
        const slow = this.inShallows(t) ? C.TIDE_SLOW : 1;
        t.speed = C.TANK_SPEED * m * align * t.driveDir * slow;
        wantVx = Math.cos(t.angle) * t.speed;
        wantVy = Math.sin(t.angle) * t.speed;
      }

      // On ice the hull only gradually catches up with the stick.
      const ice = this.mechKey === 'frost';
      if (ice) {
        const k = 1 - Math.exp(-C.ICE_GRIP * dt);
        t.vx += (wantVx - t.vx) * k;
        t.vy += (wantVy - t.vy) * k;
        if (Math.hypot(t.vx, t.vy) < 0.02 && !wantVx && !wantVy) t.vx = t.vy = 0;
      } else {
        t.vx = wantVx;
        t.vy = wantVy;
      }
      if (t.vx || t.vy) {
        const ox = t.x, oy = t.y;
        t.x += t.vx * dt;
        t.y += t.vy * dt;
        this.resolveTank(t);
        const dx = t.x - ox, dy = t.y - oy;
        // Walls soak up the slide.
        if (ice) {
          t.vx = dx / dt;
          t.vy = dy / dt;
        }
        const moved = Math.hypot(dx, dy);
        const forward = dx * Math.cos(t.angle) + dy * Math.sin(t.angle);
        t.treadPhase += moved * (forward < 0 ? -1 : 1);
        t.markDist += moved;
      }
      if (Math.abs(t.turning) > 0.1) t.treadPhase += Math.abs(t.turning) * dt * 0.15;
      if (t.markDist > 0.13) {
        t.markDist = 0;
        this.emit({ type: 'tread', x: t.x, y: t.y, angle: t.angle });
      }

      if (inp.fire > 0) this.tryFire(t, inp);
      if (inp.mine > 0) this.tryMine(t);
    }

    collideTanks() {
      const [a, b] = this.tanks;
      if (!a || !b || !a.alive || !b.alive) return;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      const min = C.TANK_RADIUS * 2;
      if (d >= min || d < 1e-6) return;
      const push = (min - d) / 2 / d;
      a.x -= dx * push; a.y -= dy * push;
      b.x += dx * push; b.y += dy * push;
      this.resolveTank(a);
      this.resolveTank(b);
    }

    tryFire(t, inp) {
      if (t.cooldown > 0) return;
      if (this.shellsInFlight(t.index) >= this.ammo.max) {
        this.emit({ type: 'dry', player: t.index });
        t.cooldown = C.FIRE_COOLDOWN;
        return;
      }
      if (inp.snapOnFire) t.turret = t.turretTarget;
      t.cooldown = C.FIRE_COOLDOWN;
      t.recoil = 1;
      const cx = Math.cos(t.turret), sy = Math.sin(t.turret);
      // Muzzle jammed against a wall? The shell fizzles instead of spawning
      // inside the block.
      for (let d = 0.2; d <= C.BARREL_LEN + 1e-6; d += 0.05) {
        const px = t.x + cx * d, py = t.y + sy * d;
        if (this.circleHits(px, py, C.BULLET_RADIUS, World.blocksShell)) {
          this.emit({ type: 'fizzle', player: t.index, x: px, y: py });
          return;
        }
      }
      const x = t.x + cx * C.BARREL_LEN;
      const y = t.y + sy * C.BARREL_LEN;
      const speed = this.ammo.speed;
      this.bullets.push({
        id: this.nextId++, owner: t.index, x, y, vx: cx * speed, vy: sy * speed, speed, bounces: 0,
        maxBounces: this.ammo.bounces + (this.mechKey === 'playroom' ? 1 : 0), bent: 0, age: 0, dead: false,
      });
      this.emit({ type: 'fire', player: t.index, x, y, angle: t.turret });
    }

    tryMine(t) {
      if (!this.minesEnabled || t.mineCooldown > 0) return;
      if (this.minesLeft(t.index) <= 0) {
        this.emit({ type: 'dry', player: t.index });
        t.mineCooldown = 0.3;
        return;
      }
      for (const m of this.mines) {
        if (Math.hypot(m.x - t.x, m.y - t.y) < 0.6) return;
      }
      this.mines.push({
        id: this.nextId++, owner: t.index, x: t.x, y: t.y,
        age: 0, fuse: C.MINE_FUSE, armed: false, triggered: false,
      });
      t.mineCooldown = C.MINE_COOLDOWN;
      this.emit({ type: 'mineLay', player: t.index, x: t.x, y: t.y });
    }

    destroyTank(t, by, cause, shell) {
      if (!t.alive) return;
      t.alive = false;
      t.speed = 0;
      t.vx = t.vy = 0;
      this.emit({
        type: 'tankDestroyed', player: t.index, by, cause, x: t.x, y: t.y, angle: t.angle, turret: t.turret,
        bounces: shell ? shell.bounces : 0, bent: shell ? shell.bent : 0,
      });
    }

    killBullet(b, reason) {
      if (b.dead) return;
      b.dead = true;
      this.emit({ type: 'shellGone', reason, x: b.x, y: b.y, owner: b.owner });
    }

    // Black holes bend shells (constant speed, only the heading changes) and
    // swallow any that get too close. Returns true if the shell was swallowed.
    pullShell(b, h) {
      let ax = 0, ay = 0;
      for (const hole of this.holes) {
        const dx = hole.x - b.x, dy = hole.y - b.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > C.HOLE_RADIUS * C.HOLE_RADIUS) continue;
        const d = Math.sqrt(d2);
        if (d < C.HOLE_CORE) {
          this.killBullet(b, 'hole');
          this.emit({ type: 'swallow', x: hole.x, y: hole.y });
          return true;
        }
        const f = C.HOLE_PULL / Math.max(d2, 0.3);
        ax += (dx / d) * f;
        ay += (dy / d) * f;
      }
      if (ax || ay) {
        b.vx += ax * h;
        b.vy += ay * h;
        const sp = Math.hypot(b.vx, b.vy);
        b.vx *= b.speed / sp;
        b.vy *= b.speed / sp;
        b.bent += (Math.hypot(ax, ay) * h) / b.speed;
      }
      return false;
    }

    updateBullets(dt) {
      const br = C.BULLET_RADIUS;
      const hitR = C.TANK_HIT_RADIUS + br;
      const gravity = this.holes.length > 0 && !this.frozen;
      for (const b of this.bullets) {
        if (b.dead) continue;
        b.age += dt;
        const steps = Math.max(1, Math.ceil((b.speed * dt) / C.BULLET_STEP));
        const h = dt / steps;
        for (let s = 0; s < steps && !b.dead; s++) {
          if (gravity && this.pullShell(b, h)) break;
          let bounced = false;
          b.x += b.vx * h;
          if (this.circleHits(b.x, b.y, br, World.blocksShell)) {
            b.x -= b.vx * h;
            b.vx = -b.vx;
            bounced = true;
          }
          b.y += b.vy * h;
          if (this.circleHits(b.x, b.y, br, World.blocksShell)) {
            b.y -= b.vy * h;
            b.vy = -b.vy;
            bounced = true;
          }
          if (bounced) {
            b.bounces++;
            if (b.bounces > b.maxBounces) {
              this.killBullet(b, 'wall');
              break;
            }
            this.emit({ type: 'bounce', x: b.x, y: b.y, owner: b.owner });
          }
          for (const t of this.tanks) {
            if (!t.alive) continue;
            const dx = t.x - b.x, dy = t.y - b.y;
            if (dx * dx + dy * dy < hitR * hitR) {
              this.killBullet(b, 'tank');
              this.destroyTank(t, b.owner, 'shell', b);
              break;
            }
          }
          if (b.dead) break;
          for (const m of this.mines) {
            if (m.exploded) continue;
            const dx = m.x - b.x, dy = m.y - b.y;
            const r = C.MINE_RADIUS + br;
            if (dx * dx + dy * dy < r * r) {
              this.killBullet(b, 'mine');
              this.explodeMine(m);
              break;
            }
          }
        }
      }
      // Shells that meet in mid-air knock each other out.
      const live = this.bullets.filter((b) => !b.dead);
      for (let i = 0; i < live.length; i++) {
        for (let j = i + 1; j < live.length; j++) {
          const a = live[i], b = live[j];
          if (a.dead || b.dead) continue;
          const dx = a.x - b.x, dy = a.y - b.y;
          if (dx * dx + dy * dy < (br * 2) * (br * 2)) {
            this.killBullet(a, 'shell');
            this.killBullet(b, 'shell');
            this.emit({ type: 'shellClash', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, owners: [a.owner, b.owner] });
          }
        }
      }
      this.bullets = this.bullets.filter((b) => !b.dead);
    }

    updateMines(dt) {
      for (const m of this.mines) {
        if (m.exploded) continue;
        m.age += dt;
        if (!m.armed && m.age >= C.MINE_ARM_TIME) m.armed = true;
        if (m.armed && !m.triggered) {
          for (const t of this.tanks) {
            if (!t.alive || t.index === m.owner) continue;
            if (Math.hypot(t.x - m.x, t.y - m.y) < C.MINE_TRIGGER_RADIUS) {
              m.triggered = true;
              m.fuse = Math.min(m.fuse, C.MINE_TRIGGER_FUSE);
              this.emit({ type: 'mineTrigger', x: m.x, y: m.y });
              break;
            }
          }
        }
        m.fuse -= dt;
        if (m.fuse <= 0) this.explodeMine(m);
      }
      this.mines = this.mines.filter((m) => !m.exploded);
    }

    explodeMine(m) {
      if (m.exploded) return;
      m.exploded = true;
      this.blast(m.x, m.y, C.MINE_BLAST_RADIUS, m.owner, 'mine');
    }

    // Explosion from a mine or an eruption: destroys tanks, shells and
    // crates in range and sets off other mines.
    blast(x, y, R, owner, cause) {
      this.emit({ type: 'explosion', x, y, r: R, owner, cause });
      for (const t of this.tanks) {
        if (t.alive && Math.hypot(t.x - x, t.y - y) < R + C.TANK_HIT_RADIUS * 0.4) {
          this.destroyTank(t, owner, cause);
        }
      }
      for (const b of this.bullets) {
        if (!b.dead && Math.hypot(b.x - x, b.y - y) < R) this.killBullet(b, 'blast');
      }
      const c0 = Math.floor(x - R), c1 = Math.floor(x + R);
      const r0 = Math.floor(y - R), r1 = Math.floor(y + R);
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          if (c < 0 || r < 0 || c >= C.COLS || r >= C.ROWS) continue;
          if (this.tileAt(c, r) !== T.CRATE) continue;
          const nx = U.clamp(x, c, c + 1), ny = U.clamp(y, r, r + 1);
          if (Math.hypot(nx - x, ny - y) < R - 0.2) {
            this.setTile(c, r, T.FLOOR);
            this.emit({ type: 'crateDestroyed', c, r });
            if (this.mechKey === 'garden') this.regrow.push({ c, r, t: C.REGROW_TIME });
          }
        }
      }
      for (const o of this.mines) {
        if (o.exploded) continue;
        if (Math.hypot(o.x - x, o.y - y) < R) {
          o.triggered = true;
          o.armed = true;
          o.fuse = Math.min(o.fuse, C.MINE_CHAIN_DELAY);
        }
      }
    }

    drainEvents() {
      const ev = this.events;
      this.events = [];
      return ev;
    }
  }

  RR.World = World;
  RR.NO_INPUT = NO_INPUT;
})();
