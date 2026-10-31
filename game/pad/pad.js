// Ricochet Pad (Wi-Fi) — the phone controller, served by the computer running
// the game. A port of the Android app's ControllerView: same layout, same
// controls, same packets (see docs/PROTOCOL.md), sent over a WebSocket instead
// of Bluetooth.
(function () {
  const P = RR.PROTO;
  const AIM_DEADZONE = 0.32;
  const MSG_HEARTBEAT = 0;
  const MSG_KICK = 4;
  const PALETTE = RR.CFG.PLAYER_COLORS;

  const canvas = document.getElementById('pad');
  const ctx = canvas.getContext('2d');
  const params = new URLSearchParams(location.search);

  // ---- settings ------------------------------------------------------------------
  const prefs = load('rr-pad-prefs', { fireOnRelease: true, haptics: true, swap: false });

  function load(key, fallback) {
    try { return Object.assign({}, fallback, JSON.parse(localStorage.getItem(key) || '{}')); } catch (e) { return fallback; }
  }

  function save() {
    try { localStorage.setItem('rr-pad-prefs', JSON.stringify(prefs)); } catch (e) { /* private mode */ }
  }

  // ---- controller state (same fields as the Android app) ---------------------------
  const state = { moveX: 0, moveY: 0, aimX: 1, aimY: 0, aimHeld: false, moveHeld: false, fireCount: 0, mineCount: 0, pauseCount: 0 };
  let seq = 0;

  function encode() {
    const b = new Uint8Array(P.INPUT_LEN);
    const i8 = (v) => Math.round(Math.max(-1, Math.min(1, v)) * 127) & 0xff;
    seq = (seq + 1) & 0xff;
    b[0] = P.VERSION;
    b[1] = seq;
    b[2] = i8(state.moveX);
    b[3] = i8(state.moveY);
    b[4] = i8(state.aimX);
    b[5] = i8(state.aimY);
    b[6] = (state.aimHeld ? P.FLAG_AIM_HELD : 0) | (state.moveHeld ? P.FLAG_MOVE_HELD : 0);
    b[7] = state.fireCount & 0xff;
    b[8] = state.mineCount & 0xff;
    b[9] = state.pauseCount & 0xff;
    return b;
  }

  // ---- connection to the game -------------------------------------------------------
  // conn: 'connecting' | 'connected' | 'lost' | 'kicked' | 'full'
  let conn = 'connecting';
  let ws = null;
  let lastMsgAt = 0;
  let lastSentAt = 0;
  let retryDelay = 800;
  let playerIndex = -1;
  let playerColor = 'rgb(200,200,215)';
  let game = null;
  let lobbyInfo = null; // { my, other, name } from the game

  const padId = (() => {
    try {
      let id = sessionStorage.getItem('rr-pad-id');
      if (!id) {
        id = Math.random().toString(36).slice(2, 10);
        sessionStorage.setItem('rr-pad-id', id);
      }
      return id;
    } catch (e) {
      return Math.random().toString(36).slice(2, 10);
    }
  })();
  const ua = navigator.userAgent;
  const deviceName = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android phone' : 'Phone';

  function connect() {
    const q = new URLSearchParams({ role: 'pad', id: padId, slot: params.get('slot') || '', name: deviceName });
    const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?${q}`);
    sock.binaryType = 'arraybuffer';
    ws = sock;
    sock.onopen = () => {
      lastMsgAt = performance.now();
      retryDelay = 800;
      sendState();
    };
    sock.onmessage = (e) => {
      lastMsgAt = performance.now();
      if (e.data instanceof ArrayBuffer) onFeedback(new Uint8Array(e.data));
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      if (conn === 'kicked' || conn === 'full') return;
      if (conn === 'connected') conn = 'lost';
      playerIndex = -1;
      game = null;
      setTimeout(connect, retryDelay);
      retryDelay = Math.min(3000, retryDelay * 1.5);
      dirty = true;
    };
  }

  function onFeedback(b) {
    if (!b.length) return;
    if (conn !== 'connected' && b[0] !== MSG_KICK) conn = 'connected';
    switch (b[0]) {
      case MSG_HEARTBEAT:
        break;
      case P.MSG_ASSIGN:
        if (b.length >= 5) {
          playerIndex = b[1] === 255 ? -1 : b[1];
          playerColor = `rgb(${b[2]},${b[3]},${b[4]})`;
          vibrate(120);
        }
        break;
      case P.MSG_RUMBLE:
        if (b.length >= 3) vibrate(b[1] * 10);
        break;
      case P.MSG_STATUS:
        if (b.length >= 9) {
          game = { state: b[1], myWins: b[2], theirWins: b[3], winsNeeded: b[4], shellsLeft: b[5], minesLeft: b[6], ready: b[7] !== 0, shellsMax: b[8] };
        }
        break;
      case P.MSG_LOBBY:
        if (b.length >= 4) {
          lobbyInfo = { my: b[1], other: b[2], name: new TextDecoder().decode(b.slice(4, 4 + b[3])) };
        }
        break;
      case MSG_KICK:
        conn = b[1] === 1 ? 'full' : 'kicked';
        playerIndex = -1;
        game = null;
        if (ws) ws.close();
        break;
    }
    dirty = true;
  }

  function sendState() {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(encode());
      lastSentAt = performance.now();
    }
  }

  function vibrate(ms) {
    if (prefs.haptics && navigator.vibrate) {
      try { navigator.vibrate(Math.max(5, Math.min(2000, ms))); } catch (e) { /* not allowed yet */ }
    }
  }

  // Keep-alive, and notice a dead Wi-Fi link even when the socket hasn't closed.
  setInterval(() => {
    const now = performance.now();
    if (ws && ws.readyState === WebSocket.OPEN) {
      if (now - lastSentAt > 200) sendState();
      if (now - lastMsgAt > 2500) {
        if (conn === 'connected') conn = 'lost';
        ws.close();
        dirty = true;
      }
    }
  }, 100);

  function retry() {
    conn = 'connecting';
    retryDelay = 800;
    if (!ws) connect();
    dirty = true;
  }

  // ---- geometry -----------------------------------------------------------------------
  const dp = 1; // CSS pixels already match Android dp closely
  let W = 0, H = 0;
  const safe = { left: 0, top: 0, right: 0, bottom: 0 };
  let topBottom = 0, stickR = 0, moveHomeX = 0, moveHomeY = 0, aimHomeX = 0, aimHomeY = 0;
  const mineBtn = {}, pauseBtn = {}, settingsBtn = {}, pill = {}, helpBox = { left: 0, top: 0, right: 0, bottom: 0 };

  function rect(r, l, t, rr, b) {
    r.left = l; r.top = t; r.right = rr; r.bottom = b;
  }

  const mirrorX = (x) => (prefs.swap ? W - x : x);

  function layout() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cs = getComputedStyle(document.getElementById('safe'));
    safe.top = parseFloat(cs.paddingTop) || 0;
    safe.right = parseFloat(cs.paddingRight) || 0;
    safe.bottom = parseFloat(cs.paddingBottom) || 0;
    safe.left = parseFloat(cs.paddingLeft) || 0;

    topBottom = safe.top + Math.max(56 * dp, H * 0.15);
    stickR = Math.min(H * 0.2, W * 0.12);
    moveHomeX = mirrorX(safe.left + W * 0.19);
    moveHomeY = H * 0.64;
    aimHomeX = mirrorX(W - safe.right - W * 0.21);
    aimHomeY = H * 0.64;
    // MINE sits top-centre, between the thumbs.
    const mr = stickR * 0.55;
    const my = topBottom + mr + 6 * dp;
    rect(mineBtn, W / 2 - mr, my - mr, W / 2 + mr, my + mr);
    const b = 44 * dp;
    const top = safe.top + (topBottom - safe.top - b) / 2;
    rect(settingsBtn, W - safe.right - 14 * dp - b, top, W - safe.right - 14 * dp, top + b);
    rect(pauseBtn, settingsBtn.left - 10 * dp - b, top, settingsBtn.left - 10 * dp, top + b);
    dirty = true;
  }

  // ---- touch handling ---------------------------------------------------------------------
  const newStick = () => ({ pointer: -1, baseX: 0, baseY: 0, knobX: 0, knobY: 0, vx: 0, vy: 0, downAt: 0, travel: 0, armed: false });
  const move = newStick();
  const aim = newStick();
  const mag = (s) => Math.hypot(s.vx, s.vy);
  let minePointer = -1;
  let lastFireFlash = -1e9;
  let cancelFlash = -1e9;

  const hit = (r, x, y, slop = 10 * dp) => x >= r.left - slop && x <= r.right + slop && y >= r.top - slop && y <= r.bottom + slop;
  const isMoveSide = (x) => (prefs.swap ? x >= W / 2 : x < W / 2);
  const needsRetry = () => conn === 'kicked' || conn === 'full';
  const canEditProfile = () => conn === 'connected' && playerIndex >= 0 && lobbyInfo && game && game.state === P.STATE.LOBBY;

  function pointerDown(id, x, y) {
    if (hit(pauseBtn, x, y)) {
      state.pauseCount = (state.pauseCount + 1) & 0xff;
      sendState();
    } else if (hit(settingsBtn, x, y)) {
      openSettings();
    } else if (canEditProfile() && hit(pill, x, y)) {
      openProfile();
    } else if (hit(mineBtn, x, y, 14 * dp)) {
      minePointer = id;
      state.mineCount = (state.mineCount + 1) & 0xff;
      sendState();
    } else if (y < topBottom) {
      // top bar
    } else if (needsRetry() && x >= helpBox.left && x <= helpBox.right && y >= helpBox.top && y <= helpBox.bottom) {
      retry();
    } else if (isMoveSide(x) && move.pointer === -1) {
      grab(move, id, x, y);
    } else if (!isMoveSide(x) && aim.pointer === -1) {
      grab(aim, id, x, y);
    }
  }

  function grab(s, id, x, y) {
    Object.assign(s, { pointer: id, baseX: x, baseY: y, knobX: x, knobY: y, vx: 0, vy: 0, travel: 0, armed: false, downAt: performance.now() });
    if (s === move) state.moveHeld = true;
  }

  function pointerMove(id, x, y) {
    const s = id === move.pointer ? move : id === aim.pointer ? aim : null;
    if (!s) return;
    let dx = x - s.baseX;
    let dy = y - s.baseY;
    const d = Math.hypot(dx, dy);
    // Drag past the rim and the stick follows your thumb.
    if (d > stickR) {
      s.baseX = x - (dx / d) * stickR;
      s.baseY = y - (dy / d) * stickR;
      dx = x - s.baseX;
      dy = y - s.baseY;
    }
    s.knobX = x;
    s.knobY = y;
    s.vx = dx / stickR;
    s.vy = dy / stickR;
    s.travel = Math.max(s.travel, mag(s));
    if (s === move) {
      state.moveX = s.vx;
      state.moveY = s.vy;
    } else {
      const m = mag(s);
      const armed = m >= AIM_DEADZONE;
      if (armed) {
        s.armed = true;
        state.aimX = s.vx / m;
        state.aimY = s.vy / m;
      }
      state.aimHeld = armed;
    }
    sendState();
  }

  function pointerUp(id, cancelled) {
    if (id === minePointer) {
      minePointer = -1;
    } else if (id === move.pointer) {
      Object.assign(move, { pointer: -1, vx: 0, vy: 0 });
      Object.assign(state, { moveX: 0, moveY: 0, moveHeld: false });
      sendState();
    } else if (id === aim.pointer) {
      const quickTap = aim.travel < AIM_DEADZONE * 0.6 && performance.now() - aim.downAt < 300;
      const release = prefs.fireOnRelease && mag(aim) >= AIM_DEADZONE;
      if (!cancelled && (quickTap || release)) {
        state.fireCount = (state.fireCount + 1) & 0xff;
        lastFireFlash = performance.now();
      } else if (aim.armed && prefs.fireOnRelease) {
        cancelFlash = performance.now();
      }
      Object.assign(aim, { pointer: -1, vx: 0, vy: 0 });
      state.aimHeld = false;
      sendState();
    }
  }

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    goFullscreen();
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    pointerDown(e.pointerId, e.clientX, e.clientY);
    dirty = true;
  });
  canvas.addEventListener('pointermove', (e) => {
    e.preventDefault();
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    const last = events.length ? events[events.length - 1] : e;
    pointerMove(e.pointerId, last.clientX, last.clientY);
    dirty = true;
  });
  canvas.addEventListener('pointerup', (e) => { pointerUp(e.pointerId, false); dirty = true; });
  canvas.addEventListener('pointercancel', (e) => { pointerUp(e.pointerId, true); dirty = true; });
  // iOS: stop pinch-zoom, double-tap zoom and rubber-band scrolling.
  for (const t of ['touchstart', 'touchmove', 'gesturestart']) {
    document.addEventListener(t, (e) => e.preventDefault(), { passive: false });
  }

  let triedFullscreen = false;
  function goFullscreen() {
    if (triedFullscreen) return;
    triedFullscreen = true;
    const el = document.documentElement;
    if (el.requestFullscreen && !document.fullscreenElement) {
      el.requestFullscreen({ navigationUI: 'hide' })
        .then(() => screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape'))
        .catch(() => {});
    }
  }

  const $ = (id) => document.getElementById(id);

  // ---- name & colour (lobby only) ----------------------------------------------------------
  let pickedColor = 0;
  function openProfile() {
    pickedColor = lobbyInfo.my;
    $('profile-name').value = lobbyInfo.name || '';
    const box = $('profile-colors');
    box.innerHTML = '';
    PALETTE.forEach((c, i) => {
      const b = document.createElement('button');
      b.style.background = c.body;
      b.title = c.name;
      b.disabled = i === lobbyInfo.other;
      b.setAttribute('aria-checked', String(i === pickedColor));
      b.addEventListener('click', () => {
        pickedColor = i;
        box.querySelectorAll('button').forEach((x, k) => x.setAttribute('aria-checked', String(k === i)));
      });
      box.appendChild(b);
    });
    $('profile').classList.remove('hidden');
  }
  $('profile-cancel').addEventListener('click', () => $('profile').classList.add('hidden'));
  $('profile-save').addEventListener('click', () => {
    const name = $('profile-name').value.trim().slice(0, 12);
    const nb = P.nameBytes(name, 17);
    const msg = new Uint8Array(3 + nb.length);
    msg.set([P.PROFILE, pickedColor, nb.length]);
    msg.set(nb, 3);
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(msg);
    $('profile-name').blur();
    $('profile').classList.add('hidden');
  });
  $('profile').addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });

  // ---- settings sheet -------------------------------------------------------------------------
  function openSettings() {
    $('opt-release').checked = prefs.fireOnRelease;
    $('opt-haptics').checked = prefs.haptics;
    $('opt-swap').checked = prefs.swap;
    $('opt-haptics').disabled = !navigator.vibrate;
    $('opt-note').textContent = navigator.vibrate ? '' : 'This browser can’t vibrate (iPhones don’t allow it for web pages).';
    $('settings').classList.remove('hidden');
  }
  $('opt-done').addEventListener('click', () => {
    prefs.fireOnRelease = $('opt-release').checked;
    prefs.haptics = $('opt-haptics').checked;
    prefs.swap = $('opt-swap').checked;
    save();
    $('settings').classList.add('hidden');
    layout();
  });
  // the sheet's own controls need normal touch behaviour
  $('settings').addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });

  // ---- drawing ------------------------------------------------------------------------------------
  let dirty = true;
  const FONT = 'system-ui, -apple-system, Roboto, "Helvetica Neue", Arial, sans-serif';
  const font = (weight, size) => { ctx.font = `${weight} ${size}px ${FONT}`; };
  const rgba = (r, g, b, a) => `rgba(${r},${g},${b},${a / 255})`;

  function parseRgb(c) {
    const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(c);
    return m ? [+m[1], +m[2], +m[3]] : [200, 200, 215];
  }
  const withAlpha = (c, a) => { const [r, g, b] = parseRgb(c); return rgba(r, g, b, Math.max(0, Math.min(255, a))); };
  const darken = (c, f) => { const [r, g, b] = parseRgb(c); return `rgb(${Math.round(r * (1 - f))},${Math.round(g * (1 - f))},${Math.round(b * (1 - f))})`; };

  function circle(x, y, r, fill) {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  function ring(x, y, r, color, width) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  function roundRect(l, t, r, b, rad, fill) {
    ctx.fillStyle = fill;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(l, t, r - l, b - t, rad);
    else ctx.rect(l, t, r - l, b - t);
    ctx.fill();
  }

  function line(x1, y1, x2, y2) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  function draw(now) {
    let animate = false;
    const w = W, h = H;

    // Background
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, 'rgb(36,33,52)');
    bg.addColorStop(1, 'rgb(24,22,34)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    if (playerIndex >= 0) {
      const g = ctx.createRadialGradient(w / 2, h * 1.1, 0, w / 2, h * 1.1, w * 0.6);
      g.addColorStop(0, withAlpha(playerColor, 70));
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    // centre divider
    ctx.strokeStyle = rgba(255, 255, 255, 28);
    ctx.lineWidth = 2 * dp;
    for (let y = mineBtn.bottom + 64 * dp; y < h - 12 * dp; y += 20 * dp) line(w / 2, y, w / 2, y + 10 * dp);

    animate = drawTopBar(now) || animate;

    // Zone captions
    font(500, 13 * dp);
    ctx.textAlign = 'center';
    ctx.fillStyle = rgba(255, 255, 255, 90);
    ctx.fillText('DRIVE', moveHomeX, h - safe.bottom - 16 * dp);
    ctx.fillText(prefs.fireOnRelease ? 'AIM · LET GO TO FIRE · TAP TO FIRE' : 'AIM · TAP TO FIRE', aimHomeX, h - safe.bottom - 16 * dp);

    if (conn !== 'connected') drawHelp();

    drawStick(move, moveHomeX, moveHomeY, false);
    drawStick(aim, aimHomeX, aimHomeY, true);
    drawMineButton();

    if (now - lastFireFlash < 140) {
      circle(aimHomeX, aimHomeY, stickR * 1.25, withAlpha(playerColor, 110 * (1 - (now - lastFireFlash) / 140)));
      animate = true;
    }
    if (now - cancelFlash < 450) {
      font(900, 16 * dp);
      ctx.fillStyle = rgba(255, 255, 255, 220 * (1 - (now - cancelFlash) / 450));
      ctx.fillText('cancelled', aimHomeX, aimHomeY - stickR * 1.3);
      animate = true;
    }
    return animate;
  }

  function drawTopBar(now) {
    const w = W;
    const midY = (safe.top + topBottom) / 2;
    let animate = false;

    // Connection pill (left)
    let dot, label;
    if (conn === 'connected') {
      if (playerIndex >= 0) {
        dot = playerColor;
        label = lobbyInfo && lobbyInfo.name ? `P${playerIndex + 1} · ${lobbyInfo.name.toUpperCase()}` : `PLAYER ${playerIndex + 1}`;
      } else { dot = 'rgb(92,196,97)'; label = 'CONNECTED'; }
    } else if (conn === 'connecting') { dot = 'rgb(255,205,69)'; label = 'CONNECTING…'; }
    else if (conn === 'lost') { dot = 'rgb(255,205,69)'; label = 'RECONNECTING…'; }
    else if (conn === 'full') { dot = 'rgb(255,90,74)'; label = 'GAME IS FULL'; }
    else { dot = 'rgb(255,90,74)'; label = 'DISCONNECTED'; }
    font(900, 15 * dp);
    ctx.textAlign = 'left';
    const tw = ctx.measureText(label).width;
    const pillH = 36 * dp;
    const left = safe.left + 14 * dp;
    rect(pill, left, midY - pillH / 2, left + tw + 46 * dp, midY + pillH / 2);
    roundRect(pill.left, pill.top, pill.right, pill.bottom, pillH / 2, playerIndex >= 0 ? playerColor : rgba(255, 255, 255, 40));
    if (canEditProfile()) {
      font(700, 12 * dp);
      ctx.fillStyle = rgba(255, 255, 255, 170);
      ctx.fillText('✎ Tap to change name & colour', left + 8 * dp, pill.bottom + 16 * dp);
      font(900, 15 * dp);
    }
    let pulse = 1;
    if (conn === 'connecting' || conn === 'lost') {
      const s = Math.sin(now / 250);
      pulse = 0.5 + 0.5 * s * s;
      animate = true;
    }
    circle(left + 18 * dp, midY, 6 * dp, playerIndex >= 0 ? '#fff' : withAlpha(dot, 255 * pulse));
    ctx.fillStyle = '#fff';
    ctx.fillText(label, left + 32 * dp, midY + 5.5 * dp);
    ctx.textAlign = 'center';

    // Score + game state (centre)
    const g = game;
    if (conn === 'connected' && g) {
      if (g.state !== P.STATE.LOBBY) {
        font(900, 26 * dp);
        ctx.fillStyle = '#fff';
        ctx.fillText(`${g.myWins}  –  ${g.theirWins}`, w / 2, midY + 2 * dp);
        font(500, 11 * dp);
        ctx.fillStyle = rgba(255, 255, 255, 150);
        ctx.fillText(`you · them · first to ${g.winsNeeded}`, w / 2, midY + 17 * dp);
      }
      const msg = {
        [P.STATE.LOBBY]: g.ready ? 'READY! Waiting for the other player' : 'Press FIRE when you\'re ready',
        [P.STATE.COUNTDOWN]: 'Get ready…',
        [P.STATE.ROUND_OVER]: 'Round over',
        [P.STATE.MATCH_OVER]: 'Match over · FIRE for a rematch',
        [P.STATE.PAUSED]: 'Paused',
      }[g.state];
      if (msg) {
        font(900, 17 * dp);
        ctx.fillStyle = g.state === P.STATE.LOBBY && g.ready ? 'rgb(120,230,120)' : 'rgb(255,205,69)';
        ctx.fillText(msg, w / 2, mineBtn.bottom + 48 * dp);
      }
      // Shells left
      if (g.state === P.STATE.PLAYING || g.state === P.STATE.COUNTDOWN) {
        const max = Math.max(1, Math.min(10, g.shellsMax));
        const sw = 8 * dp, sh = 18 * dp, gap = 5 * dp;
        let x = w / 2 - (max * sw + (max - 1) * gap) / 2;
        const yy = mineBtn.bottom + 8 * dp;
        for (let k = 0; k < max; k++) {
          roundRect(x, yy, x + sw, yy + sh, sw / 2, k < g.shellsLeft ? 'rgb(244,240,230)' : rgba(255, 255, 255, 40));
          x += sw + gap;
        }
      }
    }

    // Pause + settings (right)
    iconButton(pauseBtn, (r) => {
      const bw = (r.right - r.left) * 0.13, bh = (r.bottom - r.top) * 0.42;
      const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
      roundRect(cx - bw * 1.8, cy - bh / 2, cx - bw * 0.6, cy + bh / 2, bw / 2, '#fff');
      roundRect(cx + bw * 0.6, cy - bh / 2, cx + bw * 1.8, cy + bh / 2, bw / 2, '#fff');
    });
    iconButton(settingsBtn, (r) => {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2.5 * dp;
      ctx.lineCap = 'round';
      const l = r.left + (r.right - r.left) * 0.26, rr = r.right - (r.right - r.left) * 0.26;
      [0.32, 0.5, 0.68].forEach((f, k) => {
        const yy = r.top + (r.bottom - r.top) * f;
        line(l, yy, rr, yy);
        circle(l + (rr - l) * [0.7, 0.3, 0.55][k], yy, 3.5 * dp, '#fff');
      });
      ctx.lineCap = 'butt';
    });
    return animate;
  }

  function iconButton(r, icon) {
    roundRect(r.left, r.top, r.right, r.bottom, 12 * dp, rgba(255, 255, 255, 40));
    icon(r);
  }

  function drawHelp() {
    const cx = W / 2;
    let yy = topBottom + 34 * dp;
    const lines = {
      connecting: ['Connecting to the game…', 'Your phone must be on the same Wi-Fi as the computer'],
      lost: ['Lost connection to the game', 'Reconnecting automatically…'],
      kicked: ['This controller was removed from the game', 'Tap here to join again'],
      full: ['Both players already have controllers', 'Tap here to try again'],
    }[conn];
    if (!lines) return;
    font(500, 15 * dp);
    const maxW = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 36 * dp;
    const boxH = lines.length * 24 * dp + 18 * dp;
    rect(helpBox, cx - maxW / 2, yy - 22 * dp, cx + maxW / 2, yy - 22 * dp + boxH);
    roundRect(helpBox.left, helpBox.top, helpBox.right, helpBox.bottom, 16 * dp, rgba(10, 8, 18, 150));
    ctx.fillStyle = '#fff';
    for (const l of lines) {
      ctx.fillText(l, cx, yy);
      yy += 24 * dp;
    }
  }

  function drawStick(s, homeX, homeY, isAim) {
    const active = s.pointer !== -1;
    const bx = active ? s.baseX : homeX;
    const by = active ? s.baseY : homeY;
    const alpha = active ? 1 : 0.45;
    circle(bx, by, stickR, rgba(255, 255, 255, 26 * alpha));
    ring(bx, by, stickR, rgba(255, 255, 255, 90 * alpha), 3 * dp);
    if (isAim) ring(bx, by, stickR * AIM_DEADZONE, rgba(255, 255, 255, 40 * alpha), 1.5 * dp);
    let kx = bx, ky = by;
    if (active) {
      const m = mag(s);
      const f = m > 1 ? 1 / m : 1;
      kx = bx + s.vx * f * stickR;
      ky = by + s.vy * f * stickR;
    }
    const armed = isAim && active && mag(s) >= AIM_DEADZONE;
    if (armed) {
      const a = Math.atan2(s.vy, s.vx);
      const tipR = stickR * 1.32;
      ctx.fillStyle = playerColor;
      ctx.beginPath();
      ctx.moveTo(bx + Math.cos(a) * tipR, by + Math.sin(a) * tipR);
      ctx.lineTo(bx + Math.cos(a + 0.22) * stickR * 1.08, by + Math.sin(a + 0.22) * stickR * 1.08);
      ctx.lineTo(bx + Math.cos(a - 0.22) * stickR * 1.08, by + Math.sin(a - 0.22) * stickR * 1.08);
      ctx.closePath();
      ctx.fill();
    } else if (isAim && !active && playerIndex >= 0) {
      // where the turret last pointed
      const a = Math.atan2(state.aimY, state.aimX);
      circle(bx + Math.cos(a) * stickR * 0.78, by + Math.sin(a) * stickR * 0.78, 4 * dp, withAlpha(playerColor, 120));
    }
    const kr = stickR * 0.44;
    const base = isAim && active && s.armed && !armed && prefs.fireOnRelease ? 'rgb(140,136,150)' : playerColor;
    circle(kx, ky + 3 * dp, kr, withAlpha(darken(base, 0.35), 255 * alpha));
    circle(kx, ky, kr, withAlpha(base, 255 * alpha));
    circle(kx - kr * 0.25, ky - kr * 0.3, kr * 0.35, rgba(255, 255, 255, 60 * alpha));
    if (isAim) {
      ctx.strokeStyle = rgba(255, 255, 255, 200 * alpha);
      ctx.lineWidth = 2.5 * dp;
      ctx.beginPath();
      ctx.arc(kx, ky, kr * 0.42, 0, Math.PI * 2);
      ctx.stroke();
      line(kx - kr * 0.7, ky, kx - kr * 0.25, ky);
      line(kx + kr * 0.25, ky, kx + kr * 0.7, ky);
      line(kx, ky - kr * 0.7, kx, ky - kr * 0.25);
      line(kx, ky + kr * 0.25, kx, ky + kr * 0.7);
    }
  }

  function drawMineButton() {
    const pressed = minePointer !== -1;
    const r = (mineBtn.right - mineBtn.left) / 2;
    const cx = (mineBtn.left + mineBtn.right) / 2;
    const cy = (mineBtn.top + mineBtn.bottom) / 2;
    circle(cx, cy, r, rgba(255, 255, 255, pressed ? 90 : 40));
    ring(cx, cy, r, withAlpha(playerColor, 200), 3 * dp);
    circle(cx, cy - r * 0.12, r * 0.42, 'rgb(59,57,54)');
    circle(cx, cy - r * 0.12, r * 0.32, playerColor);
    circle(cx, cy - r * 0.12, r * 0.22, 'rgb(85,82,77)');
    circle(cx, cy - r * 0.12, r * 0.09, 'rgb(255,74,58)');
    font(900, 12 * dp);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fff';
    ctx.fillText('MINE', cx, cy + r * 0.62);
    const g = game;
    if (g && (g.state === P.STATE.PLAYING || g.state === P.STATE.COUNTDOWN)) {
      const bx = cx + r * 0.72, by = cy - r * 0.72;
      circle(bx, by, 11 * dp, g.minesLeft > 0 ? playerColor : 'gray');
      font(900, 13 * dp);
      ctx.fillStyle = '#fff';
      ctx.fillText(String(g.minesLeft), bx, by + 4.5 * dp);
    }
  }

  function frame(now) {
    if (dirty || needsAnimation) {
      dirty = false;
      needsAnimation = draw(now);
    }
    requestAnimationFrame(frame);
  }
  let needsAnimation = false;

  window.addEventListener('resize', layout);
  window.addEventListener('orientationchange', () => setTimeout(layout, 200));
  layout();
  connect();
  requestAnimationFrame(frame);
})();
