// Ricochet Rumble app — updating the game from inside the app.
// The app ships with a copy of the game (resources/game). "Check for updates"
// asks GitHub for the newest commit that changed game/, downloads that
// snapshot of the repository as a zip, unpacks its game/ folder into the
// app's data folder and serves it from then on. The app itself (the .exe)
// only needs reinstalling when the app shell changes; that is checked against
// the repository's Releases.
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const REPO = 'trout1758-cpu/Ricochet-Rumble';
const API = `https://api.github.com/repos/${REPO}`;
const UA = { 'User-Agent': 'RicochetRumble-App', Accept: 'application/vnd.github+json' };
// dates come as "…Z" from GitHub and "…+01:00" from git: compare them as times
const when = (iso) => Date.parse(iso || '') || 0;

// ---- a small zip reader (stored and deflated entries, as GitHub makes them) -------
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('bad zip entry');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error('unsupported zip compression');
    out.push({ name, data });
  }
  return out;
}

class Updater {
  // bundledDir: the game that came with the app · dataDir: where updates go
  // fetch: fetch() to use (Electron's net.fetch follows the system proxy)
  constructor({ bundledDir, dataDir, appVersion, fetch }) {
    this.bundledDir = bundledDir;
    this.dataDir = dataDir;
    this.appVersion = appVersion;
    this.fetch = fetch;
    this.statePath = path.join(dataDir, 'game-version.json');
  }

  readJson(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
  }

  bundled() {
    const b = this.readJson(path.join(this.bundledDir, 'build.json')) || {};
    return { sha: b.sha || '', date: b.date || '', dir: this.bundledDir, source: 'bundled' };
  }

  downloaded() {
    const s = this.readJson(this.statePath);
    if (!s || !s.sha) return null;
    const dir = path.join(this.dataDir, 'games', s.sha);
    if (!fs.existsSync(path.join(dir, 'index.html'))) return null;
    return { sha: s.sha, date: s.date || '', message: s.message || '', dir, source: 'downloaded' };
  }

  // The newer of the bundled game and the last downloaded update.
  current() {
    const b = this.bundled();
    const d = this.downloaded();
    if (d && when(d.date) >= when(b.date)) return d;
    return b;
  }

  async getJson(url) {
    const res = await this.fetch(url, { headers: UA });
    if (!res.ok) throw new Error(res.status === 403 ? 'GitHub is busy (too many checks). Try again in a little while.' : `GitHub answered ${res.status}`);
    return res.json();
  }

  async check() {
    const cur = this.current();
    const commits = await this.getJson(`${API}/commits?sha=main&path=game&per_page=1`);
    if (!Array.isArray(commits) || !commits.length) throw new Error('no game versions found');
    const c = commits[0];
    const latest = { sha: c.sha, date: c.commit.committer.date, message: String(c.commit.message || '').split('\n')[0] };
    const available = latest.sha !== cur.sha && when(latest.date) > when(cur.date);
    // a newer app (the .exe itself)?
    let app = null;
    try {
      const rel = await this.getJson(`${API}/releases/latest`);
      const v = String(rel.tag_name || '').replace(/^app-v/, '');
      if (v && newerVersion(v, this.appVersion)) app = { version: v, url: rel.html_url };
    } catch (e) { /* no releases yet */ }
    return { current: cur, latest, available, app };
  }

  async install(latest, onProgress = () => {}) {
    onProgress({ step: 'download', bytes: 0 });
    const res = await this.fetch(`https://codeload.github.com/${REPO}/zip/${latest.sha}`, { headers: { 'User-Agent': UA['User-Agent'] } });
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    const chunks = [];
    let bytes = 0;
    if (res.body && res.body.getReader) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
        bytes += value.length;
        onProgress({ step: 'download', bytes });
      }
    } else {
      chunks.push(Buffer.from(await res.arrayBuffer()));
    }
    onProgress({ step: 'unpack' });
    const entries = unzip(Buffer.concat(chunks));
    const games = path.join(this.dataDir, 'games');
    const tmp = path.join(games, latest.sha + '.part');
    fs.rmSync(tmp, { recursive: true, force: true });
    let files = 0;
    for (const e of entries) {
      // "<repo>-<sha>/game/js/main.js" -> "js/main.js"
      const rel = e.name.split('/').slice(1).join('/');
      if (!rel.startsWith('game/') || rel.startsWith('game/tests/')) continue;
      const inside = rel.slice(5);
      const dest = path.resolve(tmp, inside);
      if (!dest.startsWith(path.resolve(tmp) + path.sep)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, e.data);
      files++;
    }
    if (!fs.existsSync(path.join(tmp, 'index.html')) || files < 5) throw new Error('the download did not contain the game');
    fs.writeFileSync(path.join(tmp, 'build.json'), JSON.stringify({ sha: latest.sha, date: latest.date }));
    const final = path.join(games, latest.sha);
    fs.rmSync(final, { recursive: true, force: true });
    fs.renameSync(tmp, final);
    fs.writeFileSync(this.statePath, JSON.stringify(latest));
    // tidy up older downloads
    for (const name of fs.readdirSync(games)) {
      if (name !== latest.sha) fs.rmSync(path.join(games, name), { recursive: true, force: true });
    }
    onProgress({ step: 'done', files });
    return this.current();
  }

  // Go back to the game that came with the app.
  reset() {
    fs.rmSync(this.statePath, { force: true });
    fs.rmSync(path.join(this.dataDir, 'games'), { recursive: true, force: true });
    return this.current();
  }
}

function newerVersion(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

module.exports = { Updater, unzip, newerVersion, REPO };
