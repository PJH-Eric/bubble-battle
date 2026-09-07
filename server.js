/* ===== server.js — 靜態檔案 + 線上對戰（零依賴）=====
 *
 * 靜態檔案用 Node 內建 http，連線用自己寫的 lib/ws.js（原生 WebSocket），
 * 所以整個專案不需要 npm install，雙擊 .bat 就能玩，丟到 Render 也一樣。
 *
 * 規則核心與 AI 直接沿用 public/js 底下那一套，前後端完全同一份規則。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ws = require('./lib/ws.js');
const { createHub } = require('./lib/rooms.js');
const Rules = require('./public/js/rules.js');

const PORT = Number(process.env.PORT) || 3050;
const ROOT = path.join(__dirname, 'public');
const TICK_HZ = 30;
const SNAPSHOT_EVERY = 1;          /* 每個 tick 都送快照 → 30Hz。
                                    * 15Hz 的話前端要留 120ms 插值緩衝才不會抖，
                                    * 別人的角色與水球就整整慢一拍，玩起來就是「延遲」。 */

/* ---------- 靜態檔案 ---------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('找不到這個檔案');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  let url = decodeURIComponent((req.url || '/').split('?')[0]);

  /* 給前端跨網域用（GitHub Pages 前端 + Render 伺服器的組合） */
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);

  /* 給遊戲大廳問「現在有幾個人在玩」 */
  if (url === '/api/presence') {
    const connectedMembers = [...hub.rooms.values()].flatMap(room =>
      [...room.members.values()].filter(member => member.connected));
    const players = connectedMembers.filter(member => member.role === 'player').length;
    const spectators = connectedMembers.filter(member => member.role === 'spectator').length;
    const activeRooms = [...hub.rooms.values()].filter(room =>
      [...room.members.values()].some(member => member.connected)).length;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      gameId: 'bubble-battle',
      online: clients.size,
      players,
      spectators,
      lobby: [...clients.values()].filter(client => !client.roomId).length,
      rooms: activeRooms,
      updatedAt: new Date().toISOString()
    }));
    return;
  }

  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: true, game: 'bubble-battle',
      rooms: hub.rooms.size, players: clients.size, time: Date.now()
    }));
    return;
  }

  if (url === '/') url = '/index.html';
  const file = path.join(ROOT, path.normalize(url).replace(/^([/\\])+/, ''));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('不可以');
    return;
  }
  sendFile(res, file);
});

const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';

/* ---------- 線上對戰 ---------- */

const hub = createHub();
const clients = new Map();          /* clientId -> client */
let nextClient = 1;

function makeId() {
  return 'p' + (nextClient++).toString(36) + Math.random().toString(36).slice(2, 7);
}

function send(client, obj) {
  if (client && client.socket) client.socket.sendJSON(obj);
}

function fail(client, msg) {
  send(client, { t: 'error', msg });
}

function pushRoom(room) {
  if (!room) return;
  for (const m of room.members.values()) {
    const c = clients.get(m.id);
    if (c) send(c, { t: 'room', room: hub.roomView(room, m.id) });
  }
}

function pushLobby() {
  const list = hub.listRooms();
  for (const c of clients.values()) {
    if (!c.roomId) send(c, { t: 'lobby', rooms: list });
  }
}

function flushClosedRooms(skipIds) {
  const skipped = new Set(skipIds || []);
  const closed = hub.consumeClosedRooms();
  for (const item of closed) {
    for (const id of item.memberIds) {
      if (skipped.has(id)) continue;
      const client = clients.get(id);
      if (!client) continue;
      client.roomId = null;
      send(client, { t: 'closed', msg: item.reason });
    }
  }
  return closed;
}

function enter(client, result, wantRole) {
  if (result.error) { fail(client, result.error); return; }
  const room = result.room;
  client.roomId = room.id;
  client.needFull = true;
  if (result.becameSpectator) {
    send(client, { t: 'notice', msg: '席位已經滿了（或這一局已經開始），先幫你安排觀戰' });
  }
  const mine = room.members.get(client.id);
  if (mine && !result.rejoined) {
    hub.systemChat(room, mine.name + (mine.role === 'spectator' ? ' 進來觀戰了' : ' 加入了房間'));
  }
  pushRoom(room);
  pushLobby();
}

function handle(client, msg) {
  const roomId = client.roomId;
  const me = { id: client.id, name: client.name, char: client.char };

  switch (msg.t) {
    case 'hello': {
      client.name = String(msg.name || '玩家').slice(0, 6);
      client.char = String(msg.char || 'cat').slice(0, 12);
      /* 帶著上次的 id 回來 → 沿用同一個身分，房間裡的席位就接得回去 */
      const want = String(msg.id || '');
      if (want && want !== client.id && !clients.has(want)) {
        clients.delete(client.id);
        client.id = want;
        clients.set(want, client);
      }
      send(client, { t: 'welcome', id: client.id });
      /* 如果還在某個房間的名單裡，直接接回去（順便同步新的暱稱） */
      for (const room of hub.rooms.values()) {
        const m = room.members.get(client.id);
        if (!m) continue;
        m.connected = true;
        m.disconnectedAt = 0;
        m.name = client.name;
        m.char = client.char;
        client.roomId = room.id;
        client.needFull = true;
        hub.systemChat(room, m.name + ' 回來了');
        pushRoom(room);
        break;
      }
      pushLobby();
      return;
    }

    case 'lobby':
      send(client, { t: 'lobby', rooms: hub.listRooms() });
      return;

    case 'create':
      if (roomId) {
        hub.leave(roomId, client.id);
        flushClosedRooms([client.id]);
        client.roomId = null;
      }
      enter(client, hub.createRoom(me, msg));
      return;

    case 'join':
      if (roomId && roomId !== msg.roomId) {
        hub.leave(roomId, client.id);
        flushClosedRooms([client.id]);
        client.roomId = null;
      }
      enter(client, hub.join(msg.roomId, me, msg.role), msg.role);
      return;

    case 'quick':
      if (roomId) {
        hub.leave(roomId, client.id);
        flushClosedRooms([client.id]);
        client.roomId = null;
      }
      enter(client, hub.quickJoin(me));
      return;

    case 'invite:use': {
      const found = hub.resolveInvite(msg.token);
      if (found.error) { fail(client, found.error); return; }
      if (roomId) {
        hub.leave(roomId, client.id);
        flushClosedRooms([client.id]);
        client.roomId = null;
      }
      enter(client, hub.join(found.room.id, me, msg.role));
      return;
    }

    case 'leave': {
      if (!roomId) return;
      const room = hub.get(roomId);
      const member = room && room.members.get(client.id);
      if (room && member) hub.systemChat(room, member.name + ' 離開了房間');
      hub.leave(roomId, client.id);
      client.roomId = null;
      send(client, { t: 'left' });
      const activeRoom = hub.get(roomId);
      if (activeRoom) pushRoom(activeRoom);
      flushClosedRooms([client.id]);
      pushLobby();
      return;
    }
  }

  /* 以下都需要在房間裡 */
  if (!roomId) { fail(client, '你不在任何房間裡'); return; }
  const room = hub.get(roomId);
  if (!room) { client.roomId = null; send(client, { t: 'left' }); return; }

  switch (msg.t) {
    case 'ready': result(hub.setReady(roomId, client.id, msg.ready)); break;
    case 'seat': result(hub.takeSeat(roomId, client.id, msg.want)); break;
    case 'setup': result(hub.updateRoom(roomId, client.id, msg)); break;
    case 'ai:add': result(hub.addAI(roomId, client.id, msg.level)); break;
    case 'ai:remove': result(hub.removeAI(roomId, client.id, msg.id)); break;
    case 'chat': result(hub.chat(roomId, client.id, msg.text)); break;
    case 'start': result(hub.start(roomId, client.id)); break;
    case 'invite:new': {
      const r = hub.makeInvite(roomId, client.id);
      if (r.error) fail(client, r.error);
      else pushRoom(room);
      break;
    }
    case 'invite:revoke': result(hub.revokeInvite(roomId, client.id)); break;
    case 'kick': {
      const r = hub.kick(roomId, client.id, msg.id);
      if (r.error) { fail(client, r.error); break; }
      const victim = clients.get(msg.id);
      if (victim) {
        victim.roomId = null;
        send(victim, { t: 'kicked' });
      }
      const activeRoom = hub.get(room.id);
      if (activeRoom) pushRoom(activeRoom);
      flushClosedRooms([msg.id]);
      pushLobby();
      break;
    }
    case 'input':
      hub.setInput(roomId, client.id, msg);
      break;
    default:
      break;
  }

  function result(r) {
    if (r && r.error) fail(client, r.error);
    else {
      const activeRoom = hub.get(room.id);
      if (activeRoom) pushRoom(activeRoom);
      const closed = flushClosedRooms();
      if (activeRoom || closed.length) pushLobby();
    }
  }
}

ws.attach(server, {
  path: '/ws',
  onConnection(socket) {
    const client = {
      id: makeId(),
      name: '玩家',
      char: 'cat',
      socket,
      roomId: null,
      needFull: true,
      lastSeen: Date.now()
    };
    clients.set(client.id, client);
    send(client, { t: 'welcome', id: client.id });

    socket.on('message', text => {
      client.lastSeen = Date.now();
      let msg = null;
      try { msg = JSON.parse(text); } catch (e) { return; }
      if (!msg || typeof msg.t !== 'string') return;
      try { handle(client, msg); } catch (e) {
        console.error('[bubble] 處理訊息時出錯：', e && e.message);
        fail(client, '伺服器出了點問題，請再試一次');
      }
    });

    socket.on('close', () => {
      clients.delete(client.id);
      const touched = hub.markDisconnected(client.id);
      for (const room of touched) {
        const activeRoom = hub.get(room.id);
        if (activeRoom) pushRoom(activeRoom);
      }
      flushClosedRooms();
      pushLobby();
    });
  }
});

/* ---------- 主迴圈 ---------- */

/* 模擬一定要跟著「真實經過的時間」走，不能假設 setInterval 準時。
 * Windows 的計時器粒度大約 15.6 毫秒，setInterval(33) 實際上每 47 毫秒才響一次；
 * 如果每響一次就固定推進 1/30 秒，遊戲世界只會跑到真實速度的七成——
 * 線上角色比單機慢一截，而且前端的即時預測會一直被伺服器往回拉。
 * 所以這裡用固定步長 + 真實時間累加器，跟前端單機迴圈同一套做法。 */
const STEP = 1 / TICK_HZ;                      /* 每一步推進多少模擬時間 */
const SNAP_EVERY_S = STEP * SNAPSHOT_EVERY;    /* 快照間隔（秒） */
const MAX_CATCHUP = 8;                         /* 一次最多補幾步，忙不過來時不要雪崩 */
const LOOP_MS = 10;                            /* 醒來的間隔要比一步短，才追得上 */

const prevTiles = new Map();
let stepAcc = 0, snapAcc = 0;
let lastLoopAt = Date.now();

setInterval(() => {
  const at = Date.now();
  let elapsed = (at - lastLoopAt) / 1000;
  lastLoopAt = at;
  if (elapsed > 0.5) elapsed = 0.5;            /* 休眠喚醒之類的大跳躍就跳過去 */
  stepAcc += elapsed;
  snapAcc += elapsed;

  const changed = new Set();
  let steps = 0;
  while (stepAcc >= STEP && steps < MAX_CATCHUP) {
    stepAcc -= STEP;
    steps++;
    for (const room of hub.tick(STEP)) changed.add(room);

    /* 把這一步發生的事件先存起來，等下一次送快照時一起帶給前端（音效、提示用） */
    for (const room of hub.rooms.values()) {
      if (!room.match || !room.match.events.length) continue;
      room._events = (room._events || []).concat(room.match.events);
      if (room._events.length > 60) room._events = room._events.slice(-60);
    }
  }
  if (steps >= MAX_CATCHUP) stepAcc = 0;       /* 落後太多就認賠，不要越積越多 */

  if (steps) {
    for (const room of changed) {
      const activeRoom = hub.get(room.id);
      if (activeRoom) pushRoom(activeRoom);
    }
    const closed = flushClosedRooms();
    if (changed.size || closed.length) pushLobby();
  }

  if (snapAcc < SNAP_EVERY_S) return;
  snapAcc -= SNAP_EVERY_S;
  if (snapAcc > SNAP_EVERY_S) snapAcc = 0;     /* 落後就別追快照，補送也沒意義 */

  for (const room of hub.rooms.values()) {
    if (!room.match) { prevTiles.delete(room.id); continue; }
    const before = prevTiles.get(room.id);
    const diff = before ? hub.tileDiff(room, before) : null;
    prevTiles.set(room.id, Array.from(room.match.tiles));

    for (const m of room.members.values()) {
      const c = clients.get(m.id);
      if (!c) continue;
      const full = c.needFull || !before;
      c.needFull = false;
      const snap = hub.snapshot(room, { viewerId: m.id, full });
      if (!snap) continue;
      /* 快照畫的是「模擬時間」的世界，而模擬永遠落後牆上時鐘不到一步（累加器的餘數）。
       * 把這個餘數一起送出去，前端對帳才知道這張快照實際上有多舊。 */
      snap.simLag = +stepAcc.toFixed(4);
      if (!full && diff) snap.tileDiff = diff;
      if (room._events && room._events.length) snap.ev = room._events;
      snap.t = 'snap';
      snap.you = m.id;
      snap.role = m.role;
      send(c, snap);
    }
    room._events = [];
  }
}, LOOP_MS);

/* 每 25 秒 ping 一次，避免中間的代理把閒置連線切掉 */
setInterval(() => {
  for (const c of clients.values()) c.socket.ping();
}, 25000);

server.listen(PORT, () => {
  console.log('');
  console.log('  泡泡大作戰 開好了！在瀏覽器打開：');
  console.log('    本機    http://localhost:' + PORT);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log('    同網段  http://' + net.address + ':' + PORT + '   ← 平板／手機用這個');
      }
    }
  }
  console.log('');
  console.log('  線上對戰已啟用（WebSocket /ws）。要關掉請按 Ctrl+C');
  console.log('');
});
