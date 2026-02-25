// GET /api/books/:id — 获取书籍详情 + 章节目录 + 标签
import { validateId } from '../_utils.js';

export async function onRequestGet(context) {
  const { env, params } = context;
  const id = params.id;

  if (!validateId(id)) {
    return Response.json({ error: 'Invalid book ID' }, { status: 400 });
  }

  const book = await env.DB.prepare(
    `SELECT b.id, b.title, b.author, b.description, b.cover_key, b.status,
      b.annotation_enabled, b.annotation_locked,
      b.created_at, b.updated_at,
      u.username as uploader, u.avatar_url as uploader_avatar
    FROM books b LEFT JOIN admin_users u ON b.created_by = u.id
    WHERE b.id = ?`
  ).bind(id).first();

  if (!book) {
    return Response.json({ error: 'Book not found' }, { status: 404 });
  }

  // 下架或待删除的书籍，公开访问返回404
  if (book.status && book.status !== 'normal') {
    return Response.json({ error: 'Book not found' }, { status: 404 });
  }

  // 不暴露 status 字段给公开 API
  delete book.status;

  const { results: chapters } = await env.DB.prepare(`
    SELECT id, title, sort_order, word_count, created_at, updated_at
    FROM chapters WHERE book_id = ? ORDER BY sort_order ASC
  `).bind(id).all();

  // 获取标签
  let tags = [];
  try {
    const { results: tagResults } = await env.DB.prepare(`
      SELECT t.id, t.name, t.color FROM book_tags bt JOIN tags t ON bt.tag_id = t.id WHERE bt.book_id = ?
    `).bind(id).all();
    tags = tagResults || [];
  } catch {}
  book.tags = tags;

  return Response.json({ book, chapters });
}
