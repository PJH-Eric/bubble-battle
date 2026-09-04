/* ===== net.js — 把伺服器快照變成可以畫的畫面 =====
 *
 * 三件事：
 *   1. 其他玩家用「延遲 120 毫秒的插值」畫，看起來才會滑順
 *   2. 自己的角色用本地預測，按下去馬上動，不用等伺服器來回
 *   3. 收到快照後做對帳：把自己的位置校正回伺服器版本，再把還沒被確認的輸入重播一次
 */
(function (root) {
  'use strict';
  const Rules = root.Rules;
  const DELAY = 0.12;         /* 插值緩衝（秒） */

  function create() {
    let view = null;           /* 給 render.js 用的畫面狀態 */
    let buffer = [];           /* 最近的快照 */
    let meId = null;
    let pending = [];          /* 還沒被伺服器確認的輸入 */
    let seq = 0;
    let clock = 0;

    function reset() {
      view = null; buffer = []; pending = []; seq = 0; clock = 0;
    }

    /** 收到伺服器快照 */
    function onSnapshot(snap, myId) {
      meId = myId;
      const at = performance.now() / 1000;

      if (snap.full || !view) {
        view = {
          cols: snap.cols, rows: snap.rows,
          tiles: (snap.tiles || []).slice(),
          mapName: snap.mapName || '',
          mode: snap.mode || 'solo',
          duration: snap.duration,
          time: snap.time,
          players: [], bombs: [], blasts: [], items: [],
          phase: 'playing'
        };
        buffer = [];
        pending = [];
      }
      if (snap.tileDiff) {
        for (let i = 0; i < snap.tileDiff.length; i += 2) view.tiles[snap.tileDiff[i]] = snap.tileDiff[i + 1];
      }
      if (snap.tiles && !snap.full) view.tiles = snap.tiles.slice();

      view.duration = snap.duration;
      view.time = snap.time;

      buffer.push({ at, snap });
      while (buffer.length > 20) buffer.shift();

      /* 對帳：自己的位置以伺服器為準，再重播還沒確認的輸入 */
      const mine = snap.players.find(p => p.id === meId);
      if (mine) {
        pending = pending.filter(inp => inp.seq > (snap.ackSeq || 0));
        const local = ensureLocal(mine);
        local.x = mine.x; local.y = mine.y;
        local.speed = mine.speed;
        local.glove = mine.glove;
        local.state = mine.state;
        for (const inp of pending) stepLocal(local, inp.dx, inp.dy, inp.dt);
      }
    }

    let local = null;
    function ensureLocal(serverMe) {
      if (!local) local = Object.assign({}, serverMe, { effects: { turtle: 0 }, dir: serverMe.dir || 'down' });
      else Object.assign(local, {
        bombMax: serverMe.bombMax, power: serverMe.power, needle: serverMe.needle,
        team: serverMe.team, char: serverMe.char, name: serverMe.name, boxes: serverMe.boxes,
        invuln: serverMe.invuln, trapTimer: serverMe.trapTimer
      });
      return local;
    }

    /** 用同一套規則核心走一步（線上與單機手感一致） */
    function stepLocal(p, dx, dy, dt) {
      if (!view || p.state !== 'alive') return;
      const fake = {
        cols: view.cols, rows: view.rows, tiles: view.tiles,
        bombs: view.bombs.map(b => ({
          c: b.c, r: b.r, px: b.px, py: b.py, moveDir: null, power: b.power, id: b.id,
          pass: overlaps(p, b) ? [p.id] : []
        })),
        players: [p], events: []
      };
      Rules.applyMove(fake, p, dx, dy, dt);
    }

    function overlaps(p, b) {
      const R = Rules.C.PLAYER_R, EPS = 0.02;
      return p.x + R > b.c + EPS && p.x - R < b.c + 1 - EPS
        && p.y + R > b.r + EPS && p.y - R < b.r + 1 - EPS;
    }

    /** 每一幀：本地預測 + 插值，回傳可以直接丟給 render.js 的狀態 */
    function frame(dt, input) {
      if (!view) return null;
      clock += dt;

      /* 1. 插值出「大家在 120ms 前的位置」 */
      const now = performance.now() / 1000;
      const target = now - DELAY;
      let a = null, b = null;
      for (let i = buffer.length - 1; i >= 0; i--) {
        if (buffer[i].at <= target) { a = buffer[i]; b = buffer[i + 1] || null; break; }
      }
      if (!a) { a = buffer[0]; b = buffer[1] || null; }
      if (!a) return view;

      const alpha = b && b.at > a.at ? Math.min(1, Math.max(0, (target - a.at) / (b.at - a.at))) : 0;
      const snapA = a.snap, snapB = b ? b.snap : null;

      view.players = snapA.players.map(p => {
        const q = snapB && snapB.players.find(x => x.id === p.id);
        const out = Object.assign({}, p);
        if (q) {
          out.x = p.x + (q.x - p.x) * alpha;
          out.y = p.y + (q.y - p.y) * alpha;
          if (Math.abs(q.x - p.x) + Math.abs(q.y - p.y) > 1.5) { out.x = q.x; out.y = q.y; }
        }
        return out;
      });
      view.bombs = (snapB || snapA).bombs.map(bb => {
        const prev = snapA.bombs.find(x => x.id === bb.id);
        const out = Object.assign({}, bb);
        if (prev && snapB) {
          out.px = prev.px + (bb.px - prev.px) * alpha;
          out.py = prev.py + (bb.py - prev.py) * alpha;
        }
        return out;
      });
      const latest = buffer[buffer.length - 1].snap;
      view.blasts = latest.blasts;
      view.items = latest.items;
      view.time = latest.time;
      view.mode = latest.mode || view.mode;

      /* 2. 自己的角色改用本地預測的位置，按下去就會動 */
      if (meId && local) {
        if (input && local.state === 'alive') {
          seq++;
          stepLocal(local, input.dx, input.dy, dt);
          pending.push({ seq, dx: input.dx, dy: input.dy, dt });
          if (pending.length > 90) pending.shift();
        }
        const idx = view.players.findIndex(p => p.id === meId);
        if (idx >= 0) {
          const server = view.players[idx];
          view.players[idx] = Object.assign({}, server, {
            x: local.state === 'alive' ? local.x : server.x,
            y: local.state === 'alive' ? local.y : server.y,
            dir: local.dir,
            moving: !!(input && (input.dx || input.dy)) && local.state === 'alive'
          });
        }
      }
      return view;
    }

    return {
      reset, onSnapshot, frame,
      get seq() { return seq; },
      get view() { return view; },
      get local() { return local; },
      clearLocal() { local = null; }
    };
  }

  root.Net = { create, DELAY };
})(typeof self !== 'undefined' ? self : this);
