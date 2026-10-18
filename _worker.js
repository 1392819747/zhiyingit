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
<title>GitHub 加速 · Cloudflare 边缘加速</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    min-height: 100vh; overflow-x: hidden;
    background: #070b14; color: #e6edf3;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  }
  .bg { position: fixed; inset: 0; z-index: -1; overflow: hidden; }
  .blob { position: absolute; border-radius: 50%; filter: blur(90px); will-change: transform; }
  .b1 { width: 46vw; height: 46vw; opacity: .5; background: radial-gradient(circle, #1f6feb, transparent 65%); top: -12%; left: -8%; }
  .b2 { width: 40vw; height: 40vw; opacity: .5; background: radial-gradient(circle, #a371f7, transparent 65%); bottom: -14%; right: -6%; }
  .b3 { width: 26vw; height: 26vw; opacity: .26; background: radial-gradient(circle, #3fb950, transparent 65%); top: 32%; right: 24%; }
  .grid-bg {
    position: absolute; inset: 0;
    background-image: linear-gradient(rgba(88,166,255,.06) 1px, transparent 1px),
      linear-gradient(90deg, rgba(88,166,255,.06) 1px, transparent 1px);
    background-size: 44px 44px;
    -webkit-mask-image: radial-gradient(ellipse 80% 60% at 50% 38%, #000 30%, transparent 75%);
    mask-image: radial-gradient(ellipse 80% 60% at 50% 38%, #000 30%, transparent 75%);
  }
  main { width: min(980px, 92vw); margin: 0 auto; padding: 72px 0 48px; }
  .hero { display: grid; grid-template-columns: 1.2fr .8fr; gap: 32px; align-items: center; }
  .badge {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 6px 14px; border-radius: 999px; font-size: 13px; color: #8ecbff;
    background: rgba(56,139,253,.12); border: 1px solid rgba(56,139,253,.35);
  }
  .badge .dot { width: 8px; height: 8px; border-radius: 50%; background: #3fb950; box-shadow: 0 0 10px #3fb950; animation: pulse 1.8s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
  h1 { margin: 22px 0 14px; font-size: clamp(38px, 6vw, 60px); line-height: 1.08; font-weight: 800; letter-spacing: -1px; }
  h1 .grad { background: linear-gradient(90deg, #58a6ff, #a371f7 60%, #f778ba); -webkit-background-clip: text; background-clip: text; color: transparent; }
  h1 .char { display: inline-block; will-change: transform, opacity; }
  .sub { color: #9da7b3; font-size: 16px; line-height: 1.8; max-width: 46ch; }
  .sub b { color: #e6edf3; font-weight: 600; }
  form {
    display: flex; gap: 10px; margin-top: 28px; padding: 6px; border-radius: 14px;
    background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.1);
    backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
    transition: border-color .25s, box-shadow .25s;
  }
  form:focus-within { border-color: rgba(88,166,255,.6); box-shadow: 0 0 0 4px rgba(88,166,255,.12); }
  input {
    flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: #e6edf3;
    padding: 12px; font-size: 14.5px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  input::placeholder { color: #6e7681; }
  button.go {
    border: 0; cursor: pointer; white-space: nowrap; border-radius: 10px; padding: 12px 22px;
    font-size: 14.5px; font-weight: 700; color: #06121f;
    background: linear-gradient(90deg, #58a6ff, #a371f7);
    transition: transform .15s, filter .2s;
  }
  button.go:hover { filter: brightness(1.12); }
  button.go:active { transform: scale(.96); }
  .domain { margin-top: 14px; font-size: 13px; color: #6e7681; }
  .domain code { color: #8ecbff; font-family: ui-monospace, Menlo, Consolas, monospace; }
  .hero-art { height: 260px; display: flex; align-items: center; justify-content: center; }
  #lottie { width: 260px; height: 260px; }
  .section-title { margin: 56px 0 16px; font-size: 14px; color: #9da7b3; font-weight: 600; letter-spacing: 3px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; }
  .card {
    position: relative; padding: 18px; border-radius: 14px; overflow: hidden;
    background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.09);
    transition: transform .2s, border-color .25s, background .25s;
  }
  .card:hover { transform: translateY(-4px); border-color: rgba(88,166,255,.45); background: rgba(88,166,255,.06); }
  .card h3 { font-size: 14px; color: #e6edf3; margin-bottom: 10px; display: flex; align-items: center; gap: 8px; }
  .card code {
    display: block; font-size: 12px; color: #79c0ff; word-break: break-all; line-height: 1.7;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  .copy {
    position: absolute; top: 12px; right: 12px; cursor: pointer;
    border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.06);
    color: #9da7b3; font-size: 12px; padding: 5px 10px; border-radius: 8px; transition: .2s;
  }
  .copy:hover { color: #e6edf3; border-color: rgba(88,166,255,.5); }
  .copy.ok { color: #3fb950; border-color: rgba(63,185,80,.5); }
  .tip {
    margin-top: 34px; padding: 18px 20px; border-radius: 14px; font-size: 13.5px; line-height: 2;
    color: #9da7b3; background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.09);
  }
  .tip code {
    background: rgba(88,166,255,.12); color: #79c0ff; padding: 2px 8px; border-radius: 6px;
    word-break: break-all; font-size: 12.5px;
    font-family: ui-monospace, Menlo, Consolas, monospace;
  }
  footer { margin-top: 44px; text-align: center; color: #565f6b; font-size: 12.5px; }
  @media (max-width: 820px) {
    main { padding-top: 48px; }
    .hero { grid-template-columns: 1fr; }
    .hero-art { order: -1; height: 180px; }
    #lottie { width: 180px; height: 180px; }
  }
</style>
</head>
<body>
<div class="bg">
  <div class="blob b1"></div>
  <div class="blob b2"></div>
  <div class="blob b3"></div>
  <div class="grid-bg"></div>
</div>
<main>
  <div class="hero">
    <div>
      <span class="badge"><span class="dot"></span>Cloudflare 全球边缘网络<span id="ping"></span></span>
      <h1><span class="ttl">GitHub</span> <span class="ttl grad">加速站</span></h1>
      <p class="sub">粘贴任意 GitHub 链接，即刻加速 <b>网页浏览</b>、<b>Raw 文件</b>、<b>Release 下载</b> 与 <b>git clone</b>，无需客户端、无需代理。</p>
      <form id="f">
        <input id="u" type="text" placeholder="https://github.com/user/repo" autocomplete="off" spellcheck="false" />
        <button class="go" type="submit">加速前往 &rarr;</button>
      </form>
      <p class="domain">当前加速域名：<code id="d"></code></p>
    </div>
    <div class="hero-art"><div id="lottie"></div></div>
  </div>
  <p class="section-title">使 用 范 例</p>
  <div class="cards">
    <div class="card"><button class="copy" data-t="c1">复制</button><h3>&#128230; 仓库 / 网页</h3><code id="c1"></code></div>
    <div class="card"><button class="copy" data-t="c2">复制</button><h3>&#128196; Raw 文件</h3><code id="c2"></code></div>
    <div class="card"><button class="copy" data-t="c3">复制</button><h3>&#11015;&#65039; Release 下载</h3><code id="c3"></code></div>
    <div class="card"><button class="copy" data-t="c4">复制</button><h3>&#128187; git clone</h3><code id="c4"></code></div>
  </div>
  <p class="tip">
    让 git 全局走加速（只需配一次）：<br>
    <code>git config --global url."https://你的域名/https://github.com/".insteadOf "https://github.com/"</code><br>
    之后执行 <code>git clone https://github.com/user/repo.git</code> 会自动改走本加速站。
  </p>
  <footer>Powered by Cloudflare Pages &middot; GitHub 加速 &middot; 仅供学习交流</footer>
</main>
<script>
  var origin = location.origin;
  document.getElementById('d').textContent = origin;

  var ex = {
    c1: origin + '/https://github.com/user/repo',
    c2: origin + '/https://raw.githubusercontent.com/user/repo/main/README.md',
    c3: origin + '/https://github.com/user/repo/releases/download/v1.0.0/app.zip',
    c4: 'git clone ' + origin + '/https://github.com/user/repo.git'
  };
  Object.keys(ex).forEach(function (k) { document.getElementById(k).textContent = ex[k]; });

  document.getElementById('f').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = document.getElementById('u').value.trim();
    if (!v) {
      if (window.gsap) gsap.fromTo('#f', { x: -8 }, { x: 0, duration: .5, ease: 'elastic.out(1,0.3)' });
      return;
    }
    if (v.toLowerCase().indexOf(origin.toLowerCase() + '/') === 0) v = v.slice(origin.length + 1);
    if (!/^https?:\\/\\//i.test(v)) v = 'https://' + v;
    document.querySelector('button.go').textContent = '加速中…';
    location.href = origin + '/' + v;
  });

  Array.prototype.forEach.call(document.querySelectorAll('.copy'), function (btn) {
    btn.addEventListener('click', function () {
      var t = document.getElementById(btn.getAttribute('data-t')).textContent;
      function done() {
        btn.textContent = '✓ 已复制'; btn.classList.add('ok');
        setTimeout(function () { btn.textContent = '复制'; btn.classList.remove('ok'); }, 1600);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t).then(done, done);
      } else {
        var ta = document.createElement('textarea');
        ta.value = t; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); } catch (err) { /* 忽略 */ }
        ta.remove(); done();
      }
    });
  });

  // 简易延迟探测：连打 3 次 /healthz 取平均
  (function () {
    var el = document.getElementById('ping');
    var times = [], n = 0;
    function once() {
      var t0 = performance.now();
      fetch(origin + '/healthz', { cache: 'no-store' }).then(function () {
        times.push(performance.now() - t0);
        if (++n < 3) { once(); return; }
        var avg = Math.round(times.reduce(function (a, b) { return a + b; }, 0) / times.length);
        el.textContent = ' · 延迟 ' + avg + 'ms';
      }).catch(function () { /* 网络异常时保持静默 */ });
    }
    once();
  })();

  // ===== 动效层：GSAP 入场/背景漂浮/视差 + Lottie 轨道动画 =====
  // 多 CDN 依次回退；全部不可用时静默降级，页面功能完全不受影响
  var FX = {
    gsap: [
      'https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js',
      'https://unpkg.com/gsap@3.12.5/dist/gsap.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js'
    ],
    lottie: [
      'https://cdn.jsdelivr.net/npm/lottie-web@5.12.2/build/player/lottie.min.js',
      'https://unpkg.com/lottie-web@5.12.2/build/player/lottie.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/lottie-web/5.12.2/lottie.min.js'
    ]
  };

  // Lottie 数据内联（不依赖外部 JSON），240 帧 = 4 秒无缝循环
  var LOTTIE_DATA = {"v":"5.7.4","fr":60,"ip":0,"op":240,"w":240,"h":240,"nm":"accel-orbit","ddd":0,"assets":[],"layers":[
    {"ddd":0,"ind":1,"ty":4,"nm":"ring-outer","sr":1,"ks":{"o":{"a":0,"k":100},"r":{"a":1,"k":[{"i":{"x":[0.667],"y":[0.667]},"o":{"x":[0.333],"y":[0.333]},"t":0,"s":[0]},{"t":240,"s":[360]}]},"p":{"a":0,"k":[120,120,0]},"a":{"a":0,"k":[0,0,0]},"s":{"a":0,"k":[100,100,100]}},"ao":0,"shapes":[{"ty":"gr","it":[{"ty":"el","p":{"a":0,"k":[0,0]},"s":{"a":0,"k":[196,196]}},{"ty":"st","c":{"a":0,"k":[0.345,0.651,1,1]},"o":{"a":0,"k":45},"w":{"a":0,"k":2},"lc":2,"lj":2,"d":[{"n":"d","nm":"dash","v":{"a":0,"k":6}},{"n":"g","nm":"gap","v":{"a":0,"k":12}}]},{"ty":"tr","p":{"a":0,"k":[0,0]},"a":{"a":0,"k":[0,0]},"s":{"a":0,"k":[100,100]},"r":{"a":0,"k":0},"o":{"a":0,"k":100}}]}],"ip":0,"op":240,"st":0,"bm":0},
    {"ddd":0,"ind":2,"ty":4,"nm":"ring-inner","sr":1,"ks":{"o":{"a":0,"k":100},"r":{"a":1,"k":[{"i":{"x":[0.667],"y":[0.667]},"o":{"x":[0.333],"y":[0.333]},"t":0,"s":[360]},{"t":240,"s":[0]}]},"p":{"a":0,"k":[120,120,0]},"a":{"a":0,"k":[0,0,0]},"s":{"a":0,"k":[100,100,100]}},"ao":0,"shapes":[{"ty":"gr","it":[{"ty":"el","p":{"a":0,"k":[0,0]},"s":{"a":0,"k":[130,130]}},{"ty":"st","c":{"a":0,"k":[0.639,0.443,0.969,1]},"o":{"a":0,"k":30},"w":{"a":0,"k":2},"lc":2,"lj":2,"d":[{"n":"d","nm":"dash","v":{"a":0,"k":3}},{"n":"g","nm":"gap","v":{"a":0,"k":10}}]},{"ty":"tr","p":{"a":0,"k":[0,0]},"a":{"a":0,"k":[0,0]},"s":{"a":0,"k":[100,100]},"r":{"a":0,"k":0},"o":{"a":0,"k":100}}]}],"ip":0,"op":240,"st":0,"bm":0},
    {"ddd":0,"ind":3,"ty":4,"nm":"dot-blue","sr":1,"ks":{"o":{"a":0,"k":100},"r":{"a":1,"k":[{"i":{"x":[0.667],"y":[0.667]},"o":{"x":[0.333],"y":[0.333]},"t":0,"s":[0]},{"t":240,"s":[360]}]},"p":{"a":0,"k":[120,120,0]},"a":{"a":0,"k":[0,0,0]},"s":{"a":0,"k":[100,100,100]}},"ao":0,"shapes":[{"ty":"gr","it":[{"ty":"el","p":{"a":0,"k":[98,0]},"s":{"a":0,"k":[36,36]}},{"ty":"fl","c":{"a":0,"k":[0.345,0.651,1,1]},"o":{"a":0,"k":18}},{"ty":"tr","p":{"a":0,"k":[0,0]},"a":{"a":0,"k":[0,0]},"s":{"a":0,"k":[100,100]},"r":{"a":0,"k":0},"o":{"a":0,"k":100}}]},{"ty":"gr","it":[{"ty":"el","p":{"a":0,"k":[98,0]},"s":{"a":0,"k":[16,16]}},{"ty":"fl","c":{"a":0,"k":[0.345,0.651,1,1]},"o":{"a":0,"k":100}},{"ty":"tr","p":{"a":0,"k":[0,0]},"a":{"a":0,"k":[0,0]},"s":{"a":0,"k":[100,100]},"r":{"a":0,"k":0},"o":{"a":0,"k":100}}]}],"ip":0,"op":240,"st":0,"bm":0},
    {"ddd":0,"ind":4,"ty":4,"nm":"dot-purple","sr":1,"ks":{"o":{"a":0,"k":100},"r":{"a":1,"k":[{"i":{"x":[0.667],"y":[0.667]},"o":{"x":[0.333],"y":[0.333]},"t":0,"s":[360]},{"t":240,"s":[0]}]},"p":{"a":0,"k":[120,120,0]},"a":{"a":0,"k":[0,0,0]},"s":{"a":0,"k":[100,100,100]}},"ao":0,"shapes":[{"ty":"gr","it":[{"ty":"el","p":{"a":0,"k":[65,0]},"s":{"a":0,"k":[12,12]}},{"ty":"fl","c":{"a":0,"k":[0.639,0.443,0.969,1]},"o":{"a":0,"k":100}},{"ty":"tr","p":{"a":0,"k":[0,0]},"a":{"a":0,"k":[0,0]},"s":{"a":0,"k":[100,100]},"r":{"a":0,"k":0},"o":{"a":0,"k":100}}]}],"ip":0,"op":240,"st":0,"bm":0},
    {"ddd":0,"ind":5,"ty":4,"nm":"core","sr":1,"ks":{"o":{"a":0,"k":100},"r":{"a":0,"k":0},"p":{"a":0,"k":[120,120,0]},"a":{"a":0,"k":[0,0,0]},"s":{"a":1,"k":[{"i":{"x":[0.42],"y":[0]},"o":{"x":[0.58],"y":[1]},"t":0,"s":[100,100,100]},{"i":{"x":[0.42],"y":[0]},"o":{"x":[0.58],"y":[1]},"t":120,"s":[116,116,116]},{"t":240,"s":[100,100,100]}]}},"ao":0,"shapes":[{"ty":"gr","it":[{"ty":"el","p":{"a":0,"k":[0,0]},"s":{"a":0,"k":[72,72]}},{"ty":"fl","c":{"a":0,"k":[0.247,0.729,0.314,1]},"o":{"a":0,"k":14}},{"ty":"tr","p":{"a":0,"k":[0,0]},"a":{"a":0,"k":[0,0]},"s":{"a":0,"k":[100,100]},"r":{"a":0,"k":0},"o":{"a":0,"k":100}}]},{"ty":"gr","it":[{"ty":"el","p":{"a":0,"k":[0,0]},"s":{"a":0,"k":[40,40]}},{"ty":"fl","c":{"a":0,"k":[0.247,0.729,0.314,1]},"o":{"a":0,"k":100}},{"ty":"tr","p":{"a":0,"k":[0,0]},"a":{"a":0,"k":[0,0]},"s":{"a":0,"k":[100,100]},"r":{"a":0,"k":0},"o":{"a":0,"k":100}}]},{"ty":"gr","it":[{"ty":"el","p":{"a":0,"k":[0,0]},"s":{"a":0,"k":[16,16]}},{"ty":"fl","c":{"a":0,"k":[1,1,1,1]},"o":{"a":0,"k":92}},{"ty":"tr","p":{"a":0,"k":[0,0]},"a":{"a":0,"k":[0,0]},"s":{"a":0,"k":[100,100]},"r":{"a":0,"k":0},"o":{"a":0,"k":100}}]}],"ip":0,"op":240,"st":0,"bm":0}
  ]};

  var lottieBox = document.getElementById('lottie');
  function fallbackArt() {
    lottieBox.innerHTML = '<svg viewBox="0 0 240 240" width="100%" height="100%" fill="none">' +
      '<circle cx="120" cy="120" r="98" stroke="#58a6ff" stroke-opacity=".45" stroke-width="2" stroke-dasharray="6 12"/>' +
      '<circle cx="120" cy="120" r="65" stroke="#a371f7" stroke-opacity=".3" stroke-width="2" stroke-dasharray="3 10"/>' +
      '<circle cx="120" cy="120" r="20" fill="#3fb950"/><circle cx="120" cy="120" r="8" fill="#fff" fill-opacity=".9"/>' +
      '<circle cx="218" cy="120" r="8" fill="#58a6ff"/><circle cx="55" cy="120" r="6" fill="#a371f7"/></svg>';
  }
  function initArt() {
    if (window.lottie) {
      try {
        lottie.loadAnimation({ container: lottieBox, renderer: 'svg', loop: true, autoplay: true, animationData: LOTTIE_DATA });
        return;
      } catch (err) { /* 落到静态兜底 */ }
    }
    fallbackArt();
  }

  function initMotion() {
    if (!window.gsap) return;
    Array.prototype.forEach.call(document.querySelectorAll('h1 .ttl'), function (el) {
      // 渐变字不拆字：.grad 的 background-clip:text 无法被子 span 继承，拆开会导致文字透明
      if (el.classList.contains('grad')) return;
      el.innerHTML = el.textContent.split('').map(function (c) { return '<span class="char">' + c + '</span>'; }).join('');
    });
    var tl = gsap.timeline({ defaults: { ease: 'power3.out' } });
    tl.from('.badge', { y: 18, opacity: 0, duration: .6 })
      .from('h1 .ttl:not(.grad) .char', { y: 40, opacity: 0, rotateX: -50, stagger: .045, duration: .7 }, '-=0.3')
      .from('h1 .grad', { x: 30, opacity: 0, duration: .7 }, '-=0.55')
      .from('.sub', { y: 20, opacity: 0, duration: .6 }, '-=0.4')
      .from('#f', { y: 20, opacity: 0, duration: .6 }, '-=0.35')
      .from('.domain', { opacity: 0, duration: .5 }, '-=0.3')
      .from('.hero-art', { scale: .8, opacity: 0, duration: .9, ease: 'back.out(1.6)' }, '-=0.7')
      .from('.section-title', { y: 16, opacity: 0, duration: .5 }, '-=0.4')
      .from('.card', { y: 26, opacity: 0, stagger: .09, duration: .6 }, '-=0.3')
      .from('.tip', { y: 16, opacity: 0, duration: .5 }, '-=0.3')
      .from('footer', { opacity: 0, duration: .5 }, '-=0.3');

    gsap.to('.b1', { x: 60, y: 40, duration: 9, repeat: -1, yoyo: true, ease: 'sine.inOut' });
    gsap.to('.b2', { x: -70, y: -50, duration: 11, repeat: -1, yoyo: true, ease: 'sine.inOut' });
    gsap.to('.b3', { x: 40, y: -60, duration: 13, repeat: -1, yoyo: true, ease: 'sine.inOut' });

    var bx = gsap.quickTo('.bg', 'x', { duration: 1.4, ease: 'power3.out' });
    var by = gsap.quickTo('.bg', 'y', { duration: 1.4, ease: 'power3.out' });
    window.addEventListener('mousemove', function (e) {
      bx((e.clientX / window.innerWidth - .5) * 24);
      by((e.clientY / window.innerHeight - .5) * 24);
    });
  }

  // 依次尝试 CDN 列表，第一个加载成功即停
  function loadAny(list, done) {
    var i = 0;
    (function next() {
      if (i >= list.length) { done(false); return; }
      var s = document.createElement('script');
      s.src = list[i++];
      s.onload = function () { done(true); };
      s.onerror = function () { if (s.parentNode) s.parentNode.removeChild(s); next(); };
      document.head.appendChild(s);
    })();
  }

  loadAny(FX.lottie, function () { initArt(); });
  loadAny(FX.gsap, function () { initMotion(); });
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
    // vary 里的 Authorization 不阻断缓存：cacheable 已排除带 authorization/cookie 的请求，
    // 且缓存键只按 URL —— 匿名请求的响应变体唯一，缓存安全（如 raw.githubusercontent.com）
    const blocked = /no-store|private|no-cache/.test(cc) || /cookie/.test(vary);

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
