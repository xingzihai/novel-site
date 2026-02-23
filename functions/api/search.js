// GET /api/search?q=keyword&book_id=1 — 搜索书籍或章节内容
export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  const bookId = url.searchParams.get('book_id');

  if (!q || q.length < 1) {
    return Response.json({ error: 'Query too short' }, { status: 400 });
  }

  // 限制查询长度
  const query = q.slice(0, 50);
  const like = `%${query}%`;

  // 如果指定了 book_id，搜索该书的章节标题
  if (bookId && /^\d+$/.test(bookId)) {
    const { results } = await env.DB.prepare(
      `SELECT id, title, word_count, sort_order FROM chapters 
       WHERE book_id = ? AND title LIKE ? 
       ORDER BY sort_order ASC LIMIT 50`
    ).bind(bookId, like).all();

    return Response.json({ chapters: results });
  }

  // 否则搜索书籍（书名 + 作者）
  const { results } = await env.DB.prepare(
    `SELECT b.*, 
      (SELECT COUNT(*) FROM chapters WHERE book_id = b.id) as chapter_count,
      (SELECT COALESCE(SUM(word_count), 0) FROM chapters WHERE book_id = b.id) as total_words
     FROM books b 
     WHERE b.title LIKE ? OR b.author LIKE ?
     ORDER BY b.updated_at DESC LIMIT 20`
  ).bind(like, like).all();

  return Response.json({ books: results });
}
