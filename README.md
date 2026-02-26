# 📚 Novel Site — 零成本私人小说站

[![Stars](https://img.shields.io/github/stars/xingzihai/novel-site?style=flat-square)](https://github.com/xingzihai/novel-site/stargazers)
[![License](https://img.shields.io/github/license/xingzihai/novel-site?style=flat-square)](LICENSE)
[![Deploy](https://img.shields.io/badge/deploy-Cloudflare%20Pages-orange?style=flat-square)](https://pages.cloudflare.com)

> Cloudflare Pages + D1 + R2 + Functions 全栈方案，全程不花一分钱

## ✨ 亮点速览

- 💰 **零成本** — 完全运行在 Cloudflare 免费套餐上，不需要服务器、域名、CDN
- ⚡ **5 分钟部署** — 克隆仓库后几条命令即可上线
- 📖 **功能完整** — 书架、阅读、搜索、书签、统计、批注互动、举报治理、TXT/EPUB 导入、GitHub OAuth、多管理员、标签分类、PWA 离线
- 🔐 **安全加固** — 五轮 Opus 级安全审计，评分 9.0/10，PBKDF2 + HttpOnly Cookie + CSRF 防护 + 乐观锁 + 文件魔数验证
- 🛠️ **纯原生** — 零框架依赖（无 React/Vue），纯 HTML/CSS/JS，改起来简单

## 🌐 在线演示

👉 [novel-site-6ba.pages.dev](https://novel-site-6ba.pages.dev)

支持 GitHub 登录体验 demo 管理员功能（GitHub 账号需创建满 7 天）。

## ✨ 功能特性

**阅读体验**
- 📱 响应式设计，手机/平板/电脑自适应
- 🎨 5 种主题（亮色/暗色/护眼绿/羊皮纸/淡蓝）
- 📖 两种阅读模式：滚动模式 + 翻页模式（点击/滑动翻页）
- 🧘 沉浸模式：隐藏所有 UI，专注阅读
- ⚙️ 阅读设置面板：字体族/字号/行距/页面宽度可调
- 🔖 书签功能：任意章节加书签，书籍详情页查看所有书签
- 📊 阅读统计：自动记录阅读时长、字数、天数
- ⌨️ 键盘快捷键：左右箭头翻页、T 切主题、F 全屏、S 设置
- ⚡ 预加载下一章，翻页瞬间加载
- 💾 阅读进度自动记忆，首页显示"继续阅读"
- 📶 PWA 离线阅读：安装到桌面，断网也能看已缓存的章节

**管理功能**
- 📥 TXT 智能导入（自动识别章节，支持预览编辑）
- 📦 EPUB 导入（解析目录结构，批量导入，支持选择性导入）
- 📤 TXT 导出（单章/整本）
- 🔍 书名/作者搜索 + 书内章节搜索（IP 级速率限制）
- ✅ 批量操作：章节多选、批量删除
- 📈 数据统计面板：站点 PV/UV、书籍阅读量、章节热度
- 💾 数据备份与恢复：一键导出/导入全站 JSON
- 🔤 自定义字体：上传 woff2 字体，阅读页可选用
- 🏷️ 标签分类：给书籍打标签，按标签筛选
- 🖼️ 封面管理：上传自定义封面图（JPEG/PNG/WebP，文件头魔数验证）

**权限系统**
- 👑 超级管理员（super_admin）：全部权限，管理用户/设置/字体
- 👤 管理员（admin）：管理所有书籍/章节/标签
- 🎭 演示管理员（demo）：只能管理自己创建的内容，10 本书 / 每本 200 章配额
- 🔑 GitHub OAuth 登录：一键注册 demo 账号（站内配置 Client ID/Secret）
- 🚪 Demo 自助注销：注销后内容自动转交超管保管

**批注系统**
- 💬 选中文字发表批注（公开/私有），浮动按钮触发
- 📝 批注编辑器：实时字数统计（500字上限）、Ctrl+Enter 发表、Esc 取消
- 📖 下划线渲染：有批注的句子显示彩色下划线，透明度随批注数递增
- ❤️ 点赞/取消点赞，最新/最热排序，长文折叠
- 🔒 禁言/封禁用户自动限制操作
- ⚡ 速率限制：每用户每分钟 10 条，同一句子最多 3 条

**举报与治理**
- 🚩 所有人可举报（含游客），Bigram Jaccard 相似度去重
- ⚖️ 社区投票机制：达到阈值后管理员/社区投票决定移除或保留
- 📊 积分系统：处理举报 +0.2、未处理 -1.0、投票贡献 +0.1
- 🔇 禁言递进：警告 → 1天 → 3天 → 7天 → 30天 → 永久封禁
- 🛡️ 角色保护：非超管不可处理超管批注

**安全与架构**
- 🔐 PBKDF2 密码哈希（100K 迭代 + 随机盐）+ 旧格式自动迁移
- 🍪 HttpOnly Cookie 认证（Secure + SameSite=Lax）+ Bearer fallback
- 🎫 Session Token 哈希存储 + 7 天过期 + 单用户最多 10 个会话
- 🛡️ CSRF 防护：管理 API 强制 Content-Type 检查
- 🔒 IP + 用户名双维度登录限流（5 次失败锁 10 分钟）
- 🔄 乐观锁：章节编辑并发冲突检测（version 字段）
- 📏 Demo 配额 TOCTOU 防护：INSERT 后二次检查
- 🛡️ CSP / HSTS / X-Frame-Options 等安全头
- 🔍 搜索 API IP 级速率限制（30 次/分钟）
- ⚙️ 站点个性化（站名、简介、页脚自定义）

## 🏗️ 技术架构

```
┌─────────────┐     ┌──────────────────┐     ┌─────────┐
│   浏览器     │────▶│  Cloudflare Pages │────▶│   D1    │
│  (前端页面)  │     │  (Functions API)  │     │ (元数据) │
└─────────────┘     └──────────────────┘     └─────────┘
                            │
                            ▼
                      ┌─────────┐
                      │   R2    │
                      │(章节内容)│
                      └─────────┘
```

- **Pages** — 托管前端静态文件（HTML/CSS/JS），自带全球 CDN
- **Functions** — 后端 API（认证、CRUD、中间件），文件路径即 URL 路由
- **D1** — SQLite 数据库，存储书籍/章节元数据、用户、会话、统计
- **R2** — 对象存储，存储章节正文、封面图、自定义字体

> 打个比方：D1 是图书馆的目录卡片（"《斗破苍穹》，天蚕土豆著，共1647章"），R2 是书架上的实体书（每一章的完整正文）。查书先翻目录（D1），再去书架取书（R2），各司其职。

## 🚀 快速部署（5 分钟）

### 前置条件

- [Node.js](https://nodejs.org/) 18+
- Cloudflare 账号（免费注册）
- R2 需绑定支付方式（PayPal 或外币信用卡，**不会扣费**，仅身份验证）

### 部署步骤

```bash
# 1. 克隆仓库
git clone https://github.com/xingzihai/novel-site.git
cd novel-site

# 2. 安装 Wrangler CLI
npm install -g wrangler
wrangler login

# 3. 创建 D1 数据库
wrangler d1 create novel-db
# 记下输出的 database_id，填入 wrangler.toml

# 4. 初始化数据库
wrangler d1 execute novel-db --file schema.sql --remote

# 5. 创建 R2 存储桶
wrangler r2 bucket create novel-storage

# 6. 修改 wrangler.toml
# 把 database_id 改为你的真实 ID

# 7. 部署
wrangler pages deploy .
```

首次访问 `/admin.html`，用 `admin` / 你设置的 `ADMIN_PASSWORD` 环境变量登录。

> 环境变量在 Cloudflare Dashboard → Pages → Settings → Environment variables 中设置。必须设置 `ADMIN_PASSWORD`。

### 可选：启用 GitHub OAuth 登录

1. 去 GitHub → Settings → Developer settings → OAuth Apps → New OAuth App
2. Authorization callback URL 填 `https://你的域名/api/auth/github/callback`
3. 登录管理后台 → 设置 → GitHub OAuth → 填入 Client ID 和 Client Secret → 启用
4. 推荐将 Client Secret 设为环境变量 `GITHUB_CLIENT_SECRET`（比存数据库更安全）

## 📖 深入了解

### 为什么用 D1 + R2 两个存储？

- **D1**（SQLite）擅长存结构化的小数据——书名、作者、章节标题、字数、创建时间。查询快，支持 SQL
- **R2**（对象存储）擅长存大块非结构化数据——小说正文动辄几千上万字，放数据库里既浪费又慢

读取章节时：先从 D1 查章节元数据（拿到 `content_key`），再用这个 key 去 R2 取正文。写入章节时反过来：先在 D1 插入记录拿到自增 ID，拼出 R2 路径，上传正文到 R2，最后回写 `content_key` 到 D1。任何一步失败都有回滚机制。

### 项目结构

```
novel-site/
├── index.html              # 首页（书架 + 阅读统计）
├── book.html               # 书籍详情（章节列表 + 书签）
├── read.html               # 阅读页面（滚动/翻页 + 沉浸模式）
├── admin.html              # 管理后台（统计 + EPUB导入 + 用户管理）
├── annotation-admin.html   # 批注管理（批注列表 + 举报管理 + 统计）
├── 404.html                # 404 页面
├── style.css               # 全局样式（5 主题 + 响应式）
├── sw.js                   # Service Worker（PWA 离线缓存）
├── manifest.json           # PWA 清单
├── schema.sql              # 数据库建表语句
├── wrangler.toml           # Cloudflare 配置
├── migrations/             # 数据库迁移脚本
│   ├── 001_stats_and_roles.sql    # 访问统计 + 多管理员角色
│   ├── 002_github_oauth.sql       # GitHub OAuth 字段
│   └── 003_chapter_version.sql    # 章节乐观锁版本号
└── functions/              # 后端 API
    ├── _middleware.js       # 公共中间件（安全头、CORS、CSRF、限流）
    └── api/
        ├── _utils.js       # 工具函数（认证、密码哈希、权限、OAuth）
        ├── auth.js         # 认证（登录/改密码/GitHub OAuth入口）
        ├── me.js           # 当前用户信息
        ├── books.js        # 书籍列表（公开）
        ├── search.js       # 搜索（IP 速率限制）
        ├── settings.js     # 站点设置（公开，白名单过滤）
        ├── fonts.js        # 自定义字体列表
        ├── tags.js         # 标签列表
        ├── annotations.js  # 批注（GET 列表 + POST 创建）
        ├── reports.js      # 举报提交（游客+登录用户）
        ├── auth/
        │   ├── github/
        │   │   └── callback.js # GitHub OAuth 回调
        │   └── logout.js  # 登出（清除 Cookie + Session）
        ├── books/
        │   └── [id].js     # 书籍详情 + 章节列表 + 标签
        ├── chapters/
        │   └── [id].js     # 章节内容（D1 元数据 + R2 正文）
        ├── covers/
        │   └── [id].js     # 封面图 serve
        ├── fonts/
        │   └── [name].js   # 字体文件 serve
        ├── annotations/
        │   ├── summary.js  # 章节批注聚合统计（渲染下划线）
        │   ├── [id].js     # 删除自己的批注
        │   └── [id]/
        │       └── like.js # 点赞/取消点赞
        └── admin/          # 管理 API（需登录）
            ├── account.js  # Demo 用户自助注销
            ├── books.js    # 创建书籍（含配额检查）
            ├── settings.js # 站点设置 + GitHub OAuth 配置
            ├── fonts.js    # 字体上传/删除（仅超管）
            ├── tags.js     # 标签管理（仅管理员+）
            ├── covers.js   # 封面上传（MIME白名单+魔数验证）
            ├── stats.js    # 访问统计
            ├── users.js    # 多管理员管理（仅超管）
            ├── book-tags.js # 书籍标签关联（含tag存在性验证）
            ├── books/
            │   └── [id].js # 编辑/删除书籍（含所有权检查）
            ├── chapters.js # 创建章节（含配额+R2回滚）
            ├── chapters/
            │   ├── [id].js # 编辑/删除章节（乐观锁+R2回滚+批注警告）
            │   └── swap.js # 章节排序（batch原子操作）
            ├── annotations.js    # 批注管理列表（权限过滤）
            ├── annotations/
            │   ├── [id].js       # 移除/恢复/永久删除批注
            │   ├── batch.js      # 批量操作（最多100条）
            │   └── stats.js      # 批注统计
            ├── reports.js        # 举报列表（权限过滤）
            ├── reports/
            │   └── [id].js       # 处理举报（移除/保留+自动处罚）
            └── votes.js          # 社区投票
```

> `functions/` 目录是 Pages Functions 的约定——文件路径即 URL 路由。`functions/api/books.js` → `/api/books`，`functions/api/books/[id].js` → `/api/books/123`。以 `_` 开头的文件不会成为路由。

### 数据库设计

完整建表语句见 `schema.sql`，核心表：

| 表 | 用途 |
|---|---|
| `books` | 书籍元数据（标题、作者、封面key、所有者） |
| `chapters` | 章节元数据（标题、排序、字数、R2路径、version乐观锁） |
| `admin_users` | 管理员账号（PBKDF2哈希、角色、GitHub OAuth信息） |
| `admin_sessions` | 登录会话（token SHA-256哈希，7天过期） |
| `tags` / `book_tags` | 标签系统 |
| `site_settings` | 站点配置 + GitHub OAuth配置 |
| `auth_attempts` | 登录限流（IP哈希 + 失败计数） |
| `annotations` | 批注（章节定位 + 内容 + 可见性 + 状态） |
| `annotation_likes` | 批注点赞（用户唯一约束） |
| `reports` | 举报记录（举报人 + 理由 + 状态 + 阈值检测） |
| `votes` | 社区投票（每人每批注一票） |
| `score_logs` | 积分变动日志 |
| `mutes` | 禁言/封锁/封禁记录 |
| `site_visits` / `daily_visitors` | 站点 PV/UV 统计 |
| `book_stats` / `chapter_stats` | 阅读量统计 |

关键设计决策：

- **D1 + R2 分工**：章节正文存 R2，元数据存 D1。`content_key` 字段指向 R2 路径
- **密码不存明文**：PBKDF2（100K 迭代 + 16 字节随机盐），旧格式登录时自动迁移
- **Token 哈希存储**：数据库只存 SHA-256 哈希，明文只在登录响应中出现一次
- **IP 以哈希存储**：`auth_attempts` 中的 IP 用 SHA-256 哈希，不存原始 IP
- **先 DB 后 R2**：写入时先插 D1 拿 ID → 上传 R2 → 回写 content_key。任何一步失败都回滚
- **乐观锁**：章节编辑携带 version 字段，并发修改返回 409 Conflict

### 安全设计

本项目经过五轮 Opus 级安全审计（抗攻击 / 内容安全 / 账号安全 / 批注安全 / 全链路模拟攻击），评分 9.0/10。

**中间件（`_middleware.js`）**

| 防护 | 说明 |
|---|---|
| CSRF | 管理 API 写操作强制 `Content-Type: application/json` 或 `multipart/form-data` |
| CORS | 公开 API 允许跨域，管理 API 不返回 CORS 头（仅同源） |
| 请求大小 | 超过 10MB 直接拒绝（HTTP 413） |
| 安全头 | CSP、HSTS、X-Frame-Options、nosniff、Referrer-Policy、Permissions-Policy |
| 统计清理 | book_stats 90 天自动清理，daily_visitors 7 天清理 |

**认证与权限**

| 机制 | 说明 |
|---|---|
| 密码哈希 | PBKDF2-SHA256，100K 迭代，16 字节盐，恒定时间比较 |
| 登录限流 | IP + 用户名双维度，5 次失败锁 10 分钟，fail-closed |
| Session | 32 字节随机 token，DB 存 SHA-256 哈希，7 天过期 |
| Cookie 认证 | HttpOnly + Secure + SameSite=Lax，Bearer header 作为 fallback |
| 三级权限 | super_admin > admin > demo，所有 API 后端校验 |
| 所有权检查 | demo 只能操作自己创建的书籍/章节/封面/批注 |
| 批注限流 | 每用户每分钟 10 条，同一句子最多 3 条 |
| 举报限流 | 登录用户 20 次/小时，游客 3 次/小时（IP 限流） |
| 禁言/封禁 | 封禁用户不可发批注/点赞/举报，禁言用户不可发公开批注 |
| GitHub OAuth | HMAC 签名 state + cookie 绑定 + DB 一次性消费 + 10 分钟过期 |

**数据一致性**

| 场景 | 防护 |
|---|---|
| 创建章节 | R2 失败回滚 DB，content_key 更新失败回滚 DB+R2 |
| 编辑章节 | 先更新 DB 再写 R2，DB 失败可回滚；乐观锁防并发覆盖 |
| 删除书籍 | DB.batch() 原子删除所有关联数据 |
| 封面上传 | 先写 R2 再更新 DB，DB 失败清理 R2 |
| 标签操作 | DB.batch() 原子操作 |
| 用户删除 | DB.batch() 原子转移书籍所有权 + 清理会话 + 删除用户 |
| Demo 配额 | INSERT 后二次检查防 TOCTOU 竞态 |

**输入验证**

| 检查 | 说明 |
|---|---|
| ID 验证 | 最多 18 位正整数，防 INTEGER 溢出 |
| 封面上传 | MIME 白名单（JPEG/PNG/WebP）+ 文件头魔数验证 |
| 搜索 | 查询长度限制 50 字符 + IP 速率限制 30 次/分钟 |
| 用户名 | 字母数字下划线，2-32 位，禁止 `gh_` 前缀（保留给 OAuth） |
| avatar_url | 只允许 `https://avatars.githubusercontent.com/` 域名 |
| HTML 转义 | `esc()` 函数转义 `<>&"'`，正文用 `textContent` 渲染 |

## 📊 Cloudflare 免费额度

| 服务 | 免费额度 | 小说站实际用量 | 够用吗 |
|------|---------|--------------|--------|
| Pages 请求 | 无限 | 随便用 | ✅ |
| Functions 请求 | 10 万次/天 | 每次翻页 1 次，日读 1000 页才 1000 次 | ✅ |
| D1 读取 | 500 万次/天 | 每个 API 调 1-3 次查询 | ✅ |
| D1 写入 | 10 万次/天 | 只有管理员添加章节才写 | ✅ |
| D1 存储 | 5GB | 纯文本元数据，1 万本书用不到 100MB | ✅ |
| R2 存储 | 10GB | 一本 50 万字约 1MB，能存 1 万本 | ✅ |
| R2 读取 | 1000 万次/月 | 每次阅读读 1 次 R2 | ✅ |
| R2 写入 | 100 万次/月 | 只有添加章节才写 | ✅ |

> 个人使用完全够用。除非日活过万，否则免费额度根本用不完。

## 🛠️ 本地开发

```bash
wrangler pages dev . --port 3355 \
  --d1 DB=<your-database-id> \
  --r2 R2=novel-storage \
  --binding ADMIN_PASSWORD=your_password
```

本地开发服务器模拟完整的 Pages + Functions + D1 + R2 环境。本地数据与云端隔离。

### 数据库迁移

从早期版本升级时，按顺序执行迁移脚本：

```bash
wrangler d1 execute novel-db --file migrations/001_stats_and_roles.sql --remote
wrangler d1 execute novel-db --file migrations/002_github_oauth.sql --remote
wrangler d1 execute novel-db --file migrations/003_chapter_version.sql --remote
```

新部署不需要手动执行迁移，`schema.sql` 已包含所有表结构，且后端 `ensureSchema` 会自动补齐缺失字段。

## 📝 使用说明

1. 访问 `/admin.html` 登录管理后台
2. 创建书籍（填写书名、作者、简介）
3. 添加章节（手动输入、TXT 导入或 EPUB 导入）
4. 访问首页查看书架，点击阅读

### TXT 导入

支持自动识别章节标题：`第一章`、`第1章`、`Chapter 1`、`序章`、`楔子`、`番外` 等。支持 UTF-8、GBK、UTF-16 编码自动检测。导入前可预览和编辑。

### EPUB 导入

解析 EPUB 文件的目录结构，自动提取章节标题和内容。支持：
- 创建新书并导入 / 导入到已有书籍
- 选择性导入（勾选需要的章节）
- 编辑章节标题
- 并发上传（3 路并发）
- 全部失败时自动删除空书
- Zip bomb 防护（100MB 解压上限 + 5000 章上限）

### 数据备份

管理后台支持一键导出全站数据为 JSON 文件，包含所有书籍、章节、设置。可在新站点一键导入恢复。

## 📈 Star History

[![Star History Chart](https://api.star-history.com/svg?repos=xingzihai/novel-site&type=Date)](https://star-history.com/#xingzihai/novel-site&Date)

## 📄 License

[AGPL-3.0](LICENSE)

## 🤝 致谢与贡献

欢迎提 [Issue](https://github.com/xingzihai/novel-site/issues) 和 [Pull Request](https://github.com/xingzihai/novel-site/pulls)！
