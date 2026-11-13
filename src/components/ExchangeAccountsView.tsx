import React, { useState } from 'react';
import {
  Key,
  Plus,
  Trash2,
  CheckCircle2,
  PauseCircle,
  ShieldCheck,
  Copy,
  Check,
  Zap,
  RefreshCw,
  FlaskConical,
  Globe,
} from 'lucide-react';
import { ExchangeAccount, SupportedExchange } from '../types/frequi';

interface ExchangeAccountsViewProps {
  accounts: ExchangeAccount[];
  onAddAccount: (payload: {
    name: string;
    owner_label: string;
    exchange: SupportedExchange;
    api_key: string;
    api_secret: string;
    passphrase?: string;
    is_testnet?: boolean;
  }) => Promise<any>;
  onToggleAccount: (id: string, enabled: boolean) => Promise<void>;
  onDeleteAccount: (id: string) => Promise<void>;
  onClearAllAccounts: () => Promise<void>;
  onRefreshAccounts?: () => Promise<void>;
}

const EXCHANGE_META: Record<
  SupportedExchange,
  {
    label: string;
    badgeBg: string;
    badgeText: string;
    badgeBorder: string;
    needsPassphrase?: boolean;
    testnetHint: string;
  }
> = {
  binance: {
    label: 'Binance',
    badgeBg: 'bg-[#f3ba2f]/15',
    badgeText: 'text-[#f3ba2f]',
    badgeBorder: 'border-[#f3ba2f]/40',
    testnetHint: 'Mainnet (fapi.binance.com) + Testnet (testnet.binancefuture.com)',
  },
  bybit: {
    label: 'Bybit',
    badgeBg: 'bg-[#f7a600]/15',
    badgeText: 'text-[#fbbf24]',
    badgeBorder: 'border-[#f7a600]/40',
    testnetHint: 'Mainnet (api.bybit.com) + Testnet (api-testnet.bybit.com) + Demo Trading (api-demo.bybit.com)',
  },
  okx: {
    label: 'OKX',
    badgeBg: 'bg-[#e2e8f0]/15',
    badgeText: 'text-[#f8fafc]',
    badgeBorder: 'border-[#94a3b8]/40',
    needsPassphrase: true,
    testnetHint: 'Mainnet (www.okx.com) + Demo Trading (x-simulated-trading: 1)',
  },
  bitget: {
    label: 'Bitget',
    badgeBg: 'bg-[#00f0ff]/15',
    badgeText: 'text-[#38bdf8]',
    badgeBorder: 'border-[#38bdf8]/40',
    needsPassphrase: true,
    testnetHint: 'Mainnet (api.bitget.com) + Demo Futures (paptrading: 1)',
  },
  bingx: {
    label: 'BingX',
    badgeBg: 'bg-[#2962ff]/20',
    badgeText: 'text-[#60a5fa]',
    badgeBorder: 'border-[#2962ff]/50',
    testnetHint: 'Perpetual Swap V2 (open-api.bingx.com)',
  },
};

export const ExchangeAccountsView: React.FC<ExchangeAccountsViewProps> = ({
  accounts,
  onAddAccount,
  onToggleAccount,
  onDeleteAccount,
  onClearAllAccounts,
  onRefreshAccounts,
}) => {
  const [personName, setPersonName] = useState('');
  const [exchange, setExchange] = useState<SupportedExchange>('bybit');
  const [isTestnet, setIsTestnet] = useState<boolean>(true);
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<{ text: string; isError?: boolean } | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; msg: string }>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleTestConnection = async (acc: ExchangeAccount) => {
    setTestingId(acc.id);
    try {
      const res = await fetch('/api/v1/accounts/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: acc.id, is_testnet: acc.is_testnet }),
      });
      const data = await res.json();
      setTestResults((prev) => ({
        ...prev,
        [acc.id]: {
          success: Boolean(data.success),
          msg: data.message || (data.success ? 'Подключено успешно' : 'Ошибка проверки'),
        },
      }));
      if (data.success && onRefreshAccounts) {
        await onRefreshAccounts();
      }
    } catch (e: any) {
      setTestResults((prev) => ({
        ...prev,
        [acc.id]: {
          success: false,
          msg: e?.message || 'Ошибка сети',
        },
      }));
    } finally {
      setTestingId(null);
    }
  };

  const handleCopyLink = (acc: ExchangeAccount) => {
    const origin = window.location.origin;
    const url = `${origin}/?client=${acc.client_access_code}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopiedId(acc.id);
      setTimeout(() => setCopiedId(null), 2500);
    });
  };

  const needsPassphrase = Boolean(EXCHANGE_META[exchange].needsPassphrase);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!personName.trim() || !apiKey.trim() || !apiSecret.trim()) {
      setNotice({
        text: 'Укажите, кого добавляете, а также API Key и Secret Key',
        isError: true,
      });
      return;
    }
    setSubmitting(true);
    setNotice(null);
    try {
      const result = await onAddAccount({
        name: personName.trim(),
        owner_label: personName.trim(),
        exchange,
        api_key: apiKey.trim(),
        api_secret: apiSecret.trim(),
        passphrase: passphrase.trim() || undefined,
        is_testnet: isTestnet,
      });
      if (result?.error) {
        setNotice({
          text: String(result.error),
          isError: true,
        });
        return;
      }
      const check = result?.connection_check;
      const addedAcc = result?.account;
      const submittedName = personName.trim();
      setPersonName('');
      setApiKey('');
      setApiSecret('');
      setPassphrase('');
      if (check) {
        setNotice({
          text: check.message,
          isError: !check.success,
        });
        if (addedAcc?.id) {
          setTestResults((prev) => ({
            ...prev,
            [addedAcc.id]: {
              success: Boolean(check.success),
              msg: check.message,
            },
          }));
        }
      } else {
        setNotice({
          text: `Аккаунт «${submittedName}» (${EXCHANGE_META[exchange].label}) передан в работу боту`,
          isError: false,
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex-1 bg-[#131722] text-[#e2e8f0] p-4 overflow-y-auto">
      <div className="max-w-[1020px] mx-auto space-y-4">
        {/* Компактная шапка раздела владельца */}
        <div className="bg-[#181c27] border border-[#2a2e39] rounded-[4px] p-3.5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-[4px] bg-[#089981]/15 border border-[#089981]/40 flex items-center justify-center text-[#10b981]">
              <Key className="w-4 h-4" />
            </div>
            <div>
              <h1 className="text-[14px] font-bold text-white">
                Подключение API-ключей бирж (Mainnet / Testnet / Demo)
              </h1>
              <p className="text-[11.5px] text-[#9ca3af]">
                Поддерживаются Bybit (Mainnet, Testnet, Demo), Binance, OKX, Bitget и BingX. Бот автоматически определяет тип сети и синхронизирует реальный USDT-баланс.
              </p>
            </div>
          </div>

          {accounts.length > 0 && (
            <button
              type="button"
              onClick={onClearAllAccounts}
              className="px-2.5 py-1.5 rounded-[4px] bg-[#3b1219] hover:bg-[#ef4444] border border-[#ef4444]/60 text-[#fca5a5] hover:text-white text-[11.5px] font-semibold inline-flex items-center gap-1.5 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Очистить базу ({accounts.length})</span>
            </button>
          )}
        </div>

        {/* Форма добавления: Биржа + Сеть (Mainnet / Testnet) + Кого добавляем + API Key + Secret Key */}
        <form
          onSubmit={handleSubmit}
          className="bg-[#181c27] border border-[#2a2e39] rounded-[4px] p-4 space-y-3.5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#2a2e39] pb-2.5">
            <span className="text-[13px] font-semibold text-white">
              Добавить аккаунт в бота
            </span>
            <span className="text-[11px] text-[#9ca3af] inline-flex items-center gap-1">
              <ShieldCheck className="w-3.5 h-3.5 text-[#10b981]" />
              Авто-определение Mainnet / Testnet + синхронизация баланса
            </span>
          </div>

          {/* Выбор биржи и режима сети (Mainnet vs Testnet/Demo) */}
          <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
            <div className="md:col-span-7">
              <label className="block text-[11.5px] text-[#9ca3af] mb-1.5">
                1. Выберите биржу ({EXCHANGE_META[exchange].testnetHint})
              </label>
              <div className="grid grid-cols-5 gap-1.5">
                {(['binance', 'bybit', 'okx', 'bitget', 'bingx'] as SupportedExchange[]).map((ex) => {
                  const meta = EXCHANGE_META[ex];
                  const active = exchange === ex;
                  return (
                    <button
                      key={ex}
                      type="button"
                      onClick={() => setExchange(ex)}
                      className={`py-2 px-2 rounded-[4px] border text-[12px] font-semibold transition-all ${
                        active
                          ? 'bg-[#2962ff] border-[#2962ff] text-white shadow-sm'
                          : 'bg-[#131722] border-[#363a45] text-[#9ca3af] hover:text-white hover:border-[#4b5563]'
                      }`}
                    >
                      {meta.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="md:col-span-5">
              <label className="block text-[11.5px] text-[#9ca3af] mb-1.5">
                2. Режим сети (плюс авто-определение)
              </label>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => setIsTestnet(false)}
                  className={`py-2 px-2.5 rounded-[4px] border text-[11.5px] font-semibold inline-flex items-center justify-center gap-1.5 transition-all ${
                    !isTestnet
                      ? 'bg-[#089981] border-[#10b981] text-white'
                      : 'bg-[#131722] border-[#363a45] text-[#9ca3af] hover:text-white'
                  }`}
                >
                  <Globe className="w-3.5 h-3.5" />
                  <span>Mainnet (Реал)</span>
                </button>
                <button
                  type="button"
                  onClick={() => setIsTestnet(true)}
                  className={`py-2 px-2.5 rounded-[4px] border text-[11.5px] font-semibold inline-flex items-center justify-center gap-1.5 transition-all ${
                    isTestnet
                      ? 'bg-[#d97706] border-[#f59e0b] text-white'
                      : 'bg-[#131722] border-[#363a45] text-[#9ca3af] hover:text-white'
                  }`}
                >
                  <FlaskConical className="w-3.5 h-3.5" />
                  <span>Testnet / Demo</span>
                </button>
              </div>
            </div>
          </div>

          {/* Поля: Кого добавляем + Ключи */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="block text-[11.5px] text-[#9ca3af] mb-1">
                3. Кого добавляете (Имя / пометка)
              </label>
              <input
                type="text"
                value={personName}
                onChange={(e) => setPersonName(e.target.value)}
                placeholder="Напр.: Мой Bybit Testnet / Алексей"
                className="w-full px-3 py-2 text-[12.5px] bg-[#131722] border border-[#363a45] rounded-[4px] text-white placeholder:text-[#6c757d] focus:outline-none focus:border-[#2962ff]"
              />
            </div>

            <div>
              <label className="block text-[11.5px] text-[#9ca3af] mb-1">
                4. API Key (Публичный ключ)
              </label>
              <input
                type="text"
                value={apiKey}
                onChange={(e) => {
                  const val = e.target.value;
                  setApiKey(val);
                  const clean = val.replace(/[\s"']/g, '');
                  if (clean.length === 64 && exchange === 'bybit' && !passphrase) {
                    setExchange('binance');
                  } else if (
                    clean.length >= 16 &&
                    clean.length <= 24 &&
                    exchange === 'binance' &&
                    !passphrase
                  ) {
                    setExchange('bybit');
                  }
                }}
                placeholder="Вставьте API Key..."
                className="w-full px-3 py-2 text-[12.5px] bg-[#131722] border border-[#363a45] rounded-[4px] text-white font-mono placeholder:text-[#6c757d] focus:outline-none focus:border-[#2962ff]"
              />
            </div>

            <div>
              <label className="block text-[11.5px] text-[#9ca3af] mb-1">
                5. Secret Key (Секретный ключ)
              </label>
              <input
                type="password"
                value={apiSecret}
                onChange={(e) => setApiSecret(e.target.value)}
                placeholder="••••••••••••••••••••"
                className="w-full px-3 py-2 text-[12.5px] bg-[#131722] border border-[#363a45] rounded-[4px] text-white font-mono placeholder:text-[#6c757d] focus:outline-none focus:border-[#2962ff]"
              />
            </div>
          </div>

          {needsPassphrase && (
            <div className="max-w-xs">
              <label className="block text-[11.5px] text-[#9ca3af] mb-1">
                API Passphrase (кодовая фраза для {EXCHANGE_META[exchange].label})
              </label>
              <input
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder="Кодовая фраза ключа..."
                className="w-full px-3 py-1.5 text-[12px] bg-[#131722] border border-[#363a45] rounded-[4px] text-white font-mono placeholder:text-[#6c757d] focus:outline-none focus:border-[#2962ff]"
              />
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            {notice ? (
              <span
                className={`text-[12px] font-medium ${
                  notice.isError ? 'text-[#f87171]' : 'text-[#10b981]'
                }`}
              >
                {notice.text}
              </span>
            ) : (
              <span className="text-[11.5px] text-[#8b949e]">
                После добавления бот проверит подключение к бирже, загрузит реальный USDT-баланс и сразу начнёт открывать сделки.
              </span>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="px-4 py-2 rounded-[4px] bg-[#089981] hover:bg-[#059669] disabled:opacity-50 text-white text-[12.5px] font-semibold inline-flex items-center gap-1.5 transition-colors"
            >
              <Plus className="w-4 h-4" />
              <span>{submitting ? 'Проверка и подключение...' : 'Подключить к боту'}</span>
            </button>
          </div>
        </form>

        {/* Список подключённых людей и ваших аккаунтов */}
        <div className="bg-[#181c27] border border-[#2a2e39] rounded-[4px] overflow-hidden">
          <div className="px-4 py-2.5 bg-[#1e222d] border-b border-[#2a2e39] flex items-center justify-between">
            <span className="text-[13px] font-semibold text-white">
              Подключённые аккаунты ({accounts.length})
            </span>
            <span className="text-[11px] font-mono text-[#9ca3af]">
              Активных у бота: {accounts.filter((a) => a.enabled).length}
            </span>
          </div>

          {accounts.length === 0 ? (
            <div className="py-10 px-4 text-center text-[12.5px] text-[#8b949e]">
              База пуста. Добавьте свой аккаунт (Bybit Testnet / Mainnet и др.) через форму выше — бот автоматически начнёт работать с ним.
            </div>
          ) : (
            <table className="w-full text-left border-collapse text-[12px]">
              <thead>
                <tr className="border-b border-[#2a2e39] bg-[#151922] text-[#9ca3af] font-mono text-[11px]">
                  <th className="py-2.5 px-4">Владелец / Аккаунт</th>
                  <th className="py-2.5 px-4">Биржа / Сеть</th>
                  <th className="py-2.5 px-4">Баланс / Ставка 0.5%</th>
                  <th className="py-2.5 px-4">Ссылка для клиента</th>
                  <th className="py-2.5 px-4">Проверка API и Баланса</th>
                  <th className="py-2.5 px-4">Статус</th>
                  <th className="py-2.5 px-4 text-right">Действие</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#2a2e39]">
                {accounts.map((acc) => {
                  const meta = EXCHANGE_META[acc.exchange] || EXCHANGE_META.bybit;
                  const stakeUsdt = Math.max(5, Number((acc.balance_usdt * 0.005).toFixed(2)));
                  const testRes = testResults[acc.id];
                  const isTesting = testingId === acc.id;

                  return (
                    <tr key={acc.id} className="hover:bg-[#1e222d]/60 transition-colors">
                      <td className="py-2.5 px-4 font-semibold text-white">
                        <div className="flex items-center gap-1.5">
                          <span>{acc.name}</span>
                          {acc.is_owner && (
                            <span className="px-1.5 py-0.2 rounded bg-[#00a8b5]/20 border border-[#00a8b5]/40 text-[#38bdf8] text-[9.5px] font-mono">
                              MASTER
                            </span>
                          )}
                        </div>
                        <div className="text-[10.5px] font-mono text-[#9ca3af]">
                          {acc.api_key_masked}
                        </div>
                      </td>
                      <td className="py-2.5 px-4">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded-[3px] text-[11px] font-mono font-semibold border ${meta.badgeBg} ${meta.badgeText} ${meta.badgeBorder}`}
                          >
                            {acc.network_label || meta.label}
                          </span>
                          {acc.is_testnet ? (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded-[3px] text-[10px] font-mono font-bold bg-[#d97706]/20 text-[#fbbf24] border border-[#f59e0b]/40">
                              TESTNET / DEMO
                            </span>
                          ) : (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded-[3px] text-[10px] font-mono bg-[#089981]/15 text-[#10b981] border border-[#10b981]/30">
                              MAINNET
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-2.5 px-4 font-mono">
                        <div className="text-white font-semibold">${acc.balance_usdt.toFixed(2)}</div>
                        <div className="text-[10.5px] text-[#089981]">
                          0.5% = ${stakeUsdt} ({acc.max_leverage || 25}x)
                        </div>
                        <div className="text-[10px] text-[#9ca3af] mt-0.5">
                          Маржа: ${(acc.used_margin_usdt ?? 0).toFixed(2)} · Своб: $
                          {(acc.available_balance_usdt ?? Math.max(0, acc.balance_usdt - (acc.used_margin_usdt ?? 0))).toFixed(2)}
                        </div>
                      </td>
                      <td className="py-2.5 px-4 font-mono">
                        <div className="flex items-center gap-1.5">
                          <span className="px-1.5 py-0.5 rounded bg-[#131722] border border-[#363a45] text-[#38bdf8] text-[11px]">
                            {acc.client_access_code}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleCopyLink(acc)}
                            className="px-2 py-1 rounded bg-[#2962ff]/15 hover:bg-[#2962ff]/30 text-[#38bdf8] border border-[#2962ff]/40 text-[10.5px] font-sans inline-flex items-center gap-1 transition-colors"
                            title="Скопировать персональную ссылку для клиента"
                          >
                            {copiedId === acc.id ? (
                              <>
                                <Check className="w-3 h-3 text-[#10b981]" />
                                <span className="text-[#10b981]">Скопировано!</span>
                              </>
                            ) : (
                              <>
                                <Copy className="w-3 h-3" />
                                <span>Ссылка</span>
                              </>
                            )}
                          </button>
                        </div>
                      </td>
                      <td className="py-2.5 px-4">
                        <button
                          type="button"
                          onClick={() => handleTestConnection(acc)}
                          disabled={isTesting}
                          className="px-2.5 py-1 rounded bg-[#1e222d] hover:bg-[#2a2e39] border border-[#363a45] text-[11px] text-[#cbd5e1] inline-flex items-center gap-1 transition-colors disabled:opacity-50"
                        >
                          {isTesting ? (
                            <RefreshCw className="w-3 h-3 animate-spin text-[#2962ff]" />
                          ) : (
                            <Zap className="w-3 h-3 text-[#f59e0b]" />
                          )}
                          <span>{isTesting ? 'Синхронизация...' : 'Проверить и синхр.'}</span>
                        </button>
                        {testRes && (
                          <div
                            className={`text-[10.5px] mt-1 max-w-[280px] leading-snug ${
                              testRes.success ? 'text-[#10b981]' : 'text-[#f87171]'
                            }`}
                          >
                            {testRes.msg}
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 px-4">
                        <button
                          type="button"
                          onClick={() => onToggleAccount(acc.id, !acc.enabled)}
                          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[3px] text-[11px] font-mono font-semibold border transition-colors ${
                            acc.enabled
                              ? 'bg-[#063928] text-[#10b981] border-[#10b981]/50 hover:bg-[#064e3b]'
                              : 'bg-[#3b2506] text-[#fbbf24] border-[#f59e0b]/50 hover:bg-[#452c07]'
                          }`}
                          title="Нажмите, чтобы поставить на паузу или вернуть в работу боту"
                        >
                          {acc.enabled ? (
                            <>
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              <span>В работе</span>
                            </>
                          ) : (
                            <>
                              <PauseCircle className="w-3.5 h-3.5" />
                              <span>Пауза</span>
                            </>
                          )}
                        </button>
                      </td>
                      <td className="py-2.5 px-4 text-right">
                        <button
                          type="button"
                          onClick={() => onDeleteAccount(acc.id)}
                          className="px-2.5 py-1 rounded-[3px] bg-[#3b1219] hover:bg-[#ef4444] border border-[#ef4444]/60 text-[#fca5a5] hover:text-white text-[11px] font-semibold inline-flex items-center gap-1 transition-colors"
                          title="Удалить ключи из базы"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>Удалить</span>
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
};
