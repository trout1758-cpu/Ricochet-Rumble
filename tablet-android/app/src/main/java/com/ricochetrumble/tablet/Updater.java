package com.ricochetrumble.tablet;

// Ricochet Rumble on an Android tablet — updating the game from inside the app.
// The app ships with a copy of the game (its assets). "Check for updates" in
// Settings asks GitHub for the newest commit that changed game/ (that part
// runs in the page, see assets/rr-android/bridge.js); "Update now" calls
// install(), which downloads that snapshot of the repository as a zip, unpacks
// its game/ folder into the app's storage and serves it from then on.
// Plain Java (no Android classes), tested on a normal JVM.

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.util.Properties;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

public final class Updater {

    public static final String REPO = "trout1758-cpu/Ricochet-Rumble";

    public interface Progress {
        void report(String step, long bytes);
    }

    /** A game version and where its files are. */
    public static final class Version {
        public final String sha, date, source;
        public final GameServer.Files files;

        Version(String sha, String date, String source, GameServer.Files files) {
            this.sha = sha;
            this.date = date;
            this.source = source;
            this.files = files;
        }
    }

    /** Files in a folder on the device (a downloaded update). */
    public static final class DirFiles implements GameServer.Files {
        private final File root;

        public DirFiles(File root) { this.root = root; }

        @Override
        public byte[] read(String path) throws IOException {
            File f = new File(root, path);
            if (!f.getCanonicalPath().startsWith(root.getCanonicalPath() + File.separator) || !f.isFile()) return null;
            try (InputStream in = new FileInputStream(f)) { return readAll(in); }
        }

        @Override
        public boolean isDir(String path) { return new File(root, path).isDirectory(); }
    }

    private final GameServer.Files bundled;
    private final File dataDir;
    String zipBase = "https://codeload.github.com/" + REPO + "/zip/"; // tests point this elsewhere

    public Updater(GameServer.Files bundled, File dataDir) {
        this.bundled = bundled;
        this.dataDir = dataDir;
    }

    private File stateFile() { return new File(dataDir, "game-version.properties"); }

    private File gamesDir() { return new File(dataDir, "games"); }

    public Version bundledVersion() {
        String sha = "", date = "";
        try {
            byte[] b = bundled.read("build.json");
            if (b != null) {
                String s = new String(b, StandardCharsets.UTF_8);
                sha = field(s, "sha");
                date = field(s, "date");
            }
        } catch (IOException ignored) { }
        return new Version(sha, date, "bundled", bundled);
    }

    public Version downloadedVersion() {
        Properties p = new Properties();
        try (InputStream in = new FileInputStream(stateFile())) {
            p.load(in);
        } catch (IOException e) {
            return null;
        }
        String sha = p.getProperty("sha", "");
        if (sha.isEmpty()) return null;
        File dir = new File(gamesDir(), sha);
        if (!new File(dir, "index.html").isFile()) return null;
        return new Version(sha, p.getProperty("date", ""), "downloaded", new DirFiles(dir));
    }

    /** The newer of the game that came with the app and the last downloaded update. */
    public Version current() {
        Version b = bundledVersion();
        Version d = downloadedVersion();
        if (d != null && when(d.date) >= when(b.date)) return d;
        return b;
    }

    /** Download and unpack the game at commit `sha`, then switch to it. */
    public Version install(String sha, String date, String message, Progress progress) throws IOException {
        if (!sha.matches("[0-9a-f]{7,40}")) throw new IOException("bad version");
        progress.report("download", 0);
        HttpURLConnection c = (HttpURLConnection) new URL(zipBase + sha).openConnection();
        c.setRequestProperty("User-Agent", "RicochetRumble-Android");
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setInstanceFollowRedirects(true);
        if (c.getResponseCode() != 200) throw new IOException("download failed (" + c.getResponseCode() + ")");
        File games = gamesDir();
        File tmp = new File(games, sha + ".part");
        deleteTree(tmp);
        if (!tmp.mkdirs()) throw new IOException("can't write the update");
        int files = 0;
        final long[] count = { 0 };
        try (InputStream raw = c.getInputStream();
             ZipInputStream zip = new ZipInputStream(new FilterInputStream(raw) {
                 private long lastReport;

                 @Override
                 public int read(byte[] b, int off, int len) throws IOException {
                     int n = super.read(b, off, len);
                     if (n > 0) {
                         count[0] += n;
                         if (count[0] - lastReport > 65536) { lastReport = count[0]; progress.report("download", count[0]); }
                     }
                     return n;
                 }
             })) {
            ZipEntry e;
            String tmpRoot = tmp.getCanonicalPath() + File.separator;
            while ((e = zip.getNextEntry()) != null) {
                if (e.isDirectory()) continue;
                // "<repo>-<sha>/game/js/main.js" -> "js/main.js"
                String name = e.getName();
                int slash = name.indexOf('/');
                String rel = slash >= 0 ? name.substring(slash + 1) : name;
                if (!rel.startsWith("game/") || rel.startsWith("game/tests/")) continue;
                File dest = new File(tmp, rel.substring(5));
                if (!dest.getCanonicalPath().startsWith(tmpRoot)) continue;
                dest.getParentFile().mkdirs();
                try (OutputStream out = new FileOutputStream(dest)) { copy(zip, out); }
                files++;
            }
        } finally {
            c.disconnect();
        }
        progress.report("unpack", count[0]);
        if (files < 5 || !new File(tmp, "index.html").isFile()) {
            deleteTree(tmp);
            throw new IOException("the download did not contain the game");
        }
        try (OutputStream out = new FileOutputStream(new File(tmp, "build.json"))) {
            out.write(("{\"sha\":\"" + sha + "\",\"date\":" + GameServer.json(date) + "}").getBytes(StandardCharsets.UTF_8));
        }
        File fin = new File(games, sha);
        deleteTree(fin);
        if (!tmp.renameTo(fin)) throw new IOException("can't finish the update");
        Properties p = new Properties();
        p.setProperty("sha", sha);
        p.setProperty("date", date);
        p.setProperty("message", message);
        try (OutputStream out = new FileOutputStream(stateFile())) { p.store(out, "Ricochet Rumble game version"); }
        // tidy up older downloads
        File[] old = games.listFiles();
        if (old != null) for (File f : old) if (!f.getName().equals(sha)) deleteTree(f);
        progress.report("done", count[0]);
        return current();
    }

    /** Go back to the game that came with the app. */
    public Version reset() {
        stateFile().delete();
        deleteTree(gamesDir());
        return current();
    }

    // ---- helpers ------------------------------------------------------------------------
    // dates come as "...Z" from GitHub and "...+00:00" from git: compare them as times
    static long when(String iso) {
        try { return OffsetDateTime.parse(iso).toInstant().toEpochMilli(); } catch (Exception e) { return 0; }
    }

    static String field(String json, String key) {
        Matcher m = Pattern.compile("\"" + Pattern.quote(key) + "\"\\s*:\\s*\"([^\"]*)\"").matcher(json);
        return m.find() ? m.group(1) : "";
    }

    static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        copy(in, out);
        return out.toByteArray();
    }

    private static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    }

    static void deleteTree(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        f.delete();
    }
}
