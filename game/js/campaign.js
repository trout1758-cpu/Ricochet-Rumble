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

  const NEAR = [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [1, -1], [-1, 1], [-1, -1], [0, 2], [0, -2], [2, 0], [-2, 0], [1, 2], [1, -2], [2, 1], [2, -1]];

  function tiles(arena) {
    const grid = arena.grid;
    const tile = (c, r) => (c < 0 || r < 0 || c >= C.COLS || r >= C.ROWS ? T.WALL : grid[r * C.COLS + c]);
    const roomy = (c, r) => {
      for (const [dc, dr] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) if (tile(c + dc, r + dr) !== T.FLOOR) return false;
      return true;
    };
    return { tile, roomy };
  }

  // Up to `n` start spots packed round `origin` (origin first), avoiding `taken`.
  // Team-mates in battles stand a little further apart.
  const WIDE = [[0, 2], [0, -2], [2, 0], [-2, 0], [2, 2], [2, -2], [-2, 2], [-2, -2], ...NEAR];

  function cluster(arena, origin, n, taken = [], flipX = false, near = NEAR) {
    const { tile } = tiles(arena);
    const out = [origin];
    const used = [...taken, origin];
    for (const [dc0, dr] of near) {
      if (out.length >= n) break;
      const dc = flipX ? -dc0 : dc0;
      const c = Math.floor(origin.x) + dc, r = Math.floor(origin.y) + dr;
      const p = { x: c + 0.5, y: r + 0.5, angle: origin.angle };
      if (tile(c, r) !== T.FLOOR || used.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 0.9)) continue;
      out.push(p);
      used.push(p);
    }
    while (out.length < n) out.push({ x: origin.x, y: origin.y + 0.8 * out.length, angle: origin.angle });
    return out;
  }

  // Nearest comfortable floor tile to (x, y).
  function nearestFloor(arena, x, y) {
    const { tile, roomy } = tiles(arena);
    let best = null, bd = Infinity;
    for (let pass = 0; pass < 2 && !best; pass++) {
      for (let r = 0; r < C.ROWS; r++) {
        for (let c = 0; c < C.COLS; c++) {
          if (tile(c, r) !== T.FLOOR || (pass === 0 && !roomy(c, r))) continue;
          const d = Math.hypot(c + 0.5 - x, r + 0.5 - y);
          if (d < bd) { bd = d; best = { x: c + 0.5, y: r + 0.5 }; }
        }
      }
    }
    return best;
  }

  // Co-op: everyone starts together at the arena's player-1 start.
  function spawnsFor(def, n = 4) {
    const arena = RR.buildArena(def);
    return cluster(arena, arena.spawns[0], n);
  }

  // Battle spawns for the players taking part (array of player indices).
  //   teams: null for free-for-all, else teams[i] = 0 or 1 for each player.
  // Free-for-all uses the arena's two starts plus a top and a bottom spot
  // (the bottom one the point-mirror of the top); teams start side by side.
  // Returns spawns indexed by player index.
  function battle(def, slots, teams) {
    const arena = RR.buildArena(def);
    const out = [];
    if (teams) {
      const a = slots.filter((i) => teams[i] === 0), b = slots.filter((i) => teams[i] !== 0);
      const ca = cluster(arena, arena.spawns[0], a.length, [], false, WIDE);
      const cb = cluster(arena, arena.spawns[1], b.length, ca, true, WIDE);
      a.forEach((i, k) => { out[i] = ca[k]; });
      b.forEach((i, k) => { out[i] = cb[k]; });
      return out;
    }
    const top = nearestFloor(arena, C.COLS / 2 - 0.5, 1.5) || arena.spawns[0];
    const bot = nearestFloor(arena, C.COLS - top.x, C.ROWS - top.y) || arena.spawns[1];
    const spots = [
      arena.spawns[0], arena.spawns[1],
      { x: top.x, y: top.y, angle: Math.PI / 2 }, { x: bot.x, y: bot.y, angle: -Math.PI / 2 },
    ];
    slots.forEach((i, k) => { out[i] = spots[k % spots.length]; });
    return out;
  }

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
    const starts = cluster(arena, arena.spawns[0], 4);
    const [p1, p2] = starts;

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
    return { def, enemies: picked.map(({ type, x, y, angle }) => ({ type, x, y, angle })), spawns: starts };
  }

  RR.Campaign = { stage, spawnsFor, count: STAGES.length };
  RR.Spawns = { battle, cluster };

  // Survival: which tanks make up wave n. More of them, and tougher types
  // join as the waves go on (newest types a little more likely).
  function survivalWave(n, rnd = Math.random) {
    const pool = Object.entries(C.SURVIVAL.POOL).filter(([, from]) => from <= n);
    const count = Math.min(14, 1 + Math.ceil(n * 0.9));
    const out = [];
    const total = pool.reduce((a, [, from]) => a + 1 + from * 0.5, 0);
    for (let k = 0; k < count; k++) {
      let r = rnd() * total;
      for (const [type, from] of pool) {
        r -= 1 + from * 0.5;
        if (r <= 0) { out.push(type); break; }
      }
      if (out.length <= k) out.push(pool[pool.length - 1][0]);
    }
    // the boss shows up on every 10th wave
    if (n % 10 === 0) out[0] = 'commander';
    return out;
  }
  RR.Survival = { wave: survivalWave };
})();
