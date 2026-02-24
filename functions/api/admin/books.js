// POST /api/admin/books — 创建新书籍
import { checkAdmin, parseJsonBody, requireMinRole } from '../_utils.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  const auth = await checkAdmin(request, env);
  if (!auth.ok) {
    const status = auth.reason === 'locked' ? 429 : 401;
    const msg = auth.reason === 'locked' ? 'Too many failed attempts, try again later' : 'Unauthorized';
    return Response.json({ error: msg }, { status });
  }

  // demo 用户配额：最多 10 本书
  if (!requireMinRole(auth, 'admin')) {
    const { count } = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM books WHERE created_by = ?'
    ).bind(auth.userId).first();
    if (count >= 10) return Response.json({ error: '演示账号最多创建 10 本书' }, { status: 403 });
  }

  const body = await parseJsonBody(request);
  if (!body) return Response.json({ error: 'Invalid JSON' }, { status: 400 });

  const { title, description, author } = body;

  if (!title || typeof title !== 'string' || title.trim().length === 0) {
    return Response.json({ error: 'Title is required' }, { status: 400 });
  }
  if (title.length > 200) {
    return Response.json({ error: 'Title too long (max 200)' }, { status: 400 });
  }

  const result = await env.DB.prepare(`
    INSERT INTO books (title, description, author, created_by) VALUES (?, ?, ?, ?)
  `).bind(
    title.trim(),
    (description || '').trim().slice(0, 2000),
    (author || '').trim().slice(0, 100),
    auth.userId
  ).run();

  return Response.json({
    success: true,
    book: { id: result.meta.last_row_id, title: title.trim() }
  }, { status: 201 });
}
