// ===== 密码哈希（PBKDF2 + 随机盐） =====

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256
  );
  const hashHex = [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
  const saltHex = [...salt].map(b => b.toString(16).padStart(2, '0')).join('');
  return `pbkdf2:100000:${saltHex}:${hashHex}`;
}

async function verifyPassword(password, stored) {
  // 兼容旧格式（纯64位hex = 无盐SHA-256）→ 验证后自动迁移
  if (!stored.startsWith('pbkdf2:')) {
    const oldHash = await sha256Legacy(password);
    const a = new TextEncoder().encode(oldHash);
    const b = new TextEncoder().encode(stored);
    let diff = a.length ^ b.length;
    for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] || 0) ^ (b[i] || 0);
    return { match: diff === 0, needsMigration: true };
  }
  const [, iterations, saltHex, hashHex] = stored.split(':');
  const salt = new Uint8Array(saltHex.match(/.{2}/g).map(b => parseInt(b, 16)));
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: Number(iterations), hash: 'SHA-256' }, key, 256
  );
  const computed = [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
  let diff = computed.length ^ hashHex.length;
  for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ (hashHex.charCodeAt(i) || 0);
  return { match: diff === 0, needsMigration: false };
}

async function sha256Legacy(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

// SHA-256哈希（用于token和IP的存储哈希）
export async function sha256Hash(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ===== Schema迁移（兼容旧数据库） =====

let _schemaEnsured = false;

async function ensureSchema(env) {
  if (_schemaEnsured) return;
  try {
    try {
      await env.DB.prepare('ALTER TABLE admin_users ADD COLUMN password_locked INTEGER DEFAULT 0').run();
    } catch {}
    // 书籍所有者
    try {
      await env.DB.prepare('ALTER TABLE books ADD COLUMN created_by INTEGER DEFAULT NULL').run();
    } catch {}
    // 书籍封面
    try {
      await env.DB.prepare('ALTER TABLE books ADD COLUMN cover_key TEXT DEFAULT NULL').run();
    } catch {}
    // 标签系统
    try {
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, color TEXT DEFAULT \'#888\')').run();
    } catch {}
    try {
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS book_tags (book_id INTEGER, tag_id INTEGER, PRIMARY KEY (book_id, tag_id))').run();
    } catch {}
    // GitHub OAuth
    try {
      await env.DB.prepare('ALTER TABLE admin_users ADD COLUMN github_id INTEGER DEFAULT NULL').run();
    } catch {}
    try {
      await env.DB.prepare('ALTER TABLE admin_users ADD COLUMN github_login TEXT DEFAULT NULL').run();
    } catch {}
    try {
      await env.DB.prepare('ALTER TABLE admin_users ADD COLUMN avatar_url TEXT DEFAULT NULL').run();
    } catch {}
    try {
      await env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_users_github_id ON admin_users(github_id) WHERE github_id IS NOT NULL').run();
    } catch {}
    // 章节乐观锁版本号
    try {
      await env.DB.prepare('ALTER TABLE chapters ADD COLUMN version INTEGER DEFAULT 0').run();
    } catch {}
    // 章节排序唯一约束（防重试导致重复章节）
    try {
      await env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_chapters_book_sort ON chapters(book_id, sort_order)').run();
    } catch {}
    // 书籍状态：normal(正常) / unlisted(下架) / deleted(待删除)
    try {
      await env.DB.prepare("ALTER TABLE books ADD COLUMN status TEXT DEFAULT 'normal'").run();
    } catch {}
    // 书籍定时删除时间
    try {
      await env.DB.prepare('ALTER TABLE books ADD COLUMN delete_at TEXT DEFAULT NULL').run();
    } catch {}
    // 🟢-4: 回填已有书籍的 status（ALTER TABLE 不回填默认值到已有行）
    try {
      await env.DB.prepare("UPDATE books SET status = 'normal' WHERE status IS NULL").run();
    } catch {}

    // ===== 批注系统 v2 =====
    // 批注主表
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
    // 书籍批注开关
    try { await env.DB.prepare('ALTER TABLE books ADD COLUMN annotation_enabled INTEGER NOT NULL DEFAULT 0').run(); } catch {}
    try { await env.DB.prepare('ALTER TABLE books ADD COLUMN annotation_locked INTEGER NOT NULL DEFAULT 0').run(); } catch {}

    // 所有迁移成功完成，标记为已完成
    _schemaEnsured = true;
  } catch (e) {
    // DB不可用等严重错误，不设标志，下次请求重试
    console.error('ensureSchema failed:', e);
  }
}

// ===== 默认管理员（拒绝无密码创建） =====

async function ensureDefaultAdmin(env) {
  if (!env.ADMIN_PASSWORD) {
    console.error('FATAL: ADMIN_PASSWORD env not set, refusing to create default admin');
    return;
  }
  try {
    const existing = await env.DB.prepare('SELECT id FROM admin_users WHERE username = ?').bind('admin').first();
    if (existing) return;
    const hash = await hashPassword(env.ADMIN_PASSWORD);
    await env.DB.prepare("INSERT OR IGNORE INTO admin_users (username, password_hash, role) VALUES (?, ?, 'super_admin')")
      .bind('admin', hash).run();
  } catch {}
}

// ===== Session验证 =====

export async function checkAdmin(request, env) {
  await ensureSchema(env);

  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return { ok: false, reason: 'missing' };

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ipHash = await sha256Hash(ip);
  const locked = await isIpLocked(env, ipHash);
  if (locked) return { ok: false, reason: 'locked' };

  const token = auth.slice(7);
  if (!token || token.length < 10) return { ok: false, reason: 'invalid' };

  // 对token做哈希后查找
  const tokenHash = await sha256Hash(token);
  const session = await env.DB.prepare(
    "SELECT s.user_id, s.expires_at, u.username, u.role, u.password_locked FROM admin_sessions s JOIN admin_users u ON s.user_id = u.id WHERE s.token = ?"
  ).bind(tokenHash).first();

  if (!session) return { ok: false, reason: 'invalid_token' };
  if (new Date(session.expires_at) < new Date()) {
    await env.DB.prepare('DELETE FROM admin_sessions WHERE token = ?').bind(tokenHash).run();
    return { ok: false, reason: 'expired' };
  }

  // 10%概率清理过期session和限流记录
  if (Math.random() < 0.1) {
    await env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at < datetime('now')").run().catch(() => {});
    await env.DB.prepare("DELETE FROM auth_attempts WHERE last_attempt < datetime('now', '-1 day')").run().catch(() => {});
    await env.DB.prepare("DELETE FROM site_settings WHERE key LIKE 'oauth_state:%' AND value < datetime('now')").run().catch(() => {});
  }

    // 兼容旧角色：editor → admin
  const role = session.role === 'editor' ? 'admin' : (session.role || 'demo');
  return { ok: true, userId: session.user_id, username: session.username, role, passwordLocked: session.password_locked === 1 };
}

// ===== 登录 =====

export async function login(env, username, password, ip) {
  const ipHash = await sha256Hash(ip);
  const locked = await isIpLocked(env, ipHash);
  if (locked) return { ok: false, reason: 'locked' };

  await ensureDefaultAdmin(env);

  const user = await env.DB.prepare('SELECT id, password_hash, role FROM admin_users WHERE username = ?')
    .bind(username).first();

  if (!user) {
    await recordFailedAttempt(env, ipHash);
    // 同时记录 username 维度限流
    const usernameHash = await sha256Hash('user:' + username);
    await recordFailedAttempt(env, usernameHash);
    return { ok: false, reason: 'wrong' };
  }

  // 检查 username 维度限流
  const usernameHash = await sha256Hash('user:' + username);
  const userLocked = await isIpLocked(env, usernameHash);
  if (userLocked) return { ok: false, reason: 'locked' };

  // GitHub OAuth 用户不能用密码登录
  if (user.password_hash === 'github_oauth:no_password') {
    return { ok: false, reason: 'github_only' };
  }

  const result = await verifyPassword(password, user.password_hash);

  if (!result.match) {
    await recordFailedAttempt(env, ipHash);
    await recordFailedAttempt(env, usernameHash);
    return { ok: false, reason: 'wrong' };
  }

  if (result.needsMigration) {
    const newHash = await hashPassword(password);
    await env.DB.prepare("UPDATE admin_users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(newHash, user.id).run().catch(() => {});
  }

  await clearFailedAttempts(env, ipHash);
  await clearFailedAttempts(env, usernameHash);

  // token明文返回客户端，DB只存哈希
  const token = generateToken();
  const tokenHash = await sha256Hash(token);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare('INSERT INTO admin_sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(tokenHash, user.id, expiresAt).run();

  // 限制单用户最多10个活跃session，删除最旧的
  await env.DB.prepare(
    "DELETE FROM admin_sessions WHERE user_id = ? AND token NOT IN (SELECT token FROM admin_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 10)"
  ).bind(user.id, user.id).run().catch(() => {});

  await env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at < datetime('now')").run().catch(() => {});
  await env.DB.prepare("DELETE FROM auth_attempts WHERE last_attempt < datetime('now', '-1 day')").run().catch(() => {});

  const loginRole = user.role === 'editor' ? 'admin' : (user.role || 'demo');
  return { ok: true, token, username: user.username, role: loginRole, userId: user.id, expiresAt };
}

// ===== 修改密码 =====

export async function changePassword(env, userId, oldPassword, newPassword) {
  const user = await env.DB.prepare('SELECT password_hash FROM admin_users WHERE id = ?')
    .bind(userId).first();
  if (!user) return { ok: false, reason: 'not_found' };

  const result = await verifyPassword(oldPassword, user.password_hash);
  if (!result.match) return { ok: false, reason: 'wrong_old' };

  if (!newPassword || newPassword.length < 8) return { ok: false, reason: 'too_short' };
  if (newPassword.length > 128) return { ok: false, reason: 'too_long' };
  if (!/[a-zA-Z]/.test(newPassword) || !/\d/.test(newPassword)) {
    return { ok: false, reason: 'too_weak' };
  }

  const newHash = await hashPassword(newPassword);
  await env.DB.prepare("UPDATE admin_users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(newHash, userId).run();

  await env.DB.prepare('DELETE FROM admin_sessions WHERE user_id = ?').bind(userId).run();

  return { ok: true };
}

// ===== IP限流（5次失败锁10分钟） =====
const MAX_ATTEMPTS = 5;
const LOCK_DURATION_MS = 10 * 60 * 1000;

async function isIpLocked(env, ip) {
  try {
    const r = await env.DB.prepare('SELECT fail_count, locked_until FROM auth_attempts WHERE ip_hash = ?')
      .bind(ip).first();
    if (!r) return false;
    return r.locked_until && new Date(r.locked_until) > new Date();
  } catch { return true; } // fail-closed: DB异常时拒绝登录
}

async function recordFailedAttempt(env, ip) {
  try {
    const r = await env.DB.prepare('SELECT fail_count, locked_until FROM auth_attempts WHERE ip_hash = ?')
      .bind(ip).first();
    if (!r) {
      await env.DB.prepare("INSERT INTO auth_attempts (ip_hash, fail_count, last_attempt) VALUES (?, 1, datetime('now'))")
        .bind(ip).run();
      return;
    }
    if (r.locked_until && new Date(r.locked_until) <= new Date()) {
      await env.DB.prepare("UPDATE auth_attempts SET fail_count = 1, locked_until = NULL, last_attempt = datetime('now') WHERE ip_hash = ?")
        .bind(ip).run();
      return;
    }
    const n = r.fail_count + 1;
    if (n >= MAX_ATTEMPTS) {
      const lock = new Date(Date.now() + LOCK_DURATION_MS).toISOString();
      await env.DB.prepare("UPDATE auth_attempts SET fail_count = ?, locked_until = ?, last_attempt = datetime('now') WHERE ip_hash = ?")
        .bind(n, lock, ip).run();
    } else {
      await env.DB.prepare("UPDATE auth_attempts SET fail_count = ?, last_attempt = datetime('now') WHERE ip_hash = ?")
        .bind(n, ip).run();
    }
  } catch {}
}

async function clearFailedAttempts(env, ip) {
  try { await env.DB.prepare('DELETE FROM auth_attempts WHERE ip_hash = ?').bind(ip).run(); } catch {}
}

// ===== 工具函数 =====
export function validateId(id) { return /^\d{1,18}$/.test(id) && Number(id) > 0; }

// 角色层级：super_admin > admin > demo（editor是admin的旧名，兼容）
const ROLE_LEVEL = { super_admin: 3, admin: 2, editor: 2, demo: 1 };

export function requireSuperAdmin(auth) {
  return auth.role === 'super_admin';
}

// 检查是否满足最低角色要求
export function requireMinRole(auth, minRole) {
  return (ROLE_LEVEL[auth.role] || 0) >= (ROLE_LEVEL[minRole] || 99);
}

// demo角色的书籍所有权检查：返回true表示允许操作
export async function checkBookOwnership(auth, env, bookId) {
  // admin及以上不受限
  if (requireMinRole(auth, 'admin')) return true;
  // demo只能操作自己创建的书
  const book = await env.DB.prepare('SELECT created_by FROM books WHERE id = ?').bind(bookId).first();
  if (!book) return false; // 书不存在
  return book.created_by === auth.userId;
}

export async function parseJsonBody(request) {
  try { return await request.json(); } catch { return null; }
}

// ===== GitHub OAuth 工具 =====

export async function hmacSign(data, secret) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function hmacVerify(data, signature, secret) {
  const expected = await hmacSign(data, secret);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

// 为 GitHub 用户创建 session（复用现有 token 机制）
export async function createSession(env, userId) {
  const token = generateToken();
  const tokenHash = await sha256Hash(token);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare('INSERT INTO admin_sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(tokenHash, userId, expiresAt).run();
  // 限制单用户最多10个活跃session
  await env.DB.prepare(
    "DELETE FROM admin_sessions WHERE user_id = ? AND token NOT IN (SELECT token FROM admin_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 10)"
  ).bind(userId, userId).run().catch(() => {});
  return { token, expiresAt };
}

// GitHub OAuth secret：优先环境变量（更安全），fallback到DB
export async function getGitHubClientSecret(env) {
  if (env.GITHUB_CLIENT_SECRET) return env.GITHUB_CLIENT_SECRET;
  const row = await env.DB.prepare("SELECT value FROM site_settings WHERE key = 'github_client_secret'").first();
  return row?.value || null;
}
