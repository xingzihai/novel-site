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
  if (reason && reason.length > 500) {
    return Response.json({ error: '投票理由不能超过500字' }, { status: 400 });
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
      // 乐观锁：只有 status 仍为 reported 时才执行，防并发重复
      const upd = await env.DB.prepare(`
        UPDATE annotations SET status = 'removed', updated_at = datetime('now') WHERE id = ? AND status = 'reported'
      `).bind(annotationId).run();

      if (upd.meta.changes > 0) {
        // 解决所有相关举报
        await env.DB.prepare(`
          UPDATE reports SET status = 'resolved', handler_action = 'remove', handled_at = datetime('now')
          WHERE annotation_id = ? AND status IN ('pending', 'escalated')
        `).bind(annotationId).run();
        // 投票者加分（只执行一次）
        const voters = await env.DB.prepare(
          'SELECT admin_id FROM votes WHERE annotation_id = ?'
        ).bind(annotationId).all();
        for (const v of (voters.results || [])) {
          await env.DB.prepare(
            "UPDATE admin_users SET score = ROUND(MIN(100, ROUND(score, 1) + 0.1), 1) WHERE id = ?"
          ).bind(v.admin_id).run();
          await env.DB.prepare(`
            INSERT INTO score_logs (user_id, delta, reason, related_annotation_id) VALUES (?, 0.1, 'vote_contribution', ?)
          `).bind(v.admin_id, annotationId).run();
        }
        // 对批注作者施加处罚
        const MUTE_DURATIONS_MIN = [0, 0, 1440, 4320, 10080, 43200];
        await env.DB.prepare(`
          UPDATE admin_users SET violation_count = violation_count + 1, last_violation_at = datetime('now') WHERE id = ?
        `).bind(anno.user_id).run();
        const annoAuthor = await env.DB.prepare('SELECT violation_count FROM admin_users WHERE id = ?').bind(anno.user_id).first();
        if (annoAuthor) {
          const vc = annoAuthor.violation_count;
          if (vc >= 6) {
            await env.DB.prepare("UPDATE admin_users SET banned_at = datetime('now') WHERE id = ?").bind(anno.user_id).run();
            await env.DB.prepare("INSERT INTO mutes (user_id, type, reason, related_annotation_id) VALUES (?, 'ban', '累计违规达到封禁阈值', ?)").bind(anno.user_id, annotationId).run();
          } else if (vc >= 2) {
            const dur = MUTE_DURATIONS_MIN[vc] || 43200;
            const endsAt = new Date(Date.now() + dur * 60000).toISOString();
            await env.DB.prepare('UPDATE admin_users SET muted_until = ? WHERE id = ?').bind(endsAt, anno.user_id).run();
            await env.DB.prepare("INSERT INTO mutes (user_id, type, reason, related_annotation_id, duration_minutes, ends_at) VALUES (?, 'mute', '社区投票移除批注', ?, ?, ?)").bind(anno.user_id, annotationId, dur, endsAt).run();
          } else {
            await env.DB.prepare("INSERT INTO mutes (user_id, type, reason, related_annotation_id) VALUES (?, 'warning', '社区投票移除批注（警告）', ?)").bind(anno.user_id, annotationId).run();
          }
        }
      }
    } else {
      // 保留批注（同样用乐观锁）
      const upd = await env.DB.prepare(`
        UPDATE annotations SET status = 'normal', updated_at = datetime('now') WHERE id = ? AND status = 'reported'
      `).bind(annotationId).run();
      if (upd.meta.changes > 0) {
        await env.DB.prepare(`
          UPDATE reports SET status = 'resolved', handler_action = 'keep', handled_at = datetime('now')
          WHERE annotation_id = ? AND status IN ('pending', 'escalated')
        `).bind(annotationId).run();
      }
    }
  }

  return Response.json({ 
    success: true, 
    votes: { total: voteStats?.total || 0, remove: voteStats?.remove_count || 0, keep: voteStats?.keep_count || 0 }
  });
}
