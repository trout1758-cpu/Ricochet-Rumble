package com.ricochetrumble.controller

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.widget.Toast

class MainActivity : Activity(), BleControllerServer.Listener, ControllerView.Listener {

    private lateinit var view: ControllerView
    private lateinit var server: BleControllerServer
    private var vibrator: Vibrator? = null
    private var hapticsOn = true
    private var seq = 0
    private var askedToEnableBluetooth = false
    private var permissionDenied = false
    private var lastBackPress = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.attributes = window.attributes.apply {
                layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }

        view = ControllerView(this)
        view.listener = this
        setContentView(view)

        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        view.fireOnRelease = prefs.getBoolean(KEY_FIRE_ON_RELEASE, true)
        view.swapSticks = prefs.getBoolean(KEY_SWAP, false)
        hapticsOn = prefs.getBoolean(KEY_HAPTICS, true)

        vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            getSystemService(VibratorManager::class.java)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            getSystemService(Vibrator::class.java)
        }

        server = BleControllerServer(this, this)
        val filter = IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(bluetoothStateReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(bluetoothStateReceiver, filter)
        }
    }

    override fun onStart() {
        super.onStart()
        startIfPossible()
    }

    override fun onResume() {
        super.onResume()
        goImmersive()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) goImmersive()
    }

    override fun onStop() {
        super.onStop()
        // Leaving the app ends the connection; the game will pause and wait.
        server.stop()
    }

    override fun onDestroy() {
        super.onDestroy()
        runCatching { unregisterReceiver(bluetoothStateReceiver) }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        // A stray back gesture mid-match would drop the controller, so ask twice.
        val now = SystemClock.uptimeMillis()
        if (now - lastBackPress < 2000) {
            @Suppress("DEPRECATION")
            super.onBackPressed()
        } else {
            lastBackPress = now
            Toast.makeText(this, "Press back again to close the controller", Toast.LENGTH_SHORT).show()
        }
    }

    private fun goImmersive() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false)
            window.insetsController?.let {
                it.hide(WindowInsets.Type.systemBars())
                it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    or View.SYSTEM_UI_FLAG_FULLSCREEN
                    or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                )
        }
    }

    // ---- permissions & Bluetooth --------------------------------------------------------------

    private fun requiredPermissions(): Array<String> =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            arrayOf(Manifest.permission.BLUETOOTH_ADVERTISE, Manifest.permission.BLUETOOTH_CONNECT)
        } else {
            emptyArray()
        }

    private fun hasPermissions() = requiredPermissions().all { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }

    private fun startIfPossible() {
        if (server.isRunning) return
        if (!hasPermissions()) {
            if (!permissionDenied) requestPermissions(requiredPermissions(), REQ_PERMISSIONS)
            else onStatus(BleControllerServer.Status.Error("Bluetooth permission is needed to talk to the game."))
            return
        }
        val adapter = getSystemService(BluetoothManager::class.java)?.adapter
        if (adapter != null && !adapter.isEnabled) {
            if (!askedToEnableBluetooth) {
                askedToEnableBluetooth = true
                runCatching {
                    @Suppress("DEPRECATION")
                    startActivityForResult(Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE), REQ_ENABLE_BT)
                }
            }
            onStatus(BleControllerServer.Status.Error("Bluetooth is off. Turn it on to connect."))
            return
        }
        server.start()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_PERMISSIONS) return
        if (grantResults.isNotEmpty() && grantResults.all { it == PackageManager.PERMISSION_GRANTED }) {
            permissionDenied = false
            startIfPossible()
        } else {
            permissionDenied = true
            onStatus(BleControllerServer.Status.Error("Bluetooth permission is needed to talk to the game."))
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_ENABLE_BT) startIfPossible()
    }

    private val bluetoothStateReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)) {
                BluetoothAdapter.STATE_ON -> startIfPossible()
                BluetoothAdapter.STATE_TURNING_OFF, BluetoothAdapter.STATE_OFF -> {
                    if (server.isRunning) server.stop()
                    onStatus(BleControllerServer.Status.Error("Bluetooth is off. Turn it on to connect."))
                }
            }
        }
    }

    // ---- BleControllerServer.Listener -----------------------------------------------------------

    override fun onStatus(status: BleControllerServer.Status) {
        view.setConnection(status)
        if (status is BleControllerServer.Status.Connected) {
            rumble(80, 160)
            onControlsChanged()
        }
    }

    override fun onFeedback(bytes: ByteArray) {
        when (val fb = Protocol.parseFeedback(bytes)) {
            is Feedback.Assign -> {
                view.setAssigned(fb.playerIndex, fb.color)
                rumble(120, 200)
            }
            is Feedback.Rumble -> rumble(fb.durationMs, fb.amplitude)
            is Feedback.Status -> view.setGameStatus(fb.status)
            null -> Unit
        }
    }

    // ---- ControllerView.Listener ----------------------------------------------------------------

    override fun onControlsChanged() {
        seq = (seq + 1) and 0xff
        server.update(Protocol.encode(view.state, seq))
    }

    override fun onRetryRequested() {
        if (!hasPermissions() && permissionDenied) {
            // Android won't ask again after "don't allow"; send them to the app's settings.
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
            return
        }
        permissionDenied = false
        askedToEnableBluetooth = false
        if (server.isRunning) server.stop()
        startIfPossible()
    }

    override fun onSettingsRequested() {
        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        val labels = arrayOf(
            "Fire when I let go of the aim stick",
            "Vibration",
            "Left-handed (drive on the right)",
        )
        val checked = booleanArrayOf(view.fireOnRelease, hapticsOn, view.swapSticks)
        AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle("Controller settings")
            .setMultiChoiceItems(labels, checked) { _, which, isChecked -> checked[which] = isChecked }
            .setPositiveButton("Done") { _, _ ->
                view.fireOnRelease = checked[0]
                hapticsOn = checked[1]
                view.swapSticks = checked[2]
                prefs.edit()
                    .putBoolean(KEY_FIRE_ON_RELEASE, checked[0])
                    .putBoolean(KEY_HAPTICS, checked[1])
                    .putBoolean(KEY_SWAP, checked[2])
                    .apply()
                view.invalidate()
            }
            .setNegativeButton("Cancel", null)
            .setOnDismissListener { goImmersive() }
            .show()
    }

    private fun rumble(ms: Long, amplitude: Int) {
        val v = vibrator ?: return
        if (!hapticsOn || !v.hasVibrator()) return
        val amp = if (v.hasAmplitudeControl()) amplitude.coerceIn(1, 255) else VibrationEffect.DEFAULT_AMPLITUDE
        runCatching { v.vibrate(VibrationEffect.createOneShot(ms.coerceIn(5, 2000), amp)) }
    }

    companion object {
        private const val REQ_PERMISSIONS = 1
        private const val REQ_ENABLE_BT = 2
        private const val PREFS = "pad"
        private const val KEY_FIRE_ON_RELEASE = "fireOnRelease"
        private const val KEY_HAPTICS = "haptics"
        private const val KEY_SWAP = "swapSticks"
    }
}
