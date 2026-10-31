// Ricochet Rumble — tuning constants.
// All distances are in arena tiles, all times in seconds.
window.RR = window.RR || {};

RR.CFG = {
  COLS: 22,
  ROWS: 13,
  SIM_HZ: 120,

  // Tanks
  TANK_RADIUS: 0.36,        // body collision vs walls / other tanks
  TANK_HIT_RADIUS: 0.34,    // what a shell has to touch to score a hit
  TANK_SPEED: 2.4,          // tiles per second at full stick
  TANK_TURN_RATE: 5.2,      // body rotation, radians per second
  TURRET_TURN_RATE: 14,     // turret rotation, radians per second
  BARREL_LEN: 0.6,
  FIRE_COOLDOWN: 0.16,

  // Shells
  BULLET_RADIUS: 0.09,
  BULLET_STEP: 0.04,        // max sub-step length, keeps shells from tunnelling

  // Mines
  MINE_MAX: 2,
  MINE_COOLDOWN: 1.0,
  MINE_RADIUS: 0.22,
  MINE_ARM_TIME: 0.8,
  MINE_FUSE: 10,
  MINE_TRIGGER_RADIUS: 1.05,
  MINE_TRIGGER_FUSE: 0.4,
  MINE_BLAST_RADIUS: 1.75,
  MINE_CHAIN_DELAY: 0.09,

  // Round flow
  ROUND_INTRO: 2.4,
  ROUND_GRACE: 1.4,         // keep simulating after the first kill (trades → draw)
  ROUND_RESULT: 2.8,

  // Ammo presets selectable in the lobby
  AMMO: {
    classic: { label: 'Classic', speed: 5.6, bounces: 1, max: 5, desc: '1 bounce · 5 shells' },
    rubber:  { label: 'Rubber',  speed: 4.4, bounces: 3, max: 4, desc: '3 bounces · 4 shells' },
    rocket:  { label: 'Rocket',  speed: 9.6, bounces: 1, max: 2, desc: 'fast · 1 bounce · 2 shells' },
  },

  // Theme mechanics ("arena effects", switchable in the lobby), keyed by theme
  MECH: {
    frost:    { name: 'Slippery ice', desc: 'Tanks slide on the ice' },
    space:    { name: 'Black holes', desc: 'Black holes bend shells and swallow them' },
    volcano:  { name: 'Eruptions', desc: 'Lava spits fireballs: get out of the red circles' },
    beach:    { name: 'Tide', desc: 'The tide comes in and slows tanks near the water' },
    playroom: { name: 'Bouncy blocks', desc: 'Shells bounce one extra time' },
    sandbox:  { name: 'Sandstorms', desc: 'Sandstorms blow through and hide the arena' },
    garden:   { name: 'Regrowth', desc: 'Blasted planters grow back' },
  },
  ICE_GRIP: 2.0,            // how quickly tanks match the stick on ice (higher = less slide)
  HOLE_RADIUS: 2.8,         // black hole pull range
  HOLE_PULL: 2.4,
  HOLE_CORE: 0.3,           // shells closer than this are swallowed
  ERUPT_FIRST: 6,
  ERUPT_EVERY: [7, 11],
  ERUPT_FUSE: 1.5,
  ERUPT_RADIUS: 0.95,
  TIDE_CYCLE: [14, 2, 7, 2],   // calm, rising, high, falling (seconds)
  TIDE_SLOW: 0.5,
  STORM_CYCLE: [16, 2, 6, 2],
  REGROW_TIME: 12,

  // Instant replay
  REPLAY_BEFORE: 2.4,       // seconds of action before the last kill
  REPLAY_AFTER: 0.7,
  REPLAY_SPEED: 0.5,

  PLAYER_COLORS: [
    { name: 'Tomato',  body: '#e8553f', dark: '#a8321f', light: '#ff8a6e', rgb: [232, 85, 63] },
    { name: 'Cobalt',  body: '#3b7be0', dark: '#21509c', light: '#78a9ff', rgb: [59, 123, 224] },
    { name: 'Lime',    body: '#7cc242', dark: '#4e8722', light: '#a9e275', rgb: [124, 194, 66] },
    { name: 'Violet',  body: '#9a5ad8', dark: '#663399', light: '#c08cf2', rgb: [154, 90, 216] },
    { name: 'Sunflower', body: '#f2b632', dark: '#b07e10', light: '#ffd76e', rgb: [242, 182, 50] },
    { name: 'Teal',    body: '#2fb5a6', dark: '#1a7c71', light: '#6be0d2', rgb: [47, 181, 166] },
  ],
};
