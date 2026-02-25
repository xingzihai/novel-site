import { checkAdmin, validateId } from './_utils.js';

// GET /api/annotations?chapterId=X&paraIdx=Y&sentIdx=Z
// 返回某句话的批注列表
// 认证可选：未登录只看公开，已登录看公开+自己的私有
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const chapterId = url.searchParams.get('chapterId');
  const paraIdx = url.searchParams.get('paraIdx');
  const sentIdx = url.searchParams.get('sentIdx');

  if (!chapterId || !/^\d{1,18}$/.test(chapterId)) {
    return Response.json({ error: 'invalid chapterId' }, { status: 400 });
  }
  if (paraIdx == null || !/^\d{1,6}$/.test(paraIdx)) {
    return Response.json({ error: 'invalid paraIdx' }, { status: 400 });
  }
  if (sentIdx == null || !/^\d{1,6}$/.test(sentIdx)) {
    return Response.json({ error: 'invalid sentIdx' }, { status: 400 });
  }

  let userId = -1;
  const auth = await checkAdmin(request, env);
  if (auth.ok) userId = auth.userId;

  // 公开批注 + 自己的私有批注，不返回 user_id
  const rows = await env.DB.prepare(`
    SELECT a.id, a.content, a.visibility, a.created_at, u.username,
      CASE WHEN a.user_id = ? THEN 1 ELSE 0 END AS is_mine
    FROM annotations a
    LEFT JOIN admin_users u ON a.user_id = u.id
    WHERE a.chapter_id = ? AND a.para_idx = ? AND a.sent_idx = ?
      AND a.status = 'normal'
      AND (a.visibility = 'public' OR a.user_id = ?)
    ORDER BY a.created_at ASC
  `).bind(userId, chapterId, paraIdx, sentIdx, userId).all();

  return Response.json({ annotations: rows.results });
}

// POST /api/annotations
// 发表批注，需要 demo+ 认证
export async function onRequestPost(context) {
  const { request, env } = context;
  const auth = await checkAdmin(request, env);
  if (!auth.ok) return Response.json({ error: 'unauthorized' }, { status: 401 });

  // 检查禁言
  const user = await env.DB.prepare(
    'SELECT muted_until, banned_at FROM admin_users WHERE id = ?'
  ).bind(auth.userId).first();
  if (user?.banned_at) {
    return Response.json({ error: '账号已被封禁' }, { status: 403 });
  }
  if (user?.muted_until && new Date(user.muted_until) > new Date()) {
    return Response.json({ error: '你当前处于禁言状态，无法发表批注' }, { status: 403 });
  }

  // 频率限制：每分钟最多 10 条批注（🟡-9 修复）
  const { count: recentCount } = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM annotations WHERE user_id = ? AND created_at > datetime('now', '-1 minute')"
  ).bind(auth.userId).first();
  if (recentCount >= 10) {
    return Response.json({ error: '操作过于频繁，请稍后再试' }, { status: 429 });
  }

  let body;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const { chapterId, bookId, paraIdx, sentIdx, sentHash, sentText, content, visibility } = body;

  // 参数校验
  if (!chapterId || !validateId(String(chapterId))) {
    return Response.json({ error: 'invalid chapterId' }, { status: 400 });
  }
  if (!bookId || !validateId(String(bookId))) {
    return Response.json({ error: 'invalid bookId' }, { status: 400 });
  }
  if (paraIdx == null || typeof paraIdx !== 'number' || paraIdx < 0 || paraIdx > 99999) {
    return Response.json({ error: 'invalid paraIdx' }, { status: 400 });
  }
  if (sentIdx == null || typeof sentIdx !== 'number' || sentIdx < 0 || sentIdx > 9999) {
    return Response.json({ error: 'invalid sentIdx' }, { status: 400 });
  }
  if (!sentHash || !/^[0-9a-f]{8}$/.test(sentHash)) {
    return Response.json({ error: 'invalid sentHash' }, { status: 400 });
  }
  if (!sentText || typeof sentText !== 'string' || sentText.length > 2000) {
    return Response.json({ error: 'invalid sentText' }, { status: 400 });
  }
  if (!content || typeof content !== 'string') {
    return Response.json({ error: 'content is required' }, { status: 400 });
  }
  const trimmedContent = content.trim();
  if (trimmedContent.length < 1 || trimmedContent.length > 500) {
    return Response.json({ error: '批注内容需要1-500字' }, { status: 400 });
  }
  if (!visibility || !['public', 'private'].includes(visibility)) {
    return Response.json({ error: 'visibility must be public or private' }, { status: 400 });
  }

  // 检查书籍是否允许批注
  const book = await env.DB.prepare(
    'SELECT id, annotation_enabled, annotation_locked FROM books WHERE id = ? AND status = ?'
  ).bind(bookId, 'normal').first();
  if (!book) {
    return Response.json({ error: '书籍不存在' }, { status: 404 });
  }
  if (!book.annotation_enabled) {
    return Response.json({ error: '该书籍未开启批注功能' }, { status: 403 });
  }
  if (book.annotation_locked) {
    return Response.json({ error: '该书籍批注功能已被锁定' }, { status: 403 });
  }

  // 检查章节属于该书籍
  const chapter = await env.DB.prepare(
    'SELECT id FROM chapters WHERE id = ? AND book_id = ?'
  ).bind(chapterId, bookId).first();
  if (!chapter) {
    return Response.json({ error: '章节不存在或不属于该书籍' }, { status: 404 });
  }

  // demo 用户每章批注上限
  if (auth.role === 'demo') {
    const limitRow = await env.DB.prepare(
      "SELECT value FROM site_settings WHERE key = 'anno_max_per_chapter'"
    ).first();
    const maxPerChapter = limitRow ? Number(limitRow.value) : 200;
    const { count } = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM annotations WHERE chapter_id = ? AND user_id = ?'
    ).bind(chapterId, auth.userId).first();
    if (count >= maxPerChapter) {
      return Response.json({ error: `每章最多 ${maxPerChapter} 条批注` }, { status: 429 });
    }
  }

  // 防重复：同一用户同一句子同一内容
  const dup = await env.DB.prepare(
    'SELECT id FROM annotations WHERE chapter_id = ? AND user_id = ? AND para_idx = ? AND sent_idx = ? AND content = ?'
  ).bind(chapterId, auth.userId, paraIdx, sentIdx, trimmedContent).first();
  if (dup) {
    return Response.json({ error: '你已对该句子发表过相同内容的批注' }, { status: 409 });
  }

  // 插入
  const result = await env.DB.prepare(`
    INSERT INTO annotations (chapter_id, book_id, user_id, para_idx, sent_idx, sent_hash, sent_text, content, visibility)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(chapterId, bookId, auth.userId, paraIdx, sentIdx, sentHash, sentText, trimmedContent, visibility).run();

  return Response.json({
    id: result.meta.last_row_id,
    created_at: new Date().toISOString()
  }, { status: 201 });
}
