// POST /api/auth/logout — 登出
import { checkAdmin, sha256Hash, clearAuthCookie } from '../_utils.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  const auth = await checkAdmin(request, env);
  if (auth.ok && auth._token) {
    const tokenHash = await sha256Hash(auth._token);
    await env.DB.prepare('DELETE FROM admin_sessions WHERE token = ?').bind(tokenHash).run().catch(() => {});
  }

  return new Response(JSON.stringify({ success: true }), {
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': clearAuthCookie()
    }
  });
}
