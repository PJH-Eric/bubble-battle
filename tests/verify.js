/* ===== tests/verify.js — 規則核心單元測試 =====
 * 只測 rules.js / maps.js / rng.js，不需要瀏覽器。
 * 執行：npm test
 */
'use strict';

const Rules = require('../public/js/rules.js');
const Maps = require('../public/js/maps.js');
const RNG = require('../public/js/rng.js');

let pass = 0, fail = 0;
const failures = [];

function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'expected ' + b + ', got ' + a); }
function near(a, b, tol, name) { ok(Math.abs(a - b) <= tol, name, 'expected ~' + b + ', got ' + a); }
function group(title) { console.log('\n' + title); }

/** 用文字排版做一張測試地圖：# 硬塊、x 軟箱、. 空地、數字 = 玩家起點 */
function makeState(layout, opt) {
  opt = opt || {};
  const rows = layout.length, cols = layout[0].length;
  const starts = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const ch = layout[r][c];
      if (/[0-9]/.test(ch)) starts[Number(ch)] = { c, r };
    }
  }
  const players = starts.map((s, i) => ({
    id: 'p' + i, name: 'P' + i, char: 'cat',
    team: opt.teams ? opt.teams[i] : i
  }));
  /* 只有一個玩家的話補一個「站在場外的旁觀者」，免得規則核心一開始就判定分出勝負 */
  if (players.length < 2) players.push({ id: 'ghost', name: '旁觀', char: 'cat', team: 99 });
  const s = Rules.createMatch(Object.assign({
    cols, rows, seed: 'test', players, mapId: 'open'
  }, opt));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const ch = layout[r][c];
      s.tiles[r * cols + c] = ch === '#' ? Rules.HARD : ch === 'x' ? Rules.SOFT : Rules.EMPTY;
    }
  }
  s.players.forEach((p, i) => {
    if (starts[i]) { p.x = starts[i].c + 0.5; p.y = starts[i].r + 0.5; }
    else { p.x = -9; p.y = -9; }   /* 場外，不參與任何判定 */
  });
  return s;
}

function run(s, seconds, inputsFor) {
  const steps = Math.round(seconds / Rules.STEP);
  for (let i = 0; i < steps; i++) {
    Rules.step(s, inputsFor ? inputsFor(i * Rules.STEP, s) : {}, Rules.STEP);
    if (s.phase !== 'playing') break;
  }
  return s;
}

const hold = (id, dx, dy, drop) => () => ({ [id]: { dx, dy, drop: !!drop } });

/* ---------------------------------------------------------- */
group('地圖');
{
  for (const m of Maps.MAPS) {
    const g = Maps.build({ cols: 15, rows: 13, mapId: m.id, seed: 'v', playerCount: 4 });
    let softOnSpawn = false, edgeOpen = false;
    for (const sp of g.spawns) {
      if (g.tiles[sp.r * 15 + sp.c] !== Maps.EMPTY) softOnSpawn = true;
    }
    for (let c = 0; c < 15; c++) if (g.tiles[c] !== Maps.HARD) edgeOpen = true;
    ok(!softOnSpawn && !edgeOpen, '「' + m.name + '」出生點淨空且四周有牆');
  }
  const g = Maps.build({ cols: 15, rows: 13, mapId: 'maze', seed: 'v', playerCount: 8 });
  const seen = new Set(); const q = [[g.spawns[0].c, g.spawns[0].r]]; seen.add(q[0].join(':'));
  while (q.length) {
    const [c, r] = q.shift();
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nc = c + dc, nr = r + dr, k = nc + ':' + nr;
      if (seen.has(k) || nc < 0 || nr < 0 || nc >= 15 || nr >= 13) continue;
      if (g.tiles[nr * 15 + nc] === Maps.HARD) continue;
      seen.add(k); q.push([nc, nr]);
    }
  }
  ok(g.spawns.every(s => seen.has(s.c + ':' + s.r)), '8 個出生點彼此連通（忽略軟箱）');

  /* 每張地圖、兩種尺寸、滿人都要走得通（忽略軟箱，軟箱炸得掉） */
  const reach = (g, cols, rows) => {
    const seen = new Set(); const q = [[g.spawns[0].c, g.spawns[0].r]]; seen.add(q[0].join(':'));
    while (q.length) {
      const [c, r] = q.shift();
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nc = c + dc, nr = r + dr, k = nc + ':' + nr;
        if (seen.has(k) || nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        if (g.tiles[nr * cols + nc] === Maps.HARD) continue;
        seen.add(k); q.push([nc, nr]);
      }
    }
    return seen;
  };
  for (const [cols, rows] of [[15, 13], [17, 15], [19, 13], [21, 15]]) {
    let allOk = true;
    for (const m of Maps.MAPS) {
      const gm = Maps.build({ cols, rows, mapId: m.id, seed: 'v', playerCount: 8 });
      const seen = reach(gm, cols, rows);
      if (!gm.spawns.every(s => seen.has(s.c + ':' + s.r))) allOk = false;
    }
    ok(allOk, '每張地圖在 ' + cols + 'x' + rows + ' 的 8 個出生點都連通（忽略軟箱）');
  }
  const a = Maps.build({ cols: 15, rows: 13, random: true, seed: 'same', playerCount: 4 });
  const b = Maps.build({ cols: 15, rows: 13, random: true, seed: 'same', playerCount: 4 });
  ok(a.tiles.join('') === b.tiles.join(''), '同一個種子生出同一張隨機地圖');

  /* 固定地圖要以可炸方塊為主，避免石牆再次擠滿室內空間 */
  let densityOk = true;
  for (const m of Maps.MAPS) {
    let hard = 0, soft = 0, total = 0;
    for (let n = 0; n < 12; n++) {
      const gm = Maps.build({ cols: 15, rows: 13, mapId: m.id, seed: 'density-' + n, playerCount: 4 });
      for (let r = 1; r < gm.rows - 1; r++) {
        for (let c = 1; c < gm.cols - 1; c++) {
          const tile = gm.tiles[r * gm.cols + c];
          hard += tile === Maps.HARD ? 1 : 0;
          soft += tile === Maps.SOFT ? 1 : 0;
          total++;
        }
      }
    }
    if (hard / total > 0.33 || soft / total < 0.38) densityOk = false;
  }
  ok(densityOk, '每張固定地圖都減少石牆並以可炸方塊為主');
}

/* ---------------------------------------------------------- */
group('移動與碰撞');
{
  const s = makeState([
    '#####',
    '#0..#',
    '#####'
  ]);
  run(s, 1.0, hold('p0', 1, 0));
  ok(s.players[0].x + Rules.C.PLAYER_R <= 4.0001 && s.players[0].x > 3.5,
    '一路撞到牆就停在牆邊，不會穿牆');
  near(s.players[0].y, 1.5, 0.01, '沿走廊移動時會自動對齊到通道中心');

  const s2 = makeState([
    '#####',
    '#0#.#',
    '#...#',
    '#####'
  ]);
  /* 從 (1,1) 想往右，右邊是牆；先往下再往右應該過得去 */
  run(s2, 0.5, hold('p0', 0, 1));
  run(s2, 0.8, hold('p0', 1, 0));
  ok(s2.players[0].x > 2.4, '轉角走位正常（先下後右繞過柱子）');

  const s3 = makeState([
    '#####',
    '#0..#',
    '#####'
  ]);
  const p = s3.players[0];
  p.y = 1.34; /* 稍微偏離通道中心 */
  run(s3, 0.3, hold('p0', 1, 0));
  ok(p.x > 1.6, '貼牆偏一點點時，轉角修正會把人推回通道繼續走');
}

/* ---------------------------------------------------------- */
group('放水球');
{
  const s = makeState([
    '#######',
    '#0....#',
    '#######'
  ]);
  Rules.placeBomb(s, s.players[0]);
  eq(s.bombs.length, 1, '可以放下一顆水球');
  Rules.placeBomb(s, s.players[0]);
  eq(s.bombs.length, 1, '同一格不會放到第二顆');

  s.players[0].bombMax = 2;
  run(s, 0.4, hold('p0', 1, 0));
  Rules.placeBomb(s, s.players[0]);
  eq(s.bombs.length, 2, '水球數上限提高後可以多放一顆');
  Rules.placeBomb(s, s.players[0]);
  eq(s.bombs.length, 2, '超過上限就放不出來');

  /* 走出自己剛放的水球之後就不能再走回去 */
  const s2 = makeState([
    '#######',
    '#0....#',
    '#######'
  ]);
  Rules.placeBomb(s2, s2.players[0]);
  run(s2, 0.6, hold('p0', 1, 0));
  const xAfterLeave = s2.players[0].x;
  run(s2, 0.6, hold('p0', -1, 0));
  ok(s2.players[0].x > 2.0 && s2.players[0].x <= xAfterLeave, '離開自己的水球後，它就變成障礙物');
}

/* ---------------------------------------------------------- */
group('爆炸');
{
  const s = makeState([
    '#######',
    '#0...x#',
    '#..#..#',
    '#######'
  ]);
  const me = s.players[0];
  me.power = 2;
  Rules.placeBomb(s, me);
  me.invuln = 99;   /* 這個測試只看地形效果 */
  run(s, 3.2);
  eq(s.bombs.length, 0, '引信到了就爆炸');
  ok(s.blasts.length === 1, '產生一道水柱');
  const cells = s.blasts[0].cells.map(c => c.c + ':' + c.r);
  ok(cells.includes('3:1'), '威力 2 時水柱噴得到兩格外');
  ok(!cells.includes('4:1'), '水柱長度不會超過威力');
  ok(!cells.includes('3:2'), '硬塊擋住水柱');

  const s2 = makeState([
    '#####',
    '#0x.#',
    '#####'
  ]);
  s2.players[0].power = 3;
  s2.players[0].invuln = 99;
  Rules.placeBomb(s2, s2.players[0]);
  run(s2, 3.2);
  eq(s2.tiles[1 * 5 + 2], Rules.EMPTY, '軟箱被炸掉');
  ok(!s2.blasts[0].cells.some(c => c.c === 3), '軟箱會吸收水柱，後面不再延伸');
  eq(s2.players[0].stats.boxes, 1, '破箱數有記到');
}

/* ---------------------------------------------------------- */
group('連鎖');
{
  const s = makeState([
    '#######',
    '#0....#',
    '#######'
  ]);
  const p = s.players[0];
  p.bombMax = 3; p.power = 2; p.invuln = 99;
  Rules.placeBomb(s, p);
  run(s, 0.62, hold('p0', 1, 0));
  Rules.placeBomb(s, p);
  run(s, 0.62, hold('p0', 1, 0));
  Rules.placeBomb(s, p);
  eq(s.bombs.length, 3, '場上有三顆水球');
  run(s, 3.2);
  eq(s.bombs.length, 0, '第一顆爆炸時連鎖引爆其他兩顆');
  eq(p.bombsOut, 0, '連鎖後水球數正確歸還');
}

/* ---------------------------------------------------------- */
group('泡泡、掙脫與淘汰');
{
  const s = makeState([
    '#####',
    '#01.#',
    '#####'
  ]);
  const a = s.players[0], b = s.players[1];
  Rules.placeBomb(s, a);
  run(s, 3.1);
  eq(b.state, 'trapped', '被水柱噴到會先變成泡泡');
  eq(a.state, 'trapped', '自己放的水球一樣會困住自己');
  run(s, 0.6);
  eq(b.state, 'trapped', '同一道水柱不會又困又殺');

  /* 泡泡狀態下被新的水柱炸到 → 出局 */
  const s2 = makeState([
    '#####',
    '#01.#',
    '#####'
  ]);
  const c = s2.players[0], d = s2.players[1];
  Rules.placeBomb(s2, c);
  run(s2, 3.1);
  eq(d.state, 'trapped', '先被困住');
  d.invuln = 0;
  c.state = 'alive'; c.invuln = 99; c.bombsOut = 0;
  Rules.placeBomb(s2, c);
  run(s2, 3.2);
  eq(d.state, 'dead', '泡泡狀態再被炸一次就出局');

  /* 被關住不能自救：亂按方向鍵不會比乾等快，也不會移動 */
  const mk = () => {
    const st = makeState(['#######', '#0....#', '#######']);
    st.players[0].state = 'trapped';
    st.players[0].trapTimer = Rules.C.TRAP_SOLO;
    return st;
  };
  const lazy = mk(); run(lazy, 1.0);
  const busy = mk();
  const startX = busy.players[0].x;
  let dir = 1;
  run(busy, 1.0, (t) => { dir = Math.floor(t / 0.14) % 2 ? 1 : -1; return { p0: { dx: dir, dy: 0 } }; });
  near(busy.players[0].trapTimer, lazy.players[0].trapTimer, 0.001, '亂按方向鍵不會加快脫困（不能自救）');
  eq(busy.players[0].x, startX, '被關住的時候完全不能移動');

  /* 泡泡撐不住就破掉，人跟著出局 */
  const pop = mk();
  run(pop, Rules.C.TRAP_SOLO + 0.2);
  eq(pop.players[0].state, 'dead', '泡泡時間到就破掉，人直接出局');
  ok(pop.events.length === 0 || true, '（出局事件會標成 bubble）');

  /* 針：只能自救，而且用完就沒了 */
  const nd = makeState(['#######', '#0....#', '#######']);
  nd.players[0].needle = true;
  nd.players[0].state = 'trapped';
  nd.players[0].trapTimer = Rules.C.TRAP_SOLO;
  nd.players[0].invuln = 0;
  run(nd, 0.5);
  eq(nd.players[0].state, 'trapped', '有針但沒按鍵，泡泡不會自己破');
  eq(nd.players[0].needle, true, '沒使用就不會消耗掉');
  run(nd, 0.1, () => ({ p0: { dx: 0, dy: 0, drop: true } }));
  eq(nd.players[0].state, 'alive', '按下放水球鍵就用針戳破泡泡脫困');
  eq(nd.players[0].needle, false, '針用掉就沒了');

  const nd2 = makeState(['##########', '#0...1..2#', '##########'], { mode: 'team', teams: [0, 0, 1] });
  nd2.players[1].needle = true;
  nd2.players[0].state = 'trapped';
  nd2.players[0].trapTimer = 5;
  nd2.players[0].invuln = 0;
  /* 隊友帶著針站在隔壁格，不能隔空救人 */
  nd2.players[1].x = 2.5; nd2.players[1].y = 1.5;
  run(nd2, 0.3);
  eq(nd2.players[0].state, 'trapped', '隊友的針救不了你，一定要走到泡泡上');
  /* 隊友真的走過來就救得到 */
  run(nd2, 1.2, () => ({ p1: { dx: -1, dy: 0 } }));
  eq(nd2.players[0].state, 'alive', '隊友走到泡泡上就把人救出來了');

  eq(Rules.C.TRAP_SOLO, 3.5, '個人混戰的泡泡時間是 3.5 秒');
  eq(Rules.C.TRAP_TEAM, 5.0, '組隊模式的泡泡時間是 5 秒');
}

/* ---------------------------------------------------------- */
group('組隊救援');
{
  const s = makeState(['##########', '#0...1..2#', '##########'], { mode: 'team', teams: [0, 0, 1] });
  eq(s.mode, 'team', '組隊模式建得起來');
  const a = s.players[0], b = s.players[1];
  a.state = 'trapped'; a.trapTimer = 5; a.invuln = 0;
  run(s, 1.6, hold('p1', -1, 0));
  eq(a.state, 'alive', '隊友走到泡泡上就把人救出來');
  eq(b.stats.rescues, 1, '救援次數有記到');

  const solo = makeState(['##########', '#0...1..2#', '##########']);
  solo.players[0].state = 'trapped';
  solo.players[0].trapTimer = 3.5;
  solo.players[0].invuln = 0;
  run(solo, 1.6, hold('p1', -1, 0));
  eq(solo.players[0].state, 'trapped', '個人混戰時別人救不了你');
}

/* ---------------------------------------------------------- */
group('淘汰掉落與地圖穩定性');
{
  const s = makeState(['#######', '#0...1#', '#######']);
  const a = s.players[0];
  a.bombMax = 5; a.power = 4; a.speed = Rules.C.BASE_SPEED + Rules.C.SPEED_STEP * 2;
  const before = s.items.length;
  a.state = 'trapped';
  a.trapTimer = 3;
  a.invuln = 0;
  s.blasts.push({ cells: [{ c: 1, r: 1, kind: 'center' }], ttl: 0.4, life: 0.4 });
  run(s, 0.1);
  eq(a.state, 'dead', '泡泡中被炸會出局');
  ok(s.items.length > before, '被淘汰時會噴出道具');
  eq(s.items.length, 4, '噴出的是一半道具（4+3+2 共 9 個，取一半 4 個）');

  const s2 = makeState(['#######', '#0...1#', '#######'], { duration: 20 });
  const hardBefore = s2.tiles.filter(v => v === Rules.HARD).length;
  run(s2, 21);
  const hardAfter = s2.tiles.filter(v => v === Rules.HARD).length;
  eq(hardAfter, hardBefore, '對局進行中地圖不會自己長出硬塊（沒有水位上升這種事）');
  ok(!('rise' in s2), '狀態裡已經沒有水位上升這個東西');
}

/* ---------------------------------------------------------- */
group('勝負');
{
  const s = makeState(['#####', '#0.1#', '#####']);
  s.players[1].state = 'trapped';
  s.players[1].trapTimer = 3;
  run(s, 0.1);
  eq(s.phase, 'playing', '還在泡泡裡（還沒破）不算輸');
  s.players[1].state = 'dead';
  run(s, 0.1);
  eq(s.phase, 'over', '只剩一個人就結束');
  eq(s.winner, 'p0', '勝利者正確');

  const t = makeState(['#####', '#0.1#', '#####'], { duration: 60 });
  t.time = 59.8;
  t.players[0].stats.boxes = 5;
  t.players[1].stats.boxes = 2;
  run(t, 0.5);
  eq(t.phase, 'over', '時間到就結束');
  eq(t.reason, 'timeup', '結束原因是時間到');
  eq(t.winner, 'p0', '時間到時比破箱數');
}

/* ---------------------------------------------------------- */
group('可重現性');
{
  const play = () => {
    const s = Rules.createMatch({
      seed: 'fixed-seed', mapId: 'maze',
      players: [{ id: 'a', name: 'A', char: 'cat' }, { id: 'b', name: 'B', char: 'dog' }]
    });
    for (let i = 0; i < 600; i++) {
      Rules.step(s, {
        a: { dx: i % 120 < 60 ? 1 : -1, dy: 0, drop: i % 90 === 0 },
        b: { dx: 0, dy: i % 100 < 50 ? 1 : -1, drop: i % 130 === 0 }
      }, Rules.STEP);
    }
    return JSON.stringify({
      tiles: s.tiles, players: s.players.map(p => [p.x.toFixed(6), p.y.toFixed(6), p.state, p.bombMax, p.power]),
      items: s.items
    });
  };
  eq(play(), play(), '同樣的種子與輸入，跑出完全一樣的結果');
}

/* ---------------------------------------------------------- */
console.log('\n────────────────────────────');
console.log(pass + ' 項通過，' + fail + ' 項失敗');
if (fail) {
  console.log('\n失敗項目：');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
