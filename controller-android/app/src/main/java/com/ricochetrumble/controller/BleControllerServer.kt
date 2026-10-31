package com.ricochetrumble.controller

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.os.SystemClock
import android.util.Log

/**
 * Turns the phone into a Bluetooth LE peripheral (a GATT server) that the
 * desktop game connects to with Web Bluetooth.
 *
 * All public methods must be called on the main thread; GATT callbacks are
 * hopped onto the main thread before they touch any state.
 */
@SuppressLint("MissingPermission") // MainActivity only starts us once permissions are granted
class BleControllerServer(
    private val context: Context,
    private val listener: Listener,
) {
    sealed class Status {
        object Off : Status()
        data class Advertising(val name: String) : Status()
        data class Connected(val name: String) : Status()
        data class Error(val message: String) : Status()
    }

    interface Listener {
        fun onStatus(status: Status)
        fun onFeedback(bytes: ByteArray)
    }

    private val handler = Handler(Looper.getMainLooper())
    private val manager = context.getSystemService(BluetoothManager::class.java)

    private var gattServer: BluetoothGattServer? = null
    private var inputChar: BluetoothGattCharacteristic? = null
    private var central: BluetoothDevice? = null
    private var subscribed = false
    private var advertising = false
    private var includeNameInScanResponse = true
    private var running = false

    private var latest: ByteArray = ByteArray(Protocol.INPUT_LEN)
    private val oneShots = ArrayDeque<ByteArray>()
    private var notifyInFlight = false
    private var inFlightSince = 0L
    private var dirty = false
    private var lastSentAt = 0L

    val isRunning get() = running

    fun start() {
        if (running) return
        val adapter = manager?.adapter
        if (adapter == null) {
            listener.onStatus(Status.Error("This phone has no Bluetooth."))
            return
        }
        if (!adapter.isEnabled) {
            listener.onStatus(Status.Error("Bluetooth is off. Turn it on to connect."))
            return
        }
        if (!adapter.isMultipleAdvertisementSupported || adapter.bluetoothLeAdvertiser == null) {
            listener.onStatus(Status.Error("This phone can't act as a Bluetooth LE controller (peripheral mode unsupported)."))
            return
        }
        running = true
        openGattServer()
        handler.post(keepAlive)
    }

    fun stop() {
        running = false
        handler.removeCallbacks(keepAlive)
        stopAdvertising()
        central?.let { dev -> runCatching { gattServer?.cancelConnection(dev) } }
        central = null
        subscribed = false
        notifyInFlight = false
        runCatching { gattServer?.clearServices() }
        runCatching { gattServer?.close() }
        gattServer = null
        inputChar = null
        listener.onStatus(Status.Off)
    }

    /** Queue a one-off message (e.g. a name change); sent before the next state update. */
    fun sendMessage(bytes: ByteArray) {
        oneShots.addLast(bytes)
        pump()
    }

    /** Queue the newest controller state; only the latest one is ever sent. */
    fun update(bytes: ByteArray) {
        latest = bytes
        dirty = true
        pump()
    }

    // ---- GATT server --------------------------------------------------------------

    private fun openGattServer() {
        val server = manager.openGattServer(context, callback)
        if (server == null) {
            running = false
            listener.onStatus(Status.Error("Couldn't start the Bluetooth service. Try toggling Bluetooth off and on."))
            return
        }
        gattServer = server
        val service = BluetoothGattService(Protocol.SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)
        val input = BluetoothGattCharacteristic(
            Protocol.INPUT_UUID,
            BluetoothGattCharacteristic.PROPERTY_READ or BluetoothGattCharacteristic.PROPERTY_NOTIFY,
            BluetoothGattCharacteristic.PERMISSION_READ,
        )
        input.addDescriptor(
            BluetoothGattDescriptor(
                Protocol.CCCD_UUID,
                BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE,
            ),
        )
        val feedback = BluetoothGattCharacteristic(
            Protocol.FEEDBACK_UUID,
            BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
            BluetoothGattCharacteristic.PERMISSION_WRITE,
        )
        service.addCharacteristic(input)
        service.addCharacteristic(feedback)
        inputChar = input
        // Advertising starts in onServiceAdded, so the game never sees us
        // before the service exists.
        if (!server.addService(service)) {
            listener.onStatus(Status.Error("Couldn't register the controller service."))
        }
    }

    private val callback = object : BluetoothGattServerCallback() {
        override fun onServiceAdded(status: Int, service: BluetoothGattService) {
            handler.post {
                if (!running) return@post
                if (status == BluetoothGatt.GATT_SUCCESS) startAdvertising()
                else listener.onStatus(Status.Error("Bluetooth service failed to start (code $status)."))
            }
        }

        override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
            handler.post {
                if (!running) return@post
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    if (central == null) central = device
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED && device.address == central?.address) {
                    Log.i(TAG, "Game disconnected")
                    central = null
                    subscribed = false
                    notifyInFlight = false
                    startAdvertising()
                }
            }
        }

        override fun onCharacteristicReadRequest(
            device: BluetoothDevice,
            requestId: Int,
            offset: Int,
            characteristic: BluetoothGattCharacteristic,
        ) {
            val value = if (characteristic.uuid == Protocol.INPUT_UUID) latest else ByteArray(0)
            val from = offset.coerceAtMost(value.size)
            gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value.copyOfRange(from, value.size))
        }

        override fun onDescriptorReadRequest(
            device: BluetoothDevice,
            requestId: Int,
            offset: Int,
            descriptor: BluetoothGattDescriptor,
        ) {
            val value = if (subscribed && device.address == central?.address) {
                BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
            } else {
                BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE
            }
            gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, value)
        }

        override fun onDescriptorWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            descriptor: BluetoothGattDescriptor,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray?,
        ) {
            if (responseNeeded) gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
            if (descriptor.uuid != Protocol.CCCD_UUID) return
            val enable = value != null && value.isNotEmpty() && (value[0].toInt() and 0x03) != 0
            handler.post {
                if (!running) return@post
                if (enable) {
                    central = device
                    subscribed = true
                    notifyInFlight = false
                    stopAdvertising() // one game per controller
                    listener.onStatus(Status.Connected(deviceName()))
                    dirty = true
                    pump()
                } else if (device.address == central?.address) {
                    subscribed = false
                }
            }
        }

        override fun onCharacteristicWriteRequest(
            device: BluetoothDevice,
            requestId: Int,
            characteristic: BluetoothGattCharacteristic,
            preparedWrite: Boolean,
            responseNeeded: Boolean,
            offset: Int,
            value: ByteArray?,
        ) {
            if (responseNeeded) gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null)
            if (characteristic.uuid == Protocol.FEEDBACK_UUID && value != null) {
                val copy = value.copyOf()
                handler.post { listener.onFeedback(copy) }
            }
        }

        override fun onNotificationSent(device: BluetoothDevice, status: Int) {
            handler.post {
                notifyInFlight = false
                pump()
            }
        }
    }

    // ---- sending input -----------------------------------------------------------------

    private fun pump() {
        val server = gattServer ?: return
        val dev = central ?: return
        val ch = inputChar ?: return
        if (!subscribed || (!dirty && oneShots.isEmpty())) return
        val now = SystemClock.uptimeMillis()
        // Some Bluetooth stacks occasionally drop onNotificationSent; don't stall forever.
        if (notifyInFlight && now - inFlightSince < 250) return
        val oneShot = oneShots.removeFirstOrNull()
        if (oneShot == null) dirty = false
        notifyInFlight = true
        inFlightSince = now
        lastSentAt = now
        val value = oneShot ?: latest
        val ok = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            server.notifyCharacteristicChanged(dev, ch, false, value) == BluetoothGatt.GATT_SUCCESS
        } else {
            @Suppress("DEPRECATION")
            ch.setValue(value)
            @Suppress("DEPRECATION")
            server.notifyCharacteristicChanged(dev, ch, false)
        }
        if (!ok) {
            notifyInFlight = false
            if (oneShot != null) oneShots.addFirst(oneShot) else dirty = true
        }
    }

    /** Re-sends the current state now and then, and unsticks the send queue. */
    private val keepAlive = object : Runnable {
        override fun run() {
            if (!running) return
            if (subscribed && SystemClock.uptimeMillis() - lastSentAt > 200) dirty = true
            pump()
            handler.postDelayed(this, 50)
        }
    }

    // ---- advertising --------------------------------------------------------------------

    private fun startAdvertising() {
        if (!running || advertising) return
        val advertiser = manager?.adapter?.bluetoothLeAdvertiser ?: run {
            listener.onStatus(Status.Error("Bluetooth is off. Turn it on to connect."))
            return
        }
        val settings = AdvertiseSettings.Builder()
            .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
            .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
            .setConnectable(true)
            .setTimeout(0)
            .build()
        val data = AdvertiseData.Builder()
            .setIncludeDeviceName(false)
            .addServiceUuid(ParcelUuid(Protocol.SERVICE_UUID))
            .build()
        val scanResponse = AdvertiseData.Builder()
            .setIncludeDeviceName(includeNameInScanResponse)
            .build()
        advertising = true
        runCatching { advertiser.startAdvertising(settings, data, scanResponse, advertiseCallback) }
            .onFailure {
                advertising = false
                listener.onStatus(Status.Error("Couldn't advertise: ${it.message}"))
            }
    }

    private fun stopAdvertising() {
        if (!advertising) return
        advertising = false
        runCatching { manager?.adapter?.bluetoothLeAdvertiser?.stopAdvertising(advertiseCallback) }
    }

    private val advertiseCallback = object : AdvertiseCallback() {
        override fun onStartSuccess(settingsInEffect: AdvertiseSettings) {
            if (running && !subscribed) listener.onStatus(Status.Advertising(deviceName()))
        }

        override fun onStartFailure(errorCode: Int) {
            advertising = false
            when {
                errorCode == AdvertiseCallback.ADVERTISE_FAILED_ALREADY_STARTED -> {
                    advertising = true
                    if (!subscribed) listener.onStatus(Status.Advertising(deviceName()))
                }
                errorCode == AdvertiseCallback.ADVERTISE_FAILED_DATA_TOO_LARGE && includeNameInScanResponse -> {
                    // Long phone names don't fit in a scan response; go nameless.
                    includeNameInScanResponse = false
                    startAdvertising()
                }
                else -> listener.onStatus(Status.Error(advertiseError(errorCode)))
            }
        }
    }

    private fun advertiseError(code: Int) = when (code) {
        AdvertiseCallback.ADVERTISE_FAILED_FEATURE_UNSUPPORTED -> "This phone can't advertise as a Bluetooth LE controller."
        AdvertiseCallback.ADVERTISE_FAILED_TOO_MANY_ADVERTISERS -> "Too many Bluetooth advertisers are running. Close other Bluetooth apps and retry."
        AdvertiseCallback.ADVERTISE_FAILED_INTERNAL_ERROR -> "Bluetooth internal error. Toggle Bluetooth off and on."
        else -> "Bluetooth advertising failed (code $code)."
    }

    fun deviceName(): String = runCatching { manager?.adapter?.name }.getOrNull()?.takeIf { it.isNotBlank() } ?: "this phone"

    companion object {
        private const val TAG = "RicochetPad"
    }
}
