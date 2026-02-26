import { checkAdmin } from '../_utils.js';

// GET /api/admin/reports - 举报列表
export async function onRequestGet(context) {
  const { request, env } = context;

  const auth = await checkAdmin(request, env);
  if (!auth.ok) return Response.json({ error: '请先登录' }, { status: 401 });

  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get('page')) || 1);
  const limit = Math.min(50, Math.max(10, parseInt(url.searchParams.get('limit')) || 20));
  const offset = (page - 1) * limit;
  const status = url.searchParams.get('status'); // pending/escalated/resolved
  const bookId = url.searchParams.get('bookId');

  const VALID_STATUSES = ['pending', 'escalated', 'resolved'];
  const where = [];
  const binds = [];

  if (status && status !== 'all') {
    if (!VALID_STATUSES.includes(status)) return Response.json({ error: '无效的状态' }, { status: 400 });
    where.push('r.status = ?');
    binds.push(status);
  }
  if (bookId) {
    where.push('r.book_id = ?');
    binds.push(bookId);
  }

  // 权限过滤
  if (auth.role === 'demo') {
    // demo 只能看自己书上的举报
    where.push('b.created_by = ?');
    binds.push(auth.userId);
  } else if (auth.role === 'admin') {
    // admin 看所有（超管批注的举报除外）
    where.push("anno_user.role != 'super_admin'");
  }
  // super_admin 无限制

  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

  // 总数
  const countSql = `
    SELECT COUNT(*) as total FROM reports r
    LEFT JOIN annotations a ON r.annotation_id = a.id
    LEFT JOIN books b ON r.book_id = b.id
    LEFT JOIN admin_users anno_user ON a.user_id = anno_user.id
    ${whereClause}
  `;
  const countResult = await env.DB.prepare(countSql).bind(...binds).first();
  const total = countResult?.total || 0;

  // 列表：按举报分组显示（每个被举报的批注聚合）
  const listSql = `
    SELECT r.id, r.annotation_id, r.book_id, r.reporter_id, r.reason, r.status,
           r.threshold_reached_at, r.escalated_at, r.handler_action, r.created_at,
           a.content as anno_content, a.sent_text, a.status as anno_status,
           a.user_id as anno_user_id, a.para_idx, a.sent_idx, a.chapter_id,
           anno_user.username as anno_username, anno_user.role as anno_user_role,
           reporter.username as reporter_username,
           b.title as book_title,
           c.title as chapter_title,
           (SELECT COUNT(*) FROM reports WHERE annotation_id = r.annotation_id) as report_count
    FROM reports r
    LEFT JOIN annotations a ON r.annotation_id = a.id
    LEFT JOIN admin_users anno_user ON a.user_id = anno_user.id
    LEFT JOIN admin_users reporter ON r.reporter_id = reporter.id
    LEFT JOIN books b ON r.book_id = b.id
    LEFT JOIN chapters c ON a.chapter_id = c.id
    ${whereClause}
    ORDER BY r.created_at DESC
    LIMIT ? OFFSET ?
  `;
  const listResult = await env.DB.prepare(listSql).bind(...binds, limit, offset).all();

  return Response.json({
    reports: listResult.results,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
  });
}
