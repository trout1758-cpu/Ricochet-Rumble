// Tests for the app's server, phone relay and updater: node test/run.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { start } = require('../lib/server');
const { Updater, unzip, newerVersion } = require('../lib/updater');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + (e.stack || e).split('\n').slice(0, 3).join('\n      ')); }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// a small zip writer for the tests (deflated entries)
function makeZip(files) {
  const locals = [], centrals = [];
  let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const comp = zlib.deflateRawSync(data);
    const n = Buffer.from(name);
    const crc = zlib.crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, n, comp);
    centrals.push(ch, n);
    off += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

(async () => {
  const gameDir = path.join(__dirname, '..', '..', 'game');

  await test('server: serves the game and the phone page', async () => {
    const { server, port } = await start({ root: () => gameDir, ports: [18080, 18090], host: '127.0.0.1' });
    try {
      const a = await fetch(`http://127.0.0.1:${port}/`);
      assert(a.status === 200 && (await a.text()).includes('Ricochet Rumble'), 'index');
      const b = await fetch(`http://127.0.0.1:${port}/pad/`);
      assert(b.status === 200, 'pad');
      const c = await fetch(`http://127.0.0.1:${port}/js/main.js`);
      assert(c.headers.get('content-type').startsWith('text/javascript'), 'js type');
      const d = await fetch(`http://127.0.0.1:${port}/%2e%2e/app/package.json`);
      assert(d.status === 403 || d.status === 404, 'no escaping the game folder: ' + d.status);
    } finally { server.close(); }
  });

  await test('server: relays messages between the game and a phone', async () => {
    const { server, port } = await start({ root: () => gameDir, ports: [18080, 18090], host: '127.0.0.1' });
    try {
      const got = { game: [], pad: [] };
      const g = new WebSocket(`ws://127.0.0.1:${port}/ws?role=game`);
      g.binaryType = 'arraybuffer';
      g.onmessage = (e) => got.game.push(e.data);
      await new Promise((r) => { g.onopen = r; });
      await wait(100);
      const p = new WebSocket(`ws://127.0.0.1:${port}/ws?role=pad&id=abc&slot=1&name=Phone`);
      p.binaryType = 'arraybuffer';
      p.onmessage = (e) => got.pad.push(e.data);
      await new Promise((r) => { p.onopen = r; });
      await wait(150);
      const hello = got.game.map((x) => (typeof x === 'string' ? JSON.parse(x) : null)).filter(Boolean);
      assert(hello[0].t === 'hello', 'hello first');
      const join = hello.find((m) => m.t === 'join');
      assert(join && join.id === 'abc' && join.slot === '1', 'join: ' + JSON.stringify(hello));
      p.send(new Uint8Array([1, 2, 3]));
      g.send(new Uint8Array([join.pad, 9, 8]));
      // a big message (a lobby card with pictures) still gets through
      const big = new Uint8Array(30000).fill(7); big[0] = join.pad;
      g.send(big);
      await wait(200);
      const bin = got.game.find((x) => typeof x !== 'string');
      assert(bin && Array.from(new Uint8Array(bin)).join() === [join.pad, 1, 2, 3].join(), 'pad -> game');
      assert(Array.from(new Uint8Array(got.pad[0])).join() === '9,8', 'game -> pad');
      assert(got.pad[1] && got.pad[1].byteLength === 29999, 'big message');
      p.close();
      await wait(150);
      assert(got.game.some((x) => typeof x === 'string' && JSON.parse(x).t === 'leave'), 'leave');
      g.close();
    } finally { server.close(); }
  });

  await test('updater: unzip', () => {
    const z = makeZip({ 'Repo-abc/game/index.html': '<h1>hi</h1>', 'Repo-abc/README.md': 'x' });
    const e = unzip(z);
    assert(e.length === 2 && e[0].data.toString() === '<h1>hi</h1>');
  });

  await test('updater: versions compare', () => {
    assert(newerVersion('1.0.1', '1.0.0') && newerVersion('1.10.0', '1.9.9') && !newerVersion('1.0.0', '1.0.0') && !newerVersion('0.9.0', '1.0.0'));
  });

  await test('updater: check, download, switch to the new game, reset', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-app-'));
    const bundled = path.join(tmp, 'bundled');
    fs.mkdirSync(bundled);
    fs.writeFileSync(path.join(bundled, 'index.html'), 'old');
    fs.writeFileSync(path.join(bundled, 'build.json'), JSON.stringify({ sha: 'aaa', date: '2026-11-01T00:00:00Z' }));
    const files = { 'Ricochet-Rumble-bbb/game/index.html': 'new', 'Ricochet-Rumble-bbb/game/js/main.js': '1', 'Ricochet-Rumble-bbb/game/js/a.js': '2',
      'Ricochet-Rumble-bbb/game/css/s.css': '3', 'Ricochet-Rumble-bbb/game/pad/pad.js': '4', 'Ricochet-Rumble-bbb/game/tests/run.js': 'skip',
      'Ricochet-Rumble-bbb/app/main.js': 'skip' };
    const zip = makeZip(files);
    const fakeFetch = async (url) => {
      const json = (o) => ({ ok: true, status: 200, json: async () => o });
      if (url.includes('/commits')) return json([{ sha: 'bbb', commit: { message: 'New stuff\n\nmore', committer: { date: '2026-11-20T00:00:00Z' } } }]);
      if (url.includes('/releases/latest')) return json({ tag_name: 'app-v1.2.0', html_url: 'https://github.com/x/releases/tag/app-v1.2.0' });
      if (url.includes('codeload')) return { ok: true, status: 200, arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.length) };
      return { ok: false, status: 404 };
    };
    const u = new Updater({ bundledDir: bundled, dataDir: path.join(tmp, 'data'), appVersion: '1.0.0', fetch: fakeFetch });
    fs.mkdirSync(path.join(tmp, 'data'));
    assert(u.current().sha === 'aaa');
    const c = await u.check();
    assert(c.available && c.latest.sha === 'bbb' && c.latest.message === 'New stuff', JSON.stringify(c));
    assert(c.app && c.app.version === '1.2.0', 'app update noticed');
    const steps = [];
    const cur = await u.install(c.latest, (p) => steps.push(p.step));
    assert(cur.sha === 'bbb' && cur.source === 'downloaded', JSON.stringify(cur));
    assert(fs.readFileSync(path.join(cur.dir, 'index.html'), 'utf8') === 'new');
    assert(!fs.existsSync(path.join(cur.dir, 'tests')), 'tests left out');
    assert(!fs.existsSync(path.join(cur.dir, 'main.js')), 'only game/ files');
    assert(steps.includes('unpack') && steps.includes('done'));
    const again = await u.check();
    assert(!again.available, 'up to date after installing');
    // a newer app install (newer bundled game) wins over an older download
    fs.writeFileSync(path.join(bundled, 'build.json'), JSON.stringify({ sha: 'ccc', date: '2026-11-25T00:00:00Z' }));
    assert(u.current().sha === 'ccc', 'newer bundled game');
    u.reset();
    assert(u.current().source === 'bundled');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
