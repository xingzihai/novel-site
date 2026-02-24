// CRUD /api/admin/tags — 标签管理
import { checkAdmin, parseJsonBody, validateId } from '../_utils.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const auth = await checkAdmin(request, env);
  if (!auth.ok) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { results } = await env.DB.prepare(`
    SELECT t.*, (SELECT COUNT(*) FROM book_tags WHERE tag_id = t.id) as book_count
    FROM tags t ORDER BY t.name ASC
  `).all();
  return Response.json({ tags: results });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const auth = await checkAdmin(request, env);
  if (!auth.ok) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await parseJsonBody(request);
  if (!body) return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  const { name, color } = body;
  if (!name || typeof name !== 'string' || !name.trim()) return Response.json({ error: 'Name required' }, { status: 400 });

  try {
    const r = await env.DB.prepare('INSERT INTO tags (name, color) VALUES (?, ?)').bind(name.trim(), color || '#888').run();
    return Response.json({ success: true, tag: { id: r.meta.last_row_id, name: name.trim(), color: color || '#888' } }, { status: 201 });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) return Response.json({ error: 'Tag already exists' }, { status: 409 });
    return Response.json({ error: 'Failed to create tag' }, { status: 500 });
  }
}

export async function onRequestPut(context) {
  const { request, env } = context;
  const auth = await checkAdmin(request, env);
  if (!auth.ok) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await parseJsonBody(request);
  if (!body || !body.id) return Response.json({ error: 'Tag id required' }, { status: 400 });

  const sets = [], vals = [];
  if (body.name) { sets.push('name = ?'); vals.push(body.name.trim()); }
  if (body.color) { sets.push('color = ?'); vals.push(body.color); }
  if (sets.length === 0) return Response.json({ error: 'Nothing to update' }, { status: 400 });

  vals.push(body.id);
  await env.DB.prepare(`UPDATE tags SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  return Response.json({ success: true });
}

export async function onRequestDelete(context) {
  const { request, env } = context;
  const auth = await checkAdmin(request, env);
  if (!auth.ok) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await parseJsonBody(request);
  if (!body || !body.id) return Response.json({ error: 'Tag id required' }, { status: 400 });

  await env.DB.prepare('DELETE FROM book_tags WHERE tag_id = ?').bind(body.id).run();
  await env.DB.prepare('DELETE FROM tags WHERE id = ?').bind(body.id).run();
  return Response.json({ success: true });
}
