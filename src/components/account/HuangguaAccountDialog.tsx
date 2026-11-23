import { useEffect, useState } from 'react';
import { ArrowRight, Check, LoaderCircle, ShieldCheck, UserPlus } from 'lucide-react';
import { useT } from '../../i18n';
import { HUANGGUA_ORIGIN } from '../../services/huangguaAccountService';
import { useHuangguaAccountStore } from '../../store/useHuangguaAccountStore';
import { openExternal } from '../settings/providerConnection/providerConnectionShared';
import ModalOverlay from '../shared/ModalOverlay';

const REGISTER_URL = `${HUANGGUA_ORIGIN}/register`;

const MESSAGES: Record<string, string> = {
  network: '暂时无法连接黄瓜 AI，请检查网络后重试。',
  storage: '本地凭据存储不可用，请重新打开桌面应用后重试。',
  invalid_session: '登录已过期或被撤销，请重新登录。',
  expired_token: '本次授权已过期，请结束本次登录后重试。',
  access_denied: '账号授权未完成，请重新登录。',
  slow_down: '请求较频繁，请稍后重试。',
  invalid_response: '授权服务返回异常，请稍后重试。',
  unavailable: '授权服务暂不可用，请稍后重试。',
  bad_credentials: '账号或密码不正确，请重新输入。',
  invalid_code: '验证码不正确，请检查后重试。',
  verification_expired: '验证已过期，请重新登录。',
  verification_unavailable: '此账号需使用通行密钥验证，请先在黄瓜 AI 账号设置中启用动态验证码。',
  password_disabled: '平台暂未开放账号密码登录。',
  interactive_required: '平台已开启网页人机验证，当前客户端暂不支持此验证方式。',
  encryption: '密码加密失败，请重试。',
  model_sync: '账号已验证，但模型连接尚未完成，请重试连接。',
  cleanup_pending: '临时登录会话清理未完成，可点击刷新账号重试。',
};

export default function HuangguaAccountDialog() {
  const t = useT();
  const state = useHuangguaAccountStore();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  useEffect(() => { void useHuangguaAccountStore.getState().initialize(); }, []);
  const connected = state.phase === 'connected' && state.account;
  const verifying = state.phase === 'verification';
  const close = () => { setPassword(''); setCode(''); state.setDialogOpen(false); };
  // 登录前不能通过 Esc 或点击遮罩关闭，必须先登录黄瓜 AI 账号。
  const dismiss = () => { if (connected) close(); };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (verifying) { const value = code; setCode(''); void state.verifyLogin(value); }
    else { const value = password; setPassword(''); void state.startLogin(username, value); }
  };

  return <ModalOverlay isOpen={state.dialogOpen} onClose={dismiss} closeOnBackdrop={!!connected} ariaLabel={t('黄瓜 AI 账号')}
    zIndex={1200} className="ui-dialog-surface w-[min(800px,calc(100vw-32px))] max-h-[calc(100dvh-32px)] overflow-y-auto">
    <div className="grid md:grid-cols-[0.95fr_1fr]">
      <section className="relative flex flex-col justify-between gap-8 border-b border-canvas-border bg-canvas-card p-8 md:border-b-0 md:border-r">
        <div className="flex items-center gap-2 text-sm font-semibold text-canvas-text">
          <img src={`${import.meta.env.BASE_URL}huanggua-ai.png`} alt="" className="h-9 w-9 object-contain" />
          黄瓜 AI 画布
        </div>
        <div>
          <img src={`${import.meta.env.BASE_URL}huanggua-ai.png`} alt="" className="mb-4 h-28 w-28 object-contain" />
          <h1 className="text-3xl font-semibold leading-relaxed tracking-tight text-canvas-text">{t('让灵感，在画布上生长。')}</h1>
          <p className="mt-3 text-sm leading-7 text-canvas-text-secondary">{t('连接想法、图像与故事，把创作变成看得见的作品。')}</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-canvas-text-muted"><ShieldCheck size={15} aria-hidden="true" />{t('使用黄瓜 AI 统一账号')}</div>
      </section>
      <section className="relative flex flex-col justify-center p-8 pt-12">
        <p className="mb-2 text-xs font-medium tracking-widest text-canvas-text-muted">HUANGGUA AI</p>
        <h2 className="text-2xl font-semibold text-canvas-text">{t(connected ? '欢迎回来' : verifying ? '验证你的身份' : '登录黄瓜 AI')}</h2>
        <p className="mt-3 text-sm leading-6 text-canvas-text-secondary">{t(connected
          ? '账号和模型已连接，可以直接开始创作。'
          : verifying ? '输入验证器中的动态验证码或恢复码，完成客户端登录。' : '使用黄瓜 AI 账号登录，自动接入可用模型，无需填写 API Key。')}</p>

        {(state.error || state.notice) && <p role={state.error ? 'alert' : 'status'} className="mt-5 rounded-lg border border-canvas-border bg-canvas-hover p-3 text-xs leading-6 text-canvas-text">
          {t(MESSAGES[state.error || state.notice || ''] || MESSAGES.unavailable)}
        </p>}

        {connected && <div className="my-6 rounded-xl border border-canvas-border bg-canvas-card p-5" data-mcp-sensitive="true">
          <div className="flex items-center gap-2 text-sm font-medium text-canvas-text"><Check size={16} aria-hidden="true" />{state.account?.name || state.account?.username}</div>
          <p className="mt-1 text-xs text-canvas-text-muted">@{state.account?.username}</p>
          <p className="mt-5 text-xs text-canvas-text-secondary">{t('账户余额')}</p>
          <p className="mt-1 text-2xl font-semibold text-canvas-text">{state.account?.balance}</p>
          <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm mt-3" disabled={state.busy} onClick={() => void state.refresh()}>{t('刷新账号')}</button>
        </div>}

        {connected && <div className="mb-5 grid grid-cols-3 gap-2 text-center">
          {(['text', 'image', 'video'] as const).map((category) => <div key={category} className="rounded-lg bg-canvas-card py-3">
            <p className="text-lg font-semibold text-canvas-text">{state.modelCounts[category] ?? 0}</p>
            <p className="mt-1 text-xs text-canvas-text-secondary">{t({ text: '文本模型', image: '图片模型', video: '视频模型' }[category])}</p>
          </div>)}
        </div>}

        {!connected && !state.hasSession && <form onSubmit={submit} className="my-6 space-y-4" data-mcp-sensitive="true">
          {verifying ? <label className="block text-xs text-canvas-text-secondary">
            {t('动态验证码或恢复码')}
            <input autoFocus name="code" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)}
              className="ui-input mt-2 w-full" disabled={state.busy} maxLength={128} required />
          </label> : <>
            <label className="block text-xs text-canvas-text-secondary">{t('邮箱或用户名')}
              <input name="username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)}
                className="ui-input mt-2 w-full" disabled={state.busy} maxLength={254} required placeholder={t('请输入黄瓜 AI 账号')} />
            </label>
            <label className="block text-xs text-canvas-text-secondary">{t('密码')}
              <input name="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)}
                className="ui-input mt-2 w-full" disabled={state.busy} maxLength={4096} required placeholder={t('请输入密码')} />
            </label>
          </>}
          <button type="submit" className="ui-btn ui-btn--primary ui-btn--lg w-full" disabled={state.busy || state.error === 'storage'}>
            {state.busy ? <LoaderCircle size={15} className="animate-spin motion-reduce:animate-none" /> : <ArrowRight size={15} />}
            {t(verifying ? '验证并登录' : '登录并接入模型')}
          </button>
          {verifying && <button type="button" className="ui-btn ui-btn--ghost w-full" disabled={state.busy}
            onClick={() => { setCode(''); state.cancelVerification(); }}>{t('返回账号登录')}</button>}
        </form>}

        {state.busy && <p role="status" className="mb-4 flex items-center gap-2 text-xs text-canvas-text-secondary"><LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" />{t('正在连接…')}</p>}
        <div className="flex flex-col gap-2">
          {connected ? <button type="button" className="ui-btn ui-btn--primary ui-btn--lg w-full" onClick={close}>{t('进入画布')}<ArrowRight size={15} /></button>
            : state.hasSession && <button type="button" className="ui-btn ui-btn--primary ui-btn--lg w-full" disabled={state.busy} onClick={() => void state.refresh()}>{t('重试连接')}</button>}
          {state.hasSession && <button type="button" className="ui-btn ui-btn--ghost w-full" disabled={state.busy} onClick={() => void state.logout()}>{t(connected ? '退出登录' : '结束本次登录')}</button>}
          {!connected && <button type="button" className="ui-btn ui-btn--ghost w-full" onClick={() => void openExternal(REGISTER_URL)}>
            <UserPlus size={15} aria-hidden="true" />{t('注册账号')}
          </button>}
        </div>
        <p className="mt-6 text-[11px] leading-5 text-canvas-text-muted">{t('账号信息仅通过 HTTPS 发送至黄瓜 AI。密码和验证码不会保存。')}</p>
        <p className="mt-2 text-[11px] leading-5 text-canvas-text-muted">{t('登录即连接账号可用的文本、图片和视频模型，生成费用从黄瓜 AI 余额扣除。')}</p>
      </section>
    </div>
  </ModalOverlay>;
}
