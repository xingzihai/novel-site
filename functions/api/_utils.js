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
  _schemaEnsured = true;
  try {
    await env.DB.prepare('ALTER TABLE admin_users ADD COLUMN password_locked INTEGER DEFAULT 0').run();
  } catch {
    // 列已存在，静默忽略
  }
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
  }

  return { ok: true, userId: session.user_id, username: session.username, role: session.role || 'editor', passwordLocked: session.password_locked === 1 };
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
    return { ok: false, reason: 'wrong' };
  }

  const result = await verifyPassword(password, user.password_hash);

  if (!result.match) {
    await recordFailedAttempt(env, ipHash);
    return { ok: false, reason: 'wrong' };
  }

  if (result.needsMigration) {
    const newHash = await hashPassword(password);
    await env.DB.prepare("UPDATE admin_users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(newHash, user.id).run().catch(() => {});
  }

  await clearFailedAttempts(env, ipHash);

  // token明文返回客户端，DB只存哈希
  const token = generateToken();
  const tokenHash = await sha256Hash(token);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare('INSERT INTO admin_sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(tokenHash, user.id, expiresAt).run();

  // 限制单用户最多10个活跃session，删除最旧的
  await env.DB.prepare(
    "DELETE FROM admin_sessions WHERE user_id = ? AND id NOT IN (SELECT id FROM admin_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 10)"
  ).bind(user.id, user.id).run().catch(() => {});

  await env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at < datetime('now')").run().catch(() => {});
  await env.DB.prepare("DELETE FROM auth_attempts WHERE last_attempt < datetime('now', '-1 day')").run().catch(() => {});

  return { ok: true, token, username: user.username, role: user.role || 'editor', expiresAt };
}

// ===== 修改密码 =====

export async function changePassword(env, userId, oldPassword, newPassword) {
  const user = await env.DB.prepare('SELECT password_hash FROM admin_users WHERE id = ?')
    .bind(userId).first();
  if (!user) return { ok: false, reason: 'not_found' };

  const result = await verifyPassword(oldPassword, user.password_hash);
  if (!result.match) return { ok: false, reason: 'wrong_old' };

  if (!newPassword || newPassword.length < 8) return { ok: false, reason: 'too_short' };
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
export function validateId(id) { return /^\d+$/.test(id); }

export function requireSuperAdmin(auth) {
  return auth.role === 'super_admin';
}

export async function parseJsonBody(request) {
  try { return await request.json(); } catch { return null; }
}
