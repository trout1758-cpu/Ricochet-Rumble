// Ricochet Rumble — Canvas renderer.
// A 3/4 "tabletop diorama" view: blocks are extruded upward (top face shifted
// up, front face visible) and drawn row by row so tanks tuck behind them.
window.RR = window.RR || {};

(function () {
  const C = RR.CFG;
  const T = RR.TILE;
  const U = RR.util;

  const BLOCK_H = 0.34;   // block height, tiles
  const RIM = 0.55;       // arena frame thickness, tiles
  const TANK_LIFT = 0.07;
  const SHELL_LIFT = 0.18;
  const LIGHT = { x: 0.24, y: 0.17 }; // shadow offset (light from top-left)

  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
  }

  // ---------------------------------------------------------------------------
  // Particles
  // ---------------------------------------------------------------------------
  class FX {
    constructor() {
      this.p = [];
    }

    clear() {
      this.p.length = 0;
    }

    add(o) {
      if (this.p.length > 900) this.p.shift();
      o.age = 0;
      o.z = o.z || 0;
      o.vz = o.vz || 0;
      o.vx = o.vx || 0;
      o.vy = o.vy || 0;
      this.p.push(o);
    }

    update(dt) {
      for (const p of this.p) {
        p.age += dt;
        const drag = p.drag != null ? p.drag : 2.5;
        const k = Math.exp(-drag * dt);
        p.vx *= k; p.vy *= k;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.gravity) {
          p.vz -= p.gravity * dt;
          p.z += p.vz * dt;
          if (p.z < 0) { p.z = 0; p.vz = -p.vz * 0.35; p.vx *= 0.6; p.vy *= 0.6; }
        } else {
          p.z += p.vz * dt;
        }
        if (p.spin) p.rot = (p.rot || 0) + p.spin * dt;
      }
      this.p = this.p.filter((p) => p.age < p.life);
    }

    draw(ctx, R) {
      const s = R.s;
      for (const p of this.p) {
        const t = p.age / p.life;
        const X = R.ox + p.x * s;
        const Y = R.oy + (p.y - p.z) * s;
        switch (p.kind) {
          case 'smoke': {
            const rad = U.lerp(p.r0, p.r1, 1 - Math.pow(1 - t, 2)) * s;
            ctx.globalAlpha = p.a0 * (1 - t);
            ctx.fillStyle = p.color || '#d9d4cc';
            ctx.beginPath();
            ctx.arc(X, Y, rad, 0, U.TAU);
            ctx.fill();
            break;
          }
          case 'fire': {
            const rad = U.lerp(p.r0, p.r1, t) * s;
            ctx.globalAlpha = 1 - t * t;
            const g = ctx.createRadialGradient(X, Y, 0, X, Y, Math.max(1, rad));
            g.addColorStop(0, '#fff6c8');
            g.addColorStop(0.35, '#ffd25a');
            g.addColorStop(0.7, '#ff8a2a');
            g.addColorStop(1, 'rgba(220,60,20,0)');
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(X, Y, rad, 0, U.TAU);
            ctx.fill();
            break;
          }
          case 'spark': {
            ctx.globalAlpha = 1 - t;
            ctx.strokeStyle = p.color || '#ffe9a0';
            ctx.lineWidth = Math.max(1, s * 0.035);
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(X, Y);
            ctx.lineTo(X - p.vx * s * 0.035, Y - p.vy * s * 0.035);
            ctx.stroke();
            break;
          }
          case 'debris': {
            ctx.globalAlpha = t > 0.75 ? (1 - t) * 4 : 1;
            ctx.save();
            ctx.translate(X, Y);
            ctx.rotate(p.rot || 0);
            ctx.fillStyle = p.color;
            const w = p.size * s;
            ctx.fillRect(-w / 2, -w / 3, w, w * 0.66);
            ctx.restore();
            break;
          }
          case 'ring': {
            const rad = U.lerp(p.r0, p.r1, 1 - Math.pow(1 - t, 3)) * s;
            ctx.globalAlpha = (1 - t) * 0.7;
            ctx.strokeStyle = p.color || '#fff';
            ctx.lineWidth = Math.max(1, s * 0.12 * (1 - t));
            ctx.beginPath();
            ctx.arc(X, Y, rad, 0, U.TAU);
            ctx.stroke();
            break;
          }
          case 'flash': {
            const rad = p.r0 * s;
            ctx.globalAlpha = (1 - t) * 0.85;
            const g = ctx.createRadialGradient(X, Y, 0, X, Y, rad);
            g.addColorStop(0, 'rgba(255,255,230,1)');
            g.addColorStop(1, 'rgba(255,220,150,0)');
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(X, Y, rad, 0, U.TAU);
            ctx.fill();
            break;
          }
          case 'ghost': {
            ctx.globalAlpha = (1 - t) * 0.35;
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.arc(X, Y, p.r0 * s * (1 - t * 0.5), 0, U.TAU);
            ctx.fill();
            break;
          }
        }
      }
      ctx.globalAlpha = 1;
    }
  }

  // ---------------------------------------------------------------------------
  // Renderer
  // ---------------------------------------------------------------------------
  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.fx = new FX();
      this.world = null;
      this.decals = [];
      this.topInset = 0;
      this.shake = 0;
      this.time = 0;
      this.trail = new Map();
      this.dpr = 1;
      this.W = 1; this.H = 1;
      this.s = 32; this.ox = 0; this.oy = 0;
    }

    // ---- layout ----------------------------------------------------------------
    resize(topInsetCss) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = window.innerWidth, h = window.innerHeight;
      this.dpr = dpr;
      this.W = this.canvas.width = Math.round(w * dpr);
      this.H = this.canvas.height = Math.round(h * dpr);
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = h + 'px';
      this.topInset = Math.round((topInsetCss || 0) * dpr);
      const availW = this.W;
      const availH = this.H - this.topInset;
      const totalW = C.COLS + RIM * 2 + 0.5;
      const totalH = C.ROWS + RIM * 2 + BLOCK_H + 0.45;
      this.s = Math.max(8, Math.floor(Math.min(availW / totalW, availH / totalH)));
      const s = this.s;
      this.ox = Math.round((this.W - C.COLS * s) / 2);
      const visH = (C.ROWS + RIM * 2 + BLOCK_H) * s;
      this.oy = Math.round(this.topInset + (availH - visH) / 2 + (RIM + BLOCK_H) * s);
      this.rebuild();
    }

    screenToWorld(cssX, cssY) {
      return {
        x: (cssX * this.dpr - this.ox) / this.s,
        y: (cssY * this.dpr - this.oy) / this.s,
      };
    }

    worldToCss(x, y) {
      return { x: (this.ox + x * this.s) / this.dpr, y: (this.oy + y * this.s) / this.dpr };
    }

    setWorld(world) {
      this.world = world;
      this.decals = [];
      this.fx.clear();
      this.trail.clear();
      this.shake = 0;
      this.rebuild();
    }

    makeCanvas(w, h) {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.ceil(w));
      c.height = Math.max(1, Math.ceil(h));
      return c;
    }

    rebuild() {
      if (!this.world) return;
      const th = this.world.theme;
      this.staticLayer = this.makeCanvas(this.W, this.H);
      this.fgLayer = this.makeCanvas(this.W, this.H);
      this.decalLayer = this.makeCanvas(C.COLS * this.s, C.ROWS * this.s);
      this.drawStatic(this.staticLayer.getContext('2d'), th);
      this.drawForeground(this.fgLayer.getContext('2d'), th);
      this.buildSprites(th);
      this.redrawDecals();
    }

    // ---- static background -----------------------------------------------------
    drawStatic(ctx, th) {
      const { s, ox, oy, W, H } = this;
      const X = (x) => ox + x * s;
      const Y = (y) => oy + y * s;
      const bh = BLOCK_H * s;

      // Tabletop around the arena
      ctx.fillStyle = th.backdrop;
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = th.backdropLine;
      ctx.lineWidth = Math.max(1, s * 0.05);
      const plank = s * 1.7;
      for (let y = (oy % plank) - plank; y < H + plank; y += plank) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
      }
      const rnd = U.rng(99);
      ctx.lineWidth = Math.max(1, s * 0.03);
      for (let i = 0; i < 40; i++) {
        const y = rnd() * H, x = rnd() * W, len = s * (2 + rnd() * 5);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.bezierCurveTo(x + len * 0.3, y - s * 0.1, x + len * 0.7, y + s * 0.1, x + len, y);
        ctx.stroke();
      }
      const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.75);
      vg.addColorStop(0, 'rgba(0,0,0,0)');
      vg.addColorStop(1, 'rgba(0,0,0,0.45)');
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, W, H);

      // Arena frame (drop shadow first)
      const fx0 = X(-RIM), fx1 = X(C.COLS + RIM);
      const fy0 = Y(-RIM) - bh, fy1 = Y(C.ROWS + RIM);
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = s * 0.9;
      ctx.shadowOffsetX = s * 0.15;
      ctx.shadowOffsetY = s * 0.3;
      ctx.fillStyle = th.rimSide;
      rr(ctx, fx0, fy0, fx1 - fx0, fy1 - fy0, s * 0.18);
      ctx.fill();
      ctx.restore();
      // frame top face
      ctx.fillStyle = th.rimTop;
      rr(ctx, fx0, fy0, fx1 - fx0, fy1 - fy0 - bh, s * 0.18);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = Math.max(1, s * 0.04);
      rr(ctx, fx0 + s * 0.05, fy0 + s * 0.05, fx1 - fx0 - s * 0.1, fy1 - fy0 - bh - s * 0.1, s * 0.14);
      ctx.stroke();

      // Inner face of the north rim (faces the camera)
      ctx.fillStyle = U.shade(th.rimSide, -0.1);
      ctx.fillRect(X(0), Y(0) - bh, C.COLS * s, bh);

      // Floor
      ctx.save();
      ctx.beginPath();
      ctx.rect(X(0), Y(0), C.COLS * s, C.ROWS * s);
      ctx.clip();
      ctx.translate(X(0), Y(0));
      this.drawFloor(ctx, th);
      ctx.restore();

      // Pits
      ctx.save();
      ctx.translate(X(0), Y(0));
      this.drawPits(ctx, th);
      ctx.restore();

      // Contact shadow cast by the rim onto the floor
      ctx.save();
      ctx.beginPath();
      ctx.rect(X(0), Y(0), C.COLS * s, C.ROWS * s);
      ctx.clip();
      let g = ctx.createLinearGradient(0, Y(0), 0, Y(0) + s * 0.45);
      g.addColorStop(0, 'rgba(0,0,0,0.28)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(X(0), Y(0), C.COLS * s, s * 0.45);
      g = ctx.createLinearGradient(X(0), 0, X(0) + s * 0.35, 0);
      g.addColorStop(0, 'rgba(0,0,0,0.22)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(X(0), Y(0), s * 0.35, C.ROWS * s);
      ctx.restore();
    }

    drawFloor(ctx, th) {
      const s = this.s;
      const w = C.COLS * s, h = C.ROWS * s;
      const rnd = U.rng(1234);
      ctx.fillStyle = th.floor;
      ctx.fillRect(0, 0, w, h);
      // gentle large-scale tone variation
      const [ar, ag, ab] = U.hexToRgb(th.floorAlt);
      for (let i = 0; i < 14; i++) {
        const x = rnd() * w, y = rnd() * h, r = s * (2 + rnd() * 4);
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(${ar},${ag},${ab},0.7)`);
        g.addColorStop(1, `rgba(${ar},${ag},${ab},0)`);
        ctx.fillStyle = g;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
      }
      ctx.strokeStyle = th.patternInk;
      ctx.fillStyle = th.patternInk;
      switch (th.pattern) {
        case 'grain': {
          ctx.lineWidth = Math.max(1, s * 0.03);
          for (let i = 0; i < 70; i++) {
            const y = rnd() * h;
            const amp = s * (0.05 + rnd() * 0.15);
            const x0 = rnd() * w * 0.5 - w * 0.2, len = w * (0.3 + rnd() * 0.6);
            ctx.beginPath();
            ctx.moveTo(x0, y);
            for (let x = x0; x < x0 + len; x += s) {
              ctx.quadraticCurveTo(x + s * 0.5, y + (rnd() - 0.5) * amp * 2, x + s, y + (rnd() - 0.5) * amp);
            }
            ctx.stroke();
          }
          for (let i = 0; i < 6; i++) {
            const x = rnd() * w, y = rnd() * h;
            ctx.beginPath();
            ctx.ellipse(x, y, s * 0.35, s * 0.12, 0, 0, U.TAU);
            ctx.stroke();
            ctx.beginPath();
            ctx.ellipse(x, y, s * 0.18, s * 0.06, 0, 0, U.TAU);
            ctx.stroke();
          }
          // sheet seams
          ctx.strokeStyle = 'rgba(90,55,20,0.22)';
          ctx.lineWidth = Math.max(1, s * 0.035);
          for (const fx of [0.25, 0.5, 0.75]) {
            ctx.beginPath();
            ctx.moveTo(Math.round(w * fx), 0);
            ctx.lineTo(Math.round(w * fx), h);
            ctx.stroke();
          }
          break;
        }
        case 'speckle': {
          for (let i = 0; i < C.COLS * C.ROWS * 14; i++) {
            const r = s * (0.012 + rnd() * 0.03);
            ctx.globalAlpha = 0.4 + rnd() * 0.6;
            ctx.beginPath();
            ctx.arc(rnd() * w, rnd() * h, r, 0, U.TAU);
            ctx.fill();
          }
          ctx.globalAlpha = 1;
          ctx.strokeStyle = 'rgba(160,120,60,0.15)';
          ctx.lineWidth = Math.max(1, s * 0.04);
          for (let i = 0; i < 25; i++) {
            const x = rnd() * w, y = rnd() * h;
            ctx.beginPath();
            ctx.arc(x, y, s * (0.4 + rnd() * 0.8), Math.PI * 1.1, Math.PI * 1.9);
            ctx.stroke();
          }
          break;
        }
        case 'sparkle': {
          for (let i = 0; i < C.COLS * C.ROWS * 2; i++) {
            const x = rnd() * w, y = rnd() * h, r = s * (0.03 + rnd() * 0.05);
            ctx.globalAlpha = 0.5 + rnd() * 0.5;
            ctx.fillStyle = rnd() < 0.5 ? '#ffffff' : th.patternInk;
            ctx.beginPath();
            ctx.moveTo(x, y - r); ctx.lineTo(x + r * 0.3, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r * 0.3, y);
            ctx.closePath();
            ctx.moveTo(x - r, y); ctx.lineTo(x, y + r * 0.3); ctx.lineTo(x + r, y); ctx.lineTo(x, y - r * 0.3);
            ctx.closePath();
            ctx.fill();
          }
          ctx.globalAlpha = 1;
          ctx.strokeStyle = 'rgba(140,175,210,0.25)';
          ctx.lineWidth = Math.max(1, s * 0.03);
          for (let i = 0; i < 30; i++) {
            const x = rnd() * w, y = rnd() * h;
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.quadraticCurveTo(x + s, y + (rnd() - 0.5) * s, x + s * (1.5 + rnd() * 2), y + (rnd() - 0.5) * s);
            ctx.stroke();
          }
          break;
        }
        case 'grass': {
          ctx.lineWidth = Math.max(1, s * 0.028);
          ctx.lineCap = 'round';
          for (let i = 0; i < C.COLS * C.ROWS * 18; i++) {
            const x = rnd() * w, y = rnd() * h, len = s * (0.06 + rnd() * 0.1);
            ctx.strokeStyle = rnd() < 0.7 ? th.patternInk : 'rgba(210,240,170,0.35)';
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x + (rnd() - 0.5) * len * 0.8, y - len);
            ctx.stroke();
          }
          for (let i = 0; i < 26; i++) {
            const x = rnd() * w, y = rnd() * h;
            ctx.fillStyle = ['#fff7d6', '#ffe36e', '#ffb3c8'][i % 3];
            for (let k = 0; k < 5; k++) {
              const a = (k / 5) * U.TAU;
              ctx.beginPath();
              ctx.arc(x + Math.cos(a) * s * 0.05, y + Math.sin(a) * s * 0.05, s * 0.035, 0, U.TAU);
              ctx.fill();
            }
            ctx.fillStyle = '#f2a33a';
            ctx.beginPath();
            ctx.arc(x, y, s * 0.03, 0, U.TAU);
            ctx.fill();
          }
          break;
        }
        case 'dots': {
          for (let r = 0; r < C.ROWS * 2; r++) {
            for (let c = 0; c < C.COLS * 2; c++) {
              const x = (c + (r % 2 ? 0.5 : 0)) * s * 0.5 + s * 0.25;
              const y = r * s * 0.5 + s * 0.25;
              ctx.beginPath();
              ctx.arc(x, y, s * 0.06, 0, U.TAU);
              ctx.fill();
            }
          }
          // rug border
          ctx.strokeStyle = 'rgba(210,110,150,0.35)';
          ctx.lineWidth = s * 0.08;
          ctx.strokeRect(s * 0.4, s * 0.4, w - s * 0.8, h - s * 0.8);
          ctx.lineWidth = s * 0.03;
          ctx.strokeRect(s * 0.6, s * 0.6, w - s * 1.2, h - s * 1.2);
          break;
        }
        case 'grid': {
          ctx.lineWidth = 1;
          ctx.strokeStyle = 'rgba(210,230,255,0.09)';
          for (let x = 0; x <= C.COLS * 4; x++) {
            ctx.beginPath(); ctx.moveTo(Math.round(x * s / 4) + 0.5, 0); ctx.lineTo(Math.round(x * s / 4) + 0.5, h); ctx.stroke();
          }
          for (let y = 0; y <= C.ROWS * 4; y++) {
            ctx.beginPath(); ctx.moveTo(0, Math.round(y * s / 4) + 0.5); ctx.lineTo(w, Math.round(y * s / 4) + 0.5); ctx.stroke();
          }
          ctx.strokeStyle = th.patternInk;
          ctx.lineWidth = Math.max(1, s * 0.03);
          for (let x = 0; x <= C.COLS; x++) {
            ctx.beginPath(); ctx.moveTo(x * s, 0); ctx.lineTo(x * s, h); ctx.stroke();
          }
          for (let y = 0; y <= C.ROWS; y++) {
            ctx.beginPath(); ctx.moveTo(0, y * s); ctx.lineTo(w, y * s); ctx.stroke();
          }
          // drafting circle in the middle
          ctx.strokeStyle = 'rgba(230,240,255,0.25)';
          ctx.setLineDash([s * 0.15, s * 0.12]);
          ctx.beginPath();
          ctx.arc(w / 2, h / 2, s * 2.2, 0, U.TAU);
          ctx.stroke();
          ctx.setLineDash([]);
          break;
        }
      }
    }

    drawPits(ctx, th) {
      const s = this.s;
      const grid = this.world.grid;
      const isPit = (c, r) => c >= 0 && r >= 0 && c < C.COLS && r < C.ROWS && grid[r * C.COLS + c] === T.PIT;
      const water = th.pitStyle === 'water';
      for (let r = 0; r < C.ROWS; r++) {
        for (let c = 0; c < C.COLS; c++) {
          if (!isPit(c, r)) continue;
          const x = c * s, y = r * s;
          const inL = isPit(c - 1, r) ? 0 : s * 0.06;
          const inR = isPit(c + 1, r) ? 0 : s * 0.06;
          const inT = isPit(c, r - 1) ? 0 : s * 0.06;
          const inB = isPit(c, r + 1) ? 0 : s * 0.06;
          ctx.fillStyle = th.pit;
          ctx.fillRect(x + inL, y + inT, s - inL - inR, s - inT - inB);
          if (!isPit(c, r - 1)) {
            const g = ctx.createLinearGradient(0, y + inT, 0, y + inT + s * 0.42);
            g.addColorStop(0, th.pitWall);
            g.addColorStop(1, th.pit);
            ctx.fillStyle = g;
            ctx.fillRect(x + inL, y + inT, s - inL - inR, s * 0.42);
          }
          if (!isPit(c - 1, r)) {
            ctx.fillStyle = 'rgba(0,0,0,0.18)';
            ctx.fillRect(x + inL, y + inT, Math.max(1, s * 0.08), s - inT - inB);
          }
          if (water) {
            const rnd = U.rng(c * 31 + r * 17 + 5);
            ctx.fillStyle = 'rgba(255,255,255,0.06)';
            ctx.beginPath();
            ctx.ellipse(x + s * (0.3 + rnd() * 0.4), y + s * (0.5 + rnd() * 0.3), s * 0.3, s * 0.1, 0, 0, U.TAU);
            ctx.fill();
            ctx.strokeStyle = 'rgba(220,245,255,0.35)';
            ctx.lineWidth = Math.max(1, s * 0.03);
            for (let k = 0; k < 2; k++) {
              const cx = x + s * (0.2 + rnd() * 0.6), cy = y + s * (0.45 + rnd() * 0.4);
              ctx.beginPath();
              ctx.ellipse(cx, cy, s * 0.16, s * 0.06, 0, Math.PI * 1.1, Math.PI * 1.9);
              ctx.stroke();
            }
          }
          // lip highlight on the near (south) edge
          if (!isPit(c, r + 1)) {
            ctx.fillStyle = 'rgba(255,255,255,0.18)';
            ctx.fillRect(x + inL, y + s - inB, s - inL - inR, Math.max(1, s * 0.04));
          }
        }
      }
    }

    drawForeground(ctx, th) {
      // South rim drawn over the bottom edge of the floor.
      const { s, ox, oy } = this;
      const bh = BLOCK_H * s;
      const x0 = ox - RIM * s, x1 = ox + (C.COLS + RIM) * s;
      const yTop = oy + C.ROWS * s - bh;
      ctx.fillStyle = th.rimSide;
      rr(ctx, x0, yTop, x1 - x0, RIM * s + bh, [0, 0, s * 0.18, s * 0.18]);
      ctx.fill();
      ctx.fillStyle = th.rimTop;
      ctx.fillRect(x0, yTop, x1 - x0, RIM * s);
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fillRect(ox, yTop, C.COLS * s, Math.max(1, s * 0.04));
      ctx.fillStyle = 'rgba(0,0,0,0.12)';
      ctx.fillRect(x0, yTop + RIM * s, x1 - x0, Math.max(1, s * 0.05));
    }

    // ---- block sprites ------------------------------------------------------------
    buildSprites(th) {
      const s = this.s;
      const bh = Math.round(BLOCK_H * s);
      this.bh = bh;
      const make = (draw, seed) => {
        const cv = this.makeCanvas(s, s + bh);
        const ctx = cv.getContext('2d');
        draw(ctx, s, bh, U.rng(seed));
        return cv;
      };
      this.wallSprites = [];
      this.crateSprites = [];
      for (let v = 0; v < 4; v++) {
        this.wallSprites.push(make((ctx, s, bh, rnd) => this.drawWall(ctx, th, s, bh, rnd, v), 11 + v * 7));
        this.crateSprites.push(make((ctx, s, bh, rnd) => this.drawCrate(ctx, th, s, bh, rnd, v), 51 + v * 13));
      }
    }

    drawBox(ctx, s, bh, top, side, edge) {
      ctx.fillStyle = side;
      ctx.fillRect(0, s - 1, s, bh + 1);
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.fillRect(0, s + bh - Math.max(1, s * 0.05), s, Math.max(1, s * 0.05));
      ctx.fillStyle = top;
      ctx.fillRect(0, 0, s, s);
      if (edge) {
        ctx.fillStyle = edge;
        ctx.fillRect(0, 0, s, Math.max(1, s * 0.06));
        ctx.fillRect(0, 0, Math.max(1, s * 0.06), s);
      }
      ctx.fillStyle = 'rgba(0,0,0,0.12)';
      ctx.fillRect(s - Math.max(1, s * 0.05), 0, Math.max(1, s * 0.05), s + bh);
    }

    drawWall(ctx, th, s, bh, rnd, v) {
      switch (th.wallStyle) {
        case 'multi': {
          const cols = ['#f0c43a', '#e8553f', '#3fa0e0', '#6cc04a'];
          const top = cols[v];
          this.drawBox(ctx, s, bh, top, U.shade(top, -0.28), U.shade(top, 0.35));
          ctx.fillStyle = U.shade(top, -0.12);
          const m = s * 0.5, r = s * 0.2;
          ctx.beginPath();
          if (v === 0) ctx.arc(m, m, r, 0, U.TAU);
          else if (v === 1) { ctx.moveTo(m, m - r); ctx.lineTo(m + r, m + r * 0.8); ctx.lineTo(m - r, m + r * 0.8); ctx.closePath(); }
          else if (v === 2) ctx.rect(m - r * 0.85, m - r * 0.85, r * 1.7, r * 1.7);
          else {
            for (let k = 0; k < 10; k++) {
              const a = -Math.PI / 2 + (k / 10) * U.TAU, rad = k % 2 ? r * 0.45 : r * 1.05;
              ctx.lineTo(m + Math.cos(a) * rad, m + Math.sin(a) * rad);
            }
            ctx.closePath();
          }
          ctx.fill();
          break;
        }
        case 'stone': {
          const top = U.shade(th.wallTop, (rnd() - 0.5) * 0.1);
          this.drawBox(ctx, s, bh, top, th.wallSide, th.wallEdge);
          ctx.strokeStyle = 'rgba(60,60,70,0.35)';
          ctx.lineWidth = Math.max(1, s * 0.03);
          for (let k = 0; k < 2; k++) {
            ctx.beginPath();
            let x = rnd() * s, y = rnd() * s * 0.3;
            ctx.moveTo(x, y);
            for (let j = 0; j < 3; j++) { x += (rnd() - 0.5) * s * 0.4; y += s * 0.25; ctx.lineTo(x, y); }
            ctx.stroke();
          }
          for (let k = 0; k < 14; k++) {
            ctx.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.12)';
            ctx.fillRect(rnd() * s, rnd() * s, s * 0.04, s * 0.04);
          }
          ctx.fillStyle = 'rgba(0,0,0,0.15)';
          ctx.fillRect(s * 0.5, s, Math.max(1, s * 0.03), bh);
          break;
        }
        case 'ice': {
          const g = ctx.createLinearGradient(0, 0, s, s);
          g.addColorStop(0, th.wallEdge);
          g.addColorStop(0.5, th.wallTop);
          g.addColorStop(1, U.shade(th.wallTop, -0.1));
          this.drawBox(ctx, s, bh, g, th.wallSide, null);
          ctx.fillStyle = 'rgba(255,255,255,0.55)';
          ctx.beginPath();
          const o = s * (0.1 + rnd() * 0.25);
          ctx.moveTo(o, s * 0.08); ctx.lineTo(o + s * 0.16, s * 0.08); ctx.lineTo(s * 0.08, o + s * 0.4); ctx.lineTo(s * 0.08, o + s * 0.22);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,0.7)';
          ctx.lineWidth = Math.max(1, s * 0.035);
          ctx.strokeRect(s * 0.04, s * 0.04, s * 0.92, s * 0.92);
          ctx.fillStyle = 'rgba(255,255,255,0.25)';
          ctx.fillRect(s * 0.15, s + bh * 0.3, s * 0.5, Math.max(1, bh * 0.12));
          break;
        }
        case 'hedge': {
          this.drawBox(ctx, s, bh, th.wallTop, th.wallSide, null);
          for (let k = 0; k < 16; k++) {
            const x = s * (0.1 + rnd() * 0.8), y = s * (0.1 + rnd() * 0.8), r = s * (0.08 + rnd() * 0.1);
            ctx.fillStyle = [th.wallEdge, U.shade(th.wallTop, -0.15), th.wallTop][k % 3];
            ctx.beginPath();
            ctx.arc(x, y, r, 0, U.TAU);
            ctx.fill();
          }
          for (let k = 0; k < 6; k++) {
            const x = s * (k / 5);
            ctx.fillStyle = U.shade(th.wallSide, -0.15);
            ctx.beginPath();
            ctx.arc(x, s + bh * 0.25, s * 0.09, 0, U.TAU);
            ctx.fill();
          }
          if (v === 2) {
            ctx.fillStyle = '#ffd1e0';
            ctx.beginPath(); ctx.arc(s * 0.3, s * 0.35, s * 0.05, 0, U.TAU); ctx.fill();
            ctx.fillStyle = '#fff2a8';
            ctx.beginPath(); ctx.arc(s * 0.7, s * 0.6, s * 0.05, 0, U.TAU); ctx.fill();
          }
          break;
        }
        case 'paper': {
          this.drawBox(ctx, s, bh, th.wallTop, th.wallSide, th.wallEdge);
          ctx.strokeStyle = 'rgba(80,110,160,0.18)';
          ctx.lineWidth = Math.max(1, s * 0.025);
          ctx.beginPath();
          if (v % 2) { ctx.moveTo(0, 0); ctx.lineTo(s, s); } else { ctx.moveTo(s, 0); ctx.lineTo(0, s); }
          ctx.stroke();
          ctx.strokeStyle = 'rgba(47,99,168,0.35)';
          ctx.strokeRect(s * 0.12, s * 0.12, s * 0.76, s * 0.76);
          break;
        }
        default: { // 'toy' — painted wooden block with a bevelled inset
          const top = U.shade(th.wallTop, (v - 1.5) * 0.03);
          this.drawBox(ctx, s, bh, top, th.wallSide, th.wallEdge);
          const i = s * 0.16;
          ctx.fillStyle = U.shade(th.wallTop, 0.1);
          ctx.fillRect(i, i, s - i * 2, s - i * 2);
          ctx.fillStyle = 'rgba(0,0,0,0.12)';
          ctx.fillRect(i, s - i, s - i * 2, Math.max(1, s * 0.035));
          ctx.fillRect(s - i, i, Math.max(1, s * 0.035), s - i * 2);
          ctx.strokeStyle = 'rgba(255,255,255,0.12)';
          ctx.lineWidth = Math.max(1, s * 0.02);
          for (let k = 0; k < 3; k++) {
            const y = s * (0.3 + k * 0.2 + rnd() * 0.05);
            ctx.beginPath(); ctx.moveTo(i, y); ctx.lineTo(s - i, y + (rnd() - 0.5) * s * 0.05); ctx.stroke();
          }
        }
      }
      ctx.strokeStyle = 'rgba(0,0,0,0.22)';
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, s - 1, s + bh - 1);
    }

    drawCrate(ctx, th, s, bh, rnd, v) {
      switch (th.crateStyle) {
        case 'planks': {
          this.drawBox(ctx, s, bh, th.crateTop, th.crateSide, U.shade(th.crateTop, 0.2));
          ctx.strokeStyle = th.crateMark;
          ctx.lineWidth = Math.max(1, s * 0.035);
          for (let k = 1; k < 4; k++) {
            ctx.beginPath(); ctx.moveTo(0, (k * s) / 4); ctx.lineTo(s, (k * s) / 4); ctx.stroke();
          }
          ctx.lineWidth = Math.max(1, s * 0.08);
          ctx.strokeStyle = U.shade(th.crateTop, -0.18);
          ctx.strokeRect(s * 0.06, s * 0.06, s * 0.88, s * 0.88);
          ctx.beginPath();
          if (v % 2) { ctx.moveTo(s * 0.1, s * 0.1); ctx.lineTo(s * 0.9, s * 0.9); } else { ctx.moveTo(s * 0.9, s * 0.1); ctx.lineTo(s * 0.1, s * 0.9); }
          ctx.stroke();
          ctx.fillStyle = 'rgba(40,30,20,0.6)';
          for (const [x, y] of [[0.12, 0.12], [0.88, 0.12], [0.12, 0.88], [0.88, 0.88]]) {
            ctx.beginPath(); ctx.arc(s * x, s * y, s * 0.025, 0, U.TAU); ctx.fill();
          }
          ctx.strokeStyle = th.crateMark;
          ctx.lineWidth = Math.max(1, s * 0.03);
          ctx.beginPath(); ctx.moveTo(0, s + bh / 2); ctx.lineTo(s, s + bh / 2); ctx.stroke();
          break;
        }
        case 'snow': {
          const g = ctx.createLinearGradient(0, 0, s, s);
          g.addColorStop(0, '#ffffff');
          g.addColorStop(1, th.crateMark);
          this.drawBox(ctx, s, bh, g, th.crateSide, null);
          ctx.fillStyle = 'rgba(160,190,215,0.35)';
          for (let k = 0; k < 5; k++) {
            ctx.beginPath();
            ctx.arc(s * (0.2 + rnd() * 0.6), s * (0.2 + rnd() * 0.6), s * (0.05 + rnd() * 0.06), 0, U.TAU);
            ctx.fill();
          }
          ctx.strokeStyle = 'rgba(150,180,210,0.5)';
          ctx.lineWidth = Math.max(1, s * 0.03);
          ctx.beginPath(); ctx.moveTo(s * 0.5, 0); ctx.lineTo(s * 0.5, s); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(0, s * 0.5); ctx.lineTo(s, s * 0.5); ctx.stroke();
          break;
        }
        case 'pot': { // terracotta planter with a round shrub
          this.drawBox(ctx, s, bh, th.crateTop, th.crateSide, th.crateMark);
          ctx.fillStyle = '#5a3a22';
          ctx.fillRect(s * 0.12, s * 0.12, s * 0.76, s * 0.76);
          const greens = ['#3f8a3a', '#57a84b', '#76c25f'];
          const blobs = [[0.5, 0.52, 0.3], [0.36, 0.42, 0.18], [0.62, 0.38, 0.17], [0.44, 0.6, 0.16], [0.64, 0.62, 0.15]];
          blobs.forEach(([x, y, r], k) => {
            ctx.fillStyle = greens[k === 0 ? 0 : 1 + (k % 2)];
            ctx.beginPath(); ctx.arc(s * x, s * y, s * r, 0, U.TAU); ctx.fill();
          });
          ctx.fillStyle = 'rgba(255,255,255,0.25)';
          ctx.beginPath(); ctx.arc(s * 0.4, s * 0.36, s * 0.07, 0, U.TAU); ctx.fill();
          if (v % 2) {
            ctx.fillStyle = '#ffe36e';
            ctx.beginPath(); ctx.arc(s * 0.62, s * 0.55, s * 0.045, 0, U.TAU); ctx.fill();
          }
          ctx.fillStyle = th.crateMark;
          ctx.fillRect(0, s + bh * 0.2, s, Math.max(1, bh * 0.18));
          break;
        }
        default: { // cardboard box with packing tape
          this.drawBox(ctx, s, bh, th.crateTop, th.crateSide, U.shade(th.crateTop, 0.15));
          ctx.strokeStyle = 'rgba(90,60,25,0.35)';
          ctx.lineWidth = Math.max(1, s * 0.03);
          ctx.beginPath(); ctx.moveTo(s * 0.04, s * 0.5); ctx.lineTo(s * 0.96, s * 0.5); ctx.stroke();
          ctx.fillStyle = th.crateMark;
          ctx.globalAlpha = 0.85;
          if (v % 2) ctx.fillRect(s * 0.4, 0, s * 0.2, s + bh);
          else ctx.fillRect(0, s * 0.42, s, s * 0.16);
          ctx.globalAlpha = 1;
          ctx.strokeStyle = 'rgba(90,60,25,0.45)';
          ctx.lineWidth = Math.max(1, s * 0.025);
          ctx.beginPath();
          ctx.moveTo(s * 0.12, s + bh * 0.35); ctx.lineTo(s * 0.32, s + bh * 0.35);
          ctx.moveTo(s * 0.12, s + bh * 0.6); ctx.lineTo(s * 0.26, s + bh * 0.6);
          ctx.stroke();
        }
      }
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, s - 1, s + bh - 1);
    }

    // ---- decals (tread marks, scorch marks, wrecks) ------------------------------------
    addDecal(d) {
      this.decals.push(d);
      if (this.decals.length > 9000) {
        let drop = 2500;
        this.decals = this.decals.filter((x) => !(x.type === 'tread' && drop-- > 0));
        this.redrawDecals();
      } else if (this.decalLayer) {
        this.stampDecal(this.decalLayer.getContext('2d'), d);
      }
    }

    redrawDecals() {
      if (!this.decalLayer) return;
      const ctx = this.decalLayer.getContext('2d');
      ctx.clearRect(0, 0, this.decalLayer.width, this.decalLayer.height);
      for (const d of this.decals) this.stampDecal(ctx, d);
    }

    stampDecal(ctx, d) {
      const s = this.s;
      const th = this.world.theme;
      const X = d.x * s, Y = d.y * s;
      if (d.type === 'tread') {
        ctx.save();
        ctx.translate(X, Y);
        ctx.rotate(d.angle);
        ctx.fillStyle = th.tread;
        const w = s * 0.08, h = s * 0.15;
        ctx.fillRect(-w / 2, -s * 0.3 - h / 2, w, h);
        ctx.fillRect(-w / 2, s * 0.3 - h / 2, w, h);
        ctx.restore();
      } else if (d.type === 'scorch') {
        const r = d.r * s;
        const g = ctx.createRadialGradient(X, Y, 0, X, Y, r);
        g.addColorStop(0, `rgba(${th.scorch},0.55)`);
        g.addColorStop(0.6, `rgba(${th.scorch},0.3)`);
        g.addColorStop(1, `rgba(${th.scorch},0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(X, Y, r, 0, U.TAU);
        ctx.fill();
        const rnd = U.rng(d.seed || 7);
        ctx.fillStyle = `rgba(${th.scorch},0.45)`;
        for (let k = 0; k < 10; k++) {
          const a = rnd() * U.TAU, dist = r * (0.6 + rnd() * 0.5);
          ctx.beginPath();
          ctx.arc(X + Math.cos(a) * dist, Y + Math.sin(a) * dist, s * (0.03 + rnd() * 0.05), 0, U.TAU);
          ctx.fill();
        }
      } else if (d.type === 'wreck') {
        ctx.save();
        ctx.translate(X, Y);
        ctx.rotate(d.angle);
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = '#2b2622';
        ctx.fillRect(-s * 0.43, -s * 0.38, s * 0.86, s * 0.16);
        ctx.fillRect(-s * 0.43, s * 0.22, s * 0.86, s * 0.16);
        ctx.fillStyle = d.dark;
        rr(ctx, -s * 0.35, -s * 0.24, s * 0.7, s * 0.48, s * 0.07);
        ctx.fill();
        ctx.fillStyle = 'rgba(20,15,10,0.55)';
        rr(ctx, -s * 0.35, -s * 0.24, s * 0.7, s * 0.48, s * 0.07);
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.lineWidth = s * 0.06;
        ctx.beginPath();
        ctx.moveTo(-s * 0.18, -s * 0.18); ctx.lineTo(s * 0.18, s * 0.18);
        ctx.moveTo(s * 0.18, -s * 0.18); ctx.lineTo(-s * 0.18, s * 0.18);
        ctx.stroke();
        ctx.restore();
        ctx.globalAlpha = 1;
      }
    }

    // ---- events -> effects ------------------------------------------------------------
    onEvent(ev) {
      const fx = this.fx;
      const w = this.world;
      const rand = Math.random;
      switch (ev.type) {
        case 'tread':
          this.addDecal({ type: 'tread', x: ev.x, y: ev.y, angle: ev.angle });
          break;
        case 'fire': {
          const ca = Math.cos(ev.angle), sa = Math.sin(ev.angle);
          fx.add({ kind: 'flash', x: ev.x, y: ev.y, z: TANK_LIFT + 0.1, r0: 0.45, life: 0.09 });
          fx.add({ kind: 'fire', x: ev.x, y: ev.y, z: TANK_LIFT + 0.1, r0: 0.12, r1: 0.05, life: 0.1 });
          for (let i = 0; i < 4; i++) {
            fx.add({
              kind: 'smoke', x: ev.x, y: ev.y, z: 0.15, r0: 0.07, r1: 0.22 + rand() * 0.1, a0: 0.5, life: 0.5 + rand() * 0.3,
              vx: ca * (0.6 + rand()) + (rand() - 0.5) * 0.6, vy: sa * (0.6 + rand()) + (rand() - 0.5) * 0.6, vz: 0.3,
            });
          }
          break;
        }
        case 'bounce':
          for (let i = 0; i < 5; i++) {
            const a = rand() * U.TAU, sp = 2 + rand() * 3;
            fx.add({ kind: 'spark', x: ev.x, y: ev.y, z: SHELL_LIFT, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.18, drag: 6 });
          }
          fx.add({ kind: 'smoke', x: ev.x, y: ev.y, z: SHELL_LIFT, r0: 0.05, r1: 0.18, a0: 0.4, life: 0.35 });
          break;
        case 'shellGone':
        case 'fizzle':
          for (let i = 0; i < 3; i++) {
            fx.add({
              kind: 'smoke', x: ev.x, y: ev.y, z: SHELL_LIFT, r0: 0.06, r1: 0.25, a0: 0.55, life: 0.45 + rand() * 0.2,
              vx: (rand() - 0.5), vy: (rand() - 0.5), vz: 0.2,
            });
          }
          for (let i = 0; i < 4; i++) {
            const a = rand() * U.TAU, sp = 1.5 + rand() * 2;
            fx.add({ kind: 'spark', x: ev.x, y: ev.y, z: SHELL_LIFT, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.15, drag: 6 });
          }
          break;
        case 'shellClash':
          fx.add({ kind: 'flash', x: ev.x, y: ev.y, z: SHELL_LIFT, r0: 0.5, life: 0.12 });
          for (let i = 0; i < 10; i++) {
            const a = rand() * U.TAU, sp = 2 + rand() * 4;
            fx.add({ kind: 'spark', x: ev.x, y: ev.y, z: SHELL_LIFT, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.25, drag: 5 });
          }
          break;
        case 'mineLay':
          for (let i = 0; i < 4; i++) {
            const a = rand() * U.TAU;
            fx.add({ kind: 'smoke', x: ev.x, y: ev.y, r0: 0.05, r1: 0.2, a0: 0.3, life: 0.4, vx: Math.cos(a) * 0.8, vy: Math.sin(a) * 0.8, color: '#cbbfa9' });
          }
          break;
        case 'tankDestroyed': {
          const t = w.tanks[ev.player];
          this.boom(ev.x, ev.y, 0.9, [t.color.body, t.color.dark, '#3a3a3a']);
          this.addDecal({ type: 'scorch', x: ev.x, y: ev.y, r: 0.9, seed: (rand() * 1e6) | 0 });
          this.addDecal({ type: 'wreck', x: ev.x, y: ev.y, angle: ev.angle, dark: t.color.dark });
          // The turret pops off and tumbles away.
          const a = rand() * U.TAU;
          fx.add({
            kind: 'debris', x: ev.x, y: ev.y, z: 0.2, vz: 4.5, gravity: 14, vx: Math.cos(a) * 1.6, vy: Math.sin(a) * 1.6,
            size: 0.3, color: t.color.dark, spin: 9, life: 1.4, drag: 0.6,
          });
          this.shake = Math.max(this.shake, 0.6);
          break;
        }
        case 'explosion':
          this.boom(ev.x, ev.y, ev.r, ['#5a5048', '#2f2a26', '#7a6a58']);
          fx.add({ kind: 'ring', x: ev.x, y: ev.y, r0: 0.2, r1: ev.r * 1.05, life: 0.45, color: '#fff3d0' });
          this.addDecal({ type: 'scorch', x: ev.x, y: ev.y, r: ev.r * 0.85, seed: (rand() * 1e6) | 0 });
          this.shake = Math.max(this.shake, 1);
          break;
        case 'crateDestroyed': {
          const th = w.theme;
          for (let i = 0; i < 9; i++) {
            const a = rand() * U.TAU, sp = 1 + rand() * 3;
            fx.add({
              kind: 'debris', x: ev.c + 0.5, y: ev.r + 0.5, z: BLOCK_H * 0.6, vz: 2 + rand() * 3, gravity: 12,
              vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, size: 0.1 + rand() * 0.12,
              color: rand() < 0.5 ? th.crateTop : th.crateSide, spin: (rand() - 0.5) * 20, life: 1 + rand() * 0.5, drag: 1.5,
            });
          }
          fx.add({ kind: 'smoke', x: ev.c + 0.5, y: ev.r + 0.5, z: 0.2, r0: 0.3, r1: 0.8, a0: 0.45, life: 0.8, color: '#d8cdb8' });
          break;
        }
      }
    }

    boom(x, y, r, debrisColors) {
      const fx = this.fx;
      const rand = Math.random;
      fx.add({ kind: 'flash', x, y, z: 0.2, r0: r * 1.5, life: 0.16 });
      for (let i = 0; i < 9; i++) {
        const a = rand() * U.TAU, d = rand() * r * 0.45;
        fx.add({
          kind: 'fire', x: x + Math.cos(a) * d, y: y + Math.sin(a) * d, z: 0.15, r0: r * 0.25, r1: r * (0.45 + rand() * 0.3),
          life: 0.3 + rand() * 0.25, vz: 0.6,
        });
      }
      for (let i = 0; i < 12; i++) {
        const a = rand() * U.TAU, sp = 0.5 + rand() * 1.5;
        fx.add({
          kind: 'smoke', x, y, z: 0.2, r0: r * 0.2, r1: r * (0.5 + rand() * 0.4), a0: 0.6, life: 1 + rand() * 0.8,
          vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, vz: 0.5 + rand() * 0.6, color: rand() < 0.5 ? '#5d5650' : '#8a827a', drag: 1.8,
        });
      }
      for (let i = 0; i < 12; i++) {
        const a = rand() * U.TAU, sp = 2 + rand() * 4;
        fx.add({
          kind: 'debris', x, y, z: 0.2, vz: 2 + rand() * 4, gravity: 14, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
          size: 0.06 + rand() * 0.1, color: debrisColors[i % debrisColors.length], spin: (rand() - 0.5) * 25, life: 0.8 + rand() * 0.6, drag: 1.5,
        });
      }
      for (let i = 0; i < 10; i++) {
        const a = rand() * U.TAU, sp = 4 + rand() * 5;
        fx.add({ kind: 'spark', x, y, z: 0.2, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.3, drag: 4 });
      }
    }

    // ---- per-frame drawing ------------------------------------------------------------------
    render(dt, view) {
      // view: { aims: [{show, mode, x, y}], labels: bool, paused: bool }
      const ctx = this.ctx;
      const w = this.world;
      this.time += dt;
      if (!w || !this.staticLayer) {
        ctx.fillStyle = '#1c1a22';
        ctx.fillRect(0, 0, this.W, this.H);
        return;
      }
      this.fx.update(dt);
      this.spawnTrails(dt);

      const s = this.s;
      this.shake *= Math.exp(-6 * dt);
      const sh = this.shake * s * 0.12;
      const sx = sh > 0.3 ? (Math.random() - 0.5) * sh : 0;
      const sy = sh > 0.3 ? (Math.random() - 0.5) * sh : 0;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(this.staticLayer, 0, 0);
      ctx.setTransform(1, 0, 0, 1, sx, sy);
      ctx.drawImage(this.decalLayer, this.ox, this.oy);

      this.drawShadows(ctx);
      for (const m of w.mines) this.drawMine(ctx, m);

      // Blocks and tanks, back to front.
      const bh = this.bh;
      for (let r = 0; r < C.ROWS; r++) {
        for (let c = 0; c < C.COLS; c++) {
          const t = w.grid[r * C.COLS + c];
          if (t !== T.WALL && t !== T.CRATE) continue;
          const v = (c * 7 + r * 13 + ((c * r) % 5)) % 4;
          const spr = t === T.WALL ? this.wallSprites[v] : this.crateSprites[v];
          ctx.drawImage(spr, this.ox + c * s, this.oy + r * s - bh);
        }
        for (const tank of w.tanks) {
          if (tank.alive && Math.floor(tank.y) === r) this.drawTank(ctx, tank);
        }
      }

      if (view && view.aims) {
        view.aims.forEach((a, i) => { if (a && a.show && w.tanks[i].alive) this.drawAim(ctx, w.tanks[i], a); });
      }
      for (const b of w.bullets) this.drawShell(ctx, b);

      ctx.drawImage(this.fgLayer, 0, 0);
      this.fx.draw(ctx, this);
      if (view && view.labels) for (const t of w.tanks) if (t.alive) this.drawLabel(ctx, t);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    spawnTrails(dt) {
      const w = this.world;
      const kind = w.ammo === C.AMMO.rocket ? 'rocket' : w.ammo === C.AMMO.rubber ? 'rubber' : 'classic';
      const interval = kind === 'rocket' ? 0.018 : 0.035;
      const seen = new Set();
      for (const b of w.bullets) {
        seen.add(b.id);
        let acc = (this.trail.get(b.id) || 0) + dt;
        while (acc > interval) {
          acc -= interval;
          if (kind === 'rubber') {
            this.fx.add({ kind: 'ghost', x: b.x, y: b.y, z: SHELL_LIFT, r0: 0.09, life: 0.25, color: w.tanks[b.owner].color.light });
          } else {
            this.fx.add({
              kind: 'smoke', x: b.x - b.vx * 0.012, y: b.y - b.vy * 0.012, z: SHELL_LIFT, r0: 0.04,
              r1: kind === 'rocket' ? 0.16 : 0.11, a0: kind === 'rocket' ? 0.55 : 0.4, life: kind === 'rocket' ? 0.55 : 0.45,
              color: '#e8e4dc', vz: 0.1,
            });
            if (kind === 'rocket') {
              this.fx.add({ kind: 'fire', x: b.x - b.vx * 0.02, y: b.y - b.vy * 0.02, z: SHELL_LIFT, r0: 0.09, r1: 0.02, life: 0.08 });
            }
          }
        }
        this.trail.set(b.id, acc);
      }
      for (const id of this.trail.keys()) if (!seen.has(id)) this.trail.delete(id);
    }

    drawShadows(ctx) {
      const w = this.world;
      const s = this.s;
      const ox = this.ox, oy = this.oy;
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.beginPath();
      for (let r = 0; r < C.ROWS; r++) {
        for (let c = 0; c < C.COLS; c++) {
          const t = w.grid[r * C.COLS + c];
          if (t !== T.WALL && t !== T.CRATE) continue;
          ctx.rect(ox + (c + LIGHT.x) * s, oy + (r + LIGHT.y) * s, s, s);
        }
      }
      ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      for (const t of w.tanks) {
        if (!t.alive) continue;
        ctx.save();
        ctx.translate(ox + (t.x + 0.1) * s, oy + (t.y + 0.12) * s);
        ctx.rotate(t.angle);
        rr(ctx, -s * 0.46, -s * 0.4, s * 0.92, s * 0.8, s * 0.15);
        ctx.fill();
        ctx.restore();
      }
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      for (const b of w.bullets) {
        ctx.beginPath();
        ctx.ellipse(ox + (b.x + 0.1) * s, oy + (b.y + 0.08) * s, s * 0.1, s * 0.06, Math.atan2(b.vy, b.vx), 0, U.TAU);
        ctx.fill();
      }
    }

    drawTank(ctx, t) {
      const s = this.s;
      const X = this.ox + t.x * s;
      const Y = this.oy + (t.y - TANK_LIFT) * s;
      const col = t.color;
      ctx.save();
      ctx.translate(X, Y);
      ctx.rotate(t.angle);

      // Treads
      const tl = s * 0.88, tw = s * 0.2;
      for (const side of [-1, 1]) {
        const ty = side * s * 0.29 - tw / 2;
        ctx.fillStyle = '#2d2b2a';
        rr(ctx, -tl / 2, ty, tl, tw, s * 0.06);
        ctx.fill();
        ctx.save();
        ctx.beginPath();
        ctx.rect(-tl / 2, ty, tl, tw);
        ctx.clip();
        ctx.strokeStyle = '#4c4845';
        ctx.lineWidth = Math.max(1, s * 0.035);
        const gap = s * 0.11;
        let off = ((t.treadPhase * s * (side === 1 ? 1 : 1)) % gap + gap) % gap;
        for (let x = -tl / 2 - gap + off; x < tl / 2 + gap; x += gap) {
          ctx.beginPath();
          ctx.moveTo(x, ty);
          ctx.lineTo(x, ty + tw);
          ctx.stroke();
        }
        ctx.restore();
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.fillRect(-tl / 2 + s * 0.04, ty + s * 0.02, tl - s * 0.08, s * 0.035);
      }

      // Hull
      const hl = s * 0.74, hw = s * 0.48;
      ctx.fillStyle = col.dark;
      rr(ctx, -hl / 2, -hw / 2 + s * 0.03, hl, hw, s * 0.08);
      ctx.fill();
      ctx.fillStyle = col.body;
      rr(ctx, -hl / 2, -hw / 2, hl, hw - s * 0.03, s * 0.08);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      rr(ctx, -hl / 2 + s * 0.05, -hw / 2 + s * 0.04, hl - s * 0.1, s * 0.08, s * 0.04);
      ctx.fill();
      // front glacis + rear vents
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = Math.max(1, s * 0.025);
      ctx.beginPath();
      ctx.moveTo(hl / 2 - s * 0.1, -hw / 2 + s * 0.05);
      ctx.lineTo(hl / 2 - s * 0.1, hw / 2 - s * 0.08);
      for (let k = 0; k < 3; k++) {
        const x = -hl / 2 + s * (0.07 + k * 0.05);
        ctx.moveTo(x, -hw * 0.25);
        ctx.lineTo(x, hw * 0.2);
      }
      ctx.stroke();

      // Turret + barrel
      ctx.rotate(t.turret - t.angle);
      const bl = (C.BARREL_LEN - t.recoil * 0.1) * s;
      const bw = s * 0.13;
      ctx.fillStyle = col.dark;
      rr(ctx, 0, -bw / 2, bl, bw, s * 0.03);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(s * 0.1, -bw / 2 + s * 0.015, bl - s * 0.14, s * 0.03);
      ctx.fillStyle = '#2d2b2a';
      rr(ctx, bl - s * 0.08, -bw / 2 - s * 0.015, s * 0.09, bw + s * 0.03, s * 0.02);
      ctx.fill();

      ctx.fillStyle = col.dark;
      ctx.beginPath();
      ctx.arc(0, s * 0.02, s * 0.21, 0, U.TAU);
      ctx.fill();
      ctx.fillStyle = col.light;
      ctx.beginPath();
      ctx.arc(0, 0, s * 0.2, 0, U.TAU);
      ctx.fill();
      ctx.fillStyle = col.body;
      ctx.beginPath();
      ctx.arc(s * 0.015, s * 0.02, s * 0.16, 0, U.TAU);
      ctx.fill();
      ctx.fillStyle = col.dark;
      ctx.beginPath();
      ctx.arc(-s * 0.05, 0, s * 0.06, 0, U.TAU);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.arc(-s * 0.07, -s * 0.07, s * 0.04, 0, U.TAU);
      ctx.fill();
      ctx.restore();
    }

    drawShell(ctx, b) {
      const s = this.s;
      const w = this.world;
      const X = this.ox + b.x * s;
      const Y = this.oy + (b.y - SHELL_LIFT) * s;
      const col = w.tanks[b.owner].color;
      ctx.save();
      ctx.translate(X, Y);
      if (w.ammo === C.AMMO.rubber) {
        ctx.fillStyle = col.light;
        ctx.strokeStyle = col.dark;
        ctx.lineWidth = Math.max(1, s * 0.03);
        ctx.beginPath();
        ctx.arc(0, 0, s * 0.1, 0, U.TAU);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.beginPath();
        ctx.arc(-s * 0.03, -s * 0.03, s * 0.03, 0, U.TAU);
        ctx.fill();
      } else {
        ctx.rotate(Math.atan2(b.vy, b.vx));
        const len = (w.ammo === C.AMMO.rocket ? 0.34 : 0.26) * s;
        const wid = 0.13 * s;
        ctx.fillStyle = '#f4f0e6';
        ctx.strokeStyle = '#4a4540';
        ctx.lineWidth = Math.max(1, s * 0.025);
        ctx.beginPath();
        ctx.moveTo(-len / 2, -wid / 2);
        ctx.lineTo(len / 2 - wid / 2, -wid / 2);
        ctx.arc(len / 2 - wid / 2, 0, wid / 2, -Math.PI / 2, Math.PI / 2);
        ctx.lineTo(-len / 2, wid / 2);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = col.body;
        ctx.fillRect(-len / 2, -wid / 2, len * 0.3, wid);
        if (w.ammo === C.AMMO.rocket) {
          ctx.fillStyle = '#c94a2a';
          ctx.beginPath();
          ctx.moveTo(-len / 2, -wid / 2); ctx.lineTo(-len / 2 - s * 0.06, -wid); ctx.lineTo(-len / 2 + s * 0.06, -wid / 2);
          ctx.moveTo(-len / 2, wid / 2); ctx.lineTo(-len / 2 - s * 0.06, wid); ctx.lineTo(-len / 2 + s * 0.06, wid / 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }

    drawMine(ctx, m) {
      const s = this.s;
      const w = this.world;
      const X = this.ox + m.x * s;
      const Y = this.oy + m.y * s;
      const col = w.tanks[m.owner].color;
      const r = C.MINE_RADIUS * s;
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath();
      ctx.ellipse(X + s * 0.05, Y + s * 0.05, r * 1.05, r * 0.95, 0, 0, U.TAU);
      ctx.fill();
      if (m.triggered) {
        const pulse = (this.time * 6) % 1;
        ctx.strokeStyle = `rgba(255,70,50,${0.8 * (1 - pulse)})`;
        ctx.lineWidth = Math.max(1, s * 0.05);
        ctx.beginPath();
        ctx.arc(X, Y, r + pulse * s * 0.6, 0, U.TAU);
        ctx.stroke();
      }
      ctx.fillStyle = '#3b3936';
      ctx.beginPath();
      ctx.arc(X, Y, r, 0, U.TAU);
      ctx.fill();
      ctx.fillStyle = col.body;
      ctx.beginPath();
      ctx.arc(X, Y, r * 0.78, 0, U.TAU);
      ctx.fill();
      ctx.fillStyle = '#55524d';
      ctx.beginPath();
      ctx.arc(X, Y, r * 0.55, 0, U.TAU);
      ctx.fill();
      // blinking light — faster as the fuse runs down
      const period = !m.armed ? 1e9 : m.triggered ? 0.1 : m.fuse < 1.5 ? 0.2 : m.fuse < 4 ? 0.5 : 1.0;
      const on = m.armed && ((m.age / period) % 1) < 0.5;
      ctx.fillStyle = on ? '#ff4a3a' : m.armed ? '#7a2a22' : '#5b5752';
      ctx.beginPath();
      ctx.arc(X, Y, r * 0.28, 0, U.TAU);
      ctx.fill();
      if (on) {
        const g = ctx.createRadialGradient(X, Y, 0, X, Y, r * 1.4);
        g.addColorStop(0, 'rgba(255,90,60,0.45)');
        g.addColorStop(1, 'rgba(255,90,60,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(X, Y, r * 1.4, 0, U.TAU);
        ctx.fill();
      }
    }

    drawAim(ctx, t, a) {
      const s = this.s;
      ctx.save();
      ctx.fillStyle = t.color.light;
      ctx.globalAlpha = 0.6;
      if (a.mode === 'point') {
        const X = this.ox + a.x * s, Y = this.oy + a.y * s;
        ctx.strokeStyle = t.color.body;
        ctx.lineWidth = Math.max(1.5, s * 0.05);
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.arc(X, Y, s * 0.22, 0, U.TAU);
        ctx.moveTo(X - s * 0.34, Y); ctx.lineTo(X - s * 0.12, Y);
        ctx.moveTo(X + s * 0.12, Y); ctx.lineTo(X + s * 0.34, Y);
        ctx.moveTo(X, Y - s * 0.34); ctx.lineTo(X, Y - s * 0.12);
        ctx.moveTo(X, Y + s * 0.12); ctx.lineTo(X, Y + s * 0.34);
        ctx.stroke();
      } else {
        const ca = Math.cos(t.turret), sa = Math.sin(t.turret);
        for (let d = 0.85; d < 2.6; d += 0.28) {
          const X = this.ox + (t.x + ca * d) * s;
          const Y = this.oy + (t.y + sa * d - SHELL_LIFT) * s;
          ctx.globalAlpha = 0.65 * (1 - (d - 0.85) / 1.9);
          ctx.beginPath();
          ctx.arc(X, Y, s * 0.045, 0, U.TAU);
          ctx.fill();
        }
      }
      ctx.restore();
    }

    drawLabel(ctx, t) {
      const s = this.s;
      const X = this.ox + t.x * s;
      const Y = this.oy + (t.y - 0.85) * s + Math.sin(this.time * 5) * s * 0.05;
      const label = 'P' + (t.index + 1);
      ctx.font = `700 ${Math.round(s * 0.38)}px "Lilita One", "Arial Rounded MT Bold", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const wdt = ctx.measureText(label).width + s * 0.3;
      ctx.fillStyle = t.color.body;
      rr(ctx, X - wdt / 2, Y - s * 0.24, wdt, s * 0.48, s * 0.14);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(X - s * 0.1, Y + s * 0.23); ctx.lineTo(X + s * 0.1, Y + s * 0.23); ctx.lineTo(X, Y + s * 0.38);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(label, X, Y + s * 0.02);
    }
  }

  RR.Renderer = Renderer;
  RR.FX = FX;

  // Small arena preview used in the lobby.
  RR.drawArenaPreview = function drawArenaPreview(canvas, def, colors) {
    const a = RR.buildArena(def);
    const th = a.theme;
    const ctx = canvas.getContext('2d');
    const cw = canvas.width, ch = canvas.height;
    const s = Math.min(cw / (C.COLS + 1), ch / (C.ROWS + 1));
    const ox = (cw - C.COLS * s) / 2, oy = (ch - C.ROWS * s) / 2;
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = th.rimTop;
    rr(ctx, ox - s * 0.5, oy - s * 0.5, (C.COLS + 1) * s, (C.ROWS + 1) * s, s * 0.3);
    ctx.fill();
    ctx.fillStyle = th.floor;
    ctx.fillRect(ox, oy, C.COLS * s, C.ROWS * s);
    for (let r = 0; r < C.ROWS; r++) {
      for (let c = 0; c < C.COLS; c++) {
        const t = a.grid[r * C.COLS + c];
        if (t === T.FLOOR) continue;
        const x = ox + c * s, y = oy + r * s;
        if (t === T.PIT) { ctx.fillStyle = th.pit; ctx.fillRect(x, y, s, s); continue; }
        ctx.fillStyle = t === T.WALL ? th.wallSide : th.crateSide;
        ctx.fillRect(x, y, s, s);
        ctx.fillStyle = t === T.WALL ? th.wallTop : th.crateTop;
        ctx.fillRect(x, y, s, s * 0.75);
      }
    }
    a.spawns.forEach((sp, i) => {
      ctx.fillStyle = (colors && colors[i] ? colors[i] : C.PLAYER_COLORS[i]).body;
      ctx.beginPath();
      ctx.arc(ox + sp.x * s, oy + sp.y * s, s * 0.42, 0, U.TAU);
      ctx.fill();
    });
  };
})();
