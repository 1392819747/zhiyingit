import assert from 'node:assert/strict';
import { parseTargetUrl, rewriteBody, isAllowedHost, normalizeUserInput } from './worker.js';

// ---------- parseTargetUrl ----------
let t = parseTargetUrl('/https://github.com/torvalds/linux', '');
assert.equal(t.toString(), 'https://github.com/torvalds/linux');
assert.equal(t.hostname, 'github.com');

t = parseTargetUrl('/raw.githubusercontent.com/u/r/main/a.js', '');
assert.equal(t.toString(), 'https://raw.githubusercontent.com/u/r/main/a.js');

t = parseTargetUrl('/github.com/u/r', '?tab=readme');
assert.equal(t.search, '?tab=readme');

t = parseTargetUrl('/https://gist.github.com/u/abc', '');
assert.equal(t.hostname, 'gist.github.com');

t = parseTargetUrl('/http://127.0.0.1:8788/x/y', '');
assert.equal(t.protocol, 'http:');
assert.equal(t.host, '127.0.0.1:8788');

// 路径大小写保留
t = parseTargetUrl('/https://raw.githubusercontent.com/U/R/main/README.MD', '');
assert.equal(t.pathname, '/U/R/main/README.MD');

assert.equal(parseTargetUrl('/https://bad host/x'), null);
assert.equal(parseTargetUrl('/', ''), null);
assert.equal(parseTargetUrl('', ''), null);

// ---------- isAllowedHost ----------
assert.ok(isAllowedHost('github.com'));
assert.ok(isAllowedHost('www.github.com'));
assert.ok(isAllowedHost('raw.githubusercontent.com'));
assert.ok(isAllowedHost('codeload.github.com'));
assert.ok(isAllowedHost('objects.githubusercontent.com'));
assert.ok(isAllowedHost('release-assets.githubusercontent.com'));
assert.ok(isAllowedHost('user.github.io'));
assert.ok(isAllowedHost('github.githubassets.com'));
assert.ok(isAllowedHost('api.github.com'));
assert.ok(isAllowedHost('127.0.0.1:8788', ['127.0.0.1']));

assert.ok(!isAllowedHost('example.com'));
assert.ok(!isAllowedHost('evil-github.com'));
assert.ok(!isAllowedHost('github.com.evil.com'));
assert.ok(!isAllowedHost('github.commercial.com'));
assert.ok(!isAllowedHost('notgithub.io'));
assert.ok(!isAllowedHost('127.0.0.1'));

// ---------- rewriteBody ----------
const origin = 'https://gh.example.com';
assert.equal(
  rewriteBody('<a href="https://github.com/u/r">x</a>', origin),
  '<a href="https://gh.example.com/https://github.com/u/r">x</a>'
);
assert.equal(
  rewriteBody('<img src="//avatars.githubusercontent.com/u/1">', origin),
  '<img src="https://gh.example.com/https://avatars.githubusercontent.com/u/1">'
);
assert.equal(
  rewriteBody('https://github.com/a //gist.github.com/b https://github.com/c', origin),
  'https://gh.example.com/https://github.com/a https://gh.example.com/https://gist.github.com/b https://gh.example.com/https://github.com/c'
);
assert.equal(
  rewriteBody('http://github.com/a', origin),
  'https://gh.example.com/http://github.com/a'
);
// 外部主机、相对路径、误匹配域名一律不动
assert.equal(rewriteBody('https://example.com/x', origin), 'https://example.com/x');
assert.equal(rewriteBody('href="/relative/path"', origin), 'href="/relative/path"');
assert.equal(rewriteBody('https://github.commercial.com', origin), 'https://github.commercial.com');
assert.equal(
  rewriteBody('https://github.githubassets.com/a.js', origin),
  'https://gh.example.com/https://github.githubassets.com/a.js'
);
assert.equal(rewriteBody('', origin), '');

// ---------- normalizeUserInput ----------
assert.equal(normalizeUserInput('github.com/u/r', origin), 'https://github.com/u/r');
assert.equal(normalizeUserInput('https://github.com/u/r', origin), 'https://github.com/u/r');
assert.equal(
  normalizeUserInput('https://gh.example.com/https://github.com/u/r', origin),
  'https://github.com/u/r'
);
assert.equal(normalizeUserInput('   ', origin), '');

console.log('✅ 单元测试全部通过');
