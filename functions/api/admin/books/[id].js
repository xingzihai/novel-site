// PUT /api/admin/books/:id — 编辑书籍
// DELETE /api/admin/books/:id — 删除书籍（含所有章节）
import { checkAdmin, validateId, parseJsonBody, checkBookOwnership } from '../../_utils.js';

async function authCheck(request, env) {
  const auth = await checkAdmin(request, env);
  if (!auth.ok) {
    const status = auth.reason === 'locked' ? 429 : 401;
    const msg = auth.reason === 'locked' ? 'Too many failed attempts, try again later' : 'Unauthorized';
    return { denied: Response.json({ error: msg }, { status }) };
  }
  return { auth };
}

export async function onRequestPut(context) {
  const { request, env, params } = context;
  const { denied, auth } = await authCheck(request, env);
  if (denied) return denied;
  if (!validateId(params.id)) return Response.json({ error: 'Invalid ID' }, { status: 400 });

  const book = await env.DB.prepare('SELECT * FROM books WHERE id = ?').bind(params.id).first();
  if (!book) return Response.json({ error: 'Book not found' }, { status: 404 });

  // demo只能编辑自己的书
  if (!await checkBookOwnership(auth, env, params.id)) {
    return Response.json({ error: '只能编辑自己创建的书籍' }, { status: 403 });
  }

  const body = await parseJsonBody(request);
  if (!body) return Response.json({ error: 'Invalid JSON' }, { status: 400 });

  const title = (body.title || book.title || '').trim().slice(0, 200);
  const author = (body.author ?? book.author ?? '').trim().slice(0, 100);
  const description = (body.description ?? book.description ?? '').trim().slice(0, 2000);

  await env.DB.prepare(`
    UPDATE books SET title = ?, author = ?, description = ?, updated_at = datetime('now') WHERE id = ?
  `).bind(title, author, description, params.id).run();

  return Response.json({ success: true });
}

export async function onRequestDelete(context) {
  const { request, env, params } = context;
  const { denied, auth } = await authCheck(request, env);
  if (denied) return denied;
  if (!validateId(params.id)) return Response.json({ error: 'Invalid ID' }, { status: 400 });

  const book = await env.DB.prepare('SELECT * FROM books WHERE id = ?').bind(params.id).first();
  if (!book) return Response.json({ error: 'Book not found' }, { status: 404 });

  // demo只能删除自己的书
  if (!await checkBookOwnership(auth, env, params.id)) {
    return Response.json({ error: '只能删除自己创建的书籍' }, { status: 403 });
  }

  const { results: chapters } = await env.DB.prepare('SELECT content_key FROM chapters WHERE book_id = ?')
    .bind(params.id).all();
  for (const c of chapters) {
    await env.R2.delete(c.content_key).catch(() => {});
  }

  // 删除封面
  if (book.cover_key) await env.R2.delete(book.cover_key).catch(() => {});

  await env.DB.batch([
    env.DB.prepare('DELETE FROM chapter_stats WHERE chapter_id IN (SELECT id FROM chapters WHERE book_id = ?)').bind(params.id),
    env.DB.prepare('DELETE FROM book_stats WHERE book_id = ?').bind(params.id),
    env.DB.prepare('DELETE FROM book_tags WHERE book_id = ?').bind(params.id),
    env.DB.prepare('DELETE FROM chapters WHERE book_id = ?').bind(params.id),
    env.DB.prepare('DELETE FROM books WHERE id = ?').bind(params.id),
  ]);

  return Response.json({ success: true });
}
