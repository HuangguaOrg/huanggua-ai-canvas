import { corsSafeFetch } from './ai/httpTransport';

const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/x-m4v']);

/** Account references never fall back to anonymous public hosting. */
export async function uploadHuangguaReference(
  blob: Blob,
  filename: string,
  key: string,
  model: string,
  signal?: AbortSignal,
  kind: 'image' | 'video' = blob.type.startsWith('video/') ? 'video' : 'image',
): Promise<string> {
  if (!key || !model) throw new Error('请重新登录黄瓜 AI 后上传参考素材');
  if (kind === 'video') {
    if ((!VIDEO_MIME_TYPES.has(blob.type) && !/\.(mp4|mov|m4v|webm)$/i.test(filename)) || blob.size <= 0 || blob.size > 64 * 1024 * 1024) {
      throw new Error('黄瓜 AI 参考视频需为 MP4、MOV 或 WebM，且不超过 64 MB');
    }
  } else if (!IMAGE_MIME_TYPES.has(blob.type) || blob.size <= 0 || blob.size > 20 * 1024 * 1024) {
    throw new Error('黄瓜 AI 参考图片需为 PNG、JPEG 或 WebP，且不超过 20 MB');
  }
  const endpoint = new URL('https://huanggua.my/v1/media/uploads');
  endpoint.searchParams.set('model', model);
  const body = new FormData();
  body.append('file', blob, filename);
  const response = await corsSafeFetch(endpoint.href, {
    method: 'POST', body, headers: { Authorization: `Bearer ${key}` }, signal, redirect: 'error',
  }, { sensitive: true });
  signal?.throwIfAborted();
  if (!response.ok) throw new Error(`黄瓜 AI 参考${kind === 'video' ? '视频' : '图片'}上传失败（HTTP ${response.status}），本次未提交生成`);
  const result = await response.json().catch(() => null) as { url?: unknown; expires_at?: unknown } | null;
  let url: URL;
  try { url = new URL(typeof result?.url === 'string' ? result.url : ''); }
  catch { throw new Error('黄瓜 AI 参考素材响应无效，本次未提交生成'); }
  if (url.origin !== 'https://huanggua.my' || url.username || url.password || url.hash
    || typeof result?.expires_at !== 'number' || !Number.isFinite(result.expires_at) || result.expires_at <= Date.now() / 1000 + 300) {
    throw new Error('黄瓜 AI 参考素材地址无效或已过期，本次未提交生成');
  }
  return url.href;
}
