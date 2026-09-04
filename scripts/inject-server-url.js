/* ===== scripts/inject-server-url.js — 建置時把 server URL 注入 config.js =====
 * 用法：GAME_SERVER_URL=https://xxx.onrender.com node scripts/inject-server-url.js
 * GitHub Actions 佈署 Pages 時會跑這一支。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'public', 'js', 'config.js');
const url = String(process.env.GAME_SERVER_URL || '').trim();

if (!url) {
  console.error('沒有設定 GAME_SERVER_URL，這樣前端只會有單機模式。');
  console.error('請在 repo 的 Variables 加上 GAME_SERVER_URL，值填伺服器網址。');
  process.exit(1);
}
if (!/^https?:\/\//i.test(url)) {
  console.error('GAME_SERVER_URL 必須是 http/https 開頭的絕對網址，收到的是：' + url);
  process.exit(1);
}
if (/^http:\/\/(localhost|127\.)/i.test(url)) {
  console.error('正式建置不可以用 localhost：' + url);
  process.exit(1);
}

const source = fs.readFileSync(file, 'utf8');
const marker = /(\/\* GAME_SERVER_URL:BEGIN[\s\S]*?\*\/\n)([\s\S]*?)(\n\s*\/\* GAME_SERVER_URL:END)/;
if (!marker.test(source)) {
  console.error('config.js 裡找不到注入用的標記，請確認格式沒有被改動。');
  process.exit(1);
}
const out = source.replace(marker, (m, begin, body, end) =>
  begin + "  var INJECTED = '" + url.replace(/\/+$/, '') + "';" + end);

fs.writeFileSync(file, out, 'utf8');
console.log('已把 server URL 注入 config.js：' + url);
