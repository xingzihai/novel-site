import { checkAdmin, ensureAnnotationSchema } from './_utils.js';

// POST /api/annotations - 创建批注
export async function onRequestPost(context) {
  const { request, env } = context;
  
  const auth = await checkAdmin(request, env);
  if (!auth.ok) {
    return Response.json({ error: '请先登录' }, { status: 401 });
  }

  await ensureAnnotationSchema(env);

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const { chapterId, bookId, paraIdx, sentIdx, sentHash, sentText, content, visibility } = body;

  // 参数校验
  if (!chapterId || !bookId || paraIdx == null || sentIdx == null || !sentHash || !sentText || !content) {
    return Response.json({ error: '缺少必要参数' }, { status: 400 });
  }
  // 类型和范围校验
  if (!/^\d{1,18}$/.test(String(chapterId)) || !/^\d{1,18}$/.test(String(bookId))) {
    return Response.json({ error: '无效的ID' }, { status: 400 });
  }
  if (!Number.isInteger(paraIdx) || paraIdx < 0 || !Number.isInteger(sentIdx) || sentIdx < 0) {
    return Response.json({ error: '无效的索引' }, { status: 400 });
  }
  if (typeof sentHash !== 'string' || sentHash.length > 128) {
    return Response.json({ error: '无效的哈希' }, { status: 400 });
  }
  if (typeof sentText !== 'string' || sentText.length > 1000) {
    return Response.json({ error: '原文过长' }, { status: 400 });
  }
  if (content.length > 500) {
    return Response.json({ error: '批注内容不能超过500字' }, { status: 400 });
  }
  if (!['public', 'private'].includes(visibility)) {
    return Response.json({ error: '无效的可见性设置' }, { status: 400 });
  }

  // 检查书籍是否允许批注 + 是否锁定
  const book = await env.DB.prepare('SELECT annotation_enabled, annotation_locked FROM books WHERE id = ?').bind(bookId).first();
  if (!book || !book.annotation_enabled) {
    return Response.json({ error: '该书籍未开启批注功能' }, { status: 403 });
  }
  if (book.annotation_locked) {
    return Response.json({ error: '该书籍批注已锁定' }, { status: 403 });
  }

  // 校验 chapterId 属于 bookId
  const chapter = await env.DB.prepare('SELECT book_id FROM chapters WHERE id = ?').bind(chapterId).first();
  if (!chapter || chapter.book_id !== Number(bookId)) {
    return Response.json({ error: '章节不属于该书籍' }, { status: 400 });
  }

  // 速率限制：每用户每分钟最多10条
  const oneMinAgo = new Date(Date.now() - 60000).toISOString();
  const recentCount = await env.DB.prepare(
    'SELECT COUNT(*) as cnt FROM annotations WHERE user_id = ? AND created_at > ?'
  ).bind(auth.userId, oneMinAgo).first();
  if (recentCount && recentCount.cnt >= 10) {
    return Response.json({ error: '操作过于频繁，请稍后再试' }, { status: 429 });
  }

  // 同一用户对同一句子最多3条批注
  const dupCount = await env.DB.prepare(
    'SELECT COUNT(*) as cnt FROM annotations WHERE user_id = ? AND chapter_id = ? AND para_idx = ? AND sent_idx = ?'
  ).bind(auth.userId, chapterId, paraIdx, sentIdx).first();
  if (dupCount && dupCount.cnt >= 3) {
    return Response.json({ error: '同一句子最多添加3条批注' }, { status: 400 });
  }

  try {
    const result = await env.DB.prepare(`
      INSERT INTO annotations (chapter_id, book_id, user_id, para_idx, sent_idx, sent_hash, sent_text, content, visibility)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(chapterId, bookId, auth.userId, paraIdx, sentIdx, sentHash, sentText, content, visibility).run();

    return Response.json({ 
      success: true, 
      id: result.meta.last_row_id 
    });
  } catch (e) {
    console.error('创建批注失败:', e);
    return Response.json({ error: '创建失败' }, { status: 500 });
  }
}

// GET /api/annotations?chapterId=X&paraIdx=Y&sentIdx=Z&sort=latest|hot
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const chapterId = url.searchParams.get('chapterId');
  const paraIdx = url.searchParams.get('paraIdx');
  const sentIdx = url.searchParams.get('sentIdx');
  const sort = url.searchParams.get('sort') || 'latest';

  if (!chapterId || paraIdx == null || sentIdx == null) {
    return Response.json({ error: '缺少参数' }, { status: 400 });
  }
  // 参数格式校验
  if (!/^\d{1,18}$/.test(chapterId) || !/^\d{1,10}$/.test(paraIdx) || !/^\d{1,10}$/.test(sentIdx)) {
    return Response.json({ error: '参数格式错误' }, { status: 400 });
  }

  await ensureAnnotationSchema(env);

  let userId = -1;
  const auth = await checkAdmin(request, env);
  if (auth.ok) userId = auth.userId;

  const orderBy = sort === 'hot' ? 'like_count DESC, a.created_at DESC' : 'a.created_at DESC';

  const rows = await env.DB.prepare(`
    SELECT a.id, a.content, a.visibility, a.created_at, a.user_id,
           u.username, u.avatar_url,
           CASE WHEN a.user_id = ? THEN 1 ELSE 0 END as is_mine,
           (SELECT COUNT(*) FROM annotation_likes WHERE annotation_id = a.id) as like_count,
           (SELECT 1 FROM annotation_likes WHERE annotation_id = a.id AND user_id = ?) as liked
    FROM annotations a
    LEFT JOIN admin_users u ON a.user_id = u.id
    WHERE a.chapter_id = ? AND a.para_idx = ? AND a.sent_idx = ? AND a.status = 'normal'
      AND (a.visibility = 'public' OR a.user_id = ?)
    ORDER BY ${orderBy}
    LIMIT 50
  `).bind(userId, userId, chapterId, paraIdx, sentIdx, userId).all();

  return Response.json({ annotations: rows.results });
}
