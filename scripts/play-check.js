/* ===== scripts/play-check.js — 線上「真的在玩」的端對端檢查 =====
 * 走位由 netcode-check.js 顧，這支顧的是互動：放水球、爆炸、炸掉軟箱、
 * 地圖增量同步、被炸到、觀戰者看到的是不是同一場。
 * 執行：npm run test:play
 */
'use strict';

const path = require('path');
const { tinyClient } = require('./lib/tiny-ws.js');

let fail = 0;
function ok(cond, name, extra) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (!cond && extra != null ? '  → ' + extra : ''));
  if (!cond) fail++;
}

const PUB = path.join(__dirname, '..', 'public', 'js');
const Rules = require(path.join(PUB, 'rules.js'));
const Maps = require(path.join(PUB, 'maps.js'));
const EMPTY = Maps.EMPTY, SOFT = Maps.SOFT;

const PORT = 3973;
process.env.PORT = String(PORT);
require('../server.js');

console.log('\n互動：放水球、爆炸、地圖同步');

/* A 是被操作的玩家，B、B2 只是讓對局不會因為 A 出局就結束，C 是晚進來的觀戰者 */
const me = { id: null };
const seenA = [];
const evA = [];                 /* A 收到的所有事件 */
let tilesA = null;              /* A 靠 full + tileDiff 累出來的地圖 */
let started = false, plan = null;

const a = tinyClient(PORT, m => {
  seenA.push(m);
  if (m.t === 'welcome') me.id = m.id;
  if (m.t !== 'snap') return;
  started = true;
  if (m.full) tilesA = m.tiles.slice();
  else if (m.tileDiff && tilesA) {
    for (let i = 0; i < m.tileDiff.length; i += 2) tilesA[m.tileDiff[i]] = m.tileDiff[i + 1];
  }
  if (m.ev) for (const e of m.ev) evA.push(e);
  if (!plan && m.full) plan = makePlan(m);
});
const b = tinyClient(PORT, () => {});
const b2 = tinyClient(PORT, () => {});
const seenC = [];
let c = null;

/** 從整張地圖挑一個「直直走過去就能炸到」的軟箱，回傳要往哪走、走幾格 */
function makePlan(snap) {
  const mine = snap.players.find(p => p.id === snap.you);
  if (!mine) return null;
  const at = (cc, rr) => snap.tiles[rr * snap.cols + cc];
  const c0 = Math.floor(mine.x), r0 = Math.floor(mine.y);
  const DIRS = [[1, 0, '右'], [-1, 0, '左'], [0, 1, '下'], [0, -1, '上']];
  let best = null;
  for (const [dx, dy, name] of DIRS) {
    for (let d = 1; d < 8; d++) {
      const cc = c0 + dx * d, rr = r0 + dy * d;
      if (cc < 0 || rr < 0 || cc >= snap.cols || rr >= snap.rows) break;
      const t = at(cc, rr);
      if (t === SOFT) {
        /* 走到軟箱前一格放球，退回起點躲爆風 */
        if (!best || d - 1 < best.steps) best = { dx, dy, name, steps: d - 1 };
        break;
      }
      if (t !== EMPTY) break;
    }
  }
  return best;
}

setTimeout(() => {
  a.send({ t: 'hello', name: '玩甲', char: 'cat' });
  b.send({ t: 'hello', name: '玩乙', char: 'dog' });
  b2.send({ t: 'hello', name: '玩丙', char: 'bear' });
}, 150);
setTimeout(() => a.send({ t: 'create', name: '互動測試房', mapId: 'open' }), 350);
setTimeout(() => { b.send({ t: 'quick' }); b2.send({ t: 'quick' }); }, 600);
setTimeout(() => {
  a.send({ t: 'ready', ready: true });
  b.send({ t: 'ready', ready: true });
  b2.send({ t: 'ready', ready: true });
}, 900);
setTimeout(() => a.send({ t: 'start' }), 1100);

/* 對局開始之後的腳本，時間都是從第一份快照算起 */
const WALK = 0.42;              /* 走一格大概要的秒數（3.2 格/秒，抓寬一點） */
let t0 = 0, seq = 0, phase = 'walk', dropAt = 0, dropAt2 = 0;
let bombSeen = false, bombGone = false;
let sawTrapped = false, sawDead = false, othersAlive = 0, matchEnded = false;

function sendInput(dx, dy, drop) {
  a.send({ t: 'input', seq: ++seq, ct: performance.now(), dx, dy, drop: !!drop });
}

const timer = setInterval(() => {
  if (!started || !me.id || !plan) return;
  if (!t0) { t0 = performance.now(); return; }
  const el = (performance.now() - t0) / 1000;
  const walkTime = plan.steps * WALK;

  const snap = seenA[seenA.length - 1];
  if (snap && snap.t === 'snap') {
    if (snap.bombs && snap.bombs.length) bombSeen = true;
    else if (bombSeen) bombGone = true;
    const mine = snap.players.find(p => p.id === me.id);
    if (mine && mine.state === 'trapped') sawTrapped = true;
    if (mine && mine.state === 'dead') {
      sawDead = true;
      othersAlive = snap.players.filter(p => p.id !== me.id && p.state !== 'dead').length;
    }
    if (snap.matchPhase && snap.matchPhase !== 'playing') matchEnded = true;
  }

  if (phase === 'walk') {
    if (el < walkTime) { sendInput(plan.dx, plan.dy, false); return; }
    phase = 'drop';
  }
  if (phase === 'drop') {
    sendInput(0, 0, true);                       /* 放水球 */
    dropAt = el;
    phase = 'retreat';
    return;
  }
  if (phase === 'retreat') {
    /* 退回去躲爆風，退完就站著等它爆 */
    if (el < dropAt + walkTime + 0.6) { sendInput(-plan.dx, -plan.dy, false); return; }
    sendInput(0, 0, false);
    if (el > dropAt + Rules.C.FUSE + 1.4) phase = 'suicide';
    return;
  }
  if (phase === 'suicide') {
    /* 這次放完就站在原地不動，讓自己被自己的水球炸到，
     * 走一遍「被困在泡泡裡 → 泡泡破掉 → 出局」的完整流程 */
    sendInput(0, 0, true);
    dropAt2 = el;
    phase = 'wait-death';
    return;
  }
  if (phase === 'wait-death') {
    sendInput(0, 0, false);
    if (el > dropAt2 + Rules.C.FUSE + Rules.C.TRAP_SOLO + 1.5) { clearInterval(timer); finish(); }
  }
}, 40);

/* 爆完之後才讓觀戰者進來，這樣它拿到的整張地圖是「已經少一個箱子」的版本，
 * 剛好可以拿來驗 A 用 tileDiff 累出來的地圖對不對 */
function joinSpectator() {
  const room = seenA.filter(m => m.t === 'room').pop();
  if (!room) return;
  c = tinyClient(PORT, m => seenC.push(m));
  setTimeout(() => c.send({ t: 'hello', name: '觀戰丁', char: 'rabbit' }), 100);
  setTimeout(() => c.send({ t: 'join', roomId: room.room.id, role: 'spectator' }), 300);
}

function finish() {
  joinSpectator();
  setTimeout(() => {
    ok(!!plan, '地圖上找得到可以炸的軟箱', plan && JSON.stringify(plan));
    ok(bombSeen, '放下去的水球有出現在快照裡');
    ok(evA.some(e => e.type === 'bomb'), '收得到「放水球」事件',
      [...new Set(evA.map(e => e.type))].join(',') || '沒有任何事件');
    ok(evA.some(e => e.type === 'explode'), '收得到「爆炸」事件',
      [...new Set(evA.map(e => e.type))].join(',') || '沒有任何事件');
    ok(bombGone, '爆完之後水球從快照裡消失');
    ok(evA.some(e => e.type === 'box'), '有炸掉軟箱',
      [...new Set(evA.map(e => e.type))].join(','));

    /* 地圖增量同步：A 一路用 tileDiff 累出來的地圖，
     * 要跟晚進來的觀戰者拿到的整張地圖一模一樣。
     * 這條不對的話，前端的碰撞判定會跟伺服器不一樣——走位就會莫名其妙卡住或穿牆。 */
    const cFull = seenC.filter(m => m.t === 'snap' && m.full).pop();
    if (cFull && tilesA) {
      let diff = 0, firstAt = -1;
      for (let i = 0; i < cFull.tiles.length; i++) {
        if (cFull.tiles[i] !== tilesA[i]) { diff++; if (firstAt < 0) firstAt = i; }
      }
      ok(cFull.tiles.length === tilesA.length && diff === 0,
        '用 tileDiff 累出來的地圖跟伺服器完全一致',
        diff + ' 格不一樣（第一格在 index ' + firstAt + '）');
      const boxesLeft = cFull.tiles.filter(t => t === SOFT).length;
      ok(boxesLeft > 0, '地圖上還有其他軟箱（確認不是整張被清空）', boxesLeft);
    } else {
      ok(false, '觀戰者拿得到整張地圖', cFull ? 'A 沒有地圖' : '觀戰者沒收到 full 快照');
    }

    ok(sawTrapped, '被自己的水球炸到會先被困在泡泡裡（state=trapped）');
    ok(sawDead, '泡泡撐不住之後真的出局（state=dead）');
    ok(sawDead && othersAlive === 2, '一個人出局不會讓還有兩個人的對局提前結束',
      '還活著 ' + othersAlive + ' 人');
    ok(!matchEnded, '對局仍在進行中');

    const cSnap = seenC.filter(m => m.t === 'snap').pop();
    ok(cSnap && cSnap.players.length === 3, '觀戰者看到的是同一場（三個角色）',
      cSnap && cSnap.players.length);
    ok(cSnap && cSnap.role === 'spectator', '觀戰者的身分正確', cSnap && cSnap.role);

    if (c) c.end();
    a.end(); b.end(); b2.end();
    console.log('\n────────────────────────────');
    console.log(fail ? fail + ' 項未通過' : '全部通過');
    process.exit(fail ? 1 : 0);
  }, 1200);
}

setTimeout(() => {
  console.log('  ✗ 逾時：對局沒有跑起來');
  process.exit(1);
}, 45000).unref();
