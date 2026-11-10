import React, { useState } from 'react';
import { Plus, Trash2, Lock, Unlock, RefreshCw, Search } from 'lucide-react';
import { WhitelistResponse, PairLock, BotLogEntry } from '../types/frequi';

interface PairlistLogsViewProps {
  whitelist: WhitelistResponse | null;
  blacklist: string[];
  locks: PairLock[];
  logs: BotLogEntry[];
  onAddBlacklist: (pair: string) => Promise<void>;
  onRemoveBlacklist: (pair: string) => Promise<void>;
  onAddLock: (pair: string, reason: string) => Promise<void>;
  onRemoveLock: (id: number) => Promise<void>;
  onRefreshLogs: () => void;
}

export const PairlistLogsView: React.FC<PairlistLogsViewProps> = ({
  whitelist,
  blacklist,
  locks,
  logs,
  onAddBlacklist,
  onRemoveBlacklist,
  onAddLock,
  onRemoveLock,
  onRefreshLogs,
}) => {
  const [newBlacklistPair, setNewBlacklistPair] = useState('');
  const [newLockPair, setNewLockPair] = useState('BTC/USDT');
  const [newLockReason, setNewLockReason] = useState('Manual Cooldown Lock');
  const [logSearch, setLogSearch] = useState('');
  const [logLevelFilter, setLogLevelFilter] = useState<'ALL' | 'INFO' | 'WARNING' | 'ERROR'>('ALL');

  const handleBlacklistSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newBlacklistPair.trim()) return;
    await onAddBlacklist(newBlacklistPair.trim().toUpperCase());
    setNewBlacklistPair('');
  };

  const handleLockSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newLockPair.trim()) return;
    await onAddLock(newLockPair.trim().toUpperCase(), newLockReason.trim() || 'Manual Lock');
  };

  const filteredLogs = logs.filter((l) => {
    if (logLevelFilter !== 'ALL' && l.level !== logLevelFilter) return false;
    if (
      logSearch.trim() &&
      !`${l.logger} ${l.message}`.toLowerCase().includes(logSearch.trim().toLowerCase())
    ) {
      return false;
    }
    return true;
  });

  return (
    <div className="space-y-6">
      {/* Top Grid: Pairlist Pipeline + Blacklist + Pair Locks */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Pairlist Pipeline & Whitelist (5 cols) */}
        <div className="lg:col-span-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Конвейер Pairlist Handlers (/api/v1/whitelist)
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Цепочка фильтрации рынков Freqtrade перед подачей пар в стратегию
            </p>
          </div>

          <div className="space-y-2 text-xs font-mono">
            {(whitelist?.method || []).map((m, i) => (
              <div
                key={m}
                className="p-2.5 rounded bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 flex items-center justify-between"
              >
                <span className="text-slate-800 dark:text-slate-200">
                  {i + 1}. {m}
                </span>
                <span className="text-emerald-600 dark:text-emerald-400">ACTIVE</span>
              </div>
            ))}
          </div>

          <div className="pt-2 border-t border-slate-200 dark:border-slate-800">
            <div className="text-xs font-medium text-slate-700 dark:text-slate-300 mb-2">
              Текущий Whitelist ({whitelist?.whitelist.length || 0} пар):
            </div>
            <div className="text-xs font-mono text-slate-600 dark:text-slate-400 leading-relaxed">
              {(whitelist?.whitelist || []).join(' · ')}
            </div>
          </div>
        </div>

        {/* Blacklist Management (3 cols) */}
        <div className="lg:col-span-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 flex flex-col justify-between">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Чёрный список (/api/v1/blacklist)
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
              Исключённые из торгов пары ({blacklist.length})
            </p>

            <form onSubmit={handleBlacklistSubmit} className="flex gap-2 mb-4">
              <input
                type="text"
                value={newBlacklistPair}
                onChange={(e) => setNewBlacklistPair(e.target.value)}
                placeholder="Например: SHIB/USDT"
                className="flex-1 px-2.5 py-1.5 text-xs font-mono rounded bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100"
              />
              <button
                type="submit"
                className="px-3 py-1.5 rounded bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-xs font-medium flex items-center gap-1 whitespace-nowrap shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Добавить</span>
              </button>
            </form>

            <div className="space-y-2">
              {blacklist.map((pair) => (
                <div
                  key={pair}
                  className="px-3 py-2 rounded bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs font-mono"
                >
                  <span className="font-semibold text-slate-800 dark:text-slate-200">{pair}</span>
                  <button
                    type="button"
                    onClick={() => onRemoveBlacklist(pair)}
                    title="Удалить из Blacklist"
                    className="text-rose-600 dark:text-rose-400 hover:opacity-80"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-slate-200 dark:border-slate-800 text-[11px] text-slate-500">
            Добавление пары в Blacklist немедленно исключает её из сканирования стратегией.
          </div>
        </div>

        {/* Pair Locks Manager (4 cols) */}
        <div className="lg:col-span-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 flex flex-col justify-between">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Блокировки пар (Pair Locks · /api/v1/locks)
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
              Защита от повторного входа (Cooldown / StoplossGuard)
            </p>

            <form onSubmit={handleLockSubmit} className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-4 text-xs">
              <input
                type="text"
                value={newLockPair}
                onChange={(e) => setNewLockPair(e.target.value)}
                placeholder="Пара (SOL/USDT)"
                className="px-2.5 py-1.5 font-mono rounded bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100"
              />
              <input
                type="text"
                value={newLockReason}
                onChange={(e) => setNewLockReason(e.target.value)}
                placeholder="Причина блокировки"
                className="px-2.5 py-1.5 rounded bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100"
              />
              <button
                type="submit"
                className="px-3 py-1.5 rounded bg-amber-600 hover:bg-amber-500 text-white font-medium flex items-center justify-center gap-1 whitespace-nowrap shrink-0"
              >
                <Lock className="w-3.5 h-3.5" />
                <span>Заблокировать</span>
              </button>
            </form>

            <div className="space-y-2 max-h-48 overflow-y-auto">
              {locks.length === 0 ? (
                <div className="text-xs text-slate-500 py-4 text-center">
                  Активных блокировок пар нет
                </div>
              ) : (
                locks.map((l) => (
                  <div
                    key={l.id}
                    className="p-2.5 rounded bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs font-mono"
                  >
                    <div>
                      <div className="font-semibold text-slate-900 dark:text-slate-100">
                        {l.pair} · <span className="text-amber-600 dark:text-amber-400">{l.reason}</span>
                      </div>
                      <div className="text-[11px] text-slate-500">
                        До: {l.lock_end_time.replace('T', ' ').slice(0, 16)} UTC
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => onRemoveLock(l.id)}
                      title="Снять блокировку"
                      className="p-1.5 rounded text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800"
                    >
                      <Unlock className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Full-Width Live Freqtrade Log Stream (/api/v1/logs) */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
        <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Системный журнал Freqtrade (/api/v1/logs)
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Поток логов ядра бота, стратегии, RPC и ордеров в реальном времени
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={logSearch}
                onChange={(e) => setLogSearch(e.target.value)}
                placeholder="Фильтр по тексту или модулю..."
                className="pl-8 pr-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded text-slate-900 dark:text-slate-100"
              />
            </div>

            <div className="flex items-center gap-1 bg-slate-100 dark:bg-slate-800 p-1 rounded-md text-xs">
              {(['ALL', 'INFO', 'WARNING', 'ERROR'] as const).map((lvl) => (
                <button
                  key={lvl}
                  type="button"
                  onClick={() => setLogLevelFilter(lvl)}
                  className={`px-2.5 py-1 rounded font-mono font-medium transition-colors whitespace-nowrap shrink-0 ${
                    logLevelFilter === lvl
                      ? 'bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  {lvl}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={onRefreshLogs}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-slate-100 dark:bg-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-700 whitespace-nowrap shrink-0"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Обновить логи</span>
            </button>
          </div>
        </div>

        <div className="bg-slate-950 text-slate-200 p-4 font-mono text-xs overflow-x-auto max-h-96 space-y-1.5">
          {filteredLogs.map((entry, idx) => {
            const levelColor =
              entry.level === 'ERROR'
                ? 'text-rose-400'
                : entry.level === 'WARNING'
                ? 'text-amber-400'
                : 'text-emerald-400';
            return (
              <div key={`${entry.epoch}-${idx}`} className="leading-relaxed whitespace-pre-wrap">
                <span className="text-slate-500">{entry.timestamp}</span>{' '}
                <span className="text-sky-400">{entry.logger}</span>{' '}
                <span className={`font-semibold ${levelColor}`}>{entry.level}</span>:{' '}
                <span className="text-slate-200">{entry.message}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
