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

  class Tank {
    constructor(index, spawn, color) {
      this.index = index;
      this.color = color;
      this.x = spawn.x;
      this.y = spawn.y;
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
    // opts: { ammo, minesEnabled, colors: [color, color] }
    constructor(arenaDef, opts) {
      const arena = RR.buildArena(arenaDef);
      this.arena = arena;
      this.theme = arena.theme;
      this.grid = arena.grid;
      this.ammo = opts.ammo || C.AMMO.classic;
      this.minesEnabled = opts.minesEnabled !== false;
      this.tanks = arena.spawns.map((s, i) => new Tank(i, s, opts.colors[i]));
      this.bullets = [];
      this.mines = [];
      this.events = [];
      this.time = 0;
      this.frozen = true; // tanks can aim but not drive or shoot (round intro)
      this.nextId = 1;
    }

    // ---- tiles -------------------------------------------------------------
    tileAt(c, r) {
      if (c < 0 || r < 0 || c >= C.COLS || r >= C.ROWS) return T.WALL;
      return this.grid[r * C.COLS + c];
    }

    setTile(c, r, t) {
      this.grid[r * C.COLS + c] = t;
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
      this.events.push(ev);
    }

    // ---- simulation -------------------------------------------------------------
    update(dt, inputs) {
      this.time += dt;
      for (const t of this.tanks) {
        if (t.alive) this.updateTank(t, inputs[t.index] || NO_INPUT, dt);
      }
      this.collideTanks();
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
        return;
      }

      // Hull: steer toward the stick direction, driving forwards or in
      // reverse — whichever needs less turning.
      let mx = inp.moveX, my = inp.moveY;
      let m = Math.hypot(mx, my);
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
        t.speed = C.TANK_SPEED * m * align * t.driveDir;
        if (t.speed !== 0) {
          const ox = t.x, oy = t.y;
          t.x += Math.cos(t.angle) * t.speed * dt;
          t.y += Math.sin(t.angle) * t.speed * dt;
          this.resolveTank(t);
          const moved = Math.hypot(t.x - ox, t.y - oy);
          t.treadPhase += moved * Math.sign(t.speed);
          t.markDist += moved;
        }
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
        id: this.nextId++, owner: t.index, x, y, vx: cx * speed, vy: sy * speed,
        speed, bounces: 0, maxBounces: this.ammo.bounces, age: 0, dead: false,
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

    destroyTank(t, by, cause) {
      if (!t.alive) return;
      t.alive = false;
      t.speed = 0;
      this.emit({ type: 'tankDestroyed', player: t.index, by, cause, x: t.x, y: t.y, angle: t.angle, turret: t.turret });
    }

    killBullet(b, reason) {
      if (b.dead) return;
      b.dead = true;
      this.emit({ type: 'shellGone', reason, x: b.x, y: b.y, owner: b.owner });
    }

    updateBullets(dt) {
      const br = C.BULLET_RADIUS;
      const hitR = C.TANK_HIT_RADIUS + br;
      for (const b of this.bullets) {
        if (b.dead) continue;
        b.age += dt;
        const steps = Math.max(1, Math.ceil((b.speed * dt) / C.BULLET_STEP));
        const h = dt / steps;
        for (let s = 0; s < steps && !b.dead; s++) {
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
              this.destroyTank(t, b.owner, 'shell');
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
            this.emit({ type: 'shellClash', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
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
      const R = C.MINE_BLAST_RADIUS;
      this.emit({ type: 'explosion', x: m.x, y: m.y, r: R, owner: m.owner });
      for (const t of this.tanks) {
        if (t.alive && Math.hypot(t.x - m.x, t.y - m.y) < R + C.TANK_HIT_RADIUS * 0.4) {
          this.destroyTank(t, m.owner, 'mine');
        }
      }
      for (const b of this.bullets) {
        if (!b.dead && Math.hypot(b.x - m.x, b.y - m.y) < R) this.killBullet(b, 'blast');
      }
      const c0 = Math.floor(m.x - R), c1 = Math.floor(m.x + R);
      const r0 = Math.floor(m.y - R), r1 = Math.floor(m.y + R);
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          if (c < 0 || r < 0 || c >= C.COLS || r >= C.ROWS) continue;
          if (this.tileAt(c, r) !== T.CRATE) continue;
          const nx = U.clamp(m.x, c, c + 1), ny = U.clamp(m.y, r, r + 1);
          if (Math.hypot(nx - m.x, ny - m.y) < R - 0.2) {
            this.setTile(c, r, T.FLOOR);
            this.emit({ type: 'crateDestroyed', c, r });
          }
        }
      }
      for (const o of this.mines) {
        if (o === m || o.exploded) continue;
        if (Math.hypot(o.x - m.x, o.y - m.y) < R) {
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
