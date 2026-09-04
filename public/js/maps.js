/* ===== maps.js — 地圖：10 張手設固定地形 + 隨機生成 =====
 * 全部純地形，不做傳送門／輸送帶／水池等機關。
 * 格子值：0 空地、1 硬塊（炸不掉）、2 軟箱（會被炸掉，可能掉道具）
 */
(function (root, factory) {
  'use strict';
  const RNG = typeof require === 'function' && typeof module === 'object' ? require('./rng.js') : root.RNG;
  const api = factory(RNG);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Maps = api;
})(typeof self !== 'undefined' ? self : this, function (RNG) {
  'use strict';

  const EMPTY = 0;
  const HARD = 1;
  const SOFT = 2;

  /* 每張固定地圖：在經典棋盤骨架上加減硬塊，做出走位個性 */
  const MAPS = [
    {
      id: 'maze', name: '迷宮小徑', desc: '路窄轉角多，適合埋伏',
      density: 0.74,
      extra(c, r, cols, rows) { return c % 2 === 0 && r % 4 === 3 && c > 2 && c < cols - 3; }
    },
    {
      id: 'open', name: '開闊草場', desc: '視野好、跑得開，新手友善',
      density: 0.58,
      remove(c, r) { return (c / 2 + r / 2) % 2 === 0; }
    },
    {
      id: 'dual', name: '雙線道', desc: '上下兩條主幹道，攻防節奏快',
      density: 0.68,
      extra(c, r, cols, rows) {
        const a = Math.round(rows / 3);
        const b = rows - 1 - a;
        return (r === a || r === b) && c % 4 !== 2 && c > 1 && c < cols - 2;
      }
    },
    {
      id: 'ring', name: '口字廣場', desc: '中央有一圈牆，繞圈打游擊',
      density: 0.66,
      extra(c, r, cols, rows) {
        const m1 = 3, m2c = cols - 4, m2r = rows - 4;
        const onRing = (c === m1 || c === m2c) && r >= m1 && r <= m2r
          ? true : (r === m1 || r === m2r) && c >= m1 && c <= m2c;
        if (!onRing) return false;
        const midC = (cols - 1) / 2, midR = (rows - 1) / 2;
        return c !== midC && r !== midR; /* 四邊各留一個缺口 */
      }
    },
    {
      id: 'cross', name: '十字迴廊', desc: '中央十字大道，容易正面對撞',
      density: 0.70,
      extra(c, r, cols, rows) {
        const midC = (cols - 1) / 2, midR = (rows - 1) / 2;
        return (Math.abs(c - midC) === 2 && Math.abs(r - midR) <= 2)
          || (Math.abs(r - midR) === 2 && Math.abs(c - midC) <= 2);
      }
    },
    {
      id: 'hive', name: '蜂巢陣', desc: '交錯柱子，處處都是死角',
      density: 0.72,
      extra(c, r) { return c % 2 === 1 && r % 2 === 0 && (c + r) % 4 === 1; }
    },
    {
      id: 'serpent', name: '蛇形長廊', desc: '長牆左右錯開，只能繞著跑',
      density: 0.60,
      extra(c, r, cols, rows) {
        /* 缺口挑奇數列，才不會壓在棋盤柱上變成沒開 */
        const gapR = 2 * Math.floor((rows - 1) / 4) + 1;
        if (c % 4 === 2) return r >= 2 && r !== gapR;                    /* 上面與中段留缺口 */
        if (c % 4 === 0 && c > 0 && c < cols - 1) {
          return r <= rows - 3 && r !== gapR + 2;                        /* 下面與中段留缺口 */
        }
        return false;
      }
    },
    {
      id: 'quad', name: '四合院', desc: '十字大牆隔成四間，只有小門相通',
      density: 0.66,
      extra(c, r, cols, rows) {
        const midC = (cols - 1) / 2, midR = (rows - 1) / 2;
        /* 門開在奇數格，才不會剛好撞上棋盤柱 */
        if (c === midC) return r !== 3 && r !== rows - 4;   /* 上下兩道門 */
        if (r === midR) return c !== 3 && c !== cols - 4;   /* 左右兩道門 */
        return false;
      }
    },
    {
      id: 'diag', name: '大 X 廣場', desc: '兩道斜牆交叉，中央是空地',
      density: 0.64,
      extra(c, r, cols, rows) {
        const dc = Math.abs(c - (cols - 1) / 2), dr = Math.abs(r - (rows - 1) / 2);
        return dc === dr && dc >= 2;                        /* 中央留空，斜臂直達四角 */
      }
    },
    {
      id: 'blocks', name: '石塊大廳', desc: '沒有棋盤柱，改成大石塊與寬走道',
      density: 0.52,
      remove() { return true; },                        /* 整片棋盤柱都拿掉 */
      extra(c, r, cols, rows) {
        const bc = (c - 2) % 5, br = (r - 2) % 5;       /* 每 5 格擺一個 2x2 石塊 */
        return bc >= 0 && bc <= 1 && br >= 0 && br <= 1
          && c < cols - 2 && r < rows - 2;
      }
    }
  ];

  function idx(cols, c, r) { return r * cols + c; }

  /** 八個出生點：先四角，人多再往四邊中點長 */
  function spawnOrder(cols, rows) {
    const midC = (cols - 1) / 2;
    const midR = (rows - 1) / 2;
    return [
      { c: 1, r: 1 },
      { c: cols - 2, r: rows - 2 },
      { c: cols - 2, r: 1 },
      { c: 1, r: rows - 2 },
      { c: midC, r: 1 },
      { c: midC, r: rows - 2 },
      { c: 1, r: midR },
      { c: cols - 2, r: midR }
    ];
  }

  /** 出生點自己與周圍曼哈頓距離 2 以內都淨空，開場不會被自己炸到 */
  function safeCells(spawns) {
    const set = new Set();
    for (const s of spawns) {
      for (let dc = -2; dc <= 2; dc++) {
        for (let dr = -2; dr <= 2; dr++) {
          if (Math.abs(dc) + Math.abs(dr) <= 2) set.add((s.c + dc) + ':' + (s.r + dr));
        }
      }
    }
    return set;
  }

  /**
   * 建地圖
   * @param {{cols:number,rows:number,mapId?:string,random?:boolean,seed:(string|number),playerCount:number}} opt
   */
  function build(opt) {
    const cols = opt.cols, rows = opt.rows;
    const rng = RNG.create(opt.seed);
    const spawns = spawnOrder(cols, rows).slice(0, Math.max(2, opt.playerCount || 4));
    const safe = safeCells(spawns);

    let def;
    if (opt.random) {
      def = { id: 'random', name: '隨機地圖', desc: '每一局都不一樣', density: 0.58 + rng.next() * 0.18 };
      const style = rng.int(0, 2);
      if (style === 0) def.extra = (c, r) => c % 2 === 0 && r % 3 === 0 && rng.chance(0.35);
      else if (style === 1) def.remove = () => rng.chance(0.3);
    } else {
      def = MAPS.find(m => m.id === opt.mapId) || MAPS[0];
    }

    const tiles = new Array(cols * rows).fill(EMPTY);

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let v = EMPTY;
        if (c === 0 || r === 0 || c === cols - 1 || r === rows - 1) v = HARD;
        else if (c % 2 === 0 && r % 2 === 0 && !(def.remove && def.remove(c, r))) v = HARD;
        else if (def.extra && def.extra(c, r, cols, rows)) v = HARD;
        tiles[idx(cols, c, r)] = v;
      }
    }

    /* 保證每個出生點與它的逃生方向不會被額外硬塊封死 */
    for (const s of spawns) {
      tiles[idx(cols, s.c, s.r)] = EMPTY;
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      let open = 0;
      for (const [dc, dr] of dirs) {
        const c = s.c + dc, r = s.r + dr;
        if (c > 0 && r > 0 && c < cols - 1 && r < rows - 1 && tiles[idx(cols, c, r)] !== HARD) open++;
      }
      if (open < 2) {
        for (const [dc, dr] of dirs) {
          const c = s.c + dc, r = s.r + dr;
          if (c > 0 && r > 0 && c < cols - 1 && r < rows - 1) tiles[idx(cols, c, r)] = EMPTY;
        }
      }
    }

    /* 撒軟箱：安全區不放 */
    for (let r = 1; r < rows - 1; r++) {
      for (let c = 1; c < cols - 1; c++) {
        const i = idx(cols, c, r);
        if (tiles[i] !== EMPTY) continue;
        if (safe.has(c + ':' + r)) continue;
        if (rng.chance(def.density)) tiles[i] = SOFT;
      }
    }

    ensureReachable(tiles, cols, rows, spawns);

    return {
      cols, rows, tiles, spawns,
      mapId: def.id, mapName: def.name, mapDesc: def.desc
    };
  }

  /** 忽略軟箱做連通檢查（軟箱炸得掉），把連不到的出生點打通 */
  function ensureReachable(tiles, cols, rows, spawns) {
    const seen = new Array(cols * rows).fill(false);
    const start = spawns[0];
    const queue = [[start.c, start.r]];
    seen[idx(cols, start.c, start.r)] = true;
    while (queue.length) {
      const [c, r] = queue.shift();
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nc = c + dc, nr = r + dr;
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        const ni = idx(cols, nc, nr);
        if (seen[ni] || tiles[ni] === HARD) continue;
        seen[ni] = true;
        queue.push([nc, nr]);
      }
    }
    for (const s of spawns) {
      if (seen[idx(cols, s.c, s.r)]) continue;
      /* 往地圖中心挖一條路 */
      let c = s.c, r = s.r;
      const midC = Math.round((cols - 1) / 2), midR = Math.round((rows - 1) / 2);
      while (c !== midC || r !== midR) {
        if (c !== midC) c += c < midC ? 1 : -1;
        else r += r < midR ? 1 : -1;
        if (c > 0 && r > 0 && c < cols - 1 && r < rows - 1) tiles[idx(cols, c, r)] = EMPTY;
        if (seen[idx(cols, c, r)]) break;
      }
    }
  }

  return { EMPTY, HARD, SOFT, MAPS, build, spawnOrder };
});
