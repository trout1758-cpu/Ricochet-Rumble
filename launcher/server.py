#!/usr/bin/env python3
"""Ricochet Rumble local server (macOS / Linux).

Serves the game to this computer's browser at http://localhost:<port>/ and the
Wi-Fi phone controller to phones on the same network at
http://<this-computer's-IP>:<port>/pad/. Phones and the game talk through a
WebSocket relay at /ws. Everything stays on the local network; no internet
connection is used. launcher/RicochetServer.cs is the Windows twin of this file.
"""
import base64
import hashlib
import json
import os
import re
import socket
import struct
import subprocess
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'game'))
WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
PORTS = range(8080, 8091)


# ---------------------------------------------------------------------------
# WebSocket framing (RFC 6455), just enough for small binary/text messages
# ---------------------------------------------------------------------------
class WsConn:
    def __init__(self, sock, rfile):
        self.sock = sock
        self.rfile = rfile
        self.lock = threading.Lock()
        self.closed = False
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)

    def _read(self, n):
        buf = b''
        while len(buf) < n:
            chunk = self.rfile.read(n - len(buf))
            if not chunk:
                return None
            buf += chunk
        return buf

    def recv(self):
        """Returns (opcode, payload), or None when the connection is gone."""
        hdr = self._read(2)
        if hdr is None:
            return None
        op = hdr[0] & 0x0F
        n = hdr[1] & 0x7F
        if n == 126:
            ext = self._read(2)
            if ext is None:
                return None
            n = struct.unpack('>H', ext)[0]
        elif n == 127:
            ext = self._read(8)
            if ext is None:
                return None
            n = struct.unpack('>Q', ext)[0]
        if n > 1 << 16:
            return None
        mask = self._read(4) if hdr[1] & 0x80 else None
        data = self._read(n) if n else b''
        if data is None:
            return None
        if mask:
            data = bytes(b ^ mask[i & 3] for i, b in enumerate(data))
        return op, data

    def send(self, op, data):
        if self.closed:
            return
        n = len(data)
        if n < 126:
            hdr = bytes([0x80 | op, n])
        elif n < 65536:
            hdr = bytes([0x80 | op, 126]) + struct.pack('>H', n)
        else:
            hdr = bytes([0x80 | op, 127]) + struct.pack('>Q', n)
        try:
            with self.lock:
                self.sock.sendall(hdr + data)
        except OSError:
            self.closed = True

    def send_text(self, obj):
        self.send(1, json.dumps(obj).encode())

    def close(self):
        if not self.closed:
            self.send(8, b'')
            self.closed = True
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Relay between the game (one browser tab) and any number of phone pads
# ---------------------------------------------------------------------------
class Hub:
    def __init__(self, port):
        self.port = port
        self.lock = threading.Lock()
        self.game = None
        self.pads = {}  # num -> (conn, info)
        self.next_num = 1

    def hello(self):
        return {'t': 'hello', 'urls': ['http://%s:%d/pad/' % (ip, self.port) for ip in lan_ips()]}

    def game_joined(self, conn):
        with self.lock:
            old, self.game = self.game, conn
            pads = list(self.pads.items())
        if old:
            old.close()
        conn.send_text(self.hello())
        for num, (_, info) in pads:
            conn.send_text(dict(info, t='join', pad=num))

    def game_left(self, conn):
        with self.lock:
            if self.game is conn:
                self.game = None

    def from_game(self, op, data):
        if op == 1:  # text: requests to the server
            try:
                msg = json.loads(data.decode())
            except ValueError:
                return
            if msg.get('t') == 'urls':
                self.game.send_text(self.hello())
        elif op == 2 and data:  # binary: [padNum, ...message for that pad]
            with self.lock:
                entry = self.pads.get(data[0])
            if entry:
                entry[0].send(2, data[1:])

    def pad_joined(self, conn, info):
        with self.lock:
            num = self.next_num
            while num in self.pads:
                num = num % 250 + 1
            self.next_num = num % 250 + 1
            self.pads[num] = (conn, info)
            game = self.game
        if game:
            game.send_text(dict(info, t='join', pad=num))
        return num

    def pad_left(self, num):
        with self.lock:
            self.pads.pop(num, None)
            game = self.game
        if game:
            game.send_text({'t': 'leave', 'pad': num})

    def from_pad(self, num, op, data):
        game = self.game
        if game and op == 2:
            game.send(2, bytes([num]) + data)


class Handler(SimpleHTTPRequestHandler):
    hub = None
    extensions_map = dict(SimpleHTTPRequestHandler.extensions_map, **{
        '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
    })

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == '/ws' and self.headers.get('Upgrade', '').lower() == 'websocket':
            self.websocket(parse_qs(url.query))
        else:
            super().do_GET()

    def websocket(self, query):
        key = self.headers.get('Sec-WebSocket-Key', '')
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        self.wfile.write((
            'HTTP/1.1 101 Switching Protocols\r\n'
            'Upgrade: websocket\r\n'
            'Connection: Upgrade\r\n'
            'Sec-WebSocket-Accept: %s\r\n\r\n' % accept
        ).encode())
        self.wfile.flush()
        self.close_connection = True
        conn = WsConn(self.connection, self.rfile)
        arg = lambda k: (query.get(k) or [''])[0][:40]
        hub = Handler.hub
        if arg('role') == 'game':
            hub.game_joined(conn)
            self.pump(conn, hub.from_game)
            hub.game_left(conn)
        else:
            num = hub.pad_joined(conn, {'id': arg('id'), 'slot': arg('slot'), 'name': arg('name')})
            self.pump(conn, lambda op, data: hub.from_pad(num, op, data))
            hub.pad_left(num)
        conn.close()

    def pump(self, conn, on_message):
        try:
            while True:
                frame = conn.recv()
                if frame is None:
                    return
                op, data = frame
                if op == 8:
                    return
                if op == 9:
                    conn.send(10, data)
                elif op in (1, 2):
                    on_message(op, data)
        except OSError:
            return


# ---------------------------------------------------------------------------
# Finding this computer's address on the local network
# ---------------------------------------------------------------------------
def lan_ips():
    found = []

    def add(ip):
        if ip and not ip.startswith('127.') and not ip.startswith('169.254.') and ip not in found:
            found.append(ip)

    # The address the OS would use to reach another device. Works without
    # internet as long as there is any network route; no packets are sent.
    for target in ('192.168.255.255', '10.255.255.255', '172.31.255.255'):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect((target, 9))
            add(s.getsockname()[0])
            s.close()
        except OSError:
            pass
    for cmd in (['ifconfig'], ['ip', '-4', 'addr']):
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=2).stdout
            for ip in re.findall(r'inet (?:addr:)?(\d+\.\d+\.\d+\.\d+)', out):
                add(ip)
        except (OSError, subprocess.SubprocessError):
            pass
    private = lambda ip: ip.startswith('192.168.') or ip.startswith('10.') or re.match(r'172\.(1[6-9]|2\d|3[01])\.', ip)
    found.sort(key=lambda ip: 0 if private(ip) else 1)
    return found


def open_browser(url):
    if sys.platform == 'darwin':
        for app in ('Google Chrome', 'Microsoft Edge'):
            if subprocess.run(['open', '-a', app, url], capture_output=True).returncode == 0:
                return
        subprocess.run(['open', url])
        return
    for cmd in ('google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge', 'xdg-open'):
        try:
            subprocess.Popen([cmd, url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return
        except OSError:
            continue


def main():
    server = None
    for port in PORTS:
        try:
            server = ThreadingHTTPServer(('0.0.0.0', port), Handler)
            break
        except OSError:
            continue
    if server is None:
        print('Could not open a local port between 8080 and 8090.')
        sys.exit(1)
    server.daemon_threads = True
    port = server.server_address[1]
    Handler.hub = Hub(port)
    url = 'http://localhost:%d/' % port
    print('')
    print('  Ricochet Rumble is running at %s' % url)
    ips = lan_ips()
    if ips:
        print('  Wi-Fi phones join at http://%s:%d/pad/ (or scan the QR code in the game lobby)' % (ips[0], port))
    else:
        print('  Not connected to a network yet, so Wi-Fi phones cannot join.')
    print('  Press Ctrl+C to stop.')
    print('')
    if '--no-browser' not in sys.argv:
        threading.Timer(0.5, open_browser, [url]).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
