# 批注系统 v2 — 实施指南

> 配合 `annotation-v2-design.md` 使用。本文档是给开发者（子 agent）的实操手册。

---

## 现有代码关键事实

| 文件 | 行数 | 关键点 |
|------|------|--------|
| `read.html` | 874 | 阅读页，`contentDiv.textContent = data.content` 纯文本渲染，无 `<p>` 标签 |
| `style.css` | 781 | CSS 变量体系，5 主题，翻页模式用 CSS multi-column |
| `admin.html` | 2117 | 管理后台，`saveAuth/clearAuth` 认证，`api()` 封装 |
| `_utils.js` | 381 | `checkAdmin()` 返回 `{ok, userId, username, role}`，`ensureSchema()` 自动迁移 |
| `schema.sql` | — | 基础表定义，迁移在 `_utils.js` 的 `ensureSchema()` 中 |

### 认证机制
- token 存储：`localStorage.auth_token` 或 `sessionStorage.auth_token`（remember me 控制）
- API 调用：`Authorization: Bearer <token>`
- `checkAdmin()` 返回：`{ ok, userId, username, role, passwordLocked }`
- read.html 当前**无认证逻辑**，需要新增

### 内容渲染（关键改造点）
```javascript
// 当前：纯文本，一整块
contentDiv.textContent = data.content;

// 需要改为：按段落渲染为 <p> 标签（批注系统依赖段落索引）
const paragraphs = data.content.split('\n');
paragraphs.forEach((text, idx) => {
  if (!text.trim()) return; // 跳过空行
  const p = document.createElement('p');
  p.textContent = text;
  p.dataset.paraIdx = idx;
  contentDiv.appendChild(p);
});
```

> ⚠️ 这是最关键的改造。`para_idx` 必须与原始 `\n` 分割的索引一致，包括空行的索引也要保留（用 `dataset.paraIdx` 记录原始索引），否则批注定位会错乱。

### 翻页模式兼容
- 翻页用 CSS `column-width` + `translateX` 实现
- 改为 `<p>` 渲染后，`pagerRecalc()` 不需要改动（它只读 `scrollWidth`）
- 但 `<p>` 的 margin 会影响分页计算，需要确保 CSS 一致

---

## Phase 1：批注发表

### Step 1.1 — 数据库迁移

**文件：** `_utils.js` 的 `ensureSchema()` 中新增

```javascript
// === 批注系统 v2 ===
// annotations 表
try {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS annotations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chapter_id INTEGER NOT NULL,
    book_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    para_idx INTEGER NOT NULL,
    sent_idx INTEGER NOT NULL,
    sent_hash TEXT NOT NULL,
    sent_text TEXT NOT NULL,
    content TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'public',
    status TEXT NOT NULL DEFAULT 'normal',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE,
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES admin_users(id)
  )`).run();
} catch {}
try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_anno_chapter ON annotations(chapter_id, para_idx, sent_idx)').run(); } catch {}
try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_anno_book ON annotations(book_id, status)').run(); } catch {}
try { await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_anno_user ON annotations(user_id, created_at)').run(); } catch {}

// books 新字段
try { await env.DB.prepare('ALTER TABLE books ADD COLUMN annotation_enabled INTEGER NOT NULL DEFAULT 0').run(); } catch {}
try { await env.DB.prepare('ALTER TABLE books ADD COLUMN annotation_locked INTEGER NOT NULL DEFAULT 0').run(); } catch {}
```

**注意：** 不要创建 `migrations/0004_annotations.sql`，所有迁移统一在 `ensureSchema()` 中，保持现有模式一致。

### Step 1.2 — 后端 API

#### 文件清单

| 文件 | 方法 | 说明 |
|------|------|------|
| `functions/api/annotations.js` | GET, POST | 查询某句批注列表 + 发表批注 |
| `functions/api/annotations/summary.js` | GET | 章节批注聚合（渲染下划线用） |
| `functions/api/annotations/[id].js` | DELETE | 删除自己的批注 |

#### GET /api/annotations/summary

**参数：** `chapterId`（必填）
**认证：** 可选（有 token 则返回私有批注信息，无 token 只返回公开）
**响应：**
```json
{
  "sentences": [
    { "para_idx": 0, "sent_idx": 2, "sent_hash": "a1b2c3d4", "public_count": 3, "private_count": 1, "has_mine": true }
  ]
}
```

**SQL 核心：**
```sql
SELECT para_idx, sent_idx, sent_hash,
  COUNT(CASE WHEN visibility='public' AND status='normal' THEN 1 END) as public_count,
  COUNT(CASE WHEN visibility='private' AND status='normal' AND user_id=? THEN 1 END) as private_count,
  MAX(CASE WHEN user_id=? THEN 1 ELSE 0 END) as has_mine
FROM annotations
WHERE chapter_id = ? AND status IN ('normal', 'reported')
GROUP BY para_idx, sent_idx, sent_hash
HAVING public_count > 0 OR private_count > 0
```

未登录时 `user_id` 绑定为 -1（不会匹配任何用户）。

#### GET /api/annotations

**参数：** `chapterId`, `paraIdx`, `sentIdx`
**认证：** 可选
**逻辑：**
- 未登录：只返回 `visibility='public'` 的批注
- 已登录：返回公开 + 自己的私有
- 每条批注附加 `is_mine` 字段（前端用于显示删除/举报按钮）
- 不返回 `user_id`，只返回 `username`

#### POST /api/annotations

**认证：** 必须（demo+）
**Body：**
```json
{
  "chapterId": 5,
  "bookId": 1,
  "paraIdx": 3,
  "sentIdx": 1,
  "sentHash": "a1b2c3d4",
  "sentText": "他望着远方的山峦。",
  "content": "这段描写太美了",
  "visibility": "public"
}
```

**校验清单：**
- [ ] 用户未被禁言（`muted_until IS NULL OR muted_until < now()`）
- [ ] 用户未被封禁（`banned_at IS NULL`）
- [ ] 书籍存在且 `annotation_enabled = 1` 且 `annotation_locked = 0`
- [ ] 章节属于该书籍
- [ ] content 长度 1-500
- [ ] visibility 只能是 'public' 或 'private'
- [ ] sentHash 格式：`/^[0-9a-f]{8}$/`
- [ ] demo 用户每章批注上限（从 site_settings 读取，默认 200）
- [ ] 防重复：同一用户同一句子同一内容不允许重复提交

#### DELETE /api/annotations/:id

**认证：** 必须
**逻辑：** 只能删除自己的批注（`WHERE id = ? AND user_id = ?`）

### Step 1.3 — 前端改造（read.html）

按顺序执行以下改造：

#### 1.3.1 内容段落化渲染

**位置：** `contentDiv.textContent = data.content;` 这一行

替换为按 `\n` 分割渲染 `<p>` 标签。空行保留索引但不创建 DOM 元素。

```javascript
// 替换 contentDiv.textContent = data.content;
const rawParagraphs = data.content.split('\n');
rawParagraphs.forEach((text, idx) => {
  if (!text.trim()) return;
  const p = document.createElement('p');
  p.textContent = text;
  p.dataset.paraIdx = idx; // 保留原始索引（含空行跳过）
  contentDiv.appendChild(p);
});
```

> ⚠️ 改完后必须验证：滚动模式和翻页模式都正常显示，段落间距合理。

#### 1.3.2 认证状态获取

在 read.html 的 `<script>` 开头添加：

```javascript
// 获取登录状态（复用 admin.html 的 token）
const authToken = localStorage.getItem('auth_token') || sessionStorage.getItem('auth_token') || '';
let currentUser = null; // { userId, username, role }

async function fetchCurrentUser() {
  if (!authToken) return;
  try {
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken },
      body: JSON.stringify({ action: 'verify' })
    });
    if (res.ok) {
      const data = await res.json();
      currentUser = { userId: data.userId, username: data.username, role: data.role };
    }
  } catch {}
}
```

> 注意：需要确认 `/api/auth` 是否支持 verify action，如果不支持需要新增一个轻量的 `/api/me` 端点。

#### 1.3.3 句子分割工具函数

添加 `splitSentences()` 和 `snapToSentence()` — 直接从设计文档复制。

#### 1.3.4 右键菜单（PC）+ 浮动按钮（移动端）

**PC 端：** 监听 `contextmenu` 事件，有选区时拦截并显示自定义菜单。
**移动端：** 监听 `selectionchange`，选区变化时在选区上方显示浮动按钮。

**菜单消失：** 点击外部 / 滚动 / Escape / 翻页。

#### 1.3.5 批注输入框

PC 用 popover（`position: fixed`，锚定选区附近），移动端用底部抽屉（`@media max-width: 768px`）。

包含：原文引用 + textarea + 私有/公开切换 + 取消/发表按钮。

#### 1.3.6 下划线渲染

章节加载完成后，调用 `/api/annotations/summary` 获取聚合数据，遍历结果：
1. 找到对应的 `<p>` 元素（通过 `dataset.paraIdx`）
2. 在段落内找到对应句子的文本范围
3. 用 `Range.surroundContents()` 包裹 `<span class="annotated">`
4. 设置 CSS 类（`private-only` / `has-public` / `has-both`）和 `--anno-opacity` 变量

> ⚠️ `surroundContents` 在翻页模式下可能有问题（column 布局中 Range 跨列）。需要测试。如果有问题，改用预处理方式：在创建 `<p>` 时就把句子拆成 `<span>`。

#### 1.3.7 点击查看批注

点击带下划线的 `<span>` → 调用 `/api/annotations` 获取该句批注列表 → 显示 popover。

#### 1.3.8 发表流程

右键菜单点击「批注」→ 打开输入框 → 填写内容 → 选择公开/私有 → 点击发表 → POST `/api/annotations` → 成功后刷新该句下划线。

### Step 1.4 — admin.html 改造

#### 书籍编辑弹窗增加「允许批注」开关

在书籍编辑弹窗中添加 checkbox：

```html
<label style="display:flex;align-items:center;gap:8px;margin-top:8px">
  <input type="checkbox" id="edit-annotation-enabled">
  允许读者批注
</label>
```

对应后端：`PUT /api/admin/books/:id` 接受 `annotation_enabled` 字段。

### Step 1.5 — style.css 新增样式

新增批注相关样式（约 80-100 行）：
- `.annotated` 系列（下划线、hover、暗色模式）
- `.ctx-menu` + `.ctx-item`（右键菜单）
- `.anno-editor` 系列（输入框、底部抽屉）
- `.anno-popover` 系列（查看批注弹窗）
- `.anno-float-btn`（移动端浮动按钮）

---

## Phase 2：批注管理

### Step 2.1 — 后端 API

| 文件 | 说明 |
|------|------|
| `functions/api/admin/annotations.js` | GET 列表（筛选+分页）+ 统计 |
| `functions/api/admin/annotations/[id].js` | PATCH 改状态 + DELETE 永久删除 |
| `functions/api/admin/annotations/batch.js` | POST 批量操作 |

所有端点使用 `buildPermissionFilter(auth)` 统一权限过滤。

### Step 2.2 — annotation-admin.html

独立页面，约 400-600 行。复用 admin.html 的：
- CSS 变量和组件样式（通过 `<link rel="stylesheet" href="/style.css">`）
- 认证逻辑（`auth_token` 读取 + `api()` 封装）
- 按钮/表单/卡片组件类名

### Step 2.3 — admin.html 入口

侧边栏新增「📝 批注管理」按钮，`onclick="window.open('annotation-admin.html')"`.

---

## Phase 3：举报与治理

### Step 3.1 — 数据库迁移

`ensureSchema()` 新增：reports、votes、score_logs、mutes 四张表 + admin_users 新字段。

### Step 3.2 — 后端 API

| 文件 | 说明 |
|------|------|
| `functions/api/reports.js` | POST 提交举报（含游客） |
| `functions/api/admin/reports.js` | GET 待处理举报列表 |
| `functions/api/admin/reports/[id].js` | PATCH 处理举报 |
| `functions/api/admin/votes.js` | POST 提交投票 |
| `functions/api/admin/scores.js` | GET 积分排行 |

### Step 3.3 — 前端

- read.html：批注 popover 中添加「举报」按钮 + 举报弹窗
- annotation-admin.html：新增「待处理举报」tab + 投票界面
- admin.html 设置页：举报参数配置（x/y/z/n）

---

## 开发规范

### 子 agent 任务拆分原则

每个子 agent 任务应该：
1. **明确列出要创建/修改的文件**（不超过 3-4 个）
2. **提供完整的上下文**（相关文件的关键代码片段）
3. **包含验收标准**（API 返回什么、前端表现什么）
4. **包含相关教训**（从 lessons.md 提取）

### 推荐的子 agent 拆分

| 任务 | 模型 | 文件 | 预计行数 |
|------|------|------|---------|
| P1-DB: 数据库迁移 + books 新字段 | sonnet | `_utils.js`, `admin/books/[id].js` | ~40 |
| P1-API: 批注 CRUD 三个端点 | sonnet | 3 个新 JS 文件 | ~250 |
| P1-FE-1: read.html 段落化 + 认证 + 句子工具 | sonnet | `read.html` | ~80 |
| P1-FE-2: read.html 右键菜单 + 输入框 + 发表 | sonnet | `read.html`, `style.css` | ~250 |
| P1-FE-3: read.html 下划线渲染 + 查看批注 | sonnet | `read.html`, `style.css` | ~150 |
| P1-ADMIN: admin.html 批注开关 | sonnet | `admin.html` | ~30 |
| P1-AUDIT: 安全审计 | opus | 全部新代码 | — |

### 关键教训（从 lessons.md）

- **`fetch()` vs `api()`**：read.html 新增的 API 调用如果需要认证，必须手动加 `Authorization` header（read.html 没有 admin.html 的 `api()` 封装）
- **`textContent` vs `innerHTML`**：用户输入必须用 `textContent` 或 `escHtml()` 渲染，绝不能 `innerHTML`
- **D1 CPU 限制**：summary API 的聚合 SQL 要高效，避免全表扫描，必须走 `idx_anno_chapter` 索引
- **翻页模式兼容**：任何 DOM 改动后如果在翻页模式下，需要调用 `pagerRecalc()`
- **wrangler deploy**：commit message 必须用英文

### 测试检查清单

每个 Phase 完成后验证：

**Phase 1：**
- [ ] 滚动模式：段落正常显示，间距合理
- [ ] 翻页模式：分页正常，页码准确
- [ ] PC 右键菜单：选中文本后右键显示菜单，无选区时走默认右键
- [ ] 移动端：选中文本后浮动按钮出现
- [ ] 批注发表：私有/公开切换正常，发表成功后下划线出现
- [ ] 下划线颜色：私有黄色、公开蓝色、混合蓝色+黄点
- [ ] 下划线浓度：1人淡、多人深
- [ ] 点击下划线：弹出批注列表
- [ ] 删除自己的批注：下划线消失
- [ ] 游客视角：只看到公开批注下划线，无发表按钮
- [ ] 未开启批注的书籍：无右键菜单、无下划线
- [ ] admin.html：书籍编辑弹窗有「允许批注」开关
- [ ] 暗色模式：下划线颜色适配
