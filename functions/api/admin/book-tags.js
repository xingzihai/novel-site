// PUT /api/admin/book-tags — 设置书籍标签
import { checkAdmin, parseJsonBody, validateId, checkBookOwnership } from '../_utils.js';

export async function onRequestPut(context) {
  const { request, env } = context;
  const auth = await checkAdmin(request, env);
  if (!auth.ok) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await parseJsonBody(request);
  if (!body || !body.book_id) return Response.json({ error: 'book_id required' }, { status: 400 });
  if (!validateId(String(body.book_id))) return Response.json({ error: 'Invalid book_id' }, { status: 400 });
  if (!Array.isArray(body.tag_ids)) return Response.json({ error: 'tag_ids array required' }, { status: 400 });
  if (body.tag_ids.length > 20) return Response.json({ error: '最多 20 个标签' }, { status: 400 });

  // 验证每个 tag_id
  for (const tagId of body.tag_ids) {
    if (!validateId(String(tagId))) return Response.json({ error: 'Invalid tag_id: ' + tagId }, { status: 400 });
  }

  const bookId = body.book_id;

  // demo只能给自己的书打标签
  if (!await checkBookOwnership(auth, env, bookId)) {
    return Response.json({ error: '只能管理自己书籍的标签' }, { status: 403 });
  }

  await env.DB.prepare('DELETE FROM book_tags WHERE book_id = ?').bind(bookId).run();

  for (const tagId of body.tag_ids) {
    await env.DB.prepare('INSERT OR IGNORE INTO book_tags (book_id, tag_id) VALUES (?, ?)').bind(bookId, tagId).run();
  }

  return Response.json({ success: true });
}
