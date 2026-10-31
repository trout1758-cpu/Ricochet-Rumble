package com.ricochetrumble.controller

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RadialGradient
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.os.Build
import android.os.SystemClock
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.WindowInsets
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/**
 * Full-screen twin-stick touch controller.
 *
 *  Left half  – drive stick (appears wherever your thumb lands).
 *  Right half – aim stick: drag to aim, let go to fire, slide back to the
 *               middle to cancel. A quick tap fires where the turret points.
 *  Buttons    – MINE (right side), PAUSE and settings (top bar).
 */
class ControllerView(context: Context) : View(context) {

    interface Listener {
        fun onControlsChanged()
        fun onSettingsRequested()
        fun onRetryRequested()
        fun onProfileRequested()
    }

    var listener: Listener? = null
    val state = ControllerState()

    // ---- things the activity tells us -----------------------------------------------------
    var fireOnRelease = true
    var swapSticks = false
        set(value) { field = value; layoutControls(); invalidate() }

    private var connection: BleControllerServer.Status = BleControllerServer.Status.Off
    private var playerIndex = -1
    private var playerColor = Color.rgb(200, 200, 215)
    private var game: GameStatus? = null

    fun setConnection(s: BleControllerServer.Status) {
        connection = s
        if (s !is BleControllerServer.Status.Connected) {
            playerIndex = -1
            game = null
        }
        invalidate()
    }

    fun setAssigned(index: Int, color: Int) {
        playerIndex = index
        playerColor = color
        invalidate()
    }

    /** Name and colours from the game, for the lobby editor. */
    var lobby: Feedback.Lobby? = null
        set(value) { field = value; invalidate() }

    fun canEditProfile() =
        connection is BleControllerServer.Status.Connected && playerIndex >= 0 && lobby != null && game?.state == GameStatus.LOBBY

    fun setGameStatus(s: GameStatus) {
        game = s
        invalidate()
    }

    // ---- geometry ------------------------------------------------------------------------------
    private val dp = resources.displayMetrics.density
    private val safe = Rect()
    private var topBottom = 0f
    private var stickR = 0f
    private var moveHomeX = 0f
    private var moveHomeY = 0f
    private var aimHomeX = 0f
    private var aimHomeY = 0f
    private val mineBtn = RectF()
    private val pauseBtn = RectF()
    private val settingsBtn = RectF()
    private val pill = RectF()

    private class Stick {
        var pointer = -1
        var baseX = 0f
        var baseY = 0f
        var knobX = 0f
        var knobY = 0f
        var vx = 0f
        var vy = 0f
        var downAt = 0L
        var travel = 0f
        var armed = false
        val active get() = pointer != -1
        val mag get() = hypot(vx, vy)
    }

    private val move = Stick()
    private val aim = Stick()
    private var minePointer = -1
    private var lastFireFlash = 0L
    private var cancelFlash = 0L

    override fun onApplyWindowInsets(insets: WindowInsets): WindowInsets {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val i = insets.getInsetsIgnoringVisibility(WindowInsets.Type.displayCutout())
            safe.set(i.left, i.top, i.right, i.bottom)
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val c = insets.displayCutout
            safe.set(c?.safeInsetLeft ?: 0, c?.safeInsetTop ?: 0, c?.safeInsetRight ?: 0, c?.safeInsetBottom ?: 0)
        }
        layoutControls()
        return super.onApplyWindowInsets(insets)
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        layoutControls()
    }

    private fun mirrorX(x: Float) = if (swapSticks) width - x else x

    private fun layoutControls() {
        val w = width.toFloat()
        val h = height.toFloat()
        if (w <= 0 || h <= 0) return
        topBottom = safe.top + max(56 * dp, h * 0.15f)
        stickR = min(h * 0.2f, w * 0.12f)
        moveHomeX = mirrorX(safe.left + w * 0.19f)
        moveHomeY = h * 0.64f
        aimHomeX = mirrorX(w - safe.right - w * 0.21f)
        aimHomeY = h * 0.64f
        // MINE sits top-centre, between the thumbs.
        val mr = stickR * 0.55f
        val my = topBottom + mr + 6 * dp
        mineBtn.set(w / 2 - mr, my - mr, w / 2 + mr, my + mr)
        val b = 44 * dp
        val top = safe.top + (topBottom - safe.top - b) / 2
        settingsBtn.set(w - safe.right - 14 * dp - b, top, w - safe.right - 14 * dp, top + b)
        pauseBtn.set(settingsBtn.left - 10 * dp - b, top, settingsBtn.left - 10 * dp, top + b)
        // Keep Android's back gesture away from where thumbs rest.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val ex = (40 * dp).toInt()
            val exH = min(h, 200 * dp).toInt()
            systemGestureExclusionRects = listOf(
                Rect(0, height - exH, ex, height),
                Rect(width - ex, height - exH, width, height),
            )
        }
    }

    // ---- touch handling -------------------------------------------------------------------------
    override fun onTouchEvent(e: MotionEvent): Boolean {
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN, MotionEvent.ACTION_POINTER_DOWN -> {
                val i = e.actionIndex
                pointerDown(e.getPointerId(i), e.getX(i), e.getY(i))
            }
            MotionEvent.ACTION_MOVE -> {
                for (i in 0 until e.pointerCount) pointerMove(e.getPointerId(i), e.getX(i), e.getY(i))
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_POINTER_UP -> {
                val i = e.actionIndex
                pointerUp(e.getPointerId(i), cancelled = false)
            }
            MotionEvent.ACTION_CANCEL -> {
                for (i in 0 until e.pointerCount) pointerUp(e.getPointerId(i), cancelled = true)
            }
        }
        invalidate()
        return true
    }

    private fun hit(r: RectF, x: Float, y: Float, slop: Float = 10 * dp) =
        x >= r.left - slop && x <= r.right + slop && y >= r.top - slop && y <= r.bottom + slop

    private fun pointerDown(id: Int, x: Float, y: Float) {
        when {
            hit(pauseBtn, x, y) -> {
                state.pauseCount = (state.pauseCount + 1) and 0xff
                performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
                changed()
            }
            canEditProfile() && hit(pill, x, y) -> {
                performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
                listener?.onProfileRequested()
            }
            hit(settingsBtn, x, y) -> {
                performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
                listener?.onSettingsRequested()
            }
            hit(mineBtn, x, y, 14 * dp) -> {
                minePointer = id
                state.mineCount = (state.mineCount + 1) and 0xff
                changed()
            }
            y < topBottom -> Unit
            needsRetry() && helpBox.contains(x, y) -> listener?.onRetryRequested()
            isMoveSide(x) && !move.active -> grab(move, id, x, y)
            !isMoveSide(x) && !aim.active -> grab(aim, id, x, y)
        }
    }

    private fun needsRetry() =
        connection is BleControllerServer.Status.Error || connection is BleControllerServer.Status.Off

    private fun isMoveSide(x: Float) = if (swapSticks) x >= width / 2f else x < width / 2f

    private fun grab(s: Stick, id: Int, x: Float, y: Float) {
        s.pointer = id
        s.baseX = x
        s.baseY = y
        s.knobX = x
        s.knobY = y
        s.vx = 0f
        s.vy = 0f
        s.travel = 0f
        s.armed = false
        s.downAt = SystemClock.uptimeMillis()
        if (s === move) state.moveHeld = true
    }

    private fun pointerMove(id: Int, x: Float, y: Float) {
        val s = when (id) {
            move.pointer -> move
            aim.pointer -> aim
            else -> return
        }
        var dx = x - s.baseX
        var dy = y - s.baseY
        val d = hypot(dx, dy)
        // Drag past the rim and the stick follows your thumb.
        if (d > stickR) {
            s.baseX = x - dx / d * stickR
            s.baseY = y - dy / d * stickR
            dx = x - s.baseX
            dy = y - s.baseY
        }
        s.knobX = x
        s.knobY = y
        s.vx = dx / stickR
        s.vy = dy / stickR
        s.travel = max(s.travel, s.mag)
        if (s === move) {
            state.moveX = s.vx
            state.moveY = s.vy
        } else {
            val armed = s.mag >= AIM_DEADZONE
            if (armed) {
                s.armed = true
                state.aimX = s.vx / s.mag
                state.aimY = s.vy / s.mag
            }
            state.aimHeld = armed
        }
        changed()
    }

    private fun pointerUp(id: Int, cancelled: Boolean) {
        when (id) {
            minePointer -> minePointer = -1
            move.pointer -> {
                move.pointer = -1
                move.vx = 0f
                move.vy = 0f
                state.moveX = 0f
                state.moveY = 0f
                state.moveHeld = false
                changed()
            }
            aim.pointer -> {
                val quickTap = aim.travel < AIM_DEADZONE * 0.6f && SystemClock.uptimeMillis() - aim.downAt < 300
                val release = fireOnRelease && aim.mag >= AIM_DEADZONE
                if (!cancelled && (quickTap || release)) {
                    state.fireCount = (state.fireCount + 1) and 0xff
                    lastFireFlash = SystemClock.uptimeMillis()
                } else if (aim.armed && fireOnRelease) {
                    cancelFlash = SystemClock.uptimeMillis()
                }
                aim.pointer = -1
                aim.vx = 0f
                aim.vy = 0f
                state.aimHeld = false
                changed()
            }
        }
    }

    private fun changed() {
        listener?.onControlsChanged()
    }

    // ---- drawing -----------------------------------------------------------------------------------
    private val bgPaint = Paint()
    private val glowPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = Typeface.create("sans-serif-black", Typeface.NORMAL)
        textAlign = Paint.Align.CENTER
    }
    private val bodyText = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        textAlign = Paint.Align.CENTER
    }
    private val path = Path()
    private val tmp = RectF()

    override fun onDraw(c: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()
        val now = SystemClock.uptimeMillis()
        var animate = false

        // Background
        bgPaint.shader = LinearGradient(0f, 0f, 0f, h, Color.rgb(36, 33, 52), Color.rgb(24, 22, 34), Shader.TileMode.CLAMP)
        c.drawRect(0f, 0f, w, h, bgPaint)
        if (playerIndex >= 0) {
            glowPaint.shader = RadialGradient(w / 2, h * 1.1f, w * 0.6f, withAlpha(playerColor, 70), Color.TRANSPARENT, Shader.TileMode.CLAMP)
            c.drawRect(0f, 0f, w, h, glowPaint)
        }
        // centre divider
        stroke.color = Color.argb(28, 255, 255, 255)
        stroke.strokeWidth = 2 * dp
        var y = mineBtn.bottom + 64 * dp
        while (y < h - 12 * dp) {
            c.drawLine(w / 2, y, w / 2, y + 10 * dp, stroke)
            y += 20 * dp
        }

        animate = drawTopBar(c, now) || animate

        // Zone captions
        bodyText.textSize = 13 * dp
        bodyText.color = Color.argb(90, 255, 255, 255)
        c.drawText("DRIVE", moveHomeX, h - safe.bottom - 16 * dp, bodyText)
        c.drawText(if (fireOnRelease) "AIM · LET GO TO FIRE · TAP TO FIRE" else "AIM · TAP TO FIRE", aimHomeX, h - safe.bottom - 16 * dp, bodyText)

        if (connection !is BleControllerServer.Status.Connected) drawHelp(c)

        drawStick(c, move, moveHomeX, moveHomeY, isAim = false)
        drawStick(c, aim, aimHomeX, aimHomeY, isAim = true)
        drawMineButton(c)

        if (now - lastFireFlash < 140) {
            fill.color = withAlpha(playerColor, (110 * (1 - (now - lastFireFlash) / 140f)).toInt())
            c.drawCircle(aimHomeX, aimHomeY, stickR * 1.25f, fill)
            animate = true
        }
        if (now - cancelFlash < 450) {
            text.textSize = 16 * dp
            text.color = Color.argb((220 * (1 - (now - cancelFlash) / 450f)).toInt(), 255, 255, 255)
            c.drawText("cancelled", aimHomeX, aimHomeY - stickR * 1.3f, text)
            animate = true
        }
        if (animate) postInvalidateOnAnimation()
    }

    /** Returns true if something in the bar is animating. */
    private fun drawTopBar(c: Canvas, now: Long): Boolean {
        val w = width.toFloat()
        val barTop = safe.top.toFloat()
        val midY = (barTop + topBottom) / 2
        var animate = false

        // Connection pill (left)
        val (dotColor, label) = when (val s = connection) {
            is BleControllerServer.Status.Connected ->
                if (playerIndex >= 0) {
                    val name = lobby?.name?.takeIf { it.isNotBlank() }
                    playerColor to (if (name != null) "P${playerIndex + 1} · ${name.uppercase()}" else "PLAYER ${playerIndex + 1}")
                } else {
                    Color.rgb(92, 196, 97) to "CONNECTED"
                }
            is BleControllerServer.Status.Advertising -> Color.rgb(255, 205, 69) to "WAITING FOR GAME"
            is BleControllerServer.Status.Error -> Color.rgb(255, 90, 74) to "BLUETOOTH PROBLEM"
            BleControllerServer.Status.Off -> Color.GRAY to "BLUETOOTH OFF"
        }
        text.textSize = 15 * dp
        text.textAlign = Paint.Align.LEFT
        val tw = text.measureText(label)
        val pillH = 36 * dp
        val left = safe.left + 14 * dp
        pill.set(left, midY - pillH / 2, left + tw + 46 * dp, midY + pillH / 2)
        fill.color = if (playerIndex >= 0) playerColor else Color.argb(40, 255, 255, 255)
        c.drawRoundRect(pill, pillH / 2, pillH / 2, fill)
        if (canEditProfile()) {
            bodyText.textSize = 12 * dp
            bodyText.textAlign = Paint.Align.LEFT
            bodyText.color = Color.argb(170, 255, 255, 255)
            c.drawText("✎ Tap to change name & colour", left + 8 * dp, pill.bottom + 16 * dp, bodyText)
            bodyText.textAlign = Paint.Align.CENTER
        }
        var pulse = 1f
        if (connection is BleControllerServer.Status.Advertising) {
            pulse = 0.5f + 0.5f * sin(now / 250.0).toFloat().let { it * it }
            animate = true
        }
        fill.color = if (playerIndex >= 0) Color.WHITE else withAlpha(dotColor, (255 * pulse).toInt())
        c.drawCircle(left + 18 * dp, midY, 6 * dp, fill)
        text.color = Color.WHITE
        c.drawText(label, left + 32 * dp, midY + 5.5f * dp, text)
        text.textAlign = Paint.Align.CENTER

        // Score + game state (centre)
        val g = game
        if (connection is BleControllerServer.Status.Connected && g != null) {
            if (g.state != GameStatus.LOBBY) {
                text.textSize = 26 * dp
                text.color = Color.WHITE
                c.drawText("${g.myWins}  –  ${g.theirWins}", w / 2, midY + 2 * dp, text)
                bodyText.textSize = 11 * dp
                bodyText.color = Color.argb(150, 255, 255, 255)
                c.drawText("you · them · first to ${g.winsNeeded}", w / 2, midY + 17 * dp, bodyText)
            }
            val msg = when (g.state) {
                GameStatus.LOBBY -> if (g.ready) "READY! Waiting for the other player" else "Press FIRE when you're ready"
                GameStatus.COUNTDOWN -> "Get ready…"
                GameStatus.ROUND_OVER -> "Round over"
                GameStatus.MATCH_OVER -> "Match over · FIRE for a rematch"
                GameStatus.PAUSED -> "Paused"
                else -> null
            }
            if (msg != null) {
                text.textSize = 17 * dp
                text.color = if (g.state == GameStatus.LOBBY && g.ready) Color.rgb(120, 230, 120) else Color.rgb(255, 205, 69)
                c.drawText(msg, w / 2, mineBtn.bottom + 48 * dp, text)
            }
            // Shells left
            if (g.state == GameStatus.PLAYING || g.state == GameStatus.COUNTDOWN) {
                val n = g.shellsLeft
                val max = g.shellsMax.coerceIn(1, 10)
                val sw = 8 * dp
                val sh = 18 * dp
                val gap = 5 * dp
                val total = max * sw + (max - 1) * gap
                var x = w / 2 - total / 2
                val yy = mineBtn.bottom + 8 * dp
                for (k in 0 until max) {
                    tmp.set(x, yy, x + sw, yy + sh)
                    fill.color = if (k < n) Color.rgb(244, 240, 230) else Color.argb(40, 255, 255, 255)
                    c.drawRoundRect(tmp, sw / 2, sw / 2, fill)
                    x += sw + gap
                }
            }
        }

        // Pause + settings (right)
        drawIconButton(c, pauseBtn) { r ->
            val bw = r.width() * 0.13f
            val bh = r.height() * 0.42f
            tmp.set(r.centerX() - bw * 1.8f, r.centerY() - bh / 2, r.centerX() - bw * 0.6f, r.centerY() + bh / 2)
            c.drawRoundRect(tmp, bw / 2, bw / 2, fill)
            tmp.set(r.centerX() + bw * 0.6f, r.centerY() - bh / 2, r.centerX() + bw * 1.8f, r.centerY() + bh / 2)
            c.drawRoundRect(tmp, bw / 2, bw / 2, fill)
        }
        drawIconButton(c, settingsBtn) { r ->
            stroke.color = Color.WHITE
            stroke.strokeWidth = 2.5f * dp
            stroke.strokeCap = Paint.Cap.ROUND
            val l = r.left + r.width() * 0.26f
            val rr = r.right - r.width() * 0.26f
            for ((k, f) in listOf(0.32f, 0.5f, 0.68f).withIndex()) {
                val yy = r.top + r.height() * f
                c.drawLine(l, yy, rr, yy, stroke)
                val kx = l + (rr - l) * listOf(0.7f, 0.3f, 0.55f)[k]
                c.drawCircle(kx, yy, 3.5f * dp, fill)
            }
            stroke.strokeCap = Paint.Cap.BUTT
        }
        return animate
    }

    private inline fun drawIconButton(c: Canvas, r: RectF, icon: (RectF) -> Unit) {
        fill.color = Color.argb(40, 255, 255, 255)
        c.drawRoundRect(r, 12 * dp, 12 * dp, fill)
        fill.color = Color.WHITE
        icon(r)
    }

    private fun drawHelp(c: Canvas) {
        val w = width.toFloat()
        val cx = w / 2
        var yy = topBottom + 34 * dp
        val lines: List<String> = when (val s = connection) {
            is BleControllerServer.Status.Advertising -> listOf(
                "1. On the computer, open Ricochet Rumble in Chrome or Edge",
                "2. Click “Phone” on a player card",
                "3. Pick “${s.name}” in the Bluetooth list",
            )
            is BleControllerServer.Status.Error -> listOf(s.message, "Tap here to try again")
            BleControllerServer.Status.Off -> listOf("Bluetooth is off or not allowed.", "Tap here to try again")
            else -> emptyList()
        }
        if (lines.isEmpty()) return
        bodyText.textSize = 15 * dp
        val maxW = lines.maxOf { bodyText.measureText(it) } + 36 * dp
        val boxH = lines.size * 24 * dp + 18 * dp
        tmp.set(cx - maxW / 2, yy - 22 * dp, cx + maxW / 2, yy - 22 * dp + boxH)
        helpBox.set(tmp)
        fill.color = Color.argb(150, 10, 8, 18)
        c.drawRoundRect(tmp, 16 * dp, 16 * dp, fill)
        bodyText.color = Color.WHITE
        for (line in lines) {
            c.drawText(line, cx, yy, bodyText)
            yy += 24 * dp
        }
    }

    /** Area of the help box, so the activity can make it tappable for retries. */
    val helpBox = RectF()

    private fun drawStick(c: Canvas, s: Stick, homeX: Float, homeY: Float, isAim: Boolean) {
        val bx = if (s.active) s.baseX else homeX
        val by = if (s.active) s.baseY else homeY
        val alpha = if (s.active) 1f else 0.45f
        // base
        fill.color = Color.argb((26 * alpha).toInt(), 255, 255, 255)
        c.drawCircle(bx, by, stickR, fill)
        stroke.color = Color.argb((90 * alpha).toInt(), 255, 255, 255)
        stroke.strokeWidth = 3 * dp
        c.drawCircle(bx, by, stickR, stroke)
        if (isAim) {
            stroke.color = Color.argb((40 * alpha).toInt(), 255, 255, 255)
            stroke.strokeWidth = 1.5f * dp
            c.drawCircle(bx, by, stickR * AIM_DEADZONE, stroke)
        }
        // direction pointer
        val kx: Float
        val ky: Float
        if (s.active) {
            val m = s.mag
            val f = if (m > 1f) 1f / m else 1f
            kx = bx + s.vx * f * stickR
            ky = by + s.vy * f * stickR
        } else {
            kx = bx
            ky = by
        }
        val armed = isAim && s.active && s.mag >= AIM_DEADZONE
        if (armed) {
            val a = atan2(s.vy, s.vx)
            path.reset()
            val tipR = stickR * 1.32f
            path.moveTo(bx + cos(a) * tipR, by + sin(a) * tipR)
            path.lineTo(bx + cos(a + 0.22f) * stickR * 1.08f, by + sin(a + 0.22f) * stickR * 1.08f)
            path.lineTo(bx + cos(a - 0.22f) * stickR * 1.08f, by + sin(a - 0.22f) * stickR * 1.08f)
            path.close()
            fill.color = playerColor
            c.drawPath(path, fill)
        } else if (isAim && !s.active && playerIndex >= 0) {
            // show where the turret last pointed
            val a = atan2(state.aimY, state.aimX)
            fill.color = withAlpha(playerColor, 120)
            c.drawCircle(bx + cos(a) * stickR * 0.78f, by + sin(a) * stickR * 0.78f, 4 * dp, fill)
        }
        // knob
        val kr = stickR * 0.44f
        val base = if (isAim && s.active && s.armed && !armed && fireOnRelease) Color.rgb(140, 136, 150) else playerColor
        fill.color = withAlpha(darken(base, 0.35f), (255 * alpha).toInt())
        c.drawCircle(kx, ky + 3 * dp, kr, fill)
        fill.color = withAlpha(base, (255 * alpha).toInt())
        c.drawCircle(kx, ky, kr, fill)
        fill.color = Color.argb((60 * alpha).toInt(), 255, 255, 255)
        c.drawCircle(kx - kr * 0.25f, ky - kr * 0.3f, kr * 0.35f, fill)
        if (isAim) {
            // crosshair glyph
            stroke.color = Color.argb((200 * alpha).toInt(), 255, 255, 255)
            stroke.strokeWidth = 2.5f * dp
            c.drawCircle(kx, ky, kr * 0.42f, stroke)
            c.drawLine(kx - kr * 0.7f, ky, kx - kr * 0.25f, ky, stroke)
            c.drawLine(kx + kr * 0.25f, ky, kx + kr * 0.7f, ky, stroke)
            c.drawLine(kx, ky - kr * 0.7f, kx, ky - kr * 0.25f, stroke)
            c.drawLine(kx, ky + kr * 0.25f, kx, ky + kr * 0.7f, stroke)
        }
    }

    private fun drawMineButton(c: Canvas) {
        val pressed = minePointer != -1
        val r = mineBtn.width() / 2
        val cx = mineBtn.centerX()
        val cy = mineBtn.centerY()
        fill.color = Color.argb(if (pressed) 90 else 40, 255, 255, 255)
        c.drawCircle(cx, cy, r, fill)
        stroke.color = withAlpha(playerColor, 200)
        stroke.strokeWidth = 3 * dp
        c.drawCircle(cx, cy, r, stroke)
        // mine icon
        fill.color = Color.rgb(59, 57, 54)
        c.drawCircle(cx, cy - r * 0.12f, r * 0.42f, fill)
        fill.color = playerColor
        c.drawCircle(cx, cy - r * 0.12f, r * 0.32f, fill)
        fill.color = Color.rgb(85, 82, 77)
        c.drawCircle(cx, cy - r * 0.12f, r * 0.22f, fill)
        fill.color = Color.rgb(255, 74, 58)
        c.drawCircle(cx, cy - r * 0.12f, r * 0.09f, fill)
        text.textSize = 12 * dp
        text.color = Color.WHITE
        c.drawText("MINE", cx, cy + r * 0.62f, text)
        val g = game
        if (g != null && (g.state == GameStatus.PLAYING || g.state == GameStatus.COUNTDOWN)) {
            val bx = cx + r * 0.72f
            val by = cy - r * 0.72f
            fill.color = if (g.minesLeft > 0) playerColor else Color.GRAY
            c.drawCircle(bx, by, 11 * dp, fill)
            text.textSize = 13 * dp
            c.drawText(g.minesLeft.toString(), bx, by + 4.5f * dp, text)
        }
    }

    private fun withAlpha(color: Int, a: Int) = Color.argb(a.coerceIn(0, 255), Color.red(color), Color.green(color), Color.blue(color))

    private fun darken(color: Int, f: Float) = Color.rgb(
        (Color.red(color) * (1 - f)).toInt(),
        (Color.green(color) * (1 - f)).toInt(),
        (Color.blue(color) * (1 - f)).toInt(),
    )

    companion object {
        const val AIM_DEADZONE = 0.32f
    }
}
