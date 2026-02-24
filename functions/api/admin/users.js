// 管理员管理API（仅super_admin可用）
import { checkAdmin, requireSuperAdmin, validateId, hashPassword, parseJsonBody } from '../_utils.js';

// GET: 获取管理员列表
export async function onRequestGet(context) {
  const { request, env } = context;
  const auth = await checkAdmin(request, env);
  if (!auth.ok) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (!requireSuperAdmin(auth)) return Response.json({ error: '仅超级管理员可管理用户' }, { status: 403 });

  const { results } = await env.DB.prepare(
    "SELECT id, username, role, password_locked, github_id, github_login, avatar_url, created_at, updated_at FROM admin_users ORDER BY id"
  ).all();
  return Response.json({ admins: results });
}

// POST: 创建新管理员
export async function onRequestPost(context) {
  const { request, env } = context;
  const auth = await checkAdmin(request, env);
  if (!auth.ok) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (!requireSuperAdmin(auth)) return Response.json({ error: '仅超级管理员可管理用户' }, { status: 403 });

  const body = await parseJsonBody(request);
  if (!body) return Response.json({ error: '无效的请求' }, { status: 400 });

  const { username, password, role, password_locked } = body;
  if (!username || !password) return Response.json({ error: '用户名和密码不能为空' }, { status: 400 });
  if (username.length < 2 || username.length > 32) return Response.json({ error: '用户名长度2-32位' }, { status: 400 });
  if (!/^[a-zA-Z0-9_]+$/.test(username)) return Response.json({ error: '用户名只能包含字母数字下划线' }, { status: 400 });
  if (password.length < 8) return Response.json({ error: '密码至少8位' }, { status: 400 });
  if (password.length > 128) return Response.json({ error: '密码最长128位' }, { status: 400 });
  if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) return Response.json({ error: '密码需包含字母和数字' }, { status: 400 });

  const validRoles = ['super_admin', 'admin', 'demo'];
  const userRole = validRoles.includes(role) ? role : 'demo';
  const pwdLocked = password_locked === 1 ? 1 : 0;

  const existing = await env.DB.prepare('SELECT id FROM admin_users WHERE username = ?').bind(username).first();
  if (existing) return Response.json({ error: '用户名已存在' }, { status: 409 });

  const passwordHash = await hashPassword(password);

  await env.DB.prepare("INSERT INTO admin_users (username, password_hash, role, password_locked) VALUES (?, ?, ?, ?)")
    .bind(username, passwordHash, userRole, pwdLocked).run();

  return Response.json({ success: true, message: `管理员 ${username} 创建成功` });
}

// DELETE: 删除管理员
export async function onRequestDelete(context) {
  const { request, env } = context;
  const auth = await checkAdmin(request, env);
  if (!auth.ok) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (!requireSuperAdmin(auth)) return Response.json({ error: '仅超级管理员可管理用户' }, { status: 403 });

  const body = await parseJsonBody(request);
  if (!body || !body.id) return Response.json({ error: '缺少用户ID' }, { status: 400 });
  if (!validateId(String(body.id))) return Response.json({ error: '无效的用户ID' }, { status: 400 });

  // 不能删除自己
  if (String(body.id) === String(auth.userId)) return Response.json({ error: '不能删除自己' }, { status: 400 });

  const user = await env.DB.prepare('SELECT username, role FROM admin_users WHERE id = ?').bind(body.id).first();
  if (!user) return Response.json({ error: '用户不存在' }, { status: 404 });

  // 保护最后一个super_admin
  if (user.role === 'super_admin') {
    const { count } = await env.DB.prepare("SELECT COUNT(*) as count FROM admin_users WHERE role = 'super_admin'").first();
    if (count <= 1) return Response.json({ error: '不能删除最后一个超级管理员' }, { status: 400 });
  }

  await env.DB.prepare('DELETE FROM admin_sessions WHERE user_id = ?').bind(body.id).run();
  // 将该用户创建的书籍转移给第一个超管
  const superAdmin = await env.DB.prepare(
    "SELECT id FROM admin_users WHERE role = 'super_admin' AND id != ? ORDER BY id ASC LIMIT 1"
  ).bind(body.id).first();
  const newOwner = superAdmin ? superAdmin.id : auth.userId;
  await env.DB.prepare('UPDATE books SET created_by = ? WHERE created_by = ?').bind(newOwner, body.id).run();
  await env.DB.prepare('DELETE FROM admin_users WHERE id = ?').bind(body.id).run();

  return Response.json({ success: true, message: `管理员 ${user.username} 已删除` });
}

// PUT: 修改管理员角色
export async function onRequestPut(context) {
  const { request, env } = context;
  const auth = await checkAdmin(request, env);
  if (!auth.ok) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (!requireSuperAdmin(auth)) return Response.json({ error: '仅超级管理员可管理用户' }, { status: 403 });

  const body = await parseJsonBody(request);
  if (!body || !body.id) return Response.json({ error: '缺少参数' }, { status: 400 });
  if (!validateId(String(body.id))) return Response.json({ error: '无效的用户ID' }, { status: 400 });

  // 至少要有 role 或 password_locked 其中一个
  const hasRole = body.role !== undefined;
  const hasPwdLock = body.password_locked !== undefined;
  if (!hasRole && !hasPwdLock) return Response.json({ error: '缺少参数' }, { status: 400 });

  if (hasRole) {
    const validRoles = ['super_admin', 'admin', 'demo'];
    if (!validRoles.includes(body.role)) return Response.json({ error: '无效的角色' }, { status: 400 });

    // 不能降级自己
    if (String(body.id) === String(auth.userId) && body.role !== 'super_admin') {
      return Response.json({ error: '不能降级自己的权限' }, { status: 400 });
    }

    // 保护最后一个super_admin不被降级
    if (body.role !== 'super_admin') {
      const target = await env.DB.prepare('SELECT role FROM admin_users WHERE id = ?').bind(body.id).first();
      if (target && target.role === 'super_admin') {
        const { count } = await env.DB.prepare("SELECT COUNT(*) as count FROM admin_users WHERE role = 'super_admin'").first();
        if (count <= 1) return Response.json({ error: '不能降级最后一个超级管理员' }, { status: 400 });
      }
    }
  }

  // 构建动态 UPDATE
  const sets = [];
  const binds = [];
  if (hasRole) { sets.push('role = ?'); binds.push(body.role); }
  if (hasPwdLock) { sets.push('password_locked = ?'); binds.push(body.password_locked === 1 ? 1 : 0); }
  sets.push("updated_at = datetime('now')");
  binds.push(body.id);

  await env.DB.prepare(`UPDATE admin_users SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...binds).run();

  // 角色变更时清除目标用户所有 session，强制重新登录
  if (hasRole) {
    await env.DB.prepare('DELETE FROM admin_sessions WHERE user_id = ?').bind(body.id).run().catch(() => {});
  }

  return Response.json({ success: true });
}
