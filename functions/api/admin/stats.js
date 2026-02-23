// GET /api/admin/stats — 访问统计数据
import { checkAdmin } from '../_utils.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const auth = await checkAdmin(request, env);
  if (!auth.ok) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    // 今日统计
    const today = new Date().toISOString().slice(0, 10);
    const todayStats = await env.DB.prepare(
      "SELECT pv, uv FROM site_visits WHERE date = ?"
    ).bind(today).first() || { pv: 0, uv: 0 };

    // 最近30天统计
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const { results: dailyStats } = await env.DB.prepare(
      "SELECT date, pv, uv FROM site_visits WHERE date >= ? ORDER BY date ASC"
    ).bind(thirtyDaysAgo).all();

    // 总计
    const totals = await env.DB.prepare(
      "SELECT COALESCE(SUM(pv), 0) as total_pv, COALESCE(SUM(uv), 0) as total_uv FROM site_visits"
    ).first();

    // 热门书籍（最近30天阅读量Top10）
    const { results: hotBooks } = await env.DB.prepare(`
      SELECT bs.book_id, b.title, SUM(bs.views) as total_views
      FROM book_stats bs
      JOIN books b ON bs.book_id = b.id
      WHERE bs.date >= ?
      GROUP BY bs.book_id
      ORDER BY total_views DESC
      LIMIT 10
    `).bind(thirtyDaysAgo).all();

    // 热门章节（总阅读量Top10）
    const { results: hotChapters } = await env.DB.prepare(`
      SELECT cs.chapter_id, c.title as chapter_title, b.title as book_title, cs.views
      FROM chapter_stats cs
      JOIN chapters c ON cs.chapter_id = c.id
      JOIN books b ON c.book_id = b.id
      ORDER BY cs.views DESC
      LIMIT 10
    `).all();

    return Response.json({
      today: todayStats,
      totals,
      daily: dailyStats,
      hotBooks,
      hotChapters
    });
  } catch (e) {
    console.error('Stats error:', e);
    return Response.json({ error: '获取统计失败' }, { status: 500 });
  }
}
