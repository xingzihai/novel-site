import { checkAdmin, validateId } from '../_utils.js';

// DELETE /api/annotations/:id
// 删除自己的批注
export async function onRequestDelete(context) {
  const { request, env, params } = context;
  const auth = await checkAdmin(request, env);
  if (!auth.ok) return Response.json({ error: 'unauthorized' }, { status: 401 });

  const id = params.id;
  if (!validateId(id)) {
    return Response.json({ error: 'invalid id' }, { status: 400 });
  }

  // 只能删除自己的批注
  const anno = await env.DB.prepare(
    'SELECT id, user_id FROM annotations WHERE id = ?'
  ).bind(id).first();

  if (!anno) {
    return Response.json({ error: '批注不存在' }, { status: 404 });
  }
  if (anno.user_id !== auth.userId) {
    return Response.json({ error: '只能删除自己的批注' }, { status: 403 });
  }

  await env.DB.prepare('DELETE FROM annotations WHERE id = ?').bind(id).run();

  return Response.json({ ok: true });
}
