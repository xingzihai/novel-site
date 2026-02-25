// PUT /api/admin/books/:id — 编辑书籍
// DELETE /api/admin/books/:id — 软删除书籍（30天后自动清理）
// POST /api/admin/books/:id — 状态变更（上架/下架/恢复/永久删除）
import { checkAdmin, validateId, parseJsonBody, checkBookOwnership, requireMinRole } from '../../_utils.js';

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

  if (!await checkBookOwnership(auth, env, params.id)) {
    return Response.json({ error: '只能删除自己创建的书籍' }, { status: 403 });
  }

  // 🔴-3: 已在回收站的书不能重复软删除（防 delete_at 无限续期）
  const currentStatus = book.status || 'normal';
  if (currentStatus === 'deleted') {
    return Response.json({ error: '书籍已在回收站中' }, { status: 400 });
  }

  // 软删除：标记为 deleted，30天后自动清理
  const deleteAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(
    "UPDATE books SET status = 'deleted', delete_at = ?, updated_at = datetime('now') WHERE id = ?"
  ).bind(deleteAt, params.id).run();

  return Response.json({ success: true, message: '书籍已移入回收站，30天后自动删除', delete_at: deleteAt });
}

// POST /api/admin/books/:id — 状态变更
const VALID_ACTIONS = ['unlist', 'restore', 'purge'];

export async function onRequestPost(context) {
  const { request, env, params } = context;
  const { denied, auth } = await authCheck(request, env);
  if (denied) return denied;
  if (!validateId(params.id)) return Response.json({ error: 'Invalid ID' }, { status: 400 });

  const book = await env.DB.prepare('SELECT * FROM books WHERE id = ?').bind(params.id).first();
  if (!book) return Response.json({ error: 'Book not found' }, { status: 404 });

  if (!await checkBookOwnership(auth, env, params.id)) {
    return Response.json({ error: '只能操作自己创建的书籍' }, { status: 403 });
  }

  const body = await parseJsonBody(request);
  if (!body || !body.action) return Response.json({ error: 'Missing action' }, { status: 400 });

  const { action } = body;
  // 🟡-6: 入口白名单校验
  if (!VALID_ACTIONS.includes(action)) {
    return Response.json({ error: 'Unknown action' }, { status: 400 });
  }

  const currentStatus = book.status || 'normal';

  if (action === 'unlist') {
    // 🔴-1: 只有 normal 状态可以下架
    if (currentStatus !== 'normal') {
      return Response.json({ error: '只有正常状态的书籍可以下架' }, { status: 400 });
    }
    await env.DB.prepare(
      "UPDATE books SET status = 'unlisted', delete_at = NULL, updated_at = datetime('now') WHERE id = ?"
    ).bind(params.id).run();
    return Response.json({ success: true, message: '书籍已下架' });
  }

  if (action === 'restore') {
    // 🔴-2: 只有 unlisted/deleted 可以恢复
    if (currentStatus === 'normal') {
      return Response.json({ error: '书籍已是正常状态' }, { status: 400 });
    }
    await env.DB.prepare(
      "UPDATE books SET status = 'normal', delete_at = NULL, updated_at = datetime('now') WHERE id = ?"
    ).bind(params.id).run();
    return Response.json({ success: true, message: '书籍已恢复上架' });
  }

  if (action === 'purge') {
    // 🟡-1: 只有 deleted 状态可以永久删除
    if (currentStatus !== 'deleted') {
      return Response.json({ error: '只能永久删除已在回收站中的书籍' }, { status: 400 });
    }
    if (!requireMinRole(auth, 'super_admin')) {
      return Response.json({ error: '仅超级管理员可永久删除' }, { status: 403 });
    }
    // 先删 DB（batch 原子），再删 R2（🟡-2: 顺序调整）
    const { results: chapters } = await env.DB.prepare('SELECT content_key FROM chapters WHERE book_id = ?')
      .bind(params.id).all();
    const r2Keys = chapters.map(c => c.content_key);
    if (book.cover_key) r2Keys.push(book.cover_key);

    await env.DB.batch([
      env.DB.prepare('DELETE FROM chapter_stats WHERE chapter_id IN (SELECT id FROM chapters WHERE book_id = ?)').bind(params.id),
      env.DB.prepare('DELETE FROM book_stats WHERE book_id = ?').bind(params.id),
      env.DB.prepare('DELETE FROM book_tags WHERE book_id = ?').bind(params.id),
      env.DB.prepare('DELETE FROM chapters WHERE book_id = ?').bind(params.id),
      env.DB.prepare('DELETE FROM books WHERE id = ?').bind(params.id),
    ]);
    // R2 删除在 DB 之后，失败不影响数据一致性
    await Promise.all(r2Keys.map(k => env.R2.delete(k).catch(() => {})));
    return Response.json({ success: true, message: '书籍已永久删除' });
  }
}
