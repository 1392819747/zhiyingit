/**
 * GitHub 加速代理 — Cloudflare Worker
 *
 * 把 GitHub 的网页 / Raw / Release / clone 流量代理到 Cloudflare 边缘网络，加速访问。
 *
 * 用法（把 <域名> 换成你的 Worker 域名或自定义域名）：
 *   网页:   https://<域名>/https://github.com/user/repo
 *   Raw:    https://<域名>/https://raw.githubusercontent.com/user/repo/main/file.js
 *   下载:   https://<域名>/https://github.com/user/repo/releases/download/v1.0/app.zip
 *   Clone:  git clone https://<域名>/https://github.com/user/repo.git
 *
 * 环境变量：
 *   EXTRA_HOSTS  额外允许代理的主机（逗号分隔）。默认只代理 GitHub 相关域名，
 *                一般仅用于本地自测（例如指向 mock 上游）。
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 响应体中需要改写为代理地址的 GitHub 相关主机（正则片段） */
const HOST_ALT = [
  '(?:[a-z0-9-]+\\.)*github\\.com',
  '(?:[a-z0-9-]+\\.)*githubusercontent\\.com',
  '(?:[a-z0-9-]+\\.)*githubassets\\.com',
  '(?:[a-z0-9-]+\\.)*github\\.io',
  'githubstatus\\.com',
].join('|');

// 匹配 https:// / http:// / 协议相对的 GitHub URL；结尾负向预查避免误伤
// github.commercial.com 这类"前缀撞车"的域名
const URL_RE = new RegExp(`(?:https?:)?//(?:${HOST_ALT})(?![a-z0-9-])`, 'gi');

/** 不透传给上游的请求头 */
const DROP_REQ_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * 解析代理路径 -> 目标 URL
 * 支持: /https://github.com/a/b、/http://host/a、/github.com/a/b（默认 https）
 */
export function parseTargetUrl(pathname, search = '') {
  let p = String(pathname || '').replace(/^\/+/, '');
  if (!p) return null;
  let scheme = 'https';
  const m = p.match(/^(https?):\/\//i);
  if (m) {
    scheme = m[1].toLowerCase();
    p = p.slice(m[0].length);
  }
  const slash = p.indexOf('/');
  const hostPart = (slash === -1 ? p : p.slice(0, slash)).toLowerCase();
  const host = hostPart.split(':')[0];
  if (!host || !/^[a-z0-9.-]+$/.test(host)) return null;
  const path = slash === -1 ? '/' : p.slice(slash);
  try {
    return new URL(`${scheme}://${hostPart}${path}${search || ''}`);
  } catch {
    return null;
  }
}

/** 是否允许代理该主机 */
export function isAllowedHost(host, extraHosts = []) {
  const h = String(host || '').toLowerCase().replace(/:\d+$/, '');
  if (!h) return false;
  if (Array.isArray(extraHosts) && extraHosts.includes(h)) return true;
  return (
    h === 'github.com' ||
    h.endsWith('.github.com') ||
    h.endsWith('.githubusercontent.com') ||
    h.endsWith('.githubassets.com') ||
    h.endsWith('.github.io') ||
    h === 'githubstatus.com'
  );
}

/** 可缓存的静态资源主机（immutable 或 TTL 明确的内容） */
function isCacheableHost(host, extraHosts = []) {
  return (
    (Array.isArray(extraHosts) && extraHosts.includes(host)) ||
    host === 'codeload.github.com' ||
    host === 'raw.githubusercontent.com' ||
    host.endsWith('.githubusercontent.com') ||
    host.endsWith('.githubassets.com') ||
    host.endsWith('.github.io')
  );
}

/** 把响应体中的 GitHub 绝对/协议相对 URL 改写为经过本代理的地址 */
export function rewriteBody(text, origin) {
  if (!text) return text;
  return text.replace(URL_RE, (m) =>
    origin + '/' + (/^https?:/i.test(m) ? m : 'https:' + m)
  );
}

/** 规范化用户输入 -> 目标 URL 字符串 */
export function normalizeUserInput(input, origin) {
  let v = String(input || '').trim();
  if (!v) return '';
  const o = String(origin || '').toLowerCase();
  if (o && v.toLowerCase().startsWith(o + '/')) v = v.slice(o.length + 1);
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  return v;
}

function parseExtraHosts(env) {
  return String((env && env.EXTRA_HOSTS) || '')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/:\d+$/, ''))
    .filter(Boolean);
}

function buildUpstreamHeaders(request) {
  const h = new Headers();
  for (const [k, v] of request.headers.entries()) {
    const lk = k.toLowerCase();
    if (lk.startsWith('cf-')) continue;
    if (DROP_REQ_HEADERS.has(lk)) continue;
    h.set(k, v);
  }
  if (!h.has('user-agent')) h.set('user-agent', UA);
  return h;
}

function cleanHeaders(headers) {
  const h = new Headers(headers);
  // fetch 响应体已被运行时解压，必须去掉长度/编码头；CSP/NEL 指向 github.com，去掉避免拦截
  h.delete('content-encoding');
  h.delete('content-length');
  h.delete('content-security-policy');
  h.delete('content-security-policy-report-only');
  h.delete('nel');
  h.delete('report-to');
  h.set('x-proxy-by', 'cf-github-accel');
  return h;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function htmlResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function homePage(origin) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>GitHub 加速</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #f6f8fa; color: #1f2328; padding: 24px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  }
  main { width: 100%; max-width: 760px; }
  h1 { font-size: 32px; margin: 0 0 8px; }
  .sub { color: #59636e; margin: 0 0 28px; }
  form { display: flex; gap: 10px; }
  input {
    flex: 1; padding: 12px 14px; font-size: 15px; border: 1px solid #d1d9e0; border-radius: 8px;
    background: #fff; outline: none; min-width: 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  input:focus { border-color: #1f883d; box-shadow: 0 0 0 3px rgba(31, 136, 61, .15); }
  button {
    padding: 12px 22px; font-size: 15px; font-weight: 600; color: #fff; background: #1f883d;
    border: 0; border-radius: 8px; cursor: pointer; white-space: nowrap;
  }
  button:hover { background: #1a7f37; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; margin-top: 28px; }
  .card { background: #fff; border: 1px solid #d1d9e0; border-radius: 10px; padding: 14px 16px; }
  .card h3 { margin: 0 0 8px; font-size: 14px; color: #59636e; font-weight: 600; }
  .card code { font-size: 12.5px; color: #0969da; word-break: break-all;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .tip { margin-top: 20px; font-size: 13px; color: #59636e; line-height: 1.8; }
  .tip code { background: #eaeef2; padding: 2px 6px; border-radius: 6px; color: #1f2328; }
</style>
</head>
<body>
<main>
  <h1>⚡ GitHub 加速</h1>
  <p class="sub">粘贴 GitHub 链接，加速网页浏览、Raw 文件、Release 下载与 git clone</p>
  <form id="f">
    <input id="u" type="text" placeholder="https://github.com/user/repo" autocomplete="off" spellcheck="false" />
    <button type="submit">前 往</button>
  </form>
  <div class="grid">
    <div class="card"><h3>仓库 / 网页</h3><code id="c1"></code></div>
    <div class="card"><h3>Raw 文件</h3><code id="c2"></code></div>
    <div class="card"><h3>Release 下载</h3><code id="c3"></code></div>
    <div class="card"><h3>git clone</h3><code id="c4"></code></div>
  </div>
  <p class="tip">
    让 git 全局走加速（只需配一次）：<br>
    <code>git config --global url."https://你的域名/https://github.com/".insteadOf "https://github.com/"</code><br>
    之后执行 <code>git clone https://github.com/user/repo.git</code> 会自动改走本加速站。
  </p>
</main>
<script>
  var origin = location.origin;
  document.getElementById('c1').textContent = origin + '/https://github.com/user/repo';
  document.getElementById('c2').textContent = origin + '/https://raw.githubusercontent.com/user/repo/main/README.md';
  document.getElementById('c3').textContent = origin + '/https://github.com/user/repo/releases/download/v1.0.0/app.zip';
  document.getElementById('c4').textContent = 'git clone ' + origin + '/https://github.com/user/repo.git';
  document.getElementById('f').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = document.getElementById('u').value.trim();
    if (!v) return;
    if (v.toLowerCase().indexOf(origin.toLowerCase() + '/') === 0) v = v.slice(origin.length + 1);
    if (!/^https?:\\/\\//i.test(v)) v = 'https://' + v;
    location.href = origin + '/' + v;
  });
</script>
</body>
</html>`;
}

function errorPage(origin, status, message) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${status} · GitHub 加速</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #f6f8fa; color: #1f2328; padding: 24px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  .box { background: #fff; border: 1px solid #d1d9e0; border-radius: 12px; padding: 32px 36px; max-width: 560px; }
  h1 { margin: 0 0 12px; font-size: 22px; }
  p { margin: 0 0 20px; color: #59636e; line-height: 1.7; }
  code { background: #eaeef2; padding: 2px 6px; border-radius: 6px; }
  a { color: #0969da; text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>
  <div class="box">
    <h1>${status} · 出错了</h1>
    <p>${message}</p>
    <a href="${origin}/">← 返回首页</a>
  </div>
</body>
</html>`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = url.origin;
    const extraHosts = parseExtraHosts(env);

    // ---- 首页 / ?url= 快捷跳转 ----
    if (url.pathname === '/' || url.pathname === '') {
      const q = (url.searchParams.get('url') || url.searchParams.get('q') || '').trim();
      if (q) {
        const target = normalizeUserInput(q, origin);
        if (target) return Response.redirect(`${origin}/${target}`, 302);
      }
      return htmlResponse(homePage(origin));
    }
    if (url.pathname === '/healthz') {
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    if (url.pathname === '/favicon.ico') {
      return new Response(null, { status: 204 });
    }

    // ---- 解析目标地址 ----
    let target = parseTargetUrl(url.pathname, url.search);
    if (!target) {
      // 兼容被 URL 编码过的链接，如 /https%3A%2F%2Fgithub.com%2F...
      try {
        target = parseTargetUrl(decodeURIComponent(url.pathname), url.search);
      } catch {
        /* 保持 null */
      }
    }
    if (!target) {
      return htmlResponse(errorPage(origin, 400, '无法解析目标地址，请检查链接格式'), 400);
    }
    if (!isAllowedHost(target.host, extraHosts)) {
      return htmlResponse(
        errorPage(origin, 403, `暂不支持代理该主机：<code>${escapeHtml(target.host)}</code>`),
        403
      );
    }

    const method = request.method.toUpperCase();
    const cacheable =
      method === 'GET' &&
      isCacheableHost(target.hostname, extraHosts) &&
      !request.headers.has('authorization') &&
      !request.headers.has('cookie');

    // ---- 边缘缓存查询 ----
    if (cacheable) {
      try {
        const hit = await caches.default.match(request.url);
        if (hit) {
          const h = new Headers(hit.headers);
          h.set('x-proxy-cache', 'HIT');
          return new Response(hit.body, {
            status: hit.status,
            statusText: hit.statusText,
            headers: h,
          });
        }
      } catch {
        /* 缓存异常不影响主流程 */
      }
    }

    // ---- 请求上游 ----
    let upstream;
    try {
      upstream = await fetch(target.toString(), {
        method,
        headers: buildUpstreamHeaders(request),
        body: method === 'GET' || method === 'HEAD' ? undefined : request.body,
        redirect: 'manual',
      });
    } catch (err) {
      return htmlResponse(
        errorPage(origin, 502, `上游请求失败：${escapeHtml(String((err && err.message) || err))}`),
        502
      );
    }

    // ---- 重定向改写（codeload / objects.githubusercontent.com 等 302 都走这里）----
    if (upstream.status >= 300 && upstream.status < 400 && upstream.headers.has('location')) {
      const raw = upstream.headers.get('location');
      let location;
      try {
        const abs = new URL(raw, target.toString());
        location = isAllowedHost(abs.hostname, extraHosts)
          ? `${origin}/${abs.toString()}`
          : abs.toString();
      } catch {
        location = raw;
      }
      const headers = cleanHeaders(upstream.headers);
      headers.set('location', location);
      headers.set('x-proxy-cache', 'BYPASS');
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    }

    // ---- HTML / api.github.com JSON：改写正文中的链接 ----
    const contentType = upstream.headers.get('content-type') || '';
    const isHtml = /text\/html|application\/xhtml\+xml/i.test(contentType);
    const isApiJson = /json/i.test(contentType) && target.hostname === 'api.github.com';

    if (isHtml || isApiJson) {
      const text = await upstream.text();
      const headers = cleanHeaders(upstream.headers);
      headers.set('x-proxy-cache', 'BYPASS');
      return new Response(rewriteBody(text, origin), {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    }

    // ---- 其余内容：流式透传 ----
    const headers = cleanHeaders(upstream.headers);
    const cc = (headers.get('cache-control') || '').toLowerCase();
    const vary = (headers.get('vary') || '').toLowerCase();
    const blocked = /no-store|private|no-cache/.test(cc) || /cookie|authorization/.test(vary);

    let cacheStatus = 'BYPASS';
    if (cacheable && upstream.status === 200 && !headers.has('set-cookie') && !blocked) {
      if (!/max-age/.test(cc)) {
        headers.set('cache-control', 'public, max-age=86400');
      } else if (!/public/.test(cc)) {
        headers.set('cache-control', `${headers.get('cache-control')}, public`);
      }
      cacheStatus = 'MISS';
    }
    headers.set('x-proxy-cache', cacheStatus);

    const response = new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
    if (cacheStatus === 'MISS') {
      ctx.waitUntil(caches.default.put(request.url, response.clone()));
    }
    return response;
  },
};
