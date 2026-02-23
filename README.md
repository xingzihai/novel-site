# 📚 Novel Site — 零成本私人小说站

> Cloudflare Pages + D1 + R2 + Functions 全栈方案，全程不花一分钱

一个完全运行在 Cloudflare 免费套餐上的私人小说阅读站。纯 HTML/CSS/JS，无框架依赖，部署简单，适合个人使用。

📖 **详细教程**：[零成本！用 Cloudflare 四件套搭建你的私人小说站](https://linux.do/t/topic/1638705)
🌐 **在线演示**：[novel-site-6ba.pages.dev](https://novel-site-6ba.pages.dev)

## ✨ 功能特性

- 📱 响应式设计，手机/平板/电脑自适应
- 🌙 暗色模式，跟随系统或手动切换
- 🔤 三档字号调节，阅读更舒适
- 📖 沉浸式阅读布局，章节间快速导航
- 📥 TXT 智能导入（自动识别章节标题，支持 UTF-8/GBK/UTF-16 编码）
- 📤 TXT 导出（单章/整本，Windows 兼容 BOM）
- 🔐 安全认证（PBKDF2 + Session 哈希存储 + IP 限流）
- ⚙️ 站点个性化（站名、简介、页脚自定义）
- 🔍 SEO 友好（Open Graph 元标签）

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

- **Pages**：托管前端静态文件（HTML/CSS/JS）
- **Functions**：后端 API（认证、CRUD、中间件）
- **D1**：SQLite 数据库，存储书籍/章节元数据、用户、会话
- **R2**：对象存储，存储章节正文内容

## 🚀 一键部署

### 前置条件

- [Node.js](https://nodejs.org/) 18+
- [Cloudflare 账号](https://dash.cloudflare.com/sign-up)（免费）
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)

### 自动部署

```bash
git clone https://github.com/xingzihai/novel-site.git
cd novel-site
chmod +x setup.sh
./setup.sh
```

脚本会自动完成：创建 D1 数据库 → 创建 R2 存储桶 → 初始化数据表 → 设置管理员密码 → 部署到 Cloudflare Pages

### 手动部署

```bash
# 1. 安装 Wrangler
npm install -g wrangler

# 2. 登录 Cloudflare
wrangler login

# 3. 创建 D1 数据库
wrangler d1 create novel-db
# 记下输出的 database_id，填入 wrangler.toml

# 4. 创建 R2 存储桶
wrangler r2 bucket create novel-storage

# 5. 初始化数据表
wrangler d1 execute novel-db --file schema.sql --remote

# 6. 设置管理员密码
wrangler pages secret put ADMIN_PASSWORD
# 输入你的密码（至少8位，包含字母和数字）

# 7. 部署
wrangler pages deploy .
```

## 📁 项目结构

```
novel-site/
├── index.html              # 首页（书架）
├── book.html               # 书籍详情（章节列表）
├── read.html               # 阅读页面
├── admin.html              # 管理后台
├── 404.html                # 404 页面
├── style.css               # 全局样式
├── schema.sql              # 数据库建表语句
├── wrangler.toml           # Cloudflare 配置
├── setup.sh                # 一键部署脚本
└── functions/              # 后端 API
    ├── _middleware.js       # 公共中间件（安全头、CORS、错误处理）
    └── api/
        ├── _utils.js       # 工具函数（认证、密码、校验）
        ├── auth.js         # 认证 API（登录/登出/改密码）
        ├── books.js        # 公开：书籍列表
        ├── settings.js     # 公开：站点设置
        ├── books/
        │   └── [id].js     # 公开：书籍详情+章节列表
        ├── chapters/
        │   └── [id].js     # 公开：章节内容
        └── admin/
            ├── books.js    # 管理：创建书籍
            ├── settings.js # 管理：站点设置
            ├── books/
            │   └── [id].js # 管理：编辑/删除书籍
            ├── chapters.js # 管理：创建章节
            └── chapters/
                ├── [id].js # 管理：编辑/删除章节
                └── swap.js # 管理：章节排序
```

## 🔐 安全特性

- **密码存储**：PBKDF2（100,000 迭代 + 16 字节随机盐）
- **会话管理**：32 字节 CSPRNG Token，数据库只存 SHA-256 哈希
- **IP 保护**：登录 IP 以 SHA-256 哈希存储，5 次失败锁定 10 分钟
- **安全头**：CSP、HSTS、X-Frame-Options、nosniff、Referrer-Policy
- **CORS**：管理 API 不返回 CORS 头（仅同源访问）
- **输入校验**：前后端双重验证，参数化 SQL 查询

## 📊 Cloudflare 免费额度

| 服务 | 免费额度 | 本项目用量 |
|------|---------|-----------|
| Pages | 无限站点，500 次构建/月 | 1 站点 |
| Functions | 10 万次请求/天 | 远低于限制 |
| D1 | 5GB 存储，500 万行读/天 | 极少 |
| R2 | 10GB 存储，1000 万次读/月 | 取决于小说数量 |

> 个人使用完全够用，即使存几百本小说也不会超出免费额度。

## 🛠️ 本地开发

```bash
# 创建本地 D1 和 R2（自动）
wrangler pages dev . --port 3355 \
  --d1 DB=<your-database-id> \
  --r2 R2=novel-storage \
  --binding ADMIN_PASSWORD=your_password
```

首次访问 `/admin.html`，用 `admin` / 你设置的密码登录。

## 📝 使用说明

1. 访问 `/admin.html` 登录管理后台
2. 创建书籍（填写书名、作者、简介）
3. 添加章节（手动输入或 TXT 导入）
4. 访问首页查看书架，点击阅读

### TXT 导入

支持自动识别章节标题：
- `第一章`、`第1章`、`Chapter 1`、`Part I`
- `序章`、`楔子`、`番外`、`终章`、`大结局` 等
- 支持 UTF-8、GBK、UTF-16 编码自动检测

## 📄 License

AGPL-3.0
