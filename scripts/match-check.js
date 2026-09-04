/* ===== scripts/match-check.js — 讓電腦互打，確認整局跑得完、四段難度看得出差別 =====
 * 執行：npm run test:match
 */
'use strict';

const Rules = require('../public/js/rules.js');
const AI = require('../public/js/ai.js');
const Maps = require('../public/js/maps.js');

const MAX_STEPS = Math.ceil(200 / Rules.STEP);

function play(levels, seed, mapId) {
  const s = Rules.createMatch({
    seed,
    mapId,
    players: levels.map((lv, i) => ({
      id: 'p' + i, name: 'P' + i, char: 'cat', isAI: true, difficulty: lv
    }))
  });
  const ai = AI.create();
  let steps = 0;
  while (s.phase === 'playing' && steps++ < MAX_STEPS) {
    const inputs = {};
    for (const p of s.players) inputs[p.id] = ai.input(s, p, Rules.STEP);
    Rules.step(s, inputs, Rules.STEP);
  }
  return {
    finished: s.phase === 'over',
    hung: steps >= MAX_STEPS,
    time: s.time,
    winner: s.winner,
    reason: s.reason,
    boxes: s.players.map(p => p.stats.boxes),
    traps: s.players.map(p => p.stats.trapped)
  };
}

let fail = 0;
function check(cond, msg) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + msg);
  if (!cond) fail++;
}

console.log('\n整局能不能跑完（每張地圖各一場，四個普通電腦）');
for (const m of Maps.MAPS) {
  const r = play(['normal', 'normal', 'normal', 'normal'], 'map-' + m.id, m.id);
  check(r.finished && !r.hung, '「' + m.name + '」 ' + r.time.toFixed(0) + ' 秒結束（' + r.reason + '）破箱 ' + r.boxes.join('/'));
}

console.log('\n四段難度的差異（每組 16 場）');
const N = 16;
function duel(a, b) {
  let aWin = 0, bWin = 0, draw = 0;
  for (let i = 0; i < N; i++) {
    const r = play([a, b], a + '-' + b + '-' + i, Maps.MAPS[i % Maps.MAPS.length].id);
    if (r.winner === 'p0') aWin++;
    else if (r.winner === 'p1') bWin++;
    else draw++;
  }
  console.log('    ' + a + ' vs ' + b + ' → ' + aWin + ' : ' + bWin + '（平手 ' + draw + '）');
  return { aWin, bWin, draw };
}
const hb = duel('hard', 'baby');
const hn = duel('hard', 'easy');
const nb = duel('normal', 'baby');

check(hb.aWin > hb.bWin, '困難打得贏幼幼班');
check(hn.aWin >= hn.bWin, '困難不會輸給簡單');
check(nb.aWin >= nb.bWin, '普通不會輸給幼幼班');

console.log('\n幼幼班的溫柔（幼幼班對幼幼班，看看多久才分出勝負）');
const babyGames = [];
for (let i = 0; i < 6; i++) babyGames.push(play(['baby', 'baby'], 'baby-' + i, 'open'));
const avg = babyGames.reduce((a, r) => a + r.time, 0) / babyGames.length;
console.log('    平均 ' + avg.toFixed(0) + ' 秒，' + babyGames.filter(r => r.reason === 'timeup').length + ' / 6 場是時間到才結束');
check(avg > 30, '幼幼班之間不會互相秒殺');

console.log('\n────────────────────────────');
console.log(fail ? fail + ' 項未通過' : '全部通過');
process.exit(fail ? 1 : 0);
