/** Direct Huanggua login over HTTPS. Passwords and dashboard tokens are never persisted. */
import { corsSafeFetch } from './ai/httpTransport';
import { isTauriEnv } from './fs/core';
import { deleteAppSecret, readAppSecret, writeAppSecret } from './providerSecretService';

export const HUANGGUA_ORIGIN = 'https://huanggua.my';
const SESSION_KEY = 'huanggua/session';
const DEVICE_KEY = 'huanggua/device';
let browserSession: string | null = null;
let browserDevice: string | null = null;

export interface HuangguaAccount {
  id: number;
  name: string;
  username: string;
  balance: string;
  expiresAt: number;
}

export interface HuangguaChallenge {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
  intervalMs: number;
}

export class HuangguaAuthError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type Endpoint = 'device' | 'token' | 'account' | 'authorize' | 'status' | 'user/login' | 'user/login/encryption-key' | 'user/login/verify' | 'user/auth/logout';

async function request(path: Endpoint, method: string, body?: unknown, session?: string): Promise<unknown> {
  const apiPath = ['device', 'token', 'account', 'authorize'].includes(path) ? `arcreel/${path}` : path;
  const url = !isTauriEnv() && import.meta.env.DEV
    ? `/api/huanggua-client/${apiPath}` : `${HUANGGUA_ORIGIN}/api/${apiPath}`;
  try {
    const response = await corsSafeFetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(isTauriEnv() ? { Origin: HUANGGUA_ORIGIN } : {}),
        ...(session ? { Authorization: `Bearer ${session}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    }, { sensitive: true });
    if (response.status === 401) throw new HuangguaAuthError('invalid_session');
    if (response.status === 429) throw new HuangguaAuthError('slow_down');
    if (response.status >= 500) throw new HuangguaAuthError('network');
    const envelope: unknown = await response.json();
    if (!record(envelope)) throw new HuangguaAuthError('invalid_response');
    if (!response.ok || envelope.success !== true) {
      const allowed = ['authorization_pending', 'slow_down', 'expired_token', 'access_denied', 'invalid_session'];
      const code = typeof envelope.error === 'string' && allowed.includes(envelope.error) ? envelope.error : 'unavailable';
      const serverCode = envelope.code ?? (record(envelope.data) ? envelope.data.code : undefined);
      if (serverCode === 'AUTH_FLOW_INVALID') throw new HuangguaAuthError('verification_expired');
      if (path === 'user/login') throw new HuangguaAuthError('bad_credentials');
      if (path === 'user/login/verify') throw new HuangguaAuthError('invalid_code');
      throw new HuangguaAuthError(code);
    }
    return envelope.data;
  } catch (error) {
    if (error instanceof HuangguaAuthError) throw error;
    // Never surface upstream bodies, headers or raw errors containing secrets.
    throw new HuangguaAuthError('network');
  }
}

export function createSessionSecret(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function loadHuangguaSession(): Promise<string | null> {
  const value = isTauriEnv() ? await readAppSecret(SESSION_KEY) : browserSession;
  if (value !== null && !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new HuangguaAuthError('storage');
  return value;
}

export async function saveHuangguaSession(value: string): Promise<void> {
  if (isTauriEnv()) {
    if (!await writeAppSecret(SESSION_KEY, value)) throw new HuangguaAuthError('storage');
  } else browserSession = value;
}

export async function clearHuangguaSession(): Promise<void> {
  if (isTauriEnv()) {
    if (!await deleteAppSecret(SESSION_KEY)) throw new HuangguaAuthError('storage');
  } else browserSession = null;
}

export async function startHuangguaAuthorization(session: string): Promise<HuangguaChallenge> {
  let device = isTauriEnv() ? await readAppSecret(DEVICE_KEY) : browserDevice;
  if (!device) {
    device = await sha256(createSessionSecret());
    if (isTauriEnv()) {
      if (!await writeAppSecret(DEVICE_KEY, device)) throw new HuangguaAuthError('storage');
    } else browserDevice = device;
  }
  if (!/^[0-9a-f]{64}$/.test(device)) throw new HuangguaAuthError('storage');
  const data = await request('device', 'POST', {
    device_id: device, session_hash: await sha256(session), device_name: '黄瓜 AI 画布',
  });
  if (!record(data) || typeof data.device_code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(data.device_code)
    || typeof data.user_code !== 'string' || !/^[A-F0-9]{5}-[A-F0-9]{5}$/.test(data.user_code)
    || typeof data.expires_in !== 'number' || data.expires_in <= 0 || data.expires_in > 600
    || typeof data.interval !== 'number' || !Number.isFinite(data.interval) || data.interval < 1 || data.interval > 60
    || data.verification_uri_complete !== `${HUANGGUA_ORIGIN}/connect/arcreel?code=${data.user_code}`) {
    throw new HuangguaAuthError('invalid_response');
  }
  return {
    deviceCode: data.device_code, userCode: data.user_code,
    verificationUrl: data.verification_uri_complete as string,
    expiresAt: Date.now() + data.expires_in * 1000, intervalMs: Math.max(5000, data.interval * 1000),
  };
}

export async function pollHuangguaAuthorization(deviceCode: string): Promise<void> {
  const data = await request('token', 'POST', { device_code: deviceCode });
  if (!record(data) || data.authorized !== true) throw new HuangguaAuthError('invalid_response');
}

const LEGACY_DEVICE_KEY_RE = /^sk-[A-Za-z0-9_-]{16,256}$/;
const ACCOUNT_BOUND_KEY_RE: Record<HuangguaModelGrant['category'], RegExp> = {
  text: /^sk-ad1\.[0-9a-f]{64}\.text\.[0-9a-f]{64}$/,
  image: /^sk-ad1\.[0-9a-f]{64}\.image\.[0-9a-f]{64}$/,
  video: /^sk-ad1\.[0-9a-f]{64}\.video\.[0-9a-f]{64}$/,
};

export async function readHuangguaAccount(session: string): Promise<HuangguaAccountSnapshot> {
  const data = await request('account', 'GET', undefined, session);
  if (!record(data) || !record(data.user) || !record(data.balance)
    || typeof data.user.id !== 'number' || !Number.isSafeInteger(data.user.id) || data.user.id <= 0
    || typeof data.user.username !== 'string' || typeof data.user.name !== 'string'
    || typeof data.balance.display !== 'string' || typeof data.expires_at !== 'number'
    || !Number.isFinite(data.expires_at) || data.expires_at <= Date.now() / 1000) {
    throw new HuangguaAuthError('invalid_response');
  }
  const connections: HuangguaModelGrant[] = [];
  if (!record(data.services)) throw new HuangguaAuthError('invalid_response');
  for (const category of ['text', 'image', 'video'] as const) {
    const service = data.services[category];
    if (!record(service)) throw new HuangguaAuthError('invalid_response');
    if (service.status !== 'connected') continue;
    if (service.base_url !== HUANGGUA_ORIGIN || typeof service.api_key !== 'string'
      || !Array.isArray(service.models)
      || service.models.length > 5000 || service.models.some((m) => typeof m !== 'string' || !m.trim() || m.length > 300)) {
      throw new HuangguaAuthError('invalid_response');
    }
    if (!ACCOUNT_BOUND_KEY_RE[category].test(service.api_key)) {
      // Pre-migration sessions issued per-login keys; force one re-login to bind the account's three fixed groups.
      if (LEGACY_DEVICE_KEY_RE.test(service.api_key)) throw new HuangguaAuthError('invalid_session');
      throw new HuangguaAuthError('invalid_response');
    }
    connections.push({ category, apiKey: service.api_key, models: [...new Set(service.models as string[])] });
  }
  return { account: { id: data.user.id, name: data.user.name.slice(0, 100), username: data.user.username.slice(0, 100),
    balance: data.balance.display.slice(0, 60), expiresAt: data.expires_at * 1000 }, connections };
}

export async function revokeHuangguaSession(session: string): Promise<void> {
  try { await request('account', 'DELETE', undefined, session); }
  catch (error) { if (!(error instanceof HuangguaAuthError) || error.code !== 'invalid_session') throw error; }
}

export interface HuangguaModelGrant {
  category: 'text' | 'image' | 'video';
  apiKey: string;
  models: string[];
}
export interface HuangguaAccountSnapshot {
  account: HuangguaAccount;
  connections: HuangguaModelGrant[];
}
export type HuangguaLoginResult =
  | { kind: 'authenticated'; accessToken: string }
  | { kind: 'verification'; flowToken: string; expiresAt: number };

function parseLogin(data: unknown): HuangguaLoginResult {
  if (!record(data)) throw new HuangguaAuthError('invalid_response');
  if (data.require_verification === true) {
    if (typeof data.flow_token !== 'string' || data.flow_token.length > 4096 || !data.flow_token
      || typeof data.expires_at !== 'number' || !Number.isFinite(data.expires_at) || data.expires_at * 1000 <= Date.now()
      || !Array.isArray(data.methods)) throw new HuangguaAuthError('invalid_response');
    if (!data.methods.some((method) => record(method) && method.method === '2fa' && method.available === true)) {
      throw new HuangguaAuthError('verification_unavailable');
    }
    return { kind: 'verification', flowToken: data.flow_token, expiresAt: data.expires_at * 1000 };
  }
  if (typeof data.access_token !== 'string' || !data.access_token || data.access_token.length > 16384
    || typeof data.access_expires_at !== 'number' || data.access_expires_at * 1000 <= Date.now()) {
    throw new HuangguaAuthError('invalid_response');
  }
  return { kind: 'authenticated', accessToken: data.access_token };
}

function base64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

async function passwordFields(password: string): Promise<Record<string, string>> {
  const data = await request('user/login/encryption-key', 'GET');
  if (!record(data)) throw new HuangguaAuthError('invalid_response');
  if (data.enabled === false) return { password };
  if (data.enabled !== true || typeof data.kid !== 'string' || typeof data.public_key !== 'string') {
    throw new HuangguaAuthError('invalid_response');
  }
  try {
    const pem = data.public_key.replace(/-----[A-Z ]+-----|\s/g, '');
    const key = await crypto.subtle.importKey('spki', Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)),
      { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
    const bytes = new TextEncoder().encode(password);
    let encrypted: string;
    if (bytes.length <= (key.algorithm as RsaHashedKeyAlgorithm).modulusLength / 8 - 66) {
      encrypted = base64(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, bytes));
    } else {
      const secret = crypto.getRandomValues(new Uint8Array(32));
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const aes = await crypto.subtle.importKey('raw', secret, 'AES-GCM', false, ['encrypt']);
      const wrapped = await crypto.subtle.encrypt({ name: 'RSA-OAEP', label: new TextEncoder().encode('password-v2') }, key, secret);
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce,
        additionalData: new TextEncoder().encode(`password-v2:${data.kid}`) }, aes, bytes);
      encrypted = `v2.${base64(wrapped)}.${base64(nonce.buffer)}.${base64(ciphertext)}`;
    }
    return { password_encrypted: encrypted, encryption_key_id: data.kid };
  } catch { throw new HuangguaAuthError('encryption'); }
}

export async function authenticateHuanggua(username: string, password: string): Promise<HuangguaLoginResult> {
  if (!username.trim() || username.length > 254 || !password || password.length > 4096) throw new HuangguaAuthError('bad_credentials');
  const status = await request('status', 'GET');
  if (!record(status) || status.password_login_enabled !== true) throw new HuangguaAuthError('password_disabled');
  // Respect server policy; never fall back to bypassing an interactive challenge.
  if (status.turnstile_check === true) throw new HuangguaAuthError('interactive_required');
  return parseLogin(await request('user/login', 'POST', { username: username.trim(), ...await passwordFields(password) }));
}

export async function verifyHuangguaLogin(flowToken: string, code: string): Promise<string> {
  if (!code.trim() || code.length > 128) throw new HuangguaAuthError('invalid_code');
  const result = parseLogin(await request('user/login/verify', 'POST', { flow_token: flowToken, method: '2fa', code: code.trim() }));
  if (result.kind !== 'authenticated') throw new HuangguaAuthError('invalid_response');
  return result.accessToken;
}

export async function closeHuangguaDashboardSession(accessToken: string): Promise<void> {
  await request('user/auth/logout', 'POST', {}, accessToken);
}

/** Exchange the short-lived dashboard login for the existing limited desktop/model grant. */
export async function authorizeHuangguaDesktop(accessToken: string, session: string): Promise<void> {
  const challenge = await startHuangguaAuthorization(session);
  await request('authorize', 'POST', { code: challenge.userCode, approve: true }, accessToken);
  try { await pollHuangguaAuthorization(challenge.deviceCode); }
  catch (error) {
    // Claim is single-use: recover via the session instead of automatically replaying it.
    try { await readHuangguaAccount(session); } catch { throw error; }
  }
}
