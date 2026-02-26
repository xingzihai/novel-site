import { checkAdmin, ensureAnnotationSchema } from './_utils.js';

// Bigram Jaccard 相似度
function bigramSet(text) {
  const clean = text.replace(/[\s\p{P}]/gu, '').toLowerCase();
  const set = new Set();
  for (let i = 0; i < clean.length - 1; i++) {
    set.add(clean[i] + clean[i + 1]);
  }
  return set;
}

function jaccardSimilarity(a, b) {
  const setA = bigramSet(a);
  const setB = bigramSet(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const bg of setA) if (setB.has(bg)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

// POST /api/reports - 提交举报
export async function onRequestPost(context) {
  const { request, env } = context;

  await ensureAnnotationSchema(env);

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const { annotationId, reason } = body;

  // 参数校验
  if (!annotationId || !/^\d{1,18}$/.test(String(annotationId))) {
    return Response.json({ error: '无效的批注ID' }, { status: 400 });
  }
  if (!reason || typeof reason !== 'string') {
    return Response.json({ error: '请填写举报理由' }, { status: 400 });
  }
  // 理由长度：至少10个字符
  const trimmed = reason.trim();
  if (trimmed.length < 10) {
    return Response.json({ error: '举报理由至少10个字' }, { status: 400 });
  }
  if (trimmed.length > 500) {
    return Response.json({ error: '举报理由不能超过500字' }, { status: 400 });
  }

  // 可选认证（游客也可举报）
  const auth = await checkAdmin(request, env);
  const reporterId = auth.ok ? auth.userId : null;

  // 游客用 IP hash
  let guestHash = null;
  if (!reporterId) {
    const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
    guestHash = [...new Uint8Array(buf)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // 检查用户是否被禁言（禁言期间不可举报）
  if (reporterId) {
    const user = await env.DB.prepare('SELECT muted_until, banned_at FROM admin_users WHERE id = ?').bind(reporterId).first();
    if (user?.banned_at) {
      return Response.json({ error: '账号已被封禁' }, { status: 403 });
    }
    if (user?.muted_until && new Date(user.muted_until) > new Date()) {
      return Response.json({ error: '禁言期间不可举报' }, { status: 403 });
    }
  }

  // 检查批注是否存在
  const anno = await env.DB.prepare(
    'SELECT id, book_id, user_id, status FROM annotations WHERE id = ?'
  ).bind(annotationId).first();
  if (!anno || anno.status === 'removed') {
    return Response.json({ error: '批注不存在或已被移除' }, { status: 404 });
  }

  // 不能举报自己的批注
  if (reporterId && anno.user_id === reporterId) {
    return Response.json({ error: '不能举报自己的批注' }, { status: 400 });
  }

  // 每人每批注最多2次举报
  if (reporterId) {
    const cnt = await env.DB.prepare(
      'SELECT COUNT(*) as cnt FROM reports WHERE annotation_id = ? AND reporter_id = ?'
    ).bind(annotationId, reporterId).first();
    if (cnt && cnt.cnt >= 2) {
      return Response.json({ error: '您已对此批注举报过2次' }, { status: 400 });
    }
    // 登录用户：每小时最多20次举报
    const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
    const hourCnt = await env.DB.prepare(
      'SELECT COUNT(*) as cnt FROM reports WHERE reporter_id = ? AND created_at > ?'
    ).bind(reporterId, oneHourAgo).first();
    if (hourCnt && hourCnt.cnt >= 20) {
      return Response.json({ error: '操作过于频繁，请稍后再试' }, { status: 429 });
    }
  } else {
    // 游客：同IP每批注最多2次
    const cnt = await env.DB.prepare(
      'SELECT COUNT(*) as cnt FROM reports WHERE annotation_id = ? AND reporter_guest_hash = ?'
    ).bind(annotationId, guestHash).first();
    if (cnt && cnt.cnt >= 2) {
      return Response.json({ error: '您已对此批注举报过2次' }, { status: 400 });
    }
    // 游客：每小时最多3次举报
    const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
    const hourCnt = await env.DB.prepare(
      'SELECT COUNT(*) as cnt FROM reports WHERE reporter_guest_hash = ? AND created_at > ?'
    ).bind(guestHash, oneHourAgo).first();
    if (hourCnt && hourCnt.cnt >= 3) {
      return Response.json({ error: '操作过于频繁，请稍后再试' }, { status: 429 });
    }
  }

  // 举报理由相似度检测
  const existing = await env.DB.prepare(
    'SELECT reason FROM reports WHERE annotation_id = ?'
  ).bind(annotationId).all();
  for (const r of (existing.results || [])) {
    if (jaccardSimilarity(trimmed, r.reason) >= 0.6) {
      return Response.json({ error: '与已有举报理由过于相似，请提供不同角度的理由' }, { status: 400 });
    }
  }

  // 插入举报
  await env.DB.prepare(`
    INSERT INTO reports (annotation_id, book_id, reporter_id, reporter_guest_hash, reason)
    VALUES (?, ?, ?, ?, ?)
  `).bind(annotationId, anno.book_id, reporterId, guestHash, trimmed).run();

  // 检查是否达到举报阈值
  const reportCount = await env.DB.prepare(`
    SELECT 
      SUM(CASE WHEN reporter_id IS NOT NULL THEN 1 ELSE 0.2 END) as effective_count,
      SUM(CASE WHEN reporter_id IS NOT NULL THEN 1 ELSE 0 END) as registered_count
    FROM reports WHERE annotation_id = ? AND status = 'pending'
  `).bind(annotationId).first();

  const threshold = 10; // 默认阈值，后续可从 site_settings 读取
  if (reportCount && reportCount.effective_count >= threshold && reportCount.registered_count >= 3) {
    // 达到阈值：标记批注为 reported，记录时间
    await env.DB.prepare(`
      UPDATE annotations SET status = 'reported', updated_at = datetime('now') WHERE id = ? AND status = 'normal'
    `).bind(annotationId).run();
    await env.DB.prepare(`
      UPDATE reports SET threshold_reached_at = datetime('now') WHERE annotation_id = ? AND threshold_reached_at IS NULL
    `).bind(annotationId).run();
  }

  return Response.json({ success: true });
}
