import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadHuangguaReference } from '../../src/services/huangguaMediaUpload';
import { corsSafeFetch } from '../../src/services/ai/httpTransport';
vi.mock('../../src/services/ai/httpTransport', () => ({ corsSafeFetch: vi.fn() }));
const fetcher = vi.mocked(corsSafeFetch);
const blob = new Blob(['fixture'], { type: 'image/png' });
const videoBlob = new Blob(['ftypmp42fixture'], { type: 'video/mp4' });
afterEach(() => vi.resetAllMocks());
describe('Huanggua reference uploads', () => {
  it('uses only the authenticated Huanggua media endpoint for image and video references', async () => {
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ url: 'https://huanggua.my/media/fixture', expires_at: Date.now() / 1000 + 3600 })));
    expect(await uploadHuangguaReference(blob, 'test.png', 'fixture-key', 'fixture-model')).toBe('https://huanggua.my/media/fixture');
    expect(fetcher).toHaveBeenCalledWith('https://huanggua.my/v1/media/uploads?model=fixture-model', expect.objectContaining({
      method: 'POST', redirect: 'error', headers: { Authorization: 'Bearer fixture-key' }, body: expect.any(FormData),
    }), { sensitive: true });

    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ url: 'https://huanggua.my/media/video-fixture', expires_at: Date.now() / 1000 + 3600 })));
    expect(await uploadHuangguaReference(videoBlob, 'clip.mp4', 'fixture-key', 'catcode-Seedance-2.0-官转', undefined, 'video')).toBe('https://huanggua.my/media/video-fixture');
  });
  it.each(['https://untrusted.test/image', 'https://huanggua.my@untrusted.test/image', 'https://huanggua.my/image#fragment'])('rejects invalid returned URLs: %s', async (url) => {
    fetcher.mockResolvedValue(new Response(JSON.stringify({ url, expires_at: Date.now() / 1000 + 3600 })));
    await expect(uploadHuangguaReference(blob, 'test.png', 'fixture-key', 'fixture-model')).rejects.toThrow('地址无效');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('never falls back to another service on authorization failure', async () => {
    fetcher.mockResolvedValue(new Response('private provider details', { status: 403 }));
    await expect(uploadHuangguaReference(blob, 'test.png', 'fixture-key', 'fixture-model')).rejects.toThrow('HTTP 403');
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('rejects expired references and missing credentials before generation', async () => {
    await expect(uploadHuangguaReference(blob, 'test.png', '', 'fixture-model')).rejects.toThrow('重新登录');
    expect(fetcher).not.toHaveBeenCalled();
    fetcher.mockResolvedValue(new Response(JSON.stringify({ url: 'https://huanggua.my/media/fixture', expires_at: 1 })));
    await expect(uploadHuangguaReference(blob, 'test.png', 'fixture-key', 'fixture-model')).rejects.toThrow('已过期');
  });
});
