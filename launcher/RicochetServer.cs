// Ricochet Rumble local server (Windows). start-game.ps1 compiles this with
// Add-Type, so it sticks to C# 5 (what Windows PowerShell's compiler accepts).
//
// Serves the game to this computer's browser at http://localhost:<port>/ and the
// Wi-Fi phone controller to phones on the same network at
// http://<this-computer's-IP>:<port>/pad/. Phones and the game talk through a
// WebSocket relay at /ws. Everything stays on the local network; no internet
// connection is used. launcher/server.py is the macOS/Linux twin of this file.
using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

public class RicochetServer
{
    private const string WsGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

    private readonly string root;
    private TcpListener listener;
    private readonly object hubLock = new object();
    private WsConn game;
    private readonly Dictionary<int, Pad> pads = new Dictionary<int, Pad>();
    private int nextPad = 1;

    public int Port;

    private class Pad
    {
        public WsConn Conn;
        public string Id;
        public string Slot;
        public string Name;
    }

    public RicochetServer(string gameRoot)
    {
        root = Path.GetFullPath(gameRoot).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
    }

    /// <summary>Binds the first free port in the range; returns it, or -1.</summary>
    public int Start(int firstPort, int lastPort)
    {
        for (int p = firstPort; p <= lastPort; p++)
        {
            try
            {
                TcpListener l;
                try
                {
                    // Dual-stack so both "localhost" (often ::1) and IPv4 LAN addresses work.
                    l = new TcpListener(IPAddress.IPv6Any, p);
                    l.Server.DualMode = true;
                    l.Start();
                }
                catch (SocketException)
                {
                    l = new TcpListener(IPAddress.Any, p);
                    l.Start();
                }
                listener = l;
                Port = p;
                return p;
            }
            catch (SocketException)
            {
            }
        }
        return -1;
    }

    /// <summary>Accepts connections forever (blocks).</summary>
    public void Run()
    {
        while (true)
        {
            TcpClient client = listener.AcceptTcpClient();
            client.NoDelay = true;
            Thread t = new Thread(HandleClient);
            t.IsBackground = true;
            t.Start(client);
        }
    }

    // ---- HTTP -----------------------------------------------------------------

    private void HandleClient(object state)
    {
        TcpClient client = (TcpClient)state;
        try
        {
            using (client)
            using (NetworkStream stream = client.GetStream())
            {
                string head = ReadHead(stream);
                if (head == null) return;
                string[] lines = head.Split(new[] { "\r\n" }, StringSplitOptions.None);
                string[] request = lines[0].Split(' ');
                if (request.Length < 2) return;
                Dictionary<string, string> headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                for (int i = 1; i < lines.Length; i++)
                {
                    int colon = lines[i].IndexOf(':');
                    if (colon > 0) headers[lines[i].Substring(0, colon).Trim()] = lines[i].Substring(colon + 1).Trim();
                }
                string target = request[1];
                string path = target;
                string query = "";
                int q = target.IndexOf('?');
                if (q >= 0)
                {
                    path = target.Substring(0, q);
                    query = target.Substring(q + 1);
                }
                string upgrade;
                if (path == "/ws" && headers.TryGetValue("Upgrade", out upgrade) && upgrade.ToLowerInvariant() == "websocket")
                {
                    HandleWebSocket(stream, headers, ParseQuery(query));
                }
                else
                {
                    ServeFile(stream, request[0], path);
                }
            }
        }
        catch (Exception)
        {
            // Connection dropped; nothing to clean up beyond the using blocks.
        }
    }

    private static string ReadHead(NetworkStream stream)
    {
        List<byte> buf = new List<byte>();
        while (buf.Count < 16384)
        {
            int b = stream.ReadByte();
            if (b < 0) return null;
            buf.Add((byte)b);
            int n = buf.Count;
            if (n >= 4 && buf[n - 4] == 13 && buf[n - 3] == 10 && buf[n - 2] == 13 && buf[n - 1] == 10)
            {
                return Encoding.ASCII.GetString(buf.ToArray(), 0, n - 4);
            }
        }
        return null;
    }

    private void ServeFile(NetworkStream stream, string method, string urlPath)
    {
        string rel = Uri.UnescapeDataString(urlPath).TrimStart('/').Replace('/', Path.DirectorySeparatorChar);
        string full = Path.GetFullPath(Path.Combine(root, rel));
        if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase) && full + Path.DirectorySeparatorChar != root)
        {
            WriteStatus(stream, "404 Not Found", null);
            return;
        }
        if (Directory.Exists(full))
        {
            if (!urlPath.EndsWith("/"))
            {
                WriteStatus(stream, "301 Moved Permanently", "Location: " + urlPath + "/\r\n");
                return;
            }
            full = Path.Combine(full, "index.html");
        }
        if (!File.Exists(full))
        {
            WriteStatus(stream, "404 Not Found", null);
            return;
        }
        byte[] body = File.ReadAllBytes(full);
        string head = "HTTP/1.1 200 OK\r\n" +
            "Content-Type: " + ContentType(full) + "\r\n" +
            "Content-Length: " + body.Length + "\r\n" +
            "Cache-Control: no-cache\r\n" +
            "Connection: close\r\n\r\n";
        byte[] h = Encoding.ASCII.GetBytes(head);
        stream.Write(h, 0, h.Length);
        if (method != "HEAD") stream.Write(body, 0, body.Length);
    }

    private static void WriteStatus(NetworkStream stream, string status, string extraHeaders)
    {
        byte[] h = Encoding.ASCII.GetBytes("HTTP/1.1 " + status + "\r\n" + (extraHeaders ?? "") +
            "Content-Length: 0\r\nConnection: close\r\n\r\n");
        stream.Write(h, 0, h.Length);
    }

    private static string ContentType(string file)
    {
        switch (Path.GetExtension(file).ToLowerInvariant())
        {
            case ".html": return "text/html; charset=utf-8";
            case ".js": return "text/javascript; charset=utf-8";
            case ".css": return "text/css; charset=utf-8";
            case ".json": return "application/json";
            case ".webmanifest": return "application/manifest+json";
            case ".svg": return "image/svg+xml";
            case ".png": return "image/png";
            case ".jpg": return "image/jpeg";
            case ".ico": return "image/x-icon";
            default: return "application/octet-stream";
        }
    }

    private static Dictionary<string, string> ParseQuery(string query)
    {
        Dictionary<string, string> result = new Dictionary<string, string>();
        foreach (string part in query.Split('&'))
        {
            if (part.Length == 0) continue;
            int eq = part.IndexOf('=');
            string k = eq < 0 ? part : part.Substring(0, eq);
            string v = eq < 0 ? "" : part.Substring(eq + 1);
            v = Uri.UnescapeDataString(v.Replace('+', ' '));
            if (v.Length > 40) v = v.Substring(0, 40);
            result[Uri.UnescapeDataString(k)] = v;
        }
        return result;
    }

    // ---- WebSocket relay ---------------------------------------------------------

    private void HandleWebSocket(NetworkStream stream, Dictionary<string, string> headers, Dictionary<string, string> query)
    {
        string key;
        headers.TryGetValue("Sec-WebSocket-Key", out key);
        string accept;
        using (SHA1 sha = SHA1.Create())
        {
            accept = Convert.ToBase64String(sha.ComputeHash(Encoding.ASCII.GetBytes((key ?? "") + WsGuid)));
        }
        byte[] h = Encoding.ASCII.GetBytes("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
            "Connection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
        stream.Write(h, 0, h.Length);

        WsConn conn = new WsConn(stream);
        string role = Arg(query, "role");
        if (role == "game")
        {
            GameJoined(conn);
            Pump(conn, -1);
            lock (hubLock)
            {
                if (game == conn) game = null;
            }
        }
        else
        {
            Pad pad = new Pad();
            pad.Conn = conn;
            pad.Id = Arg(query, "id");
            pad.Slot = Arg(query, "slot");
            pad.Name = Arg(query, "name");
            int num = PadJoined(pad);
            Pump(conn, num);
            PadLeft(num);
        }
        conn.Close();
    }

    private static string Arg(Dictionary<string, string> q, string k)
    {
        string v;
        return q.TryGetValue(k, out v) ? v : "";
    }

    private void Pump(WsConn conn, int padNum)
    {
        while (true)
        {
            int op;
            byte[] data = conn.Receive(out op);
            if (data == null || op == 8) return;
            if (op == 9)
            {
                conn.Send(10, data);
            }
            else if (padNum < 0)
            {
                FromGame(op, data);
            }
            else if (op == 2)
            {
                WsConn g = game;
                if (g != null)
                {
                    byte[] tagged = new byte[data.Length + 1];
                    tagged[0] = (byte)padNum;
                    Buffer.BlockCopy(data, 0, tagged, 1, data.Length);
                    g.Send(2, tagged);
                }
            }
        }
    }

    private void GameJoined(WsConn conn)
    {
        WsConn old;
        List<KeyValuePair<int, Pad>> current;
        lock (hubLock)
        {
            old = game;
            game = conn;
            current = new List<KeyValuePair<int, Pad>>(pads);
        }
        if (old != null) old.Close();
        conn.SendText(HelloJson());
        foreach (KeyValuePair<int, Pad> kv in current) conn.SendText(JoinJson(kv.Key, kv.Value));
    }

    private void FromGame(int op, byte[] data)
    {
        if (op == 1)
        {
            string text = Encoding.UTF8.GetString(data);
            if (text.Contains("\"urls\""))
            {
                WsConn g = game;
                if (g != null) g.SendText(HelloJson());
            }
        }
        else if (op == 2 && data.Length > 0)
        {
            Pad pad;
            lock (hubLock)
            {
                pads.TryGetValue(data[0], out pad);
            }
            if (pad != null)
            {
                byte[] rest = new byte[data.Length - 1];
                Buffer.BlockCopy(data, 1, rest, 0, rest.Length);
                pad.Conn.Send(2, rest);
            }
        }
    }

    private int PadJoined(Pad pad)
    {
        int num;
        WsConn g;
        lock (hubLock)
        {
            num = nextPad;
            while (pads.ContainsKey(num)) num = num % 250 + 1;
            nextPad = num % 250 + 1;
            pads[num] = pad;
            g = game;
        }
        if (g != null) g.SendText(JoinJson(num, pad));
        return num;
    }

    private void PadLeft(int num)
    {
        WsConn g;
        lock (hubLock)
        {
            pads.Remove(num);
            g = game;
        }
        if (g != null) g.SendText("{\"t\":\"leave\",\"pad\":" + num + "}");
    }

    private string HelloJson()
    {
        StringBuilder sb = new StringBuilder("{\"t\":\"hello\",\"urls\":[");
        List<string> ips = LanAddresses();
        for (int i = 0; i < ips.Count; i++)
        {
            if (i > 0) sb.Append(',');
            sb.Append(Json("http://" + ips[i] + ":" + Port + "/pad/"));
        }
        return sb.Append("]}").ToString();
    }

    private static string JoinJson(int num, Pad pad)
    {
        return "{\"t\":\"join\",\"pad\":" + num + ",\"id\":" + Json(pad.Id) + ",\"slot\":" + Json(pad.Slot) +
            ",\"name\":" + Json(pad.Name) + "}";
    }

    private static string Json(string s)
    {
        StringBuilder sb = new StringBuilder("\"");
        foreach (char c in s ?? "")
        {
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }

    // ---- this computer's addresses on the local network ------------------------------

    public List<string> LanAddresses()
    {
        List<KeyValuePair<int, string>> ranked = new List<KeyValuePair<int, string>>();
        foreach (NetworkInterface nic in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (nic.OperationalStatus != OperationalStatus.Up) continue;
            if (nic.NetworkInterfaceType == NetworkInterfaceType.Loopback || nic.NetworkInterfaceType == NetworkInterfaceType.Tunnel) continue;
            IPInterfaceProperties props = nic.GetIPProperties();
            bool hasGateway = false;
            foreach (GatewayIPAddressInformation gw in props.GatewayAddresses)
            {
                if (gw.Address.AddressFamily == AddressFamily.InterNetwork && !gw.Address.Equals(IPAddress.Any)) hasGateway = true;
            }
            string desc = (nic.Name + " " + nic.Description).ToLowerInvariant();
            bool looksVirtual = desc.Contains("virtual") || desc.Contains("vethernet") || desc.Contains("vmware") ||
                desc.Contains("hyper-v") || desc.Contains("wsl") || desc.Contains("bluetooth") || desc.Contains("vpn");
            int rank = (hasGateway ? 0 : 2) + (nic.NetworkInterfaceType == NetworkInterfaceType.Wireless80211 ? 0 : 1) + (looksVirtual ? 10 : 0);
            foreach (UnicastIPAddressInformation addr in props.UnicastAddresses)
            {
                if (addr.Address.AddressFamily != AddressFamily.InterNetwork) continue;
                string ip = addr.Address.ToString();
                if (ip.StartsWith("127.") || ip.StartsWith("169.254.")) continue;
                ranked.Add(new KeyValuePair<int, string>(rank, ip));
            }
        }
        ranked.Sort(delegate(KeyValuePair<int, string> a, KeyValuePair<int, string> b) { return a.Key.CompareTo(b.Key); });
        List<string> result = new List<string>();
        foreach (KeyValuePair<int, string> kv in ranked)
        {
            if (!result.Contains(kv.Value)) result.Add(kv.Value);
        }
        return result;
    }

    // ---- WebSocket framing (RFC 6455) --------------------------------------------------

    private class WsConn
    {
        private readonly NetworkStream stream;
        private readonly object writeLock = new object();
        private bool closed;

        public WsConn(NetworkStream s)
        {
            stream = s;
        }

        public byte[] Receive(out int op)
        {
            op = 0;
            byte[] hdr = ReadExact(2);
            if (hdr == null) return null;
            op = hdr[0] & 0x0F;
            long len = hdr[1] & 0x7F;
            if (len == 126)
            {
                byte[] ext = ReadExact(2);
                if (ext == null) return null;
                len = (ext[0] << 8) | ext[1];
            }
            else if (len == 127)
            {
                byte[] ext = ReadExact(8);
                if (ext == null) return null;
                len = 0;
                for (int i = 0; i < 8; i++) len = (len << 8) | ext[i];
            }
            if (len > 65536) return null;
            byte[] mask = (hdr[1] & 0x80) != 0 ? ReadExact(4) : null;
            byte[] data = len > 0 ? ReadExact((int)len) : new byte[0];
            if (data == null) return null;
            if (mask != null)
            {
                for (int i = 0; i < data.Length; i++) data[i] = (byte)(data[i] ^ mask[i & 3]);
            }
            return data;
        }

        private byte[] ReadExact(int n)
        {
            byte[] buf = new byte[n];
            int got = 0;
            while (got < n)
            {
                int r;
                try
                {
                    r = stream.Read(buf, got, n - got);
                }
                catch (IOException)
                {
                    return null;
                }
                catch (ObjectDisposedException)
                {
                    return null;
                }
                if (r <= 0) return null;
                got += r;
            }
            return buf;
        }

        public void Send(int op, byte[] data)
        {
            byte[] hdr;
            if (data.Length < 126)
            {
                hdr = new byte[] { (byte)(0x80 | op), (byte)data.Length };
            }
            else
            {
                hdr = new byte[] { (byte)(0x80 | op), 126, (byte)(data.Length >> 8), (byte)data.Length };
            }
            lock (writeLock)
            {
                if (closed) return;
                try
                {
                    stream.Write(hdr, 0, hdr.Length);
                    if (data.Length > 0) stream.Write(data, 0, data.Length);
                }
                catch (Exception)
                {
                    closed = true;
                }
            }
        }

        public void SendText(string text)
        {
            Send(1, Encoding.UTF8.GetBytes(text));
        }

        public void Close()
        {
            Send(8, new byte[0]);
            lock (writeLock)
            {
                closed = true;
            }
            try
            {
                stream.Close();
            }
            catch (Exception)
            {
            }
        }
    }
}
