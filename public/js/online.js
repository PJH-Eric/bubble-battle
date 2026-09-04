/* ===== online.js — 和伺服器的連線（原生 WebSocket，無外部套件） =====
 * 位置一律從 config.js 拿，這裡不寫死任何網址。
 */
(function (root) {
  'use strict';

  function wsUrlFrom(httpUrl) {
    if (!httpUrl) return null;
    return httpUrl.replace(/^http/i, 'ws').replace(/\/+$/, '') + '/ws';
  }

  function create() {
    let socket = null;
    let url = null;
    let identity = { id: null, name: '玩家', char: 'cat' };
    let retry = 0;
    let closedByUs = false;
    const handlers = {};

    function on(type, fn) {
      (handlers[type] = handlers[type] || []).push(fn);
      return api;
    }

    function emit(type, payload) {
      for (const fn of handlers[type] || []) {
        try { fn(payload); } catch (e) { console.error('[online]', e); }
      }
      for (const fn of handlers['*'] || []) {
        try { fn(type, payload); } catch (e) { console.error('[online]', e); }
      }
    }

    function connect(serverUrl, who) {
      url = wsUrlFrom(serverUrl);
      if (who) identity = Object.assign(identity, who);
      if (!url) { emit('status', { state: 'offline', msg: '這個頁面沒有可以連的伺服器' }); return; }
      closedByUs = false;
      open();
    }

    function open() {
      emit('status', { state: retry ? 'reconnecting' : 'connecting' });
      let s;
      try { s = new WebSocket(url); } catch (e) {
        emit('status', { state: 'offline', msg: '連不上伺服器' });
        return;
      }
      socket = s;

      s.onopen = () => {
        retry = 0;
        emit('status', { state: 'online' });
        send({ t: 'hello', id: identity.id, name: identity.name, char: identity.char });
      };

      s.onmessage = ev => {
        let msg = null;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (!msg || !msg.t) return;
        if (msg.t === 'welcome') {
          identity.id = msg.id;
          try { localStorage.setItem('bubble-battle:id', msg.id); } catch (e) { /* 忽略 */ }
        }
        emit(msg.t, msg);
      };

      s.onclose = () => {
        socket = null;
        if (closedByUs) { emit('status', { state: 'offline' }); return; }
        retry++;
        const wait = Math.min(8000, 500 * Math.pow(1.7, retry));
        emit('status', { state: 'reconnecting', inMs: wait });
        setTimeout(() => { if (!closedByUs) open(); }, wait);
      };

      s.onerror = () => { /* onclose 會接手 */ };
    }

    function send(obj) {
      if (!socket || socket.readyState !== 1) return false;
      socket.send(JSON.stringify(obj));
      return true;
    }

    function close() {
      closedByUs = true;
      if (socket) socket.close();
      socket = null;
    }

    const api = {
      connect, send, close, on,
      get id() { return identity.id; },
      set id(v) { identity.id = v; },
      get connected() { return !!socket && socket.readyState === 1; },
      identity
    };
    return api;
  }

  root.Online = { create, wsUrlFrom };
})(typeof self !== 'undefined' ? self : this);
