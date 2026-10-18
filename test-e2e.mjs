import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { startMock } from './mock-upstream.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PORT = 8787;
const MOCK_PORT = 8788;
const ORIGIN = `http://127.0.0.1:${WORKER_PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
// 仓库根目录不放 wrangler.toml（避免 Cloudflare Git 集成把项目识别为 Worker），
// 本地联调时动态生成一份临时配置，跑完即删
const DEV_CONFIG = path.join(HERE, 'wrangler.dev.toml');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForReady(timeoutMs = 120000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await fetch(`${ORIGIN}/healthz`);
      if (r.status === 200) return;
    } catch {
      /* 还没起来 */
    }
    await sleep(500);
  }
  throw new Error('wrangler dev 启动超时');
}

async function main() {
  const mock = await startMock(MOCK_PORT);
  console.log(`mock upstream ready on ${MOCK}`);

  fs.writeFileSync(
    DEV_CONFIG,
    [
      'name = "github-proxy-dev"',
      'main = "_worker.js"',
      'compatibility_date = "2025-10-01"',
      '',
      '[vars]',
      '# 本地联调用：允许代理本机 mock 上游',
      'EXTRA_HOSTS = "127.0.0.1"',
      '',
    ].join('\n')
  );

  const npx = path.join(path.dirname(process.execPath), 'npx');
  const wrangler = spawn(
    npx,
    ['--yes', 'wrangler@4', 'dev', '-c', 'wrangler.dev.toml', '--ip', '127.0.0.1', '--port', String(WORKER_PORT)],
    { cwd: HERE, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let log = '';
  wrangler.stdout.on('data', (d) => { log += d; });
  wrangler.stderr.on('data', (d) => { log += d; });

  try {
    await waitForReady();
    console.log(`worker ready on ${ORIGIN}`);

    // 1) 首页
    const home = await fetch(`${ORIGIN}/`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /GitHub 加速/);
    console.log('✓ 首页可访问');

    // 2) ?url= 快捷跳转
    const jump = await fetch(`${ORIGIN}/?url=${encodeURIComponent('https://github.com/u/r')}`, {
      redirect: 'manual',
    });
    assert.equal(jump.status, 302);
    assert.equal(jump.headers.get('location'), `${ORIGIN}/https://github.com/u/r`);
    console.log('✓ ?url= 跳转正确');

    // 3) HTML 正文改写
    const html = await (await fetch(`${ORIGIN}/http://127.0.0.1:${MOCK_PORT}/user/repo`)).text();
    assert.ok(html.includes(`${ORIGIN}/https://github.com/user/repo/archive/main.tar.gz`), '绝对 URL 应改写');
    assert.ok(html.includes(`${ORIGIN}/https://github.githubassets.com/images/logo.png`), '协议相对 URL 应改写');
    assert.ok(html.includes('href="/relative/path"'), '相对路径不应改写');
    assert.ok(html.includes('https://example.com/external'), '外部主机不应改写');
    assert.ok(html.includes('https://github.commercial.com'), '撞车域名不应改写');
    console.log('✓ HTML 链接改写正确（绝对/协议相对改写，相对/外部/撞车域名不动）');

    // 4) 相对 Location 302 改写
    const r302 = await fetch(`${ORIGIN}/http://127.0.0.1:${MOCK_PORT}/user/repo/archive/main.tar.gz`, {
      redirect: 'manual',
    });
    assert.equal(r302.status, 302);
    assert.equal(
      r302.headers.get('location'),
      `${ORIGIN}/http://127.0.0.1:${MOCK_PORT}/codeload/user/repo/tar.gz/main`
    );
    console.log('✓ 重定向 Location 改写正确');

    // 5) 透传 + 缓存 MISS -> HIT
    const url = `${ORIGIN}/http://127.0.0.1:${MOCK_PORT}/codeload/user/repo/tar.gz/main`;
    const r1 = await fetch(url);
    assert.equal(r1.status, 200);
    assert.equal(await r1.text(), 'FAKE-TARGZ');
    assert.equal(r1.headers.get('x-proxy-cache'), 'MISS');
    const r2 = await fetch(url);
    assert.equal(r2.headers.get('x-proxy-cache'), 'HIT');
    console.log('✓ 内容透传 + 边缘缓存 MISS/HIT 正常');

    // 6) 非白名单主机 403
    const r403 = await fetch(`${ORIGIN}/http://example.com/`);
    assert.equal(r403.status, 403);
    console.log('✓ 非白名单主机返回 403');

    console.log('\n✅ 端到端测试全部通过');
  } finally {
    wrangler.kill('SIGTERM');
    mock.close();
    fs.rmSync(DEV_CONFIG, { force: true });
    if (process.env.E2E_DEBUG) console.log(log);
  }
}

main().catch((err) => {
  console.error('❌ E2E 失败:', err.message);
  process.exit(1);
});
