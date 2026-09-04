/* ===== app.js — 畫面流程與遊戲迴圈（M0：單機一局從開始玩到結算） ===== */
(function (root) {
  'use strict';

  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));

  const store = Store.load();
  const audio = Audio2.create();
  const input = Input.create();

  const LEVEL_LABEL = { baby: '幼幼班', easy: '簡單', normal: '普通', hard: '困難' };

  let renderer = null;
  let state = null;
  let ai = null;
  let rafId = 0;
  let acc = 0;
  let lastTs = 0;
  let meId = 'me';
  let phase = 'idle';       /* idle | countdown | playing | over */
  let countdown = 0;
  let flashTimer = 0;
  let lastConfig = null;
  let mode = 'solo';        /* 'solo' | 'online' */

  /* ---------- 畫面切換 ---------- */

  function show(id) {
    $$('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + id));
    if (id !== 'game') stopLoop();
  }

  /* ---------- 首頁 ---------- */

  function buildHome() {
    const art = $('.home-art');
    art.innerHTML = '';
    ['cat', 'rabbit', 'penguin'].forEach((id, i) => {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.style.width = (i === 1 ? 34 : 28) + '%';
      svg.style.height = 'auto';
      svg.style.margin = '0 -1%';
      Render.sprite(svg, id);
      art.appendChild(svg);
    });

    const s = store.stats;
    $('#home-stats').textContent = s.matches
      ? '已經打了 ' + s.matches + ' 場，贏了 ' + s.wins + ' 場（勝率 ' + Math.round(s.wins / s.matches * 100) + '%），最長撐了 ' + s.bestSurvive + ' 秒'
      : '第一次來？先看看「怎麼玩」吧';
  }

  /* ---------- 單機設定 ---------- */

  function buildSetup() {
    $('#in-nickname').value = store.nickname;
    $('#in-nickname').oninput = () => {
      store.nickname = $('#in-nickname').value.trim();
      Store.save(store);
      const lobbyBox = $('#lobby-nickname');
      if (lobbyBox) lobbyBox.value = store.nickname;
    };

    const picker = $('#char-picker');
    picker.innerHTML = '';
    for (const ch of Characters.CHARACTERS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.title = ch.name;
      btn.className = ch.id === store.char ? 'on' : '';
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      Render.sprite(svg, ch.id);
      btn.appendChild(svg);
      btn.addEventListener('click', () => {
        store.char = ch.id;
        Store.save(store);
        Array.from(picker.children).forEach(b => b.classList.toggle('on', b === btn));
        buildAiLevels(aiLevels.length);   /* 電腦的角色跟著換，名字才不會撞 */
      });
      picker.appendChild(btn);
    }

    const mapSel = $('#in-map');
    mapSel.innerHTML = '';
    for (const m of Maps.MAPS) {
      mapSel.appendChild(new Option(m.name + '（' + m.desc + '）', m.id));
    }
    mapSel.appendChild(new Option('隨機地圖（每局都不一樣）', 'random'));
    mapSel.value = store.mapPick && (store.mapPick === 'random' || Maps.MAPS.some(m => m.id === store.mapPick))
      ? store.mapPick : Maps.MAPS[1].id;

    const fieldSel = $('#in-field');
    fieldSel.innerHTML = '';
    for (const f of Fields.FIELDS) fieldSel.appendChild(new Option(f.name, f.id));
    fieldSel.value = store.field;

    buildAiLevels(Math.min(7, Math.max(1, Number(store.aiCount) || 3)));
  }

  let aiLevels = [];
  /** 電腦對手用的角色：從玩家選的那一隻往後排，名字就是角色名字 */
  function aiCharFor(i) {
    const list = Characters.CHARACTERS;
    const base = Math.max(0, list.findIndex(c => c.id === store.char));
    return list[(base + 1 + i) % list.length];
  }

  function buildAiLevels(n) {
    n = Math.min(7, Math.max(1, n));
    while (aiLevels.length < n) aiLevels.push(store.aiLevel);
    aiLevels = aiLevels.slice(0, n);
    $('#ai-count-label').textContent = aiLevels.length;
    $('#ai-minus').disabled = aiLevels.length <= 1;
    $('#ai-plus').disabled = aiLevels.length >= 7;
    const box = $('#ai-levels');
    box.innerHTML = '';
    aiLevels.forEach((lv, i) => {
      const ch = aiCharFor(i);
      const label = document.createElement('label');

      const avatar = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      avatar.setAttribute('class', 'who-svg');
      Render.sprite(avatar, ch.id);

      const name = document.createElement('span');
      name.className = 'who-name';
      name.textContent = ch.name;

      const sel = document.createElement('select');
      for (const key of ['baby', 'easy', 'normal', 'hard']) sel.appendChild(new Option(LEVEL_LABEL[key], key));
      sel.value = lv;
      sel.addEventListener('change', () => { aiLevels[i] = sel.value; });

      const kill = document.createElement('button');
      kill.type = 'button';
      kill.className = 'kill-btn';
      kill.title = '移除這個電腦對手';
      kill.setAttribute('aria-label', '移除 ' + ch.name);
      kill.textContent = '×';
      kill.addEventListener('click', () => {
        if (aiLevels.length <= 1) return;
        aiLevels.splice(i, 1);
        buildAiLevels(aiLevels.length);
      });

      label.append(avatar, name, sel, kill);
      box.appendChild(label);
    });
  }

  /* ---------- 開一局 ---------- */

  function startMatch(cfg) {
    mode = 'solo';
    chatDock(false);
    lastConfig = cfg;
    const players = [{
      id: meId, name: cfg.nickname || '小玩家', char: cfg.char, isAI: false
    }];
    cfg.levels.forEach((lv, i) => {
      const ch = aiCharFor(i);
      players.push({ id: 'ai' + i, name: ch.name, char: ch.id, isAI: true, difficulty: lv });
    });

    state = Rules.createMatch({
      seed: String(Date.now()) + ':' + Math.random(),
      mode: 'solo',
      mapId: cfg.mapId === 'random' ? null : cfg.mapId,
      random: cfg.mapId === 'random',
      players
    });
    ai = AI.create();

    if (!renderer) renderer = Render.create($('#board'));
    renderer.setup(state, { field: cfg.field });
    $('#sum-map').textContent = state.mapName;

    input.setMode(store.control);
    input.clear();
    phase = 'countdown';
    countdown = 3;
    $('#countdown').hidden = false;
    $('#countdown').firstElementChild.textContent = '3';

    show('game');
    maybeRotateTip();
    acc = 0;
    lastTs = 0;
    rafId = requestAnimationFrame(loop);
  }

  function stopLoop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function loop(ts) {
    rafId = requestAnimationFrame(loop);
    if (!lastTs) lastTs = ts;
    let dt = (ts - lastTs) / 1000;
    lastTs = ts;
    if (dt > 0.25) dt = 0.25;

    if (mode === 'online') { onlineFrame(dt); return; }

    if (phase === 'countdown') {
      countdown -= dt;
      const n = Math.ceil(countdown);
      $('#countdown').firstElementChild.textContent = n > 0 ? String(n) : '開始！';
      if (countdown <= -0.4) {
        $('#countdown').hidden = true;
        phase = 'playing';
      }
      renderer.draw(state, { meId });
      return;
    }

    if (phase === 'playing') {
      const mine = input.read();
      acc += dt;
      let first = true;
      let guard = 0;
      while (acc >= Rules.STEP && guard++ < 8) {
        const inputs = {};
        inputs[meId] = { dx: mine.dx, dy: mine.dy, drop: first && mine.drop };
        for (const p of state.players) {
          if (p.isAI) inputs[p.id] = ai.input(state, p, Rules.STEP);
        }
        Rules.step(state, inputs, Rules.STEP);
        handleEvents(state.events);
        acc -= Rules.STEP;
        first = false;
        if (state.phase !== 'playing') break;
      }
      updateHud(dt);
      if (state.phase !== 'playing') finish();
    }

    renderer.draw(state, { meId });
  }

  /* ---------- 事件 → 音效與提示 ---------- */

  function handleEvents(events) {
    for (const e of events) {
      switch (e.type) {
        case 'bomb': audio.play('place'); break;
        case 'explode': audio.play('explode'); break;
        case 'box': audio.play('box'); break;
        case 'item': if (e.by === meId) { audio.play('item'); flash(itemText(e.item)); } break;
        case 'trap':
          audio.play('trap');
          flash(e.by === meId ? (myNeedle() ? '被困住了！快按放水球鍵用針戳破泡泡' : '被困住了！泡泡破掉就出局，快叫隊友來救') : nameOf(e.by) + ' 被困住了');
          break;
        case 'free': audio.play('free'); if (e.by === meId) flash(e.how === 'needle' ? '用針戳破泡泡脫困！' : '脫困！短暫無敵'); break;
        case 'dead': audio.play('dead'); flash(nameOf(e.by) + (e.cause === 'bubble' ? ' 的泡泡破掉，出局了' : ' 出局')); break;
        case 'over': audio.play('win'); break;
      }
    }
  }

  function itemText(type) {
    return ({
      bomb: '水球 +1', power: '威力 +1', shoe: '跑得更快了', needle: '拿到針！被關住時按放水球鍵就能戳破泡泡（用一次）',
      shield: '無敵 3 秒！', turtle: '烏龜！變慢了', mini: '迷你水球！威力被壓成 1', reverse: '亂步鞋！方向相反'
    })[type] || '';
  }

  function myNeedle() {
    const src = mode === 'online' ? (net && net.view && net.view.players) : (state && state.players);
    const me = (src || []).find(p => p.id === meId);
    return !!(me && me.needle);
  }

  function nameOf(id) {
    const p = state.players.find(q => q.id === id);
    return p ? p.name : '';
  }

  function flash(text) {
    $('#sum-flash').textContent = text;
    flashTimer = 2.4;
  }

  /* ---------- 左側 Summary ---------- */

  function updateHud(dt) {
    const left = Math.max(0, state.duration - state.time);
    const mm = Math.floor(left / 60), ss = Math.floor(left % 60);
    const clock = $('#clock');
    clock.textContent = mm + ':' + String(ss).padStart(2, '0');

    const list = $('#sum-players');
    if (list.children.length !== state.players.length) {
      list.innerHTML = '';
      for (const p of state.players) {
        const li = document.createElement('li');
        li.dataset.id = p.id;
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.style.background = Characters.byId(p.char).body;
        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = p.name;
        const tag = document.createElement('span');
        tag.className = 'tag';
        li.append(dot, who, tag);
        list.appendChild(li);
      }
    }
    for (const li of list.children) {
      const p = state.players.find(q => q.id === li.dataset.id);
      li.classList.toggle('me', p.id === meId);
      li.classList.toggle('out', p.state === 'dead');
      li.classList.toggle('trapped', p.state === 'trapped');
      li.lastChild.textContent = p.state === 'dead' ? '出局'
        : p.state === 'trapped' ? '泡泡 ' + Math.max(0, p.trapTimer).toFixed(1) + 's'
          : p.isAI ? LEVEL_LABEL[p.difficulty] : '你';
    }

    const me = state.players.find(p => p.id === meId);
    if (me) {
      $('#sum-mine').innerHTML =
        '水球 <b>' + me.bombMax + '</b>　威力 <b>' + me.power + '</b><br>' +
        '速度 <b>' + me.speed.toFixed(2) + '</b>　破箱 <b>' + me.stats.boxes + '</b>' +
        (me.needle ? '<br>持有：<b>針</b>（被關住時按放水球鍵脫困）' : '');
    }

    if (flashTimer > 0) {
      flashTimer -= dt;
      if (flashTimer <= 0) $('#sum-flash').textContent = '';
    }
  }

  /* ---------- 結算 ---------- */

  function finish() {
    phase = 'over';
    const me = state.players.find(p => p.id === meId);
    const winner = state.winner ? state.players.find(p => p.id === state.winner) : null;
    const win = !!winner && winner.id === meId;

    Store.record(store, {
      win,
      survived: me ? me.stats.survived || state.time : 0,
      boxes: me ? me.stats.boxes : 0,
      items: me ? me.stats.items : 0,
      char: me ? me.char : null
    });

    $('#btn-again').hidden = false;
    Render.sprite($('#winner-svg'), winner ? winner.char : (me ? me.char : 'cat'));
    $('#result-title').textContent = winner
      ? (win ? '你贏了！' : winner.name + ' 獲勝')
      : '平手';
    const shown = winner || me;
    $('#result-line').textContent = shown
      ? '存活 ' + Math.round(shown.stats.survived || state.time) + ' 秒 ・ 破箱 ' + shown.stats.boxes + ' 個'
        + (state.reason === 'timeup' ? '（時間到）' : '')
      : '';
    buildHome();
    setTimeout(() => show('result'), 900);
  }

  /* ---------- 手機直向提示 ---------- */

  function maybeRotateTip() {
    if (store.seenRotateTip) return;
    const portrait = window.matchMedia('(orientation: portrait)').matches;
    const narrow = Math.min(window.innerWidth, window.innerHeight) < 560;
    if (!portrait || !narrow) return;
    $('#rotate-tip').hidden = false;
  }

  /* ---------- 說明 ---------- */

  function buildHelp() {
    $('#help-body').innerHTML = [
      '<h3>怎麼動</h3><p>電腦：方向鍵或 WASD 移動，空白鍵放水球。平板手機：左下搖桿移動，右下大鈕放水球（設定裡可以改成全螢幕滑動）。</p>',
      '<h3>水球會怎麼炸</h3><p>放下去 3 秒後爆炸，水柱往上下左右噴，長度就是你的「威力」。硬塊擋得住、軟箱會被炸掉，炸到別顆水球會連鎖引爆。<b>不會事先顯示範圍</b>，水球越跳越快就是要爆了。</p>',
      '<h3>被水柱噴到會怎樣</h3><p>你會變成<b>水球泡泡</b>被關住，完全不能動，而且<b>泡泡一破就出局</b>（個人混戰撐 3.5 秒、組隊 5 秒）。想活下來只有兩條路：<b>隊友</b>走到你身上把你救出來，或是身上有<b>針</b>——按<b>放水球鍵</b>就能戳破泡泡脫困，針用掉就沒了。被救出來後有 1.5 秒無敵；泡泡狀態下再被炸一次也是直接出局。</p>',
      '<h3>道具</h3><p><b>圓底</b>是好道具：水球+1、威力+1、溜冰鞋、針、護盾糖。<b>三角底</b>是壞道具：烏龜（變慢）、迷你水球（威力剩 1）、亂步鞋（方向相反）。被淘汰的人會噴出一半道具給大家撿。</p>',
      '<h3>怎麼算贏</h3><p>最後一個沒出局的人獲勝。一局最長 3 分鐘，時間到就比誰還活著、再比誰炸的箱子多。<b>對局中地圖不會自己改變</b>，只有被你們炸掉的軟箱會消失。</p>'
    ].join('');
  }

  /* ---------- 設定 ---------- */

  function openSettings() {
    $('#set-bgm').checked = store.bgm;
    $('#set-sfx').checked = store.sfx;
    $('#set-bgm-vol').value = store.bgmVol;
    $('#set-sfx-vol').value = store.sfxVol;
    $('#set-motion').checked = store.reduceMotion;
    $('#set-control').value = store.control;
    $('#modal-settings').hidden = false;
    $('#set-close').focus();
  }
  function closeSettings() { $('#modal-settings').hidden = true; }

  function bindSettings() {
    $('#btn-settings').addEventListener('click', () => { audio.unlock(); openSettings(); });
    $('#set-close').addEventListener('click', closeSettings);
    $('#modal-settings').addEventListener('click', e => { if (e.target.id === 'modal-settings') closeSettings(); });
    window.addEventListener('keydown', e => { if (e.code === 'Escape' && !$('#modal-settings').hidden) closeSettings(); });

    const sync = () => {
      store.bgm = $('#set-bgm').checked;
      store.sfx = $('#set-sfx').checked;
      store.bgmVol = Number($('#set-bgm-vol').value);
      store.sfxVol = Number($('#set-sfx-vol').value);
      store.reduceMotion = $('#set-motion').checked;
      store.control = $('#set-control').value;
      Store.save(store);
      audio.set('bgm', store.bgm);
      audio.set('sfx', store.sfx);
      audio.set('bgmVol', store.bgmVol);
      audio.set('sfxVol', store.sfxVol);
      input.setMode(store.control);
    };
    ['#set-bgm', '#set-sfx', '#set-bgm-vol', '#set-sfx-vol', '#set-motion', '#set-control']
      .forEach(sel => $(sel).addEventListener('change', sync));
    $('#set-bgm-vol').addEventListener('input', sync);
    $('#set-sfx-vol').addEventListener('input', sync);

    $('#set-reset').addEventListener('click', () => {
      Object.assign(store, JSON.parse(JSON.stringify(Store.DEFAULTS)), { stats: store.stats });
      Store.save(store);
      openSettings();
      input.setMode(store.control);
    });
    $('#set-clear').addEventListener('click', () => {
      store.stats = JSON.parse(JSON.stringify(Store.DEFAULTS.stats));
      Store.save(store);
      buildHome();
      flash('戰績已清除');
    });
  }

  /* ---------- 綁定 ---------- */

  function bind() {
    $$('[data-go]').forEach(btn => btn.addEventListener('click', () => {
      audio.unlock();
      const to = btn.dataset.go;
      if (to === 'online') { goOnline(); return; }
      if (to === 'setup') buildSetup();
      if (to === 'help') { store.seenHelp = true; Store.save(store); }
      show(to);
    }));

    $('#btn-start').addEventListener('click', () => {
      audio.unlock();
      store.nickname = $('#in-nickname').value.trim();
      store.aiCount = aiLevels.length;
      store.aiLevel = aiLevels[0] || 'normal';
      store.mapPick = $('#in-map').value;
      store.field = $('#in-field').value;
      Store.save(store);
      startMatch({
        nickname: store.nickname,
        char: store.char,
        levels: aiLevels.slice(),
        mapId: store.mapPick,
        field: store.field
      });
    });

    $('#btn-again').addEventListener('click', () => { if (lastConfig) startMatch(lastConfig); });
    $('#btn-quit').addEventListener('click', () => { stopLoop(); phase = 'idle'; buildHome(); show('home'); });
    $('#btn-rotate-ok').addEventListener('click', () => {
      $('#rotate-tip').hidden = true;
      store.seenRotateTip = true;
      Store.save(store);
    });

    $('#ai-plus').addEventListener('click', () => buildAiLevels(aiLevels.length + 1));
    $('#ai-minus').addEventListener('click', () => buildAiLevels(aiLevels.length - 1));

    input.attach({
      stick: $('#stick'), knob: $('#knob'), stickWrap: $('#stick-wrap'),
      drop: $('#drop'), surface: $('#board-wrap')
    });
    input.onFirstGesture(() => audio.unlock());
    input.setMode(store.control);

    if (!window.matchMedia('(pointer: coarse)').matches) document.body.classList.add('no-touch');
  }


  /* =====================================================================
   *  線上對戰
   * ===================================================================== */

  let online = null;
  let net = null;
  let roomView = null;
  let onlineBoardKey = '';
  let unread = 0;
  let chatOpen = false;
  let inputTimer = 0;
  let lastSentInput = { dx: 0, dy: 0 };
  let inputSeq = 0;

  const QUICK_WORDS = ['好啊！', '救我！', '小心！', '等我一下', 'GG', '哈哈'];
  const esc = t => String(t == null ? '' : t).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function ensureOnline() {
    if (online) return online;
    online = Online.create();
    net = Net.create();
    try { online.id = localStorage.getItem('bubble-battle:id') || null; } catch (e) { /* 忽略 */ }

    online.on('status', st => {
      const el = $('#conn-state');
      const text = {
        connecting: '連線中…', reconnecting: '連線斷了，正在重新連…',
        online: '已連線', offline: '沒有連線'
      }[st.state] || '';
      el.textContent = text + (st.msg ? '（' + st.msg + '）' : '');
      el.className = 'conn ' + (st.state === 'online' ? 'ok' : st.state === 'offline' ? 'bad' : '');
    });
    online.on('lobby', m => renderLobby(m.rooms));
    online.on('room', m => onRoom(m.room));
    online.on('snap', m => onSnap(m));
    online.on('error', m => flash(m.msg));
    online.on('notice', m => flash(m.msg));
    online.on('kicked', () => { roomView = null; flash('你被房主請出房間了'); backToLobby(); });
    online.on('left', () => { roomView = null; backToLobby(); });
    return online;
  }

  function goOnline(inviteToken) {
    ensureOnline();
    $('#lobby-nickname').value = store.nickname;
    const server = Config.serverUrl;
    if (!server) {
      alert('這個頁面沒有可以連的伺服器。請用「啟動遊戲.bat」開起來，或在網址加上 ?server=伺服器網址。');
      return;
    }
    if (!online.connected) online.connect(server, { name: store.nickname || '玩家', char: store.char });
    else online.send({ t: 'lobby' });

    if (inviteToken) {
      const useIt = () => online.send({ t: 'invite:use', token: inviteToken });
      if (online.connected) useIt();
      else setTimeout(useIt, 900);
    }
    show('lobby');
  }

  function backToLobby() {
    stopLoop();
    mode = 'solo';
    phase = 'idle';
    chatDock(false);
    if (online && online.connected) online.send({ t: 'lobby' });
    show('lobby');
  }

  function renderLobby(rooms) {
    const box = $('#room-list');
    box.innerHTML = '';
    if (!rooms || !rooms.length) {
      box.innerHTML = '<div class="room-empty">現在沒有人開房間。<br>按「快速加入」會自動幫你開一間等人來。</div>';
      return;
    }
    for (const r of rooms) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'room-card';
      const playing = r.phase !== 'lobby';
      card.innerHTML =
        '<div class="rc-main"><div class="rc-name">' + esc(r.name) + '</div>' +
        '<div class="rc-sub">' + (r.mode === 'team' ? '組隊' : '個人混戰') + ' ・ ' + esc(r.mapName) +
        ' ・ 房主 ' + esc(r.hostName) + (r.spectators ? ' ・ 觀戰 ' + r.spectators : '') + '</div></div>' +
        '<span class="rc-tag' + (playing ? ' playing' : '') + '">' + (playing ? '進行中' : '等待中') + '</span>' +
        '<span class="rc-count">' + r.players + '/' + r.maxPlayers + '</span>';
      card.addEventListener('click', () =>
        online.send({ t: 'join', roomId: r.id, role: playing ? 'spectator' : 'player' }));
      box.appendChild(card);
    }
  }

  function onRoom(view) {
    const first = !roomView;
    roomView = view;
    renderChat(view.chat);
    chatDock(true);

    if (view.phase === 'lobby') {
      if (mode === 'online' && phase !== 'idle') { stopLoop(); phase = 'idle'; }
      mode = 'solo';
      renderRoom(view);
      show('room');
      return;
    }
    if (!$('#screen-game').classList.contains('active')) startOnlineMatch();
    if (view.phase === 'countdown') {
      $('#countdown').hidden = false;
      $('#countdown').firstElementChild.textContent = String(Math.max(1, Math.ceil(view.countdownMs / 1000)));
    }
    if (first) show('game');
  }

  function pickField(label, key, options, value, editable) {
    const wrap = document.createElement('label');
    if (!editable) wrap.className = 'ro';
    wrap.textContent = label;
    const sel = document.createElement('select');
    for (const [v, text] of options) sel.appendChild(new Option(text, v));
    sel.value = String(value);
    sel.disabled = !editable;
    sel.addEventListener('change', () => {
      const msg = { t: 'setup' };
      msg[key] = key === 'maxPlayers' ? Number(sel.value)
        : key === 'negativeItems' ? sel.value === '1' : sel.value;
      online.send(msg);
    });
    wrap.appendChild(sel);
    return wrap;
  }

  function seatRow(view, who, isAI) {
    const li = document.createElement('li');
    if (!isAI && who.id === view.yourId) li.classList.add('me');
    if (!isAI && who.ready) li.classList.add('ready');

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'seat-svg');
    Render.sprite(svg, who.char);

    const name = document.createElement('span');
    name.className = 'seat-name';
    name.textContent = who.name + (isAI ? '（' + who.label + '）' : '');
    li.append(svg, name);

    if (view.mode === 'team') {
      const team = document.createElement('span');
      team.className = 'team t' + (who.team % 2);
      team.textContent = who.team % 2 === 0 ? '藍隊' : '紅隊';
      li.appendChild(team);
    }

    const tag = document.createElement('span');
    tag.className = 'seat-tag' + (!isAI && who.ready ? ' on' : '');
    tag.textContent = isAI ? '電腦' : (!who.connected ? '斷線中' : who.ready ? '已準備' : '還沒準備');
    li.appendChild(tag);

    if (view.youAreHost) {
      const kill = document.createElement('button');
      kill.className = 'kill-btn';
      kill.textContent = '×';
      kill.title = isAI ? '移除這個電腦' : '把這個人請出房間';
      if (!isAI && who.id === view.yourId) kill.disabled = true;
      kill.addEventListener('click', () =>
        online.send(isAI ? { t: 'ai:remove', id: who.id } : { t: 'kick', id: who.id }));
      li.appendChild(kill);
    }
    return li;
  }

  function renderRoom(view) {
    $('#room-title').textContent = view.name + (view.youAreHost ? '（你是房主）' : '');
    const host = view.youAreHost;

    const setup = $('#room-setup');
    setup.innerHTML = '';
    setup.appendChild(pickField('模式', 'mode', [['solo', '個人混戰'], ['team', '組隊對戰']], view.mode, host));
    setup.appendChild(pickField('人數上限', 'maxPlayers',
      [2, 3, 4, 5, 6, 7, 8].map(n => [String(n), n + ' 人']), String(view.maxPlayers), host));
    setup.appendChild(pickField('地圖', 'mapId',
      Maps.MAPS.map(m => [m.id, m.name]).concat([['random', '隨機地圖']]), view.mapId, host));
    setup.appendChild(pickField('場景外觀', 'field',
      Fields.FIELDS.map(f => [f.id, f.name]), view.field, host));
    setup.appendChild(pickField('負面道具', 'negativeItems',
      [['1', '開啟'], ['0', '關閉']], view.negativeItems ? '1' : '0', host));

    const seatList = $('#seat-list');
    seatList.innerHTML = '';
    const players = view.members.filter(m => m.role === 'player');
    $('#seat-count').textContent = (players.length + view.ais.length) + ' / ' + view.maxPlayers;
    for (const m of players) seatList.appendChild(seatRow(view, m, false));
    for (const a of view.ais) seatList.appendChild(seatRow(view, a, true));

    const watchers = view.members.filter(m => m.role === 'spectator');
    $('#spectator-line').textContent = watchers.length
      ? '觀戰中：' + watchers.map(w => w.name).join('、') : '目前沒有人觀戰';

    const aiRow = $('#ai-row');
    aiRow.innerHTML = '';
    if (host) {
      const label = document.createElement('span');
      label.style.cssText = 'font-size:.82rem;font-weight:700;align-self:center';
      label.textContent = '加電腦對手：';
      aiRow.appendChild(label);
      for (const [lv, name] of [['baby', '幼幼班'], ['easy', '簡單'], ['normal', '普通'], ['hard', '困難']]) {
        const b = document.createElement('button');
        b.className = 'mini-btn';
        b.textContent = '＋' + name;
        b.addEventListener('click', () => online.send({ t: 'ai:add', level: lv }));
        aiRow.appendChild(b);
      }
    }

    const meMember = view.members.find(m => m.id === view.yourId);
    const iAmPlayer = meMember && meMember.role === 'player';
    $('#btn-seat-toggle').textContent = iAmPlayer ? '改成觀戰' : '我要入座';
    $('#btn-ready').hidden = !iAmPlayer;
    $('#btn-ready').textContent = meMember && meMember.ready ? '取消準備' : '準備好了';
    $('#btn-ready').classList.toggle('primary', !(meMember && meMember.ready));
    $('#btn-host-start').hidden = !host;
    $('#btn-host-start').disabled = !view.canStart;
    $('#btn-invite').hidden = !host;

    if (view.invite) {
      const box = $('#invite-box');
      box.hidden = false;
      const link = location.origin + location.pathname + '?invite=' + view.invite;
      box.innerHTML = '<div>把這個連結傳給朋友，他點了就會直接進到這個房間（房間還在就一直有效）：</div>' +
        '<div style="margin-top:6px;font-weight:700">' + esc(link) + '</div>' +
        '<div class="row-btns"><button class="mini-btn" id="btn-copy-invite">複製連結</button>' +
        '<button class="mini-btn danger" id="btn-revoke-invite">撤銷</button></div>';
      $('#btn-copy-invite').addEventListener('click', () => {
        try { navigator.clipboard.writeText(link); flash('連結複製好了'); }
        catch (e) { flash('複製失敗，請手動選取'); }
      });
      $('#btn-revoke-invite').addEventListener('click', () => online.send({ t: 'invite:revoke' }));
    } else {
      $('#invite-box').hidden = true;
    }
  }

  /* ---------- 線上對局 ---------- */

  function startOnlineMatch() {
    mode = 'online';
    phase = 'playing';
    net.reset();
    net.clearLocal();
    onlineBoardKey = '';
    input.setMode(store.control);
    input.clear();
    show('game');
    maybeRotateTip();
    lastTs = 0;
    stopLoop();
    rafId = requestAnimationFrame(loop);
  }

  function onSnap(msg) {
    if (mode !== 'online') startOnlineMatch();
    meId = msg.you;
    net.onSnapshot(msg, msg.you);
    $('#watch-badge').hidden = msg.role !== 'spectator';
    if (msg.ev && msg.ev.length) handleEvents(msg.ev);
    if (msg.matchPhase && msg.matchPhase !== 'playing') {
      $('#countdown').hidden = true;
      showOnlineResult(msg);
    }
  }

  let resultShownFor = 0;
  function showOnlineResult(msg) {
    if (resultShownFor === msg.tick || !msg.standings) return;
    resultShownFor = msg.tick;
    stopLoop();
    mode = 'solo';        /* 先停掉對局迴圈，房間狀態回到大廳時會再帶你回房間 */
    phase = 'idle';

    const winner = msg.winner ? msg.standings.find(p => p.id === msg.winner) : null;
    const me = msg.standings.find(p => p.id === meId);
    const shown = winner || me || msg.standings[0];
    Render.sprite($('#winner-svg'), shown ? shown.char : 'cat');
    $('#result-title').textContent = msg.resultText || '這一局結束了';
    $('#result-line').textContent = shown
      ? '存活 ' + shown.survived + ' 秒 ・ 破箱 ' + shown.boxes + ' 個' +
        (msg.reason === 'timeup' ? '（時間到）' : '') + '　8 秒後回到房間'
      : '';
    $('#btn-again').hidden = true;
    show('result');

    if (me) {
      Store.record(store, {
        win: !!winner && winner.id === meId,
        survived: me.survived, boxes: me.boxes, items: 0, char: me.char
      });
      buildHome();
    }
  }

  function onlineFrame(dt) {
    const mine = input.read();
    const view = net.frame(dt, mine);
    if (!view) return;

    const key = view.cols + 'x' + view.rows + ':' + view.mapName;
    if (key !== onlineBoardKey) {
      onlineBoardKey = key;
      if (!renderer) renderer = Render.create($('#board'));
      renderer.setup(view, { field: (roomView && roomView.field) || store.field });
      $('#sum-map').textContent = view.mapName || '';
      $('#countdown').hidden = true;
    }

    inputTimer -= dt;
    const changed = mine.dx !== lastSentInput.dx || mine.dy !== lastSentInput.dy;
    if (mine.drop || changed || inputTimer <= 0) {
      inputTimer = 0.05;
      lastSentInput = { dx: mine.dx, dy: mine.dy };
      online.send({ t: 'input', seq: ++inputSeq, dx: mine.dx, dy: mine.dy, drop: mine.drop });
    }

    renderer.draw(view, { meId });
    updateOnlineHud(view, dt);
  }

  function updateOnlineHud(view, dt) {
    const left = Math.max(0, (view.duration || 180) - (view.time || 0));
    $('#clock').textContent = Math.floor(left / 60) + ':' + String(Math.floor(left % 60)).padStart(2, '0');

    const list = $('#sum-players');
    if (list.children.length !== view.players.length) {
      list.innerHTML = '';
      for (const p of view.players) {
        const li = document.createElement('li');
        li.dataset.id = p.id;
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.style.background = Characters.byId(p.char).body;
        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = p.name;
        const tag = document.createElement('span');
        tag.className = 'tag';
        li.append(dot, who, tag);
        list.appendChild(li);
      }
    }
    for (const li of list.children) {
      const p = view.players.find(q => q.id === li.dataset.id);
      if (!p) continue;
      li.classList.toggle('me', p.id === meId);
      li.classList.toggle('out', p.state === 'dead');
      li.classList.toggle('trapped', p.state === 'trapped');
      li.lastChild.textContent = p.state === 'dead' ? '出局'
        : p.state === 'trapped' ? '泡泡 ' + Number(p.trapTimer).toFixed(1) + 's'
          : (view.mode === 'team' ? (p.team % 2 === 0 ? '藍隊' : '紅隊') : '');
    }

    const me = view.players.find(p => p.id === meId);
    $('#sum-mine').innerHTML = me
      ? '水球 <b>' + me.bombMax + '</b>　威力 <b>' + me.power + '</b><br>速度 <b>' +
        Number(me.speed).toFixed(2) + '</b>　破箱 <b>' + me.boxes + '</b>' +
        (me.needle ? '<br>持有：<b>針</b>（被關住時按放水球鍵脫困）' : '') +
        (me.glove ? '<br>持有：<b>手套</b>（可以踢水球）' : '')
      : '你正在觀戰';

    if (flashTimer > 0) {
      flashTimer -= dt;
      if (flashTimer <= 0) $('#sum-flash').textContent = '';
    }
  }

  /* ---------- 聊天室 ---------- */

  function chatDock(showIt) {
    $('#chat-dock').hidden = !showIt;
    if (!showIt) { $('#chat-panel').hidden = true; chatOpen = false; }
  }

  function renderChat(lines) {
    const log = $('#chat-log');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 30;
    const before = log.childElementCount;
    log.innerHTML = '';
    for (const line of lines || []) {
      const div = document.createElement('div');
      div.className = 'line' + (line.role === 'system' ? ' system' : line.role === 'spectator' ? ' watch' : '');
      div.innerHTML = line.role === 'system'
        ? esc(line.text)
        : '<b>' + esc(line.name) + (line.role === 'spectator' ? '（觀戰）' : '') + '：</b> ' + esc(line.text);
      log.appendChild(div);
    }
    if (atBottom) log.scrollTop = log.scrollHeight;
    if (!chatOpen && lines && lines.length > before) {
      unread += lines.length - before;
      const badge = $('#chat-unread');
      badge.hidden = false;
      badge.textContent = unread > 99 ? '99+' : String(unread);
    }
  }

  function bindOnline() {
    $('#lobby-nickname').addEventListener('input', () => {
      store.nickname = $('#lobby-nickname').value.trim();
      Store.save(store);
      const box = $('#in-nickname');
      if (box) box.value = store.nickname;
      if (online) {
        online.identity.name = store.nickname || '玩家';
        online.send({ t: 'hello', id: online.id, name: online.identity.name, char: store.char });
      }
    });

    $('#btn-quick').addEventListener('click', () => online && online.send({ t: 'quick' }));
    $('#btn-create').addEventListener('click', () => online && online.send({
      t: 'create', name: (store.nickname || '玩家') + ' 的房間',
      mode: 'solo', maxPlayers: 4, mapId: store.mapPick, field: store.field
    }));
    $('#btn-ready').addEventListener('click', () => {
      const me = roomView && roomView.members.find(m => m.id === roomView.yourId);
      online.send({ t: 'ready', ready: !(me && me.ready) });
    });
    $('#btn-host-start').addEventListener('click', () => online.send({ t: 'start' }));
    $('#btn-seat-toggle').addEventListener('click', () => {
      const me = roomView && roomView.members.find(m => m.id === roomView.yourId);
      online.send({ t: 'seat', want: me && me.role === 'player' ? 'spectator' : 'player' });
    });
    $('#btn-invite').addEventListener('click', () => online.send({ t: 'invite:new' }));
    $('#btn-leave-room').addEventListener('click', () => online.send({ t: 'leave' }));

    const quick = $('#chat-quick');
    for (const word of QUICK_WORDS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = word;
      b.addEventListener('click', () => online && online.send({ t: 'chat', text: word }));
      quick.appendChild(b);
    }
    $('#chat-toggle').addEventListener('click', () => {
      chatOpen = !chatOpen;
      $('#chat-panel').hidden = !chatOpen;
      if (chatOpen) {
        unread = 0;
        $('#chat-unread').hidden = true;
        const log = $('#chat-log');
        log.scrollTop = log.scrollHeight;
      }
    });
    $('#chat-form').addEventListener('submit', e => {
      e.preventDefault();
      const box = $('#chat-input');
      const text = box.value.trim();
      if (!text || !online) return;
      online.send({ t: 'chat', text });
      box.value = '';
    });
  }

  /* ---------- 啟動 ---------- */

  audio.set('bgm', store.bgm);
  audio.set('sfx', store.sfx);
  buildHome();
  buildHelp();
  bind();
  bindSettings();
  bindOnline();

  /* 有人用邀請連結進來 → 直接連進那個房間 */
  try {
    const invite = new URLSearchParams(location.search).get('invite');
    if (invite) goOnline(invite);
  } catch (e) { /* 忽略 */ }
  if (!store.seenHelp) show('help');
})(typeof self !== 'undefined' ? self : this);
