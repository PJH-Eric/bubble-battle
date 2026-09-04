/* ===== rng.js — 可注入種子的亂數 =====
 * 地圖生成、道具掉落都走這裡，才能重播、測試與（之後的）多人同步重現。
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RNG = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** xmur3：把字串或數字揉成 32 bit 種子 */
  function hashSeed(seed) {
    const str = String(seed);
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return (h >>> 0) || 1;
  }

  /** mulberry32：小、快、夠均勻 */
  function create(seed) {
    let a = hashSeed(seed);
    const rng = {
      /** [0,1) */
      next() {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      },
      /** [min,max] 的整數 */
      int(min, max) {
        return min + Math.floor(rng.next() * (max - min + 1));
      },
      /** 機率 p 命中 */
      chance(p) {
        return rng.next() < p;
      },
      /** 從陣列挑一個 */
      pick(arr) {
        return arr[Math.floor(rng.next() * arr.length)];
      },
      /** 原地洗牌（Fisher-Yates） */
      shuffle(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
          const j = Math.floor(rng.next() * (i + 1));
          const t = arr[i];
          arr[i] = arr[j];
          arr[j] = t;
        }
        return arr;
      }
    };
    return rng;
  }

  return { create, hashSeed };
});
