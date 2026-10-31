#!/usr/bin/env node
// Headless tests for the simulation, arenas and BLE protocol decoding.
// Run with:  node game/tests/run.js
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', 'js');
const sandbox = { console, Math, performance: { now: () => Date.now() } };
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const f of ['config.js', 'util.js', 'protocol.js', 'arenas.js', 'world.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), sandbox, { filename: f });
}
const RR = sandbox.RR;
const C = RR.CFG;
const T = RR.TILE;

let failures = 0;
let passes = 0;
function test(name, fn) {
  try {
    fn();
    passes++;
    console.log('  ok  ' + name);
  } catch (err) {
    failures++;
    console.log('FAIL  ' + name + '\n      ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n      ') : err));
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

const colors = [C.PLAYER_COLORS[0], C.PLAYER_COLORS[1]];
const EMPTY = { name: 'Empty', theme: 'workshop', half: Array.from({ length: C.ROWS }, (_, r) => (r === 6 ? '.1.........' : '...........')) };

function makeWorld(def, opts = {}) {
  const w = new RR.World(def, Object.assign({ ammo: C.AMMO.classic, minesEnabled: true, colors }, opts));
  w.frozen = false;
  return w;
}

function idle() {
  return Object.assign({}, RR.NO_INPUT);
}

function step(w, seconds, inputs = [idle(), idle()]) {
  const dt = 1 / C.SIM_HZ;
  const n = Math.round(seconds / dt);
  const all = [];
  for (let i = 0; i < n; i++) {
    w.update(dt, inputs);
    all.push(...w.drainEvents());
    inputs = inputs.map((inp) => Object.assign({}, inp, { fire: 0, mine: 0 }));
  }
  return all;
}

function aimAndFire(w, i, angle) {
  const t = w.tanks[i];
  t.turret = t.turretTarget = angle;
  const inputs = [idle(), idle()];
  inputs[i] = Object.assign(idle(), { fire: 1 });
  return inputs;
}

console.log('Arenas');
RR.ARENA_DEFS.forEach((def) => {
  test(`${def.name}: builds, is mirrored, spawns connected`, () => {
    const a = RR.buildArena(def);
    assert(a.theme, 'unknown theme ' + def.theme);
    for (let r = 0; r < C.ROWS; r++) {
      for (let c = 0; c < C.COLS; c++) {
        assert(a.grid[r * C.COLS + c] === a.grid[r * C.COLS + (C.COLS - 1 - c)], `not mirrored at ${c},${r}`);
      }
    }
    // BFS over floor tiles — the two tanks must be able to reach each other
    // (crates count as passable because mines can clear them).
    const passable = (c, r) => {
      const t = a.grid[r * C.COLS + c];
      return t === T.FLOOR || t === T.CRATE;
    };
    const start = [Math.floor(a.spawns[0].x), Math.floor(a.spawns[0].y)];
    const goal = [Math.floor(a.spawns[1].x), Math.floor(a.spawns[1].y)];
    assert(passable(...start) && passable(...goal), 'spawn on a blocked tile');
    const seen = new Set([start.join(',')]);
    const q = [start];
    while (q.length) {
      const [c, r] = q.shift();
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nc = c + dc, nr = r + dr;
        if (nc < 0 || nr < 0 || nc >= C.COLS || nr >= C.ROWS) continue;
        const k = nc + ',' + nr;
        if (seen.has(k) || !passable(nc, nr)) continue;
        seen.add(k);
        q.push([nc, nr]);
      }
    }
    assert(seen.has(goal.join(',')), 'player 2 unreachable from player 1');
  });
});

console.log('Shells');
test('shell bounces once then dies on the second wall (classic)', () => {
  const w = makeWorld(EMPTY);
  // Fire straight up from P1's spawn: hits the top wall, comes back down,
  // then dies on the bottom wall.
  w.tanks[1].x = 20.5; w.tanks[1].y = 1.5; // out of the way
  const t = w.tanks[0];
  t.x = 5.5; t.y = 6.5;
  let ev = step(w, 0.02, aimAndFire(w, 0, -Math.PI / 2));
  assert(w.bullets.length === 1, 'shell should spawn');
  // move the tank out of the return path
  t.x = 2.5; t.y = 3.5;
  ev = ev.concat(step(w, 4));
  const bounces = ev.filter((e) => e.type === 'bounce').length;
  const gone = ev.filter((e) => e.type === 'shellGone' && e.reason === 'wall').length;
  assert(bounces === 1, 'expected 1 bounce, got ' + bounces);
  assert(gone === 1, 'shell should die on the wall');
  assert(w.bullets.length === 0, 'no shells left');
});

test('rubber shells bounce three times', () => {
  const w = makeWorld(EMPTY, { ammo: C.AMMO.rubber });
  w.tanks[1].x = 20.5; w.tanks[1].y = 1.5;
  w.tanks[0].x = 5.5; w.tanks[0].y = 6.5;
  let ev = step(w, 0.02, aimAndFire(w, 0, -Math.PI / 2));
  w.tanks[0].x = 2.5; w.tanks[0].y = 3.5;
  ev = ev.concat(step(w, 12));
  assert(ev.filter((e) => e.type === 'bounce').length === 3, 'expected 3 bounces');
});

test('your own ricochet can destroy you', () => {
  const w = makeWorld(EMPTY);
  w.tanks[1].x = 20.5; w.tanks[1].y = 1.5;
  const t = w.tanks[0];
  t.x = 5.5; t.y = 6.5;
  const ev = step(w, 3, aimAndFire(w, 0, -Math.PI / 2));
  const d = ev.find((e) => e.type === 'tankDestroyed');
  assert(d && d.player === 0 && d.by === 0, 'tank 0 should be destroyed by its own shell');
});

test('direct hit destroys the enemy and credits the shooter', () => {
  const w = makeWorld(EMPTY);
  const ev = step(w, 4, aimAndFire(w, 0, 0)); // P1 faces P2 across the open arena
  const d = ev.find((e) => e.type === 'tankDestroyed');
  assert(d && d.player === 1 && d.by === 0 && d.cause === 'shell', 'P2 should be hit by P1');
  assert(w.tanks[0].alive, 'shooter survives');
});

test('shells that collide cancel each other out', () => {
  const w = makeWorld(EMPTY);
  const t0 = w.tanks[0], t1 = w.tanks[1];
  t0.turret = t0.turretTarget = 0;
  t1.turret = t1.turretTarget = Math.PI;
  const inputs = [Object.assign(idle(), { fire: 1 }), Object.assign(idle(), { fire: 1 })];
  const ev = step(w, 4, inputs);
  assert(ev.some((e) => e.type === 'shellClash'), 'expected a clash');
  assert(w.tanks[0].alive && w.tanks[1].alive, 'both tanks survive');
});

test('only ammo.max shells in the air', () => {
  const w = makeWorld(EMPTY);
  w.tanks[1].x = 20.5; w.tanks[1].y = 0.5;
  const t = w.tanks[0];
  t.turret = t.turretTarget = Math.PI / 2 + 0.3;
  for (let k = 0; k < 10; k++) step(w, 0.2, [Object.assign(idle(), { fire: 1 }), idle()]);
  assert(w.bullets.length <= C.AMMO.classic.max, 'too many shells: ' + w.bullets.length);
});

test('muzzle against a wall fizzles instead of firing through it', () => {
  const w = makeWorld(EMPTY);
  const t = w.tanks[0];
  t.x = 0.37; t.y = 6.5; // hull touching the west wall
  const ev = step(w, 0.05, aimAndFire(w, 0, Math.PI));
  assert(ev.some((e) => e.type === 'fizzle'), 'expected fizzle');
  assert(w.bullets.length === 0, 'no shell should exist');
});

test('shells never escape the arena', () => {
  const w = makeWorld(RR.ARENA_DEFS[3], { ammo: C.AMMO.rocket });
  for (let k = 0; k < 40; k++) {
    w.tanks[0].turret = w.tanks[0].turretTarget = Math.random() * Math.PI * 2;
    step(w, 0.15, [Object.assign(idle(), { fire: 1 }), idle()]);
    w.tanks.forEach((t) => { t.alive = true; });
    for (const b of w.bullets) assert(b.x > 0 && b.y > 0 && b.x < C.COLS && b.y < C.ROWS, `escaped: ${b.x},${b.y}`);
  }
});

console.log('Tanks');
test('tank cannot drive through walls or pits', () => {
  const def = { name: 'Box', theme: 'workshop', half: EMPTY.half.map((row, r) => (r === 6 ? '.1.#.......' : r === 3 ? '.o.........' : row)) };
  const w = makeWorld(def);
  const drive = (mx, my, secs) => step(w, secs, [Object.assign(idle(), { moveX: mx, moveY: my }), idle()]);
  drive(1, 0, 3);
  assert(w.tanks[0].x < 3 - C.TANK_RADIUS + 0.01, 'went into the wall: x=' + w.tanks[0].x);
  drive(0, -1, 3);
  assert(w.tanks[0].y > 4 + C.TANK_RADIUS - 0.01 || Math.abs(w.tanks[0].x - 1.5) > 0.9, 'drove into the pit');
});

test('tanks push each other but never overlap', () => {
  const w = makeWorld(EMPTY);
  w.tanks[0].x = 10.5; w.tanks[1].x = 11.5;
  step(w, 2, [Object.assign(idle(), { moveX: 1 }), Object.assign(idle(), { moveX: -1 })]);
  const d = Math.hypot(w.tanks[0].x - w.tanks[1].x, w.tanks[0].y - w.tanks[1].y);
  assert(d >= C.TANK_RADIUS * 2 - 0.02, 'overlap ' + d);
});

test('reverse driving: stick behind the tank drives backwards without turning around', () => {
  const w = makeWorld(EMPTY);
  const t = w.tanks[0];
  t.x = 10.5; t.angle = 0;
  step(w, 0.5, [Object.assign(idle(), { moveX: -1 }), idle()]);
  assert(Math.abs(t.angle) < 0.01, 'tank turned instead of reversing');
  assert(t.x < 10.0, 'tank did not move backwards');
});

console.log('Mines');
test('mine explodes after its fuse, clears crates, destroys tanks nearby', () => {
  const def = { name: 'Crates', theme: 'workshop', half: EMPTY.half.map((row, r) => (r === 6 ? '.1.x.......' : row)) };
  const w = makeWorld(def);
  const ev = step(w, 0.05, [Object.assign(idle(), { mine: 1 }), idle()]);
  assert(w.mines.length === 1, 'mine placed');
  assert(ev.some((e) => e.type === 'mineLay'));
  const later = step(w, C.MINE_FUSE + 0.5);
  assert(later.some((e) => e.type === 'explosion'), 'exploded');
  assert(later.some((e) => e.type === 'crateDestroyed' && e.c === 3 && e.r === 6), 'crate cleared');
  assert(!w.tanks[0].alive, 'owner sitting on the mine is destroyed');
  assert(w.tanks[1].alive, 'far tank survives');
});

test('enemy driving close triggers the mine early', () => {
  const w = makeWorld(EMPTY);
  step(w, 0.05, [Object.assign(idle(), { mine: 1 }), idle()]);
  w.tanks[0].x = 1.5; w.tanks[0].y = 1.5; // owner leaves
  step(w, C.MINE_ARM_TIME + 0.1);
  w.tanks[1].x = 2.2; w.tanks[1].y = 6.5; // enemy creeps up
  const ev = step(w, 1);
  assert(ev.some((e) => e.type === 'mineTrigger'), 'triggered');
  assert(ev.some((e) => e.type === 'tankDestroyed' && e.player === 1 && e.cause === 'mine'), 'enemy destroyed');
});

test('shooting a mine detonates it', () => {
  const w = makeWorld(EMPTY);
  w.tanks[1].x = 20.5; w.tanks[1].y = 0.5;
  w.mines.push({ id: 99, owner: 1, x: 8.5, y: 6.5, age: 5, fuse: 5, armed: true, triggered: false });
  const ev = step(w, 2, aimAndFire(w, 0, 0));
  assert(ev.some((e) => e.type === 'explosion'), 'mine exploded');
  assert(w.tanks[0].alive, 'shooter is out of range');
});

test('max two mines per tank', () => {
  const w = makeWorld(EMPTY);
  for (let k = 0; k < 4; k++) {
    w.tanks[0].x = 2.5 + k * 2;
    step(w, C.MINE_COOLDOWN + 0.05, [Object.assign(idle(), { mine: 1 }), idle()]);
  }
  assert(w.mines.filter((m) => m.owner === 0).length === 2, 'mine cap');
});

console.log('Protocol');
test('decodes an input packet and wraps counters', () => {
  const P = RR.PROTO;
  const buf = new ArrayBuffer(10);
  const dv = new DataView(buf);
  dv.setUint8(0, 1); dv.setUint8(1, 7);
  dv.setInt8(2, 127); dv.setInt8(3, -127); dv.setInt8(4, 0); dv.setInt8(5, 64);
  dv.setUint8(6, P.FLAG_AIM_HELD); dv.setUint8(7, 2); dv.setUint8(8, 255); dv.setUint8(9, 0);
  const pkt = P.decodeInput(dv);
  assert(pkt.moveX === 1 && pkt.moveY === -1, 'move');
  assert(pkt.aimHeld && !pkt.moveHeld, 'flags');
  assert(P.counterDelta(254, 2) === 4, 'wrap');
  assert(P.counterDelta(5, 5) === 0, 'no change');
  assert(P.decodeInput(new DataView(new ArrayBuffer(4))) === null, 'short packet rejected');
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
