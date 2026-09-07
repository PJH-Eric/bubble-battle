/* ===== net.js — 把伺服器快照變成可以畫的畫面 =====
 *
 * 三件事：
 *   1. 其他玩家用「延遲 120 毫秒的插值」畫，看起來才會滑順
 *   2. 自己的角色用本地預測，按下去馬上動，不用等伺服器來回
 *   3. 收到快照後做對帳：把自己的位置校正回伺服器版本，再把「這張快照產生之後」的輸入重播一次
 *
 * 對帳為什麼看時間、不看序號：
 * 伺服器不是把輸入當成一筆一筆的指令消化掉，而是「記住最後一次的方向，每個 tick 都照著走」。
 * 所以序號沒有辦法對應到一段固定的模擬時間，只有時間可以。做法是前端每包輸入都帶自己的時戳，
 * 伺服器把它連同「在我這邊放了多久」一起塞回快照，前端就能推回這張快照是自己時鐘的幾點產生的，
 * 只重播那之後的輸入。（舊版拿前端每幀的計數器去比伺服器每包訊息的計數器，兩個數字快了三倍，
 * pending 永遠清不掉，於是每張快照都重播上限 90 幀的舊輸入 —— 角色就會自己亂跑。）
 */
(function (root) {
  'use strict';
  const Rules = root.Rules;
  const DELAY = 0.12;         /* 插值緩衝（秒） */
  const SMOOTH_TAU = 0.05;    /* 校正誤差在畫面上收斂的時間常數（秒） */
  const MAX_REPLAY = 0.5;     /* 最多重播這麼久的輸入，網路爆掉時才不會暴衝 */
  const SNAP_DIST = 1.5;      /* 誤差超過這麼多格就直接跳過去（重生、被拉走） */

  function create() {
    let view = null;           /* 給 render.js 用的畫面狀態 */
    let buffer = [];           /* 最近的快照 */
    let meId = null;
    let pending = [];          /* 最近送出的輸入，每筆帶前端時戳：{ t, dx, dy, dt } */
    let seq = 0;
    let clock = 0;
    let lagDown = 0.05;        /* 估出來的「伺服器→前端」單程延遲（秒） */
    /* 畫面上還沒收掉的位移。存的是「現在畫面比 local 偏多少」，不是原始誤差，
     * 這樣每次對帳都能算出讓畫面連續的新偏移，角色才不會在快照到達的瞬間往回彈。 */
    let off = { x: 0, y: 0 };

    function reset() {
      view = null; buffer = []; pending = []; seq = 0; clock = 0;
      lagDown = 0.05;
      off = { x: 0, y: 0 };
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

      /* 先更新延遲估計：這張快照在「前端時鐘」上是幾點產生的 */
      if (typeof snap.ackCt === 'number' && snap.ackCt > 0) {
        const rtt = at - snap.ackCt / 1000 - (snap.ackAge || 0);
        if (rtt >= 0 && rtt < 2) lagDown = lagDown * 0.85 + Math.min(MAX_REPLAY, rtt / 2) * 0.15;
      }

      /* 對帳：自己的位置以伺服器為準，再把這張快照產生之後的輸入重播一遍 */
      const mine = snap.players.find(p => p.id === meId);
      if (mine) {
        const before = local ? { x: local.x, y: local.y } : null;
        const me = ensureLocal(mine);
        me.x = mine.x; me.y = mine.y;
        me.speed = mine.speed;
        me.glove = mine.glove;
        me.state = mine.state;
        me.dir = mine.dir || me.dir;

        /* 這張快照在前端時鐘上的產生時刻 = 現在 − 單程延遲 − 伺服器模擬本身落後的那一點 */
        const age = Math.min(MAX_REPLAY, lagDown + (snap.simLag || 0));
        const since = at - age;
        pending = pending.filter(inp => inp.t > since);
        for (const inp of pending) stepLocal(me, inp.dx, inp.dy, inp.dt);

        /* 校正不要硬跳：算出「維持畫面位置不變」所需的新偏移，再讓它慢慢收斂到 0。
         * 注意要用 before + 目前偏移（也就是這一刻畫面上的位置）去減，
         * 只用 before 的話畫面會在每張快照到達時彈一下，看起來就像走一走突然倒退。 */
        if (before && me.state === 'alive') {
          const ox = before.x + off.x - me.x;
          const oy = before.y + off.y - me.y;
          if (Math.abs(ox) + Math.abs(oy) <= SNAP_DIST) off = { x: ox, y: oy };
          else off = { x: 0, y: 0 };
        } else {
          off = { x: 0, y: 0 };
        }
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
      /* 畫面偏移每一幀往 0 收斂。收斂速度要壓在角色速度以下，
       * 不然偏移大的時候「往回收」會比「往前走」還快，畫面上就變成按著方向鍵卻在倒退。 */
      if (off.x || off.y) {
        const len = Math.hypot(off.x, off.y);
        const speed = (local && local.speed) || Rules.C.BASE_SPEED;
        const pull = Math.min(len - len * Math.exp(-dt / SMOOTH_TAU), speed * 0.8 * dt);
        const k = pull > 0 ? Math.max(0, (len - pull) / len) : 1;
        off.x *= k; off.y *= k;
        if (Math.abs(off.x) < 1e-4) off.x = 0;
        if (Math.abs(off.y) < 1e-4) off.y = 0;
      }

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
          pending.push({ t: now, dx: input.dx, dy: input.dy, dt });
          /* 只留得住的那一段：比最長重播時間再多一點點就好 */
          const keepFrom = now - (MAX_REPLAY + 0.25);
          while (pending.length && pending[0].t < keepFrom) pending.shift();
        }
        const idx = view.players.findIndex(p => p.id === meId);
        if (idx >= 0) {
          const server = view.players[idx];
          view.players[idx] = Object.assign({}, server, {
            x: local.state === 'alive' ? local.x + off.x : server.x,
            y: local.state === 'alive' ? local.y + off.y : server.y,
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
      get lag() { return lagDown; },
      get view() { return view; },
      get local() { return local; },
      clearLocal() { local = null; }
    };
  }

  root.Net = { create, DELAY };
})(typeof self !== 'undefined' ? self : this);
