// PUT /api/admin/book-tags — 设置书籍标签
import { checkAdmin, parseJsonBody, validateId } from '../_utils.js';

export async function onRequestPut(context) {
  const { request, env } = context;
  const auth = await checkAdmin(request, env);
  if (!auth.ok) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await parseJsonBody(request);
  if (!body || !body.book_id) return Response.json({ error: 'book_id required' }, { status: 400 });
  if (!Array.isArray(body.tag_ids)) return Response.json({ error: 'tag_ids array required' }, { status: 400 });

  const bookId = body.book_id;
  await env.DB.prepare('DELETE FROM book_tags WHERE book_id = ?').bind(bookId).run();

  for (const tagId of body.tag_ids) {
    await env.DB.prepare('INSERT OR IGNORE INTO book_tags (book_id, tag_id) VALUES (?, ?)').bind(bookId, tagId).run();
  }

  return Response.json({ success: true });
}
