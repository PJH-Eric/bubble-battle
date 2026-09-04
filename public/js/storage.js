/* ===== storage.js — 本機設定與戰績（只存在這台裝置，不上傳） ===== */
(function (root) {
  'use strict';
  const KEY = 'bubble-battle';

  const DEFAULTS = {
    nickname: '',
    char: 'cat',
    field: 'meadow',
    control: 'stick',
    bgm: true,
    sfx: true,
    bgmVol: 0.35,
    sfxVol: 0.6,
    reduceMotion: false,
    aiCount: 3,
    aiLevel: 'normal',
    mapPick: 'open',
    seenHelp: false,
    seenRotateTip: false,
    stats: { matches: 0, wins: 0, bestSurvive: 0, boxes: 0, items: 0, charUse: {} }
  };

  function load() {
    let raw = null;
    try { raw = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { raw = null; }
    const data = Object.assign({}, DEFAULTS, raw || {});
    data.stats = Object.assign({}, DEFAULTS.stats, (raw && raw.stats) || {});
    data.stats.charUse = Object.assign({}, (raw && raw.stats && raw.stats.charUse) || {});
    return data;
  }

  function save(data) {
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* 無痕模式等等，忽略 */ }
  }

  function reset() {
    try { localStorage.removeItem(KEY); } catch (e) { /* 忽略 */ }
  }

  /** 一局結束後記一筆 */
  function record(data, result) {
    const s = data.stats;
    s.matches++;
    if (result.win) s.wins++;
    s.bestSurvive = Math.max(s.bestSurvive, Math.round(result.survived || 0));
    s.boxes += result.boxes || 0;
    s.items += result.items || 0;
    if (result.char) s.charUse[result.char] = (s.charUse[result.char] || 0) + 1;
    save(data);
    return s;
  }

  root.Store = { load, save, reset, record, DEFAULTS };
})(typeof self !== 'undefined' ? self : this);
