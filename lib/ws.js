/* ===== lib/ws.js — 很小的 WebSocket 伺服器（RFC 6455）=====
 *
 * 為什麼自己寫：這樣整個專案零依賴，使用者雙擊 .bat 就能玩，
 * 部署到 Render 也不必擔心套件安裝。瀏覽器端直接用原生 WebSocket。
 *
 * 支援：文字訊息（含 16/64 bit 長度）、分段續傳、ping/pong、close。
 * 不支援：permessage-deflate 壓縮、二進位訊息（用不到）。
 */
'use strict';

const crypto = require('crypto');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function accept(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

/** 把要送出去的資料包成 frame（伺服器送出的不加遮罩） */
function frame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeUInt32BE(Math.floor(len / 4294967296), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

class Socket {
  constructor(raw) {
    this.raw = raw;
    this.alive = true;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOp = 0;
    this.handlers = { message: [], close: [] };
    this.data = {};   /* 給上層掛自己的東西（玩家 id 之類） */
  }

  on(name, fn) {
    if (this.handlers[name]) this.handlers[name].push(fn);
    return this;
  }

  emit(name, arg) {
    for (const fn of this.handlers[name] || []) {
      try { fn(arg); } catch (e) { console.error('[ws] handler error:', e && e.message); }
    }
  }

  send(text) {
    if (!this.alive) return;
    try {
      this.raw.write(frame(0x1, Buffer.from(String(text), 'utf8')));
    } catch (e) {
      this.close();
    }
  }

  sendJSON(obj) {
    this.send(JSON.stringify(obj));
  }

  ping() {
    if (!this.alive) return;
    try { this.raw.write(frame(0x9, Buffer.alloc(0))); } catch (e) { this.close(); }
  }

  close() {
    if (!this.alive) return;
    this.alive = false;
    try { this.raw.write(frame(0x8, Buffer.alloc(0))); } catch (e) { /* 已經斷了 */ }
    try { this.raw.end(); } catch (e) { /* 忽略 */ }
    this.emit('close');
  }

  /** 收到新的位元組，盡量把完整的 frame 解出來 */
  feed(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      const buf = this.buffer;
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (buf.length < offset + 2) return;
        len = buf.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (buf.length < offset + 8) return;
        const hi = buf.readUInt32BE(offset);
        const lo = buf.readUInt32BE(offset + 4);
        len = hi * 4294967296 + lo;
        offset += 8;
      }

      let mask = null;
      if (masked) {
        if (buf.length < offset + 4) return;
        mask = buf.slice(offset, offset + 4);
        offset += 4;
      }
      if (buf.length < offset + len) return;

      const payload = Buffer.from(buf.slice(offset, offset + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      this.buffer = buf.slice(offset + len);

      if (opcode === 0x8) { this.close(); return; }
      if (opcode === 0x9) { try { this.raw.write(frame(0xA, payload)); } catch (e) { /* 忽略 */ } continue; }
      if (opcode === 0xA) continue;   /* pong */

      if (opcode === 0x0) {
        this.fragments.push(payload);
      } else {
        this.fragments = [payload];
        this.fragmentOp = opcode;
      }
      if (!fin) continue;

      const full = Buffer.concat(this.fragments);
      this.fragments = [];
      if (this.fragmentOp === 0x1) this.emit('message', full.toString('utf8'));
    }
  }
}

/**
 * 掛在既有的 http server 上。
 * @param {import('http').Server} server
 * @param {{path?:string, onConnection:(socket:Socket, req:any)=>void}} opt
 */
function attach(server, opt) {
  const path = opt.path || '/ws';

  server.on('upgrade', (req, raw, head) => {
    const url = (req.url || '').split('?')[0];
    const key = req.headers['sec-websocket-key'];
    if (url !== path || !key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      raw.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      raw.destroy();
      return;
    }

    raw.setNoDelay(true);
    raw.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept(key) + '\r\n\r\n'
    );

    const socket = new Socket(raw);
    if (head && head.length) socket.feed(head);
    raw.on('data', chunk => socket.feed(chunk));
    raw.on('close', () => { socket.alive = false; socket.emit('close'); });
    raw.on('error', () => { socket.alive = false; socket.emit('close'); });
    opt.onConnection(socket, req);
  });
}

module.exports = { attach, Socket, frame, accept };
