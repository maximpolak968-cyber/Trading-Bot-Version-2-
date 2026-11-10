import React, { useState, useMemo } from 'react';
import {
  Play,
  Square,
  Pause,
  RotateCw,
  XSquare,
  PlusSquare,
  List,
  Info,
  TrendingUp,
  Landmark,
  FolderClock,
  AlignLeft,
  Lock,
  Layers,
  ChevronRight,
  ChevronLeft,
  CheckCircle2,
  FolderOpen,
  History,
  Sliders,
} from 'lucide-react';
import {
  ParsedCandle,
  FreqtradeTrade,
  BalanceResponse,
  WhitelistResponse,
  PairPerformance,
  BotConfig,
  PlotConfig,
  DailyRecord,
  PairLock,
  BotChartLevel,
  ChartDrawingObject,
  fmtComma,
} from '../types/frequi';
import { CandleChart, TradeLevelUpdatePayload, QuickOrderFromChartPayload } from './CandleChart';
import { ProfitPill } from './ProfitPill';

export type RightPanelSection = 'open' | 'averaged' | 'closed' | 'bot';

interface TradeViewProps {
  selectedPair: string;
  onSelectPair: (pair: string) => void;
  timeframe: string;
  onSelectTimeframe?: (tf: string) => void;
  strategy: string;
  exchangeSource?: string;
  candles: ParsedCandle[];
  openTrades: FreqtradeTrade[];
  closedTrades: FreqtradeTrade[];
  botLevels?: BotChartLevel[];
  drawings?: ChartDrawingObject[];
  balance: BalanceResponse | null;
  whitelist: WhitelistResponse | null;
  blacklist: string[];
  performance: PairPerformance[];
  daily: DailyRecord[];
  locks: PairLock[];
  botConfig: BotConfig | null;
  plotConfig: PlotConfig;
  onChangePlotConfig: (cfg: PlotConfig) => void;
  onBotCommand: (cmd: 'start' | 'stop' | 'stopbuy' | 'reload_config') => Promise<void>;
  onForceExit: (tradeId: number | 'all') => Promise<void>;
  onAverageTrade: (tradeId: number) => Promise<void>;
  onUpdateTradeLevel?: (payload: TradeLevelUpdatePayload) => Promise<void>;
  onUpdateBotLevel?: (id: string, price: number) => Promise<void>;
  onAddBotLevel?: (price: number) => Promise<void>;
  onDeleteBotLevel?: (id: string) => Promise<void>;
  onClearAllBotLevels?: () => Promise<void>;
  onAddDrawing?: (drawing: Omit<ChartDrawingObject, 'id' | 'created_at'>) => Promise<void>;
  onUpdateDrawing?: (id: string, patch: Partial<ChartDrawingObject>) => Promise<void>;
  onDeleteDrawing?: (id: string) => Promise<void>;
  onClearAllDrawings?: () => Promise<void>;
  onQuickOrderFromChart?: (payload: QuickOrderFromChartPayload) => Promise<void>;
  onDeleteTrade: (tradeId: number) => Promise<void>;
  onOpenForceEnterModal: (defaultPair?: string) => void;
  onRefresh: () => void;
  loadingChart: boolean;
  rightPanelTab?: RightPanelSection;
  onChangeRightPanelTab?: (tab: RightPanelSection) => void;
  statusNotification?: string | null;
}

function formatSmartNumber(val: number): string {
  if (!Number.isFinite(val)) return '0';
  if (Math.abs(val) >= 100) return fmtComma(val, 2);
  if (Math.abs(val) >= 1) return fmtComma(val, 4).replace(/,?0+$/, '');
  return fmtComma(val, 4).replace(/,?0+$/, '');
}

function shortPairName(pair: string): string {
  return pair.split('/')[0] || pair;
}

function shortDateStr(dateStr?: string): string {
  if (!dateStr) return '—';
  return dateStr.length >= 16 ? dateStr.slice(5, 16) : dateStr;
}

export const TradeView: React.FC<TradeViewProps> = ({
  selectedPair,
  onSelectPair,
  timeframe,
  onSelectTimeframe,
  strategy,
  exchangeSource,
  candles,
  openTrades,
  closedTrades,
  botLevels = [],
  drawings = [],
  balance,
  whitelist,
  blacklist,
  performance,
  daily,
  locks,
  botConfig,
  plotConfig,
  onChangePlotConfig,
  onBotCommand,
  onForceExit,
  onAverageTrade,
  onUpdateTradeLevel,
  onUpdateBotLevel,
  onAddBotLevel,
  onDeleteBotLevel,
  onClearAllBotLevels,
  onAddDrawing,
  onUpdateDrawing,
  onDeleteDrawing,
  onClearAllDrawings,
  onQuickOrderFromChart,
  onOpenForceEnterModal,
  onRefresh,
  loadingChart,
  rightPanelTab: externalTab,
  onChangeRightPanelTab,
  statusNotification,
}) => {
  // Collapsible right drawer state (TradingView-style right panel)
  const [isRightPanelOpen, setIsRightPanelOpen] = useState<boolean>(true);
  const [internalRightTab, setInternalRightTab] = useState<RightPanelSection>('open');
  const activeRightTab = externalTab ?? internalRightTab;

  const setRightTab = (tab: RightPanelSection) => {
    setInternalRightTab(tab);
    onChangeRightPanelTab?.(tab);
    if (!isRightPanelOpen) {
      setIsRightPanelOpen(true);
    }
  };

  const [leftTab, setLeftTab] = useState<
    'pairs' | 'info' | 'perf' | 'balance' | 'daily' | 'pairlist' | 'locks'
  >('pairs');
  const [pairFilter, setPairFilter] = useState('');
  const [isMultiPaneCoinsOpen, setIsMultiPaneCoinsOpen] = useState(false);

  // Automatic classification into the 3 trade sections:
  // 1) "Открытые": active trades without DCA averaging (dca_count === 0)
  const newOpenTrades = useMemo(
    () => openTrades.filter((t) => (t.dca_count || 0) === 0),
    [openTrades]
  );

  // 2) "Усреднённые": active trades where the bot has executed 1+ DCA averaging steps (dca_count > 0)
  const averagedTrades = useMemo(
    () => openTrades.filter((t) => (t.dca_count || 0) > 0),
    [openTrades]
  );

  const availablePairs = useMemo(
    () =>
      whitelist?.whitelist || [
        'ETH/USDT:USDT',
        'DOT/USDT:USDT',
        'AVAX/USDT:USDT',
        'LINK/USDT:USDT',
        'XRP/USDT:USDT',
        'BTC/USDT:USDT',
        'SOL/USDT:USDT',
        'DOGE/USDT:USDT',
        'ADA/USDT:USDT',
      ],
    [whitelist]
  );

  const filteredPairs = useMemo(
    () =>
      availablePairs.filter((p) =>
        p.toLowerCase().includes(pairFilter.trim().toLowerCase())
      ),
    [availablePairs, pairFilter]
  );

  const openTradeByPair = useMemo(() => {
    const map = new Map<string, { pct: number; abs: number; dcaCount: number }>();
    for (const t of openTrades) {
      map.set(t.pair, {
        pct: t.profit_pct,
        abs: t.profit_abs,
        dcaCount: t.dca_count || 0,
      });
    }
    return map;
  }, [openTrades]);

  const allTrades = useMemo(
    () => [...openTrades, ...closedTrades],
    [openTrades, closedTrades]
  );

  const handleTriggerDca = async (trade: FreqtradeTrade, e: React.MouseEvent) => {
    e.stopPropagation();
    await onAverageTrade(trade.trade_id);
    onSelectPair(trade.pair);
    setRightTab('averaged');
  };

  const handleTriggerClose = async (trade: FreqtradeTrade, e: React.MouseEvent) => {
    e.stopPropagation();
    await onForceExit(trade.trade_id);
    setRightTab('closed');
  };

  return (
    <div className="flex-1 flex flex-row h-full max-h-[calc(100vh-44px)] min-h-0 bg-[#131722] text-[#e2e8f0] overflow-hidden">
      {/* =====================================================================
          ЛЕВАЯ / ЦЕНТРАЛЬНАЯ ОБЛАСТЬ: TRADINGVIEW ГРАФИК С ПЕРЕТАСКИВАЕМЫМИ УРОВНЯМИ
      ===================================================================== */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0 h-full overflow-hidden bg-[#131722]">
        <div className="flex-1 min-h-0 h-full w-full overflow-hidden">
          <CandleChart
            pair={selectedPair}
            availablePairs={availablePairs}
            pairMetrics={whitelist?.pair_metrics}
            onSelectPair={onSelectPair}
            timeframe={timeframe}
            onSelectTimeframe={onSelectTimeframe}
            strategy={strategy}
            exchangeSource={exchangeSource}
            candles={candles}
            trades={allTrades}
            botLevels={botLevels}
            drawings={drawings}
            plotConfig={plotConfig}
            onChangePlotConfig={onChangePlotConfig}
            onRefresh={onRefresh}
            onUpdateTradeLevel={onUpdateTradeLevel}
            onUpdateBotLevel={onUpdateBotLevel}
            onAddBotLevel={onAddBotLevel}
            onDeleteBotLevel={onDeleteBotLevel}
            onClearAllBotLevels={onClearAllBotLevels}
            onAddDrawing={onAddDrawing}
            onUpdateDrawing={onUpdateDrawing}
            onDeleteDrawing={onDeleteDrawing}
            onClearAllDrawings={onClearAllDrawings}
            onQuickOrderFromChart={onQuickOrderFromChart}
            loading={loadingChart}
          />
        </div>
      </div>

      {/* =====================================================================
          СКРЫВАЮЩАЯСЯ ПРАВАЯ ПАНЕЛЬ СДЕЛОК (КАК В TRADINGVIEW)
          Вкладки: 1) Открытые  2) Усреднённые  3) Закрытые  4) Бот
      ===================================================================== */}
      <div className="flex shrink-0 h-full min-h-0 border-l border-[#2a2e39] bg-[#16181c]">
        {isRightPanelOpen && (
          <aside className="w-[350px] md:w-[420px] lg:w-[500px] xl:w-[560px] flex flex-col h-full min-h-0 max-h-full overflow-hidden bg-[#16181c]">
            {/* Компактная шапка правой панели */}
            <div className="shrink-0 bg-[#1e222d] border-b border-[#2a2e39] py-1 px-2.5 flex items-center justify-between gap-1.5">
              <span className="text-[12px] font-semibold text-white">Сделки и уровни (↕ перетаскивание на графике)</span>

              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => onBotCommand('start')}
                  title="Запустить бота"
                  className="w-6 h-6 flex items-center justify-center rounded-[3px] bg-[#21252b] hover:bg-[#2c323a] border border-[#383e48] text-[#cfd6df]"
                >
                  <Play className="w-3 h-3 fill-current" />
                </button>
                <button
                  type="button"
                  onClick={() => onBotCommand('stop')}
                  title="Остановить бота"
                  className="w-6 h-6 flex items-center justify-center rounded-[3px] bg-[#21252b] hover:bg-[#2c323a] border border-[#383e48] text-[#cfd6df]"
                >
                  <Square className="w-3 h-3 fill-current" />
                </button>
                <button
                  type="button"
                  onClick={() => onBotCommand('stopbuy')}
                  title="Пауза (запретить новые входы)"
                  className="w-6 h-6 flex items-center justify-center rounded-[3px] bg-[#21252b] hover:bg-[#2c323a] border border-[#383e48] text-[#cfd6df]"
                >
                  <Pause className="w-3 h-3 fill-current" />
                </button>
                <button
                  type="button"
                  onClick={() => onBotCommand('reload_config')}
                  title="Перезагрузить конфигурацию"
                  className="w-6 h-6 flex items-center justify-center rounded-[3px] bg-[#21252b] hover:bg-[#2c323a] border border-[#383e48] text-[#cfd6df]"
                >
                  <RotateCw className="w-3 h-3" />
                </button>
                <button
                  type="button"
                  onClick={() => onForceExit('all')}
                  title="Закрыть все открытые сделки"
                  className="w-6 h-6 flex items-center justify-center rounded-[3px] bg-[#21252b] hover:bg-[#2c323a] border border-[#383e48] text-[#cfd6df]"
                >
                  <XSquare className="w-3 h-3" />
                </button>
                <button
                  type="button"
                  onClick={() => onOpenForceEnterModal(selectedPair)}
                  title="Открыть новую сделку вручную"
                  className="px-2 h-6 inline-flex items-center gap-1 rounded-[3px] bg-[#089981] hover:bg-[#059669] text-white text-[11px] font-semibold transition-colors"
                >
                  <PlusSquare className="w-3 h-3" />
                  <span>+ Trade</span>
                </button>
                <button
                  type="button"
                  onClick={() => setIsRightPanelOpen(false)}
                  title="Свернуть правую панель"
                  className="w-6 h-6 flex items-center justify-center rounded-[3px] bg-[#181b20] hover:bg-[#262b33] border border-[#383e48] text-[#9ca3af] hover:text-white"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Вкладки разделов: Открытые | Усреднённые | Закрытые | Бот */}
            <div className="grid grid-cols-4 bg-[#131722] border-b border-[#2a2e39] p-1 gap-1">
              <button
                type="button"
                onClick={() => setRightTab('open')}
                title="Открытые сделки (без усреднения)"
                className={`py-1.5 px-1.5 rounded-[3px] text-[11.5px] font-medium flex items-center justify-center gap-1 transition-colors whitespace-nowrap ${
                  activeRightTab === 'open'
                    ? 'bg-[#2962ff] text-white font-semibold'
                    : 'bg-[#1e222d] text-[#9ca3af] hover:text-white hover:bg-[#2a2e39]'
                }`}
              >
                <span>Открытые</span>
                <span className="px-1 py-0.2 rounded bg-black/30 font-mono text-[10.5px]">
                  {newOpenTrades.length}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setRightTab('averaged')}
                title="Усреднённые сделки (DCA)"
                className={`py-1.5 px-1.5 rounded-[3px] text-[11.5px] font-medium flex items-center justify-center gap-1 transition-colors whitespace-nowrap ${
                  activeRightTab === 'averaged'
                    ? 'bg-[#b45309] text-white font-semibold'
                    : 'bg-[#1e222d] text-[#9ca3af] hover:text-white hover:bg-[#2a2e39]'
                }`}
              >
                <span>Усреднённые</span>
                <span className="px-1 py-0.2 rounded bg-black/30 font-mono text-[10.5px]">
                  {averagedTrades.length}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setRightTab('closed')}
                title="Закрытые сделки"
                className={`py-1.5 px-1.5 rounded-[3px] text-[11.5px] font-medium flex items-center justify-center gap-1 transition-colors whitespace-nowrap ${
                  activeRightTab === 'closed'
                    ? 'bg-[#334155] text-white font-semibold'
                    : 'bg-[#1e222d] text-[#9ca3af] hover:text-white hover:bg-[#2a2e39]'
                }`}
              >
                <span>Закрытые</span>
                <span className="px-1 py-0.2 rounded bg-black/30 font-mono text-[10.5px]">
                  {closedTrades.length}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setRightTab('bot')}
                title="Бот и список монет"
                className={`py-1.5 px-1.5 rounded-[3px] text-[11.5px] font-medium flex items-center justify-center gap-1 transition-colors whitespace-nowrap ${
                  activeRightTab === 'bot'
                    ? 'bg-[#2962ff] text-white font-semibold'
                    : 'bg-[#1e222d] text-[#9ca3af] hover:text-white hover:bg-[#2a2e39]'
                }`}
              >
                <span>Бот</span>
              </button>
            </div>

            {/* Короткое уведомление о синхронизации с ботом */}
            {statusNotification && (
              <div className="px-2.5 py-1 bg-[#0c2d36] border-b border-[#00a8b5]/50 text-[#7dd3fc] text-[11px] flex items-center gap-1.5">
                <CheckCircle2 className="w-3 h-3 shrink-0 text-[#00b4d8]" />
                <span className="truncate font-mono">{statusNotification}</span>
              </div>
            )}

            {/* ===============================================================
                ВКЛАДКА 1: ОТКРЫТЫЕ СДЕЛКИ (LONG = Green, SHORT = Red, TP = Green, SL = Red)
            =============================================================== */}
            {activeRightTab === 'open' && (
              <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                <div className="flex-1 overflow-auto">
                  <table className="w-full text-left border-collapse text-[11px]">
                    <thead className="sticky top-0 bg-[#16181c] z-10 shadow-sm">
                      <tr className="border-b border-[#2b3036] text-[#9ca3af] font-mono font-semibold">
                        <th className="py-1.5 px-1.5 whitespace-nowrap" title="Сторона (LONG = Зелёный, SHORT = Красный)">Side</th>
                        <th className="py-1.5 px-1.5 whitespace-nowrap" title="Торговая пара">Pair</th>
                        <th className="py-1.5 px-1.5 whitespace-nowrap" title="Сумма входа в долларах ($)">Size $</th>
                        <th className="py-1.5 px-1.5 whitespace-nowrap" title="Количество монет">Qty</th>
                        <th className="py-1.5 px-1.5 whitespace-nowrap" title="Цена входа + текущие TP (зелёный) и SL (красный)">Entry / TP·SL</th>
                        <th className="py-1.5 px-1.5 whitespace-nowrap" title="Кредитное плечо">Lev</th>
                        <th className="py-1.5 px-1.5 whitespace-nowrap" title="Дата и время открытия">Date</th>
                        <th className="py-1.5 px-1.5 text-right whitespace-nowrap" title="Действия (+DCA = Усреднить, Close = Закрыть)">Act</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#242930] text-[#d1d5db]">
                      {newOpenTrades.length === 0 ? (
                        <tr>
                          <td colSpan={8} className="py-6 text-center text-[#8b949e]">
                            Нет открытых сделок без усреднения
                          </td>
                        </tr>
                      ) : (
                        newOpenTrades.map((trade) => {
                          const isShort = trade.is_short;
                          const isSelected = trade.pair === selectedPair;
                          return (
                            <tr
                              key={trade.trade_id}
                              onClick={() => onSelectPair(trade.pair)}
                              className={`cursor-pointer transition-colors ${
                                isSelected
                                  ? 'bg-[#2962ff]/20 hover:bg-[#2962ff]/30'
                                  : 'hover:bg-[#1e2228]'
                              }`}
                            >
                              {/* 1. Side (LONG = Green, SHORT = Red) */}
                              <td className="py-1.5 px-1.5 whitespace-nowrap">
                                <span
                                  className={`inline-flex items-center px-1.5 py-0.5 rounded-[3px] text-[10px] font-mono font-bold ${
                                    isShort
                                      ? 'bg-[#3b1219] text-[#ef4444] border border-[#ef4444]/60'
                                      : 'bg-[#063928] text-[#10b981] border border-[#10b981]/60'
                                  }`}
                                >
                                  {isShort ? 'SHORT' : 'LONG'}
                                </span>
                              </td>

                              {/* 2. Pair */}
                              <td
                                className="py-1.5 px-1.5 whitespace-nowrap font-semibold text-white"
                                title={trade.pair}
                              >
                                {shortPairName(trade.pair)}
                              </td>

                              {/* 3. Size $ */}
                              <td className="py-1.5 px-1.5 whitespace-nowrap font-mono tabular-nums">
                                {fmtComma(trade.stake_amount, 1)}$
                              </td>

                              {/* 4. Qty */}
                              <td className="py-1.5 px-1.5 whitespace-nowrap font-mono tabular-nums">
                                {formatSmartNumber(trade.amount)}
                              </td>

                              {/* 5. Entry + live TP (Green) & SL (Red) synced with chart dragging */}
                              <td className="py-1.5 px-1.5 whitespace-nowrap font-mono tabular-nums">
                                <div className="text-white font-semibold">
                                  {formatSmartNumber(trade.open_rate)}$
                                </div>
                                <div className="text-[9.5px] flex items-center gap-1.5">
                                  {trade.take_profit_abs ? (
                                    <span className="text-[#10b981]" title="Take-Profit (перетаскивается на графике)">
                                      TP {formatSmartNumber(trade.take_profit_abs)}
                                    </span>
                                  ) : null}
                                  {trade.stop_loss_abs ? (
                                    <span className="text-[#ef4444]" title="Stop-Loss (перетаскивается на графике)">
                                      SL {formatSmartNumber(trade.stop_loss_abs)}
                                    </span>
                                  ) : null}
                                </div>
                              </td>

                              {/* 6. Lev */}
                              <td className="py-1.5 px-1.5 whitespace-nowrap font-mono tabular-nums text-[#38bdf8] font-semibold">
                                {trade.leverage || 1}x
                              </td>

                              {/* 7. Date */}
                              <td
                                className="py-1.5 px-1.5 whitespace-nowrap font-mono text-[10px] text-[#9ca3af]"
                                title={trade.open_date}
                              >
                                {shortDateStr(trade.open_date)}
                              </td>

                              {/* 8. Act (+DCA / Close) */}
                              <td className="py-1.5 px-1.5 text-right whitespace-nowrap">
                                <div className="inline-flex items-center gap-1 font-mono">
                                  <button
                                    type="button"
                                    onClick={(e) => handleTriggerDca(trade, e)}
                                    title="Усреднить сделку (+DCA -> перейдёт в Усреднённые)"
                                    className="px-1.5 py-0.5 rounded-[3px] bg-[#2e210b] hover:bg-[#d97706] border border-[#f59e0b]/70 text-[#fde68a] hover:text-white text-[10px] font-semibold transition-colors"
                                  >
                                    +DCA
                                  </button>

                                  <button
                                    type="button"
                                    onClick={(e) => handleTriggerClose(trade, e)}
                                    title="Закрыть сделку (перейдёт в Закрытые)"
                                    className="px-1.5 py-0.5 rounded-[3px] bg-[#3b1219] hover:bg-[#ef4444] border border-[#ef4444]/70 text-[#fca5a5] hover:text-white text-[10px] font-semibold transition-colors"
                                  >
                                    Close
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ===============================================================
                ВКЛАДКА 2: УСРЕДНЁННЫЕ СДЕЛКИ (dca_count > 0)
            =============================================================== */}
            {activeRightTab === 'averaged' && (
              <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                <div className="flex-1 overflow-auto">
                  <table className="w-full text-left border-collapse text-[11px]">
                    <thead className="sticky top-0 bg-[#16181c] z-10 shadow-sm">
                      <tr className="border-b border-[#2b3036] text-[#9ca3af] font-mono font-semibold">
                        <th className="py-1.5 px-1.5 whitespace-nowrap" title="Сторона и кратность усреднения">Side</th>
                        <th className="py-1.5 px-1.5 whitespace-nowrap" title="Торговая пара">Pair</th>
                        <th className="py-1.5 px-1.5 whitespace-nowrap" title="Общая сумма в долларах ($)">Size $</th>
                        <th className="py-1.5 px-1.5 whitespace-nowrap" title="Общее количество монет">Qty</th>
                        <th className="py-1.5 px-1.5 whitespace-nowrap" title="Начальная цена ➔ Средняя цена входа + TP/SL">AVG / TP·SL</th>
                        <th className="py-1.5 px-1.5 whitespace-nowrap" title="Кредитное плечо">Lev</th>
                        <th className="py-1.5 px-1.5 whitespace-nowrap" title="Дата последнего усреднения">Date</th>
                        <th className="py-1.5 px-1.5 text-right whitespace-nowrap" title="Действия (+DCA / Close)">Act</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#242930] text-[#d1d5db]">
                      {averagedTrades.length === 0 ? (
                        <tr>
                          <td colSpan={8} className="py-6 text-center text-[#8b949e]">
                            Нет усреднённых сделок
                          </td>
                        </tr>
                      ) : (
                        averagedTrades.map((trade) => {
                          const isShort = trade.is_short;
                          const isSelected = trade.pair === selectedPair;
                          const dcaCount = trade.dca_count || 1;
                          return (
                            <tr
                              key={trade.trade_id}
                              onClick={() => onSelectPair(trade.pair)}
                              className={`cursor-pointer transition-colors ${
                                isSelected
                                  ? 'bg-[#78350f]/30 hover:bg-[#78350f]/40'
                                  : 'hover:bg-[#1e2228]'
                              }`}
                            >
                              {/* 1. Side (LONG/SHORT + DCA ×N) */}
                              <td className="py-1.5 px-1.5 whitespace-nowrap">
                                <div className="inline-flex items-center gap-1 font-mono">
                                  <span
                                    className={`inline-flex items-center px-1.5 py-0.5 rounded-[3px] text-[10px] font-bold ${
                                      isShort
                                        ? 'bg-[#3b1219] text-[#ef4444] border border-[#ef4444]/60'
                                        : 'bg-[#063928] text-[#10b981] border border-[#10b981]/60'
                                    }`}
                                  >
                                    {isShort ? 'SHORT' : 'LONG'}
                                  </span>
                                  <span className="px-1 py-0.5 rounded-[3px] bg-[#3b2506] text-[#fbbf24] border border-[#f59e0b]/50 text-[9.5px] font-bold">
                                    ×{dcaCount}
                                  </span>
                                </div>
                              </td>

                              {/* 2. Pair */}
                              <td
                                className="py-1.5 px-1.5 whitespace-nowrap font-semibold text-white"
                                title={trade.pair}
                              >
                                {shortPairName(trade.pair)}
                              </td>

                              {/* 3. Size $ */}
                              <td className="py-1.5 px-1.5 whitespace-nowrap font-mono tabular-nums">
                                {fmtComma(trade.stake_amount, 1)}$
                              </td>

                              {/* 4. Qty */}
                              <td className="py-1.5 px-1.5 whitespace-nowrap font-mono tabular-nums">
                                {formatSmartNumber(trade.amount)}
                              </td>

                              {/* 5. Initial ➔ AVG Entry + TP (Green) / SL (Red) */}
                              <td className="py-1.5 px-1.5 whitespace-nowrap font-mono tabular-nums">
                                {trade.initial_open_rate &&
                                Math.abs(trade.initial_open_rate - trade.open_rate) > 1e-8 ? (
                                  <div className="flex items-center gap-0.5">
                                    <span className="text-[#94a3b8] line-through text-[10px]">
                                      {formatSmartNumber(trade.initial_open_rate)}
                                    </span>
                                    <span className="text-[#fbbf24] text-[10px]">➔</span>
                                    <span className="text-white font-semibold">
                                      {formatSmartNumber(trade.open_rate)}$
                                    </span>
                                  </div>
                                ) : (
                                  <div className="text-white font-semibold">
                                    {formatSmartNumber(trade.open_rate)}$
                                  </div>
                                )}
                                <div className="text-[9.5px] flex items-center gap-1.5">
                                  {trade.take_profit_abs ? (
                                    <span className="text-[#10b981]">
                                      TP {formatSmartNumber(trade.take_profit_abs)}
                                    </span>
                                  ) : null}
                                  {trade.stop_loss_abs ? (
                                    <span className="text-[#ef4444]">
                                      SL {formatSmartNumber(trade.stop_loss_abs)}
                                    </span>
                                  ) : null}
                                </div>
                              </td>

                              {/* 6. Lev */}
                              <td className="py-1.5 px-1.5 whitespace-nowrap font-mono tabular-nums text-[#38bdf8] font-semibold">
                                {trade.leverage || 1}x
                              </td>

                              {/* 7. Date */}
                              <td
                                className="py-1.5 px-1.5 whitespace-nowrap font-mono text-[10px] text-[#9ca3af]"
                                title={trade.last_dca_date || trade.open_date}
                              >
                                {shortDateStr(trade.last_dca_date || trade.open_date)}
                              </td>

                              {/* 8. Act (+DCA / Close) */}
                              <td className="py-1.5 px-1.5 text-right whitespace-nowrap">
                                <div className="inline-flex items-center gap-1 font-mono">
                                  <button
                                    type="button"
                                    onClick={(e) => handleTriggerDca(trade, e)}
                                    title="Усреднить ещё раз (+DCA)"
                                    className="px-1.5 py-0.5 rounded-[3px] bg-[#2e210b] hover:bg-[#d97706] border border-[#f59e0b]/70 text-[#fde68a] hover:text-white text-[10px] font-semibold transition-colors"
                                  >
                                    +DCA
                                  </button>

                                  <button
                                    type="button"
                                    onClick={(e) => handleTriggerClose(trade, e)}
                                    title="Закрыть сделку (перейдёт в Закрытые)"
                                    className="px-1.5 py-0.5 rounded-[3px] bg-[#3b1219] hover:bg-[#ef4444] border border-[#ef4444]/70 text-[#fca5a5] hover:text-white text-[10px] font-semibold transition-colors"
                                  >
                                    Close
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ===============================================================
                ВКЛАДКА 3: ЗАКРЫТЫЕ СДЕЛКИ (LONG = Green, SHORT = Red + PnL $)
            =============================================================== */}
            {activeRightTab === 'closed' && (
              <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                <div className="flex-1 overflow-auto">
                  <table className="w-full text-left border-collapse text-[11px]">
                    <thead className="sticky top-0 bg-[#16181c] z-10 shadow-sm">
                      <tr className="border-b border-[#2b3036] text-[#9ca3af] font-mono font-semibold">
                        <th className="py-1.5 px-1.5 whitespace-nowrap" title="Сторона (LONG / SHORT)">Side</th>
                        <th className="py-1.5 px-1.5 whitespace-nowrap" title="Торговая пара">Pair</th>
                        <th className="py-1.5 px-1.5 whitespace-nowrap" title="Сумма входа в долларах ($)">Size $</th>
                        <th className="py-1.5 px-1.5 whitespace-nowrap" title="Количество монет">Qty</th>
                        <th className="py-1.5 px-1.5 whitespace-nowrap" title="Цена входа">Entry</th>
                        <th className="py-1.5 px-1.5 whitespace-nowrap" title="Кредитное плечо">Lev</th>
                        <th className="py-1.5 px-1.5 whitespace-nowrap" title="Плюс / Минус в долларах ($)">PnL $</th>
                        <th className="py-1.5 px-1.5 whitespace-nowrap" title="Дата закрытия">Date</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#242930] text-[#d1d5db]">
                      {closedTrades.length === 0 ? (
                        <tr>
                          <td colSpan={8} className="py-6 text-center text-[#8b949e]">
                            Нет закрытых сделок
                          </td>
                        </tr>
                      ) : (
                        closedTrades.map((trade) => {
                          const isShort = trade.is_short;
                          const isProfit = trade.profit_abs >= 0;
                          const sign = trade.profit_abs > 0 ? '+' : '';
                          const isSelected = trade.pair === selectedPair;
                          return (
                            <tr
                              key={trade.trade_id}
                              onClick={() => onSelectPair(trade.pair)}
                              className={`cursor-pointer transition-colors ${
                                isSelected
                                  ? 'bg-[#2962ff]/20 hover:bg-[#2962ff]/30'
                                  : 'hover:bg-[#1e2228]'
                              }`}
                            >
                              {/* 1. Side (LONG = Green, SHORT = Red) */}
                              <td className="py-1.5 px-1.5 whitespace-nowrap">
                                <span
                                  className={`inline-flex items-center px-1.5 py-0.5 rounded-[3px] text-[10px] font-mono font-bold ${
                                    isShort
                                      ? 'bg-[#3b1219] text-[#ef4444] border border-[#ef4444]/60'
                                      : 'bg-[#063928] text-[#10b981] border border-[#10b981]/60'
                                  }`}
                                >
                                  {isShort ? 'SHORT' : 'LONG'}
                                </span>
                              </td>

                              {/* 2. Pair */}
                              <td
                                className="py-1.5 px-1.5 whitespace-nowrap font-semibold text-white"
                                title={trade.pair}
                              >
                                {shortPairName(trade.pair)}
                              </td>

                              {/* 3. Size $ */}
                              <td className="py-1.5 px-1.5 whitespace-nowrap font-mono tabular-nums">
                                {fmtComma(trade.stake_amount, 1)}$
                              </td>

                              {/* 4. Qty */}
                              <td className="py-1.5 px-1.5 whitespace-nowrap font-mono tabular-nums">
                                {formatSmartNumber(trade.amount)}
                              </td>

                              {/* 5. Entry */}
                              <td className="py-1.5 px-1.5 whitespace-nowrap font-mono tabular-nums">
                                {formatSmartNumber(trade.open_rate)}$
                              </td>

                              {/* 6. Lev */}
                              <td className="py-1.5 px-1.5 whitespace-nowrap font-mono tabular-nums text-[#38bdf8] font-semibold">
                                {trade.leverage || 1}x
                              </td>

                              {/* 7. PnL $ */}
                              <td className="py-1.5 px-1.5 whitespace-nowrap">
                                <span
                                  className={`inline-flex items-center px-1.5 py-0.5 rounded-[3px] font-mono tabular-nums text-[10.5px] font-semibold border ${
                                    isProfit
                                      ? 'bg-[#063928] text-[#10b981] border-[#10b981]'
                                      : 'bg-[#3b1219] text-[#ef4444] border-[#ef4444]'
                                  }`}
                                >
                                  {sign}
                                  {fmtComma(trade.profit_abs, 2)}$
                                </span>
                              </td>

                              {/* 8. Date */}
                              <td
                                className="py-1.5 px-1.5 whitespace-nowrap font-mono text-[10px] text-[#9ca3af]"
                                title={trade.close_date || trade.open_date}
                              >
                                {shortDateStr(trade.close_date || trade.open_date)}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ===============================================================
                ВКЛАДКА 4: ПАНЕЛЬ БОТА И СПИСОК МОНЕТ
            =============================================================== */}
            {activeRightTab === 'bot' && (
              <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                <div className="grid grid-cols-7 border-b border-[#2e343c] px-1 bg-[#191c22]">
                  {[
                    { id: 'pairs', icon: List, title: 'Список монет' },
                    { id: 'info', icon: Info, title: 'Информация о боте' },
                    { id: 'perf', icon: TrendingUp, title: 'Доходность по парам' },
                    { id: 'balance', icon: Landmark, title: 'Баланс кошелька' },
                    { id: 'daily', icon: FolderClock, title: 'Прибыль по дням' },
                    { id: 'pairlist', icon: AlignLeft, title: 'Белый и чёрный список' },
                    { id: 'locks', icon: Lock, title: 'Блокировки пар' },
                  ].map((tab) => {
                    const Icon = tab.icon;
                    const active = leftTab === tab.id;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        title={tab.title}
                        onClick={() => setLeftTab(tab.id as any)}
                        className={`flex items-center justify-center py-2.5 border-b-2 transition-colors ${
                          active
                            ? 'border-[#00b4d8] text-[#ffffff]'
                            : 'border-transparent text-[#8b949e] hover:text-[#cfd6df]'
                        }`}
                      >
                        <Icon className="w-4 h-4" />
                      </button>
                    );
                  })}
                </div>

                <div className="flex-1 overflow-y-auto p-3">
                  {leftTab === 'pairs' && (
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center gap-1.5">
                        <input
                          type="text"
                          value={pairFilter}
                          onChange={(e) => {
                            setPairFilter(e.target.value);
                            if (!isMultiPaneCoinsOpen) setIsMultiPaneCoinsOpen(true);
                          }}
                          onFocus={() => setIsMultiPaneCoinsOpen(true)}
                          placeholder="Поиск монет..."
                          className="flex-1 px-3 py-1.5 text-[13px] bg-[#141619] border border-[#323842] rounded-[4px] text-[#e2e8f0] placeholder:text-[#6c757d] focus:outline-none focus:border-[#00a8b5]"
                        />
                        <button
                          type="button"
                          onClick={() => setIsMultiPaneCoinsOpen((v) => !v)}
                          className="px-2.5 py-1.5 text-[12px] bg-[#21252b] hover:bg-[#2c323a] border border-[#383e48] rounded-[4px] text-[#cfd6df] whitespace-nowrap"
                        >
                          {isMultiPaneCoinsOpen ? 'Скрыть ▲' : `Все (${filteredPairs.length}) ▼`}
                        </button>
                      </div>

                      <div className="border border-[#2b3036] rounded-[4px] divide-y divide-[#2b3036]">
                        {(isMultiPaneCoinsOpen || pairFilter.trim().length > 0
                          ? filteredPairs
                          : filteredPairs.slice(0, 12)
                        ).map((p) => {
                          const isSelected = p === selectedPair;
                          const openStat = openTradeByPair.get(p);

                          return (
                            <button
                              key={p}
                              type="button"
                              onClick={() => onSelectPair(p)}
                              className={`w-full px-3 py-2 text-left flex items-center justify-between transition-colors ${
                                isSelected
                                  ? 'bg-[#0b5862] text-white'
                                  : 'bg-[#16181c] hover:bg-[#1e2228] text-[#e2e8f0]'
                              }`}
                            >
                              <div className="flex items-center gap-2">
                                <span className="text-[13px] font-normal tracking-tight">{p}</span>
                                {openStat && openStat.dcaCount > 0 && (
                                  <span className="px-1.5 py-0.5 rounded bg-[#3b2506] text-[#fbbf24] text-[10px] font-mono">
                                    Усредн. ×{openStat.dcaCount}
                                  </span>
                                )}
                              </div>
                              {openStat !== undefined && (
                                <ProfitPill
                                  profitPct={openStat.pct}
                                  profitAbs={openStat.abs}
                                  compact
                                />
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {leftTab === 'info' && (
                    <div className="text-xs space-y-2 text-[#cfd6df]">
                      <div className="flex justify-between py-1 border-b border-[#2b3036]">
                        <span className="text-[#8b949e]">Имя бота:</span>
                        <span>{botConfig?.bot_name || 'freqtrade-dryrun'}</span>
                      </div>
                      <div className="flex justify-between py-1 border-b border-[#2b3036]">
                        <span className="text-[#8b949e]">Статус:</span>
                        <span className="uppercase text-emerald-400">
                          {botConfig?.state === 'running'
                            ? 'Работает'
                            : botConfig?.state === 'paused'
                            ? 'Пауза'
                            : 'Остановлен'}
                        </span>
                      </div>
                      <div className="flex justify-between py-1 border-b border-[#2b3036]">
                        <span className="text-[#8b949e]">Таймфрейм:</span>
                        <span>{timeframe}</span>
                      </div>
                      <div className="flex justify-between py-1 border-b border-[#2b3036]">
                        <span className="text-[#8b949e]">Стоп-лосс:</span>
                        <span>{(botConfig?.stoploss ?? -0.03) * 100}%</span>
                      </div>
                      <div className="flex justify-between py-1 border-b border-[#2b3036]">
                        <span className="text-[#8b949e]">Макс. открытых сделок:</span>
                        <span>{botConfig?.max_open_trades ?? 5}</span>
                      </div>
                    </div>
                  )}

                  {leftTab === 'perf' && (
                    <div className="text-xs">
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr className="border-b border-[#2b3036] text-[#8b949e]">
                            <th className="py-1.5 px-2">Пара</th>
                            <th className="py-1.5 px-2 text-right">Прибыль %</th>
                            <th className="py-1.5 px-2 text-right">Сделок</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#2b3036]">
                          {performance.map((item) => (
                            <tr key={item.pair}>
                              <td className="py-1.5 px-2">{item.pair}</td>
                              <td className="py-1.5 px-2 text-right font-mono">
                                {fmtComma(item.profit_pct, 2)}%
                              </td>
                              <td className="py-1.5 px-2 text-right font-mono">{item.count}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {leftTab === 'balance' && balance && (
                    <div className="text-xs space-y-2">
                      <div className="font-semibold text-sm">
                        Всего: {fmtComma(balance.total, 3)} USDT (тест)
                      </div>
                      {balance.currencies.map((c) => (
                        <div
                          key={c.currency}
                          className="p-2 bg-[#1c2026] rounded border border-[#2b3036]"
                        >
                          <div className="flex justify-between font-mono">
                            <span>{c.currency}</span>
                            <span>{fmtComma(c.balance, 3)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {leftTab === 'daily' && (
                    <div className="text-xs">
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr className="border-b border-[#2b3036] text-[#8b949e]">
                            <th className="py-1.5 px-2">Дата</th>
                            <th className="py-1.5 px-2 text-right">Прибыль ($)</th>
                            <th className="py-1.5 px-2 text-right">Сделок</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#2b3036]">
                          {daily.map((d) => (
                            <tr key={d.date}>
                              <td className="py-1.5 px-2 font-mono">{d.date}</td>
                              <td className="py-1.5 px-2 text-right font-mono">
                                {fmtComma(d.abs_profit, 2)} $
                              </td>
                              <td className="py-1.5 px-2 text-right font-mono">{d.trade_count}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {leftTab === 'pairlist' && (
                    <div className="text-xs space-y-2">
                      <div className="font-semibold text-[#cfd6df]">
                        Белый список ({availablePairs.length}):
                      </div>
                      <div className="text-[#8b949e] leading-relaxed max-h-48 overflow-y-auto">
                        {availablePairs.join(', ')}
                      </div>
                      <div className="font-semibold text-[#cfd6df] pt-2">
                        Чёрный список ({blacklist.length}):
                      </div>
                      <div className="text-[#8b949e]">{blacklist.join(', ') || 'Пусто'}</div>
                    </div>
                  )}

                  {leftTab === 'locks' && (
                    <div className="text-xs text-[#8b949e]">
                      {locks.length === 0
                        ? 'Нет активных блокировок пар.'
                        : `Активных блокировок: ${locks.length}`}
                    </div>
                  )}
                </div>
              </div>
            )}
          </aside>
        )}

        {/* Узкая вертикальная панель быстрого доступа справа (как док-бар в TradingView) */}
        <div className="w-[44px] bg-[#181b20] border-l border-[#2b3036] flex flex-col items-center py-2 gap-2 select-none shrink-0">
          <button
            type="button"
            onClick={() => setIsRightPanelOpen((v) => !v)}
            title={isRightPanelOpen ? 'Скрыть правую панель' : 'Открыть правую панель сделок'}
            className="w-8 h-8 rounded-[4px] bg-[#21252b] hover:bg-[#2c323a] border border-[#363c46] flex items-center justify-center text-[#00b4d8]"
          >
            {isRightPanelOpen ? (
              <ChevronRight className="w-4 h-4" />
            ) : (
              <ChevronLeft className="w-4 h-4" />
            )}
          </button>

          <div className="w-6 h-[1px] bg-[#2b3036] my-0.5" />

          {/* Иконка 1: Открытые сделки */}
          <button
            type="button"
            onClick={() => setRightTab('open')}
            title={`Открытые сделки (${newOpenTrades.length})`}
            className={`w-9 py-2 rounded-[4px] flex flex-col items-center gap-1 transition-colors ${
              isRightPanelOpen && activeRightTab === 'open'
                ? 'bg-[#0b5862] text-white'
                : 'text-[#9ca3af] hover:bg-[#22262e] hover:text-white'
            }`}
          >
            <FolderOpen className="w-4 h-4" />
            <span className="text-[10px] font-mono font-semibold">{newOpenTrades.length}</span>
          </button>

          {/* Иконка 2: Усреднённые сделки */}
          <button
            type="button"
            onClick={() => setRightTab('averaged')}
            title={`Усреднённые сделки (${averagedTrades.length})`}
            className={`w-9 py-2 rounded-[4px] flex flex-col items-center gap-1 transition-colors ${
              isRightPanelOpen && activeRightTab === 'averaged'
                ? 'bg-[#78350f] text-[#fde68a]'
                : 'text-[#9ca3af] hover:bg-[#22262e] hover:text-white'
            }`}
          >
            <Layers className="w-4 h-4 text-[#f59e0b]" />
            <span className="text-[10px] font-mono font-semibold text-[#fde68a]">
              {averagedTrades.length}
            </span>
          </button>

          {/* Иконка 3: Закрытые сделки */}
          <button
            type="button"
            onClick={() => setRightTab('closed')}
            title={`Закрытые сделки (${closedTrades.length})`}
            className={`w-9 py-2 rounded-[4px] flex flex-col items-center gap-1 transition-colors ${
              isRightPanelOpen && activeRightTab === 'closed'
                ? 'bg-[#1e293b] text-white border border-[#475569]'
                : 'text-[#9ca3af] hover:bg-[#22262e] hover:text-white'
            }`}
          >
            <History className="w-4 h-4" />
            <span className="text-[10px] font-mono font-semibold">{closedTrades.length}</span>
          </button>

          {/* Иконка 4: Бот и список монет */}
          <button
            type="button"
            onClick={() => setRightTab('bot')}
            title="Управление ботом и список монет"
            className={`w-9 py-2 rounded-[4px] flex flex-col items-center gap-1 transition-colors ${
              isRightPanelOpen && activeRightTab === 'bot'
                ? 'bg-[#0b5862] text-white'
                : 'text-[#9ca3af] hover:bg-[#22262e] hover:text-white'
            }`}
          >
            <Sliders className="w-4 h-4" />
            <span className="text-[9px] font-medium">Бот</span>
          </button>
        </div>
      </div>
    </div>
  );
};
