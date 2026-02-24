// GET /api/auth/github/callback — GitHub OAuth 回调
import { hmacVerify, sha256Hash, createSession } from '../../_utils.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  // GitHub 返回错误（用户拒绝授权等）
  if (error) {
    return new Response(null, {
      status: 302,
      headers: { 'Location': '/admin.html#github_error=' + encodeURIComponent(error) }
    });
  }

  if (!code || !state) {
    return new Response('Missing code or state', { status: 400 });
  }

  // 1. 验证 state（从签名 cookie 中取出）
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(/__Host-github_oauth_state=([^;]+)/);
  if (!match) {
    return new Response('Missing state cookie', { status: 403 });
  }

  const [stateValue, signature] = match[1].split('.');
  if (!stateValue || !signature || stateValue !== state) {
    return new Response('Invalid state', { status: 403 });
  }

  // 从 DB 检查 state 是否已消费（一次性使用）
  const stateKey = 'oauth_state:' + stateValue;
  const stateRow = await env.DB.prepare("SELECT value FROM site_settings WHERE key = ?").bind(stateKey).first();
  if (!stateRow) {
    return new Response('State already consumed or expired', { status: 403 });
  }
  // 立即删除，确保一次性消费
  await env.DB.prepare("DELETE FROM site_settings WHERE key = ?").bind(stateKey).run();

  // 检查 state 是否过期
  if (new Date(stateRow.value) < new Date()) {
    return new Response('State expired', { status: 403 });
  }

  // 从 DB 读取 client_secret 用于验证 HMAC
  const clientSecretRow = await env.DB.prepare("SELECT value FROM site_settings WHERE key = 'github_client_secret'").first();
  if (!clientSecretRow?.value) {
    return new Response(null, {
      status: 302,
      headers: { 'Location': '/admin.html#github_error=oauth_not_configured' }
    });
  }

  // HMAC 验证用独立密钥（ADMIN_PASSWORD），不复用 client_secret
  const hmacKey = env.ADMIN_PASSWORD || clientSecretRow.value;
  const valid = await hmacVerify(stateValue, signature, hmacKey);
  if (!valid) {
    return new Response('State signature invalid', { status: 403 });
  }

  // 2. 从 DB 读取 GitHub OAuth 配置（client_secret 已在上面读取）
  const clientIdRow = await env.DB.prepare("SELECT value FROM site_settings WHERE key = 'github_client_id'").first();
  if (!clientIdRow?.value) {
    return new Response(null, {
      status: 302,
      headers: { 'Location': '/admin.html#github_error=oauth_not_configured' }
    });
  }

  // 3. 用 code 换 access_token
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: clientIdRow.value,
      client_secret: clientSecretRow.value,
      code,
    }),
  });
  const tokenData = await tokenRes.json();

  if (tokenData.error) {
    return new Response(null, {
      status: 302,
      headers: { 'Location': '/admin.html#github_error=' + encodeURIComponent(tokenData.error_description || tokenData.error) }
    });
  }

  // 3. 用 access_token 获取用户信息
  const userRes = await fetch('https://api.github.com/user', {
    headers: {
      'Authorization': `Bearer ${tokenData.access_token}`,
      'User-Agent': 'novel-site',
      'Accept': 'application/json',
    },
  });

  if (!userRes.ok) {
    return new Response(null, {
      status: 302,
      headers: { 'Location': '/admin.html#github_error=failed_to_get_user' }
    });
  }

  const ghUser = await userRes.json();
  // access_token 到此为止，不存储

  // 4. 防滥用：检查 GitHub 账号年龄（至少 7 天）
  const accountAge = Date.now() - new Date(ghUser.created_at).getTime();
  if (accountAge < 7 * 24 * 60 * 60 * 1000) {
    return new Response(null, {
      status: 302,
      headers: { 'Location': '/admin.html#github_error=' + encodeURIComponent('GitHub 账号创建不足 7 天，暂不允许注册') }
    });
  }

  // 5. 查找或创建用户
  let user = await env.DB.prepare(
    'SELECT id, username, role FROM admin_users WHERE github_id = ?'
  ).bind(ghUser.id).first();

  if (!user) {
    // 防滥用：限制 demo 用户总数
    const { count } = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM admin_users WHERE role = 'demo' AND github_id IS NOT NULL"
    ).first();
    if (count >= 100) {
      return new Response(null, {
        status: 302,
        headers: { 'Location': '/admin.html#github_error=' + encodeURIComponent('Demo 注册名额已满') }
      });
    }

    // 首次登录：自动注册为 demo
    const username = 'gh_' + ghUser.login.slice(0, 28);
    // 确保用户名唯一
    const existing = await env.DB.prepare('SELECT id FROM admin_users WHERE username = ?').bind(username).first();
    const finalUsername = existing ? username + '_' + ghUser.id : username;

    await env.DB.prepare(
      "INSERT INTO admin_users (username, password_hash, role, github_id, github_login, avatar_url) VALUES (?, 'github_oauth:no_password', 'demo', ?, ?, ?)"
    ).bind(finalUsername, ghUser.id, ghUser.login, ghUser.avatar_url || '').run();

    user = await env.DB.prepare(
      'SELECT id, username, role FROM admin_users WHERE github_id = ?'
    ).bind(ghUser.id).first();
  } else {
    // 已有用户：更新 GitHub 信息（用户名/头像可能变了）
    await env.DB.prepare(
      "UPDATE admin_users SET github_login = ?, avatar_url = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(ghUser.login, ghUser.avatar_url || '', user.id).run();
  }

  // 6. 创建 session token（复用现有机制）
  const session = await createSession(env, user.id);

  // 7. 重定向回前端，token 通过 URL hash 传递（hash 不会发送到服务器）
  const clearCookie = '__Host-github_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
  return new Response(null, {
    status: 302,
    headers: {
      'Location': `/admin.html#github_token=${session.token}`,
      'Set-Cookie': clearCookie,
    }
  });
}
