import { checkAdmin } from '../_utils.js';

// POST /api/admin/votes - 提交投票
export async function onRequestPost(context) {
  const { request, env } = context;

  const auth = await checkAdmin(request, env);
  if (!auth.ok) return Response.json({ error: '请先登录' }, { status: 401 });

  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'invalid JSON' }, { status: 400 }); }

  const { annotationId, action, reason } = body;

  if (!annotationId || !/^\d{1,18}$/.test(String(annotationId))) {
    return Response.json({ error: '无效的批注ID' }, { status: 400 });
  }
  if (!['remove', 'keep'].includes(action)) {
    return Response.json({ error: '无效的投票选项' }, { status: 400 });
  }

  // 检查批注是否处于 escalated 状态（社区投票阶段）
  const anno = await env.DB.prepare(
    'SELECT a.id, a.user_id, a.book_id FROM annotations a WHERE a.id = ? AND a.status = ?'
  ).bind(annotationId, 'reported').first();
  if (!anno) {
    return Response.json({ error: '该批注不在投票阶段' }, { status: 400 });
  }

  // 检查是否有 escalated 的举报
  const escalatedReport = await env.DB.prepare(
    "SELECT id, book_id FROM reports WHERE annotation_id = ? AND status = 'escalated' LIMIT 1"
  ).bind(annotationId).first();

  // 也允许对 pending+threshold_reached 的举报投票
  const pendingReport = await env.DB.prepare(
    "SELECT id, book_id FROM reports WHERE annotation_id = ? AND status = 'pending' AND threshold_reached_at IS NOT NULL LIMIT 1"
  ).bind(annotationId).first();

  if (!escalatedReport && !pendingReport) {
    return Response.json({ error: '该批注不在投票阶段' }, { status: 400 });
  }

  // 不能对自己的批注投票
  if (anno.user_id === auth.userId) {
    return Response.json({ error: '不能对自己的批注投票' }, { status: 400 });
  }

  // 检查是否已投票
  const existing = await env.DB.prepare(
    'SELECT 1 FROM votes WHERE annotation_id = ? AND admin_id = ?'
  ).bind(annotationId, auth.userId).first();
  if (existing) {
    return Response.json({ error: '您已对此批注投过票' }, { status: 400 });
  }

  // 插入投票
  await env.DB.prepare(`
    INSERT INTO votes (annotation_id, admin_id, action, reason) VALUES (?, ?, ?, ?)
  `).bind(annotationId, auth.userId, action, reason || null).run();

  // 检查投票结果
  const voteStats = await env.DB.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN action = 'remove' THEN 1 ELSE 0 END) as remove_count,
      SUM(CASE WHEN action = 'keep' THEN 1 ELSE 0 END) as keep_count
    FROM votes WHERE annotation_id = ?
  `).bind(annotationId).first();

  const voteThreshold = 10; // 默认阈值
  const removePercent = 75;

  if (voteStats && voteStats.total >= voteThreshold) {
    const removeRatio = (voteStats.remove_count / voteStats.total) * 100;
    if (removeRatio >= removePercent) {
      // 移除批注
      await env.DB.prepare(`
        UPDATE annotations SET status = 'removed', updated_at = datetime('now') WHERE id = ?
      `).bind(annotationId).run();
      // 解决所有相关举报
      await env.DB.prepare(`
        UPDATE reports SET status = 'resolved', handler_action = 'remove', handled_at = datetime('now')
        WHERE annotation_id = ? AND status IN ('pending', 'escalated')
      `).bind(annotationId).run();
      // 投票者加分
      const voters = await env.DB.prepare(
        'SELECT admin_id FROM votes WHERE annotation_id = ?'
      ).bind(annotationId).all();
      for (const v of (voters.results || [])) {
        await env.DB.prepare(
          "UPDATE admin_users SET score = MIN(100, score + 0.1) WHERE id = ?"
        ).bind(v.admin_id).run();
        await env.DB.prepare(`
          INSERT INTO score_logs (user_id, delta, reason, related_annotation_id) VALUES (?, 0.1, 'vote_contribution', ?)
        `).bind(v.admin_id, annotationId).run();
      }
    } else {
      // 保留批注
      await env.DB.prepare(`
        UPDATE annotations SET status = 'normal', updated_at = datetime('now') WHERE id = ?
      `).bind(annotationId).run();
      await env.DB.prepare(`
        UPDATE reports SET status = 'resolved', handler_action = 'keep', handled_at = datetime('now')
        WHERE annotation_id = ? AND status IN ('pending', 'escalated')
      `).bind(annotationId).run();
    }
  }

  return Response.json({ 
    success: true, 
    votes: { total: voteStats?.total || 0, remove: voteStats?.remove_count || 0, keep: voteStats?.keep_count || 0 }
  });
}
