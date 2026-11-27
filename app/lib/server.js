// Ricochet Rumble app — the local web server.
// Serves the game to the app window and the Wi-Fi phone controller (/pad/) to
// phones on the same network, and relays WebSocket messages between them at
// /ws. Same behaviour as launcher/server.py, written for Node with no extra
// packages so the app needs nothing but Electron.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.txt': 'text/plain',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
};

// ---- WebSocket framing (RFC 6455), enough for small text/binary messages ----------
class WsConn {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.closed = false;
    this.onmessage = null;
    this.onclose = null;
    socket.setNoDelay(true);
    socket.on('data', (d) => this.feed(d));
    socket.on('close', () => this.gone());
    socket.on('error', () => this.gone());
  }

  feed(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.buf.length < 2) return;
      const op = this.buf[0] & 0x0f;
      const masked = (this.buf[1] & 0x80) !== 0;
      let n = this.buf[1] & 0x7f;
      let off = 2;
      if (n === 126) { if (this.buf.length < 4) return; n = this.buf.readUInt16BE(2); off = 4; }
      else if (n === 127) { if (this.buf.length < 10) return; n = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (n > 1 << 20) { this.close(); return; }
      const need = off + (masked ? 4 : 0) + n;
      if (this.buf.length < need) return;
      let data = this.buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) {
        const mask = this.buf.subarray(off, off + 4);
        data = Buffer.from(data);
        for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      }
      this.buf = this.buf.subarray(need);
      if (op === 8) { this.close(); return; }
      if (op === 9) this.send(10, data);
      else if ((op === 1 || op === 2) && this.onmessage) this.onmessage(op, data);
    }
  }

  send(op, data) {
    if (this.closed) return;
    const n = data.length;
    let hdr;
    if (n < 126) hdr = Buffer.from([0x80 | op, n]);
    else if (n < 65536) { hdr = Buffer.alloc(4); hdr[0] = 0x80 | op; hdr[1] = 126; hdr.writeUInt16BE(n, 2); }
    else { hdr = Buffer.alloc(10); hdr[0] = 0x80 | op; hdr[1] = 127; hdr.writeBigUInt64BE(BigInt(n), 2); }
    try { this.socket.write(Buffer.concat([hdr, data])); } catch (e) { this.gone(); }
  }

  sendText(obj) { this.send(1, Buffer.from(JSON.stringify(obj))); }

  close() {
    if (this.closed) return;
    try { this.socket.write(Buffer.from([0x88, 0])); this.socket.end(); } catch (e) { /* gone */ }
    this.gone();
  }

  gone() {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.destroy(); } catch (e) { /* gone */ }
    if (this.onclose) this.onclose();
  }
}

// ---- this computer's addresses on the local network -----------------------------
function lanIps() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || a.address.startsWith('169.254.')) continue;
      if (!out.includes(a.address)) out.push(a.address);
    }
  }
  const priv = (ip) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  // virtual adapters (VPNs, VirtualBox, WSL) last
  out.sort((a, b) => (priv(a) ? 0 : 1) - (priv(b) ? 0 : 1) || (a.startsWith('192.168.') ? -1 : 0) - (b.startsWith('192.168.') ? -1 : 0));
  return out;
}

// ---- relay between the game and any number of phone pads --------------------------
class Hub {
  constructor() {
    this.port = 0;
    this.game = null;
    this.pads = new Map(); // num -> { conn, info }
    this.nextNum = 1;
  }

  hello() {
    return { t: 'hello', urls: lanIps().map((ip) => `http://${ip}:${this.port}/pad/`) };
  }

  gameJoined(conn) {
    const old = this.game;
    this.game = conn;
    if (old) old.close();
    conn.sendText(this.hello());
    for (const [num, { info }] of this.pads) conn.sendText(Object.assign({}, info, { t: 'join', pad: num }));
    conn.onmessage = (op, data) => {
      if (op === 1) {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch (e) { return; }
        if (msg && msg.t === 'urls') conn.sendText(this.hello());
      } else if (op === 2 && data.length) {
        const pad = this.pads.get(data[0]);
        if (pad) pad.conn.send(2, data.subarray(1));
      }
    };
    conn.onclose = () => { if (this.game === conn) this.game = null; };
  }

  padJoined(conn, info) {
    let num = this.nextNum;
    while (this.pads.has(num)) num = (num % 250) + 1;
    this.nextNum = (num % 250) + 1;
    this.pads.set(num, { conn, info });
    if (this.game) this.game.sendText(Object.assign({}, info, { t: 'join', pad: num }));
    conn.onmessage = (op, data) => {
      if (this.game && op === 2) this.game.send(2, Buffer.concat([Buffer.from([num]), data]));
    };
    conn.onclose = () => {
      this.pads.delete(num);
      if (this.game) this.game.sendText({ t: 'leave', pad: num });
    };
  }
}

// root(): the folder to serve (it changes when the game updates itself)
function start({ root, ports = [8080, 8090], host = '0.0.0.0' }) {
  const hub = new Hub();
  const server = http.createServer((req, res) => {
    let p;
    try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { p = '/'; }
    if (p.endsWith('/')) p += 'index.html';
    const base = path.resolve(root());
    const file = path.resolve(base, '.' + p);
    if (!file.startsWith(base + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) {
        // a folder without the trailing slash
        if (err.code === 'EISDIR') { res.writeHead(301, { Location: p + '/' }); res.end(); return; }
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  });

  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws' || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(String(req.headers['sec-websocket-key'] || '') + WS_GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const conn = new WsConn(socket);
    const arg = (k) => String(url.searchParams.get(k) || '').slice(0, 40);
    if (arg('role') === 'game') hub.gameJoined(conn);
    else hub.padJoined(conn, { id: arg('id'), slot: arg('slot'), name: arg('name') });
  });

  return new Promise((resolve, reject) => {
    const list = [];
    for (let p = ports[0]; p <= ports[1]; p++) list.push(p);
    list.push(0); // any free port as a last resort
    const tryNext = () => {
      const port = list.shift();
      const onErr = (err) => {
        server.removeListener('listening', onOk);
        if (list.length) tryNext(); else reject(err);
      };
      const onOk = () => {
        server.removeListener('error', onErr);
        hub.port = server.address().port;
        resolve({ server, hub, port: hub.port });
      };
      server.once('error', onErr);
      server.once('listening', onOk);
      server.listen(port, host);
    };
    tryNext();
  });
}

module.exports = { start, lanIps, WsConn };
