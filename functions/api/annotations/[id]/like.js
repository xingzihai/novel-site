import { checkAdmin } from '../../_utils.js';

// POST /api/annotations/[id]/like - 点赞/取消点赞
export async function onRequestPost(context) {
  const { request, env, params } = context;
  const annoId = params.id;

  if (!/^\d{1,18}$/.test(annoId)) {
    return Response.json({ error: 'invalid id' }, { status: 400 });
  }

  const auth = await checkAdmin(request, env);
  if (!auth.ok) {
    return Response.json({ error: '请先登录' }, { status: 401 });
  }

  // 检查批注是否存在
  const anno = await env.DB.prepare('SELECT id, user_id FROM annotations WHERE id = ? AND status = ?')
    .bind(annoId, 'normal').first();
  if (!anno) {
    return Response.json({ error: '批注不存在' }, { status: 404 });
  }

  // 不能给自己的批注点赞
  if (anno.user_id === auth.userId) {
    return Response.json({ error: '不能给自己的批注点赞' }, { status: 403 });
  }

  // 检查是否已点赞
  const existing = await env.DB.prepare(
    'SELECT 1 FROM annotation_likes WHERE annotation_id = ? AND user_id = ?'
  ).bind(annoId, auth.userId).first();

  if (existing) {
    // 取消点赞
    await env.DB.prepare(
      'DELETE FROM annotation_likes WHERE annotation_id = ? AND user_id = ?'
    ).bind(annoId, auth.userId).run();
    return Response.json({ liked: false });
  } else {
    // 点赞
    await env.DB.prepare(
      'INSERT INTO annotation_likes (annotation_id, user_id) VALUES (?, ?)'
    ).bind(annoId, auth.userId).run();
    return Response.json({ liked: true });
  }
}
