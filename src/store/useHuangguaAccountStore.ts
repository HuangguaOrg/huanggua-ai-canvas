/** Account display state only; passwords, verification flows and grants never enter Zustand. */
import { create } from 'zustand';
import {
  authenticateHuanggua, authorizeHuangguaDesktop, clearHuangguaSession, closeHuangguaDashboardSession,
  createSessionSecret, HuangguaAuthError, loadHuangguaSession, readHuangguaAccount,
  revokeHuangguaSession, saveHuangguaSession, verifyHuangguaLogin,
} from '../services/huangguaAccountService';
import type { HuangguaAccount, HuangguaAccountSnapshot, HuangguaLoginResult } from '../services/huangguaAccountService';
import { clearHuangguaModels, syncHuangguaModels } from '../services/huangguaModelConnectionService';

interface AccountState {
  phase: 'idle' | 'restoring' | 'starting' | 'verification' | 'connected' | 'error';
  account: HuangguaAccount | null;
  modelCounts: Record<string, number>;
  dialogOpen: boolean;
  busy: boolean;
  hasSession: boolean;
  error: string | null;
  notice: string | null;
  initialize: () => Promise<void>;
  startLogin: (username: string, password: string) => Promise<void>;
  verifyLogin: (code: string) => Promise<void>;
  cancelVerification: () => void;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  setDialogOpen: (open: boolean) => void;
  dispose: () => void;
}

function errorCode(error: unknown): string {
  return error instanceof HuangguaAuthError ? error.code : 'storage';
}

export function createHuangguaAccountStore() {
  let session: string | null = null;
  let verification: Extract<HuangguaLoginResult, { kind: 'verification' }> | null = null;
  let dashboardCleanup: string | null = null;
  let initialized = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => clearTimeout(timer);

  return create<AccountState>((set, get) => {
    const cleanupDashboard = async () => {
      if (!dashboardCleanup) return;
      try { await closeHuangguaDashboardSession(dashboardCleanup); dashboardCleanup = null; set({ notice: null }); }
      catch { set({ notice: 'cleanup_pending' }); }
    };
    const connected = async (snapshot: HuangguaAccountSnapshot, attempt: number) => {
      if (attempt !== generation) return;
      let counts: Record<string, number>;
      try { counts = await syncHuangguaModels(snapshot.connections, () => attempt === generation); }
      catch { throw new HuangguaAuthError('model_sync'); }
      if (attempt !== generation) return;
      set({ phase: 'connected', account: snapshot.account, modelCounts: counts, error: null,
        busy: false, hasSession: true, notice: dashboardCleanup ? 'cleanup_pending' : null });
      stop();
      timer = setTimeout(() => { void get().refresh(); }, Math.max(1000, Math.min(60000, snapshot.account.expiresAt - Date.now())));
    };
    const clear = async () => {
      await clearHuangguaModels();
      await clearHuangguaSession();
      session = null;
      set({ account: null, modelCounts: {}, hasSession: false });
    };
    const completeLogin = async (token: string, attempt: number) => {
      dashboardCleanup = token;
      let snapshot: HuangguaAccountSnapshot | undefined;
      try {
        if (attempt !== generation) return;
        const next = createSessionSecret();
        await saveHuangguaSession(next);
        session = next;
        set({ hasSession: true });
        await authorizeHuangguaDesktop(token, next);
        if (attempt !== generation) return;
        snapshot = await readHuangguaAccount(next);
      } finally { await cleanupDashboard(); }
      if (snapshot) await connected(snapshot, attempt);
    };
    const failed = async (error: unknown, attempt: number) => {
      if (attempt !== generation) return;
      await clearHuangguaModels();
      if (attempt !== generation) return;
      set({ phase: 'error', account: null, modelCounts: {}, error: errorCode(error), busy: false });
    };
    return {
      phase: 'idle', account: null, modelCounts: {}, dialogOpen: false, busy: false, hasSession: false, error: null, notice: null,
      setDialogOpen: (dialogOpen) => set({ dialogOpen }),
      dispose: () => { ++generation; stop(); verification = null; },
      initialize: async () => {
        if (initialized) return;
        initialized = true;
        set({ phase: 'restoring', busy: true });
        try {
          await clearHuangguaModels();
          session = await loadHuangguaSession();
          set({ hasSession: !!session });
          if (session) {
            await get().refresh();
            if (!get().hasSession) set({ dialogOpen: true });
          }
          else set({ phase: 'idle', busy: false, dialogOpen: true });
        } catch { set({ phase: 'error', error: 'storage', busy: false, dialogOpen: true }); }
      },
      startLogin: async (username, password) => {
        if (get().busy || session) return;
        stop(); verification = null;
        const attempt = ++generation;
        set({ phase: 'starting', busy: true, error: null, notice: null });
        try {
          await clearHuangguaModels();
          const result = await authenticateHuanggua(username, password);
          password = '';
          if (result.kind === 'authenticated') await completeLogin(result.accessToken, attempt);
          else if (attempt === generation) {
            verification = result;
            set({ phase: 'verification', busy: false });
          }
        } catch (error) { await failed(error, attempt); }
      },
      verifyLogin: async (code) => {
        if (get().busy || !verification) return;
        if (verification.expiresAt <= Date.now()) {
          verification = null; set({ phase: 'error', error: 'verification_expired' }); return;
        }
        const attempt = ++generation;
        set({ busy: true, error: null });
        try {
          const token = await verifyHuangguaLogin(verification.flowToken, code);
          verification = null;
          set({ phase: 'starting' });
          await completeLogin(token, attempt);
        } catch (error) {
          if (attempt !== generation) return;
          if (verification && errorCode(error) !== 'verification_expired') {
            set({ phase: 'verification', busy: false, error: errorCode(error) });
          } else { verification = null; await failed(error, attempt); }
        }
      },
      cancelVerification: () => {
        if (get().busy) return;
        ++generation; verification = null; set({ phase: 'idle', error: null });
      },
      refresh: async () => {
        if (!session || (get().busy && get().phase !== 'restoring')) return;
        const attempt = ++generation;
        stop(); set({ busy: true, error: null, notice: null });
        try {
          await cleanupDashboard();
          await connected(await readHuangguaAccount(session), attempt);
        } catch (error) {
          if (attempt !== generation) return;
          if (errorCode(error) === 'invalid_session') {
            try { await revokeHuangguaSession(session); await clear(); }
            catch (cleanupError) { await failed(cleanupError, attempt); return; }
          }
          await failed(error, attempt);
        }
      },
      logout: async () => {
        if (get().busy) return;
        const attempt = ++generation;
        stop(); verification = null;
        set({ busy: true, account: null, modelCounts: {}, error: null, notice: null });
        try {
          await clearHuangguaModels();
          await cleanupDashboard();
          if (session) await revokeHuangguaSession(session);
          await clear();
          set({ phase: 'idle', busy: false, error: null });
        } catch (error) { await failed(error, attempt); }
      },
    };
  });
}

export const useHuangguaAccountStore = createHuangguaAccountStore();
if (import.meta.hot) import.meta.hot.dispose(() => useHuangguaAccountStore.getState().dispose());
