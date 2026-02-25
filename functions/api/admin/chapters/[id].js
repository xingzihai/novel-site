// PUT /api/admin/chapters/:id — 编辑章节
// DELETE /api/admin/chapters/:id — 删除章节
import { checkAdmin, validateId, parseJsonBody, checkBookOwnership } from '../../_utils.js';

const MAX_CONTENT_LENGTH = 500000;

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
  if (!validateId(params.id)) return Response.json({ error: 'Invalid chapter ID' }, { status: 400 });

  const chapter = await env.DB.prepare('SELECT * FROM chapters WHERE id = ?').bind(params.id).first();
  if (!chapter) return Response.json({ error: 'Chapter not found' }, { status: 404 });

  // demo只能编辑自己书的章节
  if (!await checkBookOwnership(auth, env, chapter.book_id)) {
    return Response.json({ error: '只能编辑自己书籍的章节' }, { status: 403 });
  }

  const body = await parseJsonBody(request);
  if (!body) return Response.json({ error: 'Invalid JSON' }, { status: 400 });

  const { title, content, version } = body;

  // 乐观锁：编辑内容时必须携带version字段
  const currentVersion = chapter.version || 0;
  if (content && version === undefined) {
    return Response.json({ error: '请提供 version 字段以防止并发冲突' }, { status: 400 });
  }
  if (version !== undefined && Number(version) !== currentVersion) {
    return Response.json({ error: '内容已被其他人修改，请刷新后重试' }, { status: 409 });
  }

  if (title && typeof title === 'string' && title.trim().length > 0) {
    if (title.length > 200) return Response.json({ error: 'Title too long' }, { status: 400 });
    await env.DB.prepare("UPDATE chapters SET title = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(title.trim(), params.id).run();
  }

  if (content && typeof content === 'string' && content.trim().length > 0) {
    if (content.length > MAX_CONTENT_LENGTH) {
      return Response.json({ error: `Content too long (max ${MAX_CONTENT_LENGTH} chars)` }, { status: 400 });
    }
    const wordCount = content.trim().length;
    // 先更新DB（可回滚），再写R2（不可回滚）
    const newVersion = (chapter.version || 0) + 1;
    try {
      await env.DB.prepare(
        "UPDATE chapters SET word_count = ?, version = ?, updated_at = datetime('now') WHERE id = ?"
      ).bind(wordCount, newVersion, params.id).run();
      await env.R2.put(chapter.content_key, content.trim());
    } catch (err) {
      // 如果R2失败，回滚DB的word_count和version
      await env.DB.prepare(
        "UPDATE chapters SET word_count = ?, version = ?, updated_at = ? WHERE id = ?"
      ).bind(chapter.word_count, chapter.version || 0, chapter.updated_at, params.id).run().catch(() => {});
      return Response.json({ error: 'Failed to update content' }, { status: 500 });
    }
  }

  await env.DB.prepare("UPDATE books SET updated_at = datetime('now') WHERE id = ?")
    .bind(chapter.book_id).run();

  // 返回新version供前端下次编辑使用
  const newChapter = await env.DB.prepare('SELECT version FROM chapters WHERE id = ?').bind(params.id).first();
  return Response.json({ success: true, version: newChapter?.version || 0 });
}

export async function onRequestDelete(context) {
  const { request, env, params } = context;
  const { denied, auth } = await authCheck(request, env);
  if (denied) return denied;
  if (!validateId(params.id)) return Response.json({ error: 'Invalid chapter ID' }, { status: 400 });

  const chapter = await env.DB.prepare('SELECT * FROM chapters WHERE id = ?').bind(params.id).first();
  if (!chapter) return Response.json({ error: 'Chapter not found' }, { status: 404 });

  // demo只能删除自己书的章节
  if (!await checkBookOwnership(auth, env, chapter.book_id)) {
    return Response.json({ error: '只能删除自己书籍的章节' }, { status: 403 });
  }

  await env.DB.prepare('DELETE FROM chapter_stats WHERE chapter_id = ?').bind(params.id).run().catch(() => {});
  await env.DB.prepare('DELETE FROM chapters WHERE id = ?').bind(params.id).run();
  await env.R2.delete(chapter.content_key).catch(() => {});

  await env.DB.prepare("UPDATE books SET updated_at = datetime('now') WHERE id = ?")
    .bind(chapter.book_id).run();

  return Response.json({ success: true });
}
