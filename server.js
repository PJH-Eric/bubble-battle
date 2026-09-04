/* ===== server.js — M0 只負責把靜態檔案送出去 =====
 * 線上對戰（Socket.IO、房間、觀戰）是 M2 的工作，這裡先保持最小。
 */
'use strict';

const path = require('path');
const express = require('express');
const os = require('os');

const app = express();
const PORT = Number(process.env.PORT) || 3040;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.json({ ok: true, game: 'bubble-battle', time: Date.now() });
});

app.listen(PORT, () => {
  console.log('泡泡大作戰已啟動：');
  console.log('  本機   http://localhost:' + PORT);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log('  同網段 http://' + net.address + ':' + PORT);
      }
    }
  }
});
