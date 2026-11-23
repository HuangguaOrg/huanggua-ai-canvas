import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticateHuanggua, authorizeHuangguaDesktop, clearHuangguaSession, createSessionSecret,
  loadHuangguaSession, readHuangguaAccount, saveHuangguaSession, verifyHuangguaLogin } from '../../src/services/huangguaAccountService';
const mock = vi.hoisted(() => ({ fetch: vi.fn(), read: vi.fn(), write: vi.fn(), remove: vi.fn() }));
vi.mock('../../src/services/ai/httpTransport', () => ({ corsSafeFetch: mock.fetch }));
vi.mock('../../src/services/fs/core', () => ({ isTauriEnv: () => true }));
vi.mock('../../src/services/providerSecretService', () => ({ readAppSecret: mock.read, writeAppSecret: mock.write, deleteAppSecret: mock.remove }));
const response = (data: unknown) => new Response(JSON.stringify({ success: true, data }));
const bundle = () => ({ access_token: 'fixture-dashboard-token', access_expires_at: Date.now() / 1000 + 600 });
const accountKey = (category: 'text' | 'image' | 'video') => `sk-ad1.${'a'.repeat(64)}.${category}.${'b'.repeat(64)}`;
const services = {
  text: { status: 'connected', base_url: 'https://huanggua.my', api_key: accountKey('text'), models: ['gpt-fixture'] },
  image: { status: 'connected', base_url: 'https://huanggua.my', api_key: accountKey('image'), models: ['grsai-gpt-image-2.6'] },
  video: { status: 'connected', base_url: 'https://huanggua.my', api_key: accountKey('video'), models: ['grsai-minimax-h3-768p'] },
};
beforeEach(() => { vi.resetAllMocks(); mock.read.mockResolvedValue('a'.repeat(64)); mock.write.mockResolvedValue(true); mock.remove.mockResolvedValue(true); });

describe('Direct Huanggua authentication', () => {
  it('uses only the fixed HTTPS origin, suppresses logging and never persists a password', async () => {
    mock.fetch.mockResolvedValueOnce(response({ password_login_enabled: true, turnstile_check: false }))
      .mockResolvedValueOnce(response({ enabled: false })).mockResolvedValueOnce(response(bundle()));
    expect(await authenticateHuanggua('fixture@example.test', 'fixture-password')).toEqual({ kind: 'authenticated', accessToken: 'fixture-dashboard-token' });
    for (const [url, init, options] of mock.fetch.mock.calls) {
      expect(url).toMatch(/^https:\/\/huanggua\.my\/api\//); expect(options).toEqual({ sensitive: true });
      expect(init.credentials).toBe('omit'); expect(init.headers.Origin).toBe('https://huanggua.my');
    }
    expect(mock.write).not.toHaveBeenCalled();
  });
  it('honors the server human-verification policy without submitting credentials', async () => {
    mock.fetch.mockResolvedValueOnce(response({ password_login_enabled: true, turnstile_check: true }));
    await expect(authenticateHuanggua('fixture', 'password')).rejects.toMatchObject({ code: 'interactive_required' });
    expect(mock.fetch).toHaveBeenCalledTimes(1);
  });
  it('encrypts the password when the server requires RSA-OAEP', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
    const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
    const pem = `-----BEGIN PUBLIC KEY-----\n${Buffer.from(spki).toString('base64')}\n-----END PUBLIC KEY-----`;
    mock.fetch.mockResolvedValueOnce(response({ password_login_enabled: true })).mockResolvedValueOnce(response({ enabled: true, kid: 'fixture-kid', public_key: pem })).mockResolvedValueOnce(response(bundle()));
    await authenticateHuanggua('fixture', 'fixture-password');
    const body = JSON.parse(mock.fetch.mock.calls[2][1].body);
    expect(body.password).toBeUndefined(); expect(body.encryption_key_id).toBe('fixture-kid');
    const plaintext = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, pair.privateKey, Buffer.from(body.password_encrypted, 'base64'));
    expect(new TextDecoder().decode(plaintext)).toBe('fixture-password');
  });
  it('requires a supported second factor and submits its opaque flow token', async () => {
    mock.fetch.mockResolvedValueOnce(response({ password_login_enabled: true })).mockResolvedValueOnce(response({ enabled: false }))
      .mockResolvedValueOnce(response({ require_verification: true, flow_token: 'fixture-flow', expires_at: Date.now() / 1000 + 300, methods: [{ method: '2fa', available: true }] }));
    expect(await authenticateHuanggua('fixture', 'password')).toMatchObject({ kind: 'verification', flowToken: 'fixture-flow' });
    mock.fetch.mockResolvedValueOnce(response(bundle()));
    expect(await verifyHuangguaLogin('fixture-flow', '123456')).toBe('fixture-dashboard-token');
    expect(JSON.parse(mock.fetch.mock.calls[3][1].body)).toEqual({ flow_token: 'fixture-flow', method: '2fa', code: '123456' });
  });
  it('authorizes and claims the desktop grant without opening an authorization page', async () => {
    mock.fetch.mockResolvedValueOnce(response({ device_code: 'a'.repeat(43), user_code: 'ABCDE-12345', verification_uri_complete: 'https://huanggua.my/connect/arcreel?code=ABCDE-12345', expires_in: 600, interval: 5 }))
      .mockResolvedValueOnce(response({ approved: true })).mockResolvedValueOnce(response({ authorized: true }));
    const secret = createSessionSecret();
    await authorizeHuangguaDesktop('fixture-dashboard-token', secret);
    expect(mock.fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(['/api/arcreel/device', '/api/arcreel/authorize', '/api/arcreel/token']);
    expect(mock.fetch.mock.calls[0][1].body).not.toContain(secret);
    expect(mock.fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer fixture-dashboard-token');
  });
  it('validates account-bound fixed-group keys, origins and separates display state from secrets', async () => {
    const data = { user: { id: 1, name: '测试账号', username: 'fixture' }, balance: { display: '¥1.00' }, expires_at: Date.now() / 1000 + 3600, services };
    mock.fetch.mockResolvedValueOnce(response(data));
    const snapshot = await readHuangguaAccount('a'.repeat(43));
    expect(snapshot.connections.map((c) => [c.category, c.models])).toEqual([
      ['text', ['gpt-fixture']],
      ['image', ['grsai-gpt-image-2.6']],
      ['video', ['grsai-minimax-h3-768p']],
    ]);
    expect(JSON.stringify(snapshot.account)).not.toContain('sk-ad1.');
    mock.fetch.mockResolvedValueOnce(response({ ...data, services: { ...services, text: { ...services.text, base_url: 'https://attacker.example' } } }));
    await expect(readHuangguaAccount('a'.repeat(43))).rejects.toMatchObject({ code: 'invalid_response' });
    mock.fetch.mockResolvedValueOnce(response({ ...data, services: { ...services, text: { ...services.text, api_key: accountKey('video') } } }));
    await expect(readHuangguaAccount('a'.repeat(43))).rejects.toMatchObject({ code: 'invalid_response' });
    mock.fetch.mockResolvedValueOnce(response({ ...data, services: { ...services, text: { ...services.text, api_key: 'sk-fixture-model-secret-12345' } } }));
    await expect(readHuangguaAccount('a'.repeat(43))).rejects.toMatchObject({ code: 'invalid_session' });
  });
  it('does not surface upstream secrets and fails closed on unavailable storage', async () => {
    mock.fetch.mockResolvedValue(new Response(JSON.stringify({ success: false, error: 'Bearer fixture-private-value' }), { status: 400 }));
    await expect(readHuangguaAccount('a'.repeat(43))).rejects.toMatchObject({ message: 'unavailable' });
    mock.write.mockResolvedValue(false); mock.remove.mockResolvedValue(false);
    await expect(saveHuangguaSession('a'.repeat(43))).rejects.toMatchObject({ code: 'storage' });
    await expect(clearHuangguaSession()).rejects.toMatchObject({ code: 'storage' });
    mock.read.mockResolvedValue('corrupt'); await expect(loadHuangguaSession()).rejects.toMatchObject({ code: 'storage' });
  });
});
