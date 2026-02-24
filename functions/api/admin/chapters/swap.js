// POST /api/admin/chapters/swap — 交换两个章节的排序（原子操作）
import { checkAdmin, validateId, parseJsonBody, checkBookOwnership } from '../../_utils.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  const auth = await checkAdmin(request, env);
  if (!auth.ok) {
    const status = auth.reason === 'locked' ? 429 : 401;
    const msg = auth.reason === 'locked' ? 'Too many failed attempts, try again later' : 'Unauthorized';
    return Response.json({ error: msg }, { status });
  }

  const body = await parseJsonBody(request);
  if (!body) return Response.json({ error: 'Invalid JSON' }, { status: 400 });

  const { id1, id2 } = body;
  if (!id1 || !id2 || !validateId(String(id1)) || !validateId(String(id2))) {
    return Response.json({ error: 'Invalid chapter IDs' }, { status: 400 });
  }
  if (String(id1) === String(id2)) {
    return Response.json({ error: 'IDs must be different' }, { status: 400 });
  }

  const c1 = await env.DB.prepare('SELECT id, book_id, sort_order FROM chapters WHERE id = ?').bind(id1).first();
  const c2 = await env.DB.prepare('SELECT id, book_id, sort_order FROM chapters WHERE id = ?').bind(id2).first();
  if (!c1 || !c2) return Response.json({ error: 'Chapter not found' }, { status: 404 });

  // 必须属于同一本书
  if (c1.book_id !== c2.book_id) {
    return Response.json({ error: '只能交换同一本书的章节' }, { status: 400 });
  }

  // demo只能操作自己书的章节（两侧都检查）
  if (!await checkBookOwnership(auth, env, c1.book_id)) {
    return Response.json({ error: '只能操作自己书籍的章节' }, { status: 403 });
  }
  if (!await checkBookOwnership(auth, env, c2.book_id)) {
    return Response.json({ error: '只能操作自己书籍的章节' }, { status: 403 });
  }

  // 原子操作：batch交换sort_order
  await env.DB.batch([
    env.DB.prepare('UPDATE chapters SET sort_order = ? WHERE id = ?').bind(c2.sort_order, c1.id),
    env.DB.prepare('UPDATE chapters SET sort_order = ? WHERE id = ?').bind(c1.sort_order, c2.id),
  ]);

  return Response.json({ success: true });
}
