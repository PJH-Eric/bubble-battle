/* ===== render.js — 手繪向量 SVG 繪圖 =====
 * 全部用向量畫，不使用任何 emoji 文字美術。
 * 座標系統直接用「格」，viewBox = 0 0 cols rows。
 */
(function (root) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const Characters = root.Characters;
  const Fields = root.Fields;
  const Rules = root.Rules;

  function el(name, attrs, parent) {
    const node = document.createElementNS(NS, name);
    if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(node);
    return node;
  }

  /** 依 key 同步一層節點，避免每幀重建整層 */
  function syncLayer(layer, list, keyOf, create, update) {
    const alive = new Set();
    for (const item of list) {
      const k = String(keyOf(item));
      alive.add(k);
      let node = layer._map.get(k);
      if (!node) {
        node = create(item);
        layer.appendChild(node);
        layer._map.set(k, node);
      }
      update(node, item);
    }
    for (const [k, node] of layer._map) {
      if (!alive.has(k)) { node.remove(); layer._map.delete(k); }
    }
  }

  function makeLayer(parent, cls) {
    const g = el('g', { class: cls }, parent);
    g._map = new Map();
    return g;
  }

  /* ---------- 角色：有頭、身體、手、腳，並用漸層做出立體感 ---------- */

  let uid = 0;

  function mix(hex, white, amt) {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const t = white ? 255 : 0;
    const f = v => Math.round(v + (t - v) * amt);
    return '#' + [f(r), f(g), f(b)].map(v => v.toString(16).padStart(2, '0')).join('');
  }

  /**
   * 把一隻角色畫進指定的 group（盤面、挑選器、結算畫面共用）。
   * 回傳可以拿來做動作的部位。
   */
  function buildChar(root, ch) {
    const id = 'bc' + (++uid);
    const defs = el('defs', null, root);

    const gb = el('radialGradient', { id: id + 'b', cx: '34%', cy: '26%', r: '82%' }, defs);
    el('stop', { offset: '0%', 'stop-color': mix(ch.body, true, 0.42) }, gb);
    el('stop', { offset: '58%', 'stop-color': ch.body }, gb);
    el('stop', { offset: '100%', 'stop-color': ch.dark }, gb);

    const gl = el('linearGradient', { id: id + 'l', x1: '0%', y1: '0%', x2: '0%', y2: '100%' }, defs);
    el('stop', { offset: '0%', 'stop-color': ch.body }, gl);
    el('stop', { offset: '100%', 'stop-color': ch.dark }, gl);

    const BODY = 'url(#' + id + 'b)';
    const LIMB = 'url(#' + id + 'l)';

    /* 腳（畫在最後面，走路時會前後擺） */
    const legL = el('g', null, root);
    el('ellipse', { cx: -0.11, cy: 0.29, rx: 0.085, ry: 0.11, fill: LIMB, stroke: ch.dark, 'stroke-width': 0.022 }, legL);
    const legR = el('g', null, root);
    el('ellipse', { cx: 0.11, cy: 0.29, rx: 0.085, ry: 0.11, fill: LIMB, stroke: ch.dark, 'stroke-width': 0.022 }, legR);

    /* 手 */
    const armL = el('g', null, root);
    el('ellipse', { cx: -0.235, cy: 0.08, rx: 0.072, ry: 0.115, fill: LIMB, stroke: ch.dark, 'stroke-width': 0.022, transform: 'rotate(14 -0.235 0.08)' }, armL);
    const armR = el('g', null, root);
    el('ellipse', { cx: 0.235, cy: 0.08, rx: 0.072, ry: 0.115, fill: LIMB, stroke: ch.dark, 'stroke-width': 0.022, transform: 'rotate(-14 0.235 0.08)' }, armR);

    /* 身體 */
    el('ellipse', { cy: 0.12, rx: 0.205, ry: 0.185, fill: BODY, stroke: ch.dark, 'stroke-width': 0.028 }, root);
    el('ellipse', { cy: 0.15, rx: 0.125, ry: 0.12, fill: ch.belly, opacity: 0.92 }, root);
    el('ellipse', { cx: -0.07, cy: 0.02, rx: 0.06, ry: 0.045, fill: '#FFFFFF', opacity: 0.3, transform: 'rotate(-25 -0.07 0.02)' }, root);

    /* 耳朵（畫在頭後面） */
    const HY = -0.17;
    const ears = el('g', null, root);
    if (ch.ear === 'point') {
      el('path', { d: 'M-0.22,' + (HY + 0.02) + ' L-0.27,' + (HY - 0.27) + ' L-0.04,' + (HY - 0.16) + ' Z', fill: BODY, stroke: ch.dark, 'stroke-width': 0.028, 'stroke-linejoin': 'round' }, ears);
      el('path', { d: 'M0.22,' + (HY + 0.02) + ' L0.27,' + (HY - 0.27) + ' L0.04,' + (HY - 0.16) + ' Z', fill: BODY, stroke: ch.dark, 'stroke-width': 0.028, 'stroke-linejoin': 'round' }, ears);
      el('path', { d: 'M-0.19,' + (HY - 0.02) + ' L-0.22,' + (HY - 0.19) + ' L-0.09,' + (HY - 0.13) + ' Z', fill: ch.inner }, ears);
      el('path', { d: 'M0.19,' + (HY - 0.02) + ' L0.22,' + (HY - 0.19) + ' L0.09,' + (HY - 0.13) + ' Z', fill: ch.inner }, ears);
    } else if (ch.ear === 'flop') {
      el('ellipse', { cx: -0.25, cy: HY + 0.02, rx: 0.093, ry: 0.17, fill: LIMB, stroke: ch.dark, 'stroke-width': 0.025 }, ears);
      el('ellipse', { cx: 0.25, cy: HY + 0.02, rx: 0.093, ry: 0.17, fill: LIMB, stroke: ch.dark, 'stroke-width': 0.025 }, ears);
    } else if (ch.ear === 'long') {
      for (const sx of [-1, 1]) {
        el('ellipse', { cx: sx * 0.105, cy: HY - 0.3, rx: 0.072, ry: 0.21, fill: BODY, stroke: ch.dark, 'stroke-width': 0.025 }, ears);
        el('ellipse', { cx: sx * 0.105, cy: HY - 0.3, rx: 0.032, ry: 0.13, fill: ch.inner }, ears);
      }
    } else if (ch.ear === 'round') {
      for (const sx of [-1, 1]) {
        el('circle', { cx: sx * 0.185, cy: HY - 0.185, r: 0.105, fill: ch.id === 'panda' ? ch.inner : BODY, stroke: ch.dark, 'stroke-width': 0.025 }, ears);
        if (ch.id !== 'panda') el('circle', { cx: sx * 0.185, cy: HY - 0.185, r: 0.05, fill: ch.inner }, ears);
      }
    } else if (ch.ear === 'crest') {
      el('path', { d: 'M-0.08,' + (HY - 0.2) + ' q0.08,-0.15 0.16,0', fill: 'none', stroke: ch.inner, 'stroke-width': 0.055, 'stroke-linecap': 'round' }, ears);
    }

    /* 頭 */
    el('circle', { cy: HY, r: 0.235, fill: BODY, stroke: ch.dark, 'stroke-width': 0.03 }, root);
    el('ellipse', { cx: -0.085, cy: HY - 0.1, rx: 0.075, ry: 0.05, fill: '#FFFFFF', opacity: 0.38, transform: 'rotate(-28 -0.085 ' + (HY - 0.1) + ')' }, root);

    if (ch.ear === 'top') { /* 青蛙：頭頂的大眼睛 */
      for (const sx of [-1, 1]) {
        el('circle', { cx: sx * 0.135, cy: HY - 0.2, r: 0.095, fill: BODY, stroke: ch.dark, 'stroke-width': 0.025 }, root);
        el('circle', { cx: sx * 0.135, cy: HY - 0.2, r: 0.042, fill: '#2B2B33' }, root);
        el('circle', { cx: sx * 0.135 - 0.016, cy: HY - 0.218, r: 0.015, fill: '#FFFFFF' }, root);
      }
    }
    if (ch.id === 'panda') {
      for (const sx of [-1, 1]) {
        el('ellipse', { cx: sx * 0.095, cy: HY + 0.005, rx: 0.082, ry: 0.098, fill: '#3B3B44', transform: 'rotate(' + (sx * 12) + ' ' + (sx * 0.095) + ' ' + (HY + 0.005) + ')' }, root);
      }
    }
    if (ch.id === 'penguin') {
      el('ellipse', { cy: HY + 0.03, rx: 0.155, ry: 0.175, fill: '#FFFFFF', opacity: 0.95 }, root);
    }

    /* 臉 */
    const face = el('g', { class: 'actor-face' }, root);
    el('circle', { cx: -0.088, cy: HY, r: 0.045, fill: '#2B2B33' }, face);
    el('circle', { cx: 0.088, cy: HY, r: 0.045, fill: '#2B2B33' }, face);
    el('circle', { cx: -0.104, cy: HY - 0.018, r: 0.016, fill: '#FFFFFF' }, face);
    el('circle', { cx: 0.072, cy: HY - 0.018, r: 0.016, fill: '#FFFFFF' }, face);
    if (ch.id === 'penguin' || ch.id === 'chick') {
      el('path', { d: 'M-0.052,' + (HY + 0.075) + ' L0.052,' + (HY + 0.075) + ' L0,' + (HY + 0.15) + ' Z', fill: ch.inner, stroke: mix(ch.inner, false, 0.2), 'stroke-width': 0.018, 'stroke-linejoin': 'round' }, face);
    } else {
      el('ellipse', { cy: HY + 0.085, rx: 0.055, ry: 0.042, fill: ch.belly, opacity: 0.9 }, face);
      el('path', { d: 'M-0.045,' + (HY + 0.075) + ' q0.045,0.055 0.09,0', fill: 'none', stroke: '#2B2B33', 'stroke-width': 0.026, 'stroke-linecap': 'round' }, face);
    }
    el('circle', { cx: -0.175, cy: HY + 0.055, r: 0.042, fill: '#FF9DAE', opacity: 0.6 }, face);
    el('circle', { cx: 0.175, cy: HY + 0.055, r: 0.042, fill: '#FF9DAE', opacity: 0.6 }, face);

    return { face, legL, legR, armL, armR };
  }

  function create(svg) {
    let field = Fields.byId('meadow');
    let prevTiles = null;
    let layers = null;
    let tileNodes = null;
    let cols = 0, rows = 0;

    function setup(state, opts) {
      field = Fields.byId((opts && opts.field) || 'meadow');
      cols = state.cols; rows = state.rows;
      svg.setAttribute('viewBox', '0 0 ' + cols + ' ' + rows);
      svg.innerHTML = '';

      const defs = el('defs', null, svg);
      const glow = el('radialGradient', { id: 'ownGlow' }, defs);
      el('stop', { offset: '0%', 'stop-color': '#FFF27A', 'stop-opacity': '0.85' }, glow);
      el('stop', { offset: '100%', 'stop-color': '#FFF27A', 'stop-opacity': '0' }, glow);
      const bub = el('radialGradient', { id: 'bubbleGrad', cx: '35%', cy: '30%' }, defs);
      el('stop', { offset: '0%', 'stop-color': '#FFFFFF', 'stop-opacity': '0.95' }, bub);
      el('stop', { offset: '55%', 'stop-color': '#9FE3FF', 'stop-opacity': '0.45' }, bub);
      el('stop', { offset: '100%', 'stop-color': '#3FB7E8', 'stop-opacity': '0.7' }, bub);

      /* 地板棋盤 */
      const floor = el('g', null, svg);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          el('rect', {
            x: c, y: r, width: 1, height: 1,
            fill: (c + r) % 2 === 0 ? field.floorA : field.floorB
          }, floor);
        }
      }

      layers = {
        tiles: makeLayer(svg, 'l-tiles'),
        items: makeLayer(svg, 'l-items'),
        bombs: makeLayer(svg, 'l-bombs'),
        blasts: makeLayer(svg, 'l-blasts'),
        actors: makeLayer(svg, 'l-actors')
      };
      tileNodes = new Array(cols * rows).fill(null);
      prevTiles = new Array(cols * rows).fill(-1);
      drawTiles(state);
    }

    function drawTiles(state) {
      for (let i = 0; i < state.tiles.length; i++) {
        if (state.tiles[i] === prevTiles[i]) continue;
        prevTiles[i] = state.tiles[i];
        if (tileNodes[i]) { tileNodes[i].remove(); tileNodes[i] = null; }
        const c = i % cols, r = Math.floor(i / cols);
        const v = state.tiles[i];
        if (v === Rules.HARD) tileNodes[i] = hardBlock(c, r);
        else if (v === Rules.SOFT) tileNodes[i] = softBox(c, r);
      }
    }

    function hardBlock(c, r) {
      const g = el('g', null, layers.tiles);
      el('rect', { x: c + 0.02, y: r + 0.06, width: 0.96, height: 0.94, rx: 0.16, fill: field.hard }, g);
      el('rect', { x: c + 0.02, y: r + 0.02, width: 0.96, height: 0.72, rx: 0.16, fill: field.hardTop }, g);
      el('rect', { x: c + 0.16, y: r + 0.16, width: 0.68, height: 0.2, rx: 0.1, fill: '#ffffff', opacity: 0.25 }, g);
      return g;
    }

    function softBox(c, r) {
      const g = el('g', null, layers.tiles);
      el('rect', { x: c + 0.08, y: r + 0.14, width: 0.84, height: 0.8, rx: 0.14, fill: field.soft }, g);
      el('rect', { x: c + 0.08, y: r + 0.1, width: 0.84, height: 0.62, rx: 0.14, fill: field.softTop }, g);
      el('rect', { x: c + 0.46, y: r + 0.12, width: 0.08, height: 0.8, fill: '#ffffff', opacity: 0.35 }, g);
      el('rect', { x: c + 0.1, y: r + 0.42, width: 0.8, height: 0.08, fill: '#ffffff', opacity: 0.35 }, g);
      return g;
    }

    /* ---------- 道具 ---------- */

    const GOOD = new Set(['bomb', 'power', 'shoe', 'glove', 'needle', 'shield']);

    function itemNode(it) {
      const g = el('g', null, layers.items);
      /* 形狀輔助：正面道具圓底、負面道具三角底，色弱也分得出來 */
      el('ellipse', { cy: 0.3, rx: 0.2, ry: 0.06, fill: '#000000', opacity: 0.14 }, g);
      if (GOOD.has(it.type)) {
        el('circle', { r: 0.3, fill: '#FFFFFF', stroke: '#3FA9D6', 'stroke-width': 0.08 }, g);
      } else {
        el('path', { d: 'M0,-0.32 L0.3,0.22 L-0.3,0.22 Z', fill: '#FFFFFF', stroke: '#D9505F', 'stroke-width': 0.08, 'stroke-linejoin': 'round' }, g);
      }
      const mark = el('g', null, g);
      switch (it.type) {
        case 'bomb':
          el('circle', { r: 0.13, cx: -0.05, cy: 0.04, fill: '#5EC3E8' }, mark);
          el('circle', { r: 0.04, cx: -0.08, cy: 0.0, fill: '#FFFFFF', opacity: 0.9 }, mark);
          el('path', { d: 'M0.12,-0.02 v0.16 M0.04,0.06 h0.16', stroke: '#2E9BC4', 'stroke-width': 0.06, 'stroke-linecap': 'round' }, mark);
          break;
        case 'power':
          el('path', { d: 'M-0.02,-0.2 L0.16,-0.02 L0.04,-0.02 L0.06,0.2 L-0.14,0.0 L-0.02,0.0 Z', fill: '#FF8A3D' }, mark);
          break;
        case 'shoe':
          el('path', { d: 'M-0.18,0.04 L-0.02,0.04 L0.06,-0.12 L0.16,0.04 L0.18,0.14 L-0.18,0.14 Z', fill: '#57C08A' }, mark);
          break;
        case 'glove':
          el('path', { d: 'M-0.13,0.16 v-0.2 q0-0.08 0.07,-0.08 t0.07,0.08 v-0.06 q0,-0.08 0.07,-0.08 t0.07,0.08 v0.26 q0,0.1 -0.1,0.1 h-0.11 q-0.07,0 -0.07,-0.1 Z', fill: '#F2A65A', stroke: '#C97F3A', 'stroke-width': 0.035, 'stroke-linejoin': 'round' }, mark);
          break;
        case 'needle':
          el('path', { d: 'M-0.14,0.16 L0.14,-0.16', stroke: '#8E7BD6', 'stroke-width': 0.09, 'stroke-linecap': 'round' }, mark);
          el('circle', { cx: -0.14, cy: 0.16, r: 0.06, fill: '#8E7BD6' }, mark);
          break;
        case 'shield':
          el('path', { d: 'M0,-0.2 L0.16,-0.12 L0.16,0.06 L0,0.2 L-0.16,0.06 L-0.16,-0.12 Z', fill: '#FFD34D' }, mark);
          break;
        case 'turtle':
          el('circle', { r: 0.14, cy: 0.02, fill: '#7BA05B' }, mark);
          el('path', { d: 'M-0.14,0.02 L0.14,0.02 M0,-0.12 L0,0.16', stroke: '#4F6B39', 'stroke-width': 0.05 }, mark);
          break;
        case 'mini':
          el('circle', { r: 0.09, cy: 0.04, fill: '#7FA6C9' }, mark);
          break;
        case 'reverse':
          el('path', { d: 'M-0.16,0.06 L0.16,0.06 M0.16,0.06 L0.06,-0.04 M-0.16,0.06 L-0.06,0.16', stroke: '#C86FA8', 'stroke-width': 0.07, fill: 'none', 'stroke-linecap': 'round' }, mark);
          break;
      }
      return g;
    }

    /* ---------- 水球與水柱 ---------- */

    function bombNode() {
      const g = el('g', null, layers.bombs);
      const body = el('g', { class: 'bomb-body' }, g);
      el('ellipse', { cy: 0.3, rx: 0.26, ry: 0.08, fill: '#000000', opacity: 0.15 }, body);
      el('circle', { r: 0.34, fill: '#4FC0E8' }, body);
      el('circle', { r: 0.34, fill: 'none', stroke: '#2E9BC4', 'stroke-width': 0.05 }, body);
      el('path', { d: 'M-0.06,-0.34 q0.06,-0.12 0.12,0', fill: 'none', stroke: '#2E9BC4', 'stroke-width': 0.06, 'stroke-linecap': 'round' }, body);
      el('circle', { cx: -0.11, cy: -0.12, r: 0.09, fill: '#FFFFFF', opacity: 0.8 }, body);
      g._body = body;
      return g;
    }

    function blastCellNode(part) {
      const g = el('g', null, layers.blasts);
      if (part.kind === 'center') {
        el('circle', { r: 0.42, fill: '#8FE3FF', opacity: 0.9 }, g);
        el('circle', { r: 0.26, fill: '#FFFFFF', opacity: 0.85 }, g);
      } else {
        const horiz = part.dir === 'left' || part.dir === 'right';
        el('rect', {
          x: horiz ? -0.5 : -0.36, y: horiz ? -0.36 : -0.5,
          width: horiz ? 1 : 0.72, height: horiz ? 0.72 : 1,
          rx: 0.3, fill: '#8FE3FF', opacity: 0.85
        }, g);
        el('rect', {
          x: horiz ? -0.5 : -0.18, y: horiz ? -0.18 : -0.5,
          width: horiz ? 1 : 0.36, height: horiz ? 0.36 : 1,
          rx: 0.18, fill: '#FFFFFF', opacity: 0.8
        }, g);
      }
      return g;
    }

    /* ---------- 角色 ---------- */

    function actorNode(p) {
      const ch = Characters.byId(p.char);
      const g = el('g', null, layers.actors);

      const ring = el('g', { opacity: 0 }, g);
      el('circle', { cy: 0.26, r: 0.44, fill: 'url(#ownGlow)' }, ring);
      el('ellipse', { cy: 0.28, rx: 0.4, ry: 0.16, fill: 'none', stroke: '#FFC42E', 'stroke-width': 0.08 }, ring);
      const teamMark = el('g', { opacity: 0 }, g);
      el('circle', { cy: 0.3, r: 0.3, fill: 'none', stroke: '#FFFFFF', 'stroke-width': 0.06 }, teamMark);

      const body = el('g', { class: 'actor-body' }, g);
      el('ellipse', { cy: 0.42, rx: 0.27, ry: 0.085, fill: '#000000', opacity: 0.2 }, body);

      const cparts = buildChar(body, ch);
      const face = cparts.face;

      /* 泡泡（被困住時才顯示） */
      const bubble = el('g', { opacity: 0 }, g);
      el('circle', { cy: -0.02, r: 0.5, fill: 'url(#bubbleGrad)', stroke: '#7FD8F5', 'stroke-width': 0.04 }, bubble);
      el('ellipse', { cx: -0.16, cy: -0.2, rx: 0.1, ry: 0.06, fill: '#FFFFFF', opacity: 0.85, transform: 'rotate(-30)' }, bubble);

      const label = el('text', {
        y: -0.5, 'text-anchor': 'middle', 'font-size': 0.22,
        fill: '#3B3B44', stroke: '#FFFFFF', 'stroke-width': 0.08,
        'paint-order': 'stroke', 'font-weight': '700'
      }, g);

      g._parts = { ring, body, bubble, label, face, teamMark, limbs: cparts };
      return g;
    }

    /* ---------- 每幀更新 ---------- */

    function draw(state, opts) {
      opts = opts || {};
      drawTiles(state);

      syncLayer(layers.items, state.items, it => it.c + ':' + it.r + ':' + it.type,
        it => itemNode(it),
        (node, it) => node.setAttribute('transform', 'translate(' + (it.c + 0.5) + ',' + (it.r + 0.5) + ')'));

      syncLayer(layers.bombs, state.bombs, b => b.id,
        () => bombNode(),
        (node, b) => {
          node.setAttribute('transform', 'translate(' + (b.px != null ? b.px : b.c + 0.5) + ',' + (b.py != null ? b.py : b.r + 0.5) + ')');
          /* 一秒跳一次；越接近爆炸跳得越用力（頻率不變，幅度變大）——這是唯一的預告 */
          const left = Math.max(0, Math.min(3, b.fuse));
          const grow = (3 - left) / 3;                 /* 0 → 1 */
          const beat = Math.sin(state.time * Math.PI * 2);
          const pulse = 1 + beat * (0.05 + grow * 0.13);
          node._body.setAttribute('transform', 'scale(' + pulse.toFixed(3) + ')');
        });

      const parts = [];
      for (const bl of state.blasts) {
        const fade = Math.max(0, Math.min(1, bl.ttl / bl.life));
        for (const c of bl.cells) parts.push({ c: c.c, r: c.r, kind: c.kind, dir: c.dir, fade, id: c.c + ':' + c.r });
      }
      syncLayer(layers.blasts, parts, p => p.id,
        p => blastCellNode(p),
        (node, p) => {
          node.setAttribute('transform', 'translate(' + (p.c + 0.5) + ',' + (p.r + 0.5) + ') scale(' + (0.7 + p.fade * 0.3).toFixed(3) + ')');
          node.setAttribute('opacity', (0.35 + p.fade * 0.65).toFixed(3));
        });

      const shown = state.players.filter(p => p.state !== 'dead');
      syncLayer(layers.actors, shown, p => p.id,
        p => actorNode(p),
        (node, p) => {
          node.setAttribute('transform', 'translate(' + p.x.toFixed(4) + ',' + p.y.toFixed(4) + ')');
          const parts = node._parts;

          /* 走路時上下輕輕彈一下 */
          const walking = p.moving && p.state === 'alive';
          const swing = walking ? Math.sin(state.time * 11) : 0;
          const bob = walking ? Math.abs(Math.sin(state.time * 11)) * 0.045 : 0;
          const L = parts.limbs;
          L.legL.setAttribute('transform', 'translate(' + (swing * 0.05).toFixed(3) + ',' + (-Math.max(0, swing) * 0.05).toFixed(3) + ')');
          L.legR.setAttribute('transform', 'translate(' + (-swing * 0.05).toFixed(3) + ',' + (-Math.max(0, -swing) * 0.05).toFixed(3) + ')');
          L.armL.setAttribute('transform', 'rotate(' + (-swing * 18).toFixed(1) + ' -0.235 0.08)');
          L.armR.setAttribute('transform', 'rotate(' + (swing * 18).toFixed(1) + ' 0.235 0.08)');
          const lean = p.dir === 'left' ? -0.04 : p.dir === 'right' ? 0.04 : 0;
          parts.body.setAttribute('transform', 'translate(' + lean + ',' + (-bob) + ')');
          parts.face.setAttribute('transform', 'translate(' + (lean * 1.6) + ',' + (p.dir === 'up' ? -0.03 : 0) + ')');

          parts.bubble.setAttribute('opacity', p.state === 'trapped' ? 1 : 0);
          if (p.state === 'trapped') {
            const wob = 1 + Math.sin(state.time * 7) * 0.05;
            parts.bubble.setAttribute('transform', 'scale(' + wob.toFixed(3) + ')');
          }

          /* 自己：腳下實心光環。隊友／對手在組隊模式用虛線／鋸齒圈區分 */
          const isMe = p.id === opts.meId;
          if (isMe) {
            parts.ring.setAttribute('opacity', (0.75 + Math.sin(state.time * 4) * 0.25).toFixed(2));
            const s2 = (1 + Math.sin(state.time * 4) * 0.06).toFixed(3);
            parts.ring.setAttribute('transform', 'scale(' + s2 + ')');
          } else {
            parts.ring.setAttribute('opacity', 0);
          }
          if (state.mode === 'team' && !isMe) {
            const me = state.players.find(q => q.id === opts.meId);
            const mate = me && me.team === p.team;
            parts.teamMark.setAttribute('opacity', 0.9);
            const ring = parts.teamMark.firstChild;
            ring.setAttribute('stroke', mate ? '#5ED2A0' : '#FF8A7A');
            ring.setAttribute('stroke-dasharray', mate ? '0.16 0.12' : '0.06 0.1');
          } else {
            parts.teamMark.setAttribute('opacity', 0);
          }

          if (parts.label.textContent !== p.name) parts.label.textContent = p.name;
          parts.label.setAttribute('fill', isMe ? '#1C6FA8' : '#3B3B44');

          const flicker = p.invuln > 0 && p.state === 'alive' ? (Math.floor(state.time * 12) % 2 ? 0.45 : 1) : 1;
          node.setAttribute('opacity', flicker);
        });
    }

    return { setup, draw, get field() { return field; } };
  }

  /** 單獨畫一隻角色（首頁、挑選器、結算畫面用） */
  function sprite(svgEl, charId) {
    const ch = Characters.byId(charId);
    svgEl.innerHTML = '';
    svgEl.setAttribute('viewBox', '-0.62 -0.86 1.24 1.46');
    const g = el('g', null, svgEl);
    el('ellipse', { cy: 0.42, rx: 0.28, ry: 0.085, fill: '#000000', opacity: 0.14 }, g);
    buildChar(g, ch);
    return svgEl;
  }

  root.Render = { create, sprite };
})(typeof self !== 'undefined' ? self : this);
