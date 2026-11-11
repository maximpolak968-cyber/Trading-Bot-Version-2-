import React, { useState, useMemo } from 'react';
import {
  RefreshCw,
  Search,
  CheckCircle2,
  AlertTriangle,
  Wifi,
  Activity,
  Terminal,
  Zap,
  ShieldAlert,
} from 'lucide-react';
import { BotLogEntry, ExchangeAccount, BotConfig } from '../types/frequi';

interface PairlistLogsViewProps {
  logs: BotLogEntry[];
  accounts?: ExchangeAccount[];
  botConfig?: BotConfig | null;
  openTradesCount?: number;
  onRefreshLogs: () => void;
}

type LogCategoryFilter = 'ALL' | 'EXCHANGE' | 'SCANNER' | 'TRADES' | 'ERRORS';

export const PairlistLogsView: React.FC<PairlistLogsViewProps> = ({
  logs,
  accounts = [],
  botConfig,
  openTradesCount = 0,
  onRefreshLogs,
}) => {
  const [logSearch, setLogSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<LogCategoryFilter>('ALL');

  const classifyLogCategory = (entry: BotLogEntry): LogCategoryFilter => {
    const logger = (entry.logger || '').toLowerCase();
    const msg = (entry.message || '').toLowerCase();
    if (entry.level === 'ERROR' || entry.level === 'WARNING' || logger.includes('guard')) {
      return 'ERRORS';
    }
    if (
      logger.includes('exchange') ||
      logger.includes('connect') ||
      msg.includes('подключен') ||
      msg.includes('тестнет') ||
      msg.includes('testnet') ||
      msg.includes('mainnet') ||
      msg.includes('баланс') ||
      msg.includes('api-ключ')
    ) {
      return 'EXCHANGE';
    }
    if (
      logger.includes('scanner') ||
      logger.includes('strategy') ||
      msg.includes('сканирование') ||
      msg.includes('авто-выбор') ||
      msg.includes('1h скальп') ||
      msg.includes('4h 2 стороны')
    ) {
      return 'SCANNER';
    }
    if (
      logger.includes('order') ||
      logger.includes('dca') ||
      logger.includes('hedge') ||
      logger.includes('exit') ||
      logger.includes('bot') ||
      msg.includes('открыт') ||
      msg.includes('закрыт') ||
      msg.includes('ордер') ||
      msg.includes('tp') ||
      msg.includes('усреднение')
    ) {
      return 'TRADES';
    }
    return 'ALL';
  };

  const getCategoryBadge = (entry: BotLogEntry) => {
    const cat = classifyLogCategory(entry);
    if (cat === 'EXCHANGE') {
      return {
        label: 'БИРЖА / БАЛАНС',
        cls: 'bg-[#0ea5e9]/15 border-[#0ea5e9]/40 text-[#38bdf8]',
      };
    }
    if (cat === 'SCANNER') {
      return {
        label: 'АВТО-СКАНЕР',
        cls: 'bg-[#a855f7]/15 border-[#a855f7]/40 text-[#c084fc]',
      };
    }
    if (cat === 'TRADES') {
      return {
        label: 'ОРДЕР / СДЕЛКА',
        cls: 'bg-[#10b981]/15 border-[#10b981]/40 text-[#34d399]',
      };
    }
    if (cat === 'ERRORS') {
      return {
        label: entry.level === 'ERROR' ? 'ОШИБКА' : 'ВНИМАНИЕ',
        cls:
          entry.level === 'ERROR'
            ? 'bg-[#ef4444]/20 border-[#ef4444]/50 text-[#f87171]'
            : 'bg-[#f59e0b]/20 border-[#f59e0b]/50 text-[#fbbf24]',
      };
    }
    return {
      label: 'СИСТЕМА',
      cls: 'bg-[#334155]/40 border-[#475569]/50 text-[#94a3b8]',
    };
  };

  const filteredLogs = useMemo(() => {
    return logs.filter((entry) => {
      if (categoryFilter !== 'ALL') {
        const cat = classifyLogCategory(entry);
        if (categoryFilter === 'ERRORS') {
          if (entry.level !== 'ERROR' && entry.level !== 'WARNING') return false;
        } else if (cat !== categoryFilter) {
          return false;
        }
      }
      if (
        logSearch.trim() &&
        !`${entry.logger} ${entry.message}`.toLowerCase().includes(logSearch.trim().toLowerCase())
      ) {
        return false;
      }
      return true;
    });
  }, [logs, categoryFilter, logSearch]);

  const counts = useMemo(() => {
    let exchange = 0;
    let scanner = 0;
    let trades = 0;
    let errors = 0;
    for (const entry of logs) {
      const cat = classifyLogCategory(entry);
      if (cat === 'EXCHANGE') exchange++;
      else if (cat === 'SCANNER') scanner++;
      else if (cat === 'TRADES') trades++;
      if (entry.level === 'ERROR' || entry.level === 'WARNING') errors++;
    }
    return {
      all: logs.length,
      exchange,
      scanner,
      trades,
      errors,
    };
  }, [logs]);

  const isRunning = botConfig?.state === 'running';

  return (
    <div className="space-y-4">
      {/* 1. СТАТУС БИРЖ И РАБОТЫ БОТА */}
      <div className="bg-[#1c1f24] border border-[#2b313a] rounded-[6px] p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <Activity className="w-4 h-4 text-[#00b4d8]" />
            <div>
              <h2 className="text-sm font-semibold text-white">
                Статус бирж и ядра авто-бота (1H Скальпинг + 4H Вход в 2 стороны)
              </h2>
              <p className="text-[11px] text-[#9ca3af]">
                Контроль подключения API-ключей, реального баланса USDT и активности торгового цикла
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded border font-mono font-semibold ${
                isRunning
                  ? 'bg-[#10b981]/15 border-[#10b981]/40 text-[#34d399]'
                  : 'bg-[#f59e0b]/15 border-[#f59e0b]/40 text-[#fbbf24]'
              }`}
            >
              <span
                className={`w-2 h-2 rounded-full ${
                  isRunning ? 'bg-[#10b981] animate-pulse' : 'bg-[#f59e0b]'
                }`}
              />
              {isRunning ? 'БОТ РАБОТАЕТ (АВТО-РЕЖИМ)' : 'БОТ ОСТАНОВЛЕН'}
            </span>

            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-[#141619] border border-[#2b313a] text-[#e2e8f0] font-mono">
              Открыто сделок: <strong className="text-[#38bdf8]">{openTradesCount}</strong>
            </span>

            <button
              type="button"
              onClick={onRefreshLogs}
              className="inline-flex items-center gap-1.5 px-3 py-1 rounded bg-[#00a8b5] hover:bg-[#00b4d8] text-[#090d11] font-semibold transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Обновить статус и логи</span>
            </button>
          </div>
        </div>

        {/* Карточки подключённых биржевых аккаунтов */}
        {accounts.length === 0 ? (
          <div className="p-3 rounded bg-[#141619] border border-[#2b313a] flex items-center justify-between text-xs text-[#9ca3af]">
            <div className="flex items-center gap-2">
              <Wifi className="w-4 h-4 text-[#f59e0b]" />
              <span>
                Нет подключённых API-ключей бирж. Перейдите во вкладку «API / Клиенты» и добавьте ключи Bybit (Mainnet или Testnet), Binance, OKX, Bitget или BingX.
              </span>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5">
            {accounts.map((acc) => {
              const isConnected = acc.status === 'connected' && acc.enabled;
              return (
                <div
                  key={acc.id}
                  className={`p-3 rounded border flex flex-col justify-between gap-2 ${
                    isConnected
                      ? 'bg-[#141619] border-[#10b981]/40'
                      : 'bg-[#141619] border-[#f59e0b]/40'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="px-2 py-0.5 rounded bg-[#252a34] text-white font-mono font-bold text-[11px] uppercase">
                        {acc.exchange}
                      </span>
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold border ${
                          acc.is_testnet
                            ? 'bg-[#f59e0b]/15 border-[#f59e0b]/40 text-[#fbbf24]'
                            : 'bg-[#0ea5e9]/15 border-[#0ea5e9]/40 text-[#38bdf8]'
                        }`}
                      >
                        {acc.network_label || (acc.is_testnet ? 'TESTNET / DEMO' : 'MAINNET')}
                      </span>
                      <span className="text-xs font-semibold text-white truncate">
                        {acc.name}
                      </span>
                    </div>

                    {isConnected ? (
                      <span className="inline-flex items-center gap-1 text-[11px] font-mono text-[#34d399] shrink-0">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        ONLINE
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[11px] font-mono text-[#fbbf24] shrink-0">
                        <AlertTriangle className="w-3.5 h-3.5" />
                        {acc.enabled ? 'ОШИБКА API' : 'ВЫКЛЮЧЕН'}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center justify-between text-xs pt-1 border-t border-[#232830]">
                    <span className="text-[#9ca3af]">Доступный баланс:</span>
                    <span className="font-mono font-bold text-white">
                      {Number(acc.balance_usdt || 0).toFixed(2)} USDT
                    </span>
                  </div>

                  <div className="text-[11px] text-[#9ca3af] font-mono truncate">
                    Ключ: {acc.api_key_masked} · Синхр: {acc.last_sync || 'сейчас'}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 2. ФИЛЬТР ПО КАТЕГОРИЯМ И ЖИВОЙ ПОТОК ЛОГОВ БОТА */}
      <div className="bg-[#1c1f24] border border-[#2b313a] rounded-[6px] overflow-hidden">
        <div className="p-3.5 border-b border-[#2b313a] flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-[#00b4d8]" />
            <div>
              <h3 className="text-sm font-semibold text-white">
                Живой поток логов бота (/api/v1/logs)
              </h3>
              <p className="text-[11px] text-[#9ca3af]">
                Реальные события подключения к бирже, проверки баланса, сканирования монет (1H Скальпинг / 4H 2 стороны) и исполнения ордеров
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-[#9ca3af] absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={logSearch}
                onChange={(e) => setLogSearch(e.target.value)}
                placeholder="Поиск по паре, бирже или тексту..."
                className="pl-8 pr-3 py-1.5 text-xs bg-[#141619] border border-[#2b313a] rounded text-white placeholder-[#6b7280] focus:outline-none focus:border-[#00b4d8]"
              />
            </div>
          </div>
        </div>

        {/* Кнопки фильтрации по категориям */}
        <div className="px-3.5 py-2.5 bg-[#16191e] border-b border-[#2b313a] flex flex-wrap items-center gap-1.5 text-xs">
          <button
            type="button"
            onClick={() => setCategoryFilter('ALL')}
            className={`px-3 py-1.5 rounded font-medium transition-colors flex items-center gap-1.5 ${
              categoryFilter === 'ALL'
                ? 'bg-[#00a8b5] text-[#090d11] font-semibold'
                : 'bg-[#1c1f24] text-[#cfd6df] hover:bg-[#252a32] border border-[#2b313a]'
            }`}
          >
            <span>Все события</span>
            <span className="px-1.5 py-0.2 rounded bg-black/20 font-mono text-[10px]">
              {counts.all}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setCategoryFilter('EXCHANGE')}
            className={`px-3 py-1.5 rounded font-medium transition-colors flex items-center gap-1.5 ${
              categoryFilter === 'EXCHANGE'
                ? 'bg-[#0ea5e9] text-[#090d11] font-semibold'
                : 'bg-[#1c1f24] text-[#38bdf8] hover:bg-[#252a32] border border-[#2b313a]'
            }`}
          >
            <Wifi className="w-3.5 h-3.5" />
            <span>Подключения и Баланс</span>
            <span className="px-1.5 py-0.2 rounded bg-black/20 font-mono text-[10px]">
              {counts.exchange}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setCategoryFilter('SCANNER')}
            className={`px-3 py-1.5 rounded font-medium transition-colors flex items-center gap-1.5 ${
              categoryFilter === 'SCANNER'
                ? 'bg-[#a855f7] text-white font-semibold'
                : 'bg-[#1c1f24] text-[#c084fc] hover:bg-[#252a32] border border-[#2b313a]'
            }`}
          >
            <Zap className="w-3.5 h-3.5" />
            <span>Сканер и Анализ</span>
            <span className="px-1.5 py-0.2 rounded bg-black/20 font-mono text-[10px]">
              {counts.scanner}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setCategoryFilter('TRADES')}
            className={`px-3 py-1.5 rounded font-medium transition-colors flex items-center gap-1.5 ${
              categoryFilter === 'TRADES'
                ? 'bg-[#10b981] text-[#090d11] font-semibold'
                : 'bg-[#1c1f24] text-[#34d399] hover:bg-[#252a32] border border-[#2b313a]'
            }`}
          >
            <Activity className="w-3.5 h-3.5" />
            <span>Сделки и Ордера</span>
            <span className="px-1.5 py-0.2 rounded bg-black/20 font-mono text-[10px]">
              {counts.trades}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setCategoryFilter('ERRORS')}
            className={`px-3 py-1.5 rounded font-medium transition-colors flex items-center gap-1.5 ${
              categoryFilter === 'ERRORS'
                ? 'bg-[#ef4444] text-white font-semibold'
                : 'bg-[#1c1f24] text-[#f87171] hover:bg-[#252a32] border border-[#2b313a]'
            }`}
          >
            <ShieldAlert className="w-3.5 h-3.5" />
            <span>Ошибки и Защита</span>
            <span className="px-1.5 py-0.2 rounded bg-black/20 font-mono text-[10px]">
              {counts.errors}
            </span>
          </button>
        </div>

        {/* Консоль логов */}
        <div className="bg-[#0d1014] text-[#e2e8f0] p-3.5 font-mono text-xs overflow-x-auto max-h-[540px] overflow-y-auto space-y-1.5">
          {filteredLogs.length === 0 ? (
            <div className="py-8 text-center text-[#6b7280]">
              Нет записей в журнале по выбранному фильтру
            </div>
          ) : (
            filteredLogs.map((entry, idx) => {
              const badge = getCategoryBadge(entry);
              return (
                <div
                  key={`${entry.epoch}-${idx}`}
                  className="py-1.5 px-2.5 rounded bg-[#13171d] border border-[#1f252e] flex flex-wrap items-start gap-2 leading-relaxed"
                >
                  <span className="text-[#64748b] shrink-0">{entry.timestamp}</span>
                  <span
                    className={`px-1.5 py-0.2 rounded border text-[10px] font-semibold shrink-0 ${badge.cls}`}
                  >
                    {badge.label}
                  </span>
                  <span className="text-[#38bdf8] shrink-0">{entry.logger}</span>
                  <span className="text-[#e2e8f0] break-words flex-1 min-w-[240px]">
                    {entry.message}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
