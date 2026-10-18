import http from 'node:http';

/**
 * 本地 mock GitHub 上游，用于 wrangler dev 联调（无需外网）。
 * 覆盖三类关键场景：
 *   1. HTML 页面（含绝对 URL / 协议相对 URL / 相对路径 / 外部主机 / 误匹配域名）
 *   2. 相对 Location 的 302 重定向（模拟 archive -> codeload 跳转）
 *   3. 可缓存静态内容（模拟 raw / release 资产）
 */
export function startMock(port) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, `http://127.0.0.1:${port}`);

    if (u.pathname === '/user/repo') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><body>
        <a href="https://github.com/user/repo/archive/main.tar.gz">zip</a>
        <img src="//github.githubassets.com/images/logo.png">
        <a href="/relative/path">rel</a>
        <a href="https://example.com/external">ext</a>
        <a href="https://github.commercial.com">lookalike</a>
      </body></html>`);
      return;
    }

    if (u.pathname === '/user/repo/archive/main.tar.gz') {
      // 相对 Location：验证是否按目标 URL 正确解析并改写
      res.writeHead(302, { location: '/codeload/user/repo/tar.gz/main' });
      res.end();
      return;
    }

    if (u.pathname === '/codeload/user/repo/tar.gz/main') {
      res.writeHead(200, {
        'content-type': 'application/x-gzip',
        'cache-control': 'public, max-age=600',
      });
      res.end('FAKE-TARGZ');
      return;
    }

    if (u.pathname === '/setcookie') {
      res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'a=b' });
      res.end('cookie');
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
