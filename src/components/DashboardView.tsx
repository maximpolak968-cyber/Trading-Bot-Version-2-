import React, { useState, useMemo } from 'react';
import {
  Info,
  Pointer,
  Wallet,
  TrendingUp,
  Percent,
  Layers,
  Activity,
  ShieldCheck,
  ArrowUpRight,
  ArrowDownRight,
} from 'lucide-react';
import {
  FreqtradeTrade,
  fmtComma,
  ExchangeAccount,
  BalanceResponse,
  DailyRecord,
} from '../types/frequi';
import { ProfitPill } from './ProfitPill';

interface DashboardViewProps {
  openTrades?: FreqtradeTrade[];
  closedTrades?: FreqtradeTrade[];
  daily?: DailyRecord[];
  accounts?: ExchangeAccount[];
  balance?: BalanceResponse | null;
  botConfig?: any;
  isOwner?: boolean;
  onTogglePauseNewEntries?: () => Promise<void>;
  onJumpToPair: (pair: string) => void;
  onForceExit?: (tradeId: number) => void;
}

function formatSmartNumber(val?: number): string {
  if (val === undefined || !Number.isFinite(val)) return '0';
  if (Math.abs(val) >= 100) return fmtComma(val, 2);
  if (Math.abs(val) >= 1) return fmtComma(val, 4).replace(/,?0+$/, '');
  return fmtComma(val, 6).replace(/,?0+$/, '');
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  openTrades = [],
  closedTrades = [],
  daily = [],
  accounts = [],
  balance,
  botConfig,
  isOwner = true,
  onTogglePauseNewEntries,
  onJumpToPair,
  onForceExit,
}) => {
  const [timePeriod, setTimePeriod] = useState<'Дни' | 'Недели' | 'Месяцы'>('Дни');
  const [profitMode, setProfitMode] = useState<'Абс $' | 'Отн %'>('Абс $');
  const [binsCount, setBinsCount] = useState<'15' | '20' | '30'>('20');

  // 1. Live Account Balance and Equity Calculation (1:1 with Exchange API)
  const ownerAccount =
    accounts.find((a) => a.enabled && a.is_owner) || accounts.find((a) => a.enabled);
  const startingBalance =
    accounts.filter((a) => a.enabled).length === 0
      ? 0
      : balance?.starting_capital && balance.starting_capital > 0
      ? Number(balance.starting_capital)
      : ownerAccount?.balance_usdt && ownerAccount.balance_usdt > 0
      ? Number(ownerAccount.balance_usdt)
      : Number(botConfig?.starting_balance || 0);

  const maxOpenTrades = Number(botConfig?.max_open_trades || 20);
  const botLeverage = Number(botConfig?.leverage || 25);
  const botName = String(botConfig?.bot_name || 'ScalpBot');
  const strategyName = String(botConfig?.strategy || 'ScalpingStrategy (v2.5-MTF)');

  // 2. Open Trades Metrics (1:1 with Exchange Unrealized PNL & Margin)
  const tradesOpenProfitSum = openTrades.reduce((acc, t) => acc + (t.profit_abs || 0), 0);
  const openProfitAbs =
    typeof balance?.unrealized_pnl === 'number' &&
    Number.isFinite(balance.unrealized_pnl) &&
    (balance.unrealized_pnl !== 0 || openTrades.length === 0)
      ? balance.unrealized_pnl
      : tradesOpenProfitSum;
  const tradesOpenStakeSum = openTrades.reduce((acc, t) => acc + (t.stake_amount || 0), 0);
  const openStakeSum =
    typeof balance?.used_margin === 'number' && balance.used_margin > 0
      ? balance.used_margin
      : tradesOpenStakeSum;
  const openProfitPct = openStakeSum > 0 ? (openProfitAbs / openStakeSum) * 100 : 0;

  // 3. Closed Trades Metrics (strictly real net profit after exchange fees)
  const closedTradesChronological = useMemo(
    () =>
      [...closedTrades].sort(
        (a, b) =>
          (a.close_timestamp || a.open_timestamp || 0) -
          (b.close_timestamp || b.open_timestamp || 0)
      ),
    [closedTrades]
  );

  const closedProfitAbs = closedTrades.reduce(
    (acc, t) => acc + (t.net_profit ?? t.profit_abs ?? 0),
    0
  );
  const totalFeesPaid = closedTrades.reduce((acc, t) => acc + (t.fee_total ?? 0), 0);
  const closedProfitPct =
    startingBalance > 0 ? (closedProfitAbs / startingBalance) * 100 : 0;

  const isScalpTrade = (t: FreqtradeTrade) =>
    t.strategy !== 'GlobalHedgeStrategy' &&
    !t.campaign_id &&
    !String(t.enter_tag || '').toLowerCase().includes('hedge');

  const openScalpTrades = useMemo(() => openTrades.filter(isScalpTrade), [openTrades]);
  const openHedgeTrades = useMemo(
    () => openTrades.filter((t) => !isScalpTrade(t)),
    [openTrades]
  );
  const closedScalpTrades = useMemo(() => closedTrades.filter(isScalpTrade), [closedTrades]);
  const closedHedgeTrades = useMemo(
    () => closedTrades.filter((t) => !isScalpTrade(t)),
    [closedTrades]
  );

  const scalpOpenPnl = openScalpTrades.reduce((s, t) => s + (t.profit_abs || 0), 0);
  const scalpClosedPnl = closedScalpTrades.reduce(
    (s, t) => s + (t.net_profit ?? t.profit_abs ?? 0),
    0
  );
  const hedgeOpenPnl = openHedgeTrades.reduce((s, t) => s + (t.profit_abs || 0), 0);
  const hedgeClosedPnl = closedHedgeTrades.reduce(
    (s, t) => s + (t.net_profit ?? t.profit_abs ?? 0),
    0
  );

  const winningTradesCount = closedTrades.filter(
    (t) => (t.net_profit ?? t.profit_abs ?? 0) > 0
  ).length;
  const losingTradesCount = closedTrades.filter(
    (t) => (t.net_profit ?? t.profit_abs ?? 0) <= 0
  ).length;
  const winRatePct =
    closedTrades.length > 0
      ? (winningTradesCount / closedTrades.length) * 100
      : openProfitAbs >= 0
      ? 100
      : 0;

  // 4. Exact Wallet Balance (1:1 Exchange Balance), Current Equity, and Free Margin
  const walletBalance =
    typeof balance?.wallet_balance === 'number' && balance.wallet_balance > 0
      ? balance.wallet_balance
      : typeof balance?.total === 'number' && balance.total > 0
      ? balance.total
      : ownerAccount?.wallet_balance_usdt && ownerAccount.wallet_balance_usdt > 0
      ? ownerAccount.wallet_balance_usdt
      : ownerAccount?.balance_usdt && ownerAccount.balance_usdt > 0
      ? ownerAccount.balance_usdt
      : startingBalance + closedProfitAbs;

  const currentEquity =
    typeof balance?.equity_balance === 'number' && balance.equity_balance > 0
      ? balance.equity_balance
      : walletBalance + openProfitAbs;
  const freeMargin =
    typeof balance?.available_balance === 'number' &&
    Number.isFinite(balance.available_balance) &&
    balance.available_balance >= 0 &&
    balance.available_balance < 1e8
      ? balance.available_balance
      : Math.max(0, currentEquity - openStakeSum);
  const marginUsagePct = walletBalance > 0 ? (openStakeSum / walletBalance) * 100 : 0;

  // 5. Accurate Daily / Weekly / Monthly Realized Profit from strictly CLOSED trades
  const timeBasedData = useMemo(() => {
    // If timePeriod === 'Дни' and backend /api/v1/daily returned records, use them or compute from closedTradesChronological
    if (timePeriod === 'Дни' && daily && daily.length > 0) {
      return daily.map((d) => ({
        label: d.date,
        pnlAbs: Number((d.abs_profit || 0).toFixed(2)),
        pnlPct: Number(
          (
            d.rel_profit ??
            (startingBalance > 0 ? ((d.abs_profit || 0) / startingBalance) * 100 : 0)
          ).toFixed(2)
        ),
        count: d.trade_count || 0,
      }));
    }

    const map = new Map<string, { label: string; pnlAbs: number; pnlPct: number; count: number }>();

    for (const t of closedTradesChronological) {
      const dateStr = (t.close_date || t.open_date || '').slice(0, 10);
      if (!dateStr) continue;

      let key = dateStr;
      if (timePeriod === 'Недели') {
        const d = new Date(dateStr);
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1);
        const monday = new Date(d.setDate(diff)).toISOString().slice(0, 10);
        key = `Нед ${monday.slice(5)}`;
      } else if (timePeriod === 'Месяцы') {
        key = dateStr.slice(0, 7);
      }

      const curr = map.get(key) || { label: key, pnlAbs: 0, pnlPct: 0, count: 0 };
      const net = Number(t.net_profit ?? t.profit_abs ?? 0);
      curr.pnlAbs = Number((curr.pnlAbs + net).toFixed(2));
      curr.pnlPct = Number(
        (
          startingBalance > 0
            ? (curr.pnlAbs / startingBalance) * 100
            : curr.pnlPct + (t.profit_pct || 0)
        ).toFixed(2)
      );
      curr.count += 1;
      map.set(key, curr);
    }

    const items = Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));

    if (items.length === 0) {
      const today = new Date().toISOString().slice(0, 10);
      items.push({
        label: today,
        pnlAbs: 0,
        pnlPct: 0,
        count: 0,
      });
    }

    return items;
  }, [closedTradesChronological, daily, startingBalance, timePeriod]);

  // 6. Cumulative Profit Points (chronological: 0 -> trade 1 -> trade 2 ... -> current)
  const cumulativePoints = useMemo(() => {
    let cum = 0;
    const pts: { label: string; val: number; date: string }[] = [
      { label: 'Старт', val: 0, date: 'База' },
    ];

    closedTradesChronological.forEach((t, i) => {
      cum += t.net_profit ?? t.profit_abs ?? 0;
      pts.push({
        label: `#${t.trade_id || i + 1}`,
        val: Number(cum.toFixed(2)),
        date: (t.close_date || t.open_date || '').slice(5, 16),
      });
    });

    if (openTrades.length > 0) {
      cum += openProfitAbs;
      pts.push({
        label: 'Live',
        val: Number(cum.toFixed(2)),
        date: 'Сейчас',
      });
    }

    return pts;
  }, [closedTradesChronological, openTrades, openProfitAbs]);

  // 7. Balance History Series (chronological startingBalance -> startingBalance + pnl)
  const balancePoints = useMemo(() => {
    let runningBalance = startingBalance;
    const pts: { label: string; balance: number; date: string }[] = [
      { label: 'Старт', balance: startingBalance, date: 'Старт' },
    ];

    closedTradesChronological.forEach((t, i) => {
      runningBalance += t.net_profit ?? t.profit_abs ?? 0;
      pts.push({
        label: `#${t.trade_id || i + 1}`,
        balance: Number(runningBalance.toFixed(2)),
        date: (t.close_date || t.open_date || '').slice(11, 16) || `#${t.trade_id || i + 1}`,
      });
    });

    if (openTrades.length > 0) {
      runningBalance += openProfitAbs;
      pts.push({
        label: 'Текущий',
        balance: Number(runningBalance.toFixed(2)),
        date: 'Сейчас',
      });
    }

    return pts;
  }, [startingBalance, closedTradesChronological, openTrades, openProfitAbs]);

  // 8. Individual Trade Bars for Log Chart (chronological)
  const tradeLogBars = useMemo(() => {
    const bars: { label: string; pair: string; val: number; isLive?: boolean }[] = [];

    closedTradesChronological.slice(-18).forEach((t) => {
      bars.push({
        label: `#${t.trade_id}`,
        pair: t.pair.split(':')[0].split('/')[0],
        val: Number((t.profit_pct || 0).toFixed(2)),
      });
    });

    openTrades.slice(0, 8).forEach((t) => {
      bars.push({
        label: `#${t.trade_id} (Откр)`,
        pair: t.pair.split(':')[0].split('/')[0],
        val: Number((t.profit_pct || 0).toFixed(2)),
        isLive: true,
      });
    });

    return bars;
  }, [closedTradesChronological, openTrades]);

  // 9. Profit Distribution Bins
  const profitBins = useMemo(() => {
    const vals = [
      ...closedTrades.map((t) => t.profit_pct || 0),
      ...openTrades.map((t) => t.profit_pct || 0),
    ];

    if (vals.length === 0) {
      return [
        { label: '0.0%', count: 1 },
        { label: '+2.0%', count: 0 },
        { label: '+4.0%', count: 0 },
        { label: '+6.0%', count: 0 },
        { label: '+8.0%', count: 0 },
      ];
    }

    const min = Math.min(-1, ...vals);
    const max = Math.max(5, ...vals);
    const count = parseInt(binsCount, 10) || 20;
    const step = Math.max(0.5, (max - min) / count);

    const bins: { label: string; count: number }[] = [];
    for (let i = 0; i < count; i++) {
      const bMin = min + i * step;
      const bMax = bMin + step;
      const bCount = vals.filter(
        (v) => v >= bMin && (i === count - 1 ? v <= bMax : v < bMax)
      ).length;
      bins.push({
        label: `${bMin >= 0 ? '+' : ''}${bMin.toFixed(1)}%`,
        count: bCount,
      });
    }
    return bins;
  }, [closedTrades, openTrades, binsCount]);

  return (
    <div className="bg-[#0f1115] text-[#e2e8f0] min-h-[calc(100vh-44px)] flex flex-col">
      {/* =====================================================================
          АКТУАЛЬНАЯ СВОДКА ДЕПОЗИТА И МАРЖИ (KPI TOP BANNER)
      ===================================================================== */}
      <div className="bg-[#14181f] border-b border-[#242b35] px-4 py-3">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {/* 1. Общий баланс биржи (1:1 Wallet Balance с биржи + Реинвест) */}
          <div className="bg-[#191e26] border border-[#2b3340] rounded-[6px] p-2.5 flex flex-col justify-between">
            <div className="flex items-center justify-between text-[#94a3b8] text-[11px]">
              <span className="font-medium">Баланс биржи (Balance)</span>
              <Wallet className="w-3.5 h-3.5 text-[#38bdf8]" />
            </div>
            <div className="mt-1">
              <div className="text-[17px] font-bold text-white tracking-tight font-mono">
                {fmtComma(walletBalance, 2)}{' '}
                <span className="text-[11px] font-normal text-[#94a3b8]">USDT</span>
              </div>
              <div className="text-[10px] text-[#64748b] mt-0.5">
                Equity: ${fmtComma(currentEquity, 2)} | Старт: ${fmtComma(startingBalance, 0)}
              </div>
            </div>
          </div>

          {/* 2. Свободная маржа */}
          <div className="bg-[#191e26] border border-[#2b3340] rounded-[6px] p-2.5 flex flex-col justify-between">
            <div className="flex items-center justify-between text-[#94a3b8] text-[11px]">
              <span className="font-medium">Свободная маржа</span>
              <ShieldCheck className="w-3.5 h-3.5 text-[#34d399]" />
            </div>
            <div className="mt-1">
              <div className="text-[17px] font-bold text-[#34d399] tracking-tight font-mono">
                {fmtComma(freeMargin, 2)}{' '}
                <span className="text-[11px] font-normal text-[#94a3b8]">USDT</span>
              </div>
              <div className="text-[10px] text-[#64748b] mt-0.5">
                Доступно для входов и DCA (вход 0.5%: ${fmtComma(walletBalance * 0.005, 2)})
              </div>
            </div>
          </div>

          {/* 3. Занятая маржа */}
          <div className="bg-[#191e26] border border-[#2b3340] rounded-[6px] p-2.5 flex flex-col justify-between">
            <div className="flex items-center justify-between text-[#94a3b8] text-[11px]">
              <span className="font-medium">Задействовано</span>
              <Layers className="w-3.5 h-3.5 text-[#f59e0b]" />
            </div>
            <div className="mt-1">
              <div className="text-[17px] font-bold text-white tracking-tight font-mono">
                {fmtComma(openStakeSum, 2)}{' '}
                <span className="text-[11px] font-normal text-[#94a3b8]">USDT</span>
              </div>
              <div className="text-[10px] text-[#f59e0b] mt-0.5">
                {marginUsagePct.toFixed(1)}% от баланса биржи
              </div>
            </div>
          </div>

          {/* 4. Плавающий PnL (Unrealized PNL с биржи 1:1) */}
          <div className="bg-[#191e26] border border-[#2b3340] rounded-[6px] p-2.5 flex flex-col justify-between">
            <div className="flex items-center justify-between text-[#94a3b8] text-[11px]">
              <span className="font-medium">Плавающий PnL</span>
              <Activity className="w-3.5 h-3.5 text-[#818cf8]" />
            </div>
            <div className="mt-1">
              <div
                className={`text-[17px] font-bold tracking-tight font-mono flex items-center gap-1 ${
                  openProfitAbs >= 0 ? 'text-[#10b981]' : 'text-[#ef4444]'
                }`}
              >
                {openProfitAbs >= 0 ? (
                  <ArrowUpRight className="w-4 h-4" />
                ) : (
                  <ArrowDownRight className="w-4 h-4" />
                )}
                <span>
                  {openProfitAbs >= 0 ? '+' : ''}
                  {fmtComma(openProfitAbs, 2)} $
                </span>
              </div>
              <div
                className={`text-[10px] font-medium mt-0.5 ${
                  openProfitPct >= 0 ? 'text-[#10b981]' : 'text-[#ef4444]'
                }`}
              >
                {openProfitPct >= 0 ? '+' : ''}
                {openProfitPct.toFixed(2)}% ROI на маржу (Live API)
              </div>
            </div>
          </div>

          {/* 5. Зафиксированный PnL с учетом всех комиссий биржи */}
          <div className="bg-[#191e26] border border-[#2b3340] rounded-[6px] p-2.5 flex flex-col justify-between">
            <div className="flex items-center justify-between text-[#94a3b8] text-[11px]">
              <span className="font-medium">Чистый PnL (Биржа)</span>
              <TrendingUp className="w-3.5 h-3.5 text-[#10b981]" />
            </div>
            <div className="mt-1">
              <div
                className={`text-[17px] font-bold tracking-tight font-mono ${
                  closedProfitAbs >= 0 ? 'text-[#10b981]' : 'text-[#ef4444]'
                }`}
              >
                {closedProfitAbs >= 0 ? '+' : ''}
                {fmtComma(closedProfitAbs, 2)} $
              </div>
              <div className="text-[10px] text-[#10b981] mt-0.5">
                {closedProfitPct >= 0 ? '+' : ''}
                {closedProfitPct.toFixed(2)}% к депо | Комиссии: ${fmtComma(totalFeesPaid, 2)}
              </div>
            </div>
          </div>

          {/* 6. Винрейт и управление новыми входами для владельца */}
          <div className="bg-[#191e26] border border-[#2b3340] rounded-[6px] p-2.5 flex flex-col justify-between">
            <div className="flex items-center justify-between text-[#94a3b8] text-[11px]">
              <span className="font-medium">Винрейт / Новые сделки</span>
              <Percent className="w-3.5 h-3.5 text-[#38bdf8]" />
            </div>
            <div className="mt-1 flex items-center justify-between gap-2">
              <div>
                <div className="text-[16px] font-bold text-white tracking-tight font-mono">
                  {winRatePct.toFixed(0)}%{' '}
                  <span className="text-[10px] text-[#94a3b8]">
                    ({winningTradesCount}В/{losingTradesCount}П)
                  </span>
                </div>
                <div className="text-[10px] text-[#38bdf8] font-medium mt-0.5 truncate">
                  2 стратегии: Скальп + 2-Way
                </div>
              </div>
              {isOwner && onTogglePauseNewEntries && (
                <button
                  type="button"
                  onClick={onTogglePauseNewEntries}
                  className={`px-2 py-1 rounded text-[10px] font-semibold border transition-colors shrink-0 ${
                    botConfig?.pause_new_entries
                      ? 'bg-amber-500/20 border-amber-500/60 text-amber-300 hover:bg-amber-500/30'
                      : 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300 hover:bg-emerald-500/30'
                  }`}
                  title={
                    botConfig?.pause_new_entries
                      ? 'Новые сделки остановлены. Нажмите, чтобы разрешить новые входы'
                      : 'Нажмите, чтобы остановить открытие новых сделок (DCA и TP текущих продолжат работать)'
                  }
                >
                  {botConfig?.pause_new_entries ? '⏸ Без новых' : '▶ Входы ВКЛ'}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* =====================================================================
          ОСНОВНОЙ КОНТЕНТ ДАШБОРДА (СЕТКА 4 РЯДОВ)
      ===================================================================== */}
      <div className="divide-y divide-[#242b35] flex-1">
        {/* =====================================================================
            РЯД 1: Сравнение ботов (Слева) | Прибыль по времени (Справа)
        ===================================================================== */}
        <div className="grid grid-cols-1 lg:grid-cols-12">
          {/* Слева: Реальная доходность по стратегиям (7 колонок) */}
          <div className="lg:col-span-7 border-r border-[#242b35] bg-[#12151b] flex flex-col">
            <div className="bg-[#181d24] border-b border-[#242b35] py-2 px-3 flex flex-wrap items-center justify-between gap-2 text-[13px] font-medium text-[#e2e8f0]">
              <div className="flex items-center gap-2">
                <span>Раздельные стратегии ({botName} · Top-Down 1D ➔ 4H)</span>
                <span className="px-1.5 py-0.2 rounded bg-[#0284c7]/20 border border-[#0284c7]/40 text-[#38bdf8] text-[10px]">
                  {ownerAccount
                    ? ownerAccount.network_label ||
                      `${ownerAccount.exchange.toUpperCase()}${ownerAccount.is_testnet ? ' TESTNET' : ''}`
                    : strategyName}
                </span>
              </div>
              <span className="text-[11px] font-mono text-[#94a3b8]">
                Плечо: {botLeverage}x Cross | Комиссия учтена: ${fmtComma(totalFeesPaid, 2)}
              </span>
            </div>

            <div className="p-2 overflow-x-auto">
              <table className="w-full text-left border-collapse text-[12px]">
                <thead>
                  <tr className="border-b border-[#242b35] text-[#94a3b8] font-semibold text-[11px]">
                    <th className="py-2 px-3">Отдельная стратегия</th>
                    <th className="py-2 px-3">Откр. / Закр.</th>
                    <th className="py-2 px-3">Плавающий PnL</th>
                    <th className="py-2 px-3">Чистый закр. PnL</th>
                    <th className="py-2 px-3">Горизонт и DCA</th>
                    <th className="py-2 px-3">Винрейт</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1e242d] text-[#d1d5db]">
                  <tr>
                    <td className="py-2.5 px-3 font-medium text-white flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-[#10b981]" />
                      <span>ScalpingStrategy (Лонг/Шорт от глобальных уровней 1D/4H)</span>
                    </td>
                    <td className="py-2.5 px-3 font-mono">
                      <span className="text-[#10b981] font-semibold">{openScalpTrades.length}</span>
                      <span className="text-[#64748b]"> откр. / </span>
                      <span className="text-white">{closedScalpTrades.length} закр.</span>
                    </td>
                    <td className="py-2.5 px-3 font-mono">
                      <span className={scalpOpenPnl >= 0 ? 'text-[#10b981]' : 'text-[#ef4444]'}>
                        {scalpOpenPnl >= 0 ? '+' : ''}
                        {fmtComma(scalpOpenPnl, 2)} $
                      </span>
                    </td>
                    <td className="py-2.5 px-3 font-mono font-semibold">
                      <span className={scalpClosedPnl >= 0 ? 'text-[#10b981]' : 'text-[#ef4444]'}>
                        {scalpClosedPnl >= 0 ? '+' : ''}
                        {fmtComma(scalpClosedPnl, 2)} $
                      </span>
                    </td>
                    <td className="py-2.5 px-3 font-mono text-[#94a3b8]">Краткосрок · DCA по хаям/лоям</td>
                    <td className="py-2.5 px-3 font-mono text-[#10b981]">
                      {closedScalpTrades.filter((t) => (t.net_profit ?? t.profit_abs ?? 0) > 0).length}В /{' '}
                      {closedScalpTrades.filter((t) => (t.net_profit ?? t.profit_abs ?? 0) <= 0).length}П
                    </td>
                  </tr>

                  <tr>
                    <td className="py-2.5 px-3 font-medium text-white flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-[#38bdf8]" />
                      <span>GlobalHedgeStrategy (2-сторонние сделки: Среднесрок / Долгосрок)</span>
                    </td>
                    <td className="py-2.5 px-3 font-mono">
                      <span className="text-[#38bdf8] font-semibold">{openHedgeTrades.length}</span>
                      <span className="text-[#64748b]"> откр. / </span>
                      <span className="text-white">{closedHedgeTrades.length} закр.</span>
                    </td>
                    <td className="py-2.5 px-3 font-mono">
                      <span className={hedgeOpenPnl >= 0 ? 'text-[#10b981]' : 'text-[#ef4444]'}>
                        {hedgeOpenPnl >= 0 ? '+' : ''}
                        {fmtComma(hedgeOpenPnl, 2)} $
                      </span>
                    </td>
                    <td className="py-2.5 px-3 font-mono font-semibold">
                      <span className={hedgeClosedPnl >= 0 ? 'text-[#10b981]' : 'text-[#ef4444]'}>
                        {hedgeClosedPnl >= 0 ? '+' : ''}
                        {fmtComma(hedgeClosedPnl, 2)} $
                      </span>
                    </td>
                    <td className="py-2.5 px-3 font-mono text-[#94a3b8]">Среднесрок 4H / Долгосрок 1D</td>
                    <td className="py-2.5 px-3 font-mono text-[#10b981]">
                      {closedHedgeTrades.filter((t) => (t.net_profit ?? t.profit_abs ?? 0) > 0).length}В /{' '}
                      {closedHedgeTrades.filter((t) => (t.net_profit ?? t.profit_abs ?? 0) <= 0).length}П
                    </td>
                  </tr>

                  <tr className="bg-[#151921] font-semibold">
                    <td className="py-2.5 px-3 text-[#38bdf8]">ИТОГО РЕАЛЬНЫЙ СЧЁТ</td>
                    <td className="py-2.5 px-3 font-mono text-[#94a3b8]">
                      {openTrades.length} откр. / {closedTrades.length} закр.
                    </td>
                    <td className="py-2.5 px-3">
                      <ProfitPill
                        profitPct={openProfitPct}
                        customText={`${openProfitAbs >= 0 ? '+' : ''}${fmtComma(openProfitAbs, 2)} USDT`}
                      />
                    </td>
                    <td className="py-2.5 px-3">
                      <ProfitPill
                        profitPct={closedProfitPct}
                        customText={`${closedProfitAbs >= 0 ? '+' : ''}${fmtComma(closedProfitAbs, 2)} USDT`}
                      />
                    </td>
                    <td className="py-2.5 px-3 font-mono text-[#38bdf8]">
                      {fmtComma(walletBalance, 2)} USDT
                    </td>
                    <td className="py-2.5 px-3 font-mono text-[#10b981]">{winRatePct.toFixed(0)}%</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* Справа: Прибыль по дням (5 колонок) */}
          <div className="lg:col-span-5 bg-[#12151b] flex flex-col">
            <div className="bg-[#181d24] border-b border-[#242b35] py-2 px-3 flex items-center justify-between text-[13px] font-medium text-[#e2e8f0]">
              <span>Прибыль по дням (Закрытые сделки)</span>
              <div className="flex items-center gap-2">
                {/* Переключатели периода */}
                <div className="inline-flex rounded-[4px] overflow-hidden border border-[#2b3340]">
                  {(['Дни', 'Недели', 'Месяцы'] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setTimePeriod(t)}
                      className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${
                        timePeriod === t
                          ? 'bg-[#0284c7] text-white font-semibold'
                          : 'bg-[#191e26] text-[#94a3b8] hover:bg-[#222933]'
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>

                {/* Переключатели валюты */}
                <div className="inline-flex rounded-[4px] overflow-hidden border border-[#2b3340]">
                  {(['Абс $', 'Отн %'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setProfitMode(m)}
                      className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${
                        profitMode === m
                          ? 'bg-[#0284c7] text-white font-semibold'
                          : 'bg-[#191e26] text-[#94a3b8] hover:bg-[#222933]'
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="p-3 flex-1 flex flex-col justify-between">
              {/* Легенда */}
              <div className="flex items-center justify-end gap-4 text-[10px] text-[#94a3b8] mb-1">
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#10b981] inline-block" />
                  <span>{profitMode === 'Абс $' ? 'Прибыль ($)' : 'Прибыль (%)'}</span>
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-3.5 h-2.5 rounded-[2px] bg-[#334155] inline-block" />
                  <span>Сделки</span>
                </span>
              </div>

              {/* Динамический SVG график */}
              <div className="w-full h-[200px]">
                <svg viewBox="0 0 520 190" className="w-full h-full">
                  {/* Горизонтальные направляющие */}
                  {[30, 65, 100, 135, 160].map((y, i) => (
                    <line
                      key={i}
                      x1="45"
                      y1={y}
                      x2="505"
                      y2={y}
                      stroke="rgba(255,255,255,0.06)"
                      strokeWidth="1"
                    />
                  ))}

                  {/* Столбики сделок и линия доходности */}
                  {timeBasedData.map((d, i) => {
                    const totalItems = Math.max(1, timeBasedData.length);
                    const x = 70 + (i * 410) / Math.max(1, totalItems - 1 || 1);
                    const val = profitMode === 'Абс $' ? d.pnlAbs : d.pnlPct;
                    const zeroY = 100;
                    const maxAbsVal = Math.max(
                      1,
                      ...timeBasedData.map((item) =>
                        Math.abs(profitMode === 'Абс $' ? item.pnlAbs : item.pnlPct)
                      )
                    );
                    const scale = 55 / maxAbsVal;
                    const barH = Math.min(60, d.count * 12);
                    const lineY = Math.max(28, Math.min(162, zeroY - val * scale));

                    return (
                      <g key={i}>
                        {/* Столбец кол-ва сделок */}
                        <rect
                          x={x - 7}
                          y={zeroY - barH}
                          width="14"
                          height={barH}
                          fill="#334155"
                          opacity="0.65"
                          rx="2"
                        />
                        {/* Метка на оси X */}
                        <text
                          x={x}
                          y={178}
                          fill="#94a3b8"
                          fontSize="9"
                          textAnchor="middle"
                        >
                          {d.label}
                        </text>
                        {/* Точка доходности */}
                        <circle
                          cx={x}
                          cy={lineY}
                          r="4"
                          fill={val >= 0 ? '#10b981' : '#ef4444'}
                          stroke="#0f1115"
                          strokeWidth="1.5"
                        />
                        {/* Значение над точкой */}
                        <text
                          x={x}
                          y={lineY - 7}
                          fill={val >= 0 ? '#10b981' : '#ef4444'}
                          fontSize="9"
                          fontWeight="bold"
                          textAnchor="middle"
                        >
                          {val >= 0 ? '+' : ''}
                          {val.toFixed(2)}
                          {profitMode === 'Абс $' ? '$' : '%'}
                        </text>
                      </g>
                    );
                  })}
                </svg>
              </div>

              {/* Таблица детализации прибыли по дням */}
              <div className="mt-2 border-t border-[#1e242d] pt-2 max-h-[115px] overflow-y-auto">
                <table className="w-full text-left border-collapse text-[11px]">
                  <thead>
                    <tr className="text-[#94a3b8] border-b border-[#1e242d]">
                      <th className="py-1 px-2">Период</th>
                      <th className="py-1 px-2 text-right">Чистый PnL ($)</th>
                      <th className="py-1 px-2 text-right">К депо (%)</th>
                      <th className="py-1 px-2 text-right">Закр. сделок</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1e242d] font-mono">
                    {[...timeBasedData].reverse().map((row) => (
                      <tr key={row.label} className="hover:bg-[#181d24]">
                        <td className="py-1 px-2 text-[#cbd5e1]">{row.label}</td>
                        <td
                          className={`py-1 px-2 text-right font-semibold ${
                            row.pnlAbs >= 0 ? 'text-[#10b981]' : 'text-[#ef4444]'
                          }`}
                        >
                          {row.pnlAbs >= 0 ? '+' : ''}
                          {fmtComma(row.pnlAbs, 2)} $
                        </td>
                        <td
                          className={`py-1 px-2 text-right ${
                            row.pnlPct >= 0 ? 'text-[#10b981]' : 'text-[#ef4444]'
                          }`}
                        >
                          {row.pnlPct >= 0 ? '+' : ''}
                          {fmtComma(row.pnlPct, 2)}%
                        </td>
                        <td className="py-1 px-2 text-right text-[#94a3b8]">{row.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        {/* =====================================================================
            РЯД 2: Открытые сделки (Слева) | Накопленная прибыль (Справа)
        ===================================================================== */}
        <div className="grid grid-cols-1 lg:grid-cols-12">
          {/* Слева: Открытые сделки (7 колонок) */}
          <div className="lg:col-span-7 border-r border-[#242b35] bg-[#12151b] flex flex-col">
            <div className="bg-[#181d24] border-b border-[#242b35] py-2 px-3 flex items-center justify-between text-[13px] font-medium text-[#e2e8f0]">
              <div className="flex items-center gap-2">
                <span>Открытые позиции бота</span>
                <span className="px-1.5 py-0.5 rounded bg-[#10b981]/20 border border-[#10b981]/40 text-[#10b981] text-[10px]">
                  {openTrades.length} активно
                </span>
              </div>
              <span className="text-[11px] text-[#94a3b8]">
                Маржа: ${fmtComma(openStakeSum, 2)} ({botLeverage}x плечо)
              </span>
            </div>

            <div className="p-2 overflow-x-auto min-h-[220px]">
              {openTrades.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-[200px] text-center text-[#94a3b8] text-[12px]">
                  <Activity className="w-8 h-8 text-[#0284c7] mb-2 animate-pulse" />
                  <div className="font-semibold text-white">Нет открытых сделок</div>
                  <div className="text-[11px] text-[#64748b] mt-1 max-w-sm">
                    Бот активно сканирует все фьючерсные пары USDT-M с объёмом от $50M и ищет
                    развороты на ключевых уровнях 4H/1D.
                  </div>
                </div>
              ) : (
                <table className="w-full text-left border-collapse text-[12px]">
                  <thead>
                    <tr className="border-b border-[#242b35] text-[#94a3b8] font-semibold text-[11px]">
                      <th className="py-2 px-2">Сторона</th>
                      <th className="py-2 px-2">Пара</th>
                      <th className="py-2 px-2">Маржа ($)</th>
                      <th className="py-2 px-2">Монет</th>
                      <th className="py-2 px-2">Вход</th>
                      <th className="py-2 px-2">Текущая</th>
                      <th className="py-2 px-2">Прибыль ($ / %)</th>
                      <th className="py-2 px-2">Цель TP</th>
                      <th className="py-2 px-2 text-right">Действие</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1e242d] text-[#d1d5db]">
                    {openTrades.map((r) => (
                      <tr
                        key={r.trade_id}
                        onClick={() => onJumpToPair(r.pair)}
                        className="hover:bg-[#181d24] cursor-pointer transition-colors"
                      >
                        <td className="py-2 px-2 whitespace-nowrap">
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded-[3px] text-[11px] font-semibold ${
                              r.is_short
                                ? 'bg-[#3b181e] text-[#f87171] border border-[#ef4444]/40'
                                : 'bg-[#123524] text-[#4ade80] border border-[#10b981]/40'
                            }`}
                          >
                            {r.is_short ? 'Шорт' : 'Лонг'}
                          </span>
                        </td>
                        <td className="py-2 px-2 whitespace-nowrap font-medium text-white">
                          {r.pair}
                        </td>
                        <td className="py-2 px-2 whitespace-nowrap font-mono text-[#f59e0b]">
                          {fmtComma(r.stake_amount, 2)} $
                        </td>
                        <td className="py-2 px-2 whitespace-nowrap font-mono">
                          {formatSmartNumber(r.amount)}
                        </td>
                        <td className="py-2 px-2 whitespace-nowrap font-mono text-[#cbd5e1]">
                          {formatSmartNumber(r.open_rate)} $
                        </td>
                        <td className="py-2 px-2 whitespace-nowrap font-mono text-white">
                          {formatSmartNumber(r.current_rate || r.open_rate)} $
                        </td>
                        <td className="py-2 px-2 whitespace-nowrap">
                          <ProfitPill profitPct={r.profit_pct} profitAbs={r.profit_abs} />
                        </td>
                        <td className="py-2 px-2 whitespace-nowrap font-mono text-[#10b981] font-medium">
                          {formatSmartNumber(r.take_profit_abs)} $
                        </td>
                        <td
                          className="py-2 px-2 text-right whitespace-nowrap"
                          onClick={(e) => {
                            e.stopPropagation();
                            onForceExit?.(r.trade_id);
                          }}
                        >
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-[4px] bg-[#2a1619] hover:bg-[#dc3545] border border-[#dc3545]/70 text-[#fca5a5] hover:text-white text-[11px] transition-colors"
                          >
                            <Pointer className="w-3 h-3" />
                            <span>Закрыть</span>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {/* Справа: Накопленная прибыль (5 колонок) */}
          <div className="lg:col-span-5 bg-[#12151b] flex flex-col">
            <div className="bg-[#181d24] border-b border-[#242b35] py-2 px-3 flex items-center justify-between text-[13px] font-medium text-[#e2e8f0]">
              <span>Накопленная прибыль системы</span>
              <div className="text-[11px] font-mono text-[#10b981] font-semibold">
                Итого: {closedProfitAbs + openProfitAbs >= 0 ? '+' : ''}
                {fmtComma(closedProfitAbs + openProfitAbs, 2)} $
              </div>
            </div>

            <div className="p-3 flex-1 flex flex-col justify-between">
              <div className="w-full h-[200px]">
                <svg viewBox="0 0 520 190" className="w-full h-full">
                  <defs>
                    <linearGradient id="cumGreenGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#10b981" stopOpacity="0.35" />
                      <stop offset="100%" stopColor="#10b981" stopOpacity="0.0" />
                    </linearGradient>
                  </defs>

                  {/* Горизонтальные сетки */}
                  {[25, 60, 95, 130, 165].map((y, i) => (
                    <line
                      key={i}
                      x1="45"
                      y1={y}
                      x2="505"
                      y2={y}
                      stroke="rgba(255,255,255,0.06)"
                      strokeWidth="1"
                    />
                  ))}

                  {/* График кумулятивной прибыли */}
                  {(() => {
                    const vals = cumulativePoints.map((p) => p.val);
                    const min = Math.min(0, ...vals);
                    const max = Math.max(10, ...vals);
                    const span = max - min || 1;

                    const coords = cumulativePoints.map((p, i) => {
                      const x =
                        60 + (i * 430) / Math.max(1, cumulativePoints.length - 1 || 1);
                      const norm = (p.val - min) / span;
                      const y = 155 - norm * 120;
                      return { x, y, ...p };
                    });

                    const polyPoints = coords.map((c) => `${c.x},${c.y}`).join(' ');
                    const firstX = coords[0]?.x || 60;
                    const lastX = coords[coords.length - 1]?.x || 490;
                    const areaPoints = `${firstX},160 ${polyPoints} ${lastX},160`;

                    return (
                      <g>
                        <polygon points={areaPoints} fill="url(#cumGreenGrad)" />
                        <polyline
                          fill="none"
                          stroke="#10b981"
                          strokeWidth="2.2"
                          points={polyPoints}
                        />
                        {coords.map((c, i) => (
                          <g key={i}>
                            <circle
                              cx={c.x}
                              cy={c.y}
                              r="3.5"
                              fill="#10b981"
                              stroke="#0f1115"
                              strokeWidth="1.5"
                            />
                            <text
                              x={c.x}
                              y={178}
                              fill="#94a3b8"
                              fontSize="9"
                              textAnchor="middle"
                            >
                              {c.label}
                            </text>
                            <text
                              x={c.x}
                              y={c.y - 7}
                              fill="#10b981"
                              fontSize="9"
                              fontWeight="bold"
                              textAnchor="middle"
                            >
                              {c.val >= 0 ? '+' : ''}
                              {c.val.toFixed(1)}$
                            </text>
                          </g>
                        ))}
                      </g>
                    );
                  })()}
                </svg>
              </div>
            </div>
          </div>
        </div>

        {/* =====================================================================
            РЯД 3: Закрытые сделки (Слева) | История баланса (Справа)
        ===================================================================== */}
        <div className="grid grid-cols-1 lg:grid-cols-12">
          {/* Слева: Реальная история закрытых сделок и доходности (7 колонок) */}
          <div className="lg:col-span-7 border-r border-[#242b35] bg-[#12151b] flex flex-col">
            <div className="bg-[#181d24] border-b border-[#242b35] py-2 px-3 flex flex-wrap items-center justify-between gap-2 text-[13px] font-medium text-[#e2e8f0]">
              <div className="flex items-center gap-2">
                <span>Реальная история доходности (закрытые сделки из SQLite)</span>
                <span className="px-1.5 py-0.5 rounded bg-[#334155] text-[#94a3b8] text-[10px]">
                  {closedTrades.length} сделок
                </span>
              </div>
              <span className="text-[11px] text-[#10b981] font-mono">
                Чистый профит: {closedProfitAbs >= 0 ? '+' : ''}
                {fmtComma(closedProfitAbs, 2)} $ ({closedProfitPct >= 0 ? '+' : ''}
                {closedProfitPct.toFixed(2)}%)
              </span>
            </div>

            <div className="overflow-x-auto max-h-[280px] p-2">
              {closedTrades.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-[200px] text-center text-[#94a3b8] text-[12px]">
                  <Info className="w-7 h-7 text-[#64748b] mb-2" />
                  <div className="text-white font-medium">Закрытых сделок пока нет</div>
                  <div className="text-[11px] text-[#64748b] mt-1 max-w-sm">
                    Как только бот закроет сделку по Тейк-Профиту или защитному тралу (строго в плюс после вычета комиссии 0.06%), она сразу отобразится в этой таблице и на графиках доходности.
                  </div>
                </div>
              ) : (
                <table className="w-full text-left border-collapse text-[11.5px]">
                  <thead>
                    <tr className="border-b border-[#242b35] text-[#94a3b8] font-semibold text-[11px]">
                      <th className="py-2 px-2">Тип / Сторона</th>
                      <th className="py-2 px-2">Пара / Биржа</th>
                      <th className="py-2 px-2">Маржа ($)</th>
                      <th className="py-2 px-2">Вход ➔ Выход</th>
                      <th className="py-2 px-2">Комиссия</th>
                      <th className="py-2 px-2">Чистый PnL ($ / %)</th>
                      <th className="py-2 px-2">Дата закрытия</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1e242d] text-[#d1d5db]">
                    {closedTrades.map((r) => {
                      const netPnl = r.net_profit ?? r.profit_abs ?? 0;
                      const isProfit = netPnl >= 0;
                      const isScalp = isScalpTrade(r);
                      return (
                        <tr
                          key={r.trade_id}
                          onClick={() => onJumpToPair(r.pair)}
                          className="hover:bg-[#181d24] cursor-pointer transition-colors"
                        >
                          <td className="py-2 px-2 whitespace-nowrap">
                            <div className="flex items-center gap-1">
                              <span
                                className={`inline-flex items-center px-1.5 py-0.5 rounded-[3px] text-[10.5px] font-semibold ${
                                  r.is_short
                                    ? 'bg-[#3b181e] text-[#f87171] border border-[#ef4444]/40'
                                    : 'bg-[#123524] text-[#4ade80] border border-[#10b981]/40'
                                }`}
                              >
                                {r.is_short ? 'SHORT' : 'LONG'}
                              </span>
                              <span
                                className={`px-1.5 py-0.5 rounded-[3px] text-[9.5px] font-mono ${
                                  isScalp
                                    ? 'bg-[#089981]/20 text-[#10b981] border border-[#10b981]/30'
                                    : 'bg-[#0284c7]/20 text-[#38bdf8] border border-[#0284c7]/30'
                                }`}
                              >
                                {isScalp ? 'SCALP' : 'HEDGE'}
                              </span>
                            </div>
                          </td>
                          <td className="py-2 px-2 whitespace-nowrap">
                            <div className="font-medium text-white">{r.pair.split(':')[0]}</div>
                            <div className="text-[10px] font-mono text-[#94a3b8]">
                              {r.exchange.toUpperCase()} · {r.leverage || botLeverage}x
                              {(r.dca_count || 0) > 0 ? ` · DCA ×${r.dca_count}` : ''}
                            </div>
                          </td>
                          <td className="py-2 px-2 whitespace-nowrap font-mono">
                            {fmtComma(r.stake_amount, 2)} $
                          </td>
                          <td className="py-2 px-2 whitespace-nowrap font-mono text-[#cbd5e1]">
                            <div>
                              {formatSmartNumber(r.open_rate)}$ ➔{' '}
                              <span className="text-white font-semibold">
                                {formatSmartNumber(r.close_rate || r.open_rate)}$
                              </span>
                            </div>
                          </td>
                          <td className="py-2 px-2 whitespace-nowrap font-mono text-[#94a3b8]">
                            -${fmtComma(r.fee_total ?? 0, 3)}
                          </td>
                          <td className="py-2 px-2 whitespace-nowrap">
                            <span
                              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-[4px] font-mono text-[11px] font-semibold border ${
                                isProfit
                                  ? 'bg-[#132a20] text-[#4ade80] border-[#10b981]/60'
                                  : 'bg-[#2c1519] text-[#f87171] border-[#ef4444]/60'
                              }`}
                            >
                              <span>{isProfit ? '▲' : '▼'}</span>
                              <span>
                                {isProfit ? '+' : ''}
                                {fmtComma(netPnl, 2)} $ ({isProfit ? '+' : ''}
                                {fmtComma(r.profit_pct, 2)}%)
                              </span>
                            </span>
                          </td>
                          <td className="py-2 px-2 whitespace-nowrap font-mono text-[#64748b] text-[10.5px]">
                            {r.close_date || r.open_date}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {/* Справа: История баланса (5 колонок) */}
          <div className="lg:col-span-5 bg-[#12151b] flex flex-col">
            <div className="bg-[#181d24] border-b border-[#242b35] py-2 px-3 flex items-center justify-between text-[13px] font-medium text-[#e2e8f0]">
              <span>История баланса депозита</span>
              <div className="text-[11px] font-mono text-white">
                Текущий: <span className="text-[#38bdf8] font-bold">${fmtComma(currentEquity, 2)}</span>
              </div>
            </div>

            <div className="p-3 flex-1 flex flex-col justify-between">
              <div className="w-full h-[200px]">
                <svg viewBox="0 0 520 190" className="w-full h-full">
                  {/* Горизонтальные сетки */}
                  {[25, 60, 95, 130, 165].map((y, i) => (
                    <line
                      key={i}
                      x1="45"
                      y1={y}
                      x2="505"
                      y2={y}
                      stroke="rgba(255,255,255,0.06)"
                      strokeWidth="1"
                    />
                  ))}

                  {/* Стартовая базовая линия */}
                  <line
                    x1="45"
                    y1="95"
                    x2="505"
                    y2="95"
                    stroke="#0284c7"
                    strokeWidth="1.5"
                    strokeDasharray="4 3"
                  />
                  <text x="50" y="88" fill="#38bdf8" fontSize="9">
                    Базовый депозит: ${fmtComma(startingBalance, 0)} USDT
                  </text>

                  {/* Кривая изменения баланса */}
                  {(() => {
                    const bVals = balancePoints.map((p) => p.balance);
                    const min = Math.min(startingBalance * 0.98, ...bVals);
                    const max = Math.max(startingBalance * 1.05, ...bVals);
                    const span = max - min || 1;

                    const coords = balancePoints.map((p, i) => {
                      const x =
                        60 + (i * 430) / Math.max(1, balancePoints.length - 1 || 1);
                      const norm = (p.balance - min) / span;
                      const y = 160 - norm * 125;
                      return { x, y, ...p };
                    });

                    const polyPoints = coords.map((c) => `${c.x},${c.y}`).join(' ');

                    return (
                      <g>
                        <polyline
                          fill="none"
                          stroke="#38bdf8"
                          strokeWidth="2.2"
                          points={polyPoints}
                        />
                        {coords.map((c, i) => (
                          <g key={i}>
                            <circle
                              cx={c.x}
                              cy={c.y}
                              r="3.5"
                              fill="#38bdf8"
                              stroke="#0f1115"
                              strokeWidth="1.5"
                            />
                            <text
                              x={c.x}
                              y={178}
                              fill="#94a3b8"
                              fontSize="9"
                              textAnchor="middle"
                            >
                              {c.date}
                            </text>
                            <text
                              x={c.x}
                              y={c.y - 7}
                              fill="#38bdf8"
                              fontSize="9"
                              fontWeight="bold"
                              textAnchor="middle"
                            >
                              ${fmtComma(c.balance, 0)}
                            </text>
                          </g>
                        ))}
                      </g>
                    );
                  })()}
                </svg>
              </div>
            </div>
          </div>
        </div>

        {/* =====================================================================
            РЯД 4: Журнал сделок (Слева) | Распределение прибыли (Справа)
        ===================================================================== */}
        <div className="grid grid-cols-1 lg:grid-cols-12">
          {/* Слева: Журнал сделок (7 колонок) */}
          <div className="lg:col-span-7 border-r border-[#242b35] bg-[#12151b] flex flex-col">
            <div className="bg-[#181d24] border-b border-[#242b35] py-2 px-3 flex items-center justify-between text-[13px] font-medium text-[#e2e8f0]">
              <span>Индивидуальная доходность сделок (ROI %)</span>
              <div className="flex items-center gap-3 text-[10px] text-[#94a3b8]">
                <span className="flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#10b981]" />
                  <span>В плюс</span>
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#ef4444]" />
                  <span>В минус</span>
                </span>
              </div>
            </div>

            <div className="p-3 flex-1 flex flex-col justify-between">
              <div className="w-full h-[180px]">
                <svg viewBox="0 0 720 180" className="w-full h-full">
                  {/* Горизонтальные направляющие */}
                  {[25, 55, 90, 125, 155].map((y, i) => (
                    <line
                      key={i}
                      x1="35"
                      y1={y}
                      x2="705"
                      y2={y}
                      stroke={y === 90 ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.05)'}
                      strokeWidth="1"
                    />
                  ))}

                  {/* Отрисовка столбцов сделок */}
                  {tradeLogBars.length === 0 ? (
                    <text
                      x="360"
                      y="95"
                      fill="#64748b"
                      fontSize="12"
                      textAnchor="middle"
                    >
                      Ожидание завершения первой серии сделок
                    </text>
                  ) : (
                    tradeLogBars.map((b, i) => {
                      const x = 50 + i * 36;
                      const zeroY = 90;
                      const scale = 8;
                      const h = Math.max(3, Math.abs(b.val) * scale);
                      const isPos = b.val >= 0;
                      const y = isPos ? zeroY - h : zeroY;

                      return (
                        <g key={i}>
                          <rect
                            x={x}
                            y={y}
                            width="24"
                            height={h}
                            fill={isPos ? '#10b981' : '#ef4444'}
                            rx="2"
                          />
                          <text
                            x={x + 12}
                            y={isPos ? y - 4 : y + h + 10}
                            fill={isPos ? '#10b981' : '#ef4444'}
                            fontSize="9"
                            fontWeight="bold"
                            textAnchor="middle"
                          >
                            {isPos ? '+' : ''}
                            {b.val.toFixed(1)}%
                          </text>
                          <text
                            x={x + 12}
                            y={172}
                            fill="#94a3b8"
                            fontSize="8"
                            textAnchor="middle"
                          >
                            {b.pair}
                          </text>
                        </g>
                      );
                    })
                  )}
                </svg>
              </div>
            </div>
          </div>

          {/* Справа: Распределение прибыли (5 колонок) */}
          <div className="lg:col-span-5 bg-[#12151b] flex flex-col">
            <div className="bg-[#181d24] border-b border-[#242b35] py-2 px-3 flex items-center justify-between text-[13px] font-medium text-[#e2e8f0]">
              <span>Распределение прибыли (Гистограмма)</span>
              <div className="flex items-center gap-2 text-[11px]">
                <span className="text-[#94a3b8]">Интервалы:</span>
                <select
                  value={binsCount}
                  onChange={(e) => setBinsCount(e.target.value as any)}
                  className="bg-[#191e26] border border-[#2b3340] rounded px-2 py-0.5 text-[11px] text-white"
                >
                  <option value="15">15</option>
                  <option value="20">20</option>
                  <option value="30">30</option>
                </select>
              </div>
            </div>

            <div className="p-3 flex-1 flex flex-col justify-between">
              <div className="w-full h-[180px]">
                <svg viewBox="0 0 520 180" className="w-full h-full">
                  {/* Горизонтальные сетки */}
                  {[25, 55, 90, 125, 155].map((y, i) => (
                    <line
                      key={i}
                      x1="45"
                      y1={y}
                      x2="505"
                      y2={y}
                      stroke="rgba(255,255,255,0.06)"
                      strokeWidth="1"
                    />
                  ))}

                  {/* Отрисовка столбцов гистограммы */}
                  {(() => {
                    const maxCount = Math.max(1, ...profitBins.map((b) => b.count));
                    const totalBins = Math.max(1, profitBins.length);
                    const barW = Math.max(8, Math.min(22, 420 / totalBins - 4));

                    return profitBins.map((b, i) => {
                      const x = 55 + (i * 440) / totalBins;
                      const h = Math.max(2, (b.count / maxCount) * 120);
                      const y = 155 - h;

                      return (
                        <g key={i}>
                          <rect
                            x={x}
                            y={y}
                            width={barW}
                            height={h}
                            fill="#0284c7"
                            opacity="0.8"
                            rx="2"
                          />
                          {b.count > 0 && (
                            <text
                              x={x + barW / 2}
                              y={y - 4}
                              fill="#38bdf8"
                              fontSize="8"
                              textAnchor="middle"
                            >
                              {b.count}
                            </text>
                          )}
                          {i % 3 === 0 && (
                            <text
                              x={x + barW / 2}
                              y={170}
                              fill="#94a3b8"
                              fontSize="8"
                              textAnchor="middle"
                            >
                              {b.label}
                            </text>
                          )}
                        </g>
                      );
                    });
                  })()}
                </svg>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
