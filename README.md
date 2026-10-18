# GitHub 加速站（Cloudflare Pages）

把 GitHub 的网页、Raw 文件、Release 下载、git clone 流量代理到 Cloudflare 全球边缘网络，缓解国内访问 GitHub 慢/丢包的问题。单文件 `_worker.js`，零依赖，免费额度即可日用。

## 功能

- **全站网页代理**：自动改写 HTML 里的 GitHub 链接，站内导航不跳出代理
- **Raw / Gist 文件**：`raw.githubusercontent.com`、`gist.githubusercontent.com`
- **Release 下载**：自动跟随并改写 `codeload.github.com` / `objects.githubusercontent.com` 的 302 跳转
- **git clone / pull**：完整支持 smart HTTP 协议
- **api.github.com**：JSON 响应同样改写链接
- **边缘缓存**：raw、静态资源、下载资产自动缓存（尊重上游 Cache-Control，默认 24h）
- **安全边界**：仅放行 GitHub 相关域名，外部重定向原样透传不劫持

## 快速部署

### 方式 A：Pages 连接 GitHub 仓库（当前使用，推荐）

仓库根目录的 `_worker.js` 会被 Cloudflare Pages 识别为 Pages Function（高级模式），接管全部路由：

1. 把本目录推到 GitHub 仓库的 main 分支
2. Cloudflare → **Workers & Pages** → **Create** → **Pages** → **Connect to Git** → 授权 GitHub → 选择该仓库
3. **构建命令留空、输出目录留空** → **Save and Deploy**
4. 访问 `https://<项目名>.pages.dev/` 即可使用
5. 之后每次 `git push` 到 main 分支都会自动重新部署

> 💡 选 Pages 而不是 Worker 的原因：`*.pages.dev` 域名在国内网络的可达性明显好于 `*.workers.dev`（后者常被 DNS 污染）。
> ⚠️ 仓库根目录**不要放 `wrangler.toml`**——Cloudflare 检测到它就会按 Worker 部署，拿到的是 workers.dev 域名。

### 方式 B：Pages 直接上传 zip（零工具，最快）

上传只含 `_worker.js` 一个文件的 zip：

1. **Workers & Pages** → **Create** → **Pages** → **Upload assets**
2. 项目名随意 → **Create project** → 上传 zip → **Deploy site**

> ⚠️ 上传的 zip **只放 `_worker.js`**：含 `wrangler.toml` / `package.json` 会被判定为"需要构建的项目"而拒绝；`_routes.json` 已被上传程序弃用，且并无必要（`_worker.js` 默认接管全部路由）。

### 方式 C：Workers 控制台粘贴（备用）

1. **Workers & Pages** → **Create** → **Create Worker** → 名字随意 → **Deploy**
2. 点 **Edit code** → 全选删除 → 粘贴 `_worker.js` **全文** → **Deploy**
3. 得到 `*.workers.dev` 域名（国内访问不稳定，仅作备用）

### 绑定自定义域名（可选）

Pages 项目 → **Custom domains** → 添加如 `gh.example.com`（免费版即可，国内访问最稳）。

## 使用方法

把 `<域名>` 替换为你的 `*.pages.dev` 域名或自定义域名：

| 场景 | 地址 |
| --- | --- |
| 仓库网页 | `https://<域名>/https://github.com/user/repo` |
| Raw 文件 | `https://<域名>/https://raw.githubusercontent.com/user/repo/main/file.js` |
| Release 下载 | `https://<域名>/https://github.com/user/repo/releases/download/v1.0/app.zip` |
| Gist | `https://<域名>/https://gist.githubusercontent.com/user/xxx/raw/abc` |
| git clone | `git clone https://<域名>/https://github.com/user/repo.git` |

也支持省略 scheme 的简写：`https://<域名>/github.com/user/repo`。

**git 全局加速**（配一次，之后 clone 自动走代理）：

```bash
git config --global url."https://<域名>/https://github.com/".insteadOf "https://github.com/"
```

## 本地开发与测试

```bash
npm test           # 单元测试：路径解析 / 主机白名单 / URL 改写
npm run test:e2e   # 端到端：wrangler dev + 本地 mock 上游，验证改写/重定向/缓存/403
```

端到端测试会自动生成临时 `wrangler.dev.toml`（跑完删除），不影响仓库结构。

## 注意事项

- **额度**：Cloudflare 免费版 10 万次请求/天；免费版单次调用 CPU 限制 10ms，日常个人使用足够，多人共用建议升级 Pro（$5/月）
- **私有仓库**：clone 私有仓库时，Git 凭证会经 Cloudflare 边缘转发到 GitHub（与 gh-proxy 等公共服务相同机制）。自建可控，如仍不放心可加 Cloudflare Access 或自定义鉴权头
- **大文件**：下载为流式透传，不受 100MB 响应体限制
- **域名选择**：优先 `*.pages.dev` 或自有域名；`*.workers.dev` 国内 DNS 污染严重，不建议日常使用

## 文件说明

| 文件 | 说明 |
| --- | --- |
| `_worker.js` | 主代码（Pages Function / Worker 入口，部署只需这一个文件） |
| `test.mjs` | 单元测试 |
| `test-e2e.mjs` + `mock-upstream.mjs` | 端到端联调（wrangler dev + mock 上游） |
| `package.json` | npm 脚本与依赖 |
