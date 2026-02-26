import { checkAdmin } from '../_utils.js';

// 权限过滤
function buildPermissionFilter(auth) {
  const where = [];
  const binds = [];

  if (auth.role === 'super_admin') {
    // 无限制
  } else if (auth.role === 'admin') {
    // 排除超管的批注
    where.push("u.role != 'super_admin'");
  } else {
    // demo：自己的批注 + 自己书上的 demo 批注
    where.push('(a.user_id = ? OR (b.created_by = ? AND u.role = ?))');
    binds.push(auth.userId, auth.userId, 'demo');
  }

  return { where, binds };
}

// GET /api/admin/annotations - 批注列表
export async function onRequestGet(context) {
  const { request, env } = context;
  
  const auth = await checkAdmin(request, env);
  if (!auth.ok) {
    return Response.json({ error: '请先登录' }, { status: 401 });
  }

  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get('page')) || 1);
  const limit = Math.min(50, Math.max(10, parseInt(url.searchParams.get('limit')) || 20));
  const offset = (page - 1) * limit;

  const bookId = url.searchParams.get('bookId');
  const status = url.searchParams.get('status'); // all/normal/reported/removed
  const visibility = url.searchParams.get('visibility'); // all/public/private
  const search = url.searchParams.get('search');
  const sort = url.searchParams.get('sort') || 'latest'; // latest/oldest/reports

  // 构建查询条件
  const { where, binds } = buildPermissionFilter(auth);
  
  const VALID_STATUSES = ['normal', 'reported', 'removed'];
  const VALID_VISIBILITIES = ['public', 'private'];

  if (bookId) {
    where.push('a.book_id = ?');
    binds.push(bookId);
  }
  if (status && status !== 'all') {
    if (!VALID_STATUSES.includes(status)) return Response.json({ error: '无效的状态' }, { status: 400 });
    where.push('a.status = ?');
    binds.push(status);
  }
  if (visibility && visibility !== 'all') {
    if (!VALID_VISIBILITIES.includes(visibility)) return Response.json({ error: '无效的类型' }, { status: 400 });
    where.push('a.visibility = ?');
    binds.push(visibility);
  }
  if (search) {
    where.push('(a.content LIKE ? OR a.sent_text LIKE ?)');
    binds.push(`%${search}%`, `%${search}%`);
  }

  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
  
  // 排序
  let orderBy = 'a.created_at DESC';
  if (sort === 'oldest') orderBy = 'a.created_at ASC';
  // reports 排序需要子查询，暂时用 created_at

  // 查询总数
  const countSql = `
    SELECT COUNT(*) as total
    FROM annotations a
    LEFT JOIN admin_users u ON a.user_id = u.id
    LEFT JOIN books b ON a.book_id = b.id
    ${whereClause}
  `;
  const countResult = await env.DB.prepare(countSql).bind(...binds).first();
  const total = countResult?.total || 0;

  // 查询列表
  const listSql = `
    SELECT a.id, a.chapter_id, a.book_id, a.user_id, a.para_idx, a.sent_idx,
           a.sent_text, a.content, a.visibility, a.status, a.created_at,
           u.username, u.role as user_role,
           b.title as book_title,
           c.title as chapter_title,
           (SELECT COUNT(*) FROM annotation_likes WHERE annotation_id = a.id) as like_count
    FROM annotations a
    LEFT JOIN admin_users u ON a.user_id = u.id
    LEFT JOIN books b ON a.book_id = b.id
    LEFT JOIN chapters c ON a.chapter_id = c.id
    ${whereClause}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `;
  const listResult = await env.DB.prepare(listSql).bind(...binds, limit, offset).all();

  return Response.json({
    annotations: listResult.results,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit)
    }
  });
}

// GET /api/admin/annotations/stats - 统计数据
export async function onRequestHead(context) {
  // 用 HEAD 请求获取统计（避免与 GET 冲突）
  return new Response(null, { status: 405 });
}
