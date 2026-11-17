// Ricochet Rumble — co-op campaign stages: which arena, where the players
// start, and where the CPU tanks wait. Positions are worked out from the
// arena itself (same every time for a given stage).
window.RR = window.RR || {};

(function () {
  const C = RR.CFG;
  const T = RR.TILE;

  function seeded(seed) {
    let s = (seed * 2654435761) >>> 0 || 1;
    return () => {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }

  const STAGES = C.CAMPAIGN.STAGES;

  // Stage n (1-based) -> { def, enemies, spawns }
  function stage(n) {
    const defs = RR.ARENA_DEFS;
    const def = defs[(n - 1) % defs.length];
    const arena = RR.buildArena(def);
    const grid = arena.grid;
    const tile = (c, r) => (c < 0 || r < 0 || c >= C.COLS || r >= C.ROWS ? T.WALL : grid[r * C.COLS + c]);
    // a tile a tank can sit in comfortably: floor all round
    const roomy = (c, r) => {
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (Math.abs(dr) + Math.abs(dc) <= 1 && tile(c + dc, r + dr) !== T.FLOOR) return false;
      return true;
    };
    const p1 = arena.spawns[0];
    // player 2 starts next to player 1
    let p2 = null;
    for (const [dc, dr] of [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [1, -1], [0, 2], [0, -2], [2, 0], [-1, 1], [-1, -1]]) {
      const c = Math.floor(p1.x) + dc, r = Math.floor(p1.y) + dr;
      if (tile(c, r) === T.FLOOR) { p2 = { x: c + 0.5, y: r + 0.5, angle: p1.angle }; break; }
    }
    if (!p2) p2 = { x: p1.x, y: p1.y + 0.8, angle: p1.angle };

    // enemies: open tiles far from the players, spread out, best ones on the far side
    const rnd = seeded(n * 97 + 13);
    const cands = [];
    for (let r = 0; r < C.ROWS; r++) {
      for (let c = 0; c < C.COLS; c++) {
        if (tile(c, r) !== T.FLOOR || !roomy(c, r)) continue;
        const x = c + 0.5, y = r + 0.5;
        const d = Math.min(Math.hypot(x - p1.x, y - p1.y), Math.hypot(x - p2.x, y - p2.y));
        if (d < 7) continue;
        cands.push({ x, y, score: d + rnd() * 4 });
      }
    }
    cands.sort((a, b) => b.score - a.score);
    const picked = [];
    for (const type of STAGES[n - 1]) {
      let spot = cands.find((p) => picked.every((q) => Math.hypot(q.x - p.x, q.y - p.y) > 3));
      if (!spot) spot = cands.find((p) => picked.every((q) => Math.hypot(q.x - p.x, q.y - p.y) > 1.2));
      if (!spot) break;
      picked.push(spot);
      const angle = Math.atan2(p1.y - spot.y, p1.x - spot.x);
      picked[picked.length - 1] = Object.assign({}, spot, { type, angle });
    }
    return { def, enemies: picked.map(({ type, x, y, angle }) => ({ type, x, y, angle })), spawns: [p1, p2] };
  }

  RR.Campaign = { stage, count: STAGES.length };
})();
