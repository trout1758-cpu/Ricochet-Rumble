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
    hats: ['none', 'none', 'none', 'none'], unlocked: ['none'], totals: { powerups: 0, kills: 0 },
    wins: 5, arena: 'rotation', ammo: 'classic', mines: true, music: true, effects: true, replay: true,
    names: ['Player 1', 'Player 2', 'Player 3', 'Player 4'], colors: [0, 1, 2, 3],
    battle: 'ffa', teams: [0, 1, 0, 1],
  };
  const NP = 4; // up to four players
  // Team colours (rings under the tanks, HUD outlines)
  const TEAMS = [{ name: 'Team A', color: '#ff4fa3', dark: '#b0266c' }, { name: 'Team B', color: '#29c8ff', dark: '#137fb0' }];
  const settings = loadSettings();

  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem('ricochet-rumble') || '{}');
      const fill = (arr, def) => def.map((d, i) => (Array.isArray(arr) && arr[i] != null ? arr[i] : d));
      return Object.assign({}, DEFAULTS, s, {
        names: fill(s.names, DEFAULTS.names),
        colors: fill(s.colors, DEFAULTS.colors),
        hats: fill(s.hats, DEFAULTS.hats),
        teams: fill(s.teams, DEFAULTS.teams).map((t) => (t ? 1 : 0)),
        battle: s.battle === 'teams' ? 'teams' : 'ffa',
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
  const players = Array.from({ length: NP }, (_, i) => ({
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
  // every player gets a different colour
  players.forEach((p, i) => {
    while (players.some((q, j) => j < i && q.colorIndex === p.colorIndex)) p.colorIndex = (p.colorIndex + 1) % C.PLAYER_COLORS.length;
  });

  const isBattle = () => settings.mode === 'duel';
  const teamsOn = () => isBattle() && settings.battle === 'teams';
  const teamOf = (i) => settings.teams[i] ? 1 : 0;
  const isCpu = (p) => !!(p.controller && p.controller.kind === 'cpu');
  // the players taking part (those with a controller)
  const activeSlots = () => players.filter((p) => p.controller).map((p) => p.index);
  const others = (i) => players.filter((q) => q.index !== i);

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
    slots: [0, 1],
    open: [true, false, false, false], // which player cards show in the lobby (players come and go)
    padPrev: {},       // gamepad buttons last frame, for "press to join"
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
    const w = new RR.World(RR.ARENA_DEFS[idx], { ammo: ammo(), minesEnabled: settings.mines, effects: settings.effects, colors: [colorOf(0), colorOf(1)], players: 2 });
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
      if (!$('#screen-settings').classList.contains('hidden')) show('#screen-settings', false);
      else if (!$('#screen-help').classList.contains('hidden')) show('#screen-help', false);
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
    players.forEach((p, i) => { if (p.controller) game.open[i] = true; });
    if (!game.open.some(Boolean)) game.open[0] = true;
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
        // computer opponents are only for battles
        players.forEach((p, i) => { if (v !== 'duel' && isCpu(p)) removeController(i, true); });
      },
      '#set-battle': (v) => { settings.battle = v === 'teams' ? 'teams' : 'ffa'; },
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
      $$('.team-seg button', card).forEach((b) => {
        b.addEventListener('click', () => {
          settings.teams[i] = Number(b.dataset.t) ? 1 : 0;
          saveSettings();
          audio.click();
          b.blur();
          refreshLobby();
        });
      });

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
    setupSettings();
    $('#btn-add-player').addEventListener('click', (e) => { e.currentTarget.blur(); addPlayer(false); });
    $('#btn-add-cpu').addEventListener('click', (e) => { e.currentTarget.blur(); addPlayer(true); });
    $$('.card-x').forEach((b) => b.addEventListener('click', (e) => {
      e.currentTarget.blur();
      removePlayer(Number(e.currentTarget.closest('.player-card').dataset.player));
    }));
    $('#btn-help-close').addEventListener('click', () => show('#screen-help', false));

    const problem = RR.BLE.problem();
    const onTablet = !!(window.rrApp && window.rrApp.platform === 'android');
    $('#ble-note').textContent = problem && !onTablet ? 'Android app (Bluetooth) unavailable: ' + problem : '';

    $('#join-other').addEventListener('click', (e) => {
      e.currentTarget.blur();
      joinUrlIndex++;
      refreshJoin();
    });
    RR.Wifi.onNewPad = onWifiPad;
    RR.Wifi.onUrls = () => refreshJoin();
    RR.Wifi.start();
  }

  // ---- settings: updates when running as the Windows app --------------------------------
  const appShell = window.rrApp || null;
  let pendingUpdate = null;

  function fmtDate(iso) {
    if (!iso) return 'unknown date';
    try { return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); } catch (e) { return iso.slice(0, 10); }
  }

  function setUpdateStatus(text, kind) {
    const el = $('#update-status');
    el.textContent = text;
    el.className = 'set-status' + (kind ? ' ' + kind : '');
  }

  async function refreshSettings() {
    $$('.app-only').forEach((el) => el.classList.toggle('hidden', !appShell));
    $$('.browser-only').forEach((el) => el.classList.toggle('hidden', !!appShell));
    if (!appShell) return;
    const info = await appShell.info();
    if (info.platform === 'android') $('#btn-fullscreen').textContent = 'Full screen on / off';
    const g = info.game;
    $('#app-version').textContent = `App ${info.app} · game from ${fmtDate(g.date)}${g.sha ? ' (' + g.sha.slice(0, 7) + ')' : ''}${g.source === 'downloaded' ? ' · updated' : ''}`;
  }

  function showUpdateResult(r) {
    $('#btn-install-update').classList.add('hidden');
    $('#app-update-note').classList.add('hidden');
    if (!r.ok) { setUpdateStatus(r.error || 'Could not check for updates.', 'bad'); return; }
    if (r.available) {
      pendingUpdate = r.latest;
      setUpdateStatus(`New version from ${fmtDate(r.latest.date)}: “${r.latest.message}”`, 'good');
      $('#btn-install-update').classList.remove('hidden');
    } else {
      setUpdateStatus('You have the newest version of the game.', 'good');
    }
    if (r.app) {
      const note = $('#app-update-note');
      note.innerHTML = '';
      note.append(`A new version of the app itself (${r.app.version}) is available. `);
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = 'Download it from the Releases page';
      a.addEventListener('click', (e) => { e.preventDefault(); appShell.openLink(r.app.url); });
      note.append(a, ' and run it to update the app.');
      note.classList.remove('hidden');
    }
  }

  async function checkForUpdates(quiet) {
    if (!appShell) return;
    if (!quiet) setUpdateStatus('Checking…');
    const r = await appShell.checkForUpdates();
    if (quiet) {
      if (r.ok && (r.available || r.app)) {
        showUpdateResult(r);
        toast('An update for Ricochet Rumble is ready: open ⚙ Settings to install it.', '#5cc461', 7000);
      }
      return;
    }
    showUpdateResult(r);
  }

  async function installUpdate() {
    if (!appShell || !pendingUpdate) return;
    $('#btn-install-update').disabled = true;
    $('#btn-check-update').disabled = true;
    const r = await appShell.installUpdate(pendingUpdate);
    if (r.ok) {
      setUpdateStatus('Updated! Restarting the game…', 'good');
      setTimeout(() => appShell.reload(), 900);
    } else {
      setUpdateStatus('Update failed: ' + r.error, 'bad');
      $('#btn-install-update').disabled = false;
      $('#btn-check-update').disabled = false;
    }
  }

  function openSettings() {
    show('#screen-settings', true);
    refreshSettings();
  }

  function setupSettings() {
    $('#btn-settings-title').addEventListener('click', (e) => { e.currentTarget.blur(); audio.click(); openSettings(); });
    $('#btn-settings-lobby').addEventListener('click', (e) => { e.currentTarget.blur(); audio.click(); openSettings(); });
    $('#btn-settings-close').addEventListener('click', () => { audio.click(); show('#screen-settings', false); });
    $('#btn-check-update').addEventListener('click', () => checkForUpdates(false));
    $('#btn-install-update').addEventListener('click', () => installUpdate());
    $('#btn-fullscreen').addEventListener('click', () => appShell && appShell.toggleFullscreen());
    $('#btn-quit-app').addEventListener('click', () => appShell && appShell.quit());
    if (appShell) {
      appShell.onProgress((p) => {
        if (p.step === 'download') setUpdateStatus(`Downloading… ${(p.bytes / 1048576).toFixed(1)} MB`);
        else if (p.step === 'unpack') setUpdateStatus('Unpacking…');
      });
      // look for updates quietly a few seconds after starting
      setTimeout(() => checkForUpdates(true), 4000);
    }
  }

  // ---- players joining one at a time ----------------------------------------------
  // Cards can come and go in any order; a removed player's spot is the first
  // to be filled again, and everyone else keeps their player number.
  const openCount = () => game.open.filter(Boolean).length;

  // First open card with nobody on it, else the first closed card (opened
  // now). -1 when all four are taken.
  function freeSlot(grow = true) {
    for (let i = 0; i < NP; i++) {
      if (!game.open[i]) continue;
      const waiting = (game.qrWait && game.qrWait.player === i) || (game.gamepadWait && game.gamepadWait.player === i);
      if (!players[i].controller && !waiting) return i;
    }
    if (grow) {
      const i = game.open.indexOf(false);
      if (i >= 0) { game.open[i] = true; return i; }
    }
    return -1;
  }

  function addPlayer(cpu) {
    const i = game.open.indexOf(false);
    if (i < 0) return;
    game.open[i] = true;
    audio.click();
    if (cpu) chooseController(i, 'cpu');
    refreshLobby();
  }

  // The × on a card: that player leaves. The last card left stays (empty).
  function removePlayer(i) {
    if (game.qrWait && game.qrWait.player === i) game.qrWait = null;
    if (game.gamepadWait && game.gamepadWait.player === i) game.gamepadWait = null;
    removeController(i, true);
    players[i].ready = false;
    if (openCount() > 1) game.open[i] = false;
    audio.click();
    refreshLobby();
  }

  // Scale the lobby to fit the window (it's laid out at a fixed size).
  function fitLobby() {
    const el = $('.lobby');
    if (!el || $('#screen-lobby').classList.contains('hidden')) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    if (!w || !h) return;
    const k = Math.min((window.innerWidth - 20) / w, (window.innerHeight - 20) / h, 1.6);
    el.style.transform = `scale(${k.toFixed(4)})`;
  }

  // A phone scanned the lobby's QR code (or typed its address). It takes the
  // next open spot: the first card with no controller (cards waiting for a
  // gamepad, or set to anything else, are skipped), or a new card. Only the
  // lobby takes new players; a phone that scans during a match waits and
  // joins when the game is back in the lobby.
  const fullToasted = new Set();
  function onWifiPad(ctl, slot) {
    if (game.state !== 'lobby') {
      ctl.reject(2);
      return;
    }
    // (older QR codes named a player: honour that if the spot is still free)
    let i = /^[0-3]$/.test(slot) && !players[Number(slot)].controller ? Number(slot) : freeSlot();
    if (i < 0) {
      ctl.reject(1);
      if (!fullToasted.has(ctl.id)) {
        fullToasted.add(ctl.id);
        toast('A phone tried to join, but all four spots are taken.', '#ff5a4a');
      }
      return;
    }
    game.open[i] = true;
    assignController(i, ctl);
    refreshLobby();
  }

  // ---- the lobby's QR code: one for everyone, the same all session ----------------------
  let joinUrlIndex = 0;
  function refreshJoin() {
    const box = $('#join-box');
    if (!box) return;
    const taken = players.filter((p) => p.controller || (game.gamepadWait && game.gamepadWait.player === p.index)).length;
    const left = NP - taken;
    const urls = RR.Wifi.urls || [];
    const qr = $('#join-qr');
    let title, sub, url = '', link = null;
    if (left <= 0) {
      title = 'Lobby full';
      sub = 'All four spots are taken.';
    } else if (!RR.Wifi.supported()) {
      title = 'Phones';
      sub = 'To let phones join over Wi-Fi, open the game with the Ricochet Rumble app or the start script.';
    } else if (!RR.Wifi.hubConnected) {
      title = 'Phones';
      sub = 'Starting the Wi-Fi link… If this doesn’t go away, restart the game.';
    } else if (!urls.length) {
      title = 'Phones';
      sub = 'Connect this computer to Wi-Fi (or a phone hotspot) so phones can join.';
    } else {
      link = urls[joinUrlIndex % urls.length];
      title = 'Scan to join';
      sub = `${left} spot${left === 1 ? '' : 's'} left · phones on the same Wi-Fi as this computer`;
      url = link.replace(/^http:\/\//, '');
    }
    box.classList.toggle('full', !link);
    if (link && qr.dataset.url !== link) {
      qr.dataset.url = link;
      drawQr(qr, link);
    }
    $('#join-title').textContent = title;
    $('#join-sub').textContent = sub;
    $('#join-url').textContent = url;
    $('#join-other').classList.toggle('hidden', !link || urls.length < 2);
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


  function refreshLobby() {
    const campaign = settings.mode === 'campaign';
    const survival = settings.mode === 'survival';
    const coop = campaign || survival;
    $$('#set-mode button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === settings.mode)));
    $$('#set-powerups button').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.v === 'on') === settings.powerups)));
    $$('.duel-only').forEach((el) => el.classList.toggle('hidden', coop));
    $$('#set-battle button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === settings.battle)));
    $$('.teams-only').forEach((el) => el.classList.toggle('hidden', !teamsOn()));
    $$('.no-campaign').forEach((el) => el.classList.toggle('hidden', campaign));
    $$('.campaign-only').forEach((el) => el.classList.toggle('hidden', !campaign));
    $$('.survival-only').forEach((el) => el.classList.toggle('hidden', !survival));
    $('#campaign-best').textContent = settings.bestStage > 0 ? `Best so far: stage ${settings.bestStage} of ${RR.Campaign.count}.` : '';
    $('#survival-best').textContent = settings.bestWave > 0 ? `Best so far: wave ${settings.bestWave}.` : '';
    $('.match-panel h2').textContent = campaign ? 'Co-op campaign' : survival ? 'Survival' : teamsOn() ? 'Team battle' : 'Free-for-all';
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
    {
      const def = RR.ARENA_DEFS[previewArenaIndex()];
      let slots = activeSlots();
      if (slots.length < 2) slots = [0, 1];
      const spots = coop ? RR.Campaign.spawnsFor(def) : RR.Spawns.battle(def, slots, teamsOn() ? settings.teams : null);
      // battles shuffle who starts where every round, so just mark the spots
      const dots = coop ? slots.map((i) => ({ sp: spots[i], col: colorOf(i) }))
        : slots.map((i) => ({ sp: spots[i], col: { body: '#2a2230' }, ring: '#ffffff' }));
      RR.drawArenaPreview($('#arena-preview'), def, null, dots);
    }

    players.forEach((p, i) => {
      const card = $(`.player-card[data-player="${i}"]`);
      $$('.colors button', card).forEach((b) => {
        const ci = Number(b.dataset.ci);
        b.setAttribute('aria-checked', String(ci === p.colorIndex));
        b.disabled = others(i).some((q) => q.colorIndex === ci);
      });
      $$('.team-seg button', card).forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.t) === teamOf(i))));
      card.style.setProperty('--tc', TEAMS[teamOf(i)].color);
      card.classList.toggle('teamed', teamsOn());
      const waitingHere = (game.qrWait && game.qrWait.player === i) || (game.gamepadWait && game.gamepadWait.player === i);
      card.classList.toggle('hidden', !game.open[i]);
      // × on every card (on the only card left, only once it has a controller)
      $('.card-x', card).classList.toggle('hidden', openCount() <= 1 && !p.controller);
      void waitingHere;
      const ctl = p.controller;
      const icon = $('.ctrl-icon', card);
      const name = $('.ctrl-name', card);
      const detail = $('.ctrl-detail', card);
      icon.removeAttribute('data-state');
      if (game.gamepadWait && game.gamepadWait.player === i) {
        icon.dataset.kind = 'gamepad';
        icon.dataset.state = 'waiting';
        name.textContent = 'Press a button…';
        detail.textContent = { 'pad-xbox': 'on the Xbox controller', 'pad-ps': 'on the PlayStation controller', 'pad-switch': 'on the Switch controller' }[game.gamepadWait.src] || 'on the gamepad you want to use';
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
      const wifiOpt = $('.ctrl-select option[value="wifi"]', card);
      wifiOpt.hidden = wifiOpt.disabled = !(ctl && ctl.kind === 'wifi');
      const noHid = !('hid' in navigator), noBt = !('bluetooth' in navigator) && !!(window.rrApp && window.rrApp.platform === 'android');
      $('.ctrl-select option[value="wiimote"]', card).hidden = noHid && !(ctl && ctl.kind === 'wiimote');
      $('.ctrl-select option[value="phone"]', card).hidden = noBt && !(ctl && ctl.kind === 'phone');
      const sel = $('.ctrl-select', card);
      const showing = game.gamepadWait && game.gamepadWait.player === i ? (game.gamepadWait.src || 'gamepad')
          : ctl ? (ctl.kind === 'gamepad' ? ctl.choice || 'gamepad' : ctl.kind) : 'none';
      if (document.activeElement !== sel && !sel.dataset.pending) sel.value = showing;
      const rb = $('.ready-btn', card);
      rb.disabled = !ctl;
      rb.classList.toggle('is-ready', p.ready);
      const fireName = !ctl ? '' : ctl.kind === 'wiimote' ? 'B' : ctl.kind === 'gamepad' ? 'a trigger' : ctl.kind === 'kbm' ? 'click' : 'fire';
      rb.textContent = p.ready ? 'Ready!' : ctl ? `Ready? (press ${fireName})` : 'Ready';
    });

    const ok = canStart();
    $('#btn-start').disabled = !ok;
    let hint;
    if (!ok) {
      const part = players.filter((p) => p.controller);
      if (coop) hint = 'Give at least one player a controller.';
      else if (part.length < 2) hint = openCount() < 2 ? 'Battles need 2–4 players: add a player or the Computer.' : 'Battles need 2–4 players. Give another player a controller (or the Computer).';
      else if (!part.some((p) => !isCpu(p))) hint = 'At least one human player, please!';
      else hint = 'Put players on both teams.';
    }
    else if (game.lobbyCountdown > 0) hint = `Starting in ${Math.ceil(game.lobbyCountdown)}…`;
    else if (coop && players.filter((p) => p.controller).length === 1) hint = 'Solo run! Press fire, or click Start.';
    else if (!coop) {
      const n = activeSlots().length;
      const vs = teamsOn() ? [0, 1].map((t) => activeSlots().filter((k) => teamOf(k) === t).length).join(' vs ') : `${n}-player free-for-all`;
      hint = `${vs} · press fire on every controller, or click Start.`;
    } else hint = 'Press fire on every controller, or click Start.';
    $('#start-hint').textContent = hint;
    $$('.ctrl-select option[value="cpu"]').forEach((o) => { o.hidden = coop; o.disabled = coop; });
    $('.add-tile').classList.toggle('hidden', openCount() >= NP);
    refreshJoin();
    $('#btn-add-cpu').classList.toggle('hidden', coop);
    fitLobby();
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
    const part = players.filter((p) => p.controller);
    if (part.length < 2 || humans.length < 1) return false;
    if (teamsOn()) return new Set(part.map((p) => teamOf(p.index))).size === 2;
    return true;
  }

  async function chooseController(i, src) {
    game.gamepadWait = null;
    game.qrWait = null;
    if (src === 'wifi') {
      toast('Phones join by scanning the QR code in the lobby.', colorOf(i).body);
      refreshLobby();
    } else if (src === 'cpu') {
      assignController(i, cpuController());
      players[i].ready = true;
      refreshLobby();
    } else if (src === 'kbm' || src === 'arrows') {
      others(i).forEach((q) => { if (q.controller && q.controller.kind === src) removeController(q.index, true); });
      assignController(i, src === 'kbm' ? new RR.KeyboardMouseController() : new RR.KeyboardArrowsController());
    } else if (src === 'wiimote') {
      const problem = RR.Wiimote.problem();
      if (problem) {
        toast(problem, '#ff5a4a', 7000);
        return;
      }
      try {
        toast('Looking for a Wii Remote… If the browser asks, pick “Nintendo RVL-CNT-01” (your DolphinBar, set to mode 4).', colorOf(i).body, 6000);
        const ctl = await RR.Wiimote.connect({
          onChoose: (n) => toast(`${n} Wii Remotes found: press A on the one for ${players[i].name}.`, colorOf(i).body, 8000),
        });
        if (players[i].controller && players[i].controller.kind === 'wiimote') removeController(i, true);
        assignController(i, ctl);
      } catch (err) {
        if (err && err.name === 'NotFoundError') return; // picker closed
        if (err && err.name === 'SecurityError') {
          toast('The first time, the browser needs a mouse click to allow the Wii Remote: pick it in this menu with the mouse once.', '#ff5a4a', 7000);
          refreshLobby();
          return;
        }
        console.error(err);
        toast(err && err.name === 'NoRemote' ? err.message : 'Could not use that Wii Remote: ' + (err && err.message ? err.message : err), '#ff5a4a', 7000);
        refreshLobby();
      }
    } else if (src === 'gamepad' || src.startsWith('pad-')) {
      game.gamepadWait = { player: i, src, until: performance.now() + 12000 };
      const tips = {
        'pad-xbox': 'Connect the Xbox controller (USB, or Bluetooth: hold the pairing button), then press any button on it.',
        'pad-ps': 'Connect the PlayStation controller (USB, or Bluetooth: hold Share/Create + PS), then press any button on it.',
        'pad-switch': 'Connect the Switch controller (USB, or Bluetooth: hold the sync button), then press any button on it.',
      };
      if (RR.Input.gamepads().length === 0 || tips[src]) toast(tips[src] || 'Connect a gamepad, then press any of its buttons.', colorOf(i).body, 6000);
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
        others(i).forEach((q) => {
          if (q.controller && q.controller.kind === 'phone' && q.controller.device && q.controller.device.id === ctl.device.id) removeController(q.index, true);
        });
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
    p.wasConnected = false;
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

  // Gamepads nobody is using: a fresh button press (returns pads pressed this frame)
  function freePadPresses() {
    const used = new Set(players.filter((p) => p.controller && p.controller.kind === 'gamepad').map((p) => p.controller.index));
    const out = [];
    for (const pad of RR.Input.gamepads()) {
      const now = pad.buttons.map((b) => !!(b && b.pressed));
      const prev = game.padPrev[pad.index] || now.map(() => true);
      game.padPrev[pad.index] = now;
      if (used.has(pad.index)) continue;
      if (now.some((v, k) => v && !prev[k])) out.push(pad);
    }
    return out;
  }

  function padChoice(pad) {
    const f = RR.Pad.padFamily(pad.id);
    return f === 'xbox' || f === 'ps' || f === 'switch' ? 'pad-' + f : 'gamepad';
  }

  // A free controller pressed a button: it takes the first empty player card.
  function joinWith(make, what) {
    const i = freeSlot();
    if (i < 0) {
      toast(`All four players already have controllers (${what}).`, '#ff5a4a');
      return;
    }
    assignController(i, make());
    refreshLobby();
  }

  let joinTimer = 0;
  function updateLobby(dt, inputs) {
    joinTimer -= dt;
    if (joinTimer <= 0) { joinTimer = 1; refreshJoin(); }
    const fresh = freePadPresses();
    if (!game.gamepadWait) {
      for (const pad of fresh) joinWith(() => new RR.GamepadController(pad, padChoice(pad)), 'gamepad');
    }
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
            const src = game.gamepadWait.src || 'gamepad';
            game.gamepadWait = null;
            assignController(i, new RR.GamepadController(pad, src));
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
        // keyboard + mouse has no menu highlight: fire still means "ready"
        if (p.controller.kind === 'kbm') toggleReady(i);
      }
      // gamepads and Wii Remotes: the trigger (RT / R2 / ZR, Wii B) is always "ready",
      // whatever is highlighted or pointed at
      if (inp.ready > 0 && !RR.MenuNav.pickerOpen()) { pv.recoil = 1; toggleReady(i); }
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
      const s = Math.round(cv.height * 0.6);
      const fake = { s, ox: cv.width / 2, oy: cv.height / 2 + s * 0.08 };
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
    game.slots = activeSlots();
    game.teams = settings.mode === 'duel' && settings.battle === 'teams' ? players.map((p) => teamOf(p.index)) : null;
    game.teamWins = [0, 0];
    players.forEach((p) => {
      p.wasConnected = !!(p.controller && p.controller.connected);
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

  function worldOpts(def) {
    const cpu = {};
    players.forEach((p, i) => { if (isCpu(p)) cpu[i] = 'rival'; });
    const o = {
      ammo: ammo(), minesEnabled: settings.mines, effects: settings.effects,
      colors: players.map((_, i) => colorOf(i)), hats: players.map((_, i) => hatOf(i)),
      powerups: settings.powerups, cpu, players: NP,
      absent: players.filter((p) => !game.slots.includes(p.index)).map((p) => p.index),
    };
    if (def && !game.campaign && !game.survival) {
      o.teams = game.teams;
      // a new random line-up every round
      o.spawns = RR.Spawns.battle(def, game.slots, game.teams, Math.random);
    }
    return o;
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
    const w = new RR.World(def, worldOpts(def));
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
    if (alive.length && game.teams) {
      const team = alive[0].team;
      game.teamWins[team]++;
      const members = game.slots.filter((i) => game.teams[i] === team);
      members.forEach((i) => { players[i].wins++; rumble(i, 160, 0.6); });
      banner(`${TEAMS[team].name} scores!`, scoreLine(), TEAMS[team].dark);
      audio.roundWin();
      if (game.teamWins[team] >= settings.wins) game.matchWinner = { team, members };
    } else if (alive.length) {
      const winner = alive[0].index;
      players[winner].wins++;
      banner(`${players[winner].name} scores!`, scoreLine(), colorOf(winner).dark);
      audio.roundWin();
      rumble(winner, 160, 0.6);
      if (players[winner].wins >= settings.wins) game.matchWinner = { team: null, members: [winner] };
    } else {
      banner('Draw!', 'Nobody scores', '#2a2230');
      audio.roundDraw();
    }
    game.state = 'result';
    game.timer = C.ROUND_RESULT;
  }

  // "3 – 1" for two, "3 · 1 · 0" for more, "A 3 – 1 B" for teams
  function scoreLine() {
    if (game.teams) return `${TEAMS[0].name} ${game.teamWins[0]} – ${game.teamWins[1]} ${TEAMS[1].name}`;
    return game.slots.map((i) => players[i].wins).join(game.slots.length === 2 ? ' – ' : ' · ');
  }

  function finishMatch() {
    game.state = 'over';
    hideBanner();
    const mw = game.matchWinner;
    const w = mw.members[0];
    const beatCpu = game.slots.some((i) => !mw.members.includes(i) && isCpu(players[i]));
    if (beatCpu && mw.members.some((i) => players[i].controller && !isCpu(players[i]))) unlockHat('tophat');
    const panel = $('#screen-results .results');
    if (mw.team != null) {
      $('.winner', panel).textContent = `${TEAMS[mw.team].name} wins!`;
      $('.winner', panel).style.color = TEAMS[mw.team].dark;
    } else {
      $('.winner', panel).textContent = `${players[w].name} wins!`;
      $('.winner', panel).style.color = colorOf(w).dark;
    }
    $('.final-score', panel).textContent = scoreLine();
    const rows = [
      ['Rounds won', (p) => p.wins],
      ['Shells fired', (p) => p.stats.shots],
      ['Ricochets', (p) => p.stats.bounces],
      ['Enemy hits', (p) => p.stats.hits],
      ['Mines laid', (p) => p.stats.mines],
      ['Trick shots', (p) => p.stats.trick],
      ['Own goals', (p) => p.stats.selfKills],
    ];
    const inIt = game.slots.map((i) => players[i]);
    const tag = (p) => (game.teams ? ` <small style="color:${TEAMS[game.teams[p.index]].dark}">${TEAMS[game.teams[p.index]].name.replace('Team ', '')}</small>` : '');
    const head = `<thead><tr><th></th>${inIt.map((p) => `<th style="color:${colorOf(p.index).dark}">${escapeHtml(isCpu(p) ? 'Computer' : p.name)}${tag(p)}</th>`).join('')}</tr></thead>`;
    const body = rows.map(([label, f]) => `<tr><th>${label}</th>${inIt.map((p) => `<td>${f(p)}</td>`).join('')}</tr>`).join('');
    $('.stats', panel).innerHTML = head + '<tbody>' + body + '</tbody>';
    show('#screen-results', true);
    game.resultsAt = performance.now();
    audio.matchWin();
    mw.members.forEach((i) => rumble(i, 500, 0.8));
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

  // ---- controllers in menus ------------------------------------------------------------
  // (Wi-Fi phones show their own card on the phone instead)
  const navable = (p) => p.controller && !['cpu', 'kbm', 'wifi'].includes(p.controller.kind);
  // The first player with a controller that can drive menus runs the whole screen.
  function menuLeader() {
    const k = players.findIndex(navable);
    return k;
  }

  function updateMenus(dt, inputs) {
    const lead = menuLeader();
    const helpOpen = !$('#screen-help').classList.contains('hidden');
    let scope = null, def = null;
    const settingsOpen = !$('#screen-settings').classList.contains('hidden');
    if (settingsOpen) { scope = $('#screen-settings'); def = $('#btn-install-update').classList.contains('hidden') ? $('#btn-check-update') : $('#btn-install-update'); }
    else if (helpOpen) { scope = $('#screen-help'); def = $('#btn-help-close'); }
    else if (game.paused) { scope = $('#screen-pause'); def = $('#btn-resume'); }
    else if (game.state === 'over') { scope = $('#screen-results'); def = $('#btn-rematch'); }
    else if (game.state === 'lobby') { scope = $('#screen-lobby'); }
    else if (game.state === 'title') { scope = $('#screen-title'); def = $('#btn-play'); }
    players.forEach((p, i) => {
      const inp = navable(p) ? inputs[i] : null;
      let sc = null, d = null;
      if (inp && game.state === 'lobby' && !helpOpen && !settingsOpen) {
        // everyone can set up their own card; the menu player can reach everything
        const card = $(`.player-card[data-player="${i}"]`);
        sc = i === lead ? scope : card;
        d = $('.ready-btn', card);
      } else if (inp && i === lead) {
        sc = scope; d = def;
      }
      RR.MenuNav.update(dt, i, sc ? inp : null, sc, d, colorOf(i).body, 'P' + (i + 1));
      if (i === lead && inp) {
        // B / mine closes the help; Start in the lobby starts the match
        const backBtn = inp.back > 0 || (inp.back == null && inp.mine > 0);
        if (settingsOpen && backBtn) show('#screen-settings', false);
        else if (helpOpen && backBtn) show('#screen-help', false);
        if (inp.pause > 0 && game.state === 'lobby' && !helpOpen && !settingsOpen && canStart()) startMatch();
        else if (inp.pause > 0 && game.state === 'over') startMatch();
      }
    });
  }

  // Title screen: a button on any free gamepad or Wii Remote heads to the lobby
  // as Player 1.
  function updateTitle() {
    const fresh = freePadPresses();
    if (fresh.length) {
      const pad = fresh[0];
      audio.unlock();
      goLobby();
      if (!players[0].controller) assignController(0, new RR.GamepadController(pad, padChoice(pad)));
      game.padPrev[pad.index] = pad.buttons.map(() => true);
    }
  }

  function onWiimoteJoin(dev) {
    if (game.state === 'title') {
      goLobby();
      if (players[0].controller) return;
    }
    if (game.state !== 'lobby') return;
    const i = freeSlot();
    if (i < 0) return;
    RR.Wiimote.adopt(dev).then((ctl) => {
      if (players[i].controller) {
        const j = freeSlot();
        if (j < 0) { ctl.dispose(); return; }
        assignController(j, ctl);
      } else {
        assignController(i, ctl);
      }
      refreshLobby();
    }).catch((err) => console.warn(err));
  }

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
          if (game.survival && ev.player < NP && game.state === 'play') onSurvivalDeath(ev.player);
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
    if (typeof profile.hat === 'string' && C.HATS.some((h) => h.id === profile.hat) && settings.unlocked.includes(profile.hat)) {
      settings.hats[i] = profile.hat;
      buildHatPickers();
    }
    if ((profile.team === 0 || profile.team === 1) && teamsOn()) settings.teams[i] = profile.team;
    if (profile.ready === 'toggle') toggleReady(i);
    const ci = profile.color;
    if (ci < C.PLAYER_COLORS.length && !others(i).some((q) => q.colorIndex === ci) && ci !== p.colorIndex) {
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
    const lead = menuLeader();
    if (performance.now() - game.resultsAt > 2000 && inputs.some((inp, i) => inp && inp.fire > 0 && i !== lead)) startMatch();
  }

  // ---------------------------------------------------------------------------
  // HUD
  // ---------------------------------------------------------------------------
  const hudCache = Array(NP).fill('');

  function buildHudPips() {
    hudCache.fill('');
    const inGame = (i) => game.slots.includes(i);
    players.forEach((p, i) => {
      const el = $(`.hud-player[data-player="${i}"]`);
      el.classList.toggle('out', !inGame(i));
      el.classList.toggle('teamed', !!game.teams);
      if (game.teams) el.style.setProperty('--tc', TEAMS[game.teams[i]].color);
    });
    $('#hud').classList.toggle('quad', players.some((p, i) => i >= 2 && inGame(i)));
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
      const cpu = isCpu(p);
      const powers = t ? ['shield', 'boost', 'spread', 'bouncy', 'rapid'].filter((k) => (k === 'shield' ? t.shield : t[k] > 0)) : [];
      const absent = !!(t && t.absent);
      const coop = !!(game.campaign || game.survival);
      const key = [p.name, p.wins, settings.wins, shells, mines, ok, maxShells, w.minesEnabled, kills, coop, powers.join(), absent].join('|');
      if (key === hudCache[i]) return;
      hudCache[i] = key;
      const el = $(`.hud-player[data-player="${i}"]`);
      el.classList.toggle('absent', absent);
      $('.hud-name', el).textContent = cpu ? (players.filter(isCpu).length > 1 ? `CPU ${i + 1}` : 'Computer') : p.name;
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
  // ---- the lobby card on a Wi-Fi phone --------------------------------------------
  const hatIcons = {};
  function hatIcon(id) {
    if (!hatIcons[id]) {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 44;
      const ctx = cv.getContext('2d');
      if (id === 'none') {
        ctx.strokeStyle = '#b9aea0'; ctx.lineWidth = 3.5;
        ctx.beginPath(); ctx.arc(22, 22, 12, 0, Math.PI * 2); ctx.moveTo(13, 31); ctx.lineTo(31, 13); ctx.stroke();
      } else {
        RR.drawHat(ctx, id, 22, 29, 33, 0.3);
      }
      hatIcons[id] = cv.toDataURL('image/png');
    }
    return hatIcons[id];
  }
  const tankPics = {};
  function tankPic(i) {
    const key = `${players[i].colorIndex}|${hatOf(i)}`;
    if (!tankPics[key]) {
      const cv = document.createElement('canvas');
      cv.width = 132; cv.height = 96;
      const ctx = cv.getContext('2d');
      const s = 58, fake = { s, ox: 66, oy: 52 };
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.beginPath(); ctx.ellipse(71, 61, s * 0.55, s * 0.32, 0, 0, U.TAU); ctx.fill();
      RR.Renderer.prototype.drawTank.call(fake, ctx, { x: 0, y: 0, angle: 0, turret: -0.35, color: colorOf(i), treadPhase: 0, recoil: 0, hat: hatOf(i) });
      tankPics[key] = cv.toDataURL('image/png');
    }
    return tankPics[key];
  }
  function sendLobbyCard(i, c) {
    const p = players[i];
    const coop = settings.mode !== 'duel';
    const card = {
      p: i, name: p.name, color: p.colorIndex,
      taken: others(i).filter((q) => game.open[q.index]).map((q) => q.colorIndex),
      hat: hatOf(i), teams: teamsOn(), team: teamOf(i), ready: p.ready,
      mode: coop ? (settings.mode === 'campaign' ? 'Co-op campaign' : 'Survival') : teamsOn() ? 'Team battle' : 'Free-for-all',
      hint: $('#start-hint').textContent,
    };
    const key = JSON.stringify(card) + settings.unlocked.join();
    card.hats = C.HATS.map((h) => {
      const ok = settings.unlocked.includes(h.id);
      return { id: h.id, name: ok ? h.name : `Locked: ${h.how}`, ok, icon: ok ? hatIcon(h.id) : null };
    });
    card.tank = tankPic(i);
    c.lobbyCard(card, key);
  }

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
        state, p.wins, Math.max(0, ...others(i).filter((q) => game.slots.includes(q.index) && !(game.teams && game.teams[q.index] === game.teams[i])).map((q) => q.wins)), settings.wins,
        live ? w.shellsLeft(i) : ammo().max,
        live ? w.minesLeft(i) : (settings.mines ? C.MINE_MAX : 0),
        p.ready,
        ammo().max,
      );
      const rival = others(i).find((q) => q.controller) || others(i)[0];
      if (c.lobby) c.lobby(p.colorIndex, rival.colorIndex, p.name);
      if (c.lobbyCard && game.state === 'lobby') sendLobbyCard(i, c);
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
        updateTitle();
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
    players.forEach((p) => { if (p.controller && p.controller.tick) p.controller.tick(); });
    RR.Wiimote.updatePointers(players, inputs, menus, colorOf);
    if (game.paused) refreshReconnectButtons();
    updateMenus(dt, inputs);
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
    fitLobby();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && inMatch() && !game.paused) togglePause('');
  });
  window.addEventListener('gamepadconnected', (e) => {
    const f = RR.Pad.FAMILIES[RR.Pad.padFamily(e.gamepad.id)];
    toast(`${f.name} connected. Press a button on it to join.`);
  });
  window.addEventListener('gamepaddisconnected', () => toast('Gamepad disconnected', '#ff5a4a'));
  window.addEventListener('resize', onResize);

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  audio.musicOn = settings.music;
  applyPlayerColors();
  buildLobby();
  onResize();
  RR.Wiimote.watchJoin(onWiimoteJoin, () => game.state === 'lobby' || game.state === 'title');
  RR.MenuNav.onMove = () => audio.click();
  RR.MenuNav.onRevert = () => refreshLobby();
  goTitle();
  if (DEBUG) show('#fps', true);
  requestAnimationFrame(frame);

  // Exposed for debugging and automated tests.
  RR.game = { game, players, TEAMS, settings, renderer, audio, startMatch, goLobby, assignController, togglePause, chooseController, refreshLobby, nextRound };
})();
