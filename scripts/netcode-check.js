/* ===== scripts/netcode-check.js — 線上走位的端對端檢查 =====
 * 用「真的 input.js + 真的 net.js + 真的 server.js + 真的 WebSocket」跑一輪，
 * 檢查畫面上的角色有沒有乖乖跟著方向鍵走。
 * 執行：npm run test:netcode
 *      npm run test:netcode -- --lag=80   （模擬來回 80 毫秒的網路）
 *
 * 門檻是照著實際會遇到的延遲訂的（本機、區網、同區雲端，大約 0～100ms 來回）。
 * 再往上（150ms 以上）轉向超衝會開始主導手感：你按了新方向，伺服器要等封包飛到
 * 才會轉，中間那段會多跑一點、撞牆的機會也變高。那是權威伺服器架構本來就有的，
 * 不是這裡的 bug，所以不列入必過項目。
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

/* ---------- 把瀏覽器端的模組原封不動載進來 ---------- */

const PUB = path.join(__dirname, '..', 'public', 'js');
function loadBrowser(file, scope) {
  const src = fs.readFileSync(path.join(PUB, file), 'utf8');
  new Function('self', src)(scope);
  return scope;
}

const scope = { Rules: require(path.join(PUB, 'rules.js')) };
loadBrowser('net.js', scope);
loadBrowser('input.js', scope);
const Net = scope.Net;
const Input = scope.Input;

/* ---------- 第一段：鍵盤（真的 input.js，套一層假的 DOM） ---------- */

function fakeInput() {
  const listeners = {};
  global.window = {
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); }
  };
  const el = () => ({
    addEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    style: {}
  });
  const inp = Input.create();
  inp.attach({ stick: el(), knob: el(), drop: el(), surface: el(), stickWrap: {} });
  const fire = (type, e) => (listeners[type] || []).forEach(fn => fn(Object.assign({
    preventDefault() {}, target: {}, repeat: false
  }, e)));
  return {
    down: e => fire('keydown', e),
    up: e => fire('keyup', e),
    blur: () => fire('blur', {}),
    read: () => inp.read()
  };
}

console.log('\n鍵盤：方向鍵要對得上');
{
  const k = fakeInput();
  k.down({ code: 'ArrowRight' });
  let r = k.read();
  ok(r.dx === 1 && r.dy === 0, '按右就往右', JSON.stringify(r));

  k.down({ code: 'ArrowDown' });
  r = k.read();
  ok(r.dx === 0 && r.dy === 1, '右還按著就按下，立刻轉成往下', JSON.stringify(r));

  k.up({ code: 'ArrowDown' });
  r = k.read();
  ok(r.dx === 1 && r.dy === 0, '放開下之後回到還按著的右', JSON.stringify(r));

  k.up({ code: 'ArrowRight' });
  r = k.read();
  ok(r.dx === 0 && r.dy === 0, '全部放開就停住', JSON.stringify(r));

  /* 舊瀏覽器沒有 e.code，只有 e.key */
  k.down({ code: '', key: 'Left' });
  r = k.read();
  ok(r.dx === -1, '只有 e.key 的舊瀏覽器也認得方向鍵', JSON.stringify(r));
  k.up({ code: '', key: 'Left' });

  /* 打字的時候不要被遊戲吃掉 */
  k.down({ code: 'ArrowUp', target: { tagName: 'INPUT' } });
  r = k.read();
  ok(r.dx === 0 && r.dy === 0, '在輸入框打字不會讓角色亂走', JSON.stringify(r));

  /* 放水球只算一次 */
  k.down({ code: 'Space' });
  k.down({ code: 'Space', repeat: true });
  ok(k.read().drop === true, '空白鍵會放水球');
  ok(k.read().drop === false, '同一次按壓不會連放');

  k.down({ code: 'ArrowRight' });
  k.blur();
  r = k.read();
  ok(r.dx === 0 && r.dy === 0, '視窗失焦會把按著的鍵清掉');
}

/* ---------- 第二段：真的連上伺服器，用真的 net.js 跑走位 ---------- */

const PORT = 3972;
process.env.PORT = String(PORT);
require('../server.js');

/* 想模擬真實網路就加 --lag=120（來回毫秒），不加就是本機零延遲 */
const LAG = Number((process.argv.find(s => s.startsWith('--lag=')) || '').slice(6)) || 0;
const HALF = LAG / 2;

console.log('\n走位：真的連線跑一輪' + (LAG ? '（模擬來回 ' + LAG + 'ms）' : ''));

const client = Net.create();
const me = { id: null };
const seenA = [];
let started = false;

/* 兩邊都壓上單程延遲，才像真的在網路上玩 */
function laggy(sock) {
  if (!HALF) return sock;
  return {
    send(obj) { setTimeout(() => sock.send(obj), HALF).unref(); },
    end() { sock.end(); }
  };
}
function onWire(fn) {
  return m => { if (!HALF) fn(m); else setTimeout(() => fn(m), HALF).unref(); };
}

/* 單機基準：同一張地圖、同一個起點、同一串按鍵，用單機那套固定步長跑一次。
 * 線上畫出來的位置就是要貼著它走——牆壁擋住的時候基準也會停，比較才公平。 */
const ref = { cols: 0, rows: 0, tiles: null, bombs: [], players: [], events: [] };
let refMe = null, refAcc = 0;

function initRef(snap) {
  if (refMe || !snap.full) return;
  const mine = snap.players.find(p => p.id === snap.you);
  if (!mine) return;
  ref.cols = snap.cols; ref.rows = snap.rows; ref.tiles = snap.tiles.slice();
  refMe = Object.assign({}, mine, { effects: { turtle: 0 }, bombsOut: 0 });
  ref.players = [refMe];
}
function stepRef(dt, dx, dy) {
  if (!refMe) return;
  refAcc += dt;
  let guard = 0;
  while (refAcc >= scope.Rules.STEP && guard++ < 8) {
    scope.Rules.applyMove(ref, refMe, dx, dy, scope.Rules.STEP);
    refAcc -= scope.Rules.STEP;
  }
}

const rawA = tinyClient(PORT, onWire(m => {
  seenA.push(m);
  if (m.t === 'welcome') me.id = m.id;
  if (m.t === 'snap') {
    started = true; initRef(m); client.onSnapshot(m, m.you);
    const sm = m.players.find(p => p.id === m.you);
    if (sm && t0) {
      const el2 = (performance.now() - t0) / 1000;
      const st = SCRIPT.find(x => el2 < x.until);
      const st0 = st && SCRIPT.indexOf(st) ? SCRIPT[SCRIPT.indexOf(st) - 1].until : 0;
      if (st) srvTrack.push({ t: el2, x: sm.x, y: sm.y, name: st.name, sinceTurn: el2 - st0 });
    }
  }
}));
const a = laggy(rawA);
const b = tinyClient(PORT, () => {});

setTimeout(() => {
  a.send({ t: 'hello', name: '走位甲', char: 'cat' });
  b.send({ t: 'hello', name: '走位乙', char: 'dog' });
}, 150);
setTimeout(() => a.send({ t: 'create', name: '走位測試房', mapId: 'open' }), 350);
setTimeout(() => b.send({ t: 'quick' }), 600);
setTimeout(() => { a.send({ t: 'ready', ready: true }); b.send({ t: 'ready', ready: true }); }, 850);
setTimeout(() => a.send({ t: 'start' }), 1050);

/* 按鍵腳本：在同一條走道上來回跑。
 * 刻意不做轉彎——轉角要不要轉是個臨界判斷，前端 1/60 步長與伺服器 1/30 步長
 * 只要差一點點就會選到不同的路，那是規則本身的敏感度，不是連線的問題。
 * 直線來回就能問出真正想問的事：速度對不對、會不會倒退、會不會跟伺服器脫節。 */
const SCRIPT = [
  { until: 0.7, dx: 1, dy: 0, name: '右' },
  { until: 1.4, dx: -1, dy: 0, name: '左' },
  { until: 2.1, dx: 1, dy: 0, name: '再往右' },
  { until: 2.9, dx: 0, dy: 0, name: '放開' }
];

const samples = [];
const srvTrack = [];
let t0 = 0, last = 0, inputTimer = 0, lastSent = { dx: 0, dy: 0 }, seq = 0;

const timer = setInterval(() => {
  if (!started || !me.id) return;
  const nowMs = performance.now();
  if (!t0) { t0 = nowMs; last = nowMs; return; }
  const dt = Math.min(0.25, (nowMs - last) / 1000);
  last = nowMs;
  const el = (nowMs - t0) / 1000;

  const step = SCRIPT.find(s => el < s.until);
  if (!step) { clearInterval(timer); finish(); return; }
  const segStart = SCRIPT.indexOf(step) ? SCRIPT[SCRIPT.indexOf(step) - 1].until : 0;
  const mine = { dx: step.dx, dy: step.dy, drop: false };

  /* 這一段照抄 app.js onlineFrame 的送輸入邏輯 */
  inputTimer -= dt;
  if (mine.dx !== lastSent.dx || mine.dy !== lastSent.dy || inputTimer <= 0) {
    inputTimer = 1 / 30;
    lastSent = { dx: mine.dx, dy: mine.dy };
    a.send({ t: 'input', seq: ++seq, ct: performance.now(), dx: mine.dx, dy: mine.dy, drop: false });
  }

  stepRef(dt, mine.dx, mine.dy);
  const view = client.frame(dt, mine);
  if (!view) return;
  const drawn = view.players.find(p => p.id === me.id);
  if (drawn && refMe) {
    samples.push({
      t: el, dx: step.dx, dy: step.dy, name: step.name, sinceTurn: el - segStart,
      x: drawn.x, y: drawn.y, rx: refMe.x, ry: refMe.y, speed: refMe.speed || 3.2,
      lx: client.local ? client.local.x : drawn.x, ly: client.local ? client.local.y : drawn.y
    });
  }
}, 16);

function finish() {
  ok(samples.length > 60, '有跑到足夠的取樣', samples.length + ' 幀');

  /* 剛換方向的那一小段先不看：伺服器說了算，你按下新方向之後它要等封包飛過去
   * 才會轉，這段「超衝」是延遲本來就會有的，不是 bug。等輸入來回一趟之後才開始檢查。 */
  const SETTLE = Math.max(0.2, LAG / 1000);
  const settled = samples.filter(s => s.sinceTurn >= SETTLE);
  ok(settled.length > 30, '扣掉轉向緩衝後還有足夠的取樣', settled.length + ' 幀');

  /* 0. 這串按鍵在單機底下真的有走出一段路，測試才不是空的 */
  let refPath = 0;
  for (let i = 1; i < samples.length; i++) {
    refPath += Math.hypot(samples[i].rx - samples[i - 1].rx, samples[i].ry - samples[i - 1].ry);
  }
  ok(refPath > 3, '這串按鍵在單機底下會走出一段路（測試不是空跑）', refPath.toFixed(2) + ' 格');

  /* 1. 速度：穩下來之後，每秒「往前推進」多少。
   *    量淨位移而不是走過的路程——高延遲時伺服器那條軌跡本身就含著轉向超衝的來回，
   *    畫面把那些抖動抹平是對的，用路程比較反而會冤枉它。 */
  function progress(track) {
    const per = {};
    for (let i = 1; i < track.length; i++) {
      const p = track[i - 1], q = track[i];
      if (q.name !== p.name || q.sinceTurn < SETTLE || q.t - p.t > 0.3) continue;
      const g = per[q.name] || (per[q.name] = { from: p, to: p, span: 0 });
      g.to = q; g.span += q.t - p.t;
    }
    let dist = 0, span = 0;
    for (const k in per) {
      dist += Math.hypot(per[k].to.x - per[k].from.x, per[k].to.y - per[k].from.y);
      span += per[k].span;
    }
    return span > 0.3 ? dist / span : 0;
  }
  const onSpeed = progress(samples);
  const refSpeed = progress(samples.map(s2 => Object.assign({}, s2, { x: s2.rx, y: s2.ry })));
  ok(refSpeed > 2, '單機基準本身有在全速走', refSpeed.toFixed(2) + ' 格/秒');

  /* 伺服器自己的世界跑多快？這個跟延遲無關，抓的就是主迴圈的時間基準有沒有歪。 */
  const srvSpeed = progress(srvTrack);
  console.log('    （伺服器 ' + srvSpeed.toFixed(2) + '、畫面 ' + onSpeed.toFixed(2) +
    '、單機 ' + refSpeed.toFixed(2) + ' 格/秒）');
  ok(srvSpeed > refSpeed * 0.9, '伺服器世界跑的速度跟單機一樣（主迴圈時間基準正確）',
    '伺服器 ' + srvSpeed.toFixed(2) + '，單機 ' + refSpeed.toFixed(2) + ' 格/秒');
  ok(onSpeed > srvSpeed * 0.9, '畫面上的速度沒有比伺服器慢（本地預測沒有拖後腿）',
    '畫面 ' + onSpeed.toFixed(2) + '，伺服器 ' + srvSpeed.toFixed(2) + ' 格/秒');

  /* 2. 穩定之後不能有倒退或瞬移 */
  let back = 0, jump = 0, worstBack = 0, worstJump = 0;
  for (let i = 1; i < samples.length; i++) {
    const p = samples[i - 1], q = samples[i];
    if (q.name !== p.name || q.sinceTurn < SETTLE) continue;
    if (!q.dx && !q.dy) continue;
    const along = (q.x - p.x) * q.dx + (q.y - p.y) * q.dy;
    const localAlong = (q.lx - p.lx) * q.dx + (q.ly - p.ly) * q.dy;
    const dist = Math.hypot(q.x - p.x, q.y - p.y);
    const budget = q.speed * Math.max(0.016, q.t - p.t) * 3;
    if (dist > budget) { jump++; worstJump = Math.max(worstJump, dist); }
    /* 本地預測沒前進就是撞牆了，那時候畫面把校正收掉是應該的，不算倒退 */
    if (localAlong > 0.001 && along < -0.001) { back++; worstBack = Math.min(worstBack, along); }
  }
  ok(back === 0, '沒有「按著方向鍵卻往回退」的幀', back + ' 幀，最糟 ' + worstBack.toFixed(3) + ' 格');
  ok(jump === 0, '沒有一幀瞬移', jump + ' 幀，最遠 ' + worstJump.toFixed(3) + ' 格');

  /* 3. 放開按鍵要真的停下來 */
  const idle = samples.filter(s => !s.dx && !s.dy && s.sinceTurn >= SETTLE);
  if (idle.length > 5) {
    const drift = Math.hypot(idle[idle.length - 1].x - idle[0].x, idle[idle.length - 1].y - idle[0].y);
    /* 放手之後伺服器還要等封包飛過去才知道，這段滑行是延遲本來就有的，容許值跟著延遲放寬 */
    const allow = 0.15 + 3.2 * (HALF / 1000);
    ok(drift < allow, '放開按鍵、等輸入傳到伺服器之後會停下來',
      '還飄了 ' + drift.toFixed(3) + ' 格（容許 ' + allow.toFixed(2) + '）');
  } else {
    ok(false, '放開按鍵那一段有取樣到', idle.length);
  }

  /* 3. 對帳欄位與延遲估計 */
  const snaps = seenA.filter(m => m.t === 'snap');
  ok(snaps.some(s => s.ackCt > 0), '快照有回傳前端時戳 ackCt');
  ok(snaps.some(s => typeof s.ackAge === 'number'), '快照有回傳 ackAge');
  const wantLag = HALF / 1000;
  ok(Math.abs(client.lag - wantLag) < 0.04, '估出來的單程延遲跟實際相符',
    '估 ' + (client.lag * 1000).toFixed(1) + 'ms，實際 ' + HALF + 'ms');

  /* 4. 預測位置要跟伺服器權威位置收斂 */
  const lastSnap = snaps[snaps.length - 1];
  const srvMe = lastSnap && lastSnap.players.find(p => p.id === me.id);
  const drawn = samples[samples.length - 1];
  if (srvMe && drawn) {
    const gap = Math.hypot(drawn.x - srvMe.x, drawn.y - srvMe.y);
    ok(gap < 0.6, '畫面位置沒有跟伺服器越離越遠', gap.toFixed(3) + ' 格');
  } else {
    ok(false, '拿得到最後一份快照裡的自己');
  }

  rawA.end(); b.end();
  console.log('\n────────────────────────────');
  console.log(fail ? fail + ' 項未通過' : '全部通過');
  process.exit(fail ? 1 : 0);
}

setTimeout(() => {
  console.log('  ✗ 逾時：對局沒有跑起來');
  process.exit(1);
}, 20000).unref();
