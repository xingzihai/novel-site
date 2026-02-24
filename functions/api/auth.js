// POST /api/auth/login — 管理员登录
// POST /api/auth/logout — 登出
// POST /api/auth/password — 修改密码
// GET /api/auth/me — 验证当前session
import { login, checkAdmin, changePassword, parseJsonBody, sha256Hash, hmacSign } from './_utils.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // 路由分发（Pages Functions不支持深层动态路由，用query参数区分）
  const action = url.searchParams.get('action');

  if (action === 'login') {
    const body = await parseJsonBody(request);
    if (!body) return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    const { username, password } = body;
    if (!username || !password) return Response.json({ error: 'Username and password required' }, { status: 400 });

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const result = await login(env, username.trim(), password, ip);

    if (!result.ok) {
      const status = result.reason === 'locked' ? 429 : 401;
      const msg = result.reason === 'locked' ? '登录失败次数过多，请10分钟后再试'
        : result.reason === 'github_only' ? '该账号请使用 GitHub 登录'
        : '用户名或密码错误';
      return Response.json({ error: msg }, { status });
    }

    return Response.json({
      success: true,
      token: result.token,
      username: result.username,
      role: result.role,
      userId: result.userId,
      expiresAt: result.expiresAt
    });
  }

  if (action === 'logout') {
    const auth = await checkAdmin(request, env);
    if (!auth.ok) return Response.json({ success: true });
    const token = request.headers.get('Authorization').slice(7);
    const tokenHash = await sha256Hash(token);
    await env.DB.prepare('DELETE FROM admin_sessions WHERE token = ?').bind(tokenHash).run();
    return Response.json({ success: true });
  }

  if (action === 'password') {
    const auth = await checkAdmin(request, env);
    if (!auth.ok) {
      const status = auth.reason === 'locked' ? 429 : 401;
      return Response.json({ error: 'Unauthorized' }, { status });
    }
    if (auth.passwordLocked || auth.role === 'demo') {
      return Response.json({ error: '该账号不允许修改密码' }, { status: 403 });
    }
    const body = await parseJsonBody(request);
    if (!body) return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    const { oldPassword, newPassword } = body;
    if (!oldPassword || !newPassword) return Response.json({ error: '请填写旧密码和新密码' }, { status: 400 });

    const result = await changePassword(env, auth.userId, oldPassword, newPassword);
    if (!result.ok) {
      const msg = result.reason === 'wrong_old' ? '旧密码错误'
        : result.reason === 'too_short' ? '新密码至少8位'
        : result.reason === 'too_weak' ? '新密码需包含字母和数字'
        : '修改失败';
      return Response.json({ error: msg }, { status: 400 });
    }

    return Response.json({ success: true, message: '密码已修改，请重新登录' });
  }

  return Response.json({ error: 'Unknown action' }, { status: 400 });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  if (action === 'me') {
    const auth = await checkAdmin(request, env);
    if (!auth.ok) return Response.json({ authenticated: false }, { status: 401 });
    // 查 GitHub 信息
    const userExtra = await env.DB.prepare('SELECT github_login, avatar_url FROM admin_users WHERE id = ?').bind(auth.userId).first();
    return Response.json({
      authenticated: true, username: auth.username, role: auth.role, userId: auth.userId,
      passwordLocked: auth.passwordLocked,
      githubLogin: userExtra?.github_login || null,
      avatarUrl: userExtra?.avatar_url || null,
    });
  }

  if (action === 'github-login') {
    // 从 DB 读取 GitHub OAuth 配置
    const enabled = await env.DB.prepare("SELECT value FROM site_settings WHERE key = 'github_oauth_enabled'").first();
    if (enabled?.value !== 'true') {
      return Response.json({ error: 'GitHub 登录未启用' }, { status: 400 });
    }
    const clientIdRow = await env.DB.prepare("SELECT value FROM site_settings WHERE key = 'github_client_id'").first();
    const clientSecretRow = await env.DB.prepare("SELECT value FROM site_settings WHERE key = 'github_client_secret'").first();
    if (!clientIdRow?.value || !clientSecretRow?.value) {
      return Response.json({ error: 'GitHub OAuth 未配置' }, { status: 500 });
    }

    // 生成随机 state
    const stateBytes = new Uint8Array(32);
    crypto.getRandomValues(stateBytes);
    const state = [...stateBytes].map(b => b.toString(16).padStart(2, '0')).join('');

    // HMAC 签名 state，用 ADMIN_PASSWORD 作为独立密钥（不复用 client_secret）
    const hmacKey = env.ADMIN_PASSWORD || clientSecretRow.value;
    const signature = await hmacSign(state, hmacKey);
    const cookie = `__Host-github_oauth_state=${state}.${signature}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;

    // state 存 DB 做一次性消费
    await env.DB.prepare(
      "INSERT INTO site_settings (key, value) VALUES (?, datetime('now', '+10 minutes'))"
    ).bind('oauth_state:' + state).run().catch(() => {});

    const redirectUri = new URL('/api/auth/github/callback', url.origin).toString();
    const params = new URLSearchParams({
      client_id: clientIdRow.value,
      redirect_uri: redirectUri,
      scope: '',
      state,
    });

    return new Response(null, {
      status: 302,
      headers: {
        'Location': `https://github.com/login/oauth/authorize?${params}`,
        'Set-Cookie': cookie,
      }
    });
  }

  return Response.json({ error: 'Unknown action' }, { status: 400 });
}
