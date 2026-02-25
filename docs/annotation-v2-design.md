# 批注系统 v2 — 完整设计文档

> 基于三轮 opus 子 agent 调研整合，覆盖发表、管理、举报三大模块。
> 项目：novel-site | 技术栈：CF Pages + Functions + D1 + R2 | 纯 HTML/CSS/JS

---

## 目录

1. [数据库设计](#1-数据库设计)
2. [批注发表](#2-批注发表)
3. [批注管理](#3-批注管理)
4. [批注举报与社区治理](#4-批注举报与社区治理)
5. [API 端点总览](#5-api-端点总览)
6. [配置参数](#6-配置参数)
7. [实施计划](#7-实施计划)

---

## 1. 数据库设计

### 1.1 新增表

#### annotations — 批注主表

```sql
CREATE TABLE IF NOT EXISTS annotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chapter_id INTEGER NOT NULL,
  book_id INTEGER NOT NULL,              -- 冗余，加速按书筛选
  user_id INTEGER NOT NULL,
  para_idx INTEGER NOT NULL,             -- 段落索引（从0开始）
  sent_idx INTEGER NOT NULL,             -- 段落内句子索引
  sent_hash TEXT NOT NULL,               -- 句子内容 SHA-256 前8位hex
  sent_text TEXT NOT NULL,               -- 句子原文（用于失效检测和模糊匹配）
  content TEXT NOT NULL,                 -- 批注内容（1-500字）
  visibility TEXT NOT NULL DEFAULT 'public',  -- 'public' | 'private'
  status TEXT NOT NULL DEFAULT 'normal',      -- 'normal' | 'reported' | 'removed' | 'hidden'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (chapter_id) REFERENCES chapters(id) ON DELETE CASCADE,
  FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES admin_users(id)
);

CREATE INDEX IF NOT EXISTS idx_anno_chapter ON annotations(chapter_id, para_idx, sent_idx);
CREATE INDEX IF NOT EXISTS idx_anno_book ON annotations(book_id, status);
CREATE INDEX IF NOT EXISTS idx_anno_user ON annotations(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_anno_status ON annotations(status) WHERE status != 'normal';
```

#### reports — 举报表

```sql
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  annotation_id INTEGER NOT NULL,
  book_id INTEGER NOT NULL,              -- 冗余，加速查询
  reporter_id INTEGER,                   -- 举报人用户ID（游客为NULL）
  reporter_guest_hash TEXT,              -- 游客：IP hash（SHA-256前16位）
  reason TEXT NOT NULL,                  -- 举报理由（≥10汉字或单词）
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'escalated' | 'resolved'
  handler_id INTEGER,                    -- 处理人ID
  handler_action TEXT,                   -- 'remove' | 'keep' | 'warning'
  threshold_reached_at TEXT,             -- 达到x人阈值的时间
  escalated_at TEXT,                     -- 升级到社区投票的时间
  handled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (annotation_id) REFERENCES annotations(id) ON DELETE CASCADE,
  FOREIGN KEY (reporter_id) REFERENCES admin_users(id)
);

CREATE INDEX IF NOT EXISTS idx_reports_annotation ON reports(annotation_id, status);
CREATE INDEX IF NOT EXISTS idx_reports_book ON reports(book_id, status);
CREATE INDEX IF NOT EXISTS idx_reports_pending ON reports(status, threshold_reached_at)
  WHERE status IN ('pending', 'escalated');
CREATE INDEX IF NOT EXISTS idx_reports_reporter ON reports(reporter_id, annotation_id);
CREATE INDEX IF NOT EXISTS idx_reports_guest ON reports(reporter_guest_hash, annotation_id);
```

#### votes — 社区投票表

```sql
CREATE TABLE IF NOT EXISTS votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  annotation_id INTEGER NOT NULL,
  admin_id INTEGER NOT NULL,
  action TEXT NOT NULL,                  -- 'remove' | 'keep'
  reason TEXT,                           -- 可选投票理由
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(annotation_id, admin_id),
  FOREIGN KEY (annotation_id) REFERENCES annotations(id) ON DELETE CASCADE,
  FOREIGN KEY (admin_id) REFERENCES admin_users(id)
);

CREATE INDEX IF NOT EXISTS idx_votes_annotation ON votes(annotation_id);
```

#### score_logs — 积分变动日志

```sql
CREATE TABLE IF NOT EXISTS score_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  delta REAL NOT NULL,                   -- +0.2, -1, +0.1 等
  reason TEXT NOT NULL,                  -- 见下方枚举
  related_annotation_id INTEGER,
  related_report_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (user_id) REFERENCES admin_users(id)
);

-- reason 枚举：
-- 'handle_report'       书籍负责人处理举报 +0.2
-- 'neglect_penalty'     未处理举报转社区 -1
-- 'vote_contribution'   投票贡献 +0.1
-- 'false_report'        恶意举报处罚 -0.5

CREATE INDEX IF NOT EXISTS idx_score_user ON score_logs(user_id, created_at);
```

#### mutes — 禁言/封锁记录

```sql
CREATE TABLE IF NOT EXISTS mutes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,                    -- 'warning' | 'mute' | 'lock' | 'ban'
  reason TEXT NOT NULL,
  related_annotation_id INTEGER,
  duration_minutes INTEGER,              -- NULL = 永久/警告
  starts_at TEXT NOT NULL DEFAULT (datetime('now')),
  ends_at TEXT,                          -- NULL = 永久
  lifted_by INTEGER,                     -- 提前解除的管理员ID
  lifted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (user_id) REFERENCES admin_users(id)
);

CREATE INDEX IF NOT EXISTS idx_mutes_active ON mutes(user_id, ends_at)
  WHERE lifted_at IS NULL;
```

### 1.2 admin_users 表新增字段

```sql
-- 积分与治理相关
ALTER TABLE admin_users ADD COLUMN score REAL NOT NULL DEFAULT 0;
ALTER TABLE admin_users ADD COLUMN violation_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE admin_users ADD COLUMN last_violation_at TEXT;
ALTER TABLE admin_users ADD COLUMN consecutive_neglect_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE admin_users ADD COLUMN lock_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE admin_users ADD COLUMN locked_until TEXT;
ALTER TABLE admin_users ADD COLUMN banned_at TEXT;
ALTER TABLE admin_users ADD COLUMN appeal_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE admin_users ADD COLUMN muted_until TEXT;
```

### 1.3 books 表新增字段

```sql
-- 是否允许批注（书籍负责人在管理页面控制）
ALTER TABLE books ADD COLUMN annotation_enabled INTEGER NOT NULL DEFAULT 0;
-- 批注锁定（管理员封锁期间自动设置）
ALTER TABLE books ADD COLUMN annotation_locked INTEGER NOT NULL DEFAULT 0;
```

### 1.4 实体关系图

```
admin_users ──1:N──> annotations ──1:N──> reports ──1:N──> votes
     │                    │
     │                    └── chapter_id → chapters → books
     │
     ├── score, violation_count, muted_until, locked_until, banned_at
     └── score_logs (积分变动历史)
         mutes (禁言/封锁历史)
```

---

## 2. 批注发表

### 2.1 前置条件

| 条件 | 说明 |
|------|------|
| 用户角色 ≥ demo | 游客不可发表批注 |
| `books.annotation_enabled = 1` | 书籍负责人需在管理页面开启 |
| `books.annotation_locked = 0` | 未被系统锁定 |
| 用户未被禁言 | `muted_until IS NULL OR muted_until < now()` |
| 用户未被封禁 | `banned_at IS NULL` |

### 2.2 句子分割算法

以句末标点为分隔，支持中英文混合。引号内的句号不单独分割。

```javascript
/**
 * 将段落文本按句子分割
 * 支持：。！？!?.  省略号……/... 不切割引号内部
 */
function splitSentences(text) {
  if (!text || !text.trim()) return [];
  const raw = text.match(/[^。！？.!?\n]+[。！？.!?\n]?/g) || [text];

  // 合并引号内的碎片
  const merged = [];
  let buf = '';
  let depth = 0; // 引号嵌套深度
  for (const seg of raw) {
    buf += seg;
    for (const ch of seg) {
      if (ch === '"' || ch === '「' || ch === '『') depth++;
      if (ch === '"' || ch === '」' || ch === '』') depth = Math.max(0, depth - 1);
    }
    if (depth === 0) {
      const trimmed = buf.trim();
      if (trimmed) merged.push(trimmed);
      buf = '';
    }
  }
  if (buf.trim()) merged.push(buf.trim());
  return merged;
}
```

### 2.3 选中文本吸附

用户选中任意文本后，自动吸附到包含选区的完整句子：

```javascript
/**
 * 将选区吸附到完整句子
 * @param {string} paragraphText - 段落全文
 * @param {number} selStart - 选区起始字符偏移
 * @param {number} selEnd - 选区结束字符偏移
 * @returns {{ text, sentIdx, start, end } | null}
 */
function snapToSentence(paragraphText, selStart, selEnd) {
  const sentences = splitSentences(paragraphText);
  let pos = 0;
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    const sStart = paragraphText.indexOf(s, pos);
    const sEnd = sStart + s.length;
    // 选区与句子有交集 → 吸附
    if (selStart < sEnd && selEnd > sStart) {
      return { text: s, sentIdx: i, start: sStart, end: sEnd };
    }
    pos = sEnd;
  }
  return null;
}
```

### 2.4 句子哈希（定位用）

```javascript
async function sentenceHash(text) {
  const buf = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(text)
  );
  return [...new Uint8Array(buf)].slice(0, 4)
    .map(b => b.toString(16).padStart(2, '0')).join('');
}
```

### 2.5 交互流程

#### PC 端（右键菜单）

```
用户选中文本 → 右键 → 系统吸附到完整句子 → 显示自定义右键菜单
  └─ 菜单项：「📝 添加批注」（后续可扩展更多项）
     └─ 点击 → 弹出批注输入框（popover，锚定在选区附近）
```

```javascript
// 拦截右键（仅在有选区时）
readerContent.addEventListener('contextmenu', (e) => {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !canAnnotate) return; // 无选区或无权限，走默认右键

  e.preventDefault();

  // 定位段落和句子
  const anchorP = sel.anchorNode.closest?.('p') || sel.anchorNode.parentElement?.closest('p');
  if (!anchorP) return;
  const paraIdx = [...readerContent.querySelectorAll('p')].indexOf(anchorP);
  if (paraIdx < 0) return;

  const paraText = anchorP.textContent;
  const range = sel.getRangeAt(0);
  const preRange = document.createRange();
  preRange.setStart(anchorP, 0);
  preRange.setEnd(range.startContainer, range.startOffset);
  const selStart = preRange.toString().length;
  const selEnd = selStart + sel.toString().length;

  const snapped = snapToSentence(paraText, selStart, selEnd);
  if (!snapped) return;

  showContextMenu(e.clientX, e.clientY, { paraIdx, ...snapped });
});
```

#### 移动端（selectionchange 浮动按钮）

```javascript
// 不拦截系统长按菜单，监听选区变化后显示浮动按钮
document.addEventListener('selectionchange', debounce(() => {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !canAnnotate) {
    hideFloatingBtn();
    return;
  }
  // 检查选区是否在阅读内容区域内
  const anchor = sel.anchorNode;
  if (!readerContent.contains(anchor)) return;

  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  showFloatingBtn(rect); // 在选区上方显示「📝」按钮
}, 300));
```

#### 右键菜单 UI

```html
<div id="ctx-menu" class="ctx-menu" style="display:none">
  <div class="ctx-item" onclick="openAnnotationEditor()">📝 添加批注</div>
  <!-- 后续扩展：翻译、朗读、复制等 -->
</div>

<style>
.ctx-menu {
  position: fixed;
  z-index: 9999;
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0,0,0,0.15);
  padding: 4px 0;
  min-width: 140px;
}
.ctx-item {
  padding: 8px 16px;
  cursor: pointer;
  font-size: 14px;
  transition: background 0.15s;
}
.ctx-item:hover { background: var(--bg); }
</style>
```

菜单消失时机：点击菜单外区域 / 滚动 / 翻页 / Escape 键。

### 2.6 批注输入框

PC 端用 popover（锚定选区附近），移动端用底部抽屉。

```html
<div id="anno-editor" class="anno-editor" style="display:none">
  <div class="anno-editor-quote" id="anno-quote"></div>
  <textarea id="anno-input" maxlength="500" placeholder="写下你的批注..."></textarea>
  <div class="anno-editor-footer">
    <button id="anno-visibility-btn" class="anno-vis-btn" onclick="toggleVisibility()">
      🔒 仅自己可见
    </button>
    <div class="anno-editor-actions">
      <button class="btn btn-sm" onclick="closeAnnotationEditor()">取消</button>
      <button class="btn btn-sm" id="anno-submit-btn" style="background:var(--accent);color:#fff"
              onclick="submitAnnotation()">发表</button>
    </div>
  </div>
</div>

<style>
.anno-editor {
  position: fixed;
  z-index: 9998;
  background: var(--card-bg);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.18);
  padding: 16px;
  width: 320px;
  max-width: 90vw;
}
.anno-editor-quote {
  font-size: 13px;
  color: var(--text-light);
  border-left: 3px solid var(--accent);
  padding: 4px 8px;
  margin-bottom: 10px;
  max-height: 60px;
  overflow: hidden;
}
.anno-editor textarea {
  width: 100%;
  min-height: 80px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px;
  font-size: 14px;
  resize: vertical;
  background: var(--bg);
  color: var(--text);
}
.anno-editor-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 10px;
}
.anno-vis-btn {
  background: none;
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 4px 12px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}
.anno-vis-btn.public {
  background: #3b82f611;
  border-color: #3b82f6;
  color: #3b82f6;
}
.anno-editor-actions { display: flex; gap: 6px; }

/* 移动端：底部抽屉 */
@media (max-width: 768px) {
  .anno-editor {
    position: fixed;
    bottom: 0; left: 0; right: 0;
    width: 100%;
    max-width: 100vw;
    border-radius: 16px 16px 0 0;
    padding: 20px 16px calc(env(safe-area-inset-bottom) + 16px);
  }
}
</style>
```

可见性切换逻辑：

```javascript
let annoVisibility = 'private'; // 默认私有

function toggleVisibility() {
  const btn = document.getElementById('anno-visibility-btn');
  if (annoVisibility === 'private') {
    annoVisibility = 'public';
    btn.textContent = '🌐 所有人可见';
    btn.classList.add('public');
  } else {
    annoVisibility = 'private';
    btn.textContent = '🔒 仅自己可见';
    btn.classList.remove('public');
  }
}
```

### 2.7 下划线视觉效果

被批注的句子用 `<span class="annotated">` 包裹，虚线下划线表示。

#### CSS 实现

```css
/* 基础下划线 — 用 background-image 画虚线（比 text-decoration 控制力强） */
.annotated {
  background-image: linear-gradient(
    to right,
    var(--anno-color) 50%,
    transparent 50%
  );
  background-size: 6px 2px;
  background-repeat: repeat-x;
  background-position: bottom;
  padding-bottom: 2px;
  cursor: pointer;
  transition: background-color 0.2s;
}
.annotated:hover {
  background-color: var(--anno-color-hover);
}

/* 仅私有批注 — 黄色 */
.annotated.private-only {
  --anno-color: rgba(245, 158, 11, var(--anno-opacity));
  --anno-color-hover: rgba(245, 158, 11, 0.08);
}

/* 有公开批注 — 蓝色 */
.annotated.has-public {
  --anno-color: rgba(59, 130, 246, var(--anno-opacity));
  --anno-color-hover: rgba(59, 130, 246, 0.08);
}

/* 同时有私有+公开 — 蓝色下划线 + 左侧黄色小圆点 */
.annotated.has-both {
  --anno-color: rgba(59, 130, 246, var(--anno-opacity));
  --anno-color-hover: rgba(59, 130, 246, 0.08);
  position: relative;
}
.annotated.has-both::before {
  content: '';
  position: absolute;
  left: -3px;
  bottom: 0;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: rgba(245, 158, 11, 0.7);
}

/* 暗色模式适配 */
[data-theme="dark"] .annotated.private-only {
  --anno-color: rgba(212, 168, 67, var(--anno-opacity));
}
[data-theme="dark"] .annotated.has-public,
[data-theme="dark"] .annotated.has-both {
  --anno-color: rgba(91, 155, 213, var(--anno-opacity));
}
```

#### 对数浓度计算

```javascript
/**
 * 批注人数 → 下划线颜色透明度
 * 1人=0.3, 3人≈0.45, 10人≈0.6, 30人≈0.75, 100人≈0.9
 */
function annotationOpacity(count) {
  if (count <= 0) return 0;
  const min = 0.3, max = 0.9;
  return Math.min(max, min + (max - min) * (Math.log10(count) / Math.log10(100)));
}
```

### 2.8 渲染批注下划线

加载章节时，从 API 获取该章节的批注聚合数据，渲染下划线：

```javascript
async function renderAnnotationUnderlines(chapterId) {
  // API 返回按句子聚合的批注统计
  const res = await api('GET', `/api/annotations/summary?chapterId=${chapterId}`);
  if (!res.ok) return;
  const { sentences } = await res.json();
  // sentences: [{ para_idx, sent_idx, public_count, private_count, has_mine }]

  const paragraphs = readerContent.querySelectorAll('p');

  for (const s of sentences) {
    const p = paragraphs[s.para_idx];
    if (!p) continue;

    const sents = splitSentences(p.textContent);
    if (!sents[s.sent_idx]) continue;

    // 找到句子在段落中的位置，用 Range 包裹 <span>
    const sentText = sents[s.sent_idx];
    const textNodes = getTextNodes(p);
    const range = findTextRange(textNodes, sentText);
    if (!range) continue;

    const span = document.createElement('span');
    span.className = 'annotated';
    span.dataset.paraIdx = s.para_idx;
    span.dataset.sentIdx = s.sent_idx;

    // 确定样式类
    const hasPublic = s.public_count > 0;
    const hasPrivate = s.private_count > 0 || s.has_mine;
    if (hasPublic && hasPrivate) {
      span.classList.add('has-both');
    } else if (hasPublic) {
      span.classList.add('has-public');
    } else {
      span.classList.add('private-only');
    }

    // 设置浓度
    const totalCount = s.public_count + (s.has_mine ? 1 : 0);
    span.style.setProperty('--anno-opacity', annotationOpacity(totalCount));

    // 点击查看批注
    span.addEventListener('click', () => showAnnotationPopover(s.para_idx, s.sent_idx, span));

    range.surroundContents(span);
  }
}
```

### 2.9 点击查看批注

点击带下划线的句子，弹出批注列表 popover：

```javascript
async function showAnnotationPopover(paraIdx, sentIdx, anchorEl) {
  const res = await api('GET',
    `/api/annotations?chapterId=${currentChapterId}&paraIdx=${paraIdx}&sentIdx=${sentIdx}`
  );
  if (!res.ok) return;
  const { annotations } = await res.json();

  const rect = anchorEl.getBoundingClientRect();
  const popover = document.getElementById('anno-popover');

  popover.innerHTML = annotations.map(a => `
    <div class="anno-popover-item">
      <div class="anno-popover-content">${escHtml(a.content)}</div>
      <div class="anno-popover-meta">
        ${escHtml(a.username)} · ${timeAgo(a.created_at)}
        ${a.visibility === 'private' ? ' · 🔒' : ''}
        ${a.is_mine ? '<button class="btn-link" onclick="deleteMyAnnotation('+a.id+')">删除</button>' : ''}
        ${!a.is_mine ? '<button class="btn-link" onclick="reportAnnotation('+a.id+')">举报</button>' : ''}
      </div>
    </div>
  `).join('') || '<div class="anno-popover-empty">暂无批注</div>';

  // 定位
  popover.style.display = 'block';
  popover.style.left = rect.left + 'px';
  popover.style.top = (rect.bottom + 8) + 'px';
}
```

### 2.10 章节更新后批注对齐

当管理员更新章节内容时，后端自动执行批注重定位：

```
精确匹配（同位置+hash一致）→ 通过，无需处理
    ↓ 失败
附近搜索（±3段落内找相同hash）→ 更新 para_idx/sent_idx
    ↓ 失败
模糊匹配（sent_text 编辑距离 > 0.7 相似度）→ 更新全部定位字段
    ↓ 失败
标记孤立（para_idx = -1）→ 不显示下划线，管理页面可见
```

---

## 3. 批注管理

### 3.1 入口与页面结构

- 入口：`admin.html` 侧边栏新增「📝 批注管理」选项
- 点击后 `window.open('annotation-admin.html')` 打开独立页面
- 独立页面复用现有 CSS 变量体系和组件样式

### 3.2 权限矩阵

| 角色 | 可见范围 | 可操作范围 |
|------|---------|-----------|
| demo | 自己的批注 + 自己书上的 demo 批注 | 删除自己的；移除自己书上的 demo 批注 |
| admin | 所有批注（超管批注除外） | 移除/恢复所有可见批注 |
| super_admin | 所有批注 | 移除/恢复/永久删除所有批注 |

#### 权限过滤 SQL

```javascript
function buildPermissionFilter(auth) {
  const where = [];
  const binds = [];

  if (auth.role === 'super_admin') {
    // 无限制
  } else if (auth.role === 'admin') {
    // 排除超管的批注
    where.push("u.role != 'super_admin'");
  } else {
    // demo：自己的批注 + 自己书上的 demo 批注
    where.push(
      '(a.user_id = ? OR (b.created_by = ? AND u.role = ?))'
    );
    binds.push(auth.userId, auth.userId, 'demo');
  }

  return { where, binds };
}
```

### 3.3 页面布局

```
┌─────────────────────────────────────────────────┐
│ 📝 批注管理                      [返回管理后台]  │
├─────────────────────────────────────────────────┤
│ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐            │
│ │ 总数 │ │ 今日 │ │ 举报 │ │ 移除 │  ← 统计卡片 │
│ │ 128  │ │  5   │ │  3   │ │  12  │  （可点击） │
│ └──────┘ └──────┘ └──────┘ └──────┘            │
├─────────────────────────────────────────────────┤
│ 书籍[▼] 状态[▼] 类型[▼] [搜索...]    ← 筛选栏  │
├─────────────────────────────────────────────────┤
│ [已选N条: 批量移除 | 批量恢复]       ← 批量操作  │
├─────────────────────────────────────────────────┤
│ ☐ "原文引用..."                                 │
│   💬 批注内容                                    │
│   👤 user [demo] 📖 书名/章节 🕐 2h前           │
│   🔒私有 ⚠️举报              [上下文] [移除]     │
│─────────────────────────────────────────────────│
│ ☐ "原文引用..."                                 │
│   💬 批注内容                                    │
│   ...                                           │
├─────────────────────────────────────────────────┤
│                    ← 1/5 →  每页20条             │
└─────────────────────────────────────────────────┘
```

### 3.4 列表项信息

每条批注展示：
- 原文句子（灰色引用，截断80字，左侧蓝色竖线）
- 批注内容
- 元信息行：用户名 + 角色标签（demo/admin/super 不同颜色）+ 书籍/章节 + 相对时间
- 状态徽章：🔒私有 / ⚠️举报 / 🚫已移除
- 操作按钮：
  - 「上下文」— 跳转到阅读页对应位置
  - 「移除」/「恢复」— 切换 status
  - 「永久删除」— 仅 super_admin 可见，仅对已移除的批注

### 3.5 筛选与搜索

| 筛选项 | 类型 | 说明 |
|--------|------|------|
| 书籍 | 下拉 | 动态加载用户可见的书籍列表 |
| 状态 | 下拉 | all / normal / reported / removed |
| 类型 | 下拉 | all / public / private |
| 搜索 | 文本 | 同时搜索批注内容和原文 `LIKE %keyword%` |
| 排序 | 下拉 | 最新 / 最早 / 举报数最多 |

### 3.6 批量操作

- 表头全选 checkbox → 选中当前页所有项
- 选中后顶部浮现操作栏：「已选 N 条 | 批量移除 | 批量恢复 | 取消」
- 批量操作前 confirm 确认
- 永久删除不支持批量（防误操作）

---

## 4. 批注举报与社区治理

### 4.1 举报资格与限制

| 规则 | 说明 |
|------|------|
| 举报人 | 所有用户（含游客） |
| 每人每批注 | 最多 2 次举报 |
| 理由长度 | ≥ 10 个汉字或单词 |
| 理由去重 | Bigram Jaccard 相似度 ≥ 0.6 视为相同，拒绝提交 |
| 游客防滥用 | IP 限流（每小时 3 次）+ Cookie 指纹追踪 |
| 游客权重 | 0.5（2 个游客举报 = 1 个有效举报） |
| 恶意举报 | 举报被判"保留" ≥ 5 次 → 禁止举报 30 天 |

#### 举报理由相似度检测

```javascript
/**
 * Bigram Jaccard 相似度（O(n)，Workers CPU 友好）
 */
function bigramSet(text) {
  const clean = text.replace(/[\s\p{P}]/gu, '').toLowerCase();
  const set = new Set();
  for (let i = 0; i < clean.length - 1; i++) {
    set.add(clean[i] + clean[i + 1]);
  }
  return set;
}

function jaccardSimilarity(a, b) {
  const setA = bigramSet(a);
  const setB = bigramSet(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const bg of setA) if (setB.has(bg)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

// 使用：与该批注已有举报理由逐一比较
const existing = await db.prepare(
  'SELECT reason FROM reports WHERE annotation_id = ?'
).bind(annoId).all();
for (const r of existing.results) {
  if (jaccardSimilarity(newReason, r.reason) >= 0.6) {
    return error('与已有举报理由过于相似，请提供不同角度的理由');
  }
}
```

### 4.2 举报处理流程

```
用户提交举报
    │
    ▼
记录到 reports 表（status='pending'）
    │
    ▼
检查该批注的有效举报人数（registered + guest/2）
    │
    ├─ < x（默认10）→ 等待更多举报
    │
    └─ ≥ x → 设置 threshold_reached_at = now()
              通知书籍负责人
              批注 status 改为 'reported'
                │
                ├─ 负责人 48h 内处理
                │   ├─ 移除 → 批注 removed，负责人 +0.2 积分
                │   └─ 保留 → 批注恢复 normal，举报 resolved
                │
                └─ 负责人 48h 未处理
                    │
                    ▼
                  升级到社区投票（status='escalated'）
                  负责人 -1 积分，consecutive_neglect_count++
                  通知其他管理员（不含负责人）
                    │
                    ▼
                  72h 投票窗口
                    │
                    ├─ ≥ z 人投票
                    │   ├─ 移除占比 ≥ y% → 自动移除，投票者各 +0.1
                    │   └─ 移除占比 < y% → 保留
                    │
                    └─ < z 人投票（超时）
                        ├─ ≥ 3 票 → 按已有票比例判定
                        └─ < 3 票 → 延长 48h
                            └─ 仍不足 → super_admin 独裁
                                └─ super_admin 也没投 → 保留，标记"争议"
```

### 4.3 特殊情况处理

| 情况 | 处理方式 |
|------|---------|
| 管理员互相举报 | 跳过负责人阶段，直接社区投票。双方不可参与投票 |
| 负责人自己的批注被举报 | 负责人回避，直接社区投票 |
| 负责人被封锁期间收到举报 | 直接走社区投票（负责人视为不可用） |
| 管理员总数 ≤ 2 | 投票阈值 z 降为 1，窗口缩短为 24h，neglect_limit 放宽为 14 |

### 4.4 积分系统

#### 积分变动规则

| 事件 | 积分变动 | 对象 |
|------|---------|------|
| 书籍负责人处理举报 | +0.2 | 负责人 |
| 负责人未处理转社区 | -1.0 | 负责人 |
| 投票贡献（结果为移除） | +0.1 | 每个投票者 |
| 恶意举报（举报被判保留 ≥5 次） | -0.5 | 举报人 |

#### 积分范围与后果

| 积分范围 | 后果 |
|---------|------|
| > 0 | 正常 |
| ≤ -10 | 触发审查通知（通知 super_admin） |
| ≤ -20 | 自动降级（admin → demo），需 super_admin 手动恢复 |
| 上限 100 | 防通胀 |

### 4.5 禁言递进规则

对发表违规批注的用户：

| 违规次数 | 处罚 | 时长 | 说明 |
|---------|------|------|------|
| 第1次 | ⚠️ 警告 | — | 系统通知，不限制功能 |
| 第2次 | 🔇 禁言 | 1天 | 不可发布/编辑公开批注 |
| 第3次 | 🔇 禁言 | 3天 | 同上 |
| 第4次 | 🔇 禁言 | 7天 | 同上 |
| 第5次 | 🔇 禁言 | 30天 | 同上 |
| 第6次 | 🚫 封禁 | 永久 | 可在30天后申诉，终身2次机会 |

**禁言期间权限：**
- ✅ 登录、查看书籍和批注、管理私有批注
- ❌ 发布/编辑公开批注、举报他人

**时间衰减：** 180 天无新违规，violation_count 减 1（最低到 0）。

```javascript
const MUTE_DURATIONS_MIN = [0, 0, 1440, 4320, 10080, 43200]; // index=违规次数

function getMuteDuration(violationCount) {
  if (violationCount <= 1) return 0; // 警告
  if (violationCount >= 6) return -1; // 封禁
  return MUTE_DURATIONS_MIN[violationCount];
}

async function applyPunishment(env, userId, annotationId) {
  // 增加违规计数
  await env.DB.prepare(`
    UPDATE admin_users
    SET violation_count = violation_count + 1,
        last_violation_at = datetime('now')
    WHERE id = ?
  `).bind(userId).run();

  const user = await env.DB.prepare(
    'SELECT violation_count FROM admin_users WHERE id = ?'
  ).bind(userId).first();

  const duration = getMuteDuration(user.violation_count);

  if (duration === -1) {
    // 封禁
    await env.DB.prepare(`
      UPDATE admin_users SET banned_at = datetime('now') WHERE id = ?
    `).bind(userId).run();
    await env.DB.prepare(`
      INSERT INTO mutes (user_id, type, reason, related_annotation_id)
      VALUES (?, 'ban', '累计违规达到封禁阈值', ?)
    `).bind(userId, annotationId).run();
  } else if (duration > 0) {
    // 禁言
    const endsAt = new Date(Date.now() + duration * 60000).toISOString();
    await env.DB.prepare(`
      UPDATE admin_users SET muted_until = ? WHERE id = ?
    `).bind(endsAt, userId).run();
    await env.DB.prepare(`
      INSERT INTO mutes (user_id, type, reason, related_annotation_id, duration_minutes, ends_at)
      VALUES (?, 'mute', '发表违规批注', ?, ?, ?)
    `).bind(userId, annotationId, duration, endsAt).run();
  } else {
    // 警告
    await env.DB.prepare(`
      INSERT INTO mutes (user_id, type, reason, related_annotation_id)
      VALUES (?, 'warning', '发表违规批注（首次警告）', ?)
    `).bind(userId, annotationId).run();
  }
}
```

### 4.6 管理员不作为封锁

```javascript
async function checkNeglect(env, adminId) {
  const params = await getSystemParams(env);
  const user = await env.DB.prepare(
    'SELECT consecutive_neglect_count, lock_count FROM admin_users WHERE id = ?'
  ).bind(adminId).first();

  if (user.consecutive_neglect_count >= params.neglect_limit) {
    // 封锁时长随次数翻倍：2天、4天、8天...
    const days = 2 * Math.pow(2, Math.min(user.lock_count, 4));
    const lockedUntil = new Date(Date.now() + days * 86400000).toISOString();

    await env.DB.prepare(`
      UPDATE admin_users
      SET locked_until = ?,
          consecutive_neglect_count = 0,
          lock_count = lock_count + 1
      WHERE id = ?
    `).bind(lockedUntil, adminId).run();

    // 锁定该管理员负责的所有书籍
    await env.DB.prepare(`
      UPDATE books SET annotation_locked = 1
      WHERE created_by = ? AND annotation_locked = 0
    `).bind(adminId).run();

    // 记录
    await env.DB.prepare(`
      INSERT INTO mutes (user_id, type, reason, duration_minutes, ends_at)
      VALUES (?, 'lock', '连续未处理举报', ?, ?)
    `).bind(adminId, days * 1440, lockedUntil).run();
  }
}

// 解封时自动解锁书籍（在 checkAdmin 中检查）
async function checkAndUnlock(env, auth) {
  if (auth.role !== 'demo' && auth.lockedUntil) {
    if (new Date(auth.lockedUntil) <= new Date()) {
      await env.DB.prepare(`
        UPDATE admin_users SET locked_until = NULL WHERE id = ?
      `).bind(auth.userId).run();
      await env.DB.prepare(`
        UPDATE books SET annotation_locked = 0
        WHERE created_by = ? AND annotation_locked = 1
      `).bind(auth.userId).run();
    }
  }
}
```

### 4.7 动态参数（管理员少时自动调整）

```javascript
async function getSystemParams(env) {
  const { count } = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM admin_users WHERE role IN ('admin','super_admin') AND banned_at IS NULL"
  ).first();

  // 从 site_settings 读取自定义值，fallback 到默认值
  const get = async (key, def) => {
    const r = await env.DB.prepare(
      'SELECT value FROM site_settings WHERE key = ?'
    ).bind(key).first();
    return r ? Number(r.value) : def;
  };

  const isSmall = count <= 2;
  return {
    report_threshold: isSmall ? 5 : await get('anno_report_threshold', 10),       // x
    vote_threshold: isSmall ? 1 : await get('anno_vote_threshold', 10),            // z
    vote_remove_percent: await get('anno_vote_remove_percent', 75),                 // y%
    vote_window_hours: isSmall ? 24 : 72,
    neglect_limit: isSmall ? 14 : await get('anno_neglect_limit', 7),              // n
    handler_timeout_hours: 48,
    admin_count: count,
  };
}
```

---

## 5. API 端点总览

### 5.1 阅读页 API（公开/半公开）

| 方法 | 端点 | 说明 | 权限 |
|------|------|------|------|
| GET | `/api/annotations/summary?chapterId=X` | 章节批注聚合统计（渲染下划线用） | 任何人（游客只看公开） |
| GET | `/api/annotations?chapterId=X&paraIdx=Y&sentIdx=Z` | 某句话的批注列表 | 任何人（游客只看公开） |
| POST | `/api/annotations` | 发表批注 | demo+ |
| DELETE | `/api/annotations/:id` | 删除自己的批注 | 批注作者 |
| POST | `/api/reports` | 提交举报 | 任何人（含游客） |

### 5.2 管理页 API（需认证）

| 方法 | 端点 | 说明 | 权限 |
|------|------|------|------|
| GET | `/api/admin/annotations` | 批注列表（筛选+分页） | demo+ |
| GET | `/api/admin/annotations/stats` | 统计数据 | demo+ |
| GET | `/api/admin/annotations/:id` | 批注详情（含上下文） | demo+ |
| PATCH | `/api/admin/annotations/:id` | 修改状态（移除/恢复） | 按权限矩阵 |
| DELETE | `/api/admin/annotations/:id` | 永久删除 | super_admin |
| POST | `/api/admin/annotations/batch` | 批量操作 | 按权限矩阵 |
| GET | `/api/admin/reports` | 待处理举报列表 | demo+ |
| PATCH | `/api/admin/reports/:id` | 处理举报（移除/保留） | 书籍负责人或投票管理员 |
| POST | `/api/admin/votes` | 提交投票 | demo+（不含负责人） |
| GET | `/api/admin/scores` | 积分排行 | admin+ |

### 5.3 summary API 响应格式

```json
// GET /api/annotations/summary?chapterId=5
{
  "sentences": [
    {
      "para_idx": 0,
      "sent_idx": 2,
      "sent_hash": "a1b2c3d4",
      "public_count": 3,
      "private_count": 1,
      "has_mine": true
    }
  ]
}
```

SQL 实现：

```sql
-- 公开批注聚合
SELECT para_idx, sent_idx, sent_hash,
  COUNT(CASE WHEN visibility='public' AND status='normal' THEN 1 END) as public_count,
  COUNT(CASE WHEN visibility='private' AND status='normal' AND user_id=? THEN 1 END) as private_count,
  MAX(CASE WHEN user_id=? THEN 1 ELSE 0 END) as has_mine
FROM annotations
WHERE chapter_id = ? AND status IN ('normal', 'reported')
GROUP BY para_idx, sent_idx, sent_hash
HAVING public_count > 0 OR private_count > 0
```

---

## 6. 配置参数

所有参数存储在 `site_settings` 表，super_admin 可在设置页面修改。

| key | 默认值 | 说明 |
|-----|--------|------|
| `anno_report_threshold` | 10 | x：触发通知负责人的举报人数 |
| `anno_vote_threshold` | 10 | z：社区投票所需管理员数 |
| `anno_vote_remove_percent` | 75 | y%：移除决策所需占比 |
| `anno_neglect_limit` | 7 | n：连续未处理次数触发封锁 |
| `anno_max_per_chapter` | 200 | demo 用户每章批注上限 |
| `anno_mute_decay_days` | 180 | 违规计数衰减周期（天） |

---

## 7. 实施计划

### Phase 1 — 批注发表（核心功能）

- [ ] 数据库迁移：annotations 表 + books 新字段
- [ ] 后端：`/api/annotations` CRUD + `/api/annotations/summary`
- [ ] 前端 read.html：句子分割 + 右键菜单 + 批注输入框 + 下划线渲染
- [ ] admin.html：书籍编辑弹窗增加「允许批注」开关
- [ ] 安全审计

### Phase 2 — 批注管理

- [ ] `annotation-admin.html` 独立页面
- [ ] 后端：`/api/admin/annotations` 列表/统计/批量操作
- [ ] 权限过滤 SQL
- [ ] admin.html 侧边栏入口
- [ ] 安全审计

### Phase 3 — 举报与治理

- [ ] 数据库迁移：reports + votes + score_logs + mutes + admin_users 新字段
- [ ] 后端：举报提交 + 负责人处理 + 社区投票 + 积分计算 + 禁言/封锁
- [ ] 前端：举报按钮 + 待处理举报列表 + 投票界面
- [ ] 管理页面：积分排行 + 禁言记录
- [ ] 安全审计

---

## 附录：文件变更清单

### 新增文件
- `docs/annotation-v2-design.md` — 本文档
- `migrations/0004_annotations.sql` — 批注表
- `migrations/0005_reports.sql` — 举报+投票+积分+禁言表
- `functions/api/annotations.js` — 批注 CRUD（公开）
- `functions/api/annotations/summary.js` — 批注聚合统计
- `functions/api/annotations/[id].js` — 单条批注操作
- `functions/api/reports.js` — 举报提交
- `functions/api/admin/annotations.js` — 管理列表+统计
- `functions/api/admin/annotations/[id].js` — 管理单条操作
- `functions/api/admin/annotations/batch.js` — 批量操作
- `functions/api/admin/reports.js` — 举报管理
- `functions/api/admin/reports/[id].js` — 处理举报
- `functions/api/admin/votes.js` — 投票
- `annotation-admin.html` — 批注管理独立页面

### 修改文件
- `functions/api/_utils.js` — ensureSchema 新增迁移
- `read.html` — 批注发表+下划线渲染+举报按钮
- `style.css` — 批注相关样式
- `admin.html` — 侧边栏入口 + 书籍编辑增加批注开关
