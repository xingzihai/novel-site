// PUT /api/admin/settings — 更新站点设置
// GET /api/admin/settings/github — 读取 GitHub OAuth 配置（仅超管）
// PUT /api/admin/settings/github — 保存 GitHub OAuth 配置（仅超管）
import { checkAdmin, requireSuperAdmin, parseJsonBody } from '../_utils.js';

const ALLOWED_KEYS = ['site_name', 'site_desc', 'footer_text'];
const MAX_VALUE_LENGTH = 500;

export async function onRequestPut(context) {
  const { request, env } = context;

  const auth = await checkAdmin(request, env);
  if (!auth.ok) {
    const status = auth.reason === 'locked' ? 429 : 401;
    const msg = auth.reason === 'locked' ? 'Too many failed attempts, try again later' : 'Unauthorized';
    return Response.json({ error: msg }, { status });
  }
  if (!requireSuperAdmin(auth)) return Response.json({ error: '仅超级管理员可修改设置' }, { status: 403 });

  const body = await parseJsonBody(request);
  if (!body || typeof body.settings !== 'object') {
    return Response.json({ error: 'Invalid request, expected { settings: { key: value } }' }, { status: 400 });
  }

  const updates = [];
  for (const [key, value] of Object.entries(body.settings)) {
    if (!ALLOWED_KEYS.includes(key)) continue;
    if (typeof value !== 'string') continue;
    const trimmed = value.trim().slice(0, MAX_VALUE_LENGTH);
    updates.push(
      env.DB.prepare('INSERT OR REPLACE INTO site_settings (key, value) VALUES (?, ?)')
        .bind(key, trimmed)
    );
  }

  if (updates.length > 0) {
    await env.DB.batch(updates);
  }

  return Response.json({ success: true, updated: updates.length });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const auth = await checkAdmin(request, env);
  if (!auth.ok) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (!requireSuperAdmin(auth)) return Response.json({ error: '仅超级管理员可查看' }, { status: 403 });

  const url = new URL(request.url);
  // GET /api/admin/settings?section=github
  if (url.searchParams.get('section') === 'github') {
    const enabled = await env.DB.prepare("SELECT value FROM site_settings WHERE key = 'github_oauth_enabled'").first();
    const clientId = await env.DB.prepare("SELECT value FROM site_settings WHERE key = 'github_client_id'").first();
    const hasSecret = await env.DB.prepare("SELECT value FROM site_settings WHERE key = 'github_client_secret'").first();
    const demoLimitRow = await env.DB.prepare("SELECT value FROM site_settings WHERE key = 'demo_user_limit'").first();
    return Response.json({
      enabled: enabled?.value === 'true',
      clientId: clientId?.value || '',
      hasSecret: !!hasSecret?.value,
      demoLimit: demoLimitRow ? Number(demoLimitRow.value) : 100,
    });
  }

  return Response.json({ error: 'Unknown section' }, { status: 400 });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const auth = await checkAdmin(request, env);
  if (!auth.ok) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (!requireSuperAdmin(auth)) return Response.json({ error: '仅超级管理员可修改' }, { status: 403 });

  const body = await parseJsonBody(request);
  if (!body) return Response.json({ error: 'Invalid JSON' }, { status: 400 });

  const url = new URL(request.url);
  // POST /api/admin/settings?section=github
  if (url.searchParams.get('section') === 'github') {
    const { enabled, clientId, clientSecret, demoLimit } = body;

    // 保存启用状态
    await env.DB.prepare("INSERT OR REPLACE INTO site_settings (key, value) VALUES ('github_oauth_enabled', ?)")
      .bind(enabled ? 'true' : 'false').run();

    // 保存 Client ID
    if (clientId !== undefined) {
      const id = (clientId || '').trim().slice(0, 100);
      await env.DB.prepare("INSERT OR REPLACE INTO site_settings (key, value) VALUES ('github_client_id', ?)")
        .bind(id).run();
    }

    // 保存 Client Secret（只在提供了新值时更新）
    if (clientSecret && clientSecret.trim()) {
      await env.DB.prepare("INSERT OR REPLACE INTO site_settings (key, value) VALUES ('github_client_secret', ?)")
        .bind(clientSecret.trim().slice(0, 200)).run();
    }

    // 保存 Demo 用户上限
    if (demoLimit !== undefined) {
      const limit = Math.max(0, Math.min(10000, Math.floor(Number(demoLimit) || 0)));
      await env.DB.prepare("INSERT OR REPLACE INTO site_settings (key, value) VALUES ('demo_user_limit', ?)")
        .bind(String(limit)).run();
    }

    return Response.json({ success: true });
  }

  return Response.json({ error: 'Unknown section' }, { status: 400 });
}
