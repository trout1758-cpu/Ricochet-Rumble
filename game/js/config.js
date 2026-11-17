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

  // Power-ups (switchable in the lobby): one drops into the arena every so often.
  POWERUP_FIRST: 6,
  POWERUP_EVERY: [9, 14],
  POWERUP_MAX: 2,           // on the floor at once (pairs in a duel, so it stays fair)
  POWERUP_RADIUS: 0.42,
  POWERUP_LIFE: 16,         // seconds before an untouched one fades away
  POWERUPS: {
    shield: { name: 'Shield', desc: 'Blocks one hit', color: '#5ad1ff', time: 0 },
    speed:  { name: 'Turbo', desc: 'Drive 50% faster', color: '#ffcd45', time: 8 },
    spread: { name: 'Triple shot', desc: 'Every shot fires three shells', color: '#ff7b5c', time: 9 },
    bouncy: { name: 'Super bounce', desc: 'Shells bounce two extra times', color: '#b06cff', time: 12 },
    rapid:  { name: 'Rapid fire', desc: 'Three more shells in the air', color: '#7cc242', time: 10 },
  },
  TURBO: 1.5,
  SPREAD_ANGLE: 0.24,

  // CPU tanks (campaign enemies, and the computer opponent in a duel).
  //   speed: share of TANK_SPEED (0 = stays put) · turn: turret rad/s
  //   ammo: shell speed / bounces / max in the air · bank: bounces it will
  //   plan a shot around · every: seconds between shots · aimError: radians
  //   mines: how many it may lay · dodge: steps out of the way of shells
  ENEMIES: {
    rookie:    { name: 'Rookie', color: { body: '#b9a77a', dark: '#7d6d45', light: '#dccb9c' }, speed: 0, turn: 1.4, ammo: { speed: 4.0, bounces: 1, max: 1 }, bank: 0, every: [2.2, 3.4], aimError: 0.12, mines: 0, dodge: false },
    scout:     { name: 'Scout', color: { body: '#7f9e6b', dark: '#4f6b3e', light: '#a9c795' }, speed: 0.4, turn: 2.0, ammo: { speed: 4.4, bounces: 1, max: 2 }, bank: 0, every: [1.6, 2.6], aimError: 0.08, mines: 0, dodge: false },
    bouncer:   { name: 'Bouncer', color: { body: '#c55fa8', dark: '#863a70', light: '#ea95cf' }, speed: 0.35, turn: 2.4, ammo: { speed: 4.4, bounces: 2, max: 2 }, bank: 2, every: [1.4, 2.4], aimError: 0.04, mines: 0, dodge: false },
    dasher:    { name: 'Dasher', color: { body: '#ef8a2c', dark: '#a85810', light: '#ffb873' }, speed: 1.0, turn: 3.4, ammo: { speed: 8.5, bounces: 0, max: 2 }, bank: 0, every: [1.0, 1.8], aimError: 0.06, mines: 0, dodge: true },
    sapper:    { name: 'Sapper', color: { body: '#55585f', dark: '#2e3035', light: '#8b8f98' }, speed: 0.75, turn: 2.6, ammo: { speed: 4.8, bounces: 1, max: 2 }, bank: 1, every: [1.4, 2.4], aimError: 0.05, mines: 2, dodge: true },
    marksman:  { name: 'Marksman', color: { body: '#e9e6df', dark: '#9e9a90', light: '#ffffff' }, speed: 0, turn: 3.4, ammo: { speed: 8.0, bounces: 1, max: 1 }, bank: 1, every: [1.6, 2.4], aimError: 0.0, mines: 0, dodge: false },
    commander: { name: 'Commander', color: { body: '#d9a21b', dark: '#8f6608', light: '#ffd45e' }, speed: 0.7, turn: 3.0, ammo: { speed: 6.0, bounces: 1, max: 3 }, bank: 1, every: [0.7, 1.2], aimError: 0.03, mines: 1, dodge: true },
    // the computer opponent in a duel uses the lobby's ammo
    rival:     { name: 'CPU', color: null, speed: 0.8, turn: 3.2, ammo: null, bank: 1, every: [0.9, 1.6], aimError: 0.04, mines: 2, dodge: true },
  },

  // Co-op campaign: enemy line-up for each stage (arenas are picked to go
  // with it). Shared lives; an extra life every 5 stages.
  CAMPAIGN: {
    LIVES: 3,
    BONUS_EVERY: 5,
    STAGES: [
      ['rookie'],
      ['rookie', 'rookie'],
      ['scout', 'rookie'],
      ['scout', 'scout', 'rookie'],
      ['bouncer', 'rookie'],
      ['dasher', 'scout'],
      ['bouncer', 'scout', 'scout'],
      ['sapper', 'rookie', 'rookie'],
      ['dasher', 'dasher', 'scout'],
      ['marksman', 'bouncer'],
      ['sapper', 'bouncer', 'scout'],
      ['marksman', 'dasher', 'dasher'],
      ['bouncer', 'bouncer', 'sapper'],
      ['commander', 'scout', 'scout'],
      ['marksman', 'marksman', 'sapper'],
      ['dasher', 'dasher', 'bouncer', 'bouncer'],
      ['commander', 'sapper', 'marksman'],
      ['sapper', 'sapper', 'dasher', 'bouncer'],
      ['commander', 'commander', 'marksman'],
      ['commander', 'commander', 'marksman', 'sapper', 'dasher'],
    ],
  },

  PLAYER_COLORS: [
    { name: 'Tomato',  body: '#e8553f', dark: '#a8321f', light: '#ff8a6e', rgb: [232, 85, 63] },
    { name: 'Cobalt',  body: '#3b7be0', dark: '#21509c', light: '#78a9ff', rgb: [59, 123, 224] },
    { name: 'Lime',    body: '#7cc242', dark: '#4e8722', light: '#a9e275', rgb: [124, 194, 66] },
    { name: 'Violet',  body: '#9a5ad8', dark: '#663399', light: '#c08cf2', rgb: [154, 90, 216] },
    { name: 'Sunflower', body: '#f2b632', dark: '#b07e10', light: '#ffd76e', rgb: [242, 182, 50] },
    { name: 'Teal',    body: '#2fb5a6', dark: '#1a7c71', light: '#6be0d2', rgb: [47, 181, 166] },
  ],
};
