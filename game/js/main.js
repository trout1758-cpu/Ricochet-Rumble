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
  const DEFAULTS = { wins: 5, arena: 'rotation', ammo: 'classic', mines: true, music: true, names: ['Player 1', 'Player 2'], colors: [0, 1] };
  const settings = loadSettings();

  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem('ricochet-rumble') || '{}');
      return Object.assign({}, DEFAULTS, s, {
        names: Array.isArray(s.names) ? s.names.slice(0, 2) : DEFAULTS.names.slice(),
        colors: Array.isArray(s.colors) ? s.colors.slice(0, 2) : DEFAULTS.colors.slice(),
      });
    } catch (e) {
      return JSON.parse(JSON.stringify(DEFAULTS));
    }
  }

  function saveSettings() {
    try { localStorage.setItem('ricochet-rumble', JSON.stringify(settings)); } catch (e) { /* private mode */ }
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
    matchWinner: null,
    goShown: false,
    mineBlink: new Map(),
    resultsAt: 0,
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
    const w = new RR.World(RR.ARENA_DEFS[idx], { ammo: ammo(), minesEnabled: settings.mines, colors: [colorOf(0), colorOf(1)] });
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
  function goLobby() {
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

  function buildLobby() {
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
      '#set-wins': (v) => { settings.wins = Number(v); },
      '#set-ammo': (v) => { settings.ammo = v; },
      '#set-mines': (v) => { settings.mines = v === 'on'; },
      '#set-music': (v) => { settings.music = v === 'on'; audio.setMusic(settings.music); },
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

      $$('.ctrl-buttons button', card).forEach((b) => {
        b.addEventListener('click', () => {
          audio.unlock();
          audio.click();
          b.blur();
          chooseController(i, b.dataset.src);
        });
      });
      $('.ctrl-remove', card).addEventListener('click', (e) => {
        e.currentTarget.blur();
        removeController(i);
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
    $('#ble-note').textContent = problem ? 'Phone controllers unavailable: ' + problem : '';
  }

  function refreshLobby() {
    $$('#set-wins button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.v) === settings.wins)));
    $$('#set-ammo button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === settings.ammo)));
    $$('#set-mines button').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.v === 'on') === settings.mines)));
    $$('#set-music button').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.v === 'on') === settings.music)));
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
        if (ctl.kind === 'phone' && !ctl.connected) {
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
      $('.ctrl-remove', card).classList.toggle('hidden', !ctl);
      const rb = $('.ready-btn', card);
      rb.disabled = !ctl;
      rb.classList.toggle('is-ready', p.ready);
      rb.textContent = p.ready ? 'Ready!' : ctl ? 'Ready? (press fire)' : 'Ready';
    });

    const both = players.every((p) => p.controller);
    $('#btn-start').disabled = !both;
    let hint;
    if (!both) hint = 'Give both players a controller.';
    else if (game.lobbyCountdown > 0) hint = `Starting in ${Math.ceil(game.lobbyCountdown)}…`;
    else hint = 'Press fire on both controllers, or click Start.';
    $('#start-hint').textContent = hint;
  }

  async function chooseController(i, src) {
    const other = players[1 - i];
    game.gamepadWait = null;
    if (src === 'kbm' || src === 'arrows') {
      if (other.controller && other.controller.kind === src) removeController(1 - i, true);
      assignController(i, src === 'kbm' ? new RR.KeyboardMouseController() : new RR.KeyboardArrowsController());
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
    if (ctl.kind === 'phone') {
      ctl.onchange = () => onPhoneChange(i, ctl);
      ctl.assign(i, colorOf(i).rgb);
    }
    ctl.rumble(150, 0.7);
    audio.connect();
    toast(`${p.name}: ${ctl.label} ready${ctl.kind === 'phone' ? ' (' + ctl.detail + ')' : ''}`, colorOf(i).body);
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
    if (ctl.connected) {
      toast(`${players[i].name}: phone reconnected`, colorOf(i).body);
      audio.connect();
    } else {
      toast(`${players[i].name}: phone disconnected — trying to reconnect…`, '#ff5a4a', 4500);
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
    if (!players.every((q) => q.ready)) game.lobbyCountdown = 0;
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
        pv.turret = Math.atan2(RR.Input.mouse.y - (r.top + r.height / 2), RR.Input.mouse.x - (r.left + r.width / 2));
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
      const t = { x: 0, y: 0, angle: p.preview.angle, turret: p.preview.turret, color: colorOf(i), treadPhase: p.preview.treadPhase, recoil: p.preview.recoil };
      RR.Renderer.prototype.drawTank.call(fake, ctx, t);
    });
  }

  // ---------------------------------------------------------------------------
  // Match flow
  // ---------------------------------------------------------------------------
  function newStats() {
    return { shots: 0, hits: 0, bounces: 0, mines: 0, selfKills: 0, deaths: 0 };
  }

  function inMatch() {
    return ['intro', 'play', 'grace', 'result'].includes(game.state);
  }

  function startMatch() {
    if (!players.every((p) => p.controller)) return;
    audio.unlock();
    game.lobbyCountdown = 0;
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
    nextRound();
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
    game.round++;
    const idx = pickArena();
    game.lastArena = idx;
    const def = RR.ARENA_DEFS[idx];
    const w = new RR.World(def, { ammo: ammo(), minesEnabled: settings.mines, colors: [colorOf(0), colorOf(1)] });
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
    $('.hud-arena').textContent = def.name;
    banner(`Round ${game.round}`, def.name);
    audio.roundStart();
  }

  function resolveRound() {
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
          players[ev.player].stats.shots++;
          rumble(ev.player, 30, 0.35);
          break;
        case 'bounce':
          audio.bounce();
          players[ev.owner].stats.bounces++;
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
          break;
        case 'dry':
          audio.dry();
          rumble(ev.player, 15, 0.2);
          break;
        case 'mineLay':
          audio.mineLay();
          players[ev.player].stats.mines++;
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
          players[ev.player].stats.deaths++;
          if (ev.by === ev.player) players[ev.player].stats.selfKills++;
          else if (ev.by != null) players[ev.by].stats.hits++;
          rumble(ev.player, 450, 1);
          if (ev.by != null && ev.by !== ev.player) rumble(ev.by, 120, 0.7);
          break;
      }
    }
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
      handleWorldEvents(w.drainEvents());
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
        if (w.aliveTanks().length < 2) {
          game.state = 'grace';
          game.timer = C.ROUND_GRACE;
          hideBanner();
        }
        break;
      case 'grace':
        if (game.timer <= 0) resolveRound();
        break;
      case 'result':
        if (game.timer <= 0) {
          if (game.matchWinner != null) finishMatch();
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
    players.forEach((p, i) => {
      const shells = w.shellsLeft(i);
      const mines = w.minesLeft(i);
      const ok = !!(p.controller && p.controller.connected);
      const key = [p.name, p.wins, settings.wins, shells, mines, ok, w.ammo.max, w.minesEnabled].join('|');
      if (key === hudCache[i]) return;
      hudCache[i] = key;
      const el = $(`.hud-player[data-player="${i}"]`);
      $('.hud-name', el).textContent = p.name;
      $('.hud-wins', el).innerHTML = Array.from({ length: settings.wins }, (_, k) => `<i class="${k < p.wins ? 'on' : ''}"></i>`).join('');
      $('.hud-shells', el).innerHTML = Array.from({ length: w.ammo.max }, (_, k) => `<i class="${k < shells ? '' : 'used'}"></i>`).join('');
      $('.hud-mines', el).innerHTML = w.minesEnabled ? Array.from({ length: C.MINE_MAX }, (_, k) => `<i class="${k < mines ? '' : 'used'}"></i>`).join('') : '';
      $('.hud-link', el).classList.toggle('lost', !ok);
    });
  }

  // Keep each phone's screen in sync (score, ammo, game state).
  function syncPhones() {
    players.forEach((p, i) => {
      const c = p.controller;
      if (!c || c.kind !== 'phone' || !c.connected) return;
      let state = P.STATE.LOBBY;
      if (game.paused) state = P.STATE.PAUSED;
      else if (game.state === 'intro') state = P.STATE.COUNTDOWN;
      else if (game.state === 'play' || game.state === 'grace') state = P.STATE.PLAYING;
      else if (game.state === 'result') state = P.STATE.ROUND_OVER;
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
      default:
        updateMatch(dt, inputs);
    }

    const view = { labels: game.state === 'intro', aims: [] };
    if (inMatch() && game.world) {
      inputs.forEach((inp, i) => {
        if (!inp) return;
        if (inp.aimMode === 'point') view.aims[i] = { show: true, mode: 'point', x: inp.aimX, y: inp.aimY };
        else if (inp.aimMode === 'dir' && inp.aimActive) view.aims[i] = { show: true, mode: 'dir' };
      });
    }
    renderer.render(game.paused ? 0 : dt, view);
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
  RR.game = { game, players, settings, renderer, audio, startMatch, goLobby, assignController, togglePause };
})();
