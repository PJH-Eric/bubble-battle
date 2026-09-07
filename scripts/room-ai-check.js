/* ===== scripts/room-ai-check.js — 開線上房間、加電腦對手、真的玩一輪 =====
 * 走的是跟真人完全一樣的路徑：建房 → 加三個電腦 → 準備 → 開始 → 倒數 → 對打。
 * 顧的是「玩起來」的兩件事：倒數畫面會不會動，以及按下去到看到要多久。
 * 執行：npm run test:room-ai
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { tinyClient } = require('./lib/tiny-ws.js');

let fail = 0;
function ok(cond, name, extra) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (!cond && extra != null ? '  → ' + extra : ''));
  if (!cond) fail++;
}

const PUB = path.join(__dirname, '..', 'public', 'js');
const scope = { Rules: require(path.join(PUB, 'rules.js')), Maps: require(path.join(PUB, 'maps.js')) };
new Function('self', fs.readFileSync(path.join(PUB, 'net.js'), 'utf8'))(scope);

/* 想看看網路差一點會怎樣就加 --lag=120 */
const LAG = Number((process.argv.find(s => s.startsWith('--lag=')) || '').slice(6)) || 0;
const HALF = LAG / 2;

const PORT = 3974;
process.env.PORT = String(PORT);
require('../server.js');

console.log('\n開房間 + 三個電腦對手，真的玩一輪' + (LAG ? '（模擬來回 ' + LAG + 'ms）' : ''));

const client = scope.Net.create();
const me = { id: null };
const rooms = [];               /* 收到的每一則 room 訊息 */
const snaps = [];
let started = false, firstSnapAt = 0;

const laggy = s => HALF ? { send: o => setTimeout(() => s.send(o), HALF).unref(), end: () => s.end() } : s;
const wire = fn => m => HALF ? setTimeout(() => fn(m), HALF).unref() : fn(m);

const raw = tinyClient(PORT, wire(m => {
  if (m.t === 'welcome') me.id = m.id;
  if (m.t === 'room') rooms.push({ at: performance.now(), room: m.room });
  if (m.t === 'snap') {
    if (!started) { started = true; firstSnapAt = performance.now(); }
    snaps.push({ at: performance.now(), snap: m });
    client.onSnapshot(m, m.you);
  }
}));
const a = laggy(raw);

let readyAt = 0, startedSendAt = 0;

setTimeout(() => a.send({ t: 'hello', name: '玩家甲', char: 'cat' }), 150);
setTimeout(() => a.send({ t: 'create', name: '單人打電腦', mapId: 'open' }), 350);
setTimeout(() => {
  a.send({ t: 'ai:add', level: 'easy' });
  a.send({ t: 'ai:add', level: 'normal' });
  a.send({ t: 'ai:add', level: 'hard' });
}, 600);
setTimeout(() => { readyAt = performance.now(); a.send({ t: 'ready', ready: true }); }, 900);
setTimeout(() => { startedSendAt = performance.now(); a.send({ t: 'start' }); }, 1100);

/* ---- 對局開始之後：走一段、放一顆球、再走一段 ---- */

const WATCH = 4.0;              /* 對打幾秒 */
let t0 = 0, seq = 0;
let movePressAt = 0, moveSeenAt = 0, moveFromX = 0;
let dropPressAt = 0, dropSeenAt = 0;
let aiMoved = 0, aiBombs = 0;
const aiStart = new Map();
let dropped = false;

const timer = setInterval(() => {
  if (!started || !me.id) return;
  const now = performance.now();
  if (!t0) { t0 = now; return; }
  const el = (now - t0) / 1000;
  if (el > WATCH) { clearInterval(timer); finish(); return; }

  const v = client.view;
  const mine = v && v.players.find(p => p.id === me.id);

  /* 電腦對手有沒有真的在動、有沒有真的在放球 */
  if (v) {
    for (const p of v.players) {
      if (p.id === me.id) continue;
      if (!aiStart.has(p.id)) aiStart.set(p.id, { x: p.x, y: p.y });
      const s0 = aiStart.get(p.id);
      if (Math.hypot(p.x - s0.x, p.y - s0.y) > 0.5) aiMoved = Math.max(aiMoved, 1);
    }
    aiBombs = Math.max(aiBombs, v.bombs.filter(b => b.owner && b.owner !== me.id).length);
  }

  let dx = 0, dy = 0, drop = false;

  if (el < 0.4) {
    /* 先站著，讓畫面穩下來 */
  } else if (el < 1.4) {
    dx = 1;
    if (!movePressAt) { movePressAt = now; moveFromX = mine ? mine.x : 0; }
    if (!moveSeenAt && mine && Math.abs(mine.x - moveFromX) > 0.02) moveSeenAt = now;
  } else if (!dropped) {
    drop = true; dropped = true; dropPressAt = now;
  } else {
    if (!dropSeenAt && v && v.bombs.some(b => b.owner === me.id)) dropSeenAt = now;
    /* 放完就閃開，不要被自己炸到 */
    dx = -1;
  }

  a.send({ t: 'input', seq: ++seq, ct: performance.now(), dx, dy, drop });
  client.frame(1 / 60, { dx, dy, drop });
}, 16);

function finish() {
  /* ---- 房間：電腦對手真的加進去了嗎 ---- */
  const lobbyRoom = rooms.map(r => r.room).filter(r => r.phase === 'lobby').pop();
  ok(lobbyRoom && lobbyRoom.ais.length === 3, '房間裡加得進三個電腦對手',
    lobbyRoom && lobbyRoom.ais.length);
  ok(lobbyRoom && ['easy', 'normal', 'hard'].every(l => lobbyRoom.ais.some(x => x.level === l)),
    '三個電腦的難度各自不同',
    lobbyRoom && lobbyRoom.ais.map(x => x.level).join(','));

  /* ---- 倒數：伺服器只推一次，所以畫面一定得自己數 ---- */
  const cd = rooms.filter(r => r.room.phase === 'countdown');
  ok(cd.length >= 1, '按下開始之後會進入倒數', cd.length);
  ok(cd.length && cd[0].room.countdownMs > 2000 && cd[0].room.countdownMs <= 3000,
    '倒數訊息帶著剩餘毫秒數（前端才數得出 3、2、1）',
    cd.length && cd[0].room.countdownMs);
  ok(cd.length === 1,
    '倒數這三秒伺服器不會再推房間狀態 —— 所以倒數畫面必須由前端自己每一幀更新',
    cd.length + ' 則');
  const cdToPlay = cd.length && firstSnapAt ? (firstSnapAt - cd[0].at) / 1000 : 0;
  ok(cdToPlay > 2 && cdToPlay < 4.5, '倒數大約三秒之後對局才真的開始',
    cdToPlay.toFixed(2) + ' 秒');

  /* ---- 對局：電腦有在玩嗎 ---- */
  ok(snaps.length > 60, '對局期間快照一直有進來', snaps.length + ' 份');
  const lastSnap = snaps[snaps.length - 1].snap;
  ok(lastSnap.players.length === 4, '場上是一個真人加三個電腦', lastSnap.players.length);
  ok(aiMoved === 1, '電腦對手真的會走動');
  ok(aiBombs > 0, '電腦對手真的會放水球', aiBombs);

  /* ---- 手感：按下去到看到要多久 ---- */
  const moveMs = moveSeenAt && movePressAt ? moveSeenAt - movePressAt : -1;
  const dropMs = dropSeenAt && dropPressAt ? dropSeenAt - dropPressAt : -1;
  console.log('    （按方向鍵 → 角色動 ' + moveMs.toFixed(0) +
    'ms、按放球 → 看到水球 ' + dropMs.toFixed(0) + 'ms）');
  ok(moveMs >= 0 && moveMs < 50, '按方向鍵幾乎立刻就動（本地預測）', moveMs.toFixed(0) + 'ms');
  ok(dropMs >= 0 && dropMs < 50, '按放球幾乎立刻就看到水球（本地預測）', dropMs.toFixed(0) + 'ms');

  /* 幽靈水球要交棒給伺服器的那顆，不能一直留在畫面上 */
  const myBombs = client.view ? client.view.bombs.filter(b => b.owner === me.id) : [];
  ok(myBombs.length <= 1, '自己的水球不會又是預測的又是伺服器的，重複畫兩顆',
    myBombs.length + ' 顆');

  raw.end();
  console.log('\n────────────────────────────');
  console.log(fail ? fail + ' 項未通過' : '全部通過');
  process.exit(fail ? 1 : 0);
}

setTimeout(() => {
  console.log('  ✗ 逾時：對局沒有跑起來');
  process.exit(1);
}, 30000).unref();
