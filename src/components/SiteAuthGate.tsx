import React, { useState, useEffect, useCallback } from 'react';
import {
  Lock,
  KeyRound,
  ShieldCheck,
  Copy,
  Check,
  LogOut,
  Server,
  Eye,
  EyeOff,
  X,
  Link2,
  Plus,
  Trash2,
  Key,
} from 'lucide-react';
import { PWAInstallButton } from './PWAInstallButton';

export interface AuthSessionState {
  loading: boolean;
  require_login: boolean;
  password_changed: boolean;
  has_env_secrets?: boolean;
  owner_login: string;
  authenticated: boolean;
  role: 'owner' | 'client';
  login: string;
  account_id?: string;
  client_code?: string;
}

export interface InviteLinkItem {
  id: string;
  label: string;
  token: string;
  role: 'client' | 'owner';
  enabled: boolean;
  uses_count: number;
  last_used_at: string | null;
  created_at: string;
}

interface SiteLoginScreenProps {
  authState: AuthSessionState;
  onLoginSuccess: (token: string, nextState: Partial<AuthSessionState>) => void;
}

/**
 * Скрытый экран ("для других людей там ничего не будет"):
 * - Посторонний человек по обычной ссылке видит полностью пустой тёмный экран без единой надписи.
 * - Владелец открывает форму входа:
 *   1) по ссылке с параметром ?owner=1 (или #owner)
 *   2) комбинацией клавиш Ctrl + Shift + L (или тройным нажатием клавиши Escape)
 *   3) кликом по потайной зоне в правом нижнем углу экрана
 */
export const SiteLoginScreen: React.FC<SiteLoginScreenProps> = ({
  onLoginSuccess,
}) => {
  const [showOwnerBox, setShowOwnerBox] = useState<boolean>(true);

  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [inputUnlocked, setInputUnlocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Горячие клавиши для владельца: Ctrl+Shift+L или 3 раза Escape
  useEffect(() => {
    let escCount = 0;
    let escTimer: ReturnType<typeof setTimeout> | null = null;

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        setShowOwnerBox((v) => !v);
      } else if (e.key === 'Escape') {
        escCount += 1;
        if (escTimer) clearTimeout(escTimer);
        if (escCount >= 3) {
          setShowOwnerBox(true);
          escCount = 0;
        } else {
          escTimer = setTimeout(() => {
            escCount = 0;
          }, 900);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      if (escTimer) clearTimeout(escTimer);
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'owner', login, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Неверный логин или пароль');
        return;
      }
      onLoginSuccess(data.token, {
        authenticated: true,
        role: data.role || 'owner',
        login: data.login || login,
        owner_login: data.owner_login || login,
        has_env_secrets: data.has_env_secrets,
      });
    } catch {
      setError('Ошибка соединения');
    } finally {
      setSubmitting(false);
    }
  };

  // Если форма владельца не вызвана — для посторонних людей на сайте абсолютно пусто
  if (!showOwnerBox) {
    return (
      <div className="min-h-screen w-full bg-[#0b0d10] select-none relative overflow-hidden">
        {/* Незаметный значок замка в правом нижнем углу для входа владельца */}
        <button
          type="button"
          onClick={() => setShowOwnerBox(true)}
          aria-label="Owner Access"
          title="Вход владельца"
          className="fixed bottom-2 right-2 w-8 h-8 rounded-full opacity-15 hover:opacity-80 focus:opacity-80 flex items-center justify-center text-[#6b7280] hover:text-[#00b4d8] transition-opacity"
        >
          <Lock className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0b0d10] text-[#e2e8f0] flex items-center justify-center p-4 select-none">
      <div className="w-full max-w-sm rounded-xl bg-[#16191f] border border-[#262b35] shadow-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-[#222730] flex items-center justify-between bg-[#1a1e25]">
          <div className="flex items-center gap-2">
            <Lock className="w-4 h-4 text-[#00b4d8]" />
            <span className="text-[14px] font-bold text-white">Вход владельца</span>
          </div>
          <button
            type="button"
            onClick={() => setShowOwnerBox(false)}
            className="text-[#6b7280] hover:text-white"
            title="Скрыть окно входа"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} autoComplete="off" className="p-5 space-y-3.5">
          {error && (
            <div className="p-2.5 rounded-lg bg-rose-500/15 border border-rose-500/40 text-rose-300 text-[12px]">
              {error}
            </div>
          )}

          <div>
            <label className="block text-[11px] uppercase tracking-wider text-[#9ca3af] mb-1">
              Логин (OWNER_LOGIN)
            </label>
            <input
              type="text"
              name="scalpbot_owner_id_noautofill"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              data-lpignore="true"
              data-form-type="other"
              readOnly={!inputUnlocked}
              onFocus={() => setInputUnlocked(true)}
              value={login}
              onChange={(e) => setLogin(e.target.value)}
              required
              placeholder="Введите логин владельца"
              className="w-full px-3 py-2 rounded-lg bg-[#0f1216] border border-[#2d333f] text-[13px] text-white focus:outline-none focus:border-[#00b4d8]"
            />
          </div>

          <div>
            <label className="block text-[11px] uppercase tracking-wider text-[#9ca3af] mb-1">
              Пароль (OWNER_PASSWORD)
            </label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                name="scalpbot_owner_secret_noautofill"
                autoComplete="new-password"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                data-lpignore="true"
                data-form-type="other"
                readOnly={!inputUnlocked}
                onFocus={() => setInputUnlocked(true)}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                placeholder="Введите пароль"
                className="w-full pl-3 pr-9 py-2 rounded-lg bg-[#0f1216] border border-[#2d333f] text-[13px] text-white focus:outline-none focus:border-[#00b4d8]"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#9ca3af] hover:text-white"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full py-2.5 rounded-lg bg-[#00b4d8] hover:bg-[#0096c7] disabled:opacity-50 text-[#090d11] font-bold text-[13px] transition flex items-center justify-center gap-2"
          >
            <KeyRound className="w-4 h-4" />
            <span>{submitting ? 'Вход...' : 'Войти'}</span>
          </button>
        </form>
      </div>
    </div>
  );
};

interface SiteSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  authState: AuthSessionState;
  token: string;
  onUpdated: (nextState: Partial<AuthSessionState>, nextToken?: string) => void;
  onLogout: () => void;
}

export const SiteSettingsModal: React.FC<SiteSettingsModalProps> = ({
  isOpen,
  onClose,
  authState,
  token,
  onUpdated,
  onLogout,
}) => {
  const [invites, setInvites] = useState<InviteLinkItem[]>([]);
  const [inviteLabel, setInviteLabel] = useState('');
  const [inviteRole, setInviteRole] = useState<'client' | 'owner'>('client');
  const [creatingInvite, setCreatingInvite] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [newLogin, setNewLogin] = useState(authState.owner_login || 'admin');
  const [newPassword, setNewPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  const siteOrigin =
    typeof window !== 'undefined'
      ? window.location.origin
      : 'https://ais-pre-3oglhtkei5ro6lgcnspstm-222140735969.europe-west1.run.app';

  const fetchInvites = useCallback(async () => {
    if (authState.role !== 'owner') return;
    try {
      const res = await fetch('/api/v1/auth/invites', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) {
        const data = await res.json();
        setInvites(data.invites || []);
      }
    } catch {
      // ignore
    }
  }, [authState.role, token]);

  useEffect(() => {
    if (isOpen) {
      fetchInvites();
      setNewLogin(authState.owner_login || 'admin');
    }
  }, [isOpen, fetchInvites, authState.owner_login]);

  if (!isOpen) return null;

  const copyText = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleCreateInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteLabel.trim()) return;
    setCreatingInvite(true);
    try {
      const res = await fetch('/api/v1/auth/invites', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          label: inviteLabel.trim(),
          role: inviteRole,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setInvites(data.invites || []);
        setInviteLabel('');
      }
    } finally {
      setCreatingInvite(false);
    }
  };

  const handleDeleteInvite = async (id: string) => {
    const res = await fetch(`/api/v1/auth/invites/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (res.ok) {
      const data = await res.json();
      setInvites(data.invites || []);
    }
  };

  const handleSaveAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSavedMsg(null);
    try {
      const res = await fetch('/api/v1/auth/settings', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          new_login: newLogin,
          new_password: newPassword.trim() ? newPassword.trim() : undefined,
          require_login: true,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setNewPassword('');
        setSavedMsg('Резервный логин и пароль обновлены в базе');
        onUpdated(
          {
            owner_login: data.owner_login,
            password_changed: data.password_changed,
            require_login: data.require_login,
          },
          data.token
        );
      }
    } finally {
      setSaving(false);
    }
  };

  const ownerDirectLink = `${siteOrigin}/?owner=1`;

  return (
    <div className="fixed inset-0 z-[180] flex items-center justify-center bg-black/75 backdrop-blur-xs p-4">
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl bg-[#181b20] border border-[#2d333f] shadow-2xl text-[#e2e8f0]">
        {/* Шапка */}
        <div className="px-5 py-4 border-b border-[#252a34] flex items-center justify-between bg-[#1c2026]">
          <div className="flex items-center gap-2.5">
            <ShieldCheck className="w-5 h-5 text-[#00b4d8]" />
            <div>
              <h2 className="text-[15px] font-bold text-white">
                Скрытый режим сайта, Секреты владельца и Доступ по ссылкам
              </h2>
              <p className="text-[11px] text-[#9ca3af]">
                Для посторонних сайт полностью пустой • Вход только для вас или по созданной вами ссылке
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-[#9ca3af] hover:text-white p-1"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-5 text-[12px]">
          {/* Блок 1: Персональные ссылки доступа для других людей */}
          {authState.role === 'owner' && (
            <div className="p-4 rounded-lg bg-[#121519] border border-[#262b35] space-y-3.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 font-semibold text-white">
                  <Link2 className="w-4 h-4 text-[#00b4d8]" />
                  <span>1. Выдать доступ по ссылке другим людям</span>
                </div>
                <span className="text-[11px] text-[#9ca3af]">
                  Активных ссылок: <strong className="text-white">{invites.length}</strong>
                </span>
              </div>

              <p className="text-[11px] text-[#9ca3af]">
                Без такой ссылки любой посторонний человек при открытии сайта видит{' '}
                <strong className="text-white">абсолютно пустой чёрный экран</strong>. Создайте персональную ссылку для нужного человека — при переходе по ней сайт откроется автоматически:
              </p>

              <form onSubmit={handleCreateInvite} className="flex flex-col sm:flex-row gap-2">
                <input
                  type="text"
                  value={inviteLabel}
                  onChange={(e) => setInviteLabel(e.target.value)}
                  placeholder="Кому ссылка (например: Партнёр Алексей)"
                  required
                  className="flex-1 px-3 py-1.5 rounded bg-[#181b20] border border-[#2d333f] text-white focus:outline-none focus:border-[#00b4d8]"
                />
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as 'client' | 'owner')}
                  className="px-2.5 py-1.5 rounded bg-[#181b20] border border-[#2d333f] text-white"
                >
                  <option value="client">Просмотр (без API-ключей)</option>
                  <option value="owner">Полный доступ</option>
                </select>
                <button
                  type="submit"
                  disabled={creatingInvite}
                  className="px-3.5 py-1.5 rounded bg-[#00b4d8] hover:bg-[#0096c7] text-[#090d11] font-semibold inline-flex items-center justify-center gap-1.5 shrink-0"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Создать ссылку</span>
                </button>
              </form>

              {/* Список созданных ссылок */}
              {invites.length > 0 ? (
                <div className="space-y-2 pt-1">
                  {invites.map((inv) => {
                    const fullLink = `${siteOrigin}/?invite=${inv.token}`;
                    const isCopied = copiedId === inv.id;
                    return (
                      <div
                        key={inv.id}
                        className="p-2.5 rounded-lg bg-[#181b20] border border-[#262b35] flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-white truncate">{inv.label}</span>
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-[#00b4d8]/15 text-[#38bdf8]">
                              {inv.role === 'owner' ? 'Полный' : 'Просмотр'}
                            </span>
                            <span className="text-[10px] text-[#9ca3af]">
                              Входов: {inv.uses_count}
                            </span>
                          </div>
                          <div className="text-[10px] font-mono text-[#6b7280] truncate mt-0.5">
                            {fullLink}
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => copyText(fullLink, inv.id)}
                            className="px-2.5 py-1 rounded bg-[#252a34] hover:bg-[#303643] text-white inline-flex items-center gap-1 text-[11px]"
                          >
                            {isCopied ? (
                              <Check className="w-3.5 h-3.5 text-[#10b981]" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                            <span>{isCopied ? 'Скопировано' : 'Скопировать ссылку'}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteInvite(inv.id)}
                            className="p-1.5 rounded bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 text-rose-300"
                            title="Отозвать ссылку и закрыть человеку доступ"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-[11px] text-[#6b7280] italic">
                  Ни одной гостевой ссылки пока не создано — доступ есть только у вас.
                </div>
              )}
            </div>
          )}

          {/* Блок 2: Секреты владельца (OWNER_LOGIN и OWNER_PASSWORD) */}
          {authState.role === 'owner' && (
            <div className="p-4 rounded-lg bg-[#121519] border border-[#262b35] space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 font-semibold text-white">
                  <Key className="w-4 h-4 text-[#10b981]" />
                  <span>2. Ваши секреты владельца (`OWNER_LOGIN` и `OWNER_PASSWORD`)</span>
                </div>
                <span
                  className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                    authState.has_env_secrets
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                      : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                  }`}
                >
                  {authState.has_env_secrets
                    ? 'Заданы через Секреты (Secrets)'
                    : 'Можно задать в панели Secrets'}
                </span>
              </div>

              <div className="p-3 rounded bg-[#181b20] border border-[#252a34] text-[11px] text-[#cfd6df] space-y-1.5">
                <div>
                  В проект добавлены секретные переменные окружения{' '}
                  <code className="text-[#38bdf8] font-mono">OWNER_LOGIN</code> и{' '}
                  <code className="text-[#38bdf8] font-mono">OWNER_PASSWORD</code> (в файл{' '}
                  <code className="font-mono">.env.example</code>).
                </div>
                <div className="text-[#9ca3af]">
                  • Чтобы вызвать скрытое окно входа владельца на пустом экране: перейдите по вашей ссылке{' '}
                  <code className="text-[#38bdf8] font-mono">/?owner=1</code>, либо нажмите{' '}
                  <code className="text-white font-mono">Ctrl + Shift + L</code> (или 3 раза{' '}
                  <code className="text-white font-mono">Esc</code>, либо клик в правый нижний угол экрана).
                </div>
              </div>

              {/* Ссылка владельца */}
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={ownerDirectLink}
                  className="flex-1 px-3 py-1.5 rounded bg-[#181b20] border border-[#2d333f] font-mono text-[11px] text-[#38bdf8]"
                />
                <button
                  type="button"
                  onClick={() => copyText(ownerDirectLink, 'owner-link')}
                  className="px-3 py-1.5 rounded bg-[#252a34] hover:bg-[#303643] text-white inline-flex items-center gap-1.5 text-[11px] font-medium shrink-0"
                >
                  {copiedId === 'owner-link' ? (
                    <Check className="w-3.5 h-3.5 text-[#10b981]" />
                  ) : (
                    <Copy className="w-3.5 h-3.5" />
                  )}
                  <span>
                    {copiedId === 'owner-link' ? 'Скопировано' : 'Ссылка входа владельца'}
                  </span>
                </button>
              </div>

              {/* Форма смены пароля в БД (если не задан через Secrets) */}
              <form onSubmit={handleSaveAuth} className="pt-2 space-y-2.5 border-t border-[#222730]">
                {savedMsg && (
                  <div className="p-2 rounded bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 text-[11px]">
                    {savedMsg}
                  </div>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <div>
                    <label className="block text-[11px] text-[#9ca3af] mb-1">
                      Логин владельца
                    </label>
                    <input
                      type="text"
                      value={newLogin}
                      onChange={(e) => setNewLogin(e.target.value)}
                      className="w-full px-3 py-1.5 rounded bg-[#181b20] border border-[#2d333f] text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-[#9ca3af] mb-1">
                      Новый пароль владельца
                    </label>
                    <input
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder="Введите новый пароль..."
                      className="w-full px-3 py-1.5 rounded bg-[#181b20] border border-[#2d333f] text-white"
                    />
                  </div>
                </div>
                <div className="flex items-center justify-between pt-1">
                  <button
                    type="button"
                    onClick={onLogout}
                    className="px-3 py-1.5 rounded bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/40 text-rose-300 inline-flex items-center gap-1.5 text-[11px] font-medium"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    <span>Скрыть сайт (Выйти)</span>
                  </button>

                  <button
                    type="submit"
                    disabled={saving}
                    className="px-4 py-1.5 rounded bg-[#00b4d8] hover:bg-[#0096c7] text-[#090d11] font-semibold text-[11px]"
                  >
                    {saving ? 'Сохранение...' : 'Сохранить логин/пароль'}
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* Блок 3: Установка PWA и деплой */}
          <div className="p-4 rounded-lg bg-[#121519] border border-[#262b35] flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-[11px] text-[#cfd6df]">
              <Server className="w-4 h-4 text-[#f59e0b] shrink-0" />
              <span>
                Установите сайт как приложение (PWA) или разверните 24/7 через встроенный{' '}
                <code className="text-[#38bdf8]">Dockerfile</code> / <code className="text-[#38bdf8]">render.yaml</code>.
              </span>
            </div>
            <PWAInstallButton />
          </div>
        </div>
      </div>
    </div>
  );
};
