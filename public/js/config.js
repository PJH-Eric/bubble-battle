/* ===== config.js — 全站唯一的 server URL 設定入口 =====
 * M0 只有單機，還用不到；但入口先立在這裡，之後線上模式一律從這裡拿位置，
 * app.js、online.js、測試都不可以自己寫死網址。
 *
 * 解析優先序：
 *   1. 網址參數 ?server=https://example.com
 *   2. 建置時注入（scripts/inject-server-url.js 會改寫下面 INJECTED 那一行）
 *   3. 頁面本身就是伺服器發出來的 → 用同源
 *   4. 都不是 → null，代表只能玩單機
 */
(function (root) {
  'use strict';

  /* GAME_SERVER_URL:BEGIN 這一行由 scripts/inject-server-url.js 改寫，請勿更動格式 */
  var INJECTED = '';
  /* GAME_SERVER_URL:END */

  function resolve(injected, queryValue, pageProtocol, pageOrigin) {
    var raw = String(queryValue || injected || '').trim();
    var source = queryValue ? 'query' : 'injected';

    if (!raw) {
      if ((pageProtocol === 'http:' || pageProtocol === 'https:') && pageOrigin) {
        return { url: String(pageOrigin).replace(/\/+$/, ''), source: 'same-origin', status: 'ok', error: null };
      }
      return { url: null, source: 'none', status: 'unset', error: null };
    }
    if (!/^https?:\/\//i.test(raw)) {
      return { url: null, source: source, status: 'invalid', error: 'server URL 必須是 http/https 開頭的絕對網址' };
    }
    if (pageProtocol === 'https:' && /^http:\/\//i.test(raw)) {
      return { url: null, source: source, status: 'invalid', error: '頁面走 https 時不接受 http 的 server URL（瀏覽器會擋混合內容）' };
    }
    return { url: raw.replace(/\/+$/, ''), source: source, status: 'ok', error: null };
  }

  var query = '';
  try {
    query = new URLSearchParams(root.location ? root.location.search : '').get('server') || '';
  } catch (e) { query = ''; }

  var result = root.location
    ? resolve(INJECTED, query, root.location.protocol, root.location.origin)
    : resolve(INJECTED, '', '', '');

  root.Config = {
    serverUrl: result.url,
    source: result.source,
    status: result.status,
    error: result.error,
    resolve: resolve
  };
})(typeof self !== 'undefined' ? self : this);
