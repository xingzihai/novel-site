// GET /api/annotations?chapter_id=X — 获取章节批注
// POST /api/annotations — 创建批注
import { checkAdmin, validateId, parseJsonBody, requireMinRole } from './_utils.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const chapterId = url.searchParams.get('chapter_id');

  if (!chapterId || !validateId(chapterId)) {
    return Response.json({ error: 'Valid chapter_id is required' }, { status: 400 });
  }

  const auth = await checkAdmin(request, env);
  if (!auth.ok) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let annotations;
  if (requireMinRole(auth, 'admin')) {
    // admin及以上可以看到所有人的批注
    const result = await env.DB.prepare(`
      SELECT a.id, a.chapter_id, a.paragraph_index, a.start_offset, a.end_offset,
        a.selected_text, a.note, a.color, a.created_at, u.username
      FROM annotations a LEFT JOIN admin_users u ON a.user_id = u.id
      WHERE a.chapter_id = ?
      ORDER BY a.paragraph_index, a.start_offset
    `).bind(Number(chapterId)).all();
    annotations = result.results || [];
  } else {
    // demo只能看自己的批注
    const result = await env.DB.prepare(`
      SELECT a.id, a.chapter_id, a.paragraph_index, a.start_offset, a.end_offset,
        a.selected_text, a.note, a.color, a.created_at, u.username
      FROM annotations a LEFT JOIN admin_users u ON a.user_id = u.id
      WHERE a.chapter_id = ? AND a.user_id = ?
      ORDER BY a.paragraph_index, a.start_offset
    `).bind(Number(chapterId), auth.userId).all();
    annotations = result.results || [];
  }

  return Response.json({ annotations });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const auth = await checkAdmin(request, env);
  if (!auth.ok) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await parseJsonBody(request);
  if (!body) return Response.json({ error: 'Invalid JSON' }, { status: 400 });

  const { chapter_id, paragraph_index, start_offset, end_offset, selected_text, note, color } = body;

  if (!chapter_id || !validateId(String(chapter_id))) {
    return Response.json({ error: 'Valid chapter_id is required' }, { status: 400 });
  }
  if (typeof paragraph_index !== 'number' || paragraph_index < 0 || paragraph_index > 100000) {
    return Response.json({ error: 'Valid paragraph_index is required' }, { status: 400 });
  }
  if (typeof start_offset !== 'number' || start_offset < 0 || start_offset > 1000000) {
    return Response.json({ error: 'Valid start_offset is required' }, { status: 400 });
  }
  if (typeof end_offset !== 'number' || end_offset <= start_offset || end_offset > 1000000) {
    return Response.json({ error: 'Valid end_offset is required' }, { status: 400 });
  }
  if (!selected_text || typeof selected_text !== 'string' || selected_text.trim().length === 0) {
    return Response.json({ error: 'selected_text is required' }, { status: 400 });
  }
  if (selected_text.length > 2000) {
    return Response.json({ error: 'selected_text too long (max 2000)' }, { status: 400 });
  }
  if (note && typeof note === 'string' && note.length > 5000) {
    return Response.json({ error: 'note too long (max 5000)' }, { status: 400 });
  }

  // 验证章节存在
  const chapter = await env.DB.prepare('SELECT id FROM chapters WHERE id = ?')
    .bind(Number(chapter_id)).first();
  if (!chapter) return Response.json({ error: 'Chapter not found' }, { status: 404 });

  // demo 用户配额：每章最多 50 条批注
  if (!requireMinRole(auth, 'admin')) {
    const { count } = await env.DB.prepare(
      'SELECT COUNT(*) as count FROM annotations WHERE chapter_id = ? AND user_id = ?'
    ).bind(Number(chapter_id), auth.userId).first();
    if (count >= 50) {
      return Response.json({ error: '每章最多 50 条批注' }, { status: 403 });
    }
  }

  const validColor = /^#[0-9A-Fa-f]{6}$/.test(color) ? color : '#FFD700';

  const result = await env.DB.prepare(`
    INSERT INTO annotations (chapter_id, user_id, paragraph_index, start_offset, end_offset, selected_text, note, color)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    Number(chapter_id), auth.userId, paragraph_index, start_offset, end_offset,
    selected_text, (note || '').slice(0, 5000), validColor
  ).run();

  return Response.json({
    success: true,
    annotation: {
      id: result.meta.last_row_id,
      chapter_id: Number(chapter_id),
      user_id: auth.userId,
      username: auth.username,
      paragraph_index,
      start_offset,
      end_offset,
      selected_text,
      note: (note || '').slice(0, 5000),
      color: validColor,
      created_at: new Date().toISOString().replace('T', ' ').slice(0, 19)
    }
  }, { status: 201 });
}
