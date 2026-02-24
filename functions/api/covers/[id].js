// GET /api/covers/:id — 公开获取书籍封面图片
import { validateId } from '../_utils.js';

export async function onRequestGet(context) {
  const { env, params } = context;
  const id = params.id;
  if (!validateId(id)) return new Response('Not found', { status: 404 });

  const book = await env.DB.prepare('SELECT cover_key FROM books WHERE id = ?').bind(id).first();
  if (!book || !book.cover_key) return new Response('Not found', { status: 404 });

  const obj = await env.R2.get(book.cover_key);
  if (!obj) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  headers.set('Content-Type', obj.httpMetadata?.contentType || 'image/jpeg');
  headers.set('Cache-Control', 'public, max-age=86400');
  return new Response(obj.body, { headers });
}
