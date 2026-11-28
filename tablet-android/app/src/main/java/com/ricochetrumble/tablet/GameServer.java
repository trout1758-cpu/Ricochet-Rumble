package com.ricochetrumble.tablet;

// Ricochet Rumble on an Android tablet — the local web server.
// Serves the game to the app's own screen (a WebView) and the Wi-Fi phone
// controller (/pad/) to phones on the same network, and relays WebSocket
// messages between them at /ws. Same behaviour as launcher/server.py and
// app/lib/server.js. Plain Java (no Android classes), so it is tested on a
// normal JVM: see tablet-android/test/ServerTest.java.

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

public final class GameServer {

    /** Where files come from: the app's bundled assets or a downloaded update. */
    public interface Files {
        /** The file's bytes, or null when there is no such file. */
        byte[] read(String path) throws IOException;

        /** Is this path a folder (so "/pad" should become "/pad/")? */
        boolean isDir(String path);
    }

    private static final String WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    private static final Map<String, String> TYPES = new HashMap<>();

    static {
        TYPES.put("html", "text/html; charset=utf-8");
        TYPES.put("js", "text/javascript; charset=utf-8");
        TYPES.put("css", "text/css; charset=utf-8");
        TYPES.put("json", "application/json");
        TYPES.put("svg", "image/svg+xml");
        TYPES.put("png", "image/png");
        TYPES.put("jpg", "image/jpeg");
        TYPES.put("webmanifest", "application/manifest+json");
        TYPES.put("woff2", "font/woff2");
        TYPES.put("ico", "image/x-icon");
        TYPES.put("txt", "text/plain; charset=utf-8");
        TYPES.put("mp3", "audio/mpeg");
        TYPES.put("ogg", "audio/ogg");
        TYPES.put("wav", "audio/wav");
    }

    private volatile Files game;      // the game (changes when it updates itself)
    private volatile Files appFiles;  // the app's own files, served under /rr-android/
    private volatile String bridgeTag; // <script> added to the game page, or null
    private ServerSocket listener;
    private volatile boolean running;
    private int port;

    public GameServer(Files game, Files appFiles, String bridgeScript) {
        this.game = game;
        this.appFiles = appFiles;
        this.bridgeTag = bridgeScript == null ? null : "<script src=\"" + bridgeScript + "\"></script>";
    }

    public void setGame(Files files) { this.game = files; }

    public int getPort() { return port; }

    /** Listens on the first free port in [from, to] (or any free port). Returns the port. */
    public int start(int from, int to) throws IOException {
        IOException last = null;
        for (int p = from; p <= to + 1; p++) {
            int tryPort = p > to ? 0 : p;
            ServerSocket s = new ServerSocket();
            try {
                s.setReuseAddress(true);
                s.bind(new InetSocketAddress((InetAddress) null, tryPort), 64);
                listener = s;
                port = s.getLocalPort();
                break;
            } catch (IOException e) {
                last = e;
                try { s.close(); } catch (IOException ignored) { }
            }
        }
        if (listener == null) throw last != null ? last : new IOException("no free port");
        running = true;
        Thread t = new Thread(this::acceptLoop, "rr-server");
        t.setDaemon(true);
        t.start();
        return port;
    }

    public void stop() {
        running = false;
        try { if (listener != null) listener.close(); } catch (IOException ignored) { }
        hub.closeAll();
    }

    private void acceptLoop() {
        while (running) {
            try {
                Socket s = listener.accept();
                Thread t = new Thread(() -> handle(s), "rr-conn");
                t.setDaemon(true);
                t.start();
            } catch (IOException e) {
                if (!running) return;
            }
        }
    }

    // ---- one HTTP request (or a WebSocket that stays open) ----------------------------
    private void handle(Socket s) {
        try {
            s.setTcpNoDelay(true);
            s.setSoTimeout(15000);
            InputStream in = new BufferedInputStream(s.getInputStream());
            OutputStream out = s.getOutputStream();
            String head = readHead(in);
            if (head == null) { s.close(); return; }
            String[] lines = head.split("\r\n");
            String[] req = lines[0].split(" ");
            if (req.length < 2) { s.close(); return; }
            Map<String, String> headers = new HashMap<>();
            for (int i = 1; i < lines.length; i++) {
                int c = lines[i].indexOf(':');
                if (c > 0) headers.put(lines[i].substring(0, c).trim().toLowerCase(Locale.ROOT), lines[i].substring(c + 1).trim());
            }
            String target = req[1];
            String pathPart = target, query = "";
            int q = target.indexOf('?');
            if (q >= 0) { pathPart = target.substring(0, q); query = target.substring(q + 1); }
            String path;
            try { path = URLDecoder.decode(pathPart.replace("+", "%2B"), "UTF-8"); } catch (IllegalArgumentException e) { path = "/"; }

            if (path.equals("/ws") && "websocket".equalsIgnoreCase(headers.getOrDefault("upgrade", ""))) {
                s.setSoTimeout(0);
                webSocket(s, in, out, headers, parseQuery(query));
                return; // the socket stays open until either side leaves
            }
            serveFile(out, req[0], path);
            s.close();
        } catch (IOException e) {
            try { s.close(); } catch (IOException ignored) { }
        }
    }

    private static String readHead(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        int state = 0;
        while (buf.size() < 16384) {
            int b = in.read();
            if (b < 0) return null;
            buf.write(b);
            state = (b == '\r' && (state == 0 || state == 2)) ? state + 1 : (b == '\n' && (state == 1 || state == 3)) ? state + 1 : 0;
            if (state == 4) return new String(buf.toByteArray(), StandardCharsets.ISO_8859_1);
        }
        return null;
    }

    private static Map<String, String> parseQuery(String q) {
        Map<String, String> m = new HashMap<>();
        for (String part : q.split("&")) {
            if (part.isEmpty()) continue;
            int e = part.indexOf('=');
            String k = e < 0 ? part : part.substring(0, e);
            String v = e < 0 ? "" : part.substring(e + 1);
            try {
                m.put(URLDecoder.decode(k, "UTF-8"), URLDecoder.decode(v, "UTF-8"));
            } catch (Exception ignored) { }
        }
        return m;
    }

    private void serveFile(OutputStream out, String method, String path) throws IOException {
        // no escaping the game folder
        for (String seg : path.split("/")) {
            if (seg.equals("..") || seg.contains("\\")) { send(out, 403, "text/plain", "Forbidden".getBytes(StandardCharsets.UTF_8)); return; }
        }
        String rel = path.startsWith("/") ? path.substring(1) : path;
        Files src = game;
        if (rel.startsWith("rr-android/")) src = appFiles;
        if (rel.isEmpty() || rel.endsWith("/")) rel += "index.html";
        byte[] body = src == null ? null : src.read(rel);
        if (body == null) {
            if (src != null && src.isDir(rel)) {
                String loc = path + "/";
                String resp = "HTTP/1.1 301 Moved Permanently\r\nLocation: " + loc + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                out.write(resp.getBytes(StandardCharsets.ISO_8859_1));
                out.flush();
                return;
            }
            send(out, 404, "text/plain", "Not found".getBytes(StandardCharsets.UTF_8));
            return;
        }
        // the game page gets the app bridge (window.rrApp) before the game's own scripts
        if (rel.equals("index.html") && bridgeTag != null) {
            String html = new String(body, StandardCharsets.UTF_8);
            String marker = "<script src=\"js/main.js\"></script>";
            if (html.contains(marker)) body = html.replace(marker, bridgeTag + "\n  " + marker).getBytes(StandardCharsets.UTF_8);
        }
        int dot = rel.lastIndexOf('.');
        String type = TYPES.getOrDefault(dot >= 0 ? rel.substring(dot + 1).toLowerCase(Locale.ROOT) : "", "application/octet-stream");
        if ("HEAD".equals(method)) body = new byte[0];
        send(out, 200, type, body);
    }

    private static void send(OutputStream out, int code, String type, byte[] body) throws IOException {
        String reason = code == 200 ? "OK" : code == 403 ? "Forbidden" : "Not Found";
        String head = "HTTP/1.1 " + code + " " + reason + "\r\nContent-Type: " + type + "\r\nContent-Length: " + body.length
            + "\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.ISO_8859_1));
        out.write(body);
        out.flush();
    }

    // ---- WebSocket framing (RFC 6455), enough for small text/binary messages ------------
    static final class WsConn {
        final Socket socket;
        final InputStream in;
        final OutputStream out;
        private volatile boolean closed;

        WsConn(Socket s, InputStream in, OutputStream out) {
            this.socket = s;
            this.in = in;
            this.out = out;
        }

        /** Next message as {opcode, payload}, or null when the connection is gone. */
        Object[] read() throws IOException {
            int b0 = in.read(), b1 = in.read();
            if (b0 < 0 || b1 < 0) return null;
            int op = b0 & 0x0f;
            boolean masked = (b1 & 0x80) != 0;
            long n = b1 & 0x7f;
            if (n == 126) n = ((long) readByte() << 8) | readByte();
            else if (n == 127) { n = 0; for (int i = 0; i < 8; i++) n = (n << 8) | readByte(); }
            if (n > (1 << 20)) throw new IOException("message too big");
            byte[] mask = new byte[4];
            if (masked) readFully(mask);
            byte[] data = new byte[(int) n];
            readFully(data);
            if (masked) for (int i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
            return new Object[] { op, data };
        }

        private int readByte() throws IOException {
            int b = in.read();
            if (b < 0) throw new IOException("closed");
            return b;
        }

        private void readFully(byte[] buf) throws IOException {
            int off = 0;
            while (off < buf.length) {
                int r = in.read(buf, off, buf.length - off);
                if (r < 0) throw new IOException("closed");
                off += r;
            }
        }

        synchronized void send(int op, byte[] data) {
            if (closed) return;
            try {
                int n = data.length;
                byte[] head;
                if (n < 126) head = new byte[] { (byte) (0x80 | op), (byte) n };
                else if (n < 65536) head = new byte[] { (byte) (0x80 | op), 126, (byte) (n >> 8), (byte) n };
                else {
                    head = new byte[10];
                    head[0] = (byte) (0x80 | op);
                    head[1] = 127;
                    for (int i = 0; i < 8; i++) head[9 - i] = (byte) ((long) n >> (8 * i));
                }
                out.write(head);
                out.write(data);
                out.flush();
            } catch (IOException e) {
                close();
            }
        }

        void sendText(String s) { send(1, s.getBytes(StandardCharsets.UTF_8)); }

        void close() {
            if (closed) return;
            closed = true;
            try { out.write(new byte[] { (byte) 0x88, 0 }); } catch (IOException ignored) { }
            try { socket.close(); } catch (IOException ignored) { }
        }
    }

    private void webSocket(Socket s, InputStream in, OutputStream out, Map<String, String> headers, Map<String, String> query) throws IOException {
        String accept;
        try {
            MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
            accept = Base64.getEncoder().encodeToString(sha1.digest((headers.getOrDefault("sec-websocket-key", "") + WS_GUID).getBytes(StandardCharsets.ISO_8859_1)));
        } catch (Exception e) {
            s.close();
            return;
        }
        out.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n").getBytes(StandardCharsets.ISO_8859_1));
        out.flush();
        WsConn conn = new WsConn(s, in, out);
        if ("game".equals(arg(query, "role"))) hub.gameJoined(conn);
        else hub.padJoined(conn, arg(query, "id"), arg(query, "slot"), arg(query, "name"));
    }

    private static String arg(Map<String, String> q, String k) {
        String v = q.getOrDefault(k, "");
        return v.length() > 40 ? v.substring(0, 40) : v;
    }

    // ---- relay between the game and any number of phone pads ----------------------------
    private final Hub hub = new Hub();

    private final class Hub {
        private WsConn gameConn;
        private final Map<Integer, WsConn> pads = new LinkedHashMap<>();
        private final Map<Integer, String> padInfo = new HashMap<>();
        private int nextNum = 1;

        String hello() {
            StringBuilder sb = new StringBuilder("{\"t\":\"hello\",\"urls\":[");
            List<String> ips = lanIps();
            for (int i = 0; i < ips.size(); i++) {
                if (i > 0) sb.append(',');
                sb.append('"').append("http://").append(ips.get(i)).append(':').append(port).append("/pad/").append('"');
            }
            return sb.append("]}").toString();
        }

        void gameJoined(WsConn conn) throws IOException {
            WsConn old;
            List<String> joins = new ArrayList<>();
            synchronized (this) {
                old = gameConn;
                gameConn = conn;
                for (Map.Entry<Integer, String> e : padInfo.entrySet()) joins.add(joinMsg(e.getKey(), e.getValue()));
            }
            if (old != null) old.close();
            conn.sendText(hello());
            for (String j : joins) conn.sendText(j);
            try {
                Object[] m;
                while ((m = conn.read()) != null) {
                    int op = (Integer) m[0];
                    byte[] data = (byte[]) m[1];
                    if (op == 8) break;
                    if (op == 9) { conn.send(10, data); continue; }
                    if (op == 1) {
                        if (new String(data, StandardCharsets.UTF_8).contains("\"urls\"")) conn.sendText(hello());
                    } else if (op == 2 && data.length > 0) {
                        WsConn pad;
                        synchronized (this) { pad = pads.get(data[0] & 0xff); }
                        if (pad != null) {
                            byte[] rest = new byte[data.length - 1];
                            System.arraycopy(data, 1, rest, 0, rest.length);
                            pad.send(2, rest);
                        }
                    }
                }
            } catch (IOException ignored) {
            } finally {
                synchronized (this) { if (gameConn == conn) gameConn = null; }
                conn.close();
            }
        }

        void padJoined(WsConn conn, String id, String slot, String name) throws IOException {
            int num;
            String info = "\"id\":" + json(id) + ",\"slot\":" + json(slot) + ",\"name\":" + json(name);
            WsConn g;
            synchronized (this) {
                num = nextNum;
                while (pads.containsKey(num)) num = num % 250 + 1;
                nextNum = num % 250 + 1;
                pads.put(num, conn);
                padInfo.put(num, info);
                g = gameConn;
            }
            if (g != null) g.sendText(joinMsg(num, info));
            try {
                Object[] m;
                while ((m = conn.read()) != null) {
                    int op = (Integer) m[0];
                    byte[] data = (byte[]) m[1];
                    if (op == 8) break;
                    if (op == 9) { conn.send(10, data); continue; }
                    if (op == 2) {
                        WsConn gg;
                        synchronized (this) { gg = gameConn; }
                        if (gg != null) {
                            byte[] out = new byte[data.length + 1];
                            out[0] = (byte) num;
                            System.arraycopy(data, 0, out, 1, data.length);
                            gg.send(2, out);
                        }
                    }
                }
            } catch (IOException ignored) {
            } finally {
                WsConn gg;
                synchronized (this) {
                    pads.remove(num);
                    padInfo.remove(num);
                    gg = gameConn;
                }
                if (gg != null) gg.sendText("{\"t\":\"leave\",\"pad\":" + num + "}");
                conn.close();
            }
        }

        private String joinMsg(int num, String info) {
            return "{" + info + ",\"t\":\"join\",\"pad\":" + num + "}";
        }

        synchronized void closeAll() {
            if (gameConn != null) gameConn.close();
            for (WsConn c : pads.values()) c.close();
        }
    }

    static String json(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            if (c == '"' || c == '\\') sb.append('\\').append(c);
            else if (c < 0x20) sb.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
            else sb.append(c);
        }
        return sb.append('"').toString();
    }

    // ---- this device's addresses on the local network ----------------------------------
    public static List<String> lanIps() {
        List<String> out = new ArrayList<>();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (!(a instanceof Inet4Address) || a.isLoopbackAddress() || a.isLinkLocalAddress()) continue;
                    String ip = a.getHostAddress();
                    if (!out.contains(ip)) out.add(ip);
                }
            }
        } catch (Exception ignored) { }
        // home networks first (192.168.x, then other private ranges), mobile data / VPNs last
        out.sort((x, y) -> rank(x) - rank(y));
        return out;
    }

    private static int rank(String ip) {
        if (ip.startsWith("192.168.")) return 0;
        if (ip.startsWith("10.") || ip.matches("172\\.(1[6-9]|2\\d|3[01])\\..*")) return 1;
        return 2;
    }
}
