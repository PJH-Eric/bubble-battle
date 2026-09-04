/* ===== scripts/online-check.js — 線上邏輯與連線的自動檢查 =====
 * 兩段：
 *   1. 直接對 lib/rooms.js 做房間、席位、觀戰、邀請、踢人、斷線、整局的測試
 *   2. 真的開一個伺服器，用最小的 WebSocket 客戶端連上去跑一輪
 * 執行：npm run test:online
 */
'use strict';

const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { createHub, CONST } = require('../lib/rooms.js');

let fail = 0;
function ok(cond, name, extra) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (!cond && extra != null ? '  → ' + extra : ''));
  if (!cond) fail++;
}
const eq = (a, b, name) => ok(a === b, name, 'expected ' + b + ', got ' + a);

/* ---------------- 第一段：房間邏輯 ---------------- */

let clock = 1000000;
const hub = createHub({ now: () => clock });
const P = (id, name) => ({ id, name, char: 'cat' });

console.log('\n房間與席位');
{
  const { room } = hub.createRoom(P('u1', '小艾'), { name: '測試房', maxPlayers: 4 });
  eq(room.hostId, 'u1', '建房的人就是房主');
  hub.join(room.id, P('u2', '阿宏'));
  hub.join(room.id, P('u3', '小美'));
  eq(hub.seatCount(room), 3, '三個人都入座');

  hub.updateRoom(room.id, 'u1', { maxPlayers: 3 });
  const r4 = hub.join(room.id, P('u4', '路人'));
  eq(r4.member.role, 'spectator', '席位滿了就自動轉觀戰');
  ok(r4.becameSpectator, '而且會明白告訴他被轉成觀戰');

  eq(hub.takeSeat(room.id, 'u4', 'player').error, '席位滿了', '滿座時入座會被擋下來');
  hub.updateRoom(room.id, 'u1', { maxPlayers: 8 });
  ok(!hub.takeSeat(room.id, 'u4', 'player').error, '放寬人數後就入座得了');

  eq(hub.kick(room.id, 'u2', 'u3').error, '只有房主可以踢人', '不是房主不能踢人');
  eq(hub.kick(room.id, 'u1', 'u1').error, '不能踢自己', '房主不能踢自己');
  hub.kick(room.id, 'u1', 'u3');
  ok(!room.members.has('u3'), '房主可以把人請出房間');

  hub.leave(room.id, 'u1');
  ok(room.hostId !== 'u1' && room.members.has(room.hostId), '房主離開會自動換人');
  for (const id of [...room.members.keys()]) hub.leave(room.id, id);
}

console.log('\n組隊與電腦對手');
{
  const { room } = hub.createRoom(P('t1', '隊長'), { mode: 'team', maxPlayers: 4 });
  hub.join(room.id, P('t2', '隊友'));
  hub.addAI(room.id, 't1', 'hard');
  hub.addAI(room.id, 't1', 'baby');
  eq(hub.seatCount(room), 4, '兩人加兩台電腦剛好滿');
  const teams = hub.seats(room).concat(room.ais).map(x => x.team);
  eq(teams.filter(t => t === 0).length, 2, '藍隊兩個');
  eq(teams.filter(t => t === 1).length, 2, '紅隊兩個');
  eq(hub.addAI(room.id, 't2', 'normal').error, '只有房主可以加電腦', '不是房主不能加電腦');
  hub.removeAI(room.id, 't1', room.ais[0].id);
  eq(room.ais.length, 1, '房主可以移除指定的電腦');
  for (const id of [...room.members.keys()]) hub.leave(room.id, id);
}

console.log('\n邀請連結');
{
  const { room } = hub.createRoom(P('i1', '主人'), {});
  const made = hub.makeInvite(room.id, 'i1');
  ok(!!made.token, '房主可以產生邀請連結');
  eq(hub.resolveInvite(made.token).room.id, room.id, '邀請連結指得到那個房間');
  eq(hub.resolveInvite('gibberish').error, '這個邀請連結無效或已經被撤銷了', '亂打的連結會被擋下來');
  const again = hub.makeInvite(room.id, 'i1');
  eq(hub.resolveInvite(made.token).error, '這個邀請連結無效或已經被撤銷了', '重發之後舊連結就失效');
  hub.revokeInvite(room.id, 'i1');
  eq(hub.resolveInvite(again.token).error, '這個邀請連結無效或已經被撤銷了', '撤銷之後連結失效');
  for (const id of [...room.members.keys()]) hub.leave(room.id, id);
}

console.log('\n房間自動關閉');
{
  const { room } = hub.createRoom(P('c1', '房主'), {});
  hub.join(room.id, P('c2', '觀戰者'), 'spectator');
  hub.addAI(room.id, 'c1', 'normal');
  const made = hub.makeInvite(room.id, 'c1');

  hub.leave(room.id, 'c1');
  ok(!hub.get(room.id), '最後一位真人離開後房間立即關閉');
  const closed = typeof hub.consumeClosedRooms === 'function' ? hub.consumeClosedRooms() : [];
  const notice = closed.find(item => item.id === room.id);
  ok(!!notice && notice.memberIds.includes('c2'), '房間關閉會通知仍在房內的觀戰者');
  eq(hub.resolveInvite(made.token).error, '這個邀請連結無效或已經被撤銷了', '房間關閉會一併撤銷邀請連結');
}

{
  const { room } = hub.createRoom(P('c3', '甲'), {});
  hub.join(room.id, P('c4', '乙'));
  hub.markDisconnected('c3');
  hub.markDisconnected('c4');
  clock += CONST.RECONNECT_MS + 100;
  hub.tick(1 / 30);
  ok(!hub.get(room.id), '所有真人斷線逾時離場後房間立即關閉');
  if (typeof hub.consumeClosedRooms === 'function') hub.consumeClosedRooms();
}

console.log('\n斷線與重連');
{
  const { room } = hub.createRoom(P('d1', '甲'), {});
  hub.join(room.id, P('d2', '乙'));
  hub.markDisconnected('d2');
  hub.tick(1 / 30);
  ok(room.members.has('d2'), '剛斷線的人還留在房間裡');
  eq(room.members.get('d2').connected, false, '狀態標成斷線中');
  hub.join(room.id, P('d2', '乙'));
  eq(room.members.get('d2').connected, true, '30 秒內回來可以接回原本的席位');

  hub.markDisconnected('d2');
  clock += CONST.RECONNECT_MS + 100;
  hub.tick(1 / 30);
  ok(!room.members.has('d2'), '超過 30 秒沒回來就判定離場');
  for (const id of [...room.members.keys()]) hub.leave(room.id, id);
}

console.log('\n開局與整局跑完');
{
  const { room } = hub.createRoom(P('m1', '甲'), { mapId: 'open' });
  hub.join(room.id, P('m2', '乙'));
  hub.addAI(room.id, 'm1', 'hard');
  eq(hub.start(room.id, 'm1').error, '還有人沒有按準備好', '沒全員準備不能開始');
  hub.setReady(room.id, 'm1', true);
  hub.setReady(room.id, 'm2', true);
  eq(hub.start(room.id, 'm2').error, '只有房主可以開始', '不是房主不能開始');
  ok(!hub.start(room.id, 'm1').error, '房主可以開始');
  eq(room.phase, 'countdown', '先進入開場倒數');

  clock += CONST.COUNTDOWN_MS + 50;
  hub.tick(1 / 30);
  eq(room.phase, 'playing', '倒數完就開打');
  ok(!!room.match, '對局建立起來了');

  /* 觀戰者中途進來 */
  const watcher = hub.join(room.id, P('w1', '路過'));
  eq(watcher.member.role, 'spectator', '對局進行中加入的人只能觀戰');

  const snap = hub.snapshot(room, { viewerId: 'm1', full: true });
  ok(snap.full && snap.tiles.length === snap.cols * snap.rows, '完整快照含整張地圖');
  ok(snap.players.length === 3, '快照裡有三個角色', snap.players.length);

  /* 讓它自己打完 */
  let guard = 0;
  while (room.phase === 'playing' && guard++ < 30 * 200) {
    hub.setInput(room.id, 'm1', { dx: guard % 40 < 20 ? 1 : -1, dy: 0, drop: guard % 90 === 0, seq: guard });
    clock += Math.round(1000 / 30);
    hub.tick(1 / 30);
  }
  eq(room.phase, 'result', '對局結束後進入結算');
  ok(room.match && room.match.phase === 'over', '規則核心也判定結束了');

  clock += CONST.RESULT_MS + 50;
  hub.tick(1 / 30);
  eq(room.phase, 'lobby', '結算完回到房間');
  eq(room.match, null, '對局狀態清乾淨');
  ok(hub.takeSeat(room.id, 'w1', 'player') && room.members.get('w1').role === 'player',
    '這一局結束後觀戰者可以入座');
}

/* ---------------- 第二段：真的連上去 ---------------- */

const PORT = 3971;

function tinyClient(port, onMessage) {
  /* 最小的 WebSocket 客戶端，只為了自測，不做遮罩（我們的伺服器兩種都收） */
  const key = crypto.randomBytes(16).toString('base64');
  const sock = net.connect(port, '127.0.0.1');
  let handshaked = false;
  let buf = Buffer.alloc(0);

  sock.on('connect', () => {
    sock.write(
      'GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n'
    );
  });

  sock.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    if (!handshaked) {
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) return;
      handshaked = true;
      buf = buf.slice(end + 4);
    }
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) return;
      const payload = buf.slice(off, off + len).toString('utf8');
      buf = buf.slice(off + len);
      if (opcode === 0x1) {
        try { onMessage(JSON.parse(payload)); } catch (e) { /* 忽略 */ }
      }
    }
  });

  return {
    send(obj) {
      const body = Buffer.from(JSON.stringify(obj), 'utf8');
      let header;
      if (body.length < 126) { header = Buffer.from([0x81, body.length]); }
      else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(body.length, 2); }
      sock.write(Buffer.concat([header, body]));
    },
    end() { sock.destroy(); }
  };
}

console.log('\n真的連上伺服器跑一輪');
process.env.PORT = String(PORT);
require('../server.js');

const seen = { A: [], B: [], C: [], D: [] };
setTimeout(() => {
  const a = tinyClient(PORT, m => seen.A.push(m));
  const b = tinyClient(PORT, m => seen.B.push(m));
  const c = tinyClient(PORT, m => seen.C.push(m));
  const d = tinyClient(PORT, m => seen.D.push(m));

  setTimeout(() => {
    a.send({ t: 'hello', name: '甲', char: 'cat' });
    b.send({ t: 'hello', name: '乙', char: 'dog' });
    c.send({ t: 'hello', name: '丙', char: 'bear' });
    d.send({ t: 'hello', name: '丁', char: 'rabbit' });
  }, 150);

  setTimeout(() => a.send({ t: 'create', name: '連線測試房', mapId: 'open' }), 350);
  setTimeout(() => b.send({ t: 'quick' }), 600);
  setTimeout(() => c.send({ t: 'create', name: '自動關閉測試房', mapId: 'open' }), 700);
  setTimeout(() => {
    const room = seen.C.filter(m => m.t === 'room').pop();
    if (room) d.send({ t: 'join', roomId: room.room.id, role: 'spectator' });
  }, 1050);
  setTimeout(() => c.send({ t: 'leave' }), 1400);
  setTimeout(() => {
    a.send({ t: 'ready', ready: true });
    b.send({ t: 'ready', ready: true });
  }, 850);
  setTimeout(() => a.send({ t: 'start' }), 1050);
  setTimeout(() => a.send({ t: 'chat', text: '哈囉' }), 1200);
  setTimeout(() => a.send({ t: 'input', seq: 1, dx: 1, dy: 0, drop: false }), 4500);

  setTimeout(() => {
    const welcome = seen.A.find(m => m.t === 'welcome');
    const room = seen.A.filter(m => m.t === 'room').pop();
    const snapA = seen.A.filter(m => m.t === 'snap');
    const snapB = seen.B.filter(m => m.t === 'snap');
    const chat = (room && room.room.chat || []).some(c => c.text === '哈囉');

    ok(!!welcome && !!welcome.id, '連上去就拿到自己的 id');
    ok(!!room, '收得到房間狀態');
    ok(room && room.room.members.length === 2, '兩個人都在房間裡', room && room.room.members.length);
    ok(chat, '聊天訊息有傳到');
    ok(snapA.length > 10 && snapB.length > 10, '雙方都持續收到對局快照',
      snapA.length + '/' + snapB.length);
    const full = snapA.find(s => s.full);
    ok(!!full && full.tiles.length === full.cols * full.rows, '第一份快照含整張地圖');
    const moved = snapA[snapA.length - 1].players.find(p => p.id === welcome.id);
    ok(!!moved, '快照裡找得到自己');
    ok(seen.D.some(m => m.t === 'closed'), '最後真人離開後觀戰者收到房間關閉通知');

    a.end(); b.end(); c.end(); d.end();
    console.log('\n────────────────────────────');
    console.log(fail ? fail + ' 項未通過' : '全部通過');
    process.exit(fail ? 1 : 0);
  }, 6000);
}, 400);
