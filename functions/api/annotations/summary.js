import { checkAdmin } from '../_utils.js';

// GET /api/annotations/summary?chapterId=X
// 返回章节内每个被批注句子的聚合统计（渲染下划线用）
// 认证可选：有 token 返回私有批注信息，无 token 只返回公开
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const chapterId = url.searchParams.get('chapterId');

  if (!chapterId || !/^\d{1,18}$/.test(chapterId)) {
    return Response.json({ error: 'invalid chapterId' }, { status: 400 });
  }

  // 可选认证：尝试获取用户信息，失败不阻断
  let userId = -1;
  const auth = await checkAdmin(request, env);
  if (auth.ok) userId = auth.userId;

  const rows = await env.DB.prepare(`
    SELECT para_idx, sent_idx, sent_hash,
      COUNT(CASE WHEN visibility = 'public' AND status = 'normal' THEN 1 END) AS public_count,
      COUNT(CASE WHEN visibility = 'private' AND status = 'normal' AND user_id = ? THEN 1 END) AS private_count,
      MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS has_mine
    FROM annotations
    WHERE chapter_id = ? AND status = 'normal'
    GROUP BY para_idx, sent_idx, sent_hash
    HAVING public_count > 0 OR private_count > 0
  `).bind(userId, userId, chapterId).all();

  return Response.json({ sentences: rows.results });
}
