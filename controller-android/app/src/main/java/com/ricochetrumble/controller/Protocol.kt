package com.ricochetrumble.controller

import java.util.UUID
import kotlin.math.roundToInt

/**
 * Bluetooth LE protocol shared with the desktop game.
 * Keep in sync with game/js/protocol.js and docs/PROTOCOL.md.
 */
object Protocol {
    val SERVICE_UUID: UUID = UUID.fromString("9938fe42-6fb5-4186-b966-95ce510c09c9")
    /** Phone -> game. Read + notify. */
    val INPUT_UUID: UUID = UUID.fromString("9938fe43-6fb5-4186-b966-95ce510c09c9")
    /** Game -> phone. Write / write without response. */
    val FEEDBACK_UUID: UUID = UUID.fromString("9938fe44-6fb5-4186-b966-95ce510c09c9")
    /** Standard Client Characteristic Configuration descriptor. */
    val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

    const val VERSION = 1
    const val INPUT_LEN = 10
    const val FLAG_AIM_HELD = 1
    const val FLAG_MOVE_HELD = 2

    const val MSG_ASSIGN = 1
    const val MSG_RUMBLE = 2
    const val MSG_STATUS = 3

    fun encode(s: ControllerState, seq: Int): ByteArray {
        val flags = (if (s.aimHeld) FLAG_AIM_HELD else 0) or (if (s.moveHeld) FLAG_MOVE_HELD else 0)
        return byteArrayOf(
            VERSION.toByte(),
            seq.toByte(),
            int8(s.moveX),
            int8(s.moveY),
            int8(s.aimX),
            int8(s.aimY),
            flags.toByte(),
            s.fireCount.toByte(),
            s.mineCount.toByte(),
            s.pauseCount.toByte(),
        )
    }

    private fun int8(v: Float): Byte = (v.coerceIn(-1f, 1f) * 127f).roundToInt().toByte()

    fun parseFeedback(b: ByteArray): Feedback? {
        if (b.isEmpty()) return null
        fun u(i: Int) = if (i < b.size) b[i].toInt() and 0xff else 0
        return when (u(0)) {
            MSG_ASSIGN -> if (b.size >= 5) Feedback.Assign(u(1), (0xff shl 24) or (u(2) shl 16) or (u(3) shl 8) or u(4)) else null
            MSG_RUMBLE -> if (b.size >= 3) Feedback.Rumble(u(1) * 10L, u(2).coerceIn(1, 255)) else null
            MSG_STATUS -> if (b.size >= 9) Feedback.Status(GameStatus(u(1), u(2), u(3), u(4), u(5), u(6), u(7) != 0, u(8))) else null
            else -> null
        }
    }
}

/** What the touch controls currently say. Counters wrap at 256. */
class ControllerState {
    var moveX = 0f
    var moveY = 0f
    var aimX = 1f
    var aimY = 0f
    var aimHeld = false
    var moveHeld = false
    var fireCount = 0
    var mineCount = 0
    var pauseCount = 0
}

data class GameStatus(
    val state: Int,
    val myWins: Int,
    val theirWins: Int,
    val winsNeeded: Int,
    val shellsLeft: Int,
    val minesLeft: Int,
    val ready: Boolean,
    val shellsMax: Int,
) {
    companion object {
        const val LOBBY = 0
        const val COUNTDOWN = 1
        const val PLAYING = 2
        const val ROUND_OVER = 3
        const val MATCH_OVER = 4
        const val PAUSED = 5
    }
}

sealed class Feedback {
    data class Assign(val playerIndex: Int, val color: Int) : Feedback()
    data class Rumble(val durationMs: Long, val amplitude: Int) : Feedback()
    data class Status(val status: GameStatus) : Feedback()
}
