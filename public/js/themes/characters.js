/* ===== themes/characters.js — 可愛動物園 8 隻角色（純資料） =====
 * 能力完全相同，只有外觀不同。主色刻意拉開，八人混戰也不會認錯人。
 */
(function (root) {
  'use strict';
  const CHARACTERS = [
    { id: 'cat',     name: '小花貓', body: '#F79A4A', dark: '#D97A2E', belly: '#FFE3C4', ear: 'point',  inner: '#FFC1A0' },
    { id: 'dog',     name: '阿布狗', body: '#EFD3A8', dark: '#C79A5E', belly: '#FFF3DE', ear: 'flop',   inner: '#C79A5E' },
    { id: 'rabbit',  name: '雪球兔', body: '#F7A9C4', dark: '#D97C9C', belly: '#FFE4EE', ear: 'long',   inner: '#FFC9DC' },
    { id: 'bear',    name: '胖胖熊', body: '#A96B3E', dark: '#7E4C29', belly: '#E8C9A5', ear: 'round',  inner: '#E8C9A5' },
    { id: 'panda',   name: '團團貓熊', body: '#FBFBF7', dark: '#3B3B44', belly: '#FFFFFF', ear: 'round', inner: '#3B3B44' },
    { id: 'penguin', name: '波波企鵝', body: '#4A6FD6', dark: '#2F4CA3', belly: '#FFFFFF', ear: 'none',  inner: '#FFC94A' },
    { id: 'frog',    name: '呱呱蛙', body: '#6FC46A', dark: '#489544', belly: '#DDF3C9', ear: 'top',    inner: '#DDF3C9' },
    { id: 'chick',   name: '啾啾雞', body: '#FFD44D', dark: '#E0A81E', belly: '#FFF0B8', ear: 'crest',  inner: '#FF9E3D' }
  ];
  const byId = id => CHARACTERS.find(c => c.id === id) || CHARACTERS[0];
  const api = { CHARACTERS, byId };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Characters = api;
})(typeof self !== 'undefined' ? self : this);
