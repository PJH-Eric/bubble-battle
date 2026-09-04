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

    const range = $('#in-ai-count');
    range.value = store.aiCount;
    range.addEventListener('input', () => {
      $('#ai-count-label').textContent = range.value;
      buildAiLevels(Number(range.value));
    });
    $('#ai-count-label').textContent = range.value;
    buildAiLevels(Number(range.value));
  }

  let aiLevels = [];
  /** 電腦對手用的角色：從玩家選的那一隻往後排，名字就是角色名字 */
  function aiCharFor(i) {
    const list = Characters.CHARACTERS;
    const base = Math.max(0, list.findIndex(c => c.id === store.char));
    return list[(base + 1 + i) % list.length];
  }

  function buildAiLevels(n) {
    while (aiLevels.length < n) aiLevels.push(store.aiLevel);
    aiLevels = aiLevels.slice(0, n);
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

      label.append(avatar, name, sel);
      box.appendChild(label);
    });
  }

  /* ---------- 開一局 ---------- */

  function startMatch(cfg) {
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
          flash(e.by === meId ? '被困住了！左右交替按可以掙脫' : nameOf(e.by) + ' 被困住了');
          break;
        case 'free': audio.play('free'); if (e.by === meId) flash('脫困！短暫無敵'); break;
        case 'dead': audio.play('dead'); flash(nameOf(e.by) + ' 出局'); break;
        case 'over': audio.play('win'); break;
      }
    }
  }

  function itemText(type) {
    return ({
      bomb: '水球 +1', power: '威力 +1', shoe: '跑得更快了', needle: '拿到針',
      shield: '無敵 3 秒！', turtle: '烏龜！變慢了', mini: '迷你水球！威力被壓成 1', reverse: '亂步鞋！方向相反'
    })[type] || '';
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
        (me.needle ? '<br>持有：針' : '');
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
      '<h3>被水柱噴到會怎樣</h3><p>先變成<b>水球泡泡</b>被困住 3.5 秒，這時<b>左右方向交替按</b>可以加快掙脫；脫困後有 1.5 秒無敵。但泡泡狀態下再被炸一次就<b>真的出局</b>。一個人玩的時候沒有人能救你。</p>',
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
      if (to === 'online') { alert('線上對戰是下一階段（M2）的工作，敬請期待！'); return; }
      if (to === 'setup') buildSetup();
      if (to === 'help') { store.seenHelp = true; Store.save(store); }
      show(to);
    }));

    $('#btn-start').addEventListener('click', () => {
      audio.unlock();
      store.nickname = $('#in-nickname').value.trim();
      store.aiCount = Number($('#in-ai-count').value);
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

    input.attach({
      stick: $('#stick'), knob: $('#knob'), stickWrap: $('#stick-wrap'),
      drop: $('#drop'), surface: $('#board-wrap')
    });
    input.onFirstGesture(() => audio.unlock());
    input.setMode(store.control);

    if (!window.matchMedia('(pointer: coarse)').matches) document.body.classList.add('no-touch');
  }

  /* ---------- 啟動 ---------- */

  audio.set('bgm', store.bgm);
  audio.set('sfx', store.sfx);
  buildHome();
  buildHelp();
  bind();
  bindSettings();
  if (!store.seenHelp) show('help');
})(typeof self !== 'undefined' ? self : this);
