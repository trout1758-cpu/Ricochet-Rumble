package com.ricochetrumble.tablet

// Ricochet Rumble on an Android tablet (or phone, or Android TV box): the
// tablet is the big screen. The game runs in a full-screen WebView, served by
// GameServer, which also serves the Wi-Fi controller page to phones on the
// same network and relays their messages, exactly like the Windows app.
// Settings > Check for updates downloads the newest game from GitHub (Updater).

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.res.AssetManager
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import org.json.JSONObject
import java.io.FileNotFoundException
import java.io.IOException

class MainActivity : Activity() {

    private lateinit var web: WebView
    private lateinit var updater: Updater
    private var server: GameServer? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private val main = Handler(Looper.getMainLooper())
    private var fullscreen = true

    /** The app's bundled files (the game, plus rr-android/bridge.js). */
    private class AssetFiles(private val assets: AssetManager) : GameServer.Files {
        override fun read(path: String): ByteArray? = try {
            assets.open(path).use { it.readBytes() }
        } catch (e: FileNotFoundException) {
            null
        } catch (e: IOException) {
            null
        }

        override fun isDir(path: String): Boolean = try {
            !assets.list(path.trimEnd('/')).isNullOrEmpty()
        } catch (e: IOException) {
            false
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val bundled = AssetFiles(assets)
        updater = Updater(bundled, filesDir)

        web = WebView(this)
        setContentView(web)
        applyFullscreen()
        web.setBackgroundColor(0xFF1C1A22.toInt())
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true          // the game keeps settings, names and hats in localStorage
            mediaPlaybackRequiresUserGesture = false
            loadWithOverviewMode = true
            useWideViewPort = true
        }
        web.isFocusable = true
        web.isFocusableInTouchMode = true
        web.requestFocus()                  // keyboards and gamepads go to the game
        web.addJavascriptInterface(Bridge(), "RRAndroid")
        web.webChromeClient = WebChromeClient()
        web.webViewClient = object : WebViewClient() {
            // the game stays in the app; links (GitHub) open in the browser
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                if (url.host == "localhost" || url.host == "127.0.0.1") return false
                startActivity(Intent(Intent.ACTION_VIEW, url))
                return true
            }
        }
        WebView.setWebContentsDebuggingEnabled(true)

        // Wi-Fi at full speed while the game is open (phones send ~20 packets a second)
        val wifi = applicationContext.getSystemService(WIFI_SERVICE) as WifiManager
        val mode = if (Build.VERSION.SDK_INT >= 29) WifiManager.WIFI_MODE_FULL_LOW_LATENCY else @Suppress("DEPRECATION") WifiManager.WIFI_MODE_FULL_HIGH_PERF
        wifiLock = wifi.createWifiLock(mode, "RicochetRumble").apply { setReferenceCounted(false); acquire() }

        // start the server off the main thread, then load the game from it
        Thread {
            val s = GameServer(updater.current().files, bundled, "rr-android/bridge.js")
            try {
                val port = s.start(8080, 8090)
                server = s
                main.post { web.loadUrl("http://localhost:$port/") }
            } catch (e: IOException) {
                main.post { Toast.makeText(this, "Couldn't start the game server: ${e.message}", Toast.LENGTH_LONG).show() }
            }
        }.start()
    }

    // ---- what the game page can ask the app (see assets/rr-android/bridge.js) ------------
    inner class Bridge {
        @JavascriptInterface
        fun info(): String {
            val cur = updater.current()
            val pkg = packageManager.getPackageInfo(packageName, 0)
            @Suppress("DEPRECATION")
            val build = if (Build.VERSION.SDK_INT >= 28) pkg.longVersionCode.toInt() else pkg.versionCode
            return JSONObject()
                .put("app", pkg.versionName)
                .put("build", build)
                .put("platform", "android")
                .put("repo", Updater.REPO)
                .put("fullscreen", fullscreen)
                .put("game", JSONObject().put("sha", cur.sha).put("date", cur.date).put("source", cur.source))
                .toString()
        }

        @JavascriptInterface
        fun install(id: String, sha: String, date: String, message: String) {
            Thread {
                val result = try {
                    val v = updater.install(sha, date, message) { step, bytes ->
                        val p = JSONObject().put("step", step).put("bytes", bytes)
                        js("window.__rrAndroid.progress(${JSONObject.quote(p.toString())})")
                    }
                    server?.setGame(v.files)
                    JSONObject().put("ok", true).put("info", JSONObject(info()))
                } catch (e: Exception) {
                    val msg = e.message ?: e.toString()
                    val friendly = if (e is java.net.UnknownHostException || msg.contains("Unable to resolve")) "No internet connection. Connect to the internet to update." else msg
                    JSONObject().put("ok", false).put("error", friendly)
                }
                js("window.__rrAndroid.done(${JSONObject.quote(id)}, ${JSONObject.quote(result.toString())})")
            }.start()
        }

        @JavascriptInterface
        fun reset(id: String) {
            val v = updater.reset()
            server?.setGame(v.files)
            js("window.__rrAndroid.done(${JSONObject.quote(id)}, ${JSONObject.quote(info())})")
        }

        @JavascriptInterface
        fun reload() { main.post { web.clearCache(true); web.reload() } }

        @JavascriptInterface
        fun toggleFullscreen(): Boolean {
            fullscreen = !fullscreen
            main.post { applyFullscreen() }
            return fullscreen
        }

        @JavascriptInterface
        fun openLink(url: String) {
            if (url.startsWith("https://github.com/")) main.post { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
        }

        @JavascriptInterface
        fun quit() { main.post { finish() } }
    }

    private fun js(code: String) = main.post { web.evaluateJavascript(code, null) }

    // ---- full screen, back button, lifecycle ----------------------------------------------
    private fun applyFullscreen() {
        if (Build.VERSION.SDK_INT >= 30) {
            window.insetsController?.let {
                if (fullscreen) {
                    it.hide(WindowInsets.Type.systemBars())
                    it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                } else {
                    it.show(WindowInsets.Type.systemBars())
                }
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = if (fullscreen) (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_FULLSCREEN or
                View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
                View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN) else View.SYSTEM_UI_FLAG_VISIBLE
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) applyFullscreen()
    }

    // Back works like Esc in the game: closes Settings / help, pauses a match.
    // On the title screen it leaves the app.
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        web.evaluateJavascript("(function(){var t=document.getElementById('screen-title');" +
            "if(t&&!t.classList.contains('hidden')&&document.getElementById('screen-settings').classList.contains('hidden'))return 'quit';" +
            "window.dispatchEvent(new KeyboardEvent('keydown',{code:'Escape',key:'Escape'}));return 'ok';})()") { r ->
            if (r != null && r.contains("quit")) finish()
        }
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        // A gamepad's B button belongs to the game (Back in menus, mines in play);
        // don't let Android turn it into the Back key and close the app.
        if (event.keyCode == KeyEvent.KEYCODE_BUTTON_B) {
            web.dispatchKeyEvent(event)
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    override fun onPause() {
        super.onPause()
        web.onPause()
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
        applyFullscreen()
    }

    override fun onDestroy() {
        server?.stop()
        wifiLock?.release()
        web.destroy()
        super.onDestroy()
    }
}
