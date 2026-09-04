/* ===== server.js — 靜態檔案伺服器 =====
 * 為了讓你「雙擊就能玩」，這支不依賴任何套件：
 * 有裝 express 就用 express，沒有就用 Node 內建的 http，兩種都跑得起來。
 * （線上對戰的 Socket.IO 之後會接在這裡。）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT) || 3040;
const ROOT = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.woff2': 'font/woff2'
};

function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('找不到這個檔案');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  let url = decodeURIComponent((req.url || '/').split('?')[0]);

  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, game: 'bubble-battle', time: Date.now() }));
    return;
  }

  if (url === '/') url = '/index.html';
  /* 擋掉往上跳目錄的路徑 */
  const file = path.join(ROOT, path.normalize(url).replace(/^([/\\])+/, ''));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('不可以');
    return;
  }
  sendFile(res, file);
});

server.listen(PORT, () => {
  console.log('');
  console.log('  泡泡大作戰 開好了！在瀏覽器打開：');
  console.log('    本機    http://localhost:' + PORT);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log('    同網段  http://' + net.address + ':' + PORT + '   ← 平板／手機用這個');
      }
    }
  }
  console.log('');
  console.log('  要關掉的話，在這個視窗按 Ctrl+C');
  console.log('');
});
