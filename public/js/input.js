/* ===== input.js — 鍵盤、虛擬搖桿、全螢幕滑動 =====
 * 對外只吐 {dx,dy,drop}，和 AI 送進規則核心的格式完全一樣。
 */
(function (root) {
  'use strict';

  function create() {
    const keys = new Set();
    let dropQueued = false;
    let mode = 'stick';          /* 'stick' | 'swipe' */
    let stick = { active: false, id: null, dx: 0, dy: 0 };
    let swipe = { active: false, id: null, ox: 0, oy: 0, dx: 0, dy: 0, moved: false };
    let onUnlock = null;
    let els = {};

    const KEY_DIR = {
      ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
      KeyW: [0, -1], KeyS: [0, 1], KeyA: [-1, 0], KeyD: [1, 0]
    };
    const KEY_DROP = new Set(['Space', 'KeyJ', 'Enter', 'KeyK']);

    /** 正在打字（聊天室、暱稱欄）的時候，鍵盤不要被遊戲吃掉 */
    function typing(e) {
      const el = e.target;
      if (!el || !el.tagName) return false;
      const tag = el.tagName.toLowerCase();
      return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
    }

    function keydown(e) {
      if (e.repeat || typing(e)) return;
      if (KEY_DIR[e.code]) { keys.add(e.code); e.preventDefault(); }
      else if (KEY_DROP.has(e.code)) { dropQueued = true; e.preventDefault(); }
      fireUnlock();
    }
    function keyup(e) { keys.delete(e.code); }

    function fireUnlock() { if (onUnlock) { const f = onUnlock; onUnlock = null; f(); } }

    /* ---------- 虛擬搖桿 ---------- */

    function stickStart(e) {
      if (mode !== 'stick') return;
      stick.active = true;
      stick.id = e.pointerId;
      els.stick.setPointerCapture(e.pointerId);
      stickMove(e);
      fireUnlock();
      e.preventDefault();
    }
    function stickMove(e) {
      if (!stick.active || e.pointerId !== stick.id) return;
      const box = els.stick.getBoundingClientRect();
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      let dx = e.clientX - cx, dy = e.clientY - cy;
      const max = box.width / 2;
      const len = Math.hypot(dx, dy) || 1;
      const clamped = Math.min(len, max);
      const nx = (dx / len) * clamped, ny = (dy / len) * clamped;
      els.knob.style.transform = 'translate(' + nx.toFixed(1) + 'px,' + ny.toFixed(1) + 'px)';
      if (len < max * 0.28) { stick.dx = 0; stick.dy = 0; return; }   /* 死區 */
      if (Math.abs(dx) > Math.abs(dy)) { stick.dx = Math.sign(dx); stick.dy = 0; }
      else { stick.dx = 0; stick.dy = Math.sign(dy); }
      e.preventDefault();
    }
    function stickEnd(e) {
      if (e.pointerId !== stick.id) return;
      stick.active = false; stick.dx = 0; stick.dy = 0; stick.id = null;
      els.knob.style.transform = 'translate(0,0)';
    }

    /* ---------- 全螢幕滑動 ---------- */

    function swipeStart(e) {
      if (mode !== 'swipe') return;
      swipe.active = true; swipe.id = e.pointerId;
      swipe.ox = e.clientX; swipe.oy = e.clientY;
      swipe.dx = 0; swipe.dy = 0; swipe.moved = false;
      fireUnlock();
    }
    function swipeMove(e) {
      if (!swipe.active || e.pointerId !== swipe.id) return;
      const dx = e.clientX - swipe.ox, dy = e.clientY - swipe.oy;
      if (Math.hypot(dx, dy) < 14) { swipe.dx = 0; swipe.dy = 0; return; }
      swipe.moved = true;
      if (Math.abs(dx) > Math.abs(dy)) { swipe.dx = Math.sign(dx); swipe.dy = 0; }
      else { swipe.dx = 0; swipe.dy = Math.sign(dy); }
      /* 拖太遠就把原點跟上，手指不用回到起點 */
      const max = 60;
      if (Math.abs(dx) > max) swipe.ox = e.clientX - Math.sign(dx) * max;
      if (Math.abs(dy) > max) swipe.oy = e.clientY - Math.sign(dy) * max;
    }
    function swipeEnd(e) {
      if (e.pointerId !== swipe.id) return;
      if (!swipe.moved) dropQueued = true;   /* 點一下就是放水球 */
      swipe.active = false; swipe.dx = 0; swipe.dy = 0; swipe.id = null;
    }

    /* ---------- 對外 ---------- */

    function attach(opt) {
      els = opt;
      window.addEventListener('keydown', keydown);
      window.addEventListener('keyup', keyup);
      window.addEventListener('blur', () => keys.clear());

      els.stick.addEventListener('pointerdown', stickStart);
      els.stick.addEventListener('pointermove', stickMove);
      els.stick.addEventListener('pointerup', stickEnd);
      els.stick.addEventListener('pointercancel', stickEnd);

      els.drop.addEventListener('pointerdown', e => { dropQueued = true; fireUnlock(); e.preventDefault(); });

      els.surface.addEventListener('pointerdown', swipeStart);
      els.surface.addEventListener('pointermove', swipeMove);
      els.surface.addEventListener('pointerup', swipeEnd);
      els.surface.addEventListener('pointercancel', swipeEnd);
    }

    function setMode(m) {
      mode = m === 'swipe' ? 'swipe' : 'stick';
      if (els.stickWrap) els.stickWrap.hidden = mode !== 'stick';
    }

    function read() {
      let dx = 0, dy = 0;
      for (const code of keys) {
        const d = KEY_DIR[code];
        if (d) { dx = d[0] || dx; dy = d[1] || dy; }
      }
      if (stick.dx || stick.dy) { dx = stick.dx; dy = stick.dy; }
      else if (swipe.dx || swipe.dy) { dx = swipe.dx; dy = swipe.dy; }
      const drop = dropQueued;
      dropQueued = false;
      return { dx, dy, drop };
    }

    function clear() { keys.clear(); dropQueued = false; stick.dx = stick.dy = 0; swipe.dx = swipe.dy = 0; }
    function onFirstGesture(fn) { onUnlock = fn; }

    return { attach, read, setMode, clear, onFirstGesture, get mode() { return mode; } };
  }

  root.Input = { create };
})(typeof self !== 'undefined' ? self : this);
