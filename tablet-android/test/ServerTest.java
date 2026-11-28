// Tests for the tablet app's web server, phone relay and updater, on a normal JVM.
// Run from tablet-android/:  ./test/run.sh   (or see the script for the javac/java lines)

import com.ricochetrumble.tablet.GameServer;
import com.ricochetrumble.tablet.Updater;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.OutputStream;
import java.lang.reflect.Field;
import java.net.HttpURLConnection;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URL;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.List;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

public class ServerTest {
    static int pass = 0, fail = 0;

    interface Body { void run() throws Exception; }

    static void test(String name, Body b) {
        try {
            b.run();
            pass++;
            System.out.println("  ok  " + name);
        } catch (Throwable t) {
            fail++;
            System.out.println("FAIL  " + name + "\n      " + t);
        }
    }

    static void check(boolean c, String m) { if (!c) throw new AssertionError(m); }

    static Object[] get(int port, String path) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL("http://127.0.0.1:" + port + path).openConnection(java.net.Proxy.NO_PROXY);
        c.setInstanceFollowRedirects(false);
        int code = c.getResponseCode();
        byte[] body = code < 400 ? c.getInputStream().readAllBytes() : new byte[0];
        return new Object[] { code, new String(body, StandardCharsets.UTF_8), c.getHeaderField("Content-Type"), c.getHeaderField("Location") };
    }

    /** Collects what a WebSocket receives. */
    static final class Rx implements WebSocket.Listener {
        final List<Object> got = new CopyOnWriteArrayList<>();
        private final ByteArrayOutputStream bin = new ByteArrayOutputStream();
        private final StringBuilder txt = new StringBuilder();

        public CompletionStage<?> onText(WebSocket ws, CharSequence data, boolean last) {
            txt.append(data);
            if (last) { got.add(txt.toString()); txt.setLength(0); }
            ws.request(1);
            return null;
        }

        public CompletionStage<?> onBinary(WebSocket ws, ByteBuffer data, boolean last) {
            byte[] b = new byte[data.remaining()];
            data.get(b);
            bin.write(b, 0, b.length);
            if (last) { got.add(bin.toByteArray()); bin.reset(); }
            ws.request(1);
            return null;
        }
    }

    public static void main(String[] args) throws Exception {
        File root = new File(args.length > 0 ? args[0] : ".");
        File game = new File(root, "../game").getCanonicalFile();
        File appAssets = new File(root, "app/src/main/assets").getCanonicalFile();

        GameServer server = new GameServer(new Updater.DirFiles(game), new Updater.DirFiles(appAssets), "rr-android/bridge.js");
        int port = server.start(18180, 18190);

        test("server: serves the game page with the app bridge added", () -> {
            Object[] r = get(port, "/");
            check((int) r[0] == 200, "status " + r[0]);
            String html = (String) r[1];
            check(html.contains("Ricochet Rumble"), "game page");
            int bridge = html.indexOf("rr-android/bridge.js"), main = html.indexOf("js/main.js");
            check(bridge > 0 && bridge < main, "bridge script before the game's main script");
        });

        test("server: phone page, script types, folders, missing files, no escaping", () -> {
            check((int) get(port, "/pad/")[0] == 200, "pad page");
            Object[] r = get(port, "/pad");
            check((int) r[0] == 301 && "/pad/".equals(r[3]), "/pad redirects to /pad/");
            check(((String) get(port, "/js/main.js")[2]).startsWith("text/javascript"), "js type");
            check(((String) get(port, "/rr-android/bridge.js")[1]).contains("rrApp"), "bridge served");
            check((int) get(port, "/nope.js")[0] == 404, "404");
            check((int) get(port, "/js/../../tablet-android/test/ServerTest.java")[0] == 403, "no ..");
        });

        test("relay: messages go between the game and a phone, big ones too", () -> {
            HttpClient http = HttpClient.newBuilder().proxy(HttpClient.Builder.NO_PROXY).build();
            Rx g = new Rx(), p = new Rx();
            WebSocket gs = http.newWebSocketBuilder().buildAsync(URI.create("ws://127.0.0.1:" + port + "/ws?role=game"), g).get();
            Thread.sleep(150);
            WebSocket ps = http.newWebSocketBuilder().buildAsync(URI.create("ws://127.0.0.1:" + port + "/ws?role=pad&id=abc&slot=&name=Phone%20%22x%22"), p).get();
            Thread.sleep(250);
            check(g.got.size() >= 2, "hello + join: " + g.got);
            check(((String) g.got.get(0)).startsWith("{\"t\":\"hello\""), "hello first: " + g.got.get(0));
            String join = (String) g.got.get(1);
            check(join.contains("\"t\":\"join\"") && join.contains("\"id\":\"abc\"") && join.contains("Phone \\\"x\\\""), "join: " + join);
            int num = Integer.parseInt(join.replaceAll(".*\"pad\":(\\d+).*", "$1"));
            ps.sendBinary(ByteBuffer.wrap(new byte[] { 1, 2, 3 }), true).get();
            gs.sendBinary(ByteBuffer.wrap(new byte[] { (byte) num, 9, 8 }), true).get();
            byte[] big = new byte[30000];
            big[0] = (byte) num;
            gs.sendBinary(ByteBuffer.wrap(big), true).get();
            gs.sendText("{\"t\":\"urls\"}", true).get();
            Thread.sleep(300);
            byte[] fromPad = (byte[]) g.got.stream().filter((o) -> o instanceof byte[]).findFirst().orElse(null);
            check(fromPad != null && fromPad.length == 4 && fromPad[0] == num && fromPad[3] == 3, "pad -> game");
            check(p.got.size() >= 2 && ((byte[]) p.got.get(0)).length == 2 && ((byte[]) p.got.get(1)).length == 29999, "game -> pad: " + p.got.size());
            check(g.got.stream().filter((o) -> o instanceof String && ((String) o).contains("hello")).count() == 2, "urls request answered");
            ps.sendClose(WebSocket.NORMAL_CLOSURE, "").get();
            Thread.sleep(300);
            check(g.got.stream().anyMatch((o) -> o instanceof String && ((String) o).contains("\"t\":\"leave\"")), "leave");
            gs.sendClose(WebSocket.NORMAL_CLOSURE, "").get();
        });

        server.stop();

        test("updater: download, unpack, switch, keep the newest, reset", () -> {
            File tmp = Files.createTempDirectory("rr-tablet").toFile();
            File bundledDir = new File(tmp, "bundled");
            bundledDir.mkdirs();
            Files.writeString(new File(bundledDir, "index.html").toPath(), "old");
            Files.writeString(new File(bundledDir, "build.json").toPath(), "{\"sha\":\"aaaaaaa\",\"date\":\"2026-11-01T00:00:00Z\"}");
            // a GitHub-style zip of the repository
            ByteArrayOutputStream zb = new ByteArrayOutputStream();
            try (ZipOutputStream z = new ZipOutputStream(zb)) {
                String[][] files = { { "Ricochet-Rumble-bbb/game/index.html", "new" }, { "Ricochet-Rumble-bbb/game/js/main.js", "1" },
                    { "Ricochet-Rumble-bbb/game/js/a.js", "2" }, { "Ricochet-Rumble-bbb/game/css/s.css", "3" }, { "Ricochet-Rumble-bbb/game/pad/pad.js", "4" },
                    { "Ricochet-Rumble-bbb/game/tests/run.js", "skip" }, { "Ricochet-Rumble-bbb/app/main.js", "skip" }, { "Ricochet-Rumble-bbb/game/../../evil", "x" } };
                for (String[] f : files) {
                    z.putNextEntry(new ZipEntry(f[0]));
                    z.write(f[1].getBytes(StandardCharsets.UTF_8));
                    z.closeEntry();
                }
            }
            byte[] zip = zb.toByteArray();
            com.sun.net.httpserver.HttpServer hs = com.sun.net.httpserver.HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            hs.createContext("/", (ex) -> {
                ex.sendResponseHeaders(200, zip.length);
                try (OutputStream o = ex.getResponseBody()) { o.write(zip); }
            });
            hs.start();
            try {
                Updater u = new Updater(new Updater.DirFiles(bundledDir), new File(tmp, "data"));
                new File(tmp, "data").mkdirs();
                Field f = Updater.class.getDeclaredField("zipBase");
                f.setAccessible(true);
                f.set(u, "http://127.0.0.1:" + hs.getAddress().getPort() + "/zip/");
                check(u.current().sha.equals("aaaaaaa"), "bundled first");
                List<String> steps = new CopyOnWriteArrayList<>();
                Updater.Version v = u.install("bbbbbbb", "2026-11-20T00:00:00Z", "New stuff", (s, b) -> steps.add(s));
                check(v.source.equals("downloaded") && v.sha.equals("bbbbbbb"), "switched: " + v.source);
                check("new".equals(new String(v.files.read("index.html"), StandardCharsets.UTF_8)), "new files served");
                check(v.files.read("tests/run.js") == null && v.files.read("main.js") == null, "only game/, no tests");
                check(!new File(tmp, "evil").exists(), "nothing written outside");
                check(steps.contains("unpack") && steps.contains("done"), "progress: " + steps);
                // a newer app install (newer bundled game) wins over an older download;
                // 03:00 at +05:00 is 22:00 UTC the day before: older, though it reads later as text
                Files.writeString(new File(bundledDir, "build.json").toPath(), "{\"sha\":\"ddddddd\",\"date\":\"2026-11-20T03:00:00+05:00\"}");
                check(u.current().sha.equals("bbbbbbb"), "dates compared as times");
                Files.writeString(new File(bundledDir, "build.json").toPath(), "{\"sha\":\"ccccccc\",\"date\":\"2026-11-25T00:00:00Z\"}");
                check(u.current().sha.equals("ccccccc"), "newer bundled game");
                u.reset();
                check(u.current().source.equals("bundled"), "reset");
            } finally {
                hs.stop(0);
            }
        });

        System.out.println("\n" + pass + " passed, " + fail + " failed");
        System.exit(fail == 0 ? 0 : 1);
    }
}
