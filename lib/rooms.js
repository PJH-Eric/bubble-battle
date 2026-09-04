/* ===== lib/rooms.js — 房間、席位、觀戰、準備、邀請、聊天 =====
 * 只管規則以外的事，完全不碰 socket，所以可以直接寫測試。
 * 對局本身交給 public/js/rules.js（前後端同一套規則核心）。
 */
'use strict';

const Rules = require('../public/js/rules.js');
const AI = require('../public/js/ai.js');
const Maps = require('../public/js/maps.js');
const Characters = require('../public/js/themes/characters.js');

const CONST = {
  MAX_ROOMS: 40,
  MAX_SPECTATORS: 20,
  CHAT_KEEP: 60,
  CHAT_MAX_LEN: 60,
  RECONNECT_MS: 30000,
  COUNTDOWN_MS: 3000,
  RESULT_MS: 8000,
  EMPTY_ROOM_MS: 60000
};

const LEVELS = ['baby', 'easy', 'normal', 'hard'];
const LEVEL_LABEL = { baby: '幼幼班', easy: '簡單', normal: '普通', hard: '困難' };

let seq = 1;
const nextId = prefix => prefix + (seq++).toString(36) + Math.random().toString(36).slice(2, 6);

function token() {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 12; i++) out += abc[Math.floor(Math.random() * abc.length)];
  return out;
}

function clean(text, max) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, max);
}

function createHub(opt) {
  opt = opt || {};
  const now = opt.now || (() => Date.now());
  const rooms = new Map();
  const invites = new Map();

  const seats = room => [...room.members.values()].filter(m => m.role === 'player');
  const spectators = room => [...room.members.values()].filter(m => m.role === 'spectator');
  const seatCount = room => seats(room).length + room.ais.length;
  const nameOf = (room, id) => (room.members.get(id) || {}).name || '';
  const mapName = id => {
    const m = Maps.MAPS.find(x => x.id === id);
    return m ? m.name : '隨機地圖';
  };

  function createRoom(host, cfg) {
    if (rooms.size >= CONST.MAX_ROOMS) return { error: '房間數量已經滿了，等一下再試試' };
    cfg = cfg || {};
    const room = {
      id: nextId('r'),
      name: clean(cfg.name, 16) || (clean(host.name, 6) || '玩家') + ' 的房間',
      mode: cfg.mode === 'team' ? 'team' : 'solo',
      maxPlayers: Math.min(8, Math.max(2, Number(cfg.maxPlayers) || 4)),
      mapId: cfg.mapId || 'open',
      random: cfg.mapId === 'random' || !!cfg.random,
      field: cfg.field || 'meadow',
      negativeItems: cfg.negativeItems !== false,
      hostId: host.id,
      members: new Map(),
      ais: [],
      chat: [],
      phase: 'lobby',
      match: null,
      ai: null,
      pending: null,
      inputs: new Map(),
      lastSeq: new Map(),
      countdownUntil: 0,
      resultUntil: 0,
      invite: null,
      createdAt: now(),
      emptyAt: 0
    };
    rooms.set(room.id, room);
    join(room.id, host);
    return { room };
  }

  function listRooms() {
    const out = [];
    for (const room of rooms.values()) {
      out.push({
        id: room.id,
        name: room.name,
        mode: room.mode,
        phase: room.phase,
        players: seatCount(room),
        maxPlayers: room.maxPlayers,
        spectators: spectators(room).length,
        mapName: room.random ? '隨機地圖' : mapName(room.mapId),
        hostName: nameOf(room, room.hostId)
      });
    }
    return out.sort((a, b) =>
      (a.phase === 'lobby' ? 0 : 1) - (b.phase === 'lobby' ? 0 : 1) || b.players - a.players);
  }

  function join(roomId, person, wantRole) {
    const room = rooms.get(roomId);
    if (!room) return { error: '這個房間已經不在了' };

    const exist = room.members.get(person.id);
    if (exist) {
      exist.connected = true;
      exist.disconnectedAt = 0;
      if (person.name) exist.name = clean(person.name, 6) || exist.name;
      return { room, member: exist, rejoined: true };
    }

    let role = wantRole === 'spectator' ? 'spectator' : 'player';
    if (role === 'player' && (seatCount(room) >= room.maxPlayers || room.phase !== 'lobby')) role = 'spectator';
    if (role === 'spectator' && spectators(room).length >= CONST.MAX_SPECTATORS) {
      return { error: '這個房間的觀戰人數也滿了' };
    }

    const member = {
      id: person.id,
      name: clean(person.name, 6) || '玩家',
      char: person.char || 'cat',
      role,
      ready: false,
      team: 0,
      connected: true,
      disconnectedAt: 0,
      joinedAt: now()
    };
    room.members.set(member.id, member);
    balanceTeams(room);
    room.emptyAt = 0;
    return { room, member, becameSpectator: wantRole !== 'spectator' && role === 'spectator' };
  }

  function quickJoin(person) {
    const open = [...rooms.values()]
      .filter(r => r.phase === 'lobby' && seatCount(r) < r.maxPlayers)
      .sort((a, b) => seatCount(b) - seatCount(a));
    if (open.length) return join(open[0].id, person);
    return createRoom(person, {});
  }

  function leave(roomId, personId) {
    const room = rooms.get(roomId);
    if (!room) return null;
    if (!room.members.has(personId)) return null;
    room.members.delete(personId);
    room.inputs.delete(personId);

    if (room.match && room.match.phase === 'playing') {
      const p = room.match.players.find(x => x.id === personId);
      if (p && p.state !== 'dead') {
        p.state = 'dead';
        p.stats.survived = room.match.time;
        room.match.events.push({ type: 'dead', by: p.id, cause: 'leave' });
      }
    }

    if (room.hostId === personId) {
      const next = seats(room)[0] || spectators(room)[0];
      if (next) {
        room.hostId = next.id;
        systemChat(room, next.name + ' 成為新的房主');
      }
    }
    if (!room.members.size) room.emptyAt = now();
    else balanceTeams(room);
    return room;
  }

  function markDisconnected(personId) {
    const touched = [];
    for (const room of rooms.values()) {
      const m = room.members.get(personId);
      if (!m) continue;
      m.connected = false;
      m.disconnectedAt = now();
      m.ready = false;
      touched.push(room);
    }
    return touched;
  }

  /* ---------- 房間設定 ---------- */

  function updateRoom(roomId, hostId, cfg) {
    const room = rooms.get(roomId);
    if (!room) return { error: '房間不在了' };
    if (room.hostId !== hostId) return { error: '只有房主可以改設定' };
    if (room.phase !== 'lobby') return { error: '對局進行中不能改設定' };

    if (cfg.name != null) room.name = clean(cfg.name, 16) || room.name;
    if (cfg.mode === 'solo' || cfg.mode === 'team') room.mode = cfg.mode;
    if (cfg.maxPlayers != null) {
      room.maxPlayers = Math.min(8, Math.max(2, Number(cfg.maxPlayers) || 4));
      while (seatCount(room) > room.maxPlayers && room.ais.length) room.ais.pop();
      while (seatCount(room) > room.maxPlayers) {
        const list = seats(room);
        const last = list[list.length - 1];
        if (!last) break;
        last.role = 'spectator';
      }
    }
    if (cfg.mapId != null) { room.mapId = cfg.mapId; room.random = cfg.mapId === 'random'; }
    if (cfg.field != null) room.field = cfg.field;
    if (cfg.negativeItems != null) room.negativeItems = !!cfg.negativeItems;
    balanceTeams(room);
    resetReady(room);
    return { room };
  }

  function addAI(roomId, hostId, level) {
    const room = rooms.get(roomId);
    if (!room) return { error: '房間不在了' };
    if (room.hostId !== hostId) return { error: '只有房主可以加電腦' };
    if (room.phase !== 'lobby') return { error: '對局進行中不能加電腦' };
    if (seatCount(room) >= room.maxPlayers) return { error: '席位滿了' };
    const lv = LEVELS.indexOf(level) === -1 ? 'normal' : level;
    const used = new Set([...room.members.values()].map(m => m.char).concat(room.ais.map(a => a.char)));
    const pick = Characters.CHARACTERS.find(c => !used.has(c.id)) || Characters.CHARACTERS[0];
    room.ais.push({ id: nextId('ai'), name: pick.name, char: pick.id, level: lv, team: 0 });
    balanceTeams(room);
    resetReady(room);
    return { room };
  }

  function removeAI(roomId, hostId, aiId) {
    const room = rooms.get(roomId);
    if (!room) return { error: '房間不在了' };
    if (room.hostId !== hostId) return { error: '只有房主可以移除電腦' };
    const i = aiId ? room.ais.findIndex(a => a.id === aiId) : room.ais.length - 1;
    if (i >= 0) room.ais.splice(i, 1);
    balanceTeams(room);
    resetReady(room);
    return { room };
  }

  function kick(roomId, hostId, targetId) {
    const room = rooms.get(roomId);
    if (!room) return { error: '房間不在了' };
    if (room.hostId !== hostId) return { error: '只有房主可以踢人' };
    if (targetId === hostId) return { error: '不能踢自己' };
    const member = room.members.get(targetId);
    if (!member) return { error: '這個人已經不在房間裡了' };
    systemChat(room, member.name + ' 被房主請出房間');
    leave(roomId, targetId);
    return { room, kicked: targetId };
  }

  function setReady(roomId, personId, ready) {
    const room = rooms.get(roomId);
    if (!room) return { error: '房間不在了' };
    const m = room.members.get(personId);
    if (!m || m.role !== 'player') return { error: '只有入座的玩家要按準備' };
    m.ready = !!ready;
    return { room };
  }

  function takeSeat(roomId, personId, want) {
    const room = rooms.get(roomId);
    if (!room) return { error: '房間不在了' };
    const m = room.members.get(personId);
    if (!m) return { error: '你不在這個房間裡' };
    if (want === 'spectator') { m.role = 'spectator'; m.ready = false; balanceTeams(room); return { room }; }
    if (room.phase !== 'lobby') return { error: '對局進行中不能入座，等這一局結束' };
    if (seatCount(room) >= room.maxPlayers) return { error: '席位滿了' };
    m.role = 'player';
    m.ready = false;
    balanceTeams(room);
    return { room };
  }

  function resetReady(room) {
    for (const m of room.members.values()) m.ready = false;
  }

  function balanceTeams(room) {
    const list = seats(room).concat(room.ais);
    list.forEach((x, i) => { x.team = room.mode === 'team' ? i % 2 : i; });
  }

  function allReady(room) {
    const list = seats(room);
    if (seatCount(room) < 2) return false;
    return list.length > 0 && list.every(m => m.ready && m.connected);
  }

  /* ---------- 邀請連結（不設時限，房間還在就有效） ---------- */

  function makeInvite(roomId, hostId) {
    const room = rooms.get(roomId);
    if (!room) return { error: '房間不在了' };
    if (room.hostId !== hostId) return { error: '只有房主可以發邀請連結' };
    if (room.invite) invites.delete(room.invite.token);
    const t = token();
    room.invite = { token: t, createdAt: now() };
    invites.set(t, room.id);
    return { room, token: t };
  }

  function revokeInvite(roomId, hostId) {
    const room = rooms.get(roomId);
    if (!room) return { error: '房間不在了' };
    if (room.hostId !== hostId) return { error: '只有房主可以撤銷邀請連結' };
    if (room.invite) {
      invites.delete(room.invite.token);
      room.invite = null;
    }
    return { room };
  }

  function resolveInvite(t) {
    const roomId = invites.get(String(t || ''));
    if (!roomId) return { error: '這個邀請連結無效或已經被撤銷了' };
    const room = rooms.get(roomId);
    if (!room) return { error: '這個房間已經結束了' };
    return { room };
  }

  /* ---------- 聊天 ---------- */

  function chat(roomId, personId, text) {
    const room = rooms.get(roomId);
    if (!room) return { error: '房間不在了' };
    const m = room.members.get(personId);
    if (!m) return { error: '你不在這個房間裡' };
    const body = clean(text, CONST.CHAT_MAX_LEN);
    if (!body) return { error: '沒有內容' };
    push(room, { id: nextId('c'), from: m.id, name: m.name, role: m.role, text: body, at: now() });
    return { room };
  }

  function systemChat(room, text) {
    push(room, { id: nextId('c'), from: null, name: '', role: 'system', text, at: now() });
  }

  function push(room, line) {
    room.chat.push(line);
    if (room.chat.length > CONST.CHAT_KEEP) room.chat.shift();
  }

  /* ---------- 對局 ---------- */

  function start(roomId, hostId) {
    const room = rooms.get(roomId);
    if (!room) return { error: '房間不在了' };
    if (hostId && room.hostId !== hostId) return { error: '只有房主可以開始' };
    if (room.phase !== 'lobby') return { error: '已經開始了' };
    if (seatCount(room) < 2) return { error: '至少要兩個人（或加一個電腦）才能開始' };
    if (!allReady(room)) return { error: '還有人沒有按準備好' };

    room.phase = 'countdown';
    room.countdownUntil = now() + CONST.COUNTDOWN_MS;
    room.pending = buildMatchConfig(room);
    systemChat(room, '全員準備完成，馬上開始！');
    return { room };
  }

  function buildMatchConfig(room) {
    const players = seats(room).map(m => ({
      id: m.id, name: m.name, char: m.char, team: m.team, isAI: false
    })).concat(room.ais.map(a => ({
      id: a.id, name: a.name + '（' + LEVEL_LABEL[a.level] + '）', char: a.char,
      team: a.team, isAI: true, difficulty: a.level
    })));
    return {
      seed: room.id + ':' + now(),
      mode: room.mode,
      mapId: room.random ? null : room.mapId,
      random: room.random,
      negativeItems: room.negativeItems,
      players
    };
  }

  function beginMatch(room) {
    room.match = Rules.createMatch(room.pending);
    room.ai = AI.create();
    room.inputs = new Map();
    room.lastSeq = new Map();
    room.phase = 'playing';
    return room.match;
  }

  function setInput(roomId, personId, input) {
    const room = rooms.get(roomId);
    if (!room || room.phase !== 'playing' || !room.match) return;
    const p = room.match.players.find(x => x.id === personId);
    if (!p || p.state === 'dead') return;
    const prev = room.inputs.get(personId);
    room.inputs.set(personId, {
      dx: Math.max(-1, Math.min(1, input.dx | 0)),
      dy: Math.max(-1, Math.min(1, input.dy | 0)),
      drop: !!input.drop || (prev ? prev.drop : false)
    });
    if (input.seq != null) room.lastSeq.set(personId, input.seq | 0);
  }

  function tick(dt) {
    const t = now();
    const changed = new Set();
    for (const room of rooms.values()) {
      for (const m of [...room.members.values()]) {
        if (m.connected || !m.disconnectedAt) continue;
        if (t - m.disconnectedAt >= CONST.RECONNECT_MS) {
          systemChat(room, m.name + ' 斷線太久，先離場了');
          leave(room.id, m.id);
          changed.add(room);
        }
      }

      if (room.phase === 'countdown' && t >= room.countdownUntil) {
        beginMatch(room);
        changed.add(room);
      }

      if (room.phase === 'playing' && room.match) {
        const inputs = {};
        for (const p of room.match.players) {
          if (p.isAI) inputs[p.id] = room.ai.input(room.match, p, dt);
          else inputs[p.id] = room.inputs.get(p.id) || { dx: 0, dy: 0, drop: false };
        }
        Rules.step(room.match, inputs, dt);
        for (const [id, inp] of room.inputs) {
          if (inp.drop) room.inputs.set(id, { dx: inp.dx, dy: inp.dy, drop: false });
        }
        if (room.match.phase !== 'playing') {
          room.phase = 'result';
          room.resultUntil = t + CONST.RESULT_MS;
          resetReady(room);
          systemChat(room, matchResultText(room));
          changed.add(room);
        }
      }

      if (room.phase === 'result' && t >= room.resultUntil) {
        room.phase = 'lobby';
        room.match = null;
        room.ai = null;
        changed.add(room);
      }

      if (!room.members.size && room.emptyAt && t - room.emptyAt > CONST.EMPTY_ROOM_MS) {
        if (room.invite) invites.delete(room.invite.token);
        rooms.delete(room.id);
      }
    }
    return [...changed];
  }

  function matchResultText(room) {
    const m = room.match;
    if (!m) return '';
    if (m.mode === 'team') {
      if (m.winnerTeam == null) return '平手！';
      return (m.winnerTeam === 0 ? '藍隊' : '紅隊') + '獲勝！';
    }
    if (!m.winner) return '平手！';
    const p = m.players.find(x => x.id === m.winner);
    return (p ? p.name : '') + ' 獲勝！';
  }

  /* ---------- 給前端的資料 ---------- */

  function roomView(room, viewerId) {
    const me = room.members.get(viewerId);
    return {
      id: room.id,
      name: room.name,
      mode: room.mode,
      phase: room.phase,
      maxPlayers: room.maxPlayers,
      mapId: room.random ? 'random' : room.mapId,
      field: room.field,
      negativeItems: room.negativeItems,
      hostId: room.hostId,
      youAreHost: room.hostId === viewerId,
      yourRole: me ? me.role : 'spectator',
      yourId: viewerId,
      countdownMs: room.phase === 'countdown' ? Math.max(0, room.countdownUntil - now()) : 0,
      invite: room.invite ? room.invite.token : null,
      members: [...room.members.values()].map(m => ({
        id: m.id, name: m.name, char: m.char, role: m.role,
        ready: m.ready, team: m.team, connected: m.connected
      })),
      ais: room.ais.map(a => ({
        id: a.id, name: a.name, char: a.char, level: a.level,
        team: a.team, label: LEVEL_LABEL[a.level]
      })),
      chat: room.chat.slice(-30),
      canStart: room.hostId === viewerId && room.phase === 'lobby' && allReady(room)
    };
  }

  function snapshot(room, opts) {
    const m = room.match;
    if (!m) return null;
    opts = opts || {};
    const snap = {
      tick: m.tick,
      time: +m.time.toFixed(2),
      duration: m.duration,
      matchPhase: m.phase,
      players: m.players.map(p => ({
        id: p.id, x: +p.x.toFixed(3), y: +p.y.toFixed(3), dir: p.dir, moving: p.moving,
        state: p.state, invuln: +p.invuln.toFixed(2), trapTimer: +Math.max(0, p.trapTimer).toFixed(2),
        bombMax: p.bombMax, power: p.power, speed: +p.speed.toFixed(2),
        needle: p.needle, glove: p.glove, team: p.team, char: p.char, name: p.name,
        boxes: p.stats.boxes
      })),
      bombs: m.bombs.map(b => ({
        id: b.id, c: b.c, r: b.r, px: +b.px.toFixed(3), py: +b.py.toFixed(3),
        fuse: +b.fuse.toFixed(2), power: b.power
      })),
      blasts: m.blasts.map(b => ({ ttl: +b.ttl.toFixed(2), life: b.life, cells: b.cells })),
      items: m.items.map(i => ({ c: i.c, r: i.r, type: i.type })),
      ackSeq: opts.viewerId ? (room.lastSeq.get(opts.viewerId) || 0) : 0
    };
    if (m.phase !== 'playing') {
      snap.winner = m.winner;
      snap.winnerTeam = m.winnerTeam;
      snap.reason = m.reason;
      snap.resultText = matchResultText(room);
      snap.standings = m.players.map(p => ({
        id: p.id, name: p.name, char: p.char, team: p.team,
        survived: Math.round(p.stats.survived || m.time), boxes: p.stats.boxes
      }));
    }
    if (opts.full) {
      snap.full = true;
      snap.cols = m.cols;
      snap.rows = m.rows;
      snap.tiles = Array.from(m.tiles);
      snap.mapName = m.mapName;
      snap.mode = m.mode;
      snap.field = room.field;
    }
    return snap;
  }

  /** 地圖只在開場送整張，之後只送「哪一格變成什麼」 */
  function tileDiff(room, prevTiles) {
    const m = room.match;
    if (!m || !prevTiles) return null;
    const diff = [];
    for (let i = 0; i < m.tiles.length; i++) {
      if (m.tiles[i] !== prevTiles[i]) diff.push(i, m.tiles[i]);
    }
    return diff.length ? diff : null;
  }

  return {
    CONST, LEVELS, LEVEL_LABEL,
    rooms, invites,
    createRoom, listRooms, join, quickJoin, leave, markDisconnected,
    updateRoom, addAI, removeAI, kick, setReady, takeSeat,
    makeInvite, revokeInvite, resolveInvite,
    chat, systemChat,
    start, beginMatch, setInput, tick, matchResultText,
    roomView, snapshot, tileDiff,
    seats, spectators, seatCount, allReady,
    get: id => rooms.get(id)
  };
}

module.exports = { createHub, CONST, LEVEL_LABEL, LEVELS };
