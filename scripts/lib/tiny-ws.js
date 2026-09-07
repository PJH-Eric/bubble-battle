/* ===== scripts/lib/tiny-ws.js — 自測用的最小 WebSocket 客戶端 =====
 * 只為了讓 check 腳本能真的連上自己的伺服器，不做遮罩（我們的伺服器兩種都收）。
 */
'use strict';

const net = require('net');
const crypto = require('crypto');

function tinyClient(port, onMessage) {
  const key = crypto.randomBytes(16).toString('base64');
  const sock = net.connect(port, '127.0.0.1');
  let handshaked = false;
  let buf = Buffer.alloc(0);

  sock.on('connect', () => {
    sock.write(
      'GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n'
    );
  });

  sock.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    if (!handshaked) {
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) return;
      handshaked = true;
      buf = buf.slice(end + 4);
    }
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) return;
      const payload = buf.slice(off, off + len).toString('utf8');
      buf = buf.slice(off + len);
      if (opcode === 0x1) {
        try { onMessage(JSON.parse(payload)); } catch (e) { /* 忽略 */ }
      }
    }
  });

  sock.on('error', () => { /* 測試收尾時對方先關掉是正常的 */ });

  return {
    send(obj) {
      const body = Buffer.from(JSON.stringify(obj), 'utf8');
      let header;
      if (body.length < 126) { header = Buffer.from([0x81, body.length]); }
      else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(body.length, 2); }
      sock.write(Buffer.concat([header, body]));
    },
    end() { sock.destroy(); }
  };
}

module.exports = { tinyClient };
