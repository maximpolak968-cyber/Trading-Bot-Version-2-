import React, { useState, useEffect } from 'react';
import {
  TrendingUp,
  TrendingDown,
  ShieldCheck,
  RefreshCw,
  LogOut,
  ExternalLink,
  DollarSign,
  Activity,
  Layers,
  Award,
} from 'lucide-react';
import { FreqtradeTrade } from '../types/frequi';

interface ClientAccountInfo {
  id: string;
  name: string;
  exchange: string;
  balance_usdt: number;
  open_trades_count: number;
  unrealized_pnl: number;
  copy_trading: boolean;
  stake_pct: number;
  leverage: number;
  last_sync: string;
}

interface ClientDashboardData {
  account: ClientAccountInfo;
  open_trades: FreqtradeTrade[];
  closed_trades: FreqtradeTrade[];
  total_profit_usdt: number;
  winrate: number;
  current_pair: string;
}

interface ClientDashboardViewProps {
  clientCode: string;
  onLogout: () => void;
}

export const ClientDashboardView: React.FC<ClientDashboardViewProps> = ({
  clientCode,
  onLogout,
}) => {
  const [data, setData] = useState<ClientDashboardData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<string>('');

  const fetchClientData = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(`/api/v1/client/dashboard?code=${encodeURIComponent(clientCode)}`);
      if (!res.ok) {
        throw new Error('Не удалось загрузить данные аккаунта по коду доступа');
      }
      const json: ClientDashboardData = await res.json();
      setData(json);
      setLastRefreshed(new Date().toLocaleTimeString('ru-RU'));
    } catch (e: any) {
      setError(e?.message || 'Ошибка подключения');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchClientData();
    const interval = setInterval(fetchClientData, 10000);
    return () => clearInterval(interval);
  }, [clientCode]);

  if (loading && !data) {
    return (
      <div className="flex-1 min-h-screen bg-[#131722] text-[#e2e8f0] flex items-center justify-center">
        <div className="flex items-center gap-3 text-sm text-[#9ca3af]">
          <RefreshCw className="w-5 h-5 animate-spin text-[#2962ff]" />
          <span>Подключение к личному кабинету автоторговли...</span>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex-1 min-h-screen bg-[#131722] text-[#e2e8f0] flex items-center justify-center p-4">
        <div className="bg-[#181c27] border border-[#ef4444]/40 rounded-lg p-6 max-w-md w-full text-center space-y-4">
          <div className="text-red-400 font-semibold text-base">Ошибка доступа к аккаунту</div>
          <div className="text-xs text-[#9ca3af]">{error}</div>
          <button
            onClick={onLogout}
            className="px-4 py-2 bg-[#2962ff] hover:bg-[#1e4bd8] text-white text-xs font-semibold rounded"
          >
            Вернуться ко входу
          </button>
        </div>
      </div>
    );
  }

  const acc = data.account;
  const stakeAmount = Number((acc.balance_usdt * (acc.stake_pct / 100)).toFixed(2));
  const notionalPosition = Number((stakeAmount * acc.leverage).toFixed(2));

  return (
    <div className="flex-1 min-h-screen bg-[#131722] text-[#e2e8f0] flex flex-col font-sans select-none overflow-y-auto">
      {/* Top Header */}
      <header className="h-14 bg-[#181c27] border-b border-[#2a2e39] px-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded bg-[#2962ff]/20 border border-[#2962ff]/40 flex items-center justify-center text-[#2962ff]">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-sm text-white tracking-wide">
                Личный кабинет инвестора: {acc.name}
              </span>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-[#089981]/20 text-[#089981] border border-[#089981]/40">
                {acc.exchange.toUpperCase()} FUTURES
              </span>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-[#2962ff]/20 text-[#38bdf8] border border-[#2962ff]/40">
                КОД: {clientCode}
              </span>
            </div>
            <div className="text-[11px] text-[#9ca3af]">
              Автономная торговля бота • Изолированный профиль
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={fetchClientData}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#1e222d] border border-[#363a45] text-xs text-[#9ca3af] hover:text-white transition-colors"
            title="Обновить данные"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>{lastRefreshed ? `Обновлено ${lastRefreshed}` : 'Обновить'}</span>
          </button>
          <button
            onClick={onLogout}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#3b1219] border border-[#ef4444]/40 text-xs text-[#fca5a5] hover:text-white transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Выйти</span>
          </button>
        </div>
      </header>

      {/* Main Body */}
      <main className="p-6 max-w-7xl mx-auto w-full space-y-6">
        {/* KPI Grid */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <div className="bg-[#181c27] border border-[#2a2e39] rounded p-3.5 flex flex-col justify-between">
            <span className="text-[11px] font-medium text-[#9ca3af] uppercase tracking-wider flex items-center gap-1.5">
              <DollarSign className="w-3.5 h-3.5 text-[#38bdf8]" />
              Ваш баланс
            </span>
            <div className="text-xl font-bold font-mono text-white mt-2">
              ${acc.balance_usdt.toLocaleString('en-US', { minimumFractionDigits: 2 })}
            </div>
            <span className="text-[10.5px] text-[#089981] mt-1">Активный депозит</span>
          </div>

          <div className="bg-[#181c27] border border-[#2a2e39] rounded p-3.5 flex flex-col justify-between">
            <span className="text-[11px] font-medium text-[#9ca3af] uppercase tracking-wider flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-[#a855f7]" />
              Ставка бота (0.5%)
            </span>
            <div className="text-xl font-bold font-mono text-[#a855f7] mt-2">
              ${stakeAmount}
            </div>
            <span className="text-[10.5px] text-[#9ca3af] mt-1">
              Позиция {acc.leverage}x = ${notionalPosition}
            </span>
          </div>

          <div className="bg-[#181c27] border border-[#2a2e39] rounded p-3.5 flex flex-col justify-between">
            <span className="text-[11px] font-medium text-[#9ca3af] uppercase tracking-wider flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5 text-[#fbbf24]" />
              Нереализованный PnL
            </span>
            <div
              className={`text-xl font-bold font-mono mt-2 ${
                acc.unrealized_pnl >= 0 ? 'text-[#089981]' : 'text-[#f23645]'
              }`}
            >
              {acc.unrealized_pnl >= 0 ? '+' : ''}${acc.unrealized_pnl.toFixed(2)}
            </div>
            <span className="text-[10.5px] text-[#9ca3af] mt-1">
              В открытых сделках ({data.open_trades.length})
            </span>
          </div>

          <div className="bg-[#181c27] border border-[#2a2e39] rounded p-3.5 flex flex-col justify-between">
            <span className="text-[11px] font-medium text-[#9ca3af] uppercase tracking-wider flex items-center gap-1.5">
              <TrendingUp className="w-3.5 h-3.5 text-[#089981]" />
              Зафиксировано
            </span>
            <div
              className={`text-xl font-bold font-mono mt-2 ${
                data.total_profit_usdt >= 0 ? 'text-[#089981]' : 'text-[#f23645]'
              }`}
            >
              {data.total_profit_usdt >= 0 ? '+' : ''}${data.total_profit_usdt.toFixed(2)}
            </div>
            <span className="text-[10.5px] text-[#9ca3af] mt-1">
              Сделок закрыто: {data.closed_trades.length}
            </span>
          </div>

          <div className="bg-[#181c27] border border-[#2a2e39] rounded p-3.5 flex flex-col justify-between">
            <span className="text-[11px] font-medium text-[#9ca3af] uppercase tracking-wider flex items-center gap-1.5">
              <Award className="w-3.5 h-3.5 text-[#f59e0b]" />
              Винрейт бота
            </span>
            <div className="text-xl font-bold font-mono text-[#f59e0b] mt-2">
              {data.winrate > 0 ? `${data.winrate}%` : '100%'}
            </div>
            <span className="text-[10.5px] text-[#089981] mt-1">Только прибыльный выход</span>
          </div>

          <div className="bg-[#181c27] border border-[#2a2e39] rounded p-3.5 flex flex-col justify-between">
            <span className="text-[11px] font-medium text-[#9ca3af] uppercase tracking-wider flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-[#10b981]" />
              Статус автоторговли
            </span>
            <div className="text-sm font-bold font-mono text-[#10b981] mt-2 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-[#10b981] animate-ping" />
              АКТИВНО 100%
            </div>
            <span className="text-[10.5px] text-[#9ca3af] mt-1">2-Way Hedge + Smart DCA</span>
          </div>
        </div>

        {/* Info Banner */}
        <div className="bg-[#181c27] border border-[#2962ff]/30 rounded p-4 flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="text-xs font-semibold text-white flex items-center gap-2">
              <span>🚀 Бот подключен к вашему биржевому аккаунту {acc.exchange.toUpperCase()}</span>
              <span className="text-[#38bdf8] text-[11px] font-normal">
                (Ваши API-ключи защищены и изолированы)
              </span>
            </div>
            <div className="text-[11.5px] text-[#9ca3af]">
              Бот открывает парные сделки (LONG + SHORT) с контролируемым объемом строго 0.5% от вашего депозита (${stakeAmount}) с плечом 25x. Стоп-лоссы отсутствуют — выход осуществляется исключительно по ключевым институциональным уровням 4H/1D (от +3% до +8% движения цены) с безопасным динамическим усреднением на подтвержденных разворотах.
            </div>
          </div>
        </div>

        {/* Open Trades Table */}
        <div className="bg-[#181c27] border border-[#2a2e39] rounded overflow-hidden">
          <div className="px-4 py-3 bg-[#1e222d] border-b border-[#2a2e39] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-sm text-white">
                Ваши открытые позиции ({data.open_trades.length})
              </span>
              <span className="text-xs text-[#9ca3af]">
                (Автономные сделки бота по ставке ${stakeAmount})
              </span>
            </div>
            <span className="text-xs font-mono text-[#9ca3af]">Плечо: {acc.leverage}x</span>
          </div>

          {data.open_trades.length === 0 ? (
            <div className="p-8 text-center text-xs text-[#9ca3af]">
              В данный момент бот ожидает оптимальную точку входа на волатильных парах с объемом от $50M.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-[#2a2e39] bg-[#151922] text-[#9ca3af] font-mono text-[11px]">
                    <th className="py-2.5 px-4">Пара</th>
                    <th className="py-2.5 px-4">Сторона</th>
                    <th className="py-2.5 px-4">Маржа / Объем</th>
                    <th className="py-2.5 px-4">Цена входа</th>
                    <th className="py-2.5 px-4">Текущая цена</th>
                    <th className="py-2.5 px-4">Цель TP</th>
                    <th className="py-2.5 px-4">Усреднение (DCA)</th>
                    <th className="py-2.5 px-4 text-right">Текущий PnL</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#2a2e39] font-mono">
                  {data.open_trades.map((t) => {
                    const isPositive = t.profit_abs >= 0;
                    return (
                      <tr key={t.trade_id} className="hover:bg-[#1e222d]/60 transition-colors">
                        <td className="py-3 px-4 font-bold text-white">{t.pair}</td>
                        <td className="py-3 px-4">
                          <span
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-bold ${
                              t.is_short
                                ? 'bg-[#f23645]/15 text-[#f23645] border border-[#f23645]/40'
                                : 'bg-[#089981]/15 text-[#089981] border border-[#089981]/40'
                            }`}
                          >
                            {t.is_short ? (
                              <TrendingDown className="w-3 h-3" />
                            ) : (
                              <TrendingUp className="w-3 h-3" />
                            )}
                            {t.is_short ? 'SHORT' : 'LONG'} {t.leverage || 25}x
                          </span>
                        </td>
                        <td className="py-3 px-4">
                          <div className="text-white font-semibold">${t.stake_amount.toFixed(2)}</div>
                          <div className="text-[10.5px] text-[#9ca3af]">
                            {t.amount} {t.base_currency}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-[#cbd5e1]">{t.open_rate}</td>
                        <td className="py-3 px-4 text-white font-semibold">{t.current_rate}</td>
                        <td className="py-3 px-4 text-[#089981]">
                          {t.take_profit_abs ? `${t.take_profit_abs}` : '—'}
                        </td>
                        <td className="py-3 px-4">
                          <span className="text-[11px] text-[#cbd5e1]">
                            {t.dca_count && t.dca_count > 0
                              ? `Шаг #${t.dca_count}`
                              : 'Ожидание разворота'}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-right">
                          <div
                            className={`font-bold ${
                              isPositive ? 'text-[#089981]' : 'text-[#f23645]'
                            }`}
                          >
                            {isPositive ? '+' : ''}${t.profit_abs.toFixed(2)}
                          </div>
                          <div
                            className={`text-[10.5px] ${
                              isPositive ? 'text-[#089981]' : 'text-[#f23645]'
                            }`}
                          >
                            {isPositive ? '+' : ''}
                            {t.profit_pct.toFixed(2)}%
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Closed Trades History */}
        <div className="bg-[#181c27] border border-[#2a2e39] rounded overflow-hidden">
          <div className="px-4 py-3 bg-[#1e222d] border-b border-[#2a2e39] flex items-center justify-between">
            <span className="font-semibold text-sm text-white">
              История закрытых сделок вашего аккаунта ({data.closed_trades.length})
            </span>
            <span className="text-xs text-[#089981] font-mono">
              Общая прибыль: +${data.total_profit_usdt.toFixed(2)} USDT
            </span>
          </div>

          {data.closed_trades.length === 0 ? (
            <div className="p-8 text-center text-xs text-[#9ca3af]">
              Закрытых сделок пока нет. По мере фиксации прибыли они автоматически появятся в этом отчете.
            </div>
          ) : (
            <div className="overflow-x-auto max-h-80 overflow-y-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-[#2a2e39] bg-[#151922] text-[#9ca3af] font-mono text-[11px]">
                    <th className="py-2.5 px-4">Дата закрытия</th>
                    <th className="py-2.5 px-4">Пара</th>
                    <th className="py-2.5 px-4">Сторона</th>
                    <th className="py-2.5 px-4">Вход / Выход</th>
                    <th className="py-2.5 px-4">Причина</th>
                    <th className="py-2.5 px-4 text-right">Зафиксированный Профит</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#2a2e39] font-mono">
                  {data.closed_trades.map((t) => {
                    const isPositive = t.profit_abs >= 0;
                    return (
                      <tr key={t.trade_id} className="hover:bg-[#1e222d]/60 transition-colors">
                        <td className="py-2.5 px-4 text-[#9ca3af]">{t.close_date || t.open_date}</td>
                        <td className="py-2.5 px-4 font-bold text-white">{t.pair}</td>
                        <td className="py-2.5 px-4">
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                              t.is_short
                                ? 'bg-[#f23645]/15 text-[#f23645]'
                                : 'bg-[#089981]/15 text-[#089981]'
                            }`}
                          >
                            {t.is_short ? 'SHORT' : 'LONG'}
                          </span>
                        </td>
                        <td className="py-2.5 px-4 text-[#cbd5e1]">
                          {t.open_rate} → {t.close_rate}
                        </td>
                        <td className="py-2.5 px-4 text-[#9ca3af]">
                          {t.exit_reason || 'Target TP'}
                        </td>
                        <td className="py-2.5 px-4 text-right">
                          <span
                            className={`font-bold ${
                              isPositive ? 'text-[#089981]' : 'text-[#f23645]'
                            }`}
                          >
                            {isPositive ? '+' : ''}${t.profit_abs.toFixed(2)} (
                            {isPositive ? '+' : ''}
                            {t.profit_pct.toFixed(2)}%)
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </div>
  );
};
