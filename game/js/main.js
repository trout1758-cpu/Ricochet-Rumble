// Ricochet Rumble — game flow: title, lobby, rounds, HUD, controller feedback.
(function () {
  const C = RR.CFG;
  const P = RR.PROTO;
  const U = RR.util;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const canvas = $('#game');
  const renderer = new RR.Renderer(canvas);
  const audio = new RR.Audio();
  RR.Input.init(canvas, renderer);

  const params = new URLSearchParams(location.search);
  const DEBUG = params.has('debug');

  // ---------------------------------------------------------------------------
  // Settings (remembered between visits)
  // ---------------------------------------------------------------------------
  const DEFAULTS = {
    mode: 'duel', powerups: true, bestStage: 0, bestWave: 0,
    hats: ['none', 'none'], unlocked: ['none'], totals: { powerups: 0, kills: 0 },
    wins: 5, arena: 'rotation', ammo: 'classic', mines: true, music: true, effects: true, replay: true,
    names: ['Player 1', 'Player 2'], colors: [0, 1],
  };
  const settings = loadSettings();

  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem('ricochet-rumble') || '{}');
      return Object.assign({}, DEFAULTS, s, {
        names: Array.isArray(s.names) ? s.names.slice(0, 2) : DEFAULTS.names.slice(),
        colors: Array.isArray(s.colors) ? s.colors.slice(0, 2) : DEFAULTS.colors.slice(),
        hats: Array.isArray(s.hats) ? s.hats.slice(0, 2) : DEFAULTS.hats.slice(),
        unlocked: Array.isArray(s.unlocked) ? s.unlocked.slice() : DEFAULTS.unlocked.slice(),
        totals: Object.assign({}, DEFAULTS.totals, s.totals || {}),
      });
    } catch (e) {
      return JSON.parse(JSON.stringify(DEFAULTS));
    }
  }

  function saveSettings() {
    try { localStorage.setItem('ricochet-rumble', JSON.stringify(settings)); } catch (e) { /* private mode */ }
  }

  // ---- hats and achievements ------------------------------------------------------
  function hatOf(i) {
    const h = settings.hats[i] || 'none';
    return settings.unlocked.includes(h) ? h : 'none';
  }

  function unlockHat(id) {
    if (settings.unlocked.includes(id)) return;
    settings.unlocked.push(id);
    saveSettings();
    const hat = C.HATS.find((h) => h.id === id);
    if (!hat) return;
    toast(`🎩 New hat unlocked: ${hat.name}! Pick it in the lobby.`, '#ffcd45', 6000);
    audio.powerup();
    if (typeof buildHatPickers === 'function') buildHatPickers();
  }

  function countTotal(key, n = 1) {
    settings.totals[key] = (settings.totals[key] || 0) + n;
    if (settings.totals.powerups >= 25) unlockHat('viking');
    if (settings.totals.kills >= 100) unlockHat('chef');
    saveSettings();
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const players = [0, 1].map((i) => ({
    index: i,
    name: settings.names[i] || `Player ${i + 1}`,
    colorIndex: U.clamp(settings.colors[i] | 0, 0, C.PLAYER_COLORS.length - 1),
    controller: null,
    wasConnected: false,
    ready: false,
    wins: 0,
    stats: null,
    edge: { fire: 0, mine: 0 },
    preview: { angle: 0, turret: 0, treadPhase: 0, recoil: 0 },
  }));
  if (players[0].colorIndex === players[1].colorIndex) players[1].colorIndex = (players[0].colorIndex + 1) % C.PLAYER_COLORS.length;

  const game = {
    state: 'title',   // title | lobby | intro | play | grace | result | over
    world: null,
    round: 0,
    timer: 0,
    acc: 0,
    paused: false,
    lastArena: -1,
    lobbyCountdown: 0,
    gamepadWait: null,
    qrWait: null,
    matchWinner: null,
    goShown: false,
    mineBlink: new Map(),
    resultsAt: 0,
    replay: new RR.Replay(),
    replayInputDelay: 0,
  };

  const colorOf = (i) => C.PLAYER_COLORS[players[i].colorIndex];
  const ammo = () => C.AMMO[settings.ammo] || C.AMMO.classic;

  // ---------------------------------------------------------------------------
  // UI helpers
  // ---------------------------------------------------------------------------
  function show(id, on) {
    $(id).classList.toggle('hidden', !on);
  }

  function toast(msg, color, ms = 3200) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    if (color) el.style.setProperty('--tc', color);
    $('#toasts').appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 320);
    }, ms);
  }

  function banner(main, sub, color) {
    const b = $('#banner');
    const m = $('.banner-main', b);
    m.textContent = main;
    $('.banner-sub', b).textContent = sub || '';
    b.style.setProperty('--bc', color || '#2a2230');
    // restart the pop animation
    m.style.animation = 'none';
    void m.offsetWidth;
    m.style.animation = '';
    show('#banner', true);
  }

  function hideBanner() {
    show('#banner', false);
  }

  function hudInset() {
    return Math.round(U.clamp(window.innerHeight * 0.08, 52, 88));
  }

  function applyPlayerColors() {
    players.forEach((p, i) => {
      const col = colorOf(i);
      document.documentElement.style.setProperty(`--p${i}`, col.body);
      const card = $(`.player-card[data-player="${i}"]`);
      card.style.setProperty('--pc', col.body);
      const hud = $(`.hud-player[data-player="${i}"]`);
      hud.style.setProperty('--pc', col.body);
      hud.style.setProperty('--pcd', col.dark);
    });
  }

  // ---------------------------------------------------------------------------
  // Background world (title + lobby show the arena behind the menus)
  // ---------------------------------------------------------------------------
  function previewArenaIndex() {
    if (settings.arena === 'rotation' || settings.arena === 'random') return 0;
    return U.clamp(Number(settings.arena) | 0, 0, RR.ARENA_DEFS.length - 1);
  }

  function setBackdropWorld(idx) {
    const w = new RR.World(RR.ARENA_DEFS[idx], { ammo: ammo(), minesEnabled: settings.mines, effects: settings.effects, colors: [colorOf(0), colorOf(1)] });
    game.world = w;
    renderer.setWorld(w);
  }

  // ---------------------------------------------------------------------------
  // Title
  // ---------------------------------------------------------------------------
  function goTitle() {
    game.state = 'title';
    show('#screen-title', true);
    show('#screen-lobby', false);
    show('#hud', false);
    setBackdropWorld(Math.floor(Math.random() * RR.ARENA_DEFS.length));
  }

  $('#btn-play').addEventListener('click', () => {
    audio.unlock();
    audio.click();
    goLobby();
  });

  window.addEventListener('keydown', (e) => {
    if (game.state === 'title' && (e.code === 'Enter' || e.code === 'Space')) {
      audio.unlock();
      goLobby();
    } else if (game.state === 'replay' && ['Escape', 'Space', 'Enter'].includes(e.code)) {
      endReplay();
    } else if (e.code === 'Escape') {
      if (!$('#screen-help').classList.contains('hidden')) show('#screen-help', false);
      else if (inMatch()) togglePause('');
    }
  });
  // Browsers only allow audio after a user gesture.
  window.addEventListener('pointerdown', () => audio.unlock(), { once: false });

  // ---------------------------------------------------------------------------
  // Lobby
  // ---------------------------------------------------------------------------
  function clearReplay() {
    game.replay.stop();
    renderer.replayMode = false;
    show('#replay-tag', false);
    document.body.classList.remove('letterbox');
  }

  function goLobby() {
    clearReplay();
    game.state = 'lobby';
    game.paused = false;
    game.lobbyCountdown = 0;
    players.forEach((p) => { p.ready = false; });
    show('#screen-title', false);
    show('#screen-lobby', true);
    show('#screen-pause', false);
    show('#screen-results', false);
    show('#hud', false);
    hideBanner();
    setBackdropWorld(previewArenaIndex());
    refreshLobby();
  }

  function buildHatPickers() {
    players.forEach((p, i) => {
      const box = $(`.player-card[data-player="${i}"] .hats`);
      if (!box) return;
      box.innerHTML = '';
      C.HATS.forEach((h) => {
        const b = document.createElement('button');
        const unlocked = settings.unlocked.includes(h.id);
        b.dataset.hat = h.id;
        b.title = unlocked ? h.name : `${h.name} (locked) · ${h.how}`;
        b.disabled = !unlocked;
        b.setAttribute('aria-checked', String(hatOf(i) === h.id));
        const cv = document.createElement('canvas');
        cv.width = 40; cv.height = 40;
        const ctx = cv.getContext('2d');
        if (h.id === 'none') {
          ctx.strokeStyle = '#b9aea0'; ctx.lineWidth = 3;
          ctx.beginPath(); ctx.arc(20, 20, 11, 0, Math.PI * 2); ctx.moveTo(12, 28); ctx.lineTo(28, 12); ctx.stroke();
        } else if (unlocked) {
          RR.drawHat(ctx, h.id, 20, 26, 30, 0.3);
        } else {
          ctx.fillStyle = '#b9aea0';
          ctx.font = '700 20px system-ui, sans-serif';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText('?', 20, 21);
        }
        b.appendChild(cv);
        b.addEventListener('click', () => {
          settings.hats[i] = h.id;
          saveSettings();
          audio.click();
          b.blur();
          buildHatPickers();
        });
        box.appendChild(b);
      });
    });
  }

  function buildLobby() {
    buildHatPickers();
    // Arena list
    const sel = $('#set-arena');
    sel.innerHTML = '';
    const add = (v, label) => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      sel.appendChild(o);
    };
    add('rotation', 'Rotation (all arenas)');
    add('random', 'Random');
    RR.ARENA_DEFS.forEach((d, i) => add(String(i), `${d.name} · ${RR.THEMES[d.theme].label}`));
    sel.value = settings.arena;
    sel.addEventListener('change', () => {
      settings.arena = sel.value;
      saveSettings();
      setBackdropWorld(previewArenaIndex());
      refreshLobby();
    });

    // Ammo options
    const ammoSeg = $('#set-ammo');
    Object.entries(C.AMMO).forEach(([k, a]) => {
      const b = document.createElement('button');
      b.dataset.v = k;
      b.textContent = a.label;
      b.title = a.desc;
      ammoSeg.appendChild(b);
    });

    const segs = {
      '#set-mode': (v) => {
        settings.mode = v;
        // the computer opponent is only for duels
        players.forEach((p, i) => { if (v !== 'duel' && p.controller && p.controller.kind === 'cpu') removeController(i, true); });
      },
      '#set-powerups': (v) => { settings.powerups = v === 'on'; },
      '#set-wins': (v) => { settings.wins = Number(v); },
      '#set-ammo': (v) => { settings.ammo = v; },
      '#set-mines': (v) => { settings.mines = v === 'on'; },
      '#set-music': (v) => { settings.music = v === 'on'; audio.setMusic(settings.music); },
      '#set-effects': (v) => { settings.effects = v === 'on'; setBackdropWorld(previewArenaIndex()); },
      '#set-replay': (v) => { settings.replay = v === 'on'; },
    };
    Object.entries(segs).forEach(([id, apply]) => {
      $(id).addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        apply(b.dataset.v);
        saveSettings();
        audio.click();
        b.blur();
        refreshLobby();
      });
    });

    players.forEach((p, i) => {
      const card = $(`.player-card[data-player="${i}"]`);
      const nameIn = $('.pname', card);
      nameIn.value = p.name;
      nameIn.addEventListener('input', () => {
        p.name = nameIn.value.trim() || `Player ${i + 1}`;
        settings.names[i] = p.name;
        saveSettings();
      });
      nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameIn.blur(); });

      const colors = $('.colors', card);
      C.PLAYER_COLORS.forEach((col, ci) => {
        const b = document.createElement('button');
        b.style.background = col.body;
        b.title = col.name;
        b.setAttribute('role', 'radio');
        b.dataset.ci = ci;
        b.addEventListener('click', () => {
          p.colorIndex = ci;
          settings.colors[i] = ci;
          saveSettings();
          audio.click();
          b.blur();
          if (p.controller && p.controller.assign) p.controller.assign(i, colorOf(i).rgb);
          applyPlayerColors();
          setBackdropWorld(previewArenaIndex());
          refreshLobby();
        });
        colors.appendChild(b);
      });

      const sel = $('.ctrl-select', card);
      sel.addEventListener('change', () => {
        audio.unlock();
        audio.click();
        sel.blur();
        if (sel.value === 'none') {
          if (game.qrWait && game.qrWait.player === i) game.qrWait = null;
          if (game.gamepadWait && game.gamepadWait.player === i) game.gamepadWait = null;
          removeController(i);
          refreshLobby();
        } else {
          chooseController(i, sel.value);
        }
      });
      $('.ready-btn', card).addEventListener('click', (e) => {
        e.currentTarget.blur();
        toggleReady(i);
      });
    });

    $('#btn-start').addEventListener('click', (e) => {
      e.currentTarget.blur();
      audio.click();
      startMatch();
    });
    $('#btn-help').addEventListener('click', () => show('#screen-help', true));
    $('#btn-help-close').addEventListener('click', () => show('#screen-help', false));

    const problem = RR.BLE.problem();
    $('#ble-note').textContent = problem ? 'Android app (Bluetooth) unavailable: ' + problem : '';

    players.forEach((p, i) => {
      const card = $(`.player-card[data-player="${i}"]`);
      $('.qr-cancel', card).addEventListener('click', (e) => {
        e.currentTarget.blur();
        game.qrWait = null;
        refreshLobby();
      });
      $('.qr-other', card).addEventListener('click', (e) => {
        e.currentTarget.blur();
        if (game.qrWait) game.qrWait.urlIndex++;
        refreshLobby();
      });
    });
    RR.Wifi.onNewPad = onWifiPad;
    RR.Wifi.onUrls = () => { if (game.qrWait) refreshLobby(); };
    RR.Wifi.start();
  }

  // A phone opened the Wi-Fi controller page (scanned a player's QR code, or
  // typed the address). Give it that player's tank if we can.
  function onWifiPad(ctl, slot) {
    let i = slot === '0' || slot === '1' ? Number(slot) : players.findIndex((p) => !p.controller);
    if (i < 0 && game.qrWait) i = game.qrWait.player;
    const current = i >= 0 ? players[i].controller : null;
    const busy = game.state !== 'lobby' && current && current.connected;
    const qrForThis = game.qrWait && game.qrWait.player === i;
    if (i < 0 || busy || (game.state === 'lobby' && slot === '' && current && !qrForThis)) {
      ctl.reject();
      toast('A phone tried to join, but both players already have controllers.', '#ff5a4a');
      return;
    }
    if (game.qrWait && game.qrWait.player === i) game.qrWait = null;
    assignController(i, ctl);
  }

  function drawQr(canvas, text) {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const ctx = canvas.getContext('2d');
    const cell = Math.floor(canvas.width / (n + 4));
    const off = Math.floor((canvas.width - cell * n) / 2);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#2a2230';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) ctx.fillRect(off + c * cell, off + r * cell, cell, cell);
      }
    }
  }

  function refreshQr(i, card) {
    const panel = $('.qr-panel', card);
    const waiting = !!(game.qrWait && game.qrWait.player === i);
    panel.classList.toggle('hidden', !waiting);
    $('.tank-preview', card).classList.toggle('hidden', waiting);
    if (!waiting) return;
    const urls = RR.Wifi.urls;
    const qrCanvas = $('canvas.qr', panel);
    const url = $('.qr-url', panel);
    $('.qr-other', panel).classList.toggle('hidden', urls.length < 2);
    if (!RR.Wifi.hubConnected) {
      qrCanvas.classList.add('hidden');
      url.textContent = 'Starting the Wi-Fi link… If this doesn’t go away, close the game and start it again with the start script.';
    } else if (!urls.length) {
      qrCanvas.classList.add('hidden');
      url.textContent = 'This computer isn’t on a network yet. Connect it to Wi-Fi (or a phone hotspot), then click the button again.';
    } else {
      const link = `${urls[game.qrWait.urlIndex % urls.length]}?slot=${i}`;
      qrCanvas.classList.remove('hidden');
      if (qrCanvas.dataset.url !== link) {
        qrCanvas.dataset.url = link;
        drawQr(qrCanvas, link);
      }
      url.textContent = link.replace(/^http:\/\//, '');
    }
  }

  function refreshLobby() {
    const campaign = settings.mode === 'campaign';
    const survival = settings.mode === 'survival';
    const coop = campaign || survival;
    $$('#set-mode button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === settings.mode)));
    $$('#set-powerups button').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.v === 'on') === settings.powerups)));
    $$('.duel-only').forEach((el) => el.classList.toggle('hidden', coop));
    $$('.no-campaign').forEach((el) => el.classList.toggle('hidden', campaign));
    $$('.campaign-only').forEach((el) => el.classList.toggle('hidden', !campaign));
    $$('.survival-only').forEach((el) => el.classList.toggle('hidden', !survival));
    $('#campaign-best').textContent = settings.bestStage > 0 ? `Best so far: stage ${settings.bestStage} of ${RR.Campaign.count}.` : '';
    $('#survival-best').textContent = settings.bestWave > 0 ? `Best so far: wave ${settings.bestWave}.` : '';
    $('.match-panel h2').textContent = campaign ? 'Co-op campaign' : survival ? 'Survival' : 'Match setup';
    $('#btn-start').textContent = campaign ? 'Start campaign' : survival ? 'Start survival' : 'Start match';
    $$('#set-wins button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.v) === settings.wins)));
    $$('#set-ammo button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === settings.ammo)));
    $$('#set-mines button').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.v === 'on') === settings.mines)));
    $$('#set-music button').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.v === 'on') === settings.music)));
    $$('#set-effects button').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.v === 'on') === settings.effects)));
    $$('#set-replay button').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.v === 'on') === settings.replay)));
    const mech = game.world && game.world.mechanic;
    $('#arena-effect').textContent = !settings.effects ? 'Arena effects are off.'
      : settings.arena === 'rotation' || settings.arena === 'random' ? 'Most themes have their own arena effect: ice, lava, black holes and more.'
        : mech ? `Arena effect: ${mech.name}. ${mech.desc}.` : 'No special arena effect here.';
    $('#set-arena').value = settings.arena;
    RR.drawArenaPreview($('#arena-preview'), RR.ARENA_DEFS[previewArenaIndex()], [colorOf(0), colorOf(1)]);

    players.forEach((p, i) => {
      const card = $(`.player-card[data-player="${i}"]`);
      const other = players[1 - i];
      $$('.colors button', card).forEach((b) => {
        const ci = Number(b.dataset.ci);
        b.setAttribute('aria-checked', String(ci === p.colorIndex));
        b.disabled = ci === other.colorIndex;
      });
      const ctl = p.controller;
      const icon = $('.ctrl-icon', card);
      const name = $('.ctrl-name', card);
      const detail = $('.ctrl-detail', card);
      icon.removeAttribute('data-state');
      if (game.gamepadWait && game.gamepadWait.player === i) {
        icon.dataset.kind = 'gamepad';
        icon.dataset.state = 'waiting';
        name.textContent = 'Press a button…';
        detail.textContent = 'on the gamepad you want to use';
      } else if (ctl) {
        icon.dataset.kind = ctl.kind;
        name.textContent = ctl.label;
        if ((ctl.kind === 'phone' || ctl.kind === 'wifi') && !ctl.connected) {
          icon.dataset.state = 'lost';
          detail.textContent = `${ctl.detail} — reconnecting…`;
        } else {
          detail.textContent = ctl.detail;
        }
      } else {
        icon.removeAttribute('data-kind');
        name.textContent = 'No controller';
        detail.textContent = 'Pick one below';
      }
      refreshQr(i, card);
      const sel = $('.ctrl-select', card);
      const showing = game.qrWait && game.qrWait.player === i ? 'wifi'
        : game.gamepadWait && game.gamepadWait.player === i ? 'gamepad'
          : ctl ? ctl.kind : 'none';
      if (document.activeElement !== sel) sel.value = showing;
      const rb = $('.ready-btn', card);
      rb.disabled = !ctl;
      rb.classList.toggle('is-ready', p.ready);
      rb.textContent = p.ready ? 'Ready!' : ctl ? 'Ready? (press fire)' : 'Ready';
    });

    const ok = canStart();
    $('#btn-start').disabled = !ok;
    let hint;
    if (!ok) hint = coop ? 'Give at least one player a controller.' : 'Give both players a controller (or make Player 2 the computer).';
    else if (game.lobbyCountdown > 0) hint = `Starting in ${Math.ceil(game.lobbyCountdown)}…`;
    else hint = coop && players.filter((p) => p.controller).length === 1 ? 'Solo run! Press fire, or click Start.' : 'Press fire on every controller, or click Start.';
    $('#start-hint').textContent = hint;
    $$('.ctrl-select option[value="cpu"]').forEach((o) => { o.hidden = coop; o.disabled = coop; });
  }

  // The computer opponent (duels only): the world drives this tank itself.
  function cpuController() {
    return {
      kind: 'cpu', label: 'Computer', detail: 'Banks shots off walls · lays mines', connected: true,
      read() { return null; }, rumble() {}, dispose() {},
    };
  }

  function canStart() {
    const humans = players.filter((p) => p.controller && p.controller.kind !== 'cpu');
    if (settings.mode !== 'duel') return humans.length >= 1;
    return players.every((p) => p.controller) && humans.length >= 1;
  }

  async function chooseController(i, src) {
    const other = players[1 - i];
    game.gamepadWait = null;
    game.qrWait = null;
    if (src === 'wifi') {
      if (!RR.Wifi.supported()) {
        toast('Wi-Fi phones need the game started with the start script (start-game.bat / start-game.sh).', '#ff5a4a', 6000);
        refreshLobby();
        return;
      }
      game.qrWait = { player: i, urlIndex: 0 };
      RR.Wifi.refreshUrls();
      refreshLobby();
    } else if (src === 'cpu') {
      assignController(i, cpuController());
      players[i].ready = true;
      refreshLobby();
    } else if (src === 'kbm' || src === 'arrows') {
      if (other.controller && other.controller.kind === src) removeController(1 - i, true);
      assignController(i, src === 'kbm' ? new RR.KeyboardMouseController() : new RR.KeyboardArrowsController());
    } else if (src === 'wiimote') {
      const problem = RR.Wiimote.problem();
      if (problem) {
        toast(problem, '#ff5a4a', 7000);
        return;
      }
      try {
        toast('Pick the Wii Remote (“Nintendo RVL-CNT-01”) in the list. Pair it in your computer’s Bluetooth settings first.', colorOf(i).body, 6000);
        assignController(i, await RR.Wiimote.connect());
      } catch (err) {
        if (err && err.name === 'NotFoundError') return; // picker closed
        console.error(err);
        toast('Could not use that Wii Remote: ' + (err && err.message ? err.message : err), '#ff5a4a', 6000);
      }
    } else if (src === 'gamepad') {
      game.gamepadWait = { player: i, until: performance.now() + 12000 };
      if (RR.Input.gamepads().length === 0) toast('Connect a gamepad, then press any of its buttons.', colorOf(i).body);
      refreshLobby();
    } else if (src === 'phone') {
      const problem = RR.BLE.problem();
      if (problem) {
        toast(problem, '#ff5a4a', 7000);
        return;
      }
      try {
        toast('Pick your phone in the browser’s Bluetooth list. (Open the controller app first.)', colorOf(i).body, 5000);
        const ctl = await RR.BLE.connect();
        if (other.controller && other.controller.kind === 'phone' && other.controller.device && other.controller.device.id === ctl.device.id) {
          removeController(1 - i, true);
        }
        assignController(i, ctl);
      } catch (err) {
        if (err && err.name === 'NotFoundError') return; // user closed the picker
        console.error(err);
        toast('Could not connect: ' + (err && err.message ? err.message : err), '#ff5a4a', 6000);
      }
    }
  }

  function assignController(i, ctl) {
    const p = players[i];
    if (p.controller && p.controller !== ctl) p.controller.dispose();
    p.controller = ctl;
    p.wasConnected = true;
    p.ready = false;
    if (ctl.assign) {
      ctl.onchange = () => onPhoneChange(i, ctl);
      ctl.onprofile = (profile) => onPhoneProfile(i, ctl, profile);
      ctl.onext = () => { if (game.state === 'lobby') refreshLobby(); };
      ctl.assign(i, colorOf(i).rgb);
    }
    ctl.rumble(150, 0.7);
    audio.connect();
    toast(ctl.kind === 'cpu' ? `${p.name} is the computer` : `${p.name}: ${ctl.label} ready${ctl.assign ? ' (' + ctl.detail + ')' : ''}`, colorOf(i).body);
    refreshLobby();
  }

  function removeController(i, silent) {
    const p = players[i];
    if (!p.controller) return;
    p.controller.dispose();
    p.controller = null;
    p.ready = false;
    if (!silent) audio.disconnect();
    refreshLobby();
  }

  function onPhoneChange(i, ctl) {
    if (players[i].controller !== ctl) return;
    const what = ctl.kind === 'wiimote' ? 'Wii Remote' : 'phone';
    if (ctl.connected) {
      toast(`${players[i].name}: ${what} reconnected`, colorOf(i).body);
      audio.connect();
    } else {
      toast(`${players[i].name}: ${what} disconnected — ${ctl.kind === 'wiimote' ? 'press a button on it to reconnect' : 'trying to reconnect'}…`, '#ff5a4a', 4500);
      audio.disconnect();
      if (inMatch() && !game.paused) togglePause(`${players[i].name}'s controller disconnected.`);
    }
    if (game.state === 'lobby') {
      if (!ctl.connected) players[i].ready = false;
      refreshLobby();
    }
  }

  function toggleReady(i) {
    const p = players[i];
    if (!p.controller) return;
    p.ready = !p.ready;
    if (p.ready) audio.countdown(); else audio.click();
    p.controller.rumble(p.ready ? 120 : 40, 0.6);
    const present = players.filter((q) => q.controller);
    if (!canStart() || !present.every((q) => q.ready)) game.lobbyCountdown = 0;
    else game.lobbyCountdown = 2.99;
    refreshLobby();
  }

  function updateLobby(dt, inputs) {
    // Gamepad assignment: the first button press on an unused pad wins.
    if (game.gamepadWait) {
      if (performance.now() > game.gamepadWait.until) {
        game.gamepadWait = null;
        refreshLobby();
      } else {
        const used = new Set(players.filter((p) => p.controller && p.controller.kind === 'gamepad').map((p) => p.controller.index));
        for (const pad of RR.Input.gamepads()) {
          if (used.has(pad.index)) continue;
          if (pad.buttons.some((b) => b.pressed)) {
            const i = game.gamepadWait.player;
            game.gamepadWait = null;
            assignController(i, new RR.GamepadController(pad));
            break;
          }
        }
      }
    }

    players.forEach((p, i) => {
      const inp = inputs[i];
      const pv = p.preview;
      pv.recoil = Math.max(0, pv.recoil - dt * 5);
      if (!inp) return;
      // Live controller test: the card's tank follows the sticks.
      const m = Math.hypot(inp.moveX, inp.moveY);
      if (m > 0.2) {
        const target = Math.atan2(inp.moveY, inp.moveX);
        pv.angle = U.approachAngle(pv.angle, target, C.TANK_TURN_RATE * dt);
        pv.treadPhase += m * C.TANK_SPEED * dt;
      }
      if (inp.aimMode === 'dir' && inp.aimActive) pv.turret = Math.atan2(inp.aimY, inp.aimX);
      else if (inp.aimMode === 'rotate') pv.turret += inp.rotate * C.TURRET_TURN_RATE * 0.3 * dt;
      else if (inp.aimMode === 'point') {
        const card = $(`.player-card[data-player="${i}"] .tank-preview canvas`);
        const r = card.getBoundingClientRect();
        const sx = inp.screenX != null ? inp.screenX : RR.Input.mouse.x, sy = inp.screenY != null ? inp.screenY : RR.Input.mouse.y;
        pv.turret = Math.atan2(sy - (r.top + r.height / 2), sx - (r.left + r.width / 2));
      }
      if (inp.fire > 0) {
        pv.recoil = 1;
        toggleReady(i);
      }
      if (inp.mine > 0) p.controller.rumble(40, 0.4);
    });

    if (game.lobbyCountdown > 0) {
      const before = Math.ceil(game.lobbyCountdown);
      game.lobbyCountdown -= dt;
      if (Math.ceil(game.lobbyCountdown) !== before) {
        refreshLobby();
        if (game.lobbyCountdown > 0) audio.countdown();
      }
      if (game.lobbyCountdown <= 0) startMatch();
    }
    drawPreviews();
  }

  function drawPreviews() {
    players.forEach((p, i) => {
      const cv = $(`.player-card[data-player="${i}"] .tank-preview canvas`);
      const ctx = cv.getContext('2d');
      ctx.clearRect(0, 0, cv.width, cv.height);
      const s = 74;
      const fake = { s, ox: cv.width / 2, oy: cv.height / 2 + 6 };
      ctx.fillStyle = 'rgba(0,0,0,0.12)';
      ctx.beginPath();
      ctx.ellipse(fake.ox + 6, fake.oy + 10, s * 0.55, s * 0.32, 0, 0, U.TAU);
      ctx.fill();
      const t = { x: 0, y: 0, angle: p.preview.angle, turret: p.preview.turret, color: colorOf(i), treadPhase: p.preview.treadPhase, recoil: p.preview.recoil, hat: hatOf(i) };
      RR.Renderer.prototype.drawTank.call(fake, ctx, t);
    });
  }

  // ---------------------------------------------------------------------------
  // Match flow
  // ---------------------------------------------------------------------------
  function newStats() {
    return { shots: 0, hits: 0, bounces: 0, mines: 0, selfKills: 0, deaths: 0, trick: 0, powerups: 0 };
  }

  function inMatch() {
    return ['intro', 'play', 'grace', 'replay', 'result'].includes(game.state);
  }

  function startMatch() {
    if (!canStart()) return;
    audio.unlock();
    clearReplay();
    game.lobbyCountdown = 0;
    game.qrWait = null;
    game.round = 0;
    game.lastArena = -1;
    game.matchWinner = null;
    players.forEach((p) => {
      p.wins = 0;
      p.ready = false;
      p.stats = newStats();
    });
    show('#screen-lobby', false);
    show('#screen-results', false);
    show('#screen-help', false);
    show('#hud', true);
    applyPlayerColors();
    buildHudPips();
    game.campaign = settings.mode === 'campaign'
      ? { stage: 1, lives: C.CAMPAIGN.LIVES, cleared: 0, retries: 0 }
      : null;
    game.survival = settings.mode === 'survival'
      ? { wave: 0, lives: C.SURVIVAL.LIVES, queue: [], respawns: [], spawnT: 0, breakT: 0, bannerT: 0, over: false }
      : null;
    document.body.classList.toggle('campaign', !!(game.campaign || game.survival));
    nextRound();
  }

  function worldOpts() {
    const cpu = {};
    players.forEach((p, i) => { if (p.controller && p.controller.kind === 'cpu') cpu[i] = 'rival'; });
    return {
      ammo: ammo(), minesEnabled: settings.mines, effects: settings.effects, colors: [colorOf(0), colorOf(1)],
      powerups: settings.powerups, cpu, hats: [hatOf(0), hatOf(1)],
    };
  }

  // ---- co-op campaign ------------------------------------------------------------
  function nextStage() {
    const cp = game.campaign;
    const st = RR.Campaign.stage(cp.stage);
    const absent = players.filter((p) => !p.controller).map((p) => p.index);
    const w = new RR.World(st.def, Object.assign(worldOpts(), {
      campaign: true, enemies: st.enemies, spawns: st.spawns, absent, cpu: {},
    }));
    w.frozen = true;
    game.world = w;
    game.acc = 0;
    game.mineBlink.clear();
    renderer.setWorld(w);
    game.state = 'intro';
    game.timer = C.ROUND_INTRO + 0.6;
    game.goShown = false;
    players.forEach((p) => { p.edge.fire = p.edge.mine = 0; });
    const foes = st.enemies.map((e) => C.ENEMIES[e.type].name);
    const counts = {};
    foes.forEach((n) => { counts[n] = (counts[n] || 0) + 1; });
    const lineup = Object.entries(counts).map(([n, k]) => (k > 1 ? `${k} ${n}s` : `1 ${n}`)).join(' · ');
    $('.hud-round').textContent = `Stage ${cp.stage}/${RR.Campaign.count}`;
    $('.hud-arena').textContent = `${st.def.name} · ${hearts(cp.lives)}`;
    banner(`Stage ${cp.stage}`, lineup);
    game.replay.reset();
    audio.roundStart();
  }

  function hearts(n) {
    return n > 0 ? '♥'.repeat(Math.min(n, 9)) : 'last chance';
  }

  function enemiesLeft() {
    return game.world.tanks.filter((t) => t.team === 1 && t.alive).length;
  }

  // ---- survival ------------------------------------------------------------------
  function startSurvival() {
    const n = RR.ARENA_DEFS.length;
    const idx = settings.arena === 'rotation' || settings.arena === 'random' ? Math.floor(Math.random() * n) : U.clamp(Number(settings.arena) | 0, 0, n - 1);
    const def = RR.ARENA_DEFS[idx];
    // both players start on the arena's player-1 side
    const spawns = RR.Campaign.spawnsFor(def);
    const absent = players.filter((p) => !p.controller).map((p) => p.index);
    const w = new RR.World(def, Object.assign(worldOpts(), { campaign: true, enemies: [], spawns, absent, cpu: {} }));
    w.frozen = true;
    game.world = w;
    game.acc = 0;
    game.mineBlink.clear();
    renderer.setWorld(w);
    game.state = 'intro';
    game.timer = C.ROUND_INTRO;
    game.goShown = false;
    players.forEach((p) => { p.edge.fire = p.edge.mine = 0; });
    $('.hud-round').textContent = 'Survival';
    banner('Survival', `${def.name} · how long can you last?`);
    game.replay.reset();
    audio.roundStart();
  }

  function nextWave() {
    const sv = game.survival;
    sv.wave++;
    sv.queue = RR.Survival.wave(sv.wave);
    sv.spawnT = 0.6;
    let sub = `${sv.queue.length} tank${sv.queue.length === 1 ? '' : 's'} incoming`;
    if (sv.wave > 1 && (sv.wave - 1) % C.SURVIVAL.BONUS_EVERY === 0) {
      sv.lives++;
      sub = 'Extra life! · ' + sub;
      audio.powerup();
    }
    if (sv.wave === 5) unlockHat('propeller');
    if (sv.wave > settings.bestWave) { settings.bestWave = sv.wave; saveSettings(); }
    banner(`Wave ${sv.wave}`, sub);
    sv.bannerT = 1.8;
    audio.roundStart();
  }

  function updateSurvival(dt) {
    const sv = game.survival, w = game.world;
    if (sv.bannerT > 0) { sv.bannerT -= dt; if (sv.bannerT <= 0) hideBanner(); }
    // knocked-out players come back while there are lives
    for (const r of sv.respawns) {
      r.t -= dt;
      if (r.t <= 0 && w.respawnPlayer(r.i)) { r.done = true; audio.connect(); rumble(r.i, 120, 0.5); }
    }
    sv.respawns = sv.respawns.filter((r) => !r.done);
    // feed in the wave a few at a time
    sv.spawnT -= dt;
    const alive = enemiesLeft();
    if (sv.queue.length && sv.spawnT <= 0 && alive < C.SURVIVAL.MAX_ALIVE) {
      if (w.spawnEnemy(sv.queue[0])) sv.queue.shift();
      sv.spawnT = C.SURVIVAL.SPAWN_GAP;
    }
    if (!sv.queue.length && alive === 0 && sv.wave > 0) {
      if (sv.breakT <= 0) {
        sv.breakT = C.SURVIVAL.WAVE_BREAK;
        banner(`Wave ${sv.wave} cleared!`, 'Get ready…', '#2a2230');
        sv.bannerT = C.SURVIVAL.WAVE_BREAK;
        audio.roundWin();
      }
      sv.breakT -= dt;
      if (sv.breakT <= 0) nextWave();
    }
    // nobody left and no lives to come back with
    const playersAlive = w.tanks.some((t) => t.team === 0 && t.alive);
    if (!playersAlive && !sv.respawns.length) {
      sv.over = true;
      game.state = 'grace';
      game.timer = C.ROUND_GRACE;
    }
  }

  function onSurvivalDeath(i) {
    const sv = game.survival;
    if (sv.lives > 0) {
      sv.lives--;
      sv.respawns.push({ i, t: C.SURVIVAL.RESPAWN });
    }
  }

  function finishSurvival() {
    game.state = 'over';
    hideBanner();
    const sv = game.survival;
    const panel = $('#screen-results .results');
    $('.winner', panel).textContent = `Survived to wave ${sv.wave}`;
    $('.winner', panel).style.color = '#2a2230';
    $('.final-score', panel).textContent = sv.wave >= settings.bestWave ? 'New best!' : `Best: wave ${settings.bestWave}`;
    const team = players.filter((p) => p.controller);
    const rows = [
      ['Tanks destroyed', (p) => p.stats.hits],
      ['Shells fired', (p) => p.stats.shots],
      ['Ricochets', (p) => p.stats.bounces],
      ['Trick shots', (p) => p.stats.trick],
      ['Power-ups', (p) => p.stats.powerups],
      ['Times knocked out', (p) => p.stats.deaths],
    ];
    const head = `<thead><tr><th></th>${team.map((p) => `<th style="color:${colorOf(p.index).dark}">${escapeHtml(p.name)}</th>`).join('')}</tr></thead>`;
    const body = rows.map(([label, f]) => `<tr><th>${label}</th>${team.map((p) => `<td>${f(p)}</td>`).join('')}</tr>`).join('');
    $('.stats', panel).innerHTML = head + '<tbody>' + body + '</tbody>';
    show('#screen-results', true);
    game.resultsAt = performance.now();
    audio.matchWin();
    players.forEach((p, i) => rumble(i, 400, 0.8));
  }

  function resolveStage() {
    const cp = game.campaign;
    const cleared = enemiesLeft() === 0 && game.world.tanks.some((t) => t.team === 0 && t.alive);
    game.state = 'result';
    game.timer = C.ROUND_RESULT;
    if (cleared) {
      cp.cleared = cp.stage;
      if (cp.stage >= 5) unlockHat('cowboy');
      if (cp.stage >= RR.Campaign.count) unlockHat('crown');
      settings.bestStage = Math.max(settings.bestStage, cp.stage);
      saveSettings();
      if (cp.stage >= RR.Campaign.count) {
        game.campaignOver = 'won';
        banner('Campaign complete!', 'Every tank destroyed', '#2a2230');
        audio.matchWin();
        return;
      }
      let sub = `On to stage ${cp.stage + 1}`;
      if (cp.stage % C.CAMPAIGN.BONUS_EVERY === 0) {
        cp.lives++;
        sub = 'Extra life! ' + hearts(cp.lives);
        audio.powerup();
      }
      banner('Stage clear!', sub, '#2a2230');
      audio.roundWin();
      players.forEach((p, i) => rumble(i, 160, 0.6));
      cp.stage++;
    } else {
      cp.lives--;
      if (cp.lives < 0) {
        game.campaignOver = 'lost';
        banner('Game over', `You reached stage ${cp.stage}`, '#2a2230');
        audio.roundDraw();
        return;
      }
      banner('Tank down!', `Try stage ${cp.stage} again · ${hearts(cp.lives)}`, '#2a2230');
      audio.roundDraw();
    }
  }

  function finishCampaign() {
    game.state = 'over';
    hideBanner();
    const cp = game.campaign;
    const won = game.campaignOver === 'won';
    const panel = $('#screen-results .results');
    $('.winner', panel).textContent = won ? 'Campaign complete!' : 'Game over';
    $('.winner', panel).style.color = won ? '#b07e10' : '#2a2230';
    $('.final-score', panel).textContent = won ? `All ${RR.Campaign.count} stages cleared` : `Stages cleared: ${cp.cleared} of ${RR.Campaign.count}`;
    const team = players.filter((p) => p.controller);
    const rows = [
      ['Tanks destroyed', (p) => p.stats.hits],
      ['Shells fired', (p) => p.stats.shots],
      ['Ricochets', (p) => p.stats.bounces],
      ['Trick shots', (p) => p.stats.trick],
      ['Power-ups', (p) => p.stats.powerups],
      ['Times knocked out', (p) => p.stats.deaths],
    ];
    const head = `<thead><tr><th></th>${team.map((p) => `<th style="color:${colorOf(p.index).dark}">${escapeHtml(p.name)}</th>`).join('')}</tr></thead>`;
    const body = rows.map(([label, f]) => `<tr><th>${label}</th>${team.map((p) => `<td>${f(p)}</td>`).join('')}</tr>`).join('');
    $('.stats', panel).innerHTML = head + '<tbody>' + body + '</tbody>';
    show('#screen-results', true);
    game.resultsAt = performance.now();
    if (won) audio.matchWin();
    players.forEach((p, i) => rumble(i, 400, 0.8));
  }

  function pickArena() {
    const n = RR.ARENA_DEFS.length;
    if (settings.arena === 'rotation') return (game.round - 1) % n;
    if (settings.arena === 'random') {
      let idx;
      do { idx = Math.floor(Math.random() * n); } while (n > 1 && idx === game.lastArena);
      return idx;
    }
    return U.clamp(Number(settings.arena) | 0, 0, n - 1);
  }

  function nextRound() {
    if (game.survival) {
      startSurvival();
      return;
    }
    if (game.campaign) {
      game.campaignOver = null;
      nextStage();
      return;
    }
    game.round++;
    const idx = pickArena();
    game.lastArena = idx;
    const def = RR.ARENA_DEFS[idx];
    const w = new RR.World(def, worldOpts());
    w.frozen = true;
    game.world = w;
    game.acc = 0;
    game.mineBlink.clear();
    renderer.setWorld(w);
    game.state = 'intro';
    game.timer = C.ROUND_INTRO;
    game.goShown = false;
    players.forEach((p) => { p.edge.fire = p.edge.mine = 0; });
    $('.hud-round').textContent = `Round ${game.round}`;
    const arenaLabel = w.mechanic ? `${def.name} · ${w.mechanic.name}` : def.name;
    $('.hud-arena').textContent = arenaLabel;
    banner(`Round ${game.round}`, arenaLabel);
    game.replay.reset();
    audio.roundStart();
  }

  function resolveRound() {
    if (game.survival) {
      game.state = 'result';
      game.timer = 1.6;
      banner('Game over', `You reached wave ${game.survival.wave}`, '#2a2230');
      audio.roundDraw();
      return;
    }
    if (game.campaign) {
      resolveStage();
      return;
    }
    const alive = game.world.aliveTanks();
    let winner = null;
    if (alive.length === 1) {
      winner = alive[0].index;
      players[winner].wins++;
      const col = colorOf(winner);
      banner(`${players[winner].name} scores!`, `${players[0].wins} – ${players[1].wins}`, col.dark);
      audio.roundWin();
      rumble(winner, 160, 0.6);
    } else {
      banner('Draw!', 'Nobody scores', '#2a2230');
      audio.roundDraw();
    }
    game.state = 'result';
    game.timer = C.ROUND_RESULT;
    const champ = players.find((p) => p.wins >= settings.wins);
    game.matchWinner = champ ? champ.index : null;
  }

  function finishMatch() {
    game.state = 'over';
    hideBanner();
    const w = game.matchWinner;
    const loser = players[1 - w];
    if (loser.controller && loser.controller.kind === 'cpu' && players[w].controller && players[w].controller.kind !== 'cpu') unlockHat('tophat');
    const col = colorOf(w);
    const panel = $('#screen-results .results');
    $('.winner', panel).textContent = `${players[w].name} wins!`;
    $('.winner', panel).style.color = col.dark;
    $('.final-score', panel).textContent = `${players[0].wins} – ${players[1].wins}`;
    const rows = [
      ['Rounds won', (p) => p.wins],
      ['Shells fired', (p) => p.stats.shots],
      ['Ricochets', (p) => p.stats.bounces],
      ['Enemy hits', (p) => p.stats.hits],
      ['Mines laid', (p) => p.stats.mines],
      ['Trick shots', (p) => p.stats.trick],
      ['Own goals', (p) => p.stats.selfKills],
    ];
    const head = `<thead><tr><th></th>${players.map((p, i) => `<th style="color:${colorOf(i).dark}">${escapeHtml(p.name)}</th>`).join('')}</tr></thead>`;
    const body = rows.map(([label, f]) => `<tr><th>${label}</th>${players.map((p) => `<td>${f(p)}</td>`).join('')}</tr>`).join('');
    $('.stats', panel).innerHTML = head + '<tbody>' + body + '</tbody>';
    show('#screen-results', true);
    game.resultsAt = performance.now();
    audio.matchWin();
    rumble(w, 500, 0.8);
  }

  $('#btn-rematch').addEventListener('click', () => { audio.click(); startMatch(); });
  $('#btn-lobby').addEventListener('click', () => { audio.click(); goLobby(); });
  $('#btn-resume').addEventListener('click', () => { audio.click(); togglePause(); });
  $('#btn-quit').addEventListener('click', () => { audio.click(); goLobby(); });

  function togglePause(reason) {
    if (!inMatch()) return;
    game.paused = !game.paused;
    $('#screen-pause .pause-reason').textContent = reason || '';
    show('#screen-pause', game.paused);
    refreshReconnectButtons();
    audio.click();
  }

  // While paused, offer to re-pair any phone that dropped out (Android may
  // come back with a new Bluetooth address, which needs a fresh pick).
  function refreshReconnectButtons() {
    $$('#screen-pause [data-reconnect]').forEach((b) => {
      const p = players[Number(b.dataset.reconnect)];
      b.textContent = `Re-pair ${p.name}’s phone`;
      b.classList.toggle('hidden', !(game.paused && p.controller && p.controller.kind === 'phone' && !p.controller.connected));
    });
  }

  $$('#screen-pause [data-reconnect]').forEach((b) => {
    b.addEventListener('click', async () => {
      b.blur();
      await chooseController(Number(b.dataset.reconnect), 'phone');
      refreshReconnectButtons();
    });
  });

  function rumble(i, ms, strength) {
    const c = players[i] && players[i].controller;
    if (c) c.rumble(ms, strength);
  }

  function handleWorldEvents(events) {
    const w = game.world;
    for (const ev of events) {
      renderer.onEvent(ev);
      switch (ev.type) {
        case 'fire':
          audio.fire();
          if (players[ev.player]) players[ev.player].stats.shots++;
          rumble(ev.player, 30, 0.35);
          break;
        case 'bounce':
          audio.bounce();
          if (players[ev.owner]) players[ev.owner].stats.bounces++;
          break;
        case 'powerup': {
          const d = C.POWERUPS[ev.kind];
          audio.powerup();
          if (players[ev.player]) { players[ev.player].stats.powerups++; countTotal('powerups'); }
          rumble(ev.player, 90, 0.6);
          renderer.callout(d.name.toUpperCase() + '!', ev.x, ev.y, d.color, false);
          break;
        }
        case 'teleport':
          audio.teleport();
          break;
        case 'gates':
          audio.gate();
          break;
        case 'lightning':
          audio.thunder();
          break;
        case 'gust':
          audio.gust();
          break;
        case 'shieldPop':
          audio.shieldPop();
          rumble(ev.player, 200, 0.9);
          renderer.callout('BLOCKED!', ev.x, ev.y, C.POWERUPS.shield.color, false);
          break;
        case 'shellGone':
          if (ev.reason === 'wall' || ev.reason === 'shell') audio.puff();
          break;
        case 'fizzle':
          audio.puff();
          rumble(ev.player, 30, 0.3);
          break;
        case 'shellClash':
          audio.clash();
          calloutFor(ev, true);
          break;
        case 'eruption':
          audio.erupt();
          break;
        case 'swallow':
          audio.swallow();
          break;
        case 'crateRegrow':
          audio.regrow();
          break;
        case 'dry':
          audio.dry();
          rumble(ev.player, 15, 0.2);
          break;
        case 'mineLay':
          audio.mineLay();
          if (players[ev.player]) players[ev.player].stats.mines++;
          rumble(ev.player, 45, 0.5);
          break;
        case 'mineTrigger':
          audio.mineBeep(true);
          break;
        case 'explosion':
          audio.explosion(true);
          w.tanks.forEach((t) => {
            if (t.alive && Math.hypot(t.x - ev.x, t.y - ev.y) < 4) rumble(t.index, 110, 0.6);
          });
          break;
        case 'crateDestroyed':
          audio.crate();
          break;
        case 'tankDestroyed':
          audio.explosion(false);
          if (players[ev.player]) players[ev.player].stats.deaths++;
          if (ev.by === ev.player) { if (players[ev.player]) players[ev.player].stats.selfKills++; }
          else if (ev.by != null && players[ev.by] && w.tanks[ev.player].team !== w.tanks[ev.by].team) {
            players[ev.by].stats.hits++;
            if (w.tanks[ev.player].ai) countTotal('kills');
          }
          if (game.survival && ev.player < 2 && game.state === 'play') onSurvivalDeath(ev.player);
          rumble(ev.player, 450, 1);
          if (ev.by != null && ev.by !== ev.player) rumble(ev.by, 120, 0.7);
          calloutFor(ev, true);
          break;
      }
    }
  }

  // Big on-screen shout for special kills. `count` adds to match stats (not
  // when the moment is being shown again in a replay).
  function calloutFor(ev, count) {
    let text = null, color = '#ffcd45', big = false, trick = false;
    if (ev.type === 'shellClash') {
      if (ev.owners && ev.owners[0] !== ev.owners[1]) {
        text = 'INTERCEPTED!';
        color = '#ffffff';
      }
    } else if (ev.type === 'tankDestroyed') {
      const wt = game.world && game.world.tanks;
      const shooter = ev.by != null && wt && wt[ev.by] ? wt[ev.by].color.light : '#ffcd45';
      const friendly = wt && ev.by != null && ev.by !== ev.player && wt[ev.by] && wt[ev.player] && wt[ev.by].team === wt[ev.player].team;
      if (ev.cause === 'eruption') { text = 'ROASTED!'; color = '#ff8a3a'; }
      else if (ev.by === ev.player) { text = 'OWN GOAL!'; color = '#ff7b5c'; }
      else if (friendly) { text = 'FRIENDLY FIRE!'; color = '#ff7b5c'; }
      else if (ev.cause === 'mine') { text = 'KABOOM!'; color = shooter; }
      else if (ev.cause === 'shell') {
        if (ev.warped) { text = 'PORTAL SHOT!'; color = '#3be8ff'; big = true; trick = true; }
        else if (ev.bent > 0.35 && game.world && game.world.mechKey === 'sky') { if (ev.bent > 0.7) { text = 'WIND ASSIST!'; color = '#ffffff'; big = true; trick = true; } }
        else if (ev.bent > 0.35) { text = 'GRAVITY ASSIST!'; color = '#c9b0ff'; big = true; trick = true; }
        else if (ev.bounces >= 3) { text = 'INCREDIBLE!'; color = shooter; big = true; trick = true; }
        else if (ev.bounces === 2) { text = 'TRICK SHOT!'; color = shooter; big = true; trick = true; }
        else if (ev.bounces === 1) { text = 'BANK SHOT!'; color = shooter; trick = true; }
      }
      if (count && trick && ev.by != null && players[ev.by]) {
        players[ev.by].stats.trick++;
        unlockHat('party');
      }
    }
    if (!text) return;
    renderer.callout(text, ev.x, ev.y, color, big);
    audio.callout(big);
  }

  // ---------------------------------------------------------------------------
  // Instant replay
  // ---------------------------------------------------------------------------
  function startReplayOrResolve() {
    const r = game.replay;
    const failed = (game.campaign && enemiesLeft() > 0) || !!game.survival;
    const kill = settings.replay && !failed ? r.lastKill() : null;
    const proxy = kill && r.start(game.world, kill.time - C.REPLAY_BEFORE, kill.time + C.REPLAY_AFTER);
    if (!proxy) {
      resolveRound();
      return;
    }
    game.state = 'replay';
    game.replayFocus = renderer.worldToCanvas(kill.x, kill.y);
    game.replayInputDelay = 0.5;
    renderer.fx.clear();
    renderer.callouts = [];
    renderer.replayMode = true;
    renderer.world = proxy;
    show('#replay-tag', true);
    document.body.classList.add('letterbox');
  }

  function updateReplay(dt, inputs) {
    if (game.paused) return;
    const r = game.replay;
    game.replayInputDelay -= dt;
    if (game.replayInputDelay <= 0 && inputs.some((inp) => inp && (inp.fire > 0 || inp.pause > 0))) {
      endReplay();
      return;
    }
    for (const ev of r.advance(dt * C.REPLAY_SPEED)) {
      renderer.onEvent(ev);
      if (ev.type === 'fire') audio.fire();
      else if (ev.type === 'bounce') audio.bounce();
      else if (ev.type === 'explosion') audio.explosion(true);
      else if (ev.type === 'tankDestroyed') audio.explosion(false);
      if (ev.type === 'tankDestroyed' || ev.type === 'shellClash') calloutFor(ev, false);
    }
    if (r.done) endReplay();
  }

  function replayCamera() {
    const p = game.replay.progress;
    const zoomIn = Math.min(1, p / 0.35);
    const zoomOut = p > 0.85 ? (p - 0.85) / 0.15 : 0;
    const k = (zoomIn * zoomIn * (3 - 2 * zoomIn)) * (1 - zoomOut);
    const W = renderer.W, H = renderer.H;
    const z = 1 + 0.5 * k;
    // keep the zoomed view inside the screen
    const hw = W / (2 * z), hh = H / (2 * z);
    return {
      z,
      fx: U.clamp(U.lerp(W / 2, game.replayFocus.x, k), hw, W - hw),
      fy: U.clamp(U.lerp(H / 2, game.replayFocus.y, k), hh, H - hh),
    };
  }

  function endReplay() {
    if (game.state !== 'replay') return;
    game.replay.stop();
    renderer.replayMode = false;
    renderer.world = game.world;
    renderer.fx.clear();
    renderer.callouts = [];
    show('#replay-tag', false);
    document.body.classList.remove('letterbox');
    resolveRound();
  }

  // ---------------------------------------------------------------------------
  // Names and colours set from a phone in the lobby
  // ---------------------------------------------------------------------------
  function onPhoneProfile(i, ctl, profile) {
    const p = players[i];
    if (game.state !== 'lobby' || p.controller !== ctl) return;
    const name = String(profile.name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 12);
    if (name) {
      p.name = name;
      settings.names[i] = name;
      $(`.player-card[data-player="${i}"] .pname`).value = name;
    }
    const ci = profile.color;
    if (ci < C.PLAYER_COLORS.length && ci !== players[1 - i].colorIndex && ci !== p.colorIndex) {
      p.colorIndex = ci;
      settings.colors[i] = ci;
      ctl.assign(i, colorOf(i).rgb);
      applyPlayerColors();
      setBackdropWorld(previewArenaIndex());
    }
    saveSettings();
    audio.click();
    refreshLobby();
  }

  function mineBeeps() {
    const w = game.world;
    const live = new Set();
    for (const m of w.mines) {
      live.add(m.id);
      if (!m.armed || (!m.triggered && m.fuse > 3)) continue;
      const period = m.triggered ? 0.1 : m.fuse < 1.5 ? 0.2 : 0.5;
      const k = Math.floor(m.age / period);
      if (game.mineBlink.get(m.id) !== k) {
        game.mineBlink.set(m.id, k);
        if (k % 2 === 0 && !m.triggered) audio.mineBeep(m.fuse < 1.5);
      }
    }
    for (const id of game.mineBlink.keys()) if (!live.has(id)) game.mineBlink.delete(id);
  }

  function updateMatch(dt, inputs) {
    if (inputs.some((inp) => inp && inp.pause > 0)) togglePause('');

    // Pause automatically if a controller drops out.
    players.forEach((p) => {
      const ok = !!(p.controller && p.controller.connected);
      if (p.wasConnected && !ok && !game.paused && game.state !== 'result') {
        togglePause(`${p.name}'s controller disconnected.`);
      }
      p.wasConnected = ok;
    });
    if (game.paused) return;

    const w = game.world;
    players.forEach((p, i) => {
      if (inputs[i]) {
        p.edge.fire += inputs[i].fire;
        p.edge.mine += inputs[i].mine;
      }
    });

    if (game.state !== 'result') {
      const step = 1 / C.SIM_HZ;
      game.acc = Math.min(game.acc + dt, 0.25);
      while (game.acc >= step) {
        const frames = inputs.map((inp, i) => {
          const base = inp || RR.NO_INPUT;
          const f = Object.assign({}, base, { fire: players[i].edge.fire, mine: players[i].edge.mine });
          players[i].edge.fire = players[i].edge.mine = 0;
          return f;
        });
        w.update(step, frames);
        game.acc -= step;
      }
      const events = w.drainEvents();
      handleWorldEvents(events);
      if (game.state !== 'intro') game.replay.capture(w, events);
      mineBeeps();
    }

    game.timer -= dt;
    switch (game.state) {
      case 'intro':
        if (game.timer <= 0.65 && !game.goShown) {
          game.goShown = true;
          banner('GO!', '', '#2a2230');
          audio.go();
        }
        if (game.timer <= 0) {
          game.state = 'play';
          w.frozen = false;
          game.timer = 0.5;
          players.forEach((p) => { p.edge.fire = p.edge.mine = 0; });
        }
        break;
      case 'play':
        if (game.timer <= 0 && game.goShown) {
          game.goShown = false;
          hideBanner();
        }
        if (game.survival) {
          if (game.goShown === false && game.survival.wave === 0) nextWave();
          updateSurvival(dt);
        } else if (w.aliveTeams().size < 2) {
          game.state = 'grace';
          game.timer = C.ROUND_GRACE;
          hideBanner();
        }
        break;
      case 'grace':
        if (game.timer <= 0) startReplayOrResolve();
        break;
      case 'result':
        if (game.timer <= 0) {
          if (game.survival) finishSurvival();
          else if (game.campaign && game.campaignOver) finishCampaign();
          else if (!game.campaign && game.matchWinner != null) finishMatch();
          else nextRound();
        }
        break;
    }
  }

  function updateOver(inputs) {
    // Either controller's fire button starts a rematch (after a short delay
    // so a celebratory button-mash doesn't skip the results).
    if (performance.now() - game.resultsAt > 2000 && inputs.some((inp) => inp && inp.fire > 0)) startMatch();
  }

  // ---------------------------------------------------------------------------
  // HUD
  // ---------------------------------------------------------------------------
  const hudCache = ['', ''];

  function buildHudPips() {
    hudCache[0] = hudCache[1] = '';
  }

  function updateHud() {
    if (!inMatch() && game.state !== 'over') return;
    const w = game.world;
    if (game.survival && w) {
      const sv = game.survival;
      const txt = `${w.arena.name} · Wave ${sv.wave} · ${hearts(sv.lives)} · ${enemiesLeft() + sv.queue.length} left`;
      const el = $('.hud-arena');
      if (el.textContent !== txt) el.textContent = txt;
    }
    if (game.campaign && w) {
      const txt = `${w.arena.name} · ${hearts(game.campaign.lives)} · ${enemiesLeft()} left`;
      const el = $('.hud-arena');
      if (el.textContent !== txt) el.textContent = txt;
    }
    players.forEach((p, i) => {
      const shells = w.shellsLeft(i);
      const mines = w.minesLeft(i);
      const ok = !!(p.controller && p.controller.connected);
      const t = w.tanks[i];
      const maxShells = t ? t.maxShells() : w.ammo.max;
      const kills = p.stats ? p.stats.hits : 0;
      const cpu = !!(p.controller && p.controller.kind === 'cpu');
      const powers = t ? ['shield', 'boost', 'spread', 'bouncy', 'rapid'].filter((k) => (k === 'shield' ? t.shield : t[k] > 0)) : [];
      const absent = !!(t && t.absent);
      const coop = !!(game.campaign || game.survival);
      const key = [p.name, p.wins, settings.wins, shells, mines, ok, maxShells, w.minesEnabled, kills, coop, powers.join(), absent].join('|');
      if (key === hudCache[i]) return;
      hudCache[i] = key;
      const el = $(`.hud-player[data-player="${i}"]`);
      el.classList.toggle('absent', absent);
      $('.hud-name', el).textContent = cpu ? 'Computer' : p.name;
      $('.hud-wins', el).innerHTML = coop
        ? `<b class="hud-kills">${kills} <small>tank${kills === 1 ? '' : 's'}</small></b>`
        : Array.from({ length: settings.wins }, (_, k) => `<i class="${k < p.wins ? 'on' : ''}"></i>`).join('');
      const PU = { shield: 'shield', boost: 'speed', spread: 'spread', bouncy: 'bouncy', rapid: 'rapid' };
      $('.hud-shells', el).innerHTML = Array.from({ length: maxShells }, (_, k) => `<i class="${k < shells ? '' : 'used'}"></i>`).join('')
        + powers.map((k) => `<em class="pu" style="--pu:${C.POWERUPS[PU[k]].color}" title="${C.POWERUPS[PU[k]].name}"></em>`).join('');
      $('.hud-mines', el).innerHTML = w.minesEnabled ? Array.from({ length: C.MINE_MAX }, (_, k) => `<i class="${k < mines ? '' : 'used'}"></i>`).join('') : '';
      $('.hud-link', el).classList.toggle('lost', !ok && !cpu);
    });
  }

  // Keep each phone's screen in sync (score, ammo, game state).
  function syncPhones() {
    players.forEach((p, i) => {
      const c = p.controller;
      if (!c || !c.status || !c.connected) return;
      let state = P.STATE.LOBBY;
      if (game.paused) state = P.STATE.PAUSED;
      else if (game.state === 'intro') state = P.STATE.COUNTDOWN;
      else if (game.state === 'play' || game.state === 'grace') state = P.STATE.PLAYING;
      else if (game.state === 'result' || game.state === 'replay') state = P.STATE.ROUND_OVER;
      else if (game.state === 'over') state = P.STATE.MATCH_OVER;
      const w = game.world;
      const live = inMatch() && w;
      c.status(
        state, p.wins, players[1 - i].wins, settings.wins,
        live ? w.shellsLeft(i) : ammo().max,
        live ? w.minesLeft(i) : (settings.mines ? C.MINE_MAX : 0),
        p.ready,
        ammo().max,
      );
      if (c.lobby) c.lobby(p.colorIndex, players[1 - i].colorIndex, p.name);
    });
  }

  // ---------------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------------
  let last = performance.now();
  let fpsAcc = 0, fpsFrames = 0;

  function readInputs() {
    return players.map((p) => (p.controller ? p.controller.read() : null));
  }

  function frame(now) {
    const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    const inputs = readInputs();

    switch (game.state) {
      case 'title':
        if (game.world) {
          game.world.tanks.forEach((t, i) => { t.turret += dt * (i ? -0.5 : 0.5); });
        }
        break;
      case 'lobby':
        updateLobby(dt, inputs);
        break;
      case 'over':
        updateOver(inputs);
        break;
      case 'replay':
        updateReplay(dt, inputs);
        break;
      default:
        updateMatch(dt, inputs);
    }

    const view = { labels: game.state === 'intro', aims: [] };
    if (game.state === 'replay') view.camera = replayCamera();
    else if (inMatch() && game.world) {
      inputs.forEach((inp, i) => {
        if (!inp) return;
        if (inp.aimMode === 'point') view.aims[i] = { show: true, mode: 'point', x: inp.aimX, y: inp.aimY };
        else if (inp.aimMode === 'dir' && inp.aimActive) view.aims[i] = { show: true, mode: 'dir' };
      });
    }
    renderer.render(game.paused ? 0 : dt, view);
    // Wii Remote pointers act as cursors in menus (A clicks)
    const menus = game.state === 'lobby' || game.state === 'over' || game.state === 'title' || game.paused;
    RR.Wiimote.updatePointers(players, inputs, menus, colorOf);
    if (game.paused) refreshReconnectButtons();
    updateHud();
    syncPhones();

    if (DEBUG) {
      fpsAcc += dt; fpsFrames++;
      if (fpsAcc > 0.5) {
        $('#fps').textContent = `${Math.round(fpsFrames / fpsAcc)} fps · ${renderer.fx.p.length} particles`;
        fpsAcc = 0; fpsFrames = 0;
      }
    }
    requestAnimationFrame(frame);
  }

  function onResize() {
    renderer.resize(hudInset());
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && inMatch() && !game.paused) togglePause('');
  });
  window.addEventListener('gamepadconnected', (e) => toast(`Gamepad connected: ${e.gamepad.id.replace(/\(.*?\)/g, '').trim()}`));
  window.addEventListener('gamepaddisconnected', () => toast('Gamepad disconnected', '#ff5a4a'));
  window.addEventListener('resize', onResize);

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  audio.musicOn = settings.music;
  applyPlayerColors();
  buildLobby();
  onResize();
  goTitle();
  if (DEBUG) show('#fps', true);
  requestAnimationFrame(frame);

  // Exposed for debugging and automated tests.
  RR.game = { game, players, settings, renderer, audio, startMatch, goLobby, assignController, togglePause, chooseController, refreshLobby, nextRound };
})();
