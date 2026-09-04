/* ===== ai.js — 電腦對手 =====
 *
 * AI 只產生「和真人一模一樣格式」的輸入 {dx,dy,drop}，規則一律走 rules.js。
 * 四段難度差在：反應延遲、安全邊際、會不會主動攻擊、會不會補刀、會不會救隊友。
 * （M1 會再加上路徑預測與連鎖計算，這裡是可玩且四段差異看得出來的版本。）
 */
(function (root, factory) {
  'use strict';
  const isNode = typeof module === 'object' && module.exports;
  const Rules = isNode ? require('./rules.js') : root.Rules;
  const api = factory(Rules);
  if (isNode) module.exports = api;
  else root.AI = api;
})(typeof self !== 'undefined' ? self : this, function (Rules) {
  'use strict';

  const LEVELS = {
    baby: {
      label: '幼幼班', think: 0.55, margin: 2.6,
      hunt: 0, finish: false, retreat: 3, bombChance: 0.35,
      avoidBad: false, predict: false, kick: false, trap: false
    },
    easy: {
      label: '簡單', think: 0.60, margin: 2.2,
      hunt: 3, finish: false, retreat: 0, bombChance: 0.6,
      avoidBad: false, predict: false, kick: false, trap: false
    },
    normal: {
      label: '普通', think: 0.30, margin: 1.7,
      hunt: 5, finish: true, retreat: 0, bombChance: 0.85,
      avoidBad: true, predict: false, kick: true, trap: true
    },
    hard: {
      label: '困難', think: 0.12, margin: 1.25,
      hunt: 9, finish: true, retreat: 0, bombChance: 1,
      avoidBad: true, predict: true, kick: true, trap: true
    }
  };

  function create() {
    const memory = new Map();

    /** 取得（或建立）某個電腦玩家的思考狀態 */
    function mem(p) {
      let m = memory.get(p.id);
      if (!m) {
        m = { wait: 0, move: { dx: 0, dy: 0 }, drop: false, struggle: 1 };
        memory.set(p.id, m);
      }
      return m;
    }

    /**
     * @returns {{dx:number,dy:number,drop:boolean}}
     */
    function input(state, p, dt) {
      const lv = LEVELS[p.difficulty] || LEVELS.normal;
      const m = mem(p);

      if (p.state === 'trapped') {
        /* 泡泡裡左右交替掙脫，難度高的按得快 */
        m.wait -= dt;
        if (m.wait <= 0) {
          m.struggle = -m.struggle;
          m.wait = lv.think * 0.35;
        }
        return { dx: m.struggle, dy: 0, drop: false };
      }
      if (p.state !== 'alive') return { dx: 0, dy: 0, drop: false };

      m.wait -= dt;
      if (m.wait <= 0) {
        m.wait = lv.think;
        const plan = decide(state, p, lv);
        m.move = plan.move;
        m.drop = plan.drop;
      }
      const out = { dx: m.move.dx, dy: m.move.dy, drop: m.drop };
      m.drop = false; /* 放球只送一幀 */
      return out;
    }

    return { input, LEVELS };
  }

  /* ---------- 決策 ---------- */

  function decide(state, p, lv) {
    const danger = Rules.dangerMap(state);
    const here = Rules.cellOf(p);
    const nav = bfs(state, here, danger, p.speed, lv.margin);
    const hereDanger = danger[Rules.idx(state, here.c, here.r)];

    /* 1. 腳下危險 → 逃 */
    if (hereDanger < lv.margin) {
      const escape = nearestSafe(state, nav, danger);
      if (escape) return { move: stepToward(nav, escape), drop: false };
      /* 無處可逃就往危險最小的鄰格挪 */
      return { move: leastBad(state, here, danger), drop: false };
    }

    /* 2. 撿看得到的道具（普通以上會避開烏龜、迷你水球、亂步鞋） */
    const item = nearestOf(state, nav, (c, r) => {
      const it = Rules.itemAt(state, c, r);
      if (!it) return false;
      if (lv.avoidBad && BAD.has(it.type)) return false;
      return true;
    }, 8);
    if (item) return { move: stepToward(nav, item), drop: false };

    /* 3. 對手 */
    const foes = state.players.filter(q => q.id !== p.id && q.state !== 'dead'
      && (state.mode !== 'team' || q.team !== p.team));
    const near = closest(foes, here);
    if (near) {
      const d = Math.abs(near.cell.c - here.c) + Math.abs(near.cell.r - here.r);

      /* 幼幼班：看到人就退開，也不補刀 */
      if (lv.retreat && d <= lv.retreat) {
        const away = fleeFrom(state, here, near.cell, danger, lv.margin);
        if (away) return { move: away, drop: false };
      }

      /* 補刀：對手正卡在泡泡裡 */
      if (lv.finish && near.player.state === 'trapped' && d <= 2 && canBombSafely(state, p, danger, lv)) {
        if (d <= 1) return { move: { dx: 0, dy: 0 }, drop: true };
        return { move: stepToward(nav, near.cell), drop: false };
      }

      if (lv.hunt && d <= lv.hunt) {
        /* 有手套就先想想能不能直接把旁邊的水球踢向對手 */
        if (lv.kick && p.glove) {
          const kickDir = kickToward(state, p, near.cell);
          if (kickDir) return { move: kickDir, drop: false };
        }
        if (canBombSafely(state, p, danger, lv)) {
          const here2 = Rules.cellOf(p);
          const blast = blastIfPlaced(state, here2, p.effects.mini > 0 ? 1 : p.power);
          const hitsMate = state.mode === 'team' && state.players.some(q =>
            q.team === p.team && q.id !== p.id && q.state !== 'dead'
            && blast.has(keyOf(Rules.cellOf(q))));
          const catches = blast.has(keyOf(near.cell));
          const escapes = lv.trap ? escapeCount(state, near.cell, blast, 3) : 9;
          if (!hitsMate && catches && (near.player.state === 'trapped' || escapes <= 1 || d <= 2)
            && Math.random() < lv.bombChance) {
            return { move: { dx: 0, dy: 0 }, drop: true };
          }
        }
        /* 困難：距離還遠的時候先去堵對手的出路，貼身時就正面壓上去 */
        if (lv.predict && d >= 3) {
          const cut = blockingStep(state, nav, near.cell, danger, lv);
          if (cut) return { move: cut, drop: false };
        }
        return { move: stepToward(nav, near.cell), drop: false };
      }
    }

    /* 4. 隊友求救 */
    if (state.mode === 'team' && lv.hunt) {
      const mate = state.players.find(q => q.team === p.team && q.id !== p.id && q.state === 'trapped');
      if (mate) {
        const mc = Rules.cellOf(mate);
        return { move: stepToward(nav, { c: mc.c, r: mc.r }), drop: false };
      }
    }

    /* 5. 炸箱子拿道具 */
    if (adjacentSoft(state, here) && canBombSafely(state, p, danger, lv)) {
      return { move: { dx: 0, dy: 0 }, drop: true };
    }
    const box = nearestOf(state, nav, (c, r) => adjacentSoft(state, { c, r }), 14);
    if (box) return { move: stepToward(nav, box), drop: false };

    /* 6. 沒事做就走動，別站著等死 */
    return { move: wander(state, here, danger, lv.margin), drop: false };
  }

  const BAD = new Set(['turtle', 'mini', 'reverse']);
  const keyOf = cell => cell.c + ':' + cell.r;

  /** 在某一格放球會炸到哪些格子（含連鎖引爆旁邊的球） */
  function blastIfPlaced(state, cell, power) {
    const cells = new Set();
    const queue = [{ c: cell.c, r: cell.r, power }];
    const done = new Set();
    while (queue.length) {
      const b = queue.shift();
      const bk = b.c + ':' + b.r;
      if (done.has(bk)) continue;
      done.add(bk);
      cells.add(bk);
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        for (let n = 1; n <= b.power; n++) {
          const c = b.c + dc * n, r = b.r + dr * n;
          const t = Rules.tileAt(state, c, r);
          if (t === Rules.HARD || t === Rules.SOFT) break;
          cells.add(c + ':' + r);
          const other = Rules.bombAt(state, c, r);
          if (other) { queue.push({ c, r, power: other.power }); break; }
        }
      }
    }
    return cells;
  }

  /** 對手在幾步之內還有沒有安全格可以躲 */
  function escapeCount(state, from, blast, steps) {
    let frontier = [[from.c, from.r]];
    const seen = new Set([from.c + ':' + from.r]);
    let safe = 0;
    for (let i = 0; i < steps; i++) {
      const next = [];
      for (const [c, r] of frontier) {
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nc = c + dc, nr = r + dr, k = nc + ':' + nr;
          if (seen.has(k) || !Rules.walkable(state, nc, nr)) continue;
          seen.add(k);
          if (!blast.has(k)) safe++;
          else next.push([nc, nr]);
        }
      }
      frontier = next;
    }
    return safe;
  }

  /** 旁邊有沒有水球可以往對手的方向踢 */
  function kickToward(state, p, foeCell) {
    const here = Rules.cellOf(p);
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const b = Rules.bombAt(state, here.c + dc, here.r + dr);
      if (!b || b.moveDir) continue;
      if (b.pass.indexOf(p.id) !== -1) continue;
      /* 對手要在這顆球被踢出去的那條線上 */
      if (dc !== 0 && foeCell.r === here.r && Math.sign(foeCell.c - here.c) === dc) return { dx: dc, dy: 0 };
      if (dr !== 0 && foeCell.c === here.c && Math.sign(foeCell.r - here.r) === dr) return { dx: 0, dy: dr };
    }
    return null;
  }

  /** 困難才會做的封路：站到對手出路較少的那一側 */
  function blockingStep(state, nav, foeCell, danger, lv) {
    const options = [];
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const c = foeCell.c + dc, r = foeCell.r + dr;
      const k = nav.k(c, r);
      if (!nav.dist.has(k)) continue;
      if (danger[Rules.idx(state, c, r)] < lv.margin) continue;
      options.push({ c, r, d: nav.dist.get(k), exits: freeNeighbours(state, { c, r }) });
    }
    if (!options.length) return null;
    options.sort((a, b) => (a.d - b.d) || (a.exits - b.exits));
    const pick = options[0];
    if (pick.d > 4) return null;
    return stepToward(nav, pick);
  }

  function freeNeighbours(state, cell) {
    let n = 0;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (Rules.walkable(state, cell.c + dc, cell.r + dr)) n++;
    }
    return n;
  }

  /* ---------- 尋路 ---------- */

  /** 從所在格做 BFS，只走安全到得了的格子 */
  function bfs(state, from, danger, speed, margin) {
    const cellTime = 1 / Math.max(1, speed);
    const dist = new Map();
    const prev = new Map();
    const k = (c, r) => c + ':' + r;
    const queue = [[from.c, from.r]];
    dist.set(k(from.c, from.r), 0);

    while (queue.length) {
      const [c, r] = queue.shift();
      const d = dist.get(k(c, r));
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nc = c + dc, nr = r + dr;
        const nk = k(nc, nr);
        if (dist.has(nk)) continue;
        if (!Rules.walkable(state, nc, nr)) continue;
        const arrive = (d + 1) * cellTime;
        const dg = danger[Rules.idx(state, nc, nr)];
        if (dg < arrive + margin * 0.35) continue; /* 走過去剛好會被炸到 */
        dist.set(nk, d + 1);
        prev.set(nk, [c, r]);
        queue.push([nc, nr]);
      }
    }
    return { from, dist, prev, k };
  }

  function stepToward(nav, target) {
    const k = nav.k;
    let cur = k(target.c, target.r);
    if (!nav.prev.has(cur)) return { dx: 0, dy: 0 };
    let node = [target.c, target.r];
    while (nav.prev.has(cur)) {
      const p = nav.prev.get(cur);
      if (p[0] === nav.from.c && p[1] === nav.from.r) {
        return { dx: Math.sign(node[0] - p[0]), dy: Math.sign(node[1] - p[1]) };
      }
      node = p;
      cur = k(p[0], p[1]);
    }
    return { dx: 0, dy: 0 };
  }

  function nearestSafe(state, nav, danger) {
    let best = null, bestD = Infinity;
    for (const [key, d] of nav.dist) {
      if (d === 0 || d >= bestD) continue;
      const [c, r] = key.split(':').map(Number);
      if (danger[Rules.idx(state, c, r)] === Infinity) { best = { c, r }; bestD = d; }
    }
    return best;
  }

  function nearestOf(state, nav, match, maxDist) {
    let best = null, bestD = Infinity;
    for (const [key, d] of nav.dist) {
      if (d === 0 || d > maxDist || d >= bestD) continue;
      const [c, r] = key.split(':').map(Number);
      if (match(c, r)) { best = { c, r }; bestD = d; }
    }
    return best;
  }

  function closest(list, here) {
    let best = null, bestD = Infinity;
    for (const q of list) {
      const cell = Rules.cellOf(q);
      const d = Math.abs(cell.c - here.c) + Math.abs(cell.r - here.r);
      if (d < bestD) { best = { player: q, cell }; bestD = d; }
    }
    return best;
  }

  function adjacentSoft(state, cell) {
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (Rules.tileAt(state, cell.c + dc, cell.r + dr) === Rules.SOFT) return true;
    }
    return false;
  }

  /** 放了球之後還逃得掉嗎 */
  function canBombSafely(state, p, danger, lv) {
    if (p.bombsOut >= p.bombMax) return false;
    const here = Rules.cellOf(p);
    if (Rules.tileAt(state, here.c, here.r) !== Rules.EMPTY) return false;
    if (Rules.bombAt(state, here.c, here.r)) return false;

    /* 用自己的威力模擬一顆球，看看兩步內有沒有安全格 */
    const blast = new Set([here.c + ':' + here.r]);
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (let n = 1; n <= p.power; n++) {
        const c = here.c + dc * n, r = here.r + dr * n;
        const t = Rules.tileAt(state, c, r);
        if (t === Rules.HARD || t === Rules.SOFT) break;
        blast.add(c + ':' + r);
      }
    }
    const seen = new Set([here.c + ':' + here.r]);
    let frontier = [[here.c, here.r]];
    const reach = Math.max(2, Math.round(p.power) + 1);
    for (let step = 0; step < reach; step++) {
      const next = [];
      for (const [c, r] of frontier) {
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nc = c + dc, nr = r + dr, nk = nc + ':' + nr;
          if (seen.has(nk) || !Rules.walkable(state, nc, nr)) continue;
          if (danger[Rules.idx(state, nc, nr)] < lv.margin) continue;
          seen.add(nk);
          if (!blast.has(nk)) return true;
          next.push([nc, nr]);
        }
      }
      frontier = next;
    }
    return false;
  }

  function leastBad(state, here, danger) {
    let best = { dx: 0, dy: 0 }, bestVal = danger[Rules.idx(state, here.c, here.r)];
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const c = here.c + dc, r = here.r + dr;
      if (!Rules.walkable(state, c, r)) continue;
      const v = danger[Rules.idx(state, c, r)];
      if (v > bestVal) { bestVal = v; best = { dx: dc, dy: dr }; }
    }
    return best;
  }

  function fleeFrom(state, here, foe, danger, margin) {
    let best = null, bestScore = -Infinity;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const c = here.c + dc, r = here.r + dr;
      if (!Rules.walkable(state, c, r)) continue;
      if (danger[Rules.idx(state, c, r)] < margin) continue;
      const score = Math.abs(c - foe.c) + Math.abs(r - foe.r);
      if (score > bestScore) { bestScore = score; best = { dx: dc, dy: dr }; }
    }
    return best;
  }

  function wander(state, here, danger, margin) {
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dc, dr]) => {
      const c = here.c + dc, r = here.r + dr;
      return Rules.walkable(state, c, r) && danger[Rules.idx(state, c, r)] >= margin;
    });
    if (!dirs.length) return { dx: 0, dy: 0 };
    const [dx, dy] = dirs[Math.floor(Math.random() * dirs.length)];
    return { dx, dy };
  }

  return { create, LEVELS };
});
