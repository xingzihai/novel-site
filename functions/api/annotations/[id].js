// PUT /api/annotations/:id — 编辑批注
// DELETE /api/annotations/:id — 删除批注
import { checkAdmin, validateId, parseJsonBody } from '../_utils.js';

export async function onRequestPut(context) {
  const { request, env, params } = context;
  const id = params.id;

  if (!validateId(id)) {
    return Response.json({ error: 'Invalid annotation ID' }, { status: 400 });
  }

  const auth = await checkAdmin(request, env);
  if (!auth.ok) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const annotation = await env.DB.prepare('SELECT * FROM annotations WHERE id = ?')
    .bind(Number(id)).first();
  if (!annotation) {
    return Response.json({ error: 'Annotation not found' }, { status: 404 });
  }

  // 只能编辑自己的批注（admin也只能编辑自己的）
  if (annotation.user_id !== auth.userId) {
    return Response.json({ error: '只能编辑自己的批注' }, { status: 403 });
  }

  const body = await parseJsonBody(request);
  if (!body) return Response.json({ error: 'Invalid JSON' }, { status: 400 });

  const { note, color } = body;

  // 验证输入
  if (note === undefined && color === undefined) {
    return Response.json({ error: 'Nothing to update' }, { status: 400 });
  }
  if (note !== undefined) {
    if (typeof note !== 'string') {
      return Response.json({ error: 'note must be a string' }, { status: 400 });
    }
    if (note.length > 5000) {
      return Response.json({ error: 'note too long (max 5000)' }, { status: 400 });
    }
  }
  if (color !== undefined) {
    if (!/^#[0-9A-Fa-f]{6}$/.test(color)) {
      return Response.json({ error: 'Invalid color format' }, { status: 400 });
    }
  }

  // 固定字段更新，避免动态 SQL 拼接
  const newNote = note !== undefined ? note : annotation.note;
  const newColor = color !== undefined ? color : annotation.color;

  await env.DB.prepare(
    "UPDATE annotations SET note = ?, color = ?, updated_at = datetime('now') WHERE id = ?"
  ).bind(newNote, newColor, Number(id)).run();

  const updated = await env.DB.prepare(
    'SELECT id, chapter_id, paragraph_index, start_offset, end_offset, selected_text, note, color, created_at, updated_at FROM annotations WHERE id = ?'
  ).bind(Number(id)).first();

  return Response.json({ success: true, annotation: updated });
}

export async function onRequestDelete(context) {
  const { request, env, params } = context;
  const id = params.id;

  if (!validateId(id)) {
    return Response.json({ error: 'Invalid annotation ID' }, { status: 400 });
  }

  const auth = await checkAdmin(request, env);
  if (!auth.ok) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const annotation = await env.DB.prepare('SELECT * FROM annotations WHERE id = ?')
    .bind(Number(id)).first();
  if (!annotation) {
    return Response.json({ error: 'Annotation not found' }, { status: 404 });
  }

  // 只能删除自己的批注
  if (annotation.user_id !== auth.userId) {
    return Response.json({ error: '只能删除自己的批注' }, { status: 403 });
  }

  await env.DB.prepare('DELETE FROM annotations WHERE id = ?')
    .bind(Number(id)).run();

  return Response.json({ success: true });
}
