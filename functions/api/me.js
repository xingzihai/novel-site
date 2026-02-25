// GET /api/me — 获取当前登录用户信息（轻量验证端点）
import { checkAdmin } from './_utils.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const auth = await checkAdmin(request, env);
  if (!auth.ok) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  return Response.json({
    userId: auth.userId,
    username: auth.username,
    role: auth.role
  });
}
