/* ===== rules.js — 泡泡大作戰的規則核心 =====
 *
 * 這是全遊戲唯一的規則來源：單機在瀏覽器跑它，之後線上模式由 Node 伺服器跑同一支檔案，
 * AI 也只是產生和真人一模一樣格式的輸入。純函式、無 DOM、無 socket、無計時器。
 *
 * 座標：以「格」為單位的浮點數。格子 (c,r) 的中心是 (c+0.5, r+0.5)。
 * 時間：呼叫端用固定步長推進（Rules.STEP），才能重播與同步。
 */
(function (root, factory) {
  'use strict';
  const isNode = typeof module === 'object' && module.exports;
  const RNG = isNode ? require('./rng.js') : root.RNG;
  const Maps = isNode ? require('./maps.js') : root.Maps;
  const api = factory(RNG, Maps);
  if (isNode) module.exports = api;
  else root.Rules = api;
})(typeof self !== 'undefined' ? self : this, function (RNG, Maps) {
  'use strict';

  const EMPTY = Maps.EMPTY, HARD = Maps.HARD, SOFT = Maps.SOFT;

  const C = {
    STEP: 1 / 60,
    PLAYER_R: 0.30,        /* 角色半徑（格），比半格小才擠得過轉角 */
    BASE_SPEED: 3.2,       /* 格／秒 */
    SPEED_STEP: 0.35,
    MAX_SPEED: 6.0,
    BASE_POWER: 1,
    MAX_POWER: 8,
    BASE_BOMBS: 1,
    MAX_BOMBS: 8,
    FUSE: 3.0,             /* 水球幾秒後爆 */
    BLAST_TTL: 0.5,        /* 水柱殘留（仍有傷害判定） */
    TRAP_SOLO: 3.5,        /* 個人混戰：泡泡 3.5 秒，不能互救 */
    TRAP_TEAM: 5.0,        /* 組隊：泡泡 5 秒，隊友可救 */
    STRUGGLE_SOLO: 0.30,   /* 左右交替掙脫，每次扣的秒數 */
    STRUGGLE_TEAM: 0.25,
    STRUGGLE_CD: 0.12,     /* 輸入冷卻，防連打作弊 */
    INVULN: 1.5,           /* 脫困後的無敵 */
    EFFECT_TURTLE: 8,
    EFFECT_MINI: 8,
    EFFECT_REVERSE: 5,
    SHIELD_TIME: 3,
    KICK_SPEED: 6.5,       /* 被踢的水球滑多快（格／秒） */
    DROP_RATE: 0.42        /* 軟箱掉道具的機率 */
  };

  const GOOD_ITEMS = [
    { type: 'bomb', w: 25 },
    { type: 'power', w: 25 },
    { type: 'shoe', w: 17 },
    { type: 'glove', w: 9 },
    { type: 'needle', w: 6 },
    { type: 'shield', w: 8 }
  ];
  const BAD_ITEMS = [
    { type: 'turtle', w: 7 },
    { type: 'mini', w: 5 },
    { type: 'reverse', w: 4 }
  ];

  /* ---------- 小工具 ---------- */

  const idx = (s, c, r) => r * s.cols + c;
  const tileAt = (s, c, r) => (c < 0 || r < 0 || c >= s.cols || r >= s.rows) ? HARD : s.tiles[idx(s, c, r)];
  const cellOf = p => ({ c: Math.floor(p.x), r: Math.floor(p.y) });
  const key = (c, r) => c + ':' + r;

  function bombAt(s, c, r) {
    for (const b of s.bombs) if (b.c === c && b.r === r) return b;
    return null;
  }

  function itemAt(s, c, r) {
    for (const it of s.items) if (it.c === c && it.r === r) return it;
    return null;
  }

  /* ---------- 建立一局 ---------- */

  /**
   * @param {object} cfg
   *   cols, rows      盤面大小（預設依人數）
   *   mapId / random  固定地圖 id，或隨機生成
   *   seed            亂數種子
   *   mode            'solo' | 'team'
   *   duration        局時（秒）
   *   negativeItems   是否放負面道具
   *   players         [{id,name,char,team,isAI,difficulty}]
   */
  function createMatch(cfg) {
    const players = cfg.players || [];
    const count = players.length;
    const cols = cfg.cols || (count > 4 || cfg.mode === 'team' ? 17 : 15);
    const rows = cfg.rows || (count > 4 || cfg.mode === 'team' ? 15 : 13);
    const seed = cfg.seed == null ? String(Date.now()) : cfg.seed;

    const map = Maps.build({ cols, rows, mapId: cfg.mapId, random: !!cfg.random, seed, playerCount: count });

    const state = {
      seed,
      cols, rows,
      tiles: map.tiles,
      mapId: map.mapId, mapName: map.mapName, mapDesc: map.mapDesc,
      spawns: map.spawns,
      mode: cfg.mode === 'team' ? 'team' : 'solo',
      duration: cfg.duration || 180,   /* 對局中地圖不會自己長出東西，時間到就比分 */
      negativeItems: cfg.negativeItems !== false,
      time: 0,
      tick: 0,
      phase: 'playing',
      winner: null,
      winnerTeam: null,
      reason: '',
      players: [],
      bombs: [],
      blasts: [],
      items: [],
      nextBombId: 1,
      rng: RNG.create(seed + ':play'),
      events: []
    };

    players.forEach((raw, i) => {
      const sp = map.spawns[i % map.spawns.length];
      state.players.push({
        id: raw.id,
        name: raw.name,
        char: raw.char,
        team: state.mode === 'team' ? (raw.team != null ? raw.team : i % 2) : i,
        isAI: !!raw.isAI,
        difficulty: raw.difficulty || 'normal',
        x: sp.c + 0.5,
        y: sp.r + 0.5,
        dir: 'down',
        moving: false,
        state: 'alive',
        trapTimer: 0,
        struggleCd: 0,
        lastStruggle: 0,
        invuln: 0,
        bombMax: C.BASE_BOMBS,
        power: C.BASE_POWER,
        speed: C.BASE_SPEED,
        bombsOut: 0,
        needle: false,
        glove: false,
        effects: { turtle: 0, mini: 0, reverse: 0 },
        aliveTime: 0,
        stats: { boxes: 0, items: 0, trapped: 0, survived: 0, rescues: 0 }
      });
    });

    return state;
  }

  /* ---------- 碰撞與移動 ---------- */

  function solidFor(s, p, c, r) {
    const t = tileAt(s, c, r);
    if (t === HARD || t === SOFT) return true;
    const b = bombAt(s, c, r);
    if (b && b.pass.indexOf(p.id) === -1) return true;
    return false;
  }

  function canStand(s, p, x, y) {
    const r = C.PLAYER_R;
    const c0 = Math.floor(x - r), c1 = Math.floor(x + r);
    const r0 = Math.floor(y - r), r1 = Math.floor(y + r);
    for (let c = c0; c <= c1; c++) {
      for (let rr = r0; rr <= r1; rr++) {
        if (solidFor(s, p, c, rr)) return false;
      }
    }
    return true;
  }

  /**
   * 單軸移動 + 轉角修正。
   * 撞牆時如果把身體對齊到通道中心就過得去，就自動幫玩家對齊——這是原版走位手感的關鍵。
   */
  function moveAxis(s, p, axis, dir, dist) {
    const PROBE = 0.03;   /* 對齊之後往前探一點點，確認那個方向真的通 */

    if (axis === 'x') {
      if (canStand(s, p, p.x + dir * dist, p.y)) {
        p.x += dir * dist;
        /* 邊走邊往通道中心靠，下一個轉彎才轉得過去 */
        const cy = Math.floor(p.y) + 0.5;
        const dy = cy - p.y;
        if (Math.abs(dy) > 1e-4) {
          const step = Math.min(dist * 0.8, Math.abs(dy));
          if (canStand(s, p, p.x, p.y + Math.sign(dy) * step)) p.y += Math.sign(dy) * step;
        }
        return true;
      }
      /* 前面卡住 → 只要對齊之後那個方向會通，就先把身體滑進通道（不要求同一幀就前進） */
      const cy = Math.floor(p.y) + 0.5;
      const dy = cy - p.y;
      if (Math.abs(dy) > 1e-4 && canStand(s, p, p.x + dir * PROBE, cy)) {
        p.y += Math.sign(dy) * Math.min(dist, Math.abs(dy));
        return true;
      }
      return false;
    }

    if (canStand(s, p, p.x, p.y + dir * dist)) {
      p.y += dir * dist;
      const cx = Math.floor(p.x) + 0.5;
      const dx = cx - p.x;
      if (Math.abs(dx) > 1e-4) {
        const step = Math.min(dist * 0.8, Math.abs(dx));
        if (canStand(s, p, p.x + Math.sign(dx) * step, p.y)) p.x += Math.sign(dx) * step;
      }
      return true;
    }
    const cx = Math.floor(p.x) + 0.5;
    const dx = cx - p.x;
    if (Math.abs(dx) > 1e-4 && canStand(s, p, cx, p.y + dir * PROBE)) {
      p.x += Math.sign(dx) * Math.min(dist, Math.abs(dx));
      return true;
    }
    return false;
  }

  /* ---------- 水球 ---------- */

  function placeBomb(s, p) {
    if (p.state !== 'alive') return false;
    if (p.bombsOut >= p.bombMax) return false;
    const cell = cellOf(p);
    if (tileAt(s, cell.c, cell.r) !== EMPTY) return false;
    if (bombAt(s, cell.c, cell.r)) return false;

    const pass = [];
    for (const q of s.players) {
      if (q.state === 'dead') continue;
      const qc = cellOf(q);
      if (qc.c === cell.c && qc.r === cell.r) pass.push(q.id);
    }
    s.bombs.push({
      id: s.nextBombId++,
      owner: p.id,
      c: cell.c, r: cell.r,
      px: cell.c + 0.5, py: cell.r + 0.5,
      moveDir: null,
      fuse: C.FUSE,
      power: p.effects.mini > 0 ? 1 : p.power,
      pass
    });
    p.bombsOut++;
    s.events.push({ type: 'bomb', c: cell.c, r: cell.r, by: p.id });
    return true;
  }

  /** 滑動中的水球下一格能不能過 */
  function blockedForBomb(s, bomb, c, r) {
    if (tileAt(s, c, r) !== EMPTY) return true;
    /* 別顆水球（含正在滑的） */
    for (const other of s.bombs) {
      if (other === bomb) continue;
      if (other.c === c && other.r === r) return true;
      if (Math.abs(other.px - (c + 0.5)) < 0.85 && Math.abs(other.py - (r + 0.5)) < 0.85
        && Math.round(other.px - 0.5) === c && Math.round(other.py - 0.5) === r) return true;
    }
    /* 人：用身體範圍判定，不只看中心點在哪一格，才不會從人身上滑過去 */
    const R = C.PLAYER_R;
    for (const p of s.players) {
      if (p.state === 'dead') continue;
      if (p.x + R > c && p.x - R < c + 1 && p.y + R > r && p.y - R < r + 1) return true;
    }
    return false;
  }

  /** 有手套的人撞到水球就把它踢出去 */
  function tryKick(s, p, axis, dir) {
    const cell = cellOf(p);
    const c = axis === 'x' ? cell.c + dir : cell.c;
    const r = axis === 'y' ? cell.r + dir : cell.r;
    const b = bombAt(s, c, r);
    if (!b || b.moveDir) return false;
    if (b.pass.indexOf(p.id) !== -1) return false;   /* 站在上面的不能踢 */
    const dx = axis === 'x' ? dir : 0;
    const dy = axis === 'y' ? dir : 0;
    /* 前面就是牆的話踢不動，也不要每幀都發一次音效 */
    if (blockedForBomb(s, b, b.c + dx, b.r + dy)) return false;
    b.moveDir = { dx, dy };
    b.pass = [];
    s.events.push({ type: 'kick', id: b.id, by: p.id });
    return true;
  }

  function detonate(s, first) {
    const queue = [first];
    const cells = [];
    const seen = new Set();

    while (queue.length) {
      const bomb = queue.shift();
      const i = s.bombs.indexOf(bomb);
      if (i === -1) continue;
      s.bombs.splice(i, 1);
      const owner = s.players.find(p => p.id === bomb.owner);
      if (owner) owner.bombsOut = Math.max(0, owner.bombsOut - 1);

      pushCell(bomb.c, bomb.r, 'center', null);

      for (const [dc, dr, dirName] of [[1, 0, 'right'], [-1, 0, 'left'], [0, 1, 'down'], [0, -1, 'up']]) {
        for (let n = 1; n <= bomb.power; n++) {
          const c = bomb.c + dc * n, r = bomb.r + dr * n;
          const t = tileAt(s, c, r);
          if (t === HARD) break;
          if (t === SOFT) {
            s.tiles[idx(s, c, r)] = EMPTY;
            if (owner) owner.stats.boxes++;
            s.events.push({ type: 'box', c, r, by: bomb.owner });
            maybeDropItem(s, c, r);
            break;
          }
          pushCell(c, r, n === bomb.power ? 'tip' : 'arm', dirName);
          const other = bombAt(s, c, r);
          if (other) { queue.push(other); break; }
        }
      }
    }

    function pushCell(c, r, kind, dirName) {
      const k = key(c, r);
      if (!seen.has(k)) {
        seen.add(k);
        cells.push({ c, r, kind, dir: dirName });
      }
      const it = itemAt(s, c, r);
      if (it) s.items.splice(s.items.indexOf(it), 1);
    }

    s.blasts.push({ cells, ttl: C.BLAST_TTL, life: C.BLAST_TTL });
    s.events.push({ type: 'explode', cells: cells.length, c: first.c, r: first.r });
  }

  function maybeDropItem(s, c, r) {
    if (!s.rng.chance(C.DROP_RATE)) return;
    const pool = s.negativeItems ? GOOD_ITEMS.concat(BAD_ITEMS) : GOOD_ITEMS;
    let total = 0;
    for (const e of pool) total += e.w;
    let n = s.rng.next() * total;
    for (const e of pool) {
      n -= e.w;
      if (n <= 0) { s.items.push({ c, r, type: e.type }); return; }
    }
  }

  function applyItem(s, p, type) {
    switch (type) {
      case 'bomb': p.bombMax = Math.min(C.MAX_BOMBS, p.bombMax + 1); break;
      case 'power': p.power = Math.min(C.MAX_POWER, p.power + 1); break;
      case 'shoe': p.speed = Math.min(C.MAX_SPEED, p.speed + C.SPEED_STEP); break;
      case 'needle': p.needle = true; break;
      case 'glove': p.glove = true; break;
      case 'shield': p.invuln = Math.max(p.invuln, C.SHIELD_TIME); break;
      case 'turtle': p.effects.turtle = C.EFFECT_TURTLE; break;
      case 'mini': p.effects.mini = C.EFFECT_MINI; break;
      case 'reverse': p.effects.reverse = C.EFFECT_REVERSE; break;
    }
    p.stats.items++;
    s.events.push({ type: 'item', item: type, by: p.id });
  }

  /* ---------- 淘汰與掉落 ---------- */

  function killPlayer(s, p, cause) {
    if (p.state === 'dead') return;
    p.state = 'dead';
    p.stats.survived = s.time;
    dropHalfItems(s, p);
    s.events.push({ type: 'dead', by: p.id, cause: cause || 'blast' });
  }

  /** 被淘汰時噴出一半道具（負面道具不噴） */
  function dropHalfItems(s, p) {
    const bag = [];
    for (let i = C.BASE_BOMBS; i < p.bombMax; i++) bag.push('bomb');
    for (let i = C.BASE_POWER; i < p.power; i++) bag.push('power');
    if (p.glove) bag.push('glove');
    const shoes = Math.round((p.speed - C.BASE_SPEED) / C.SPEED_STEP);
    for (let i = 0; i < shoes; i++) bag.push('shoe');
    if (p.needle) bag.push('needle');
    const n = Math.floor(bag.length / 2);
    if (n <= 0) return;
    s.rng.shuffle(bag);
    const spots = nearbyFreeCells(s, cellOf(p), n);
    for (let i = 0; i < spots.length; i++) {
      s.items.push({ c: spots[i][0], r: spots[i][1], type: bag[i] });
    }
  }

  function nearbyFreeCells(s, from, want) {
    const out = [];
    const seen = new Set([key(from.c, from.r)]);
    const queue = [[from.c, from.r]];
    while (queue.length && out.length < want) {
      const [c, r] = queue.shift();
      if (tileAt(s, c, r) === EMPTY && !itemAt(s, c, r) && !bombAt(s, c, r)) out.push([c, r]);
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nc = c + dc, nr = r + dr;
        const k = key(nc, nr);
        if (seen.has(k)) continue;
        seen.add(k);
        if (tileAt(s, nc, nr) !== HARD) queue.push([nc, nr]);
      }
    }
    return out.slice(0, want);
  }

  /* ---------- 主迴圈 ---------- */

  /**
   * 推進一個固定步長。
   * @param {object} s      對局狀態（會被就地修改）
   * @param {object} inputs { [playerId]: {dx,dy,drop} }
   * @param {number} dt     秒（請用 Rules.STEP）
   */
  function step(s, inputs, dt) {
    s.events = [];
    if (s.phase !== 'playing') return s;

    dt = dt || C.STEP;
    s.tick++;
    s.time += dt;
    inputs = inputs || {};

    /* 1. 玩家：移動、放球、掙脫 */
    for (const p of s.players) {
      if (p.state === 'dead') continue;
      p.aliveTime = s.time;
      if (p.invuln > 0) p.invuln = Math.max(0, p.invuln - dt);
      if (p.struggleCd > 0) p.struggleCd = Math.max(0, p.struggleCd - dt);
      for (const k of ['turtle', 'mini', 'reverse']) {
        if (p.effects[k] > 0) p.effects[k] = Math.max(0, p.effects[k] - dt);
      }

      const raw = inputs[p.id] || { dx: 0, dy: 0, drop: false };
      let dx = raw.dx | 0, dy = raw.dy | 0;
      if (p.effects.reverse > 0) { dx = -dx; dy = -dy; }

      if (p.state === 'trapped') {
        /* 左右交替掙脫 */
        if (dx !== 0 && dx !== p.lastStruggle && p.struggleCd <= 0) {
          p.trapTimer -= (s.mode === 'team' ? C.STRUGGLE_TEAM : C.STRUGGLE_SOLO);
          p.struggleCd = C.STRUGGLE_CD;
          p.lastStruggle = dx;
          s.events.push({ type: 'struggle', by: p.id });
        }
        p.trapTimer -= dt;
        if (p.trapTimer <= 0) freePlayer(s, p, 'self');
        continue;
      }

      p.moving = false;
      if (dx !== 0 || dy !== 0) {
        /* 四方向：兩軸同時按時，優先延續目前的軸 */
        let axis;
        if (dx !== 0 && dy !== 0) axis = (p.dir === 'left' || p.dir === 'right') ? 'x' : 'y';
        else axis = dx !== 0 ? 'x' : 'y';
        const dir = axis === 'x' ? dx : dy;
        const speed = p.speed * (p.effects.turtle > 0 ? 0.6 : 1);
        const moved = moveAxis(s, p, axis, dir, speed * dt);
        if (!moved && p.glove) tryKick(s, p, axis, dir);
        if (!moved && dx !== 0 && dy !== 0) {
          const other = axis === 'x' ? 'y' : 'x';
          const moved2 = moveAxis(s, p, other, other === 'x' ? dx : dy, speed * dt);
          if (!moved2 && p.glove) tryKick(s, p, other, other === 'x' ? dx : dy);
        }
        p.dir = axis === 'x' ? (dir > 0 ? 'right' : 'left') : (dir > 0 ? 'down' : 'up');
        p.moving = true;
      }

      if (raw.drop) placeBomb(s, p);
    }

    /* 2. 水球能不能被踩過去：身體還壓在上面就可以，離開了就變成牆。
     *    這樣被踢過來的水球或別人放在你腳下的水球都不會把你永遠卡住。 */
    {
      const R = C.PLAYER_R, EPS = 0.02;
      for (const b of s.bombs) {
        const inside = [];
        for (const p of s.players) {
          if (p.state === 'dead') continue;
          if (p.x + R > b.c + EPS && p.x - R < b.c + 1 - EPS
            && p.y + R > b.r + EPS && p.y - R < b.r + 1 - EPS) inside.push(p.id);
        }
        b.pass = inside;
      }
    }

    /* 2.5 被踢出去的水球會一直滑到撞牆、撞人或撞到別顆水球 */
    for (const b of s.bombs) {
      if (!b.moveDir) continue;
      const dist = C.KICK_SPEED * dt;
      const nx = b.px + b.moveDir.dx * dist;
      const ny = b.py + b.moveDir.dy * dist;
      const aheadC = Math.floor(nx + b.moveDir.dx * 0.5);
      const aheadR = Math.floor(ny + b.moveDir.dy * 0.5);
      if (blockedForBomb(s, b, aheadC, aheadR)) {
        b.px = b.c + 0.5;
        b.py = b.r + 0.5;
        b.moveDir = null;
        s.events.push({ type: 'kick-stop', id: b.id, c: b.c, r: b.r });
      } else {
        b.px = nx; b.py = ny;
        b.c = Math.floor(b.px);
        b.r = Math.floor(b.py);
      }
    }

    /* 3. 引信 */
    for (const b of s.bombs.slice()) {
      b.fuse -= dt;
      if (b.fuse <= 0 && s.bombs.indexOf(b) !== -1) detonate(s, b);
    }

    /* 4. 水柱殘留 */
    for (let i = s.blasts.length - 1; i >= 0; i--) {
      s.blasts[i].ttl -= dt;
      if (s.blasts[i].ttl <= 0) s.blasts.splice(i, 1);
    }

    /* 5. 撿道具 */
    for (const p of s.players) {
      if (p.state !== 'alive') continue;
      const cell = cellOf(p);
      const it = itemAt(s, cell.c, cell.r);
      if (it) {
        s.items.splice(s.items.indexOf(it), 1);
        applyItem(s, p, it.type);
      }
    }

    /* 6. 水柱傷害 */
    const burning = new Set();
    for (const bl of s.blasts) for (const c of bl.cells) burning.add(key(c.c, c.r));
    if (burning.size) {
      for (const p of s.players) {
        if (p.state === 'dead') continue;
        const cell = cellOf(p);
        if (!burning.has(key(cell.c, cell.r))) continue;
        /* 無敵（含剛被困住的緩衝）擋掉這一發：同一道水柱不會又困又殺 */
        if (p.invuln > 0) continue;
        if (p.state === 'alive') trapPlayer(s, p);
        else if (p.state === 'trapped') killPlayer(s, p, 'blast');
      }
    }

    /* 7. 組隊救援：隊友走到泡泡上就戳破（拿針的話隔一格也行） */
    if (s.mode === 'team') {
      for (const p of s.players) {
        if (p.state !== 'trapped') continue;
        const pc = cellOf(p);
        for (const q of s.players) {
          if (q.state !== 'alive' || q.team !== p.team || q.id === p.id) continue;
          const qc = cellOf(q);
          const dist = Math.abs(qc.c - pc.c) + Math.abs(qc.r - pc.r);
          if (dist === 0 || (q.needle && dist === 1)) {
            q.stats.rescues++;
            freePlayer(s, p, 'rescue');
            break;
          }
        }
      }
    }

    /* 8. 勝負 */
    checkOver(s);

    return s;
  }

  function trapPlayer(s, p) {
    p.state = 'trapped';
    p.trapTimer = s.mode === 'team' ? C.TRAP_TEAM : C.TRAP_SOLO;
    p.struggleCd = 0;
    p.lastStruggle = 0;
    p.stats.trapped++;
    /* 同一道水柱只把人困住，不會順手補刀：撐過這道水柱殘留的時間 */
    p.invuln = C.BLAST_TTL + 0.1;
    /* 對齊格子中心，泡泡才不會卡在牆邊 */
    const cell = cellOf(p);
    p.x = cell.c + 0.5;
    p.y = cell.r + 0.5;
    s.events.push({ type: 'trap', by: p.id });
  }

  function freePlayer(s, p, how) {
    p.state = 'alive';
    p.trapTimer = 0;
    p.invuln = C.INVULN;
    s.events.push({ type: 'free', by: p.id, how });
  }

  function checkOver(s) {
    const living = s.players.filter(p => p.state !== 'dead');

    if (s.mode === 'team') {
      const teams = new Set(living.map(p => p.team));
      if (teams.size <= 1) {
        finish(s, teams.size === 1 ? [...teams][0] : null, living, 'elimination');
        return;
      }
    } else if (living.length <= 1) {
      finish(s, null, living, 'elimination');
      return;
    }

    if (s.time >= s.duration) {
      /* 時間到：先比存活人數，再比破箱數 */
      if (s.mode === 'team') {
        const score = new Map();
        for (const p of living) score.set(p.team, (score.get(p.team) || 0) + 1);
        let best = null, bestN = -1, tie = false;
        for (const [team, n] of score) {
          if (n > bestN) { best = team; bestN = n; tie = false; }
          else if (n === bestN) tie = true;
        }
        if (tie) {
          const boxes = new Map();
          for (const p of s.players) boxes.set(p.team, (boxes.get(p.team) || 0) + p.stats.boxes);
          best = null; bestN = -1; tie = false;
          for (const [team, n] of boxes) {
            if (n > bestN) { best = team; bestN = n; tie = false; }
            else if (n === bestN) tie = true;
          }
        }
        finish(s, tie ? null : best, living, 'timeup');
      } else {
        let best = null, tie = false;
        for (const p of living) {
          if (!best || p.stats.boxes > best.stats.boxes) { best = p; tie = false; }
          else if (p.stats.boxes === best.stats.boxes) tie = true;
        }
        finish(s, null, tie ? [] : (best ? [best] : []), 'timeup');
      }
    }
  }

  function finish(s, team, living, reason) {
    s.phase = 'over';
    s.reason = reason;
    for (const p of s.players) if (p.state !== 'dead') p.stats.survived = s.time;
    if (s.mode === 'team') {
      s.winnerTeam = team;
      s.winner = null;
    } else {
      s.winner = living.length === 1 ? living[0].id : null;
    }
    s.events.push({ type: 'over', winner: s.winner, winnerTeam: s.winnerTeam, reason });
  }

  /* ---------- 給 AI 與 UI 用的查詢 ---------- */

  /** 每一格「還有幾秒會被水柱掃到」，沒有危險就是 Infinity */
  function dangerMap(s) {
    const danger = new Array(s.cols * s.rows).fill(Infinity);
    const mark = (c, r, t) => {
      if (c < 0 || r < 0 || c >= s.cols || r >= s.rows) return;
      const i = idx(s, c, r);
      if (t < danger[i]) danger[i] = t;
    };
    for (const b of s.bombs) {
      mark(b.c, b.r, b.fuse);
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        for (let n = 1; n <= b.power; n++) {
          const c = b.c + dc * n, r = b.r + dr * n;
          const t = tileAt(s, c, r);
          if (t === HARD || t === SOFT) break;
          mark(c, r, b.fuse);
        }
      }
    }
    for (const bl of s.blasts) for (const c of bl.cells) mark(c.c, c.r, 0);
    return danger;
  }

  function walkable(s, c, r) {
    return tileAt(s, c, r) === EMPTY && !bombAt(s, c, r);
  }

  return {
    STEP: C.STEP,
    C, EMPTY, HARD, SOFT,
    GOOD_ITEMS, BAD_ITEMS,
    createMatch, step,
    placeBomb, detonate,
    dangerMap, walkable, tileAt, cellOf, bombAt, itemAt, idx
  };
});
