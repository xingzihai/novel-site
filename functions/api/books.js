// GET /api/books — 获取所有书籍列表（含标签）
import { checkAdmin } from './_utils.js';

export async function onRequestGet(context) {
  const { request, env } = context;

  // 验证 token 有效性，而非仅检查 header 存在（防止伪造 header 获取 created_by）
  let isAdmin = false;
  if (request.headers.get('Authorization')?.startsWith('Bearer ')) {
    const auth = await checkAdmin(request, env);
    isAdmin = auth.ok;
  }

  // 始终查询 created_by，在非管理员响应中过滤掉
  const { results } = await env.DB.prepare(`
    SELECT b.id, b.title, b.author, b.description, b.cover_key, b.created_at, b.updated_at,
      b.created_by,
      (SELECT COUNT(*) FROM chapters WHERE book_id = b.id) as chapter_count,
      (SELECT COALESCE(SUM(word_count), 0) FROM chapters WHERE book_id = b.id) as total_words
    FROM books b
    ORDER BY b.updated_at DESC
  `).all();

  // 非管理员请求不返回 created_by
  if (!isAdmin) {
    for (const book of results) {
      delete book.created_by;
    }
  }

  // 批量获取所有书籍的标签
  let allBookTags = [];
  try {
    const { results: btResults } = await env.DB.prepare(`
      SELECT bt.book_id, t.id as tag_id, t.name, t.color
      FROM book_tags bt JOIN tags t ON bt.tag_id = t.id
    `).all();
    allBookTags = btResults || [];
  } catch {}

  const tagsByBook = {};
  for (const bt of allBookTags) {
    if (!tagsByBook[bt.book_id]) tagsByBook[bt.book_id] = [];
    tagsByBook[bt.book_id].push({ id: bt.tag_id, name: bt.name, color: bt.color });
  }

  for (const book of results) {
    book.tags = tagsByBook[book.id] || [];
  }

  return Response.json({ books: results });
}
