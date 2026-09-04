/* ===== themes/fields.js — 地圖主題（純資料，加一套主題＝加一個項目） ===== */
(function (root) {
  'use strict';
  const FIELDS = [
    { id: 'meadow', name: '草原',   floorA: '#DCF3C0', floorB: '#D1EDB2', hard: '#5E7F53', hardTop: '#79A06A', soft: '#E8B96B', softTop: '#F4CE8B', line: '#7E9A6B' },
    { id: 'beach',  name: '海灘',   floorA: '#FDF0D2', floorB: '#F8E7C2', hard: '#8C7358', hardTop: '#AC9377', soft: '#5FB8D4', softTop: '#8FD3E7', line: '#C2A985' },
    { id: 'candy',  name: '糖果屋', floorA: '#FFEAF2', floorB: '#FFDDE9', hard: '#9A6FB5', hardTop: '#B98FD1', soft: '#FF8AA2', softTop: '#FFAEC0', line: '#E0A7C0' },
    { id: 'space',  name: '太空站', floorA: '#E2E7F4', floorB: '#D4DBEC', hard: '#4E5878', hardTop: '#6E7899', soft: '#4EC6B6', softTop: '#7FDDD0', line: '#98A2C0' },
    { id: 'forest', name: '森林',   floorA: '#CDE9CE', floorB: '#BFE1C1', hard: '#3F5E3F', hardTop: '#5C7F5A', soft: '#C08A5A', softTop: '#D7A579', line: '#6E8F6B' },
    { id: 'snow',   name: '雪國',   floorA: '#F2F8FE', floorB: '#E4EEF9', hard: '#6E88A3', hardTop: '#8EA6BE', soft: '#63B4DE', softTop: '#93CFEC', line: '#A9C0D4' }
  ];
  const byId = id => FIELDS.find(f => f.id === id) || FIELDS[0];
  const api = { FIELDS, byId };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Fields = api;
})(typeof self !== 'undefined' ? self : this);
