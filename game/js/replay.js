// Ricochet Rumble — instant replay.
// Keeps a rolling few seconds of snapshots while a round is played, then plays
// a slice of them back through a stand-in "world" object that the renderer
// draws exactly like the real one.
window.RR = window.RR || {};

(function () {
  const KEEP = 6; // seconds of history

  class Replay {
    constructor() {
      this.frames = [];
      this.play = null;
    }

    reset() {
      this.frames = [];
      this.play = null;
      this.lastGridVersion = -1;
      this.lastGrid = null;
    }

    // Call once per rendered frame with the events drained this frame.
    capture(w, events) {
      if (this.lastGridVersion !== w.gridVersion || !this.lastGrid) {
        this.lastGrid = w.grid.slice();
        this.lastGridVersion = w.gridVersion;
      }
      this.frames.push({
        t: w.time,
        tanks: w.tanks.map((k) => [k.x, k.y, k.angle, k.turret, k.alive, k.treadPhase, k.recoil]),
        bullets: w.bullets.map((b) => [b.id, b.owner, b.x, b.y, b.vx, b.vy]),
        mines: w.mines.map((m) => [m.id, m.owner, m.x, m.y, m.age, m.fuse, m.armed, m.triggered]),
        grid: this.lastGrid,
        tide: w.tide,
        storm: w.storm,
        eruptions: w.eruptions.map((e) => Object.assign({}, e)),
        regrow: w.regrow.map((g) => Object.assign({}, g)),
        events: events.filter((e) => e.type !== 'tread'),
      });
      const cutoff = w.time - KEEP;
      while (this.frames.length && this.frames[0].t < cutoff) this.frames.shift();
    }

    lastKill() {
      for (let i = this.frames.length - 1; i >= 0; i--) {
        const evs = this.frames[i].events;
        for (let j = evs.length - 1; j >= 0; j--) if (evs[j].type === 'tankDestroyed') return evs[j];
      }
      return null;
    }

    // Starts playback of [from, to] (world seconds). Returns the stand-in world.
    start(w, from, to) {
      const frames = this.frames.filter((f) => f.t >= from && f.t <= to);
      if (frames.length < 2) return null;
      const proxy = {
        arena: w.arena, theme: w.theme, ammo: w.ammo, minesEnabled: w.minesEnabled,
        mechKey: w.mechKey, mechanic: w.mechanic, holes: w.holes, shallow: w.shallow,
        grid: frames[0].grid,
        tanks: w.tanks.map((k) => ({ index: k.index, color: k.color })),
        bullets: [], mines: [], eruptions: [], regrow: [], tide: 0, storm: 0,
      };
      this.play = { frames, i: 0, t: frames[0].t, end: frames[frames.length - 1].t, proxy };
      this.apply(frames[0]);
      return proxy;
    }

    apply(f) {
      const p = this.play.proxy;
      f.tanks.forEach((k, i) => {
        Object.assign(p.tanks[i], { x: k[0], y: k[1], angle: k[2], turret: k[3], alive: k[4], treadPhase: k[5], recoil: k[6] });
      });
      p.bullets = f.bullets.map((b) => ({ id: b[0], owner: b[1], x: b[2], y: b[3], vx: b[4], vy: b[5] }));
      p.mines = f.mines.map((m) => ({ id: m[0], owner: m[1], x: m[2], y: m[3], age: m[4], fuse: m[5], armed: m[6], triggered: m[7] }));
      p.grid = f.grid;
      p.tide = f.tide;
      p.storm = f.storm;
      p.eruptions = f.eruptions;
      p.regrow = f.regrow;
    }

    // Advances playback by `dt` world seconds; returns the events that happened.
    advance(dt) {
      const pl = this.play;
      const out = [];
      if (!pl) return out;
      pl.t += dt;
      while (pl.i + 1 < pl.frames.length && pl.frames[pl.i + 1].t <= pl.t) {
        pl.i++;
        out.push(...pl.frames[pl.i].events);
      }
      this.apply(pl.frames[pl.i]);
      return out;
    }

    get done() {
      return !this.play || this.play.t >= this.play.end;
    }

    get progress() {
      const pl = this.play;
      return pl ? (pl.t - pl.frames[0].t) / Math.max(0.001, pl.end - pl.frames[0].t) : 1;
    }

    stop() {
      this.play = null;
    }
  }

  RR.Replay = Replay;
})();
