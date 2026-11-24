import 'dotenv/config';
import express from 'express';
import http from 'http';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import {
  DEFAULT_SCALPBOT_CONFIG,
  analyzeMultiTimeframe,
  computeTakeProfitTarget,
  closedCandlesAtr,
  TP_MIN_DISTANCE_PCT,
  assessTimeframeTrend,
  assessMarketRegime,
  findStrongestDcaLevel,
  detectMarketStructure,
  extractStrongTimeframeLevels,
  isHedgeEntryCandidate,
  checkBtcMarketHealth,
  evaluateScalpingStrategy,
  evaluateGlobalHedgeStrategy,
  canExecuteDca,
  calculateDynamicDcaAmount,
  detectThreePhaseLevelReversal,
  calculateBasketConvergenceBreakeven,
  calculateTailBitePartialClose,
  checkCandleRejection,
  checkRsiCondition,
  isKnifeDrop,
  isPumpExhaustion,
  calculateWaveTrend,
} from './src/bot/scalpBotEngine.ts';
import { SqliteBotDatabase } from './src/bot/sqliteStore.ts';
import { analyzeReversalHistory } from './src/bot/reversalHistory.ts';
import {
  testExchangeConnection,
  executeExchangeFuturesOrder,
  placeOrUpdateExchangeTakeProfitOrder,
  isSimulatedTestApiKey,
  getExchangeTakerFeeRate,
  fetchExchangeOpenPositions,
  fetchExchangeClosedPnl,
  ensureExchangeHedgeMode,
  isPairTradableOnExchange,
  isBinanceHostRateLimited,
  sanitizeCredentialString,
  prewarmExchangeAccountCaches,
  stopExchangePrivateStream,
  ExchangeOrderParams,
  PlacedOrderResult,
} from './src/bot/exchangeConnector.ts';
import {
  startPublicMarketWebSockets,
  subscribePairKlineStream,
  onWsTickerUpdate,
  onWsKlineUpdate,
  onWsAccountUpdate,
  onWsExchangeExecution,
  onWsExchangePositionClosed,
  getLiveWsTicker,
  getFuturesExecutionPrice,
  getAllLiveWsTickers,
  getWebSocketEngineStatus,
  getWsAccountLiveState,
  sanitizePositionMarginUsdt,
  sanitizeWalletUsedMarginUsdt,
  LiveWsTicker,
  WsOrderFillEvent,
  WsPositionClosedEvent,
} from './src/bot/exchangeWebSocket.ts';
import {
  attachLiveWebSocketHub,
  queueLiveTickerBroadcast,
  broadcastLiveCandleTick,
  broadcastTradeLifecycleEvent,
  scheduleScopeStateSync,
  getConnectedUiClientsCount,
} from './src/bot/liveWsHub.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const sqliteDb = new SqliteBotDatabase();

interface RawCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const PINNED_PAIRS = [
  'ETH/USDT:USDT',
  'DOT/USDT:USDT',
  'AVAX/USDT:USDT',
  'LINK/USDT:USDT',
  'XRP/USDT:USDT',
  'BTC/USDT:USDT',
  'SOL/USDT:USDT',
  'DOGE/USDT:USDT',
  'ADA/USDT:USDT',
];

const EXCLUDED_BASE_ASSETS = new Set([
  'USDC',
  'FDUSD',
  'TUSD',
  'USDP',
  'BUSD',
  'DAI',
  'USD1',
  'RLUSD',
  'USDE',
  'USDD',
  'PYUSD',
  'U',
  'EUR',
  'EURI',
  'GBP',
  'AEUR',
  'TRY',
  'BRL',
  'ARS',
  'JPY',
  'PLN',
  'RON',
  'UAH',
  'ZAR',
  'SPCX',
  'XAU',
  'XAG',
  'XPT',
  'XPD',
  'CL',
  'BZ',
  'NATGAS',
  'COPPER',
  'SOXL',
  'KORU',
  'SKHYNIX',
  'SNDK',
  'NVDA',
  'TSLA',
  'AAPL',
  'MSFT',
  'AMZN',
  'GOOG',
  'GOOGL',
  'META',
  'COIN',
  'MSTR',
  'SPY',
  'QQQ',
  'INTC',
  'HOOD',
  'CRCL',
  'PLTR',
  'EWY',
  'EWJ',
  'PAYP',
  'TSM',
  'MU',
  'AVGO',
]);

let marketPairsCache: { timestamp: number; pairs: string[] } = {
  timestamp: 0,
  pairs: [...PINNED_PAIRS],
};

function pairToBinanceSymbol(pair: string): string {
  const clean = pair.split(':')[0]; // strip :USDT futures suffix
  return clean.replace('/', '').toUpperCase();
}

const candleCache = new Map<string, { timestamp: number; candles: RawCandle[]; source: string }>();
const tickerCache = new Map<string, { price: number; change24h: number; volume24h: number; high24h: number; low24h: number; updatedAt: number }>();
const exchangeTickerCache = new Map<string, LiveWsTicker>();
const fastTpInFlightIds = new Set<number>();

/**
 * Сделка открыта на Testnet/Demo-аккаунте. Публичные WebSocket-тикеры бота — это цены ОСНОВНОЙ сети
 * (Binance/Bybit Mainnet), а у Testnet свои цены. Для таких сделок цену, Mark Price и PnL берём
 * только у самой биржи (REST-позиции / приватный поток), иначе сайт расходится с биржей.
 */
function isTestnetTrade(t: FreqtradeTrade): boolean {
  const acc =
    t.account_id && t.account_id !== 'master'
      ? exchangeAccountsStore.find((a) => a.id === t.account_id)
      : resolveExchangeAccountRecord('master');
  return Boolean(acc?.is_testnet);
}

/**
 * Котировка для расчётов по сделке. Для Mainnet — живой WS-тикер (Mark / Bid / Ask).
 * Для Testnet — последняя Mark Price, полученная с самой тестовой биржи (или undefined, если её ещё нет).
 */
function getTradeExecutionQuote(
  t: FreqtradeTrade,
  isClose: boolean
): ReturnType<typeof getFuturesExecutionPrice> {
  if (!isTestnetTrade(t)) {
    return getFuturesExecutionPrice(t.pair, t.is_short, isClose, t.exchange);
  }
  const mark = Number(t.exchange_mark_price || 0);
  if (!(mark > 0)) return undefined;
  return {
    markPrice: mark,
    lastPrice: mark,
    bestBid: mark,
    bestAsk: mark,
    executionPrice: mark,
    source: 'exchange_testnet_rest',
    updatedAt: t.exchange_synced_at || Date.now(),
  };
}

/** Текущая цена пары для сделки: для Testnet — Mark Price тестовой биржи, для Mainnet — общий кэш тикеров. */
function getTradeReferencePrice(t: FreqtradeTrade): number {
  if (isTestnetTrade(t)) {
    const mark = Number(t.exchange_mark_price || 0);
    return mark > 0 ? roundPrice(mark) : 0;
  }
  const tick = tickerCache.get(t.pair);
  return tick && tick.price > 0 ? roundPrice(tick.price) : 0;
}

function refreshTradeLivePriceFromWs(t: FreqtradeTrade): boolean {
  if (!t.is_open) return false;
  const isTestnetAccount = isTestnetTrade(t);

  // Для Testnet/Demo используем ТОЛЬКО Mark Price и Unrealized PnL самой тестовой биржи (любой давности):
  // публичный Mainnet-тикер имеет другие цены и искажал бы PnL, маржу и цену закрытия
  if (isTestnetAccount) {
    if (t.exchange_mark_price && t.exchange_mark_price > 0) {
      t.current_rate = roundPrice(t.exchange_mark_price);
      return true;
    }
    return false;
  }

  const wsTick =
    getLiveWsTicker(t.pair, t.exchange) ||
    exchangeTickerCache.get(`${t.exchange}:${t.pair}`);
  if (
    wsTick &&
    (wsTick.markPrice > 0 || wsTick.price > 0) &&
    (!t.exchange_synced_at || wsTick.updatedAt >= t.exchange_synced_at)
  ) {
    const mark = wsTick.markPrice > 0 ? wsTick.markPrice : wsTick.price;
    t.exchange_mark_price = mark;
    t.current_rate = roundPrice(mark);
    if (!isTestnetAccount && t.open_rate > 0 && t.amount > 0) {
      const liveUpl = (t.is_short ? t.open_rate - mark : mark - t.open_rate) * t.amount;
      t.exchange_unrealized_pnl = Number(liveUpl.toFixed(4));
      t.exchange_synced_at = wsTick.updatedAt;
    }
    return true;
  }

  const hasFreshRestExchangeMark =
    t.exchange_mark_price &&
    t.exchange_synced_at &&
    Date.now() - t.exchange_synced_at < 120_000;
  if (!hasFreshRestExchangeMark) {
    const fallbackTick = tickerCache.get(t.pair);
    if (fallbackTick && fallbackTick.price > 0) {
      t.current_rate = roundPrice(fallbackTick.price);
      return true;
    }
  }
  return false;
}

async function processFastWsTradeClose(
  tradeId: number,
  execInfo: NonNullable<ReturnType<typeof getFuturesExecutionPrice>>,
  reasonTag: 'roi_target_tp' | 'hedge_breakeven_profit' | 'trailed_breakeven_stop_profit'
): Promise<void> {
  if (fastTpInFlightIds.has(tradeId)) return;
  const candidate = tradesStore.find((t) => t.trade_id === tradeId && t.is_open);
  if (!candidate || botConfig.state === 'stopped') return;

  const targetAccId = candidate.account_id || 'master';
  const lockKey = getPosLockKey(targetAccId, candidate.pair, candidate.is_short);
  if (activePositionKeys.has(lockKey)) return;

  fastTpInFlightIds.add(tradeId);
  try {
    await withPositionLock(lockKey, async () => {
      const trade = tradesStore.find((t) => t.trade_id === tradeId && t.is_open);
      if (!trade || botConfig.state === 'stopped') return;

      const latestExec =
        getTradeExecutionQuote(trade, true) || execInfo;
      const markPrice = roundPrice(latestExec.markPrice);
      const execPrice = roundPrice(latestExec.executionPrice);

      trade.exchange_mark_price = markPrice;
      trade.current_rate = markPrice;
      if (trade.open_rate > 0 && trade.amount > 0) {
        const markUpl =
          (trade.is_short ? trade.open_rate - markPrice : markPrice - trade.open_rate) *
          trade.amount;
        trade.exchange_unrealized_pnl = Number(markUpl.toFixed(4));
        trade.exchange_synced_at = latestExec.updatedAt;
      }
      recalculateTradeMetrics(trade, false);

      const execUpl =
        trade.open_rate > 0 && trade.amount > 0
          ? Number(
              (
                (trade.is_short ? trade.open_rate - execPrice : execPrice - trade.open_rate) *
                trade.amount
              ).toFixed(4)
            )
          : undefined;
      const guard = verifySafeProfitableClose(
        trade,
        {
          mark_price: markPrice,
          unrealized_pnl: execUpl,
          size: trade.amount,
        },
        execPrice
      );
      if (!guard.ok) return;

      const targetAcc = resolveExchangeAccountRecord(targetAccId);
      const isRealAcc = Boolean(
        targetAcc?.api_key_raw && !isSimulatedTestApiKey(targetAcc.api_key_raw)
      );
      const closeOrderRes = await dispatchOrderToExchangeAccount(targetAcc, {
        pair: trade.pair,
        action: 'CLOSE',
        isShort: trade.is_short,
        quantity: trade.amount,
        referencePrice: execPrice,
        leverage: trade.leverage || 25,
      });
      if (isRealAcc && !closeOrderRes?.success) {
        return;
      }

      const actualClosePrice =
        closeOrderRes?.success && closeOrderRes.price > 0
          ? roundPrice(closeOrderRes.price)
          : execPrice;
      const now =
        closeOrderRes?.exchange_time && closeOrderRes.exchange_time > 0
          ? closeOrderRes.exchange_time
          : Date.now();
      const nowStr = new Date(now).toISOString().replace('T', ' ').slice(0, 19);

      sqliteDb.runInTransaction(() => {
        trade.is_open = false;
        trade.close_rate = actualClosePrice;
        trade.current_rate = actualClosePrice;
        trade.close_date = nowStr;
        trade.close_timestamp = now;
        if (closeOrderRes?.open_fee_usdt && closeOrderRes.open_fee_usdt > 0) {
          trade.fee_open = Number(closeOrderRes.open_fee_usdt.toFixed(4));
        }
        if (closeOrderRes?.commission_usdt && closeOrderRes.commission_usdt > 0) {
          trade.fee_close = Number(closeOrderRes.commission_usdt.toFixed(4));
        }
        if (typeof closeOrderRes?.realized_pnl_usdt === 'number') {
          const totalFees = (trade.fee_open || 0) + (trade.fee_close || 0);
          trade.exchange_realized_pnl = Number(
            (closeOrderRes.realized_pnl_usdt - totalFees).toFixed(4)
          );
        }
        trade.exit_reason = reasonTag;
        trade.trade_state = 'CLOSED';
        trade.planned_dca_levels = [];
        recalculateTradeMetrics(trade, false);
        sqliteDb.upsertTrade(trade);
        sqliteDb.recordOrder({
          trade_id: trade.trade_id,
          pair: trade.pair,
          order_type: 'market',
          side: trade.is_short ? 'buy' : 'sell',
          price: actualClosePrice,
          amount: trade.amount,
          cost: Number((actualClosePrice * trade.amount).toFixed(4)),
          fee: trade.fee_close || 0,
          realized_pnl: trade.net_profit || trade.profit_abs,
          action_type: reasonTag === 'hedge_breakeven_profit' ? 'HEDGE_PROFIT_EXIT' : 'TAKE_PROFIT',
          notes: `[WS FAST TP] Closed at ${actualClosePrice} (Mark: ${markPrice}, Bid: ${latestExec.bestBid}, Ask: ${latestExec.bestAsk}), Net PnL: +${trade.profit_abs} USDT`,
        });

        if (trade.campaign_id) {
          const sibling = tradesStore.find(
            (s) =>
              s.is_open &&
              resolveTradeUserId(s) === resolveTradeUserId(trade) &&
              (trade.account_id
                ? s.account_id === trade.account_id
                : !s.account_id || s.account_id === 'master') &&
              s.campaign_id === trade.campaign_id &&
              s.trade_id !== trade.trade_id
          );
          if (sibling) {
            const addedProfit = Math.max(0, Number((trade.net_profit ?? trade.profit_abs ?? 0).toFixed(4)));
            sibling.campaign_banked_profit = Number(
              ((sibling.campaign_banked_profit || 0) + addedProfit).toFixed(4)
            );
            if (sibling.campaign_role === 'insurance') {
              sibling.campaign_role = 'primary';
            }
            recalculateTradeMetrics(sibling, false);
            sqliteDb.upsertTrade(sibling);
          }
        }

        if (targetAcc) {
          const accScopeId = getTargetAccountIdForRecord(targetAcc);
          const remOpen = tradesStore.filter(
            (x) => x.is_open && tradeMatchesAccount(x, targetAcc, accScopeId)
          );
          targetAcc.open_trades_count = remOpen.length;
          targetAcc.used_margin_usdt = Number(
            remOpen.reduce((s, x) => s + (x.stake_amount || 0), 0).toFixed(2)
          );
          targetAcc.unrealized_pnl = Number(
            remOpen.reduce((s, x) => s + (x.profit_abs || 0), 0).toFixed(4)
          );
        }
      });

      const tradeUserId = resolveTradeUserId(trade);
      cooldownPairs.set(`${targetAcc?.id || targetAccId}:${trade.pair}`, Date.now());
      if (targetAcc && !isSimulatedTestApiKey(targetAcc.api_key_raw) && typeof trade.exchange_realized_pnl !== 'number') {
        setTimeout(() => {
          void syncRealExchangeBalancesIfNeeded(true);
        }, 2200);
      }
      appendLog(
        'freqtrade.bot.exit',
        'INFO',
        `⚡ [WS FAST TP] [${trade.pair}] #${trade.trade_id} (${targetAcc?.name || targetAccId}): мгновенно закрыто по потоку биржи @ ${actualClosePrice}$ (Mark: ${markPrice}$) | Чистый PnL: +${trade.profit_abs}$ (комиссия: ${trade.fee_total}$)`,
        { userId: tradeUserId }
      );
      broadcastTradeLifecycleEvent('trade:closed', trade);
      scheduleScopeStateSync(tradeUserId);
    });
  } finally {
    fastTpInFlightIds.delete(tradeId);
  }
}

function evaluateFastWsTpExit(wsTick: LiveWsTicker): void {
  if (!initializedTrades || botConfig.state === 'stopped') return;
  const tickExchange: 'bybit' | 'binance' = wsTick.source === 'binance_ws' ? 'binance' : 'bybit';

  for (const t of tradesStore) {
    if (!t.is_open || t.pair !== wsTick.pair) continue;
    // Тикер пришёл из Mainnet — по нему нельзя закрывать Testnet-сделки: у тестовой биржи другие цены.
    // Testnet-сделки проверяет основной цикл по Mark Price самой тестовой биржи.
    if (isTestnetTrade(t)) continue;
    if (
      (t.exchange === 'binance' || t.exchange === 'bybit') &&
      t.exchange !== tickExchange &&
      getLiveWsTicker(t.pair, t.exchange)
    ) {
      continue;
    }
    if (fastTpInFlightIds.has(t.trade_id)) continue;

    // Если открыты обе ноги двустороннего замка (campaign_id), быстрый тик НЕ должен разрывать замок без 3-фазного подтверждения разворота на уровне (Раздел 3 и Сценарии 1/3/5)
    if (t.campaign_id) {
      const hasOpenSibling = tradesStore.some(
        (s) =>
          s.is_open &&
          s.campaign_id === t.campaign_id &&
          s.trade_id !== t.trade_id &&
          (t.account_id ? s.account_id === t.account_id : !s.account_id || s.account_id === 'master')
      );
      if (hasOpenSibling) continue;
    }

    const execInfo = getFuturesExecutionPrice(t.pair, t.is_short, true, t.exchange);
    if (!execInfo || !(execInfo.markPrice > 0)) continue;

    const mark = execInfo.markPrice;
    const execPrice = execInfo.executionPrice;

    // Мгновенный триггер основного цикла при пересечении отложенного ордера перестраховки (Сценарий 4) или анти-распил стопа (Сценарий 1Б)
    if (t.rehedge_stop_price && t.rehedge_stop_price > 0) {
      const triggeredRehedge = t.is_short
        ? mark >= t.rehedge_stop_price || execPrice >= t.rehedge_stop_price
        : mark <= t.rehedge_stop_price || execPrice <= t.rehedge_stop_price;
      if (triggeredRehedge) {
        void runScalpBotCycle();
        continue;
      }
    }
    if (t.whipsaw_stop_price && t.whipsaw_stop_price > 0) {
      const triggeredWhipsaw = t.is_short
        ? mark >= t.whipsaw_stop_price || execPrice >= t.whipsaw_stop_price
        : mark <= t.whipsaw_stop_price || execPrice <= t.whipsaw_stop_price;
      if (triggeredWhipsaw) {
        void runScalpBotCycle();
        continue;
      }
    }

    // Если активен подтянутый стоп в безубыток/плюс (Раздел 5Б/5В или Сценарий 2) и цена вернулась к нему — мгновенное закрытие по стоп-профиту
    const hasLockedBeStop =
      t.stop_loss_abs > 0 &&
      t.min_profitable_tp &&
      (t.is_short
        ? t.stop_loss_abs <= t.min_profitable_tp * 1.001
        : t.stop_loss_abs >= t.min_profitable_tp * 0.999);

    if (t.stop_loss_abs > 0) {
      const hitStop = t.is_short
        ? mark >= t.stop_loss_abs || execPrice >= t.stop_loss_abs
        : mark <= t.stop_loss_abs || execPrice <= t.stop_loss_abs;
      if (hitStop) {
        void processFastWsTradeClose(t.trade_id, execInfo, 'trailed_breakeven_stop_profit');
        continue;
      }
    }

    const minSafeTp =
      t.tp_manual_override && t.take_profit_abs > 0
        ? t.take_profit_abs
        : t.min_profitable_tp || t.breakeven_price || t.open_rate;

    if (t.take_profit_abs > 0) {
      const hitTp = t.is_short
        ? mark <= t.take_profit_abs || execPrice <= t.take_profit_abs
        : mark >= t.take_profit_abs || execPrice >= t.take_profit_abs;
      const clearedSafeTp = t.is_short
        ? mark <= minSafeTp || execPrice <= minSafeTp
        : mark >= minSafeTp || execPrice >= minSafeTp;
      if (hitTp && clearedSafeTp) {
        void processFastWsTradeClose(t.trade_id, execInfo, 'roi_target_tp');
        continue;
      }
    }

    if (
      !hasLockedBeStop &&
      t.campaign_banked_profit !== undefined &&
      t.campaign_banked_profit !== null &&
      t.campaign_banked_profit > 0 &&
      t.min_profitable_tp &&
      t.min_profitable_tp > 0
    ) {
      const reachedMin = t.is_short
        ? mark <= t.min_profitable_tp && execPrice <= t.min_profitable_tp
        : mark >= t.min_profitable_tp && execPrice >= t.min_profitable_tp;
      if (reachedMin) {
        void processFastWsTradeClose(t.trade_id, execInfo, 'hedge_breakeven_profit');
      }
    }
  }
}

// Подключаем живые WebSocket-потоки фьючерсов (Bybit V5 Linear WS + Binance USD-M Futures WS):
// обновляем tickerCache, свечи, Mark Price & PnL открытых сделок, триггерим быстрый WS TP и пушим на сайт!
onWsTickerUpdate((wsTick) => {
  const tickExchange: 'bybit' | 'binance' = wsTick.source === 'binance_ws' ? 'binance' : 'bybit';
  exchangeTickerCache.set(`${tickExchange}:${wsTick.pair}`, wsTick);

  const preferredEx =
    exchangeAccountsStore.find((a) => a.enabled)?.exchange === 'binance' ? 'binance' : 'bybit';
  const prevCachedTick = tickerCache.get(wsTick.pair);
  if (
    tickExchange === preferredEx ||
    !prevCachedTick ||
    Date.now() - prevCachedTick.updatedAt > 10_000
  ) {
    tickerCache.set(wsTick.pair, {
      price: wsTick.markPrice > 0 ? wsTick.markPrice : wsTick.price,
      change24h: wsTick.change24h,
      volume24h: wsTick.volume24h,
      high24h: wsTick.high24h,
      low24h: wsTick.low24h,
      updatedAt: wsTick.updatedAt,
    });
  }

  // Обновляем закрытие последней свечи в кэше ТОЛЬКО от той же биржи, что и источник свечей (без прыжков цен между Bybit и Binance)
  for (const [key, entry] of candleCache.entries()) {
    if (key.startsWith(`${wsTick.pair}_`) && key.endsWith('_latest') && entry.candles.length > 0) {
      const srcLower = (entry.source || '').toLowerCase();
      const entryEx = srcLower.includes('binance')
        ? 'binance'
        : srcLower.includes('bybit')
        ? 'bybit'
        : preferredEx;
      if (entryEx !== tickExchange) continue;
      const last = entry.candles[entry.candles.length - 1];
      last.close = wsTick.price;
      if (wsTick.price > last.high) last.high = wsTick.price;
      if (wsTick.price < last.low) last.low = wsTick.price;
      entry.timestamp = Date.now();
    }
  }

  // Мгновенно обновляем Mark Price и PnL открытых сделок без 30-60с REST-задержек
  for (const t of tradesStore) {
    if (!t.is_open || t.pair !== wsTick.pair) continue;
    if (
      (t.exchange === 'binance' || t.exchange === 'bybit') &&
      t.exchange !== tickExchange &&
      getLiveWsTicker(t.pair, t.exchange)
    ) {
      continue;
    }
    refreshTradeLivePriceFromWs(t);
    recalculateTradeMetrics(t, false);
  }

  // Пушим батч тикеров (до 100мс) подключённым браузерам на сайте
  queueLiveTickerBroadcast({
    pair: wsTick.pair,
    exchange: tickExchange,
    price: wsTick.price,
    markPrice: wsTick.markPrice > 0 ? wsTick.markPrice : wsTick.price,
    bestBid: wsTick.bestBid,
    bestAsk: wsTick.bestAsk,
    change24h: wsTick.change24h,
    volume24h: wsTick.volume24h,
    high24h: wsTick.high24h,
    low24h: wsTick.low24h,
    updatedAt: wsTick.updatedAt,
  });

  // Event-driven проверка Take Profit прямо на WS-тике (с защитой Zero-Loss Guard + Best Bid/Ask)
  evaluateFastWsTpExit(wsTick);
});

onWsKlineUpdate((wsKline) => {
  const klineExchange: 'bybit' | 'binance' = wsKline.source === 'binance_ws' ? 'binance' : 'bybit';
  const preferredEx =
    exchangeAccountsStore.find((a) => a.enabled)?.exchange === 'binance' ? 'binance' : 'bybit';
  const barTsMs = wsKline.time * 1000;

  for (const [key, entry] of candleCache.entries()) {
    if (
      key.startsWith(`${wsKline.pair}_${wsKline.interval}_`) &&
      key.endsWith('_latest') &&
      entry.candles.length > 0
    ) {
      const srcLower = (entry.source || '').toLowerCase();
      const entryEx = srcLower.includes('binance')
        ? 'binance'
        : srcLower.includes('bybit')
        ? 'bybit'
        : preferredEx;
      if (entryEx !== klineExchange) continue;

      const last = entry.candles[entry.candles.length - 1];
      if (last.timestamp === barTsMs) {
        last.open = wsKline.open;
        last.high = wsKline.high;
        last.low = wsKline.low;
        last.close = wsKline.close;
        last.volume = wsKline.volume;
      } else if (barTsMs > last.timestamp) {
        entry.candles.push({
          timestamp: barTsMs,
          open: wsKline.open,
          high: wsKline.high,
          low: wsKline.low,
          close: wsKline.close,
          volume: wsKline.volume,
        });
        if (entry.candles.length > 1000) {
          entry.candles.shift();
        }
      }
      entry.timestamp = Date.now();
      if (!entry.source.includes('[WS')) {
        entry.source = `${entry.source} [WS Live]`;
      }
    }
  }

  if (klineExchange === preferredEx) {
    broadcastLiveCandleTick({
      pair: wsKline.pair,
      interval: wsKline.interval,
      timestamp: barTsMs,
      open: wsKline.open,
      high: wsKline.high,
      low: wsKline.low,
      close: wsKline.close,
      volume: wsKline.volume,
      confirmed: wsKline.confirmed,
      exchange: klineExchange,
    });
  }
});

async function fetchWithTimeout(url: string, timeoutMs = 6000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Freqtrade/2025.2 FreqUI',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAllMarketPairs(): Promise<string[]> {
  if (marketPairsCache.pairs.length > PINNED_PAIRS.length && Date.now() - marketPairsCache.timestamp < 120_000) {
    return marketPairsCache.pairs;
  }

  // 0. Сначала используем живые данные из WebSocket-потока (!miniTicker@arr / tickers.*), если уже получено >= 25 пар — 0 REST запросов!
  const wsTickers = getAllLiveWsTickers();
  if (wsTickers.length >= 25) {
    const validWs = wsTickers
      .filter((t) => {
        const base = t.symbol.slice(0, -4);
        if (!base || EXCLUDED_BASE_ASSETS.has(base)) return false;
        if (
          base.endsWith('UP') ||
          base.endsWith('DOWN') ||
          base.endsWith('BULL') ||
          base.endsWith('BEAR')
        ) {
          return false;
        }
        return t.price > 0 && t.volume24h > 100_000;
      })
      .sort((a, b) => b.volume24h - a.volume24h);

    if (validWs.length >= 15) {
      const discoveredPairs: string[] = [...PINNED_PAIRS];
      const seen = new Set<string>(PINNED_PAIRS);
      for (const t of validWs) {
        if (!seen.has(t.pair)) {
          seen.add(t.pair);
          discoveredPairs.push(t.pair);
        }
      }
      marketPairsCache = {
        timestamp: Date.now(),
        pairs: discoveredPairs,
      };
      return discoveredPairs;
    }
  }

  // 1. Сначала пробуем прямой фьючерсный поток Bybit V5 Linear USDT Perpetual (без расхождения со спотом)
  try {
    const bybitRes = await fetchWithTimeout('https://api.bybit.com/v5/market/tickers?category=linear', 6000);
    if (bybitRes.ok) {
      const bybitJson = await bybitRes.json();
      const list = bybitJson?.result?.list;
      if (Array.isArray(list) && list.length > 0) {
        const usdtLinear = list
          .filter((t: any) => {
            const sym = String(t.symbol || '');
            if (!sym.endsWith('USDT')) return false;
            const base = sym.slice(0, -4);
            if (!base || EXCLUDED_BASE_ASSETS.has(base)) return false;
            const lastPrice = parseFloat(t.lastPrice) || 0;
            const turnover24h = parseFloat(t.turnover24h) || 0;
            return lastPrice > 0 && turnover24h > 100_000;
          })
          .sort((a: any, b: any) => (parseFloat(b.turnover24h) || 0) - (parseFloat(a.turnover24h) || 0));

        if (usdtLinear.length >= 15) {
          const discoveredPairs: string[] = [...PINNED_PAIRS];
          const seen = new Set<string>(PINNED_PAIRS);
          for (const t of usdtLinear) {
            const base = String(t.symbol).slice(0, -4);
            const formattedPair = `${base}/USDT:USDT`;
            const lastPrice = parseFloat(t.lastPrice) || 0;
            const markPrice = parseFloat(t.markPrice) || lastPrice;
            const changePct = (parseFloat(t.price24hPcnt) || 0) * 100;
            tickerCache.set(formattedPair, {
              price: markPrice > 0 ? markPrice : lastPrice,
              change24h: Number(changePct.toFixed(2)),
              volume24h: parseFloat(t.turnover24h) || 0,
              high24h: parseFloat(t.highPrice24h) || 0,
              low24h: parseFloat(t.lowPrice24h) || 0,
              updatedAt: Date.now(),
            });
            if (!seen.has(formattedPair)) {
              seen.add(formattedPair);
              discoveredPairs.push(formattedPair);
            }
          }
          marketPairsCache = {
            timestamp: Date.now(),
            pairs: discoveredPairs,
          };
          return discoveredPairs;
        }
      }
    }
  } catch {
    // fallback to Binance Futures / Spot below
  }

  const endpoints = [
    'https://fapi.binance.com/fapi/v1/ticker/24hr',
    'https://data-api.binance.vision/api/v3/ticker/24hr',
    'https://api.binance.com/api/v3/ticker/24hr',
  ];

  for (const url of endpoints) {
    try {
      const res = await fetchWithTimeout(url, 6500);
      if (res.ok) {
        const tickers = await res.json();
        if (Array.isArray(tickers) && tickers.length > 0) {
          const usdtTickers = tickers
            .filter((t: any) => {
              const sym = String(t.symbol || '');
              if (!sym.endsWith('USDT')) return false;
              const base = sym.slice(0, -4);
              if (!base || EXCLUDED_BASE_ASSETS.has(base)) return false;
              if (base.endsWith('UP') || base.endsWith('DOWN') || base.endsWith('BULL') || base.endsWith('BEAR')) {
                return false;
              }
              const lastPrice = parseFloat(t.lastPrice);
              const quoteVol = parseFloat(t.quoteVolume);
              return lastPrice > 0 && quoteVol > 100_000;
            })
            .sort((a: any, b: any) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));

          const discoveredPairs: string[] = [...PINNED_PAIRS];
          const seen = new Set<string>(PINNED_PAIRS);

          for (const t of usdtTickers) {
            const base = String(t.symbol).slice(0, -4);
            const formattedPair = `${base}/USDT:USDT`;
            tickerCache.set(formattedPair, {
              price: parseFloat(t.lastPrice) || 0,
              change24h: Number((parseFloat(t.priceChangePercent) || 0).toFixed(2)),
              volume24h: parseFloat(t.quoteVolume) || 0,
              high24h: parseFloat(t.highPrice) || 0,
              low24h: parseFloat(t.lowPrice) || 0,
              updatedAt: Date.now(),
            });
            if (!seen.has(formattedPair)) {
              seen.add(formattedPair);
              discoveredPairs.push(formattedPair);
            }
          }

          marketPairsCache = {
            timestamp: Date.now(),
            pairs: discoveredPairs,
          };
          return discoveredPairs;
        }
      }
    } catch {
      // try next endpoint
    }
  }

  return marketPairsCache.pairs;
}

let volatilePairsCache: { timestamp: number; pairs: string[] } = {
  timestamp: 0,
  pairs: [...PINNED_PAIRS],
};

async function fetchTopVolatileFuturesPairs(minVolumeUsdt = 50_000_000): Promise<string[]> {
  if (volatilePairsCache.pairs.length > PINNED_PAIRS.length && Date.now() - volatilePairsCache.timestamp < 120_000) {
    return volatilePairsCache.pairs;
  }

  // 0. Сначала используем живые данные из WebSocket-потока (!miniTicker@arr / tickers.*), если уже получено >= 25 пар — 0 REST запросов!
  const wsTickers = getAllLiveWsTickers();
  if (wsTickers.length >= 25) {
    const volatileWs = wsTickers
      .filter((t) => {
        const base = t.symbol.slice(0, -4);
        if (!base || EXCLUDED_BASE_ASSETS.has(base)) return false;
        if (
          base.endsWith('UP') ||
          base.endsWith('DOWN') ||
          base.endsWith('BULL') ||
          base.endsWith('BEAR')
        ) {
          return false;
        }
        return t.volume24h >= minVolumeUsdt && t.price > 0;
      })
      .map((t) => {
        const swingPct = t.low24h > 0 ? ((t.high24h - t.low24h) / t.low24h) * 100 : Math.abs(t.change24h);
        return { pair: t.pair, swingPct, volume: t.volume24h };
      })
      .sort((a, b) => b.swingPct - a.swingPct);

    if (volatileWs.length >= 10) {
      const result: string[] = [];
      const seen = new Set<string>();
      for (const item of volatileWs) {
        if (!seen.has(item.pair)) {
          seen.add(item.pair);
          result.push(item.pair);
        }
      }
      for (const p of PINNED_PAIRS) {
        if (!seen.has(p)) {
          seen.add(p);
          result.push(p);
        }
      }
      volatilePairsCache = {
        timestamp: Date.now(),
        pairs: result,
      };
      return result;
    }
  }

  // 1. Try Bybit V5 Linear USDT Perpetual Futures first (fast, unblocked globally, pure USDT-M futures)
  try {
    const bybitRes = await fetchWithTimeout('https://api.bybit.com/v5/market/tickers?category=linear', 6000);
    if (bybitRes.ok) {
      const bybitJson = await bybitRes.json();
      const list = bybitJson?.result?.list;
      if (Array.isArray(list) && list.length > 0) {
        const volatileList = list
          .filter((t: any) => {
            const sym = String(t.symbol || '');
            if (!sym.endsWith('USDT')) return false;
            const base = sym.slice(0, -4);
            if (!base || EXCLUDED_BASE_ASSETS.has(base)) return false;
            const turnover24h = parseFloat(t.turnover24h) || 0;
            const lastPrice = parseFloat(t.lastPrice) || 0;
            return turnover24h >= minVolumeUsdt && lastPrice > 0;
          })
          .map((t: any) => {
            const high = parseFloat(t.highPrice24h) || 0;
            const low = parseFloat(t.lowPrice24h) || 0;
            const lastPrice = parseFloat(t.lastPrice) || 0;
            const turnover24h = parseFloat(t.turnover24h) || 0;
            const changePct = (parseFloat(t.price24hPcnt) || 0) * 100;
            const swingPct = low > 0 ? ((high - low) / low) * 100 : 0;
            const base = String(t.symbol).slice(0, -4);
            const formattedPair = `${base}/USDT:USDT`;
            tickerCache.set(formattedPair, {
              price: lastPrice,
              change24h: Number(changePct.toFixed(2)),
              volume24h: turnover24h,
              high24h: high,
              low24h: low,
              updatedAt: Date.now(),
            });
            return { pair: formattedPair, swingPct, volume: turnover24h };
          })
          .sort((a: any, b: any) => b.swingPct - a.swingPct);

        if (volatileList.length > 0) {
          const result: string[] = [];
          const seen = new Set<string>();
          for (const item of volatileList) {
            if (!seen.has(item.pair)) {
              seen.add(item.pair);
              result.push(item.pair);
            }
          }
          for (const p of PINNED_PAIRS) {
            if (!seen.has(p)) {
              seen.add(p);
              result.push(p);
            }
          }
          volatilePairsCache = {
            timestamp: Date.now(),
            pairs: result,
          };
          return result;
        }
      }
    }
  } catch {
    // fallback to Binance endpoints below
  }

  // 2. Fallback to Binance Vision CDN (НЕ используем fapi.binance.com/fapi/v1/ticker/24hr с весом 40, чтобы не вызывать бан -1003)
  const endpoints = [
    'https://data-api.binance.vision/api/v3/ticker/24hr',
    ...(!isBinanceHostRateLimited('https://fapi.binance.com').limited
      ? ['https://fapi.binance.com/fapi/v1/ticker/24hr']
      : []),
  ];

  for (const url of endpoints) {
    try {
      const res = await fetchWithTimeout(url, 6500);
      if (res.ok) {
        const tickers = await res.json();
        if (Array.isArray(tickers) && tickers.length > 0) {
          const volatileList = tickers
            .filter((t: any) => {
              const sym = String(t.symbol || '');
              if (!sym.endsWith('USDT')) return false;
              const base = sym.slice(0, -4);
              if (!base || EXCLUDED_BASE_ASSETS.has(base)) return false;
              if (base.endsWith('UP') || base.endsWith('DOWN') || base.endsWith('BULL') || base.endsWith('BEAR')) {
                return false;
              }
              const quoteVol = parseFloat(t.quoteVolume) || 0;
              const lastPrice = parseFloat(t.lastPrice) || 0;
              return quoteVol >= minVolumeUsdt && lastPrice > 0;
            })
            .map((t: any) => {
              const high = parseFloat(t.highPrice) || 0;
              const low = parseFloat(t.lowPrice) || 0;
              const swingPct = low > 0 ? ((high - low) / low) * 100 : 0;
              const base = String(t.symbol).slice(0, -4);
              const formattedPair = `${base}/USDT:USDT`;
              tickerCache.set(formattedPair, {
                price: parseFloat(t.lastPrice) || 0,
                change24h: Number((parseFloat(t.priceChangePercent) || 0).toFixed(2)),
                volume24h: parseFloat(t.quoteVolume) || 0,
                high24h: high,
                low24h: low,
                updatedAt: Date.now(),
              });
              return { pair: formattedPair, swingPct, volume: parseFloat(t.quoteVolume) || 0 };
            })
            .sort((a: any, b: any) => b.swingPct - a.swingPct);

          const result: string[] = [];
          const seen = new Set<string>();
          for (const item of volatileList) {
            if (!seen.has(item.pair)) {
              seen.add(item.pair);
              result.push(item.pair);
            }
          }
          for (const p of PINNED_PAIRS) {
            if (!seen.has(p)) {
              seen.add(p);
              result.push(p);
            }
          }

          volatilePairsCache = {
            timestamp: Date.now(),
            pairs: result,
          };
          return result;
        }
      }
    } catch {
      // try next endpoint
    }
  }

  return volatilePairsCache.pairs.length > 0 ? volatilePairsCache.pairs : [...PINNED_PAIRS];
}

// ============================================================================
// СВЕЧИ ДЛЯ ГРАФИКА: ТОТ ЖЕ РЫНОК, ЧТО И У ТОРГОВОГО АККАУНТА
// Если бот торгует на Binance Futures Testnet, график показывает свечи самой тестовой биржи
// (у неё свои цены и особенно тени свечей), а не основной Binance — иначе график не совпадает с биржей.
// Анализ стратегии по-прежнему идёт по свечам основного рынка (у Testnet искусственный объём и тонкий стакан).
// ============================================================================

type ChartNetwork = 'mainnet' | 'binance_testnet';

function getChartNetwork(): ChartNetwork {
  const enabled = exchangeAccountsStore.filter((a) => a.enabled);
  const primary = enabled.find((a) => a.is_owner) || enabled[0];
  return primary && primary.exchange === 'binance' && primary.is_testnet ? 'binance_testnet' : 'mainnet';
}

const BINANCE_TESTNET_FAPI = 'https://testnet.binancefuture.com';
const testnetCandleCache = new Map<string, { candles: RawCandle[]; historyTs: number; tailTs: number }>();

function parseBinanceKlines(raw: any): RawCandle[] {
  return Array.isArray(raw)
    ? raw
        .map((k: any[]) => ({
          timestamp: Number(k[0]),
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
        }))
        .filter((c) => Number.isFinite(c.timestamp) && c.close > 0)
    : [];
}

async function fetchBinanceTestnetCandles(
  pair: string,
  interval: string,
  limit: number,
  endTime?: number
): Promise<{ candles: RawCandle[]; source: string }> {
  const symbol = pairToBinanceSymbol(pair);
  const source = `Binance Testnet (${interval})`;
  const url = (lim: number, end?: number) =>
    `${BINANCE_TESTNET_FAPI}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${lim}${end ? `&endTime=${end}` : ''}`;

  // Старая история (прокрутка графика влево) — отдельный запрос, кэшируем на 10 минут
  if (endTime) {
    const key = `${symbol}_${interval}_${limit}_${endTime}`;
    const hit = testnetCandleCache.get(key);
    if (hit && Date.now() - hit.historyTs < 600_000) return { candles: hit.candles, source };
    try {
      const res = await fetchWithTimeout(url(limit, endTime), 6000);
      if (res.ok) {
        const candles = parseBinanceKlines(await res.json());
        testnetCandleCache.set(key, { candles, historyTs: Date.now(), tailTs: Date.now() });
        return { candles, source };
      }
    } catch {
      // ignore
    }
    return { candles: hit?.candles || [], source: hit ? `${source} (Cached)` : 'Offline' };
  }

  // Последние свечи: полную историю обновляем раз в 5 минут, а хвост (3 последние свечи) — не чаще раза в 3 секунды
  const key = `${symbol}_${interval}_latest`;
  const entry = testnetCandleCache.get(key);
  const now = Date.now();
  try {
    if (!entry || entry.candles.length < limit || now - entry.historyTs > 300_000) {
      const res = await fetchWithTimeout(url(1000), 6000);
      if (res.ok) {
        const candles = parseBinanceKlines(await res.json());
        if (candles.length > 5) {
          testnetCandleCache.set(key, { candles, historyTs: now, tailTs: now });
          return { candles: candles.slice(-limit), source };
        }
      }
    } else if (now - entry.tailTs > 3_000) {
      const res = await fetchWithTimeout(url(3), 4000);
      if (res.ok) {
        const tail = parseBinanceKlines(await res.json());
        const merged = entry.candles.slice();
        for (const c of tail) {
          const last = merged[merged.length - 1];
          if (last && c.timestamp === last.timestamp) merged[merged.length - 1] = c;
          else if (!last || c.timestamp > last.timestamp) merged.push(c);
        }
        entry.candles = merged.slice(-1000);
        entry.tailTs = now;
      }
    }
  } catch {
    // сеть недоступна — отдаём то, что есть в кэше
  }
  const cur = testnetCandleCache.get(key);
  return cur ? { candles: cur.candles.slice(-limit), source } : { candles: [], source: 'Offline' };
}

/** Свечи для графика сайта — с рынка, на котором реально торгует аккаунт. */
async function fetchChartCandles(
  pair: string,
  timeframe: string,
  limit = 1000,
  endTime?: number
): Promise<{ candles: RawCandle[]; source: string }> {
  if (getChartNetwork() === 'binance_testnet') {
    const tf = String(timeframe || '1h').trim().toLowerCase();
    const interval = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '1w'].includes(tf)
      ? tf
      : '1h';
    const res = await fetchBinanceTestnetCandles(pair, interval, Math.min(1000, Math.max(50, limit)), endTime);
    if (res.candles.length > 0) return res;
  }
  return fetchRealCandles(pair, timeframe, limit, endTime);
}

async function fetchRealCandles(
  pair: string,
  timeframe: string,
  limit = 1000,
  endTime?: number
): Promise<{ candles: RawCandle[]; source: string }> {
  const safeLimit = Math.min(1000, Math.max(50, limit));
  const normTf = String(timeframe || '1h').trim().toLowerCase();
  const validIntervals: Record<string, string> = {
    '1m': '1m',
    '3m': '3m',
    '5m': '5m',
    '15m': '15m',
    '30m': '30m',
    '1h': '1h',
    '2h': '2h',
    '4h': '4h',
    '6h': '6h',
    '8h': '8h',
    '12h': '12h',
    '1d': '1d',
    '1w': '1w',
  };
  const interval = validIntervals[normTf] || '1h';
  if (!endTime) {
    subscribePairKlineStream(pair, interval);
  }
  const cacheKey = `${pair}_${interval}_${safeLimit}_${endTime || 'latest'}`;
  const cached = candleCache.get(cacheKey);
  // Поскольку живые свечи обновляются в реальном времени по WebSocket, увеличиваем TTL кэша, чтобы не дёргать REST
  const candleTtlMs =
    interval === '1d' || interval === '1w' || interval === '4h' || interval === '6h' || interval === '12h'
      ? 300_000
      : 90_000;
  if (cached && Date.now() - cached.timestamp < candleTtlMs) {
    return { candles: cached.candles, source: cached.source };
  }

  // Если в candleCache уже есть более длинная история по этой же паре и таймфрейму (например, 500 или 1000 свечей),
  // возвращаем срез последних safeLimit свечей из неё без повторного HTTP REST-запроса!
  if (!endTime) {
    for (const [k, v] of candleCache.entries()) {
      if (
        k.startsWith(`${pair}_${interval}_`) &&
        k.endsWith('_latest') &&
        v.candles.length >= safeLimit &&
        Date.now() - v.timestamp < candleTtlMs
      ) {
        return {
          candles: v.candles.slice(-safeLimit),
          source: v.source,
        };
      }
    }
  }

  const symbol = pairToBinanceSymbol(pair);
  const cleanPair = pair.split(':')[0].toUpperCase();
  const [baseAsset = 'ETH', quoteAsset = 'USDT'] = cleanPair.split('/');
  const endTimeMs = endTime && Number.isFinite(endTime) ? Math.floor(endTime) : undefined;
  const endTimeParam = endTimeMs ? `&endTime=${endTimeMs}` : '';

  const bybitIntervals: Record<string, string> = {
    '1m': '1',
    '3m': '3',
    '5m': '5',
    '15m': '15',
    '30m': '30',
    '1h': '60',
    '2h': '120',
    '4h': '240',
    '6h': '360',
    '12h': '720',
    '1d': 'D',
    '1w': 'W',
  };
  const okxBars: Record<string, string> = {
    '1m': '1m',
    '3m': '3m',
    '5m': '5m',
    '15m': '15m',
    '30m': '30m',
    '1h': '1H',
    '2h': '2H',
    '4h': '4H',
    '6h': '6HUTC',
    '12h': '12HUTC',
    '1d': '1DUTC',
    '1w': '1WUTC',
  };
  const bitgetGrans: Record<string, string> = {
    '1m': '1m',
    '5m': '5m',
    '15m': '15m',
    '30m': '30m',
    '1h': '1H',
    '4h': '4H',
    '6h': '6H',
    '12h': '12H',
    '1d': '1D',
    '1w': '1W',
  };

  interface KlineProvider {
    id: SupportedExchange;
    name: string;
    url: string;
    parse: (raw: any) => RawCandle[];
  }

  // Публичные свечи запрашиваем строго с реальных фьючерсных рынков Mainnet (Bybit V5 Linear и Binance USD-M Futures),
  // чтобы исторические свечи и уровни MTF 1:1 совпадали с живым фьючерсным WebSocket-потоком без скачков цен Testnet vs Mainnet.
  const allProviders: KlineProvider[] = [
    ...(bybitIntervals[interval]
      ? [
          {
            id: 'bybit' as SupportedExchange,
            name: `Bybit Futures (${interval})`,
            url: `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${bybitIntervals[interval]}&limit=${safeLimit}${
              endTimeMs ? `&end=${endTimeMs}` : ''
            }`,
            parse: (raw: any) => {
              const list = raw?.result?.list;
              if (!Array.isArray(list)) return [];
              return list
                .map((k: any[]) => ({
                  timestamp: Number(k[0]),
                  open: parseFloat(k[1]),
                  high: parseFloat(k[2]),
                  low: parseFloat(k[3]),
                  close: parseFloat(k[4]),
                  volume: parseFloat(k[5]),
                }))
                .sort((a, b) => a.timestamp - b.timestamp);
            },
          },
        ]
      : []),
    ...(!isBinanceHostRateLimited('https://fapi.binance.com').limited
      ? [
          {
            id: 'binance' as SupportedExchange,
            name: `Binance Futures (${interval})`,
            url: `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${safeLimit}${endTimeParam}`,
            parse: (raw: any) =>
              Array.isArray(raw)
                ? raw.map((k: any[]) => ({
                    timestamp: Number(k[0]),
                    open: parseFloat(k[1]),
                    high: parseFloat(k[2]),
                    low: parseFloat(k[3]),
                    close: parseFloat(k[4]),
                    volume: parseFloat(k[5]),
                  }))
                : [],
          },
        ]
      : []),
    {
      id: 'binance',
      name: `Binance (${interval})`,
      url: `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${safeLimit}${endTimeParam}`,
      parse: (raw: any) =>
        Array.isArray(raw)
          ? raw.map((k: any[]) => ({
              timestamp: Number(k[0]),
              open: parseFloat(k[1]),
              high: parseFloat(k[2]),
              low: parseFloat(k[3]),
              close: parseFloat(k[4]),
              volume: parseFloat(k[5]),
            }))
          : [],
    },
    ...(okxBars[interval]
      ? [
          {
            id: 'okx' as SupportedExchange,
            name: `OKX Swap (${interval})`,
            url: `https://www.okx.com/api/v5/market/candles?instId=${baseAsset}-${quoteAsset}-SWAP&bar=${okxBars[interval]}&limit=${Math.min(
              300,
              safeLimit
            )}${endTimeMs ? `&after=${endTimeMs}` : ''}`,
            parse: (raw: any) => {
              const list = raw?.data;
              if (!Array.isArray(list)) return [];
              return list
                .map((k: any[]) => ({
                  timestamp: Number(k[0]),
                  open: parseFloat(k[1]),
                  high: parseFloat(k[2]),
                  low: parseFloat(k[3]),
                  close: parseFloat(k[4]),
                  volume: parseFloat(k[5]),
                }))
                .sort((a, b) => a.timestamp - b.timestamp);
            },
          },
        ]
      : []),
    ...(bitgetGrans[interval]
      ? [
          {
            id: 'bitget' as SupportedExchange,
            name: `Bitget Futures (${interval})`,
            url: `https://api.bitget.com/api/v2/mix/market/candles?symbol=${symbol}&productType=USDT-FUTURES&granularity=${bitgetGrans[interval]}&limit=${Math.min(
              1000,
              safeLimit
            )}${endTimeParam}`,
            parse: (raw: any) => {
              const list = raw?.data;
              if (!Array.isArray(list)) return [];
              return list
                .map((k: any[]) => ({
                  timestamp: Number(k[0]),
                  open: parseFloat(k[1]),
                  high: parseFloat(k[2]),
                  low: parseFloat(k[3]),
                  close: parseFloat(k[4]),
                  volume: parseFloat(k[5]),
                }))
                .sort((a, b) => a.timestamp - b.timestamp);
            },
          },
        ]
      : []),
    {
      id: 'bingx',
      name: `BingX Swap (${interval})`,
      url: `https://open-api.bingx.com/openApi/swap/v3/quote/klines?symbol=${baseAsset}-${quoteAsset}&interval=${interval}&limit=${Math.min(
        1000,
        safeLimit
      )}${endTimeParam}`,
      parse: (raw: any) => {
        const list = raw?.data;
        if (!Array.isArray(list)) return [];
        return list
          .map((k: any) => ({
            timestamp: Number(k.time),
            open: parseFloat(k.open),
            high: parseFloat(k.high),
            low: parseFloat(k.low),
            close: parseFloat(k.close),
            volume: parseFloat(k.volume),
          }))
          .sort((a, b) => a.timestamp - b.timestamp);
      },
    },
    {
      id: 'binance',
      name: `Binance Spot (${interval})`,
      url: `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${safeLimit}${endTimeParam}`,
      parse: (raw: any) =>
        Array.isArray(raw)
          ? raw.map((k: any[]) => ({
              timestamp: Number(k[0]),
              open: parseFloat(k[1]),
              high: parseFloat(k[2]),
              low: parseFloat(k[3]),
              close: parseFloat(k[4]),
              volume: parseFloat(k[5]),
            }))
          : [],
    },
  ];

  // Prioritize the active exchange account if configured by the user
  const preferredExchange = exchangeAccountsStore.find((a) => a.enabled)?.exchange;
  const orderedProviders = preferredExchange
    ? [
        ...allProviders.filter((p) => p.id === preferredExchange),
        ...allProviders.filter((p) => p.id !== preferredExchange),
      ]
    : allProviders;

  const tryProvider = async (provider: KlineProvider, timeoutMs: number) => {
    const res = await fetchWithTimeout(provider.url, timeoutMs);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const candles = provider
      .parse(await res.json())
      .filter((c) => Number.isFinite(c.timestamp) && Number.isFinite(c.close) && c.close > 0);
    if (candles.length <= 5) throw new Error('empty');
    return { provider, candles };
  };

  // Сначала основной источник (биржа аккаунта); если он не ответил за 3.5 с — опрашиваем остальные
  // ПАРАЛЛЕЛЬНО и берём первый успешный ответ (раньше они перебирались по очереди по 5.5 с каждый).
  let winner: { provider: KlineProvider; candles: RawCandle[] } | null = null;
  if (orderedProviders.length > 0) {
    try {
      winner = await tryProvider(orderedProviders[0], 3500);
    } catch {
      winner = null;
    }
  }
  if (!winner && orderedProviders.length > 1) {
    try {
      winner = await Promise.any(orderedProviders.slice(1).map((p) => tryProvider(p, 5000)));
    } catch {
      winner = null;
    }
  }

  if (winner) {
    const { provider, candles } = winner;
    {
      {
          if (!endTimeMs) {
            const latest = candles[candles.length - 1];
            const existingTicker = tickerCache.get(pair);
            const target24hAgo = latest.timestamp - 86_400_000;
            const candle24h =
              candles.find((c) => c.timestamp >= target24hAgo) || candles[0];
            const computedChange24h = candle24h
              ? Number((((latest.close - candle24h.open) / candle24h.open) * 100).toFixed(2))
              : 0;

            tickerCache.set(pair, {
              price: latest.close,
              change24h:
                existingTicker && existingTicker.change24h !== 0
                  ? existingTicker.change24h
                  : computedChange24h,
              volume24h:
                existingTicker?.volume24h ||
                candles.reduce((acc, c) => acc + c.volume * c.close, 0),
              high24h:
                existingTicker?.high24h ||
                Math.max(...candles.slice(-24).map((c) => c.high)),
              low24h:
                existingTicker?.low24h ||
                Math.min(...candles.slice(-24).map((c) => c.low)),
              updatedAt: Date.now(),
            });
          }
          candleCache.set(cacheKey, {
            timestamp: Date.now(),
            candles,
            source: provider.name,
          });
          return { candles, source: provider.name };
      }
    }
  }

  // No synthetic/demo candles: if all 5 exchanges are unreachable, return last cached real candles if available, otherwise empty
  const staleCached = candleCache.get(cacheKey);
  if (staleCached && staleCached.candles.length > 0) {
    return { candles: staleCached.candles, source: `${staleCached.source} (Cached)` };
  }
  return { candles: [], source: 'Offline' };
}

function buildFreqtradeDataframe(
  pair: string,
  timeframe: string,
  strategy: string,
  candles: RawCandle[],
  source: string
) {
  const columns = [
    'date',
    'open',
    'high',
    'low',
    'close',
    'volume',
    'enter_long',
    'enter_tag',
    'exit_long',
    'exit_tag',
    'enter_short',
    'exit_short',
  ];

  // Compute real ScalpingStrategy WaveTrend + Market Structure signals on this timeframe's candles
  const { wt1, wt2 } = calculateWaveTrend(candles);
  const ms = candles.length >= 20 ? detectMarketStructure(candles, Math.min(80, candles.length)) : null;
  const sup = ms?.nearest_support || 0;
  const res = ms?.nearest_resistance || 0;

  const data: any[][] = candles.map((c, idx) => {
    let enterLong: number | null = null;
    let enterTag: string | null = null;
    let exitLong: number | null = null;
    let exitTag: string | null = null;
    let enterShort: number | null = null;
    let exitShort: number | null = null;

    if (idx >= 22) {
      const prevWt1 = wt1[idx - 1];
      const prevWt2 = wt2[idx - 1];
      const curWt1 = wt1[idx];
      const curWt2 = wt2[idx];
      const crossedUp = prevWt1 <= prevWt2 && curWt1 > curWt2;
      const crossedDown = prevWt1 >= prevWt2 && curWt1 < curWt2;
      const nearSup = sup > 0 && Math.abs(c.low - sup) / sup <= 0.012;
      const nearRes = res > 0 && Math.abs(c.high - res) / res <= 0.012;

      if (crossedUp && (curWt2 <= -45 || nearSup) && c.close > c.open) {
        enterLong = c.low;
        enterTag = `WT_LONG_${timeframe.toUpperCase()}`;
      } else if (crossedDown && (curWt2 >= 45 || nearRes) && c.close < c.open) {
        enterShort = c.high;
        exitLong = c.high;
        exitTag = `WT_SHORT_${timeframe.toUpperCase()}`;
        exitShort = c.low;
      }
    }

    return [
      c.timestamp,
      c.open,
      c.high,
      c.low,
      c.close,
      c.volume,
      enterLong,
      enterTag,
      exitLong,
      exitTag,
      enterShort,
      exitShort,
    ];
  });

  return {
    pair,
    timeframe,
    strategy,
    exchange_source: source,
    columns,
    data,
    length: data.length,
    last_analyzed: Date.now(),
  };
}

// ============================================================================
// FREQTRADE BOT STATE MATCHING USER SCREENSHOTS + LIVE EXCHANGE CANDLES
// ============================================================================

interface TradeOrderEntry {
  id: string;
  step: number;
  label: string;
  side: 'long' | 'short';
  price: number;
  amount: number;
  stake_amount: number;
  timestamp: number;
  date: string;
}

interface PlannedDcaLevel {
  step: number;
  label: string;
  price: number;
  stake_amount: number;
  amount: number;
  distance_pct: number;
  manual_override?: boolean;
  filled?: boolean;
  filled_at?: string;
}

interface BotChartLevel {
  id: string;
  pair: string;
  label: string;
  role: 'support' | 'resistance' | 'entry_trigger';
  price: number;
  touches?: number;
  bounces?: number;
  breaks?: number;
  strength_score?: number;
  source?: string;
  manual_override?: boolean;
  updated_at: string;
  zone_low?: number;
  zone_high?: number;
  mirror_retests?: number;
  false_breakouts?: number;
  consolidation_bars?: number;
  timeframe_role?: string;
}

interface FreqtradeTrade {
  trade_id: number;
  pair: string;
  base_currency: string;
  quote_currency: string;
  is_open: boolean;
  is_short: boolean;
  exchange: string;
  account_id?: string;
  account_name?: string;
  user_id?: string;
  parent_trade_id?: number;
  synced_accounts?: string[];
  amount: number;
  initial_amount?: number;
  stake_amount: number;
  initial_stake?: number;
  strategy: string;
  timeframe: string;
  enter_tag: string;
  open_date: string;
  open_timestamp: number;
  open_rate: number;
  initial_open_rate: number;
  dca_count: number;
  last_dca_date: string | null;
  current_rate: number;
  close_date: string | null;
  close_timestamp: number | null;
  close_rate: number | null;
  profit_ratio: number;
  profit_pct: number;
  profit_abs: number;
  take_profit_abs: number;
  take_profit_pct: number;
  tp_manual_override?: boolean;
  stop_loss_abs: number;
  stop_loss_pct: number;
  sl_manual_override?: boolean;
  dca_manual_override?: boolean;
  initial_stop_loss_abs: number;
  initial_stop_loss_pct: number;
  exit_reason: string | null;
  leverage: number;
  support_level?: number;
  resistance_level?: number;
  next_dca_price?: number;
  trade_state?: string;
  pullback_min_profit_pct?: number;
  plan_notes?: string;
  campaign_id?: string;
  campaign_role?: 'primary' | 'insurance' | 'standalone';
  campaign_banked_profit?: number;
  rehedge_stop_price?: number;
  rehedge_stop_qty?: number;
  whipsaw_stop_price?: number;
  tail_bites_count?: number;
  fee_open?: number;
  fee_close?: number;
  fee_total?: number;
  gross_profit?: number;
  net_profit?: number;
  net_profit_percent?: number;
  breakeven_price?: number;
  min_profitable_tp?: number;
  exchange_unrealized_pnl?: number;
  exchange_mark_price?: number;
  exchange_synced_at?: number;
  exchange_realized_pnl?: number;
  tp_horizon?: string;
  tp_reason?: string;
  dca_history?: any[];
  orders: TradeOrderEntry[];
  planned_dca_levels: PlannedDcaLevel[];
}

// Стандартная комиссия биржи Taker 0.06% (0.0006) на открытие, каждый шаг DCA и закрытие сделки
const TAKER_FEE_RATE = 0.0006;
// Расширенный защитный буфер над точкой безубытка (0.50% движения цены), перекрывающий комиссии входа/выхода, фандинг, спред и рыночное проскальзывание
const MIN_NET_PROFIT_PRICE_BUFFER = 0.005;

function roundPrice(val: number): number {
  if (!Number.isFinite(val) || val <= 0) return 0;
  if (val >= 1000) return Number(val.toFixed(2));
  return Number(val.toPrecision(8));
}

function verifySafeProfitableClose(
  trade: FreqtradeTrade,
  liveExPos: { mark_price?: number; unrealized_pnl?: number; size?: number } | undefined,
  liveMarketPrice: number
): { ok: boolean; reason: string; slippageReserveUsdt: number; totalFees: number } {
  const feeRate = getExchangeTakerFeeRate(trade.exchange || 'bybit');
  const refPrice = liveMarketPrice > 0 ? liveMarketPrice : trade.current_rate;
  const markPrice = liveExPos?.mark_price || trade.exchange_mark_price || refPrice;
  const qty = Math.max(0, trade.amount || 0);
  const notionalUsdt = refPrice * qty;
  const estClosingFee = notionalUsdt * feeRate;
  const totalFees = Number(((trade.fee_open || 0) + estClosingFee).toFixed(4));
  // Пропорциональный резерв проскальзывания (0.12% от объёма позиции) без завышенного порога $0.15, блокировавшего малые ордера
  const slippageReserveUsdt = Number(Math.max(0.005, notionalUsdt * 0.0012).toFixed(4));

  // Если пользователь вручную выставил TP (tp_manual_override), разрешаем закрытие при достижении этого TP
  if (trade.tp_manual_override && trade.take_profit_abs > 0) {
    const hitManualTp = trade.is_short
      ? refPrice <= trade.take_profit_abs || markPrice <= trade.take_profit_abs
      : refPrice >= trade.take_profit_abs || markPrice >= trade.take_profit_abs;
    if (hitManualTp) {
      return { ok: true, reason: 'manual_tp_override', slippageReserveUsdt, totalFees };
    }
  }

  const minSafeTp = trade.min_profitable_tp || trade.breakeven_price || trade.open_rate;
  // Допускаем спред стакана в пределах 0.08% вокруг minSafeTp, если Mark-цена или цена исполнения уже пробила целевой TP
  const spreadTolerance = minSafeTp * 0.0008;
  const marketPastSafeTp = trade.is_short
    ? refPrice <= minSafeTp + spreadTolerance
    : refPrice >= minSafeTp - spreadTolerance;
  if (!marketPastSafeTp) {
    return {
      ok: false,
      reason: `Цена ${refPrice} ещё не прошла защитный порог безубытка ${minSafeTp}`,
      slippageReserveUsdt,
      totalFees,
    };
  }

  if (markPrice > 0) {
    const markPastSafeTp = trade.is_short
      ? markPrice <= minSafeTp + spreadTolerance
      : markPrice >= minSafeTp - spreadTolerance;
    if (!markPastSafeTp) {
      return {
        ok: false,
        reason: `Mark-цена биржи ${markPrice} ещё не прошла защитный порог ${minSafeTp}`,
        slippageReserveUsdt,
        totalFees,
      };
    }
  }

  // Считаем фактический валовой и чистый PnL по актуальной цене закрытия refPrice / markPrice,
  // чтобы устаревший REST-кэш exchange_unrealized_pnl не блокировал закрытие на импульсном пробое TP
  const bestCheckPrice =
    markPrice > 0
      ? trade.is_short
        ? Math.max(refPrice, markPrice)
        : Math.min(refPrice, markPrice)
      : refPrice;
  const computedGrossAtRef =
    trade.open_rate > 0 && qty > 0
      ? Number(
          (
            (trade.is_short ? trade.open_rate - bestCheckPrice : bestCheckPrice - trade.open_rate) *
            qty
          ).toFixed(4)
        )
      : undefined;
  const computedNetAtRef =
    computedGrossAtRef !== undefined
      ? Number((computedGrossAtRef - totalFees).toFixed(4))
      : undefined;

  const freshExUnrealized =
    liveExPos && typeof liveExPos.unrealized_pnl === 'number'
      ? liveExPos.unrealized_pnl
      : computedGrossAtRef;

  const effectiveGross =
    computedGrossAtRef !== undefined && freshExUnrealized !== undefined
      ? Math.max(computedGrossAtRef, freshExUnrealized)
      : (computedGrossAtRef ?? freshExUnrealized);

  const bankedProfitUsdt = Math.max(0, Number(trade.campaign_banked_profit || 0));
  const isUnloadingPriorityL2 = (trade.dca_count || 0) >= 2;
  const maxAllowedUnloadingLoss = isUnloadingPriorityL2
    ? Math.max(0, (trade.stake_amount || 0) * 0.1)
    : 0;

  if (typeof effectiveGross === 'number' && Number.isFinite(effectiveGross)) {
    const requiredGross = totalFees + slippageReserveUsdt - bankedProfitUsdt - maxAllowedUnloadingLoss;
    if (effectiveGross <= requiredGross) {
      return {
        ok: false,
        reason: `Unrealized PnL (${effectiveGross.toFixed(3)}$ + банк ${bankedProfitUsdt.toFixed(2)}$) не перекрывает комиссии + резерв проскальзывания (${(totalFees + slippageReserveUsdt).toFixed(3)}$)`,
        slippageReserveUsdt,
        totalFees,
      };
    }
  }

  const effectiveNet =
    computedNetAtRef !== undefined
      ? Math.max(computedNetAtRef, trade.net_profit ?? trade.profit_abs ?? -Infinity)
      : (trade.net_profit ?? trade.profit_abs ?? 0);
  const cycleNetWithBank = effectiveNet + bankedProfitUsdt + maxAllowedUnloadingLoss;
  if (cycleNetWithBank <= slippageReserveUsdt) {
    return {
      ok: false,
      reason: `Расчётный чистый итог цикла (${(effectiveNet + bankedProfitUsdt).toFixed(3)}$) <= резерва проскальзывания (${slippageReserveUsdt.toFixed(3)}$)`,
      slippageReserveUsdt,
      totalFees,
    };
  }

  return { ok: true, reason: 'ok', slippageReserveUsdt, totalFees };
}

// Load freqtrade/config.json from ported repository if available
let rawFreqtradeJson: Record<string, any> = {};
try {
  const cfgPath = path.resolve(process.cwd(), 'freqtrade/config.json');
  if (fs.existsSync(cfgPath)) {
    rawFreqtradeJson = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  }
} catch {
  rawFreqtradeJson = {};
}

const scalpBotConfig = {
  ...DEFAULT_SCALPBOT_CONFIG,
  ...rawFreqtradeJson,
};

function recalculateTradeMetrics(trade: FreqtradeTrade, resetLevels = false) {
  const lev = trade.leverage || scalpBotConfig.leverage || 25;
  const openRate = trade.open_rate > 0 ? trade.open_rate : 1;
  const refRate = trade.is_open ? trade.current_rate : (trade.close_rate ?? trade.current_rate);
  const totalAmount = Math.max(1e-8, trade.amount || 0);
  if (trade.amount > 0 && trade.open_rate > 0) {
    trade.stake_amount = sanitizePositionMarginUsdt(
      Number(trade.stake_amount || 0),
      trade.amount,
      trade.open_rate,
      lev
    );
    trade.initial_stake = sanitizePositionMarginUsdt(
      Number(trade.initial_stake || trade.stake_amount || 0),
      Number(trade.initial_amount || trade.amount),
      Number(trade.initial_open_rate || trade.open_rate),
      lev
    );
  }
  if ((trade.dca_count || 0) === 0 && trade.open_rate > 0) {
    trade.initial_open_rate = trade.open_rate;
    if (Array.isArray(trade.orders) && trade.orders.length === 1 && Number(trade.orders[0]?.step || 0) === 0) {
      trade.orders[0].price = trade.open_rate;
    }
  }
  const exchangeFeeRate = getExchangeTakerFeeRate(trade.exchange || 'bybit');

  // Суммируем комиссию на открытие по всем реально исполненным ордерам (Начальный вход + все шаги DCA) по реальной ставке Taker биржи
  let openFeeSum = 0;
  if (Array.isArray(trade.orders) && trade.orders.length > 0) {
    for (const ord of trade.orders) {
      const ordNotional = (Number(ord.price) || openRate) * (Number(ord.amount) || 0);
      const actualOrdFee = Number((ord as any).commission_usdt || 0);
      openFeeSum += actualOrdFee > 0 ? actualOrdFee : ordNotional * exchangeFeeRate;
    }
  }
  if (openFeeSum <= 0) {
    openFeeSum = openRate * totalAmount * exchangeFeeRate;
  }

  const exitNotional = refRate * totalAmount;
  if (trade.is_open || typeof trade.fee_open !== 'number' || !(trade.fee_open >= 0)) {
    trade.fee_open = Number(openFeeSum.toFixed(4));
  }
  // Если сделка уже закрыта и биржа вернула точную комиссию закрытия, сохраняем её 1:1
  if (trade.is_open || typeof trade.fee_close !== 'number' || !(trade.fee_close >= 0)) {
    trade.fee_close = Number((exitNotional * exchangeFeeRate).toFixed(4));
  }
  trade.fee_total = Number((trade.fee_open + trade.fee_close).toFixed(4));

  const hasFreshExchangeUnrealized =
    trade.is_open &&
    typeof trade.exchange_unrealized_pnl === 'number' &&
    Number.isFinite(trade.exchange_unrealized_pnl) &&
    (!trade.exchange_synced_at || Date.now() - trade.exchange_synced_at < 120_000);

  if (!trade.is_open && typeof trade.exchange_realized_pnl === 'number' && Number.isFinite(trade.exchange_realized_pnl)) {
    const exactNet = Number(trade.exchange_realized_pnl.toFixed(4));
    trade.net_profit = exactNet;
    trade.gross_profit = Number((exactNet + trade.fee_total).toFixed(4));
    trade.net_profit_percent = Number(
      ((exactNet / Math.max(1e-8, trade.stake_amount)) * 100).toFixed(2)
    );
    trade.profit_ratio = Number((trade.net_profit_percent / 100).toFixed(4));
    trade.profit_pct = trade.net_profit_percent;
    trade.profit_abs = Number(exactNet.toFixed(4));
  } else if (trade.is_open) {
    // Для открытой сделки: нереализованный PnL (profit_abs и profit_pct) считается 1:1 как на бирже (по Mark Price без двойного вычета будущей комиссии закрытия),
    // а чистый PnL после всех комиссий хранится в trade.net_profit для защиты безубытка
    const rawUnrealized = hasFreshExchangeUnrealized
      ? Number(trade.exchange_unrealized_pnl!.toFixed(4))
      : Number(((trade.is_short ? openRate - refRate : refRate - openRate) * totalAmount).toFixed(4));
    const netAfterFees = Number((rawUnrealized - trade.fee_total).toFixed(4));
    trade.gross_profit = rawUnrealized;
    trade.net_profit = netAfterFees;
    trade.net_profit_percent = Number(
      ((netAfterFees / Math.max(1e-8, trade.stake_amount)) * 100).toFixed(2)
    );
    const exchangeRoiPct = Number(
      ((rawUnrealized / Math.max(1e-8, trade.stake_amount)) * 100).toFixed(2)
    );
    trade.profit_ratio = Number((exchangeRoiPct / 100).toFixed(4));
    trade.profit_pct = exchangeRoiPct;
    trade.profit_abs = Number(rawUnrealized.toFixed(4));
  } else {
    const grossProfit = (trade.is_short ? openRate - refRate : refRate - openRate) * totalAmount;
    const netProfit = grossProfit - trade.fee_total;
    trade.gross_profit = Number(grossProfit.toFixed(4));
    trade.net_profit = Number(netProfit.toFixed(4));
    trade.net_profit_percent = Number(
      ((netProfit / Math.max(1e-8, trade.stake_amount)) * 100).toFixed(2)
    );
    trade.profit_ratio = Number((trade.net_profit_percent / 100).toFixed(4));
    trade.profit_pct = trade.net_profit_percent;
    trade.profit_abs = Number(netProfit.toFixed(4));
  }

  const bankedProfitUsdt = Math.max(0, Number(trade.campaign_banked_profit || 0));
  if (bankedProfitUsdt > 0 || (trade.dca_count || 0) > 0) {
    const basketBe = calculateBasketConvergenceBreakeven({
      openRate,
      amount: totalAmount,
      isShort: trade.is_short,
      bankedProfitUsdt,
      feeOpenUsdt: trade.fee_open,
      feeRate: exchangeFeeRate,
      dcaCount: trade.dca_count || 0,
      stakeAmount: trade.stake_amount,
    });
    trade.breakeven_price = roundPrice(basketBe.exactZeroCyclePrice);
    trade.min_profitable_tp = roundPrice(
      (trade.dca_count || 0) >= 2 ? basketBe.unloadingFloorPrice : basketBe.targetCycleExitPrice
    );
  } else {
    const feeOpenPerCoin = trade.fee_open / totalAmount;
    const exactBreakeven = trade.is_short
      ? (openRate - feeOpenPerCoin) / (1 + exchangeFeeRate)
      : (openRate + feeOpenPerCoin) / (1 - exchangeFeeRate);
    trade.breakeven_price = roundPrice(exactBreakeven);

    const rawMinProfitableTp = trade.is_short
      ? exactBreakeven * (1 - MIN_NET_PROFIT_PRICE_BUFFER)
      : exactBreakeven * (1 + MIN_NET_PROFIT_PRICE_BUFFER);
    trade.min_profitable_tp = roundPrice(rawMinProfitableTp);
  }

  const tpMove = (trade.dca_count || 0) > 0 ? 0.018 : 0.024;

  // Проверяем, не переведена ли позиция в режим сопровождения импульса со стопом в БУ/плюс (Раздел 5Б / 5В / Сценарий 2)
  const hasActiveBounceTrailTp =
    trade.stop_loss_abs > 0 &&
    trade.take_profit_abs > 0 &&
    trade.min_profitable_tp > 0 &&
    (trade.is_short
      ? trade.stop_loss_abs <= trade.min_profitable_tp * 1.001 &&
        trade.take_profit_abs < trade.min_profitable_tp
      : trade.stop_loss_abs >= trade.min_profitable_tp * 0.999 &&
        trade.take_profit_abs > trade.min_profitable_tp);

  // Защита ручного TP: если пользователь сам перетащил TP (tp_manual_override === true), бот НИКОГДА не сбрасывает его в фоновых циклах!
  if (trade.tp_manual_override && trade.take_profit_abs > 0) {
    // Оставляем ровно тот TP, который выставил пользователь
  } else if (hasActiveBounceTrailTp) {
    // Сохраняем целевой тейк на продолжение отскока при защищённом стопе в БУ (Раздел 5Б / 5В / Сценарий 2)
  } else if (((trade.dca_count || 0) >= 1 || bankedProfitUsdt > 0) && trade.min_profitable_tp) {
    // После разворотного усреднения и/или фиксации страховочной ноги (Сценарий 3.4 и Раздел 5Б/5В)
    // подтягиваем рабочий TP к точке схлопывания корзины P_BE_cycle!
    trade.take_profit_abs = trade.min_profitable_tp;
  } else {
    const isTpBelowMinProfitable = trade.is_short
      ? (trade.take_profit_abs || 0) <= 0 || (trade.take_profit_abs || 0) > trade.min_profitable_tp
      : (trade.take_profit_abs || 0) <= 0 || (trade.take_profit_abs || 0) < trade.min_profitable_tp;

    if (resetLevels || !trade.take_profit_abs || trade.take_profit_abs <= 0) {
      const defaultTp = roundPrice(
        trade.is_short ? openRate * (1 - tpMove) : openRate * (1 + tpMove)
      );
      trade.take_profit_abs = trade.is_short
        ? Math.min(defaultTp, trade.min_profitable_tp)
        : Math.max(defaultTp, trade.min_profitable_tp);
    } else if (isTpBelowMinProfitable) {
      const structuralFloorTp = roundPrice(
        trade.is_short ? openRate * (1 - TP_MIN_DISTANCE_PCT / 100) : openRate * (1 + TP_MIN_DISTANCE_PCT / 100)
      );
      trade.take_profit_abs = trade.is_short
        ? Math.min(structuralFloorTp, trade.min_profitable_tp)
        : Math.max(structuralFloorTp, trade.min_profitable_tp);
    }
  }

  // Чистый ожидаемый профит на уровне TP (за вычетом всех комиссий 0.06% + накопленный банк кампании)
  const tpExitFee = trade.take_profit_abs * totalAmount * TAKER_FEE_RATE;
  const tpGross =
    (trade.is_short ? openRate - trade.take_profit_abs : trade.take_profit_abs - openRate) *
    totalAmount;
  const tpNet = tpGross - (trade.fee_open + tpExitFee) + bankedProfitUsdt;
  trade.take_profit_pct = Number(
    ((tpNet / Math.max(1e-8, trade.stake_amount)) * 100).toFixed(2)
  );

  if (!trade.sl_manual_override && !(trade.stop_loss_abs > 0)) {
    trade.stop_loss_abs = 0;
    trade.stop_loss_pct = 0;
  }
  trade.pullback_min_profit_pct = 3.0;
  if (trade.campaign_role === 'insurance') {
    trade.planned_dca_levels = [];
    trade.next_dca_price = undefined;
  } else if (Array.isArray(trade.planned_dca_levels) && trade.planned_dca_levels.length > 0) {
    const nextUnfilled = trade.planned_dca_levels.find((l) => !l.filled);
    trade.next_dca_price = nextUnfilled ? nextUnfilled.price : undefined;
  }
}

function resolvePostDcaTakeProfit(
  newAvgRate: number,
  isShort: boolean,
  mtf?: ReturnType<typeof analyzeMultiTimeframe> | null,
  safeMinProfitableTp?: number
): number {
  const safeFloor =
    safeMinProfitableTp && safeMinProfitableTp > 0
      ? roundPrice(safeMinProfitableTp)
      : roundPrice(
          isShort
            ? newAvgRate * (1 - MIN_NET_PROFIT_PRICE_BUFFER)
            : newAvgRate * (1 + MIN_NET_PROFIT_PRICE_BUFFER)
        );
  // Минимальная структурная дистанция TP после усреднения — минимум 1.5% от новой средней цены входа
  const minStructuralDist = 0.015;
  const fallbackTp = roundPrice(
    isShort
      ? Math.min(safeFloor * 0.994, newAvgRate * (1 - 0.018))
      : Math.max(safeFloor * 1.006, newAvgRate * (1 + 0.018))
  );
  if (!(newAvgRate > 0) || !mtf) return fallbackTp;

  if (!isShort) {
    const minTp = Math.max(safeFloor, newAvgRate * (1 + minStructuralDist));
    if (Number.isFinite(mtf.recommended_tp_long) && mtf.recommended_tp_long >= minTp) {
      return roundPrice(mtf.recommended_tp_long);
    }
    const scoredCandidates: Array<{ price: number; strength: number }> = [
      ...(mtf.chart_targets_long || []).map((c) => ({ price: c.price, strength: c.strength + 4 })),
      { price: mtf.key_4h_resistance * 0.998, strength: (mtf.resistance_history?.strength_score || 6) + 5 },
      ...(mtf.structural_4h_levels || [])
        .filter((l) => l.bounces >= 2 && l.bounces >= l.breaks)
        .map((l) => ({ price: l.price * 0.998, strength: l.strength_score + 3 })),
      ...(mtf.local_1d_levels || [])
        .filter((l) => l.bounces >= 2 || (l.consolidation_bars || 0) >= 3)
        .map((l) => ({ price: l.price * 0.998, strength: l.strength_score + 4 })),
      ...(mtf.institutional_levels || []).map((l) => ({ price: l.price * 0.998, strength: l.strength_score + 5 })),
    ].filter((c) => Number.isFinite(c.price) && c.price >= minTp && c.price <= newAvgRate * 1.18);

    scoredCandidates.sort((a, b) => {
      if (Math.abs(b.strength - a.strength) >= 2.0) return b.strength - a.strength;
      return a.price - b.price;
    });
    return scoredCandidates.length > 0 ? roundPrice(scoredCandidates[0].price) : fallbackTp;
  } else {
    const minTp = Math.min(safeFloor, newAvgRate * (1 - minStructuralDist));
    if (Number.isFinite(mtf.recommended_tp_short) && mtf.recommended_tp_short <= minTp) {
      return roundPrice(mtf.recommended_tp_short);
    }
    const scoredCandidates: Array<{ price: number; strength: number }> = [
      ...(mtf.chart_targets_short || []).map((c) => ({ price: c.price, strength: c.strength + 4 })),
      { price: mtf.key_4h_support * 1.002, strength: (mtf.support_history?.strength_score || 6) + 5 },
      ...(mtf.structural_4h_levels || [])
        .filter((l) => l.bounces >= 2 && l.bounces >= l.breaks)
        .map((l) => ({ price: l.price * 1.002, strength: l.strength_score + 3 })),
      ...(mtf.local_1d_levels || [])
        .filter((l) => l.bounces >= 2 || (l.consolidation_bars || 0) >= 3)
        .map((l) => ({ price: l.price * 1.002, strength: l.strength_score + 4 })),
      ...(mtf.institutional_levels || []).map((l) => ({ price: l.price * 1.002, strength: l.strength_score + 5 })),
    ].filter((c) => Number.isFinite(c.price) && c.price <= minTp && c.price >= newAvgRate * 0.82);

    scoredCandidates.sort((a, b) => {
      if (Math.abs(b.strength - a.strength) >= 2.0) return b.strength - a.strength;
      return b.price - a.price;
    });
    return scoredCandidates.length > 0 ? roundPrice(scoredCandidates[0].price) : fallbackTp;
  }
}

const botConfig = {
  version: '2026.9-ScalpBot',
  strategy_version: 'v2.6-MTF-DualStrategy',
  api_version: 2.34,
  dry_run: Boolean(scalpBotConfig.dry_run),
  runmode: scalpBotConfig.dry_run ? 'dry_run' : 'live',
  state: 'running' as 'running' | 'stopped' | 'paused',
  pause_new_entries: false,
  bot_name: 'ScalpBot',
  strategy: String(scalpBotConfig.strategy || 'ScalpingStrategy'),
  timeframe: String(scalpBotConfig.timeframe || '1h'),
  timeframe_ms: 3600000,
  exchange: 'binance',
  stake_currency: String(scalpBotConfig.stake_currency || 'USDT'),
  stake_amount: Number(scalpBotConfig.stake_amount || 25),
  stake_percent: Number(scalpBotConfig.stake_percent || 0.005),
  min_stake_amount: Number(scalpBotConfig.min_stake_amount || 5),
  leverage: Number(scalpBotConfig.leverage || 25),
  margin_mode: String(scalpBotConfig.margin_mode || 'cross'),
  max_open_trades: Number(scalpBotConfig.max_open_trades || 30),
  dca_enabled: Boolean(scalpBotConfig.dca_enabled ?? true),
  max_dca_orders: Number(scalpBotConfig.max_dca_orders ?? 2),
  dca_multiplier: 1.0,
  max_position_multiplier: Number(scalpBotConfig.max_position_multiplier || 6.0),
  min_liquidation_distance_pct: Number(scalpBotConfig.min_liquidation_distance_pct || 15.0),
  max_margin_used_for_dca_pct: Number(scalpBotConfig.max_margin_used_for_dca_pct || 60.0),
  max_pair_margin_pct: Number(scalpBotConfig.max_pair_margin_pct || 20.0),
  dca_scale_mode: 'linear',
  stoploss: Number(scalpBotConfig.stoploss ?? -1.0),
  trailing_stop: false,
  trailing_stop_positive: 0.02,
  trailing_stop_positive_offset: 0.035,
  minimal_roi: {
    '0': 0.08,
    '120': 0.05,
    '240': 0.035,
  },
  force_entry_enable: true,
  starting_balance: 0,
};

let blacklist: string[] = [
  'USDC/USDT:USDT',
  'TUSD/USDT:USDT',
  'FDUSD/USDT:USDT',
  'BUSD/USDT:USDT',
  'EUR/USDT:USDT',
];
let pairLocks: any[] = [];
const botLogs: Array<{
  timestamp: string;
  epoch: number;
  logger: string;
  level: string;
  message: string;
  userId?: string;
  publicMarket?: boolean;
}> = [];
const cooldownPairs = new Map<string, number>();
const dcaRiskSkipLogTs = new Map<number, number>();
let ownerManuallyStoppedBot = false;
const stoppedUsers = new Set<string>();
const pausedNewEntriesUsers = new Set<string>();

function isUserBotStopped(userId = 'owner'): boolean {
  const clean = String(userId || 'owner').trim() || 'owner';
  if (clean === 'owner') return ownerManuallyStoppedBot || stoppedUsers.has('owner');
  return stoppedUsers.has(clean);
}

function setUserBotStopped(userId = 'owner', stopped: boolean): void {
  const clean = String(userId || 'owner').trim() || 'owner';
  if (stopped) {
    stoppedUsers.add(clean);
  } else {
    stoppedUsers.delete(clean);
  }
  if (clean === 'owner') {
    ownerManuallyStoppedBot = stopped;
  }
}

function isUserNewEntriesPaused(userId = 'owner'): boolean {
  const clean = String(userId || 'owner').trim() || 'owner';
  if (clean === 'owner') return Boolean(botConfig.pause_new_entries) || pausedNewEntriesUsers.has('owner');
  return pausedNewEntriesUsers.has(clean);
}

function setUserNewEntriesPaused(userId = 'owner', paused: boolean): void {
  const clean = String(userId || 'owner').trim() || 'owner';
  if (paused) {
    pausedNewEntriesUsers.add(clean);
  } else {
    pausedNewEntriesUsers.delete(clean);
  }
  if (clean === 'owner') {
    botConfig.pause_new_entries = paused;
  }
}

function generateSecureClientAccessCode(exchange: string): string {
  return `${String(exchange || 'BYBIT').toUpperCase()}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
}

function appendLog(
  logger: string,
  level: 'INFO' | 'DEBUG' | 'WARNING' | 'ERROR',
  message: string,
  scope?: { userId?: string; publicMarket?: boolean }
) {
  const now = new Date();
  const formatted = now.toISOString().replace('T', ' ').slice(0, 19);
  const isDefaultPublic =
    scope?.publicMarket !== undefined
      ? scope.publicMarket
      : logger === 'freqtrade.scanner' || logger === 'freqtrade.worker';
  botLogs.push({
    timestamp: formatted,
    epoch: now.getTime(),
    logger,
    level,
    message,
    userId: scope?.userId,
    publicMarket: isDefaultPublic,
  });
  if (botLogs.length > 350) botLogs.shift();
}

let tradesStore: FreqtradeTrade[] = [];
const botLevelsStore = new Map<string, BotChartLevel[]>();

interface ChartDrawingPoint {
  timestamp: number;
  price: number;
}

interface ChartDrawingObject {
  id: string;
  pair: string;
  tool:
    | 'trendline'
    | 'ray'
    | 'hline'
    | 'channel'
    | 'fib'
    | 'rect'
    | 'long_rr'
    | 'short_rr'
    | 'text'
    | 'ruler';
  points: ChartDrawingPoint[];
  color: string;
  text?: string;
  locked?: boolean;
  user_id?: string;
  created_at: string;
}

const chartDrawingsStore = new Map<string, ChartDrawingObject[]>();

type SupportedExchange = 'binance' | 'bybit' | 'okx' | 'bitget' | 'bingx';

interface ExchangeAccountRecord {
  id: string;
  name: string;
  owner_label: string;
  exchange: SupportedExchange;
  market_type: 'futures' | 'spot';
  api_key_masked: string;
  has_passphrase?: boolean;
  is_owner: boolean;
  user_id: string;
  client_access_code: string;
  enabled: boolean;
  copy_trading: boolean;
  copy_multiplier: number;
  max_leverage: number;
  balance_usdt: number;
  wallet_balance_usdt?: number;
  equity_usdt?: number;
  available_balance_usdt?: number;
  used_margin_usdt?: number;
  initial_deposit_usdt?: number;
  unrealized_pnl: number;
  open_trades_count: number;
  status: 'connected' | 'paused' | 'error';
  last_sync: string;
  connected_at?: number;
  api_key_raw?: string;
  api_secret_raw?: string;
  passphrase_raw?: string;
  is_testnet?: boolean;
  network_label?: string;
}

function serializeAccountForClient(acc: ExchangeAccountRecord) {
  const { api_key_raw: _k, api_secret_raw: _s, passphrase_raw: _p, ...safe } = acc;
  return safe;
}

function hasConnectedExchangeAccount(userId?: string): boolean {
  if (userId) {
    return exchangeAccountsStore.some((a) => a.enabled && (a.user_id || 'owner') === userId);
  }
  return exchangeAccountsStore.some((a) => a.enabled);
}

/**
 * Определяет чистый стартовый депозит для реального счёта биржи:
 * если `rawBalance - closedNetProfit` находится вблизи круглого стартового депозита (например, 5000 USDT на Testnet),
 * фиксирует его, чтобы стартовый капитал не искажался при расчётах.
 */
function inferInitialDeposit(acc: ExchangeAccountRecord | undefined, rawBalance: number, closedNetProfit: number): number {
  if (acc?.initial_deposit_usdt && acc.initial_deposit_usdt > 0) {
    return acc.initial_deposit_usdt;
  }
  const diff = rawBalance - closedNetProfit;
  const roundBenchmarks = [100, 250, 500, 1000, 2000, 3000, 5000, 10000, 25000, 50000, 100000];
  for (const b of roundBenchmarks) {
    if (Math.abs(diff - b) <= b * 0.015 || (acc?.is_testnet && Math.abs(rawBalance - b) <= b * 0.03)) {
      return b;
    }
  }
  return Number(Math.max(10, diff).toFixed(2));
}

/**
 * Возвращает актуальный баланс аккаунта:
 * - Для реальных биржевых ключей (Bybit / Binance / OKX / Bitget / BingX): `acc.balance_usdt` синхронизируется напрямую с API биржи
 *   и УЖЕ включает в себя все закрытые сделки и списанные комиссии (1 в 1 как на счету биржи).
 * - Для тестовых симуляционных ключей (`test_...`): складывает стартовый депозит + накопленный чистый профит.
 */
function getCompoundedAccountBalance(accountId = 'master'): {
  baseDeposit: number;
  closedNetProfit: number;
  compoundedBalance: number;
} {
  if (accountId === 'master') {
    const ownerAccs = getMasterScopeOwnerAccounts();
    if (ownerAccs.length === 0) {
      return { baseDeposit: 0, closedNetProfit: 0, compoundedBalance: 0 };
    }
    const ownerAcc = ownerAccs[0];
    const closedNetProfit = tradesStore
      .filter((t) => !t.is_open && isTradeInMasterScope(t))
      .reduce((sum, t) => sum + (t.net_profit ?? t.profit_abs ?? 0), 0);

    if (ownerAccs.length > 1) {
      let sumWallet = 0;
      let sumBaseDep = 0;
      for (const a of ownerAccs) {
        const wBal = Number(a.wallet_balance_usdt ?? a.balance_usdt ?? 0);
        const targetId = getTargetAccountIdForRecord(a);
        const aClosed = tradesStore
          .filter((t) => !t.is_open && tradeMatchesAccount(t, a, targetId))
          .reduce((s, t) => s + (t.net_profit ?? t.profit_abs ?? 0), 0);
        sumWallet += wBal;
        const isReal = Boolean(a.api_key_raw && !isSimulatedTestApiKey(a.api_key_raw));
        sumBaseDep += isReal ? inferInitialDeposit(a, wBal, aClosed) : wBal;
      }
      const anySim = ownerAccs.some(
        (a) => !a.api_key_raw || isSimulatedTestApiKey(a.api_key_raw)
      );
      return {
        baseDeposit: Number(sumBaseDep.toFixed(2)),
        closedNetProfit: Number(closedNetProfit.toFixed(2)),
        compoundedBalance: Number(
          Math.max(0, anySim ? sumWallet + closedNetProfit : sumWallet).toFixed(2)
        ),
      };
    }

    const rawBalance = Number(
      ownerAcc?.wallet_balance_usdt ?? ownerAcc?.balance_usdt ?? botConfig.starting_balance ?? 0
    );
    const isRealExchangeAcc = Boolean(
      ownerAcc?.api_key_raw && !isSimulatedTestApiKey(ownerAcc.api_key_raw)
    );
    if (isRealExchangeAcc) {
      const baseDep = inferInitialDeposit(ownerAcc, rawBalance, closedNetProfit);
      return {
        baseDeposit: baseDep,
        closedNetProfit: Number(closedNetProfit.toFixed(2)),
        compoundedBalance: Number(Math.max(0, rawBalance).toFixed(2)),
      };
    }
    return {
      baseDeposit: rawBalance,
      closedNetProfit: Number(closedNetProfit.toFixed(2)),
      compoundedBalance: Number(Math.max(10, rawBalance + closedNetProfit).toFixed(2)),
    };
  }
  const targetAcc = exchangeAccountsStore.find((a) => a.id === accountId);
  if (!targetAcc) {
    return { baseDeposit: 0, closedNetProfit: 0, compoundedBalance: 0 };
  }
  const targetId = getTargetAccountIdForRecord(targetAcc);
  const rawBalance = Number(targetAcc.wallet_balance_usdt ?? targetAcc.balance_usdt ?? 1000);
  const closedNetProfit = tradesStore
    .filter((t) => !t.is_open && tradeMatchesAccount(t, targetAcc, targetId))
    .reduce((sum, t) => sum + (t.net_profit ?? t.profit_abs ?? 0), 0);
  const isRealAcc = Boolean(
    targetAcc.api_key_raw && !isSimulatedTestApiKey(targetAcc.api_key_raw)
  );
  if (isRealAcc) {
    const baseDep = inferInitialDeposit(targetAcc, rawBalance, closedNetProfit);
    return {
      baseDeposit: baseDep,
      closedNetProfit: Number(closedNetProfit.toFixed(2)),
      compoundedBalance: Number(Math.max(0, rawBalance).toFixed(2)),
    };
  }
  return {
    baseDeposit: rawBalance,
    closedNetProfit: Number(closedNetProfit.toFixed(2)),
    compoundedBalance: Number(Math.max(10, rawBalance + closedNetProfit).toFixed(2)),
  };
}

function maskApiKey(rawKey: string): string {
  const clean = String(rawKey || '').trim();
  if (clean.length <= 8) return '••••••••' + clean.slice(-2);
  return `${clean.slice(0, 4)}••••••••${clean.slice(-4)}`;
}

// Чистая база API-аккаунтов, синхронизированная с trades.sqlite
let exchangeAccountsStore: ExchangeAccountRecord[] = [];

let nextTradeId = 1;
let initializedTrades = false;

/**
 * Computes or loads MTF & Timeframe-specific Support/Resistance levels for a pair.
 * Respects any manual drags or additions saved by the user in trades.sqlite, while dynamically
 * computing Support & Resistance for the active timeframe (1m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d, 1w).
 */
async function getOrComputeMtfBotLevels(
  pair: string,
  timeframe = '1h',
  forceRefresh = false,
  userId = 'owner'
): Promise<BotChartLevel[]> {
  const cleanPair = pair.toUpperCase();
  const normTf = String(timeframe || '1h').trim().toLowerCase();
  const cleanUser = String(userId || 'owner').trim() || 'owner';
  const storeKey = cleanUser === 'owner' ? `${cleanPair}_${normTf}` : `${cleanUser}::${cleanPair}_${normTf}`;
  const pairStoreKey = cleanUser === 'owner' ? cleanPair : `${cleanUser}::${cleanPair}`;

  if (!forceRefresh && botLevelsStore.has(storeKey)) {
    return botLevelsStore.get(storeKey)!;
  }

  // Load all persisted levels for this pair & user (including deleted flag so deleted auto-levels are never recreated)
  const allForPair = sqliteDb.getAllBotLevelsForPairIncludeDeleted(cleanPair, cleanUser);

  // All manual levels configured or dragged by the user on this pair apply across all timeframes and bot cycles
  const manualLevels = allForPair.filter((l) => l.manual_override && !l.deleted);
  const hasManualGlobalSupport = manualLevels.some(
    (l) => l.id.startsWith('tf-sup-') || l.id.startsWith('mtf-sup-')
  );
  const hasManualGlobalResistance = manualLevels.some(
    (l) => l.id.startsWith('tf-res-') || l.id.startsWith('mtf-res-')
  );

  try {
    // Top-Down 1W (Macro) -> 1D (Refinement & Local) -> 4H/1H (Structural points only)
    const [{ candles: c1w }, { candles: c1d }, { candles: c4h }, { candles: tfCandles }] =
      await Promise.all([
        fetchRealCandles(cleanPair, '1w', 300),
        fetchRealCandles(cleanPair, '1d', 1000),
        fetchRealCandles(cleanPair, '4h', 1000),
        normTf === '4h' || normTf === '1d' || normTf === '1w'
          ? Promise.resolve({ candles: [] as RawCandle[] })
          : fetchRealCandles(cleanPair, normTf, 500),
      ]);

    const activeCandles =
      normTf === '1w'
        ? c1w
        : normTf === '1d'
        ? c1d
        : normTf === '4h'
        ? c4h
        : tfCandles.length > 0
        ? tfCandles
        : c4h;

    const liveRefPrice =
      tickerCache.get(cleanPair)?.price ||
      (activeCandles.length > 0 ? activeCandles[activeCandles.length - 1].close : 0) ||
      (c1d.length > 0 ? c1d[c1d.length - 1].close : 0);

    const mtf = analyzeMultiTimeframe(
      cleanPair,
      normTf === '1d' || normTf === '1w' ? c4h : activeCandles,
      c4h,
      c1d,
      undefined,
      c1w
    );

    const globalSup = mtf.key_4h_support;
    const globalRes = mtf.key_4h_resistance;
    const sh = mtf.support_history;
    const rh = mtf.resistance_history;

    const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const generated: BotChartLevel[] = [...manualLevels];

    const supId = `tf-sup-${cleanPair}-${normTf}`;
    const resId = `tf-res-${cleanPair}-${normTf}`;

    const savedSup = allForPair.find(
      (l) => l.id === supId || (l.id === `mtf-sup-${cleanPair}` && normTf === '4h')
    );
    const savedRes = allForPair.find(
      (l) => l.id === resId || (l.id === `mtf-res-${cleanPair}` && normTf === '4h')
    );

    const globalTag = sh?.refined_from_1w || rh?.refined_from_1w ? '1W/1D GLOBAL' : '1D GLOBAL';

    const buildBadgeStats = (
      hist: ReturnType<typeof analyzeMultiTimeframe>['support_history'] | undefined
    ) => {
      if (!hist) return '';
      const scoreTxt = ` ${hist.strength_score.toFixed(1)}★`;
      const mirrorTxt = hist.mirror_retests && hist.mirror_retests > 0 ? ' ⇄S/R' : '';
      return `${scoreTxt}${mirrorTxt}`;
    };

    const syncAutoLevel = (
      lvl: BotChartLevel,
      savedRow?: (typeof allForPair)[number]
    ) => {
      generated.push(lvl);
      const priceChanged =
        !savedRow ||
        Math.abs(savedRow.price - lvl.price) / Math.max(1e-8, lvl.price) > 0.0005;
      const metaChanged =
        !savedRow || savedRow.label !== lvl.label || savedRow.source !== lvl.source;
      if (priceChanged || metaChanged) {
        sqliteDb.upsertBotLevel({ ...lvl, deleted: false }, cleanUser);
      }
    };

    if (!hasManualGlobalSupport && !savedSup?.deleted) {
      if (globalSup > 0) {
        const lvl: BotChartLevel = {
          id: savedSup?.id || supId,
          pair: cleanPair,
          label: `${globalTag} SUP${buildBadgeStats(sh)}`,
          role: 'support',
          price: roundPrice(globalSup),
          touches: sh?.touches || 3,
          bounces: sh?.bounces || 3,
          breaks: sh?.breaks || 0,
          strength_score: sh?.strength_score || 5.0,
          source: globalTag,
          manual_override: false,
          updated_at: nowStr,
          zone_low: sh?.zone_low ? roundPrice(sh.zone_low) : undefined,
          zone_high: sh?.zone_high ? roundPrice(sh.zone_high) : undefined,
          mirror_retests: sh?.mirror_retests || 0,
          false_breakouts: sh?.false_breakouts || 0,
          consolidation_bars: sh?.consolidation_bars || 0,
          timeframe_role: 'GLOBAL_1W_1D',
        };
        syncAutoLevel(lvl, savedSup);
      } else if (savedSup && !savedSup.deleted) {
        if (!generated.some((g) => g.id === savedSup.id)) generated.push(savedSup);
      }
    }

    if (!hasManualGlobalResistance && !savedRes?.deleted) {
      if (globalRes > 0) {
        const lvl: BotChartLevel = {
          id: savedRes?.id || resId,
          pair: cleanPair,
          label: `${globalTag} RES${buildBadgeStats(rh)}`,
          role: 'resistance',
          price: roundPrice(globalRes),
          touches: rh?.touches || 3,
          bounces: rh?.bounces || 3,
          breaks: rh?.breaks || 0,
          strength_score: rh?.strength_score || 5.0,
          source: globalTag,
          manual_override: false,
          updated_at: nowStr,
          zone_low: rh?.zone_low ? roundPrice(rh.zone_low) : undefined,
          zone_high: rh?.zone_high ? roundPrice(rh.zone_high) : undefined,
          mirror_retests: rh?.mirror_retests || 0,
          false_breakouts: rh?.false_breakouts || 0,
          consolidation_bars: rh?.consolidation_bars || 0,
          timeframe_role: 'GLOBAL_1W_1D',
        };
        syncAutoLevel(lvl, savedRes);
      } else if (savedRes && !savedRes.deleted) {
        if (!generated.some((g) => g.id === savedRes.id)) generated.push(savedRes);
      }
    }

    const isFarFromExisting = (p: number, minDistPct: number) =>
      generated.every(
        (existing) =>
          (Math.abs(existing.price - p) / Math.max(1e-8, existing.price)) * 100 >= minDistPct
      );

    // Раздел 2А Регламента («Фильтр: Локальные уровни младших таймфреймов внутри текущего дня полностью игнорируются»):
    // На дневном (1D) и недельном (1W) графике отображаем СТРОГО 2 главных уровня (1 глобальная поддержка SUP и 1 глобальное сопротивление RES).
    // Дополнительные структурные уровни разрешены ТОЛЬКО со старших таймфреймов (>= 4H: 4h, 6h, 12h), а мелкие внутридневные уровни (15m, 30m, 1h, 2h) полностью игнорируются!
    const isHtfStructuralAllowed = normTf === '4h' || normTf === '6h' || normTf === '12h';
    if (isHtfStructuralAllowed && activeCandles.length >= 30 && liveRefPrice > 0) {
      const tfStrong = extractStrongTimeframeLevels(activeCandles, normTf, liveRefPrice, 1);
      const tfLabelPrefix = normTf.toUpperCase();
      const minSepForTf = 4.0;

      const tfBestSup = tfStrong.supports[0];
      if (tfBestSup && isFarFromExisting(roundPrice(tfBestSup.price), minSepForTf)) {
        const tfSupId = `tf-own-sup-${cleanPair}-${normTf}`;
        const savedTfSup = allForPair.find((l) => l.id === tfSupId);
        if (!savedTfSup?.deleted && !savedTfSup?.manual_override) {
          const mirrorTxt = tfBestSup.mirror_retests && tfBestSup.mirror_retests > 0 ? ' ⇄S/R' : '';
          const lvl: BotChartLevel = {
            id: tfSupId,
            pair: cleanPair,
            label: `${tfLabelPrefix} SUP ${tfBestSup.strength_score.toFixed(1)}★${mirrorTxt}`,
            role: 'support',
            price: roundPrice(tfBestSup.price),
            touches: tfBestSup.touches,
            bounces: tfBestSup.bounces,
            breaks: tfBestSup.breaks,
            strength_score: tfBestSup.strength_score,
            source: `${tfLabelPrefix}_STRONG`,
            manual_override: false,
            updated_at: nowStr,
            zone_low: tfBestSup.zone_low ? roundPrice(tfBestSup.zone_low) : undefined,
            zone_high: tfBestSup.zone_high ? roundPrice(tfBestSup.zone_high) : undefined,
            mirror_retests: tfBestSup.mirror_retests || 0,
            false_breakouts: tfBestSup.false_breakouts || 0,
            consolidation_bars: tfBestSup.consolidation_bars || 0,
            timeframe_role: 'STRUCT_4H',
          };
          syncAutoLevel(lvl, savedTfSup);
        }
      }

      const tfBestRes = tfStrong.resistances[0];
      if (tfBestRes && isFarFromExisting(roundPrice(tfBestRes.price), minSepForTf)) {
        const tfResId = `tf-own-res-${cleanPair}-${normTf}`;
        const savedTfRes = allForPair.find((l) => l.id === tfResId);
        if (!savedTfRes?.deleted && !savedTfRes?.manual_override) {
          const mirrorTxt = tfBestRes.mirror_retests && tfBestRes.mirror_retests > 0 ? ' ⇄S/R' : '';
          const lvl: BotChartLevel = {
            id: tfResId,
            pair: cleanPair,
            label: `${tfLabelPrefix} RES ${tfBestRes.strength_score.toFixed(1)}★${mirrorTxt}`,
            role: 'resistance',
            price: roundPrice(tfBestRes.price),
            touches: tfBestRes.touches,
            bounces: tfBestRes.bounces,
            breaks: tfBestRes.breaks,
            strength_score: tfBestRes.strength_score,
            source: `${tfLabelPrefix}_STRONG`,
            manual_override: false,
            updated_at: nowStr,
            zone_low: tfBestRes.zone_low ? roundPrice(tfBestRes.zone_low) : undefined,
            zone_high: tfBestRes.zone_high ? roundPrice(tfBestRes.zone_high) : undefined,
            mirror_retests: tfBestRes.mirror_retests || 0,
            false_breakouts: tfBestRes.false_breakouts || 0,
            consolidation_bars: tfBestRes.consolidation_bars || 0,
            timeframe_role: 'STRUCT_4H',
          };
          syncAutoLevel(lvl, savedTfRes);
        }
      }
    }

    generated.sort((a, b) => b.price - a.price);
    botLevelsStore.set(storeKey, generated);
    botLevelsStore.set(pairStoreKey, generated);
    return generated;
  } catch {
    return manualLevels;
  }
}

async function initializeBotTrades() {
  if (initializedTrades) return;
  initializedTrades = true;

  // 1. Загружаем сохраненные биржевые аккаунты и все сделки (открытые, усредненные, закрытые) из trades.sqlite
  const rawTrades = sqliteDb.loadAllTrades();
  exchangeAccountsStore = sqliteDb.loadExchangeAccounts();

  // Deduplicate any duplicate test accounts strictly within the same user_id, and upgrade legacy short client_access_code
  const uniqueAccounts: ExchangeAccountRecord[] = [];
  const seenAccKeys = new Set<string>();
  for (const acc of exchangeAccountsStore) {
    const accUser = acc.user_id || 'owner';
    if (
      !acc.client_access_code ||
      (acc.client_access_code.length < 12 &&
        acc.client_access_code !== 'BYBIT-ENV1' &&
        acc.client_access_code !== 'BINANCE-ENV1')
    ) {
      acc.client_access_code = generateSecureClientAccessCode(acc.exchange);
      sqliteDb.upsertExchangeAccount(acc);
    }
    const key = `${accUser}::${acc.api_key_raw || acc.client_access_code || ''}::${acc.name.toLowerCase()}::${acc.exchange}`;
    if (seenAccKeys.has(key)) {
      sqliteDb.deleteExchangeAccount(acc.id);
    } else {
      seenAccKeys.add(key);
      uniqueAccounts.push(acc);
    }
  }
  exchangeAccountsStore = uniqueAccounts;
  const validAccIds = new Set(exchangeAccountsStore.map((a) => a.id));

  // 2. Подтягиваем актуальные рыночные котировки до пересчета сделок (если сеть временно недоступна — используем сохраненный current_rate из БД)
  await fetchAllMarketPairs().catch(() => {});

  // 3. Восстанавливаем все сделки бота без потерь, НО удаляем чужие старые исторические сделки (до подключения API или EXCHANGE_HISTORY)!
  const hasActiveExchange = exchangeAccountsStore.some((a) => a.enabled);
  const ownerConnectedAt =
    exchangeAccountsStore
      .filter((a) => a.is_owner && a.connected_at && a.connected_at > 0)
      .reduce((minTs, a) => (minTs === 0 ? a.connected_at! : Math.min(minTs, a.connected_at!)), 0) ||
    exchangeAccountsStore
      .filter((a) => a.enabled && a.connected_at && a.connected_at > 0)
      .reduce((minTs, a) => (minTs === 0 ? a.connected_at! : Math.min(minTs, a.connected_at!)), 0);
  const accConnectedById = new Map<string, number>(
    exchangeAccountsStore.map((a) => [a.id, a.connected_at || 0])
  );

  const seenOpenKeys = new Set<string>();
  const cleanTrades: FreqtradeTrade[] = [];
  // Sort ascending by trade_id so we keep the original trade #1 first
  const sortedAsc = [...rawTrades].sort((a, b) => a.trade_id - b.trade_id);
  const activeExchangeSet = new Set(exchangeAccountsStore.map((a) => a.exchange));
  for (const t of sortedAsc) {
    const accId = t.account_id || 'master';
    const isOrphanClient = accId !== 'master' && exchangeAccountsStore.length > 0 && !validAccIds.has(accId);
    const matchingOwnerOrAcc =
      accId === 'master'
        ? exchangeAccountsStore.find((a) => a.is_owner) || exchangeAccountsStore[0]
        : exchangeAccountsStore.find((a) => a.id === accId);
    const isSimOrderTrade =
      Array.isArray(t.orders) &&
      t.orders.some((o: any) => String(o?.id || '').startsWith('sim-'));
    const hasSimOwner = Boolean(
      matchingOwnerOrAcc && isSimulatedTestApiKey(matchingOwnerOrAcc.api_key_raw)
    );
    const isStaleSimTrade = isSimOrderTrade && !hasSimOwner;
    const isOrphanExchangeTrade =
      exchangeAccountsStore.length > 0 && !activeExchangeSet.has(t.exchange);
    const isFakeTestRate =
      t.pair === 'ETH/USDT:USDT' && t.open_rate === 2500 && exchangeAccountsStore.length === 0;
    const accConnTs = accId === 'master' ? ownerConnectedAt : accConnectedById.get(accId) || 0;
    const closedTs = t.close_timestamp || 0;
    const isBeforeApiConnection =
      !t.is_open &&
      accConnTs > 0 &&
      closedTs > 0 &&
      closedTs < accConnTs - 1000;
    const isForeignHistoricalTrade =
      !t.is_open &&
      (t.enter_tag === 'EXCHANGE_HISTORY' ||
        t.exit_reason === 'exchange_closed_pnl' ||
        isBeforeApiConnection);
    if (isOrphanClient || isStaleSimTrade || isOrphanExchangeTrade || isFakeTestRate || isForeignHistoricalTrade) {
      sqliteDb.deleteTrade(t.trade_id);
      continue;
    }
    if (t.is_open) {
      const openKey = `${accId}::${t.pair}::${t.is_short ? 'short' : 'long'}`;
      if (seenOpenKeys.has(openKey)) {
        sqliteDb.deleteTrade(t.trade_id);
        continue;
      }
      seenOpenKeys.add(openKey);

      // Обновляем текущую цену из живого кэша котировок (или сохраняем последний известный current_rate из trades.sqlite)
      const liveRefPrice = getTradeReferencePrice(t);
      if (liveRefPrice > 0) {
        t.current_rate = liveRefPrice;
      }
    }
    recalculateTradeMetrics(t, false);
    cleanTrades.unshift(t);
  }

  for (const t of cleanTrades) {
    const acc = t.account_id && t.account_id !== 'master'
      ? exchangeAccountsStore.find((a) => a.id === t.account_id)
      : resolveExchangeAccountRecord('master');
    if (acc && (!t.user_id || t.user_id === 'owner') && (acc.user_id || 'owner') !== 'owner') {
      t.user_id = acc.user_id;
    }
    if (!t.user_id) t.user_id = 'owner';
    sqliteDb.upsertTrade(t);
  }

  tradesStore = cleanTrades;
  for (const t of tradesStore) {
    if (t.is_open && t.pair) {
      subscribePairKlineStream(t.pair, t.timeframe || '1h');
      const tpDistRatio =
        t.open_rate > 0 && t.take_profit_abs > 0
          ? Math.abs(t.take_profit_abs - t.open_rate) / t.open_rate
          : 0;
      if (t.campaign_role === 'insurance') {
        t.planned_dca_levels = [];
        t.next_dca_price = undefined;
      } else if (Array.isArray(t.planned_dca_levels) && t.planned_dca_levels.length > 0) {
        const nextUnfilled = t.planned_dca_levels.find((l) => !l.filled);
        t.next_dca_price = nextUnfilled ? nextUnfilled.price : undefined;
      }
      const needsMtfRefresh = !t.tp_manual_override && tpDistRatio < TP_MIN_DISTANCE_PCT / 100;
      if (needsMtfRefresh) {
        const acc =
          t.account_id && t.account_id !== 'master'
            ? exchangeAccountsStore.find((a) => a.id === t.account_id)
            : resolveExchangeAccountRecord('master');
        const creds = acc ? getAccountCredentialsFromStore(acc) : null;
        if (acc && creds) {
          void enrichImportedPositionMtfLevelsAsync(
            t.trade_id,
            acc,
            {
              pair: t.pair,
              is_short: t.is_short,
              entry_price: t.open_rate,
              take_profit: t.tp_manual_override ? t.take_profit_abs : 0,
            },
            creds
          );
        }
      }
    }
  }

  // Строгое правило: без подключенного биржевого аккаунта бот остановлен (но все существующие сделки в БД сохранены)
  botConfig.state = hasActiveExchange && !ownerManuallyStoppedBot ? 'running' : 'stopped';

  const maxExistingId = tradesStore.reduce((m, t) => Math.max(m, t.trade_id || 0), 0);
  nextTradeId = maxExistingId + 1;

  const openMasterCount = tradesStore.filter(
    (t) => t.is_open && resolveTradeUserId(t) === 'owner'
  ).length;
  const averagedMasterCount = tradesStore.filter(
    (t) => t.is_open && resolveTradeUserId(t) === 'owner' && (t.dca_count || 0) > 0
  ).length;
  const totalDcaStepsRestored = tradesStore
    .filter((t) => t.is_open && resolveTradeUserId(t) === 'owner')
    .reduce((sum, t) => sum + (t.dca_count || 0), 0);

  appendLog(
    'freqtrade.worker',
    hasActiveExchange ? 'INFO' : 'WARNING',
    hasActiveExchange
      ? `Starting ScalpBot (${botConfig.version}) | Strategy: ${botConfig.strategy} (${botConfig.timeframe}) | Leverage: ${botConfig.leverage}x ${botConfig.margin_mode} | Active Exchanges: ${exchangeAccountsStore.filter((a) => a.enabled).length}`
      : `ScalpBot ожидает подключения биржи (state: STOPPED). Подключите API-ключи во вкладке «API / Биржи» для запуска анализа и торговли.`,
    { publicMarket: true }
  );
  appendLog(
    'freqtrade.database',
    'INFO',
    `🔄 Восстановлено состояние из trades.sqlite после старта/перезапуска: открытых сделок владельца=${openMasterCount} (из них усреднённых=${averagedMasterCount}, шагов DCA=${totalDcaStepsRestored}), всего сделок в памяти=${tradesStore.length}, аккаунтов=${exchangeAccountsStore.length}`,
    { userId: 'owner' }
  );

  if (hasActiveExchange) {
    syncRealExchangeBalancesIfNeeded(true).catch(() => {});
    for (const acc of exchangeAccountsStore) {
      if (!acc.enabled) continue;
      const creds = getAccountCredentialsFromStore(acc);
      if (creds && !isSimulatedTestApiKey(creds.apiKey)) {
        prewarmExchangeAccountCaches(creds).catch(() => {});
      }
    }
  }
}

let lastExchangeBalanceSyncTs = 0;
const accInitialPosSynced = new Set<string>();
const lastExchangeTpEnsureByTrade = new Map<number, { tp: number; ts: number }>();
const missingFromExchangeCountByTrade = new Map<number, { count: number; firstMissingAt: number }>();

function isOwnerAccountRecord(acc: ExchangeAccountRecord | undefined): boolean {
  if (!acc) return false;
  return (acc.user_id || 'owner') === 'owner';
}

function getMasterScopeOwnerAccounts(): ExchangeAccountRecord[] {
  return exchangeAccountsStore.filter((a) => a.enabled && (a.user_id || 'owner') === 'owner');
}

function resolveExchangeAccountRecord(
  accOrId: ExchangeAccountRecord | string | undefined
): ExchangeAccountRecord | undefined {
  if (!accOrId) return undefined;
  if (typeof accOrId !== 'string') return accOrId;
  if (accOrId === 'master') {
    const ownerPool = exchangeAccountsStore.filter((a) => (a.user_id || 'owner') === 'owner');
    const activeOwner = ownerPool.filter((a) => a.enabled);
    return (
      activeOwner.find((a) => a.is_owner) ||
      activeOwner[0] ||
      ownerPool.find((a) => a.is_owner) ||
      ownerPool[0]
    );
  }
  return exchangeAccountsStore.find((a) => a.id === accOrId);
}

function getTargetAccountIdForRecord(acc: ExchangeAccountRecord): string {
  if ((acc.user_id || 'owner') !== 'owner') {
    return acc.id;
  }
  const primary = resolveExchangeAccountRecord('master');
  if (primary && primary.id === acc.id) return 'master';
  return acc.id;
}

function resolveTradeUserId(t: FreqtradeTrade): string {
  if (t.user_id && t.user_id !== 'owner') return t.user_id;
  if (t.account_id && t.account_id !== 'master') {
    const acc = exchangeAccountsStore.find((a) => a.id === t.account_id);
    if (acc?.user_id) return acc.user_id;
  }
  return t.user_id || 'owner';
}

function isTradeInMasterScope(t: FreqtradeTrade): boolean {
  return resolveTradeUserId(t) === 'owner';
}

function tradeMatchesAccount(
  t: FreqtradeTrade,
  acc: ExchangeAccountRecord,
  targetAccountId: string
): boolean {
  if ((acc.user_id || 'owner') !== resolveTradeUserId(t)) return false;
  if (targetAccountId === 'master') {
    return (
      ((!t.account_id || t.account_id === 'master') && t.exchange === acc.exchange) ||
      t.account_id === acc.id
    );
  }
  return t.account_id === targetAccountId || t.account_id === acc.id;
}

function getAccountCredentialsFromStore(
  accOrId: ExchangeAccountRecord | string | undefined
) {
  const acc = resolveExchangeAccountRecord(accOrId);
  if (!acc) return null;
  let key = acc.api_key_raw;
  let secret = acc.api_secret_raw;
  let pass = acc.passphrase_raw;
  if (!key || !secret) {
    const dbAccs = sqliteDb.loadExchangeAccounts();
    const found = dbAccs.find((a) => a.id === acc.id);
    if (found) {
      key = found.api_key_raw;
      secret = found.api_secret_raw;
      pass = found.passphrase_raw;
      acc.api_key_raw = key;
      acc.api_secret_raw = secret;
      acc.passphrase_raw = pass;
    }
  }
  if (!key || !secret) return null;
  return {
    exchange: acc.exchange,
    apiKey: String(key).trim(),
    apiSecret: String(secret).trim(),
    passphrase: pass ? String(pass).trim() : undefined,
    isTestnet: Boolean(acc.is_testnet),
  };
}

const activePositionOpLocks = new Map<string, Promise<any>>();
const activePositionKeys = new Set<string>();

function getPosLockKey(accountId: string, pair: string, isShort: boolean): string {
  return `${accountId || 'master'}::${pair.toUpperCase()}::${isShort ? 'short' : 'long'}`;
}

async function withPositionLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = activePositionOpLocks.get(key) || Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = prev.catch(() => {}).then(() => gate);
  activePositionOpLocks.set(key, chained);
  await prev.catch(() => {});
  activePositionKeys.add(key);
  try {
    return await fn();
  } finally {
    activePositionKeys.delete(key);
    release();
    if (activePositionOpLocks.get(key) === chained) {
      activePositionOpLocks.delete(key);
    }
  }
}

async function dispatchOrderToExchangeAccount(
  accOrId: ExchangeAccountRecord | string | undefined,
  params: ExchangeOrderParams
): Promise<PlacedOrderResult | null> {
  const acc = resolveExchangeAccountRecord(accOrId);
  const creds = getAccountCredentialsFromStore(acc);
  if (!acc || !creds) return null;

  const orderRes = await executeExchangeFuturesOrder(creds, params);
  if (!orderRes.is_simulated_test) {
    const netTag =
      orderRes.network_label ||
      (acc.is_testnet ? `${acc.exchange.toUpperCase()} TESTNET` : acc.exchange.toUpperCase());
    if (orderRes.success) {
      appendLog(
        `freqtrade.exchange.${acc.exchange}`,
        'INFO',
        `✅ [${netTag} LIVE ORDER] Исполнен ордер на бирже (${acc.name}): ${params.action} [${params.pair}] ${orderRes.side} ${orderRes.qty} @ ${orderRes.price}$ (комиссия: ${orderRes.commission_usdt ?? 0}$) | OrderID: ${orderRes.order_id}`,
        { userId: acc.user_id || 'owner' }
      );
      // При OPEN синхронизацию запускает сам createScalpBotPosition ПОСЛЕ записи сделки в БД, чтобы исключить гонку и дубли
      if (params.action !== 'OPEN') {
        syncRealExchangeBalancesIfNeeded(true).catch(() => {});
      }
    } else {
      appendLog(
        `freqtrade.exchange.${acc.exchange}`,
        'ERROR',
        `❌ [${netTag} ORDER REJECTED] Биржа отклонила ордер (${acc.name}) при ${params.action} [${params.pair}]: ${orderRes.error || 'Неизвестная ошибка биржи'}`,
        { userId: acc.user_id || 'owner' }
      );
    }
  }
  return orderRes;
}

const dismissedExchangeSyncKeys = new Set<string>();

function reconcileExchangeAccountOpenDuplicates(targetAccountId: string): void {
  const grouped = new Map<string, FreqtradeTrade[]>();
  for (const t of tradesStore) {
    if (!t.is_open) continue;
    const tAcc = t.account_id || 'master';
    if (tAcc !== targetAccountId) continue;
    const key = `${t.exchange}::${t.pair}::${t.is_short ? 'short' : 'long'}`;
    const arr = grouped.get(key) || [];
    arr.push(t);
    grouped.set(key, arr);
  }
  const dupIdsToRemove = new Set<number>();
  for (const list of grouped.values()) {
    if (list.length <= 1) continue;
    // Оставляем приоритетную запись (бот-управляемую, с наибольшим числом ордеров или самым ранним ID), дубли удаляем сразу в рантайме
    const sorted = [...list].sort((a, b) => {
      const aSync = a.enter_tag === 'EXCHANGE_SYNC_LIVE' ? 1 : 0;
      const bSync = b.enter_tag === 'EXCHANGE_SYNC_LIVE' ? 1 : 0;
      if (aSync !== bSync) return aSync - bSync;
      const aOrd = a.orders?.length || 0;
      const bOrd = b.orders?.length || 0;
      if (aOrd !== bOrd) return bOrd - aOrd;
      return a.trade_id - b.trade_id;
    });
    const keep = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      const dup = sorted[i];
      if (!keep.campaign_id && dup.campaign_id) keep.campaign_id = dup.campaign_id;
      if (!keep.tp_manual_override && dup.tp_manual_override && dup.take_profit_abs > 0) {
        keep.take_profit_abs = dup.take_profit_abs;
        keep.tp_manual_override = true;
      }
      dupIdsToRemove.add(dup.trade_id);
      sqliteDb.deleteTrade(dup.trade_id);
    }
    sqliteDb.upsertTrade(keep);
  }
  if (dupIdsToRemove.size > 0) {
    tradesStore = tradesStore.filter((t) => !dupIdsToRemove.has(t.trade_id));
    appendLog(
      'freqtrade.exchange.sync',
      'WARNING',
      `🧹 Устранены дубли односторонних позиций (${dupIdsToRemove.size} шт.) для синхронизации 1:1 с биржей.`
    );
  }
}

async function enrichImportedPositionMtfLevelsAsync(
  tradeId: number,
  acc: ExchangeAccountRecord,
  pos: {
    pair: string;
    is_short: boolean;
    entry_price: number;
    take_profit?: number;
  },
  creds: NonNullable<ReturnType<typeof getAccountCredentialsFromStore>>
): Promise<void> {
  try {
    const [{ candles: c1w }, { candles: c1d }, { candles: c4h }, { candles: c1h }] =
      await Promise.all([
        fetchRealCandles(pos.pair, '1w', 300),
        fetchRealCandles(pos.pair, '1d', 1000),
        fetchRealCandles(pos.pair, '4h', 1000),
        fetchRealCandles(pos.pair, '1h', 200),
      ]);
    const refreshedLvls = await getOrComputeMtfBotLevels(
      pos.pair,
      botConfig.timeframe,
      true,
      acc.user_id || 'owner'
    ).catch(() => [] as BotChartLevel[]);

    const liveTrade = tradesStore.find((t) => t.trade_id === tradeId && t.is_open);
    if (!liveTrade) return;

    const entryRate = liveTrade.open_rate;
    const lev = liveTrade.leverage || acc.max_leverage || 25;
    const stakeUsdt = liveTrade.stake_amount || 25;
    const posTp = Number(pos.take_profit || 0);

    const manualSup = refreshedLvls.find(
      (l) =>
        l.role === 'support' &&
        l.manual_override &&
        !l.id.startsWith('lvl-') &&
        l.price < entryRate
    );
    const manualRes = refreshedLvls.find(
      (l) =>
        l.role === 'resistance' &&
        l.manual_override &&
        !l.id.startsWith('lvl-') &&
        l.price > entryRate
    );
    const manualDcaSup =
      manualSup && (entryRate - manualSup.price) / Math.max(1e-8, entryRate) >= 0.028
        ? manualSup
        : undefined;
    const manualDcaRes =
      manualRes && (manualRes.price - entryRate) / Math.max(1e-8, entryRate) >= 0.028
        ? manualRes
        : undefined;
    const hasManualSup = Boolean(manualDcaSup);
    const hasManualRes = Boolean(manualDcaRes);

    if (c4h.length >= 20) {
      const mtf = analyzeMultiTimeframe(pos.pair, c1h, c4h, c1d, undefined, c1w);
      liveTrade.support_level = manualSup ? roundPrice(manualSup.price) : roundPrice(mtf.key_4h_support);
      liveTrade.resistance_level = manualRes ? roundPrice(manualRes.price) : roundPrice(mtf.key_4h_resistance);

      const posTpTooClose =
        posTp > 0 && Math.abs(posTp - entryRate) / Math.max(1e-8, entryRate) < TP_MIN_DISTANCE_PCT / 100;
      const shouldUpdateAutoTp = !liveTrade.tp_manual_override && (!(posTp > 0) || posTpTooClose);
      if (shouldUpdateAutoTp) {
        // Тот же тейк, что и для новых позиций: 1.25 ATR(4H) или ближайший уровень − 0.35 ATR, не ближе 0.8%
        const importedTp = computeTakeProfitTarget({
          entry: entryRate,
          isShort: liveTrade.is_short,
          atr: closedCandlesAtr(c4h),
          levels: liveTrade.is_short
            ? [manualSup?.price, mtf.key_4h_support, ...(mtf.chart_targets_short || []).map((c) => c.level_price || c.price)]
            : [manualRes?.price, mtf.key_4h_resistance, ...(mtf.chart_targets_long || []).map((c) => c.level_price || c.price)],
        });
        liveTrade.take_profit_abs = roundPrice(importedTp.price);
      }

      if (liveTrade.campaign_role === 'insurance') {
        liveTrade.planned_dca_levels = [];
        liveTrade.next_dca_price = undefined;
      } else if (!Array.isArray(liveTrade.planned_dca_levels) || liveTrade.planned_dca_levels.length === 0) {
        const dcaLvl = findStrongestDcaLevel(c4h, c1d, entryRate, liveTrade.is_short, 2.6, 95.0, c1w);
        const l1Price = roundPrice(dcaLvl.price);
        const lev = Math.max(1, liveTrade.leverage || 25);
        const baseStake = Math.max(5, liveTrade.initial_stake || liveTrade.stake_amount || 5);
        const computedDcaLevels: PlannedDcaLevel[] = [];
        if (l1Price > 0) {
          computedDcaLevels.push({
            step: 1,
            label: `L1 Усреднение #1 (${dcaLvl.source || '4H/1D S/R'} · сила ${dcaLvl.strength_score || 16}★)`,
            price: l1Price,
            stake_amount: Number(baseStake.toFixed(2)),
            amount: Number(((baseStake * lev) / Math.max(1e-8, l1Price)).toFixed(4)),
            distance_pct: Number(((Math.abs(l1Price - entryRate) / Math.max(1e-8, entryRate)) * 100).toFixed(2)),
            filled: (liveTrade.dca_count || 0) >= 1,
          });
          const l2Price = roundPrice(dcaLvl.second_price || 0);
          if (l2Price > 0 && Math.abs(l2Price - l1Price) / Math.max(1e-8, l1Price) >= 0.02) {
            const l2Stake = Number((baseStake * 1.5).toFixed(2));
            computedDcaLevels.push({
              step: 2,
              label: `L2 Экстренная разгрузка #2 (${dcaLvl.source || '1D/1W S/R'})`,
              price: l2Price,
              stake_amount: l2Stake,
              amount: Number(((l2Stake * lev) / Math.max(1e-8, l2Price)).toFixed(4)),
              distance_pct: Number(((Math.abs(l2Price - entryRate) / Math.max(1e-8, entryRate)) * 100).toFixed(2)),
              filled: (liveTrade.dca_count || 0) >= 2,
            });
          }
        }
        liveTrade.planned_dca_levels = computedDcaLevels;
      }
      liveTrade.plan_notes = `Открытая позиция синхронизирована с биржи ${acc.exchange.toUpperCase()} (${acc.name}) и проанализирована (1D=${mtf.d1_trend} | SUP=${liveTrade.support_level}$ | RES=${liveTrade.resistance_level}$ | TP=${liveTrade.take_profit_abs}$)`;

      recalculateTradeMetrics(liveTrade, false);
      if (!liveTrade.tp_manual_override && liveTrade.min_profitable_tp) {
        const minStructuralFloor = roundPrice(
          liveTrade.is_short ? entryRate * (1 - TP_MIN_DISTANCE_PCT / 100) : entryRate * (1 + TP_MIN_DISTANCE_PCT / 100)
        );
        const targetFloor = liveTrade.is_short
          ? Math.min(liveTrade.min_profitable_tp, minStructuralFloor)
          : Math.max(liveTrade.min_profitable_tp, minStructuralFloor);
        liveTrade.take_profit_abs = liveTrade.is_short
          ? Math.min(liveTrade.take_profit_abs || targetFloor, targetFloor)
          : Math.max(liveTrade.take_profit_abs || targetFloor, targetFloor);
        recalculateTradeMetrics(liveTrade, false);
      }

      sqliteDb.upsertTrade(liveTrade);

      if (
        shouldUpdateAutoTp &&
        liveTrade.campaign_role !== 'insurance' &&
        liveTrade.take_profit_abs &&
        liveTrade.take_profit_abs > 0
      ) {
        placeOrUpdateExchangeTakeProfitOrder(creds, {
          pair: pos.pair,
          isShort: liveTrade.is_short,
          quantity: liveTrade.amount,
          takeProfitPrice: liveTrade.take_profit_abs,
        }).catch(() => {});
      }

      broadcastTradeLifecycleEvent('trade:updated', liveTrade);
      scheduleScopeStateSync(resolveTradeUserId(liveTrade));
    }
  } catch {
    // ignore background candle enrichment errors
  }
}

async function syncPositionsAndHistoryFromExchanges(
  acc: ExchangeAccountRecord,
  forceReanalyzeOpen = false,
  forceFreshFetch = false
): Promise<void> {
  const creds = getAccountCredentialsFromStore(acc);
  if (!creds || isSimulatedTestApiKey(creds.apiKey)) return;

  const targetAccountId = getTargetAccountIdForRecord(acc);
  const targetAccountName = targetAccountId === 'master' ? 'Master' : acc.name;

  reconcileExchangeAccountOpenDuplicates(targetAccountId);

  try {
    // 1. Всегда запрашиваем открытые позиции с биржи; при первом запуске/ручном обновлении обходим кэш (forceFresh)
    const shouldForceFresh = Boolean(forceReanalyzeOpen || forceFreshFetch || !accInitialPosSynced.has(acc.id));
    const openPosRes = await fetchExchangeOpenPositions(creds, shouldForceFresh);

    if (openPosRes.success) {
      accInitialPosSynced.add(acc.id);
      let totalPosUnrealized = 0;
      let totalPosMargin = 0;
      let anyLifecycleChange = false;

      for (const pos of openPosRes.positions) {
        totalPosUnrealized += Number(pos.unrealized_pnl || 0);
        totalPosMargin += Number(pos.margin_usdt || 0);
        const lockKey = getPosLockKey(targetAccountId, pos.pair, pos.is_short);
        if (activePositionKeys.has(lockKey)) continue;
        const syncKey = `open:${targetAccountId}:${pos.pair}:${pos.is_short ? 'S' : 'L'}:${pos.entry_price}`;
        if (dismissedExchangeSyncKeys.has(syncKey)) continue;
        const existingOpen = tradesStore.find(
          (t) =>
            t.is_open &&
            tradeMatchesAccount(t, acc, targetAccountId) &&
            t.pair === pos.pair &&
            t.is_short === pos.is_short
        );

        if (existingOpen) {
          missingFromExchangeCountByTrade.delete(existingOpen.trade_id);
          subscribePairKlineStream(existingOpen.pair, existingOpen.timeframe || '1h');
          if (pos.mark_price > 0) {
            existingOpen.current_rate = roundPrice(pos.mark_price);
            existingOpen.exchange_mark_price = pos.mark_price;
          }
          existingOpen.exchange_unrealized_pnl = Number(pos.unrealized_pnl || 0);
          existingOpen.exchange_synced_at = Date.now();
          const sanitizedPosMargin = sanitizePositionMarginUsdt(
            pos.margin_usdt,
            pos.size,
            pos.entry_price > 0 ? pos.entry_price : existingOpen.open_rate,
            pos.leverage || existingOpen.leverage || 25
          );
          const prevAmount = existingOpen.amount;
          const prevOpenRate = existingOpen.open_rate;

          const sizeChanged = Math.abs(prevAmount - pos.size) > 1e-6;
          const entryShifted =
            pos.entry_price > 0 &&
            Math.abs(prevOpenRate - pos.entry_price) / Math.max(1e-8, pos.entry_price) >
              0.0001;

          if (sanitizedPosMargin > 0) {
            existingOpen.stake_amount = Number(sanitizedPosMargin.toFixed(2));
            if ((existingOpen.dca_count || 0) === 0) {
              existingOpen.initial_stake = existingOpen.stake_amount;
            }
          }
          existingOpen.leverage = pos.leverage || existingOpen.leverage;

          if (sizeChanged && pos.size > 0) {
            existingOpen.amount = Number(pos.size.toFixed(6));
            if ((existingOpen.dca_count || 0) === 0) {
              existingOpen.initial_amount = existingOpen.amount;
            }
          }

          if (entryShifted && pos.entry_price > 0) {
            const exactEntry = roundPrice(pos.entry_price);
            existingOpen.open_rate = exactEntry;
            if ((existingOpen.dca_count || 0) === 0) {
              existingOpen.initial_open_rate = exactEntry;
              if (Array.isArray(existingOpen.orders) && existingOpen.orders.length === 1) {
                existingOpen.orders[0].price = exactEntry;
                existingOpen.orders[0].amount = existingOpen.amount;
                existingOpen.orders[0].stake_amount = existingOpen.stake_amount;
              }
            }
          }

          if (existingOpen.campaign_role === 'insurance') {
            existingOpen.planned_dca_levels = [];
            existingOpen.next_dca_price = undefined;
          }
          const hasTooCloseAutoTp =
            !existingOpen.tp_manual_override &&
            existingOpen.take_profit_abs > 0 &&
            existingOpen.open_rate > 0 &&
            Math.abs(existingOpen.take_profit_abs - existingOpen.open_rate) /
              existingOpen.open_rate <
              TP_MIN_DISTANCE_PCT / 100;
          if (hasTooCloseAutoTp || forceReanalyzeOpen) {
            void enrichImportedPositionMtfLevelsAsync(existingOpen.trade_id, acc, pos, creds);
          }
          recalculateTradeMetrics(existingOpen, false);

          // Если у позиции НЕТ активной второй ноги замка (то есть страховка уже закрыта и идёт сведение, либо одиночная сделка), синхронизируем TP на бирже.
          // Пока открыты ОБЕ ноги замка, биржевой лимитный TP не ставится, так как по Разделу 3, Сценарию 1 и Сценарию 2 касание уровня не является сигналом к закрытию одной ноги!
          const hasActiveLockSibling = Boolean(
            existingOpen.campaign_id &&
              tradesStore.some(
                (s) =>
                  s.is_open &&
                  s.campaign_id === existingOpen.campaign_id &&
                  s.trade_id !== existingOpen.trade_id
              )
          );
          const exPosTp = Number(pos.take_profit || 0);
          if (
            !isSimulatedTestApiKey(creds.apiKey) &&
            !hasActiveLockSibling &&
            existingOpen.campaign_role !== 'insurance' &&
            existingOpen.take_profit_abs > 0 &&
            (!(exPosTp > 0) ||
              Math.abs(exPosTp - existingOpen.take_profit_abs) / existingOpen.take_profit_abs > 0.002)
          ) {
            const prevEnsure = lastExchangeTpEnsureByTrade.get(existingOpen.trade_id);
            const shouldEnsureNow =
              !prevEnsure ||
              Math.abs(prevEnsure.tp - existingOpen.take_profit_abs) > 1e-6 ||
              Date.now() - prevEnsure.ts > 60_000;
            if (shouldEnsureNow) {
              lastExchangeTpEnsureByTrade.set(existingOpen.trade_id, {
                tp: existingOpen.take_profit_abs,
                ts: Date.now(),
              });
              placeOrUpdateExchangeTakeProfitOrder(creds, {
                pair: existingOpen.pair,
                isShort: existingOpen.is_short,
                quantity: existingOpen.amount,
                takeProfitPrice: existingOpen.take_profit_abs,
              })
                .then((tpRes) => {
                  if (tpRes.success && tpRes.take_profit_price > 0) {
                    pos.take_profit = tpRes.take_profit_price;
                  }
                })
                .catch(() => {});
            }
          }

          sqliteDb.upsertTrade(existingOpen);
        } else {
          // На бирже есть открытая позиция, которой еще нет на сайте — НЕМЕДЛЕННО добавляем её в UI с базовыми структурными уровнями,
          // а глубокий 1W->1D->4H анализ запускаем параллельно в фоне (и обновляем карточку по готовности)!
          const id = nextTradeId++;
          const openTs = pos.created_time > 0 ? pos.created_time : Date.now();
          const openDateStr = new Date(openTs).toISOString().replace('T', ' ').slice(0, 19);
          const [base, quote] = pos.pair.split(':')[0].split('/');
          const entryRate = roundPrice(pos.entry_price);
          const markRate = roundPrice(pos.mark_price > 0 ? pos.mark_price : entryRate);
          const lev = pos.leverage || acc.max_leverage || 25;
          const stakeUsdt = Number(pos.margin_usdt.toFixed(2));
          const posTp = Number(pos.take_profit || 0);
          const posSl = Number(pos.stop_loss || 0);
          const feeRate = getExchangeTakerFeeRate(acc.exchange);

          const analyzedSup = roundPrice(pos.is_short ? entryRate * 0.98 : entryRate * 0.965);
          const analyzedRes = roundPrice(pos.is_short ? entryRate * 1.035 : entryRate * 1.02);
          const analyzedTp =
            posTp > 0 && Math.abs(posTp - entryRate) / Math.max(1e-8, entryRate) >= 0.015
              ? roundPrice(posTp)
              : roundPrice(pos.is_short ? entryRate * (1 - 0.02) : entryRate * (1 + 0.02));
          const dcaPrice1 = roundPrice(pos.is_short ? entryRate * 1.035 : entryRate * 0.965);
          const dcaPrice2 = roundPrice(pos.is_short ? entryRate * 1.072 : entryRate * 0.93);

          const importedTrade: FreqtradeTrade = {
            trade_id: id,
            pair: pos.pair,
            base_currency: base || 'ETH',
            quote_currency: quote || 'USDT',
            is_open: true,
            is_short: pos.is_short,
            exchange: acc.exchange,
            account_id: targetAccountId,
            account_name: targetAccountName,
            user_id: acc.user_id || 'owner',
            amount: Number(pos.size.toFixed(4)),
            initial_amount: Number(pos.size.toFixed(4)),
            stake_amount: stakeUsdt,
            initial_stake: stakeUsdt,
            strategy: botConfig.strategy,
            timeframe: botConfig.timeframe,
            fee_open: Number((entryRate * pos.size * feeRate).toFixed(4)),
            fee_close: Number((markRate * pos.size * feeRate).toFixed(4)),
            open_date: openDateStr,
            open_timestamp: openTs,
            open_rate: entryRate,
            initial_open_rate: entryRate,
            dca_count: 0,
            last_dca_date: null,
            close_date: null,
            close_timestamp: null,
            close_rate: null,
            current_rate: markRate,
            exchange_mark_price: pos.mark_price,
            exchange_unrealized_pnl: Number(pos.unrealized_pnl || 0),
            exchange_synced_at: Date.now(),
            profit_ratio: 0,
            profit_pct: 0,
            profit_abs: 0,
            stop_loss_abs: posSl > 0 ? roundPrice(posSl) : 0,
            stop_loss_pct: 0,
            initial_stop_loss_abs: posSl > 0 ? roundPrice(posSl) : 0,
            initial_stop_loss_pct: 0,
            exit_reason: null,
            take_profit_abs: analyzedTp,
            take_profit_pct: Number((0.02 * lev * 100).toFixed(1)),
            leverage: lev,
            enter_tag: 'EXCHANGE_SYNC_LIVE',
            orders: [
              {
                id: `ord-${id}-0`,
                step: 0,
                label: `Синхр. с биржи ${acc.exchange.toUpperCase()} (${pos.is_short ? 'Шорт' : 'Лонг'})`,
                side: pos.is_short ? 'short' : 'long',
                price: entryRate,
                amount: Number(pos.size.toFixed(4)),
                stake_amount: stakeUsdt,
                timestamp: openTs,
                date: openDateStr,
              },
            ],
            planned_dca_levels: [],
            support_level: analyzedSup,
            resistance_level: analyzedRes,
            plan_notes: `Открытая позиция синхронизирована с биржи ${acc.exchange.toUpperCase()} (${acc.name}) — выполняется MTF-анализ 1D/4H...`,
            trade_state: 'WAITING_PULLBACK',
            next_dca_price: undefined,
            tp_manual_override: false,
            sl_manual_override: posSl > 0,
            dca_manual_override: false,
          };

          recalculateTradeMetrics(importedTrade, false);
          if (!importedTrade.tp_manual_override && importedTrade.min_profitable_tp) {
            importedTrade.take_profit_abs = importedTrade.is_short
              ? Math.min(importedTrade.take_profit_abs || importedTrade.min_profitable_tp, importedTrade.min_profitable_tp)
              : Math.max(importedTrade.take_profit_abs || importedTrade.min_profitable_tp, importedTrade.min_profitable_tp);
            recalculateTradeMetrics(importedTrade, false);
          }

          const raceExisting = tradesStore.find(
            (t) =>
              t.is_open &&
              tradeMatchesAccount(t, acc, targetAccountId) &&
              t.pair === pos.pair &&
              t.is_short === pos.is_short
          );
          if (raceExisting || activePositionKeys.has(lockKey)) {
            continue;
          }

          tradesStore.unshift(importedTrade);
          sqliteDb.upsertTrade(importedTrade);
          broadcastTradeLifecycleEvent('trade:opened', importedTrade);
          anyLifecycleChange = true;

          appendLog(
            `freqtrade.exchange.${acc.exchange}`,
            'INFO',
            `🔄 [OPEN POSITION SYNC] Мгновенно подтянута открытая сделка с биржи ${acc.exchange.toUpperCase()} (${acc.name}): #${id} [${pos.pair}] ${pos.is_short ? 'SHORT' : 'LONG'} ${lev}x @ ${entryRate}$ | TP: ${importedTrade.take_profit_abs}$`,
            { userId: acc.user_id || 'owner' }
          );

          // Запускаем глубокий анализ свечей 1W->1D->4H в фоне, не блокируя остальные позиции
          void enrichImportedPositionMtfLevelsAsync(id, acc, pos, creds);
        }
      }

      acc.open_trades_count = openPosRes.positions.length;
      acc.unrealized_pnl = Number(totalPosUnrealized.toFixed(4));
      acc.used_margin_usdt = Number(totalPosMargin.toFixed(2));
      const walletRef = acc.wallet_balance_usdt ?? acc.balance_usdt ?? 0;
      const liveWsStateForAvail = getWsAccountLiveState(sanitizeCredentialString(acc.api_key_raw), 120_000);
      if (walletRef > 0) {
        acc.equity_usdt = Number((walletRef + acc.unrealized_pnl).toFixed(4));
        if (
          liveWsStateForAvail &&
          typeof liveWsStateForAvail.availableBalanceUsdt === 'number' &&
          Number.isFinite(liveWsStateForAvail.availableBalanceUsdt) &&
          liveWsStateForAvail.availableBalanceUsdt >= 0 &&
          liveWsStateForAvail.availableBalanceUsdt <= walletRef + Math.max(0, acc.unrealized_pnl) + 1.0
        ) {
          acc.available_balance_usdt = Number(liveWsStateForAvail.availableBalanceUsdt.toFixed(2));
        } else if (acc.used_margin_usdt === 0) {
          acc.available_balance_usdt = Number(walletRef.toFixed(2));
        } else {
          acc.available_balance_usdt = Number(
            Math.max(0, walletRef + Math.min(0, acc.unrealized_pnl || 0) - acc.used_margin_usdt).toFixed(2)
          );
        }
      }
      sqliteDb.upsertExchangeAccount(acc);

      // 2. Удаляем старые симулированные (sim-*) или чужие межбиржевые фантомы, которых нет ни на одной подключённой бирже
      const enabledExchangesSet = new Set<string>(
        exchangeAccountsStore.filter((a) => a.enabled).map((a) => a.exchange)
      );
      const stalePhantomIds = new Set<number>();
      for (const localT of tradesStore) {
        if (!localT.is_open) continue;
        if (!tradeMatchesAccount(localT, acc, targetAccountId)) continue;
        const hasSimOrder =
          Array.isArray(localT.orders) &&
          localT.orders.some((o: any) => String(o?.id || '').startsWith('sim-'));
        const noEnabledAccountForExchange = !enabledExchangesSet.has(localT.exchange);
        const wrongExchangeForClient = localT.exchange !== acc.exchange;
        if (hasSimOrder || noEnabledAccountForExchange || wrongExchangeForClient) {
          stalePhantomIds.add(localT.trade_id);
        }
      }
      if (stalePhantomIds.size > 0) {
        for (const pid of stalePhantomIds) {
          sqliteDb.deleteTrade(pid);
        }
        tradesStore = tradesStore.filter((t) => !stalePhantomIds.has(t.trade_id));
        anyLifecycleChange = true;
      }

      reconcileExchangeAccountOpenDuplicates(targetAccountId);

      // 3. Для открытых сделок на ЭТОМ аккаунте/бирже, которые исчезли из списка открытых на бирже (закрылись по TP или вручную):
      const localOpenForAcc = tradesStore.filter(
        (t) =>
          t.is_open &&
          t.exchange === acc.exchange &&
          tradeMatchesAccount(t, acc, targetAccountId) &&
          !activePositionKeys.has(getPosLockKey(targetAccountId, t.pair, t.is_short)) &&
          Date.now() - (t.open_timestamp || 0) > 15_000
      );

      let disappearedTrades = localOpenForAcc.filter(
        (localTrade) =>
          !openPosRes.positions.some(
            (p) => p.pair === localTrade.pair && p.is_short === localTrade.is_short
          )
      );

      // Защита от ложного закрытия на сайте: если какие-то сделки отсутствуют в кэшированном ответе,
      // ОБЯЗАТЕЛЬНО делаем прямой некэшированный запрос к бирже (forceFresh = true), чтобы убедиться, что позиция реально закрыта на бирже!
      if (disappearedTrades.length > 0 && !shouldForceFresh) {
        const freshPosCheck = await fetchExchangeOpenPositions(creds, true).catch(() => ({
          success: false,
          positions: [] as typeof openPosRes.positions,
        }));
        if (!freshPosCheck.success) {
          // Если биржа временно не ответила на прямой запрос позиций — НЕ закрываем сделки локально!
          disappearedTrades = [];
        } else {
          for (const fPos of freshPosCheck.positions) {
            const matchStillOpen = disappearedTrades.find(
              (t) => t.pair === fPos.pair && t.is_short === fPos.is_short
            );
            if (matchStillOpen) {
              missingFromExchangeCountByTrade.delete(matchStillOpen.trade_id);
            }
          }
          disappearedTrades = disappearedTrades.filter(
            (localTrade) =>
              !freshPosCheck.positions.some(
                (p) => p.pair === localTrade.pair && p.is_short === localTrade.is_short
              )
          );
        }
      }

      if (disappearedTrades.length > 0) {
        const missingPairs = Array.from(new Set(disappearedTrades.map((t) => t.pair)));
        const closedPnlRes = await fetchExchangeClosedPnl(creds, 50, missingPairs, true).catch(() => ({
          success: false,
          closed: [],
        }));
        const minValidTs = acc.connected_at || 0;
        const consumedClosedKeys = new Set<string>();

        for (const localTrade of disappearedTrades) {
          const matchedClosed = closedPnlRes.success
            ? closedPnlRes.closed.find((c) => {
                const cKey = `${c.order_id}:${c.updated_time}:${c.pair}:${c.is_short ? 'S' : 'L'}`;
                return (
                  !consumedClosedKeys.has(cKey) &&
                  c.pair === localTrade.pair &&
                  (c.is_short === localTrade.is_short || c.order_id.startsWith('inc-')) &&
                  c.updated_time >= Math.max(minValidTs, (localTrade.open_timestamp || 0) - 5_000)
                );
              })
            : undefined;

          if (!matchedClosed) {
            // КРИТИЧЕСКАЯ ЗАЩИТА: если в истории закрытых сделок биржи (closed-pnl / userTrades) НЕТ записи о закрытии этой позиции,
            // НЕ закрываем сделку на сайте с первого раза! Считаем последовательные подтверждения отсутствия (минимум 4 проверки и >= 30 секунд),
            // чтобы кратковременный сбой API или задержка индексации закрытия на бирже никогда не закрывали сделки локально.
            const prevMiss = missingFromExchangeCountByTrade.get(localTrade.trade_id);
            const nowMs = Date.now();
            const nextMiss = prevMiss
              ? { count: prevMiss.count + 1, firstMissingAt: prevMiss.firstMissingAt }
              : { count: 1, firstMissingAt: nowMs };
            missingFromExchangeCountByTrade.set(localTrade.trade_id, nextMiss);

            if (nextMiss.count < 4 || nowMs - nextMiss.firstMissingAt < 30_000) {
              continue;
            }

            // Только если на протяжении >= 4 свежих проверок (>= 30 сек) позиции точно нет на бирже (например, закрыта в 0 без записи в income),
            // переводим её в закрытые:
            missingFromExchangeCountByTrade.delete(localTrade.trade_id);
            const fallbackClosePrice = roundPrice(
              localTrade.current_rate > 0 ? localTrade.current_rate : localTrade.open_rate
            );
            const closeTs = Date.now();
            const closeDateStr = new Date(closeTs).toISOString().replace('T', ' ').slice(0, 19);
            localTrade.is_open = false;
            localTrade.close_rate = fallbackClosePrice;
            localTrade.current_rate = fallbackClosePrice;
            localTrade.close_timestamp = closeTs;
            localTrade.close_date = closeDateStr;
            localTrade.exit_reason = 'exchange_tp_closed_sync';
            localTrade.trade_state = 'CLOSED';
            localTrade.planned_dca_levels = [];
            recalculateTradeMetrics(localTrade, false);
            sqliteDb.upsertTrade(localTrade);
            broadcastTradeLifecycleEvent('trade:closed', localTrade);
            anyLifecycleChange = true;
            appendLog(
              `freqtrade.exchange.${acc.exchange}`,
              'INFO',
              `🏁 [EXCHANGE CLOSE SYNC] Позиция #${localTrade.trade_id} [${localTrade.pair}] подтверждённо отсутствует на бирже ${acc.exchange.toUpperCase()} @ ${fallbackClosePrice}$ | PnL: ${localTrade.profit_abs}$`,
              { userId: acc.user_id || 'owner' }
            );
            continue;
          }

          missingFromExchangeCountByTrade.delete(localTrade.trade_id);
          const matchedKey = `${matchedClosed.order_id}:${matchedClosed.updated_time}:${matchedClosed.pair}:${matchedClosed.is_short ? 'S' : 'L'}`;
          consumedClosedKeys.add(matchedKey);

          if (matchedClosed.entry_price > 0 && !matchedClosed.order_id.startsWith('inc-')) {
            localTrade.open_rate = roundPrice(matchedClosed.entry_price);
          }
          if (matchedClosed.qty > 0 && !matchedClosed.order_id.startsWith('inc-')) {
            localTrade.amount = Number(matchedClosed.qty.toFixed(6));
            const lev = Math.max(1, localTrade.leverage || 25);
            localTrade.stake_amount = Number(
              ((localTrade.open_rate * localTrade.amount) / lev).toFixed(2)
            );
          }

          const closePrice = roundPrice(
            matchedClosed.exit_price > 0 ? matchedClosed.exit_price : localTrade.current_rate
          );
          const closeTs =
            matchedClosed.updated_time > 0 ? matchedClosed.updated_time : Date.now();
          const closeDateStr = new Date(closeTs).toISOString().replace('T', ' ').slice(0, 19);

          localTrade.is_open = false;
          localTrade.close_rate = closePrice;
          localTrade.current_rate = closePrice;
          localTrade.close_timestamp = closeTs;
          localTrade.close_date = closeDateStr;
          localTrade.exit_reason = 'exchange_tp_closed_sync';
          localTrade.trade_state = 'CLOSED';
          localTrade.planned_dca_levels = [];
          localTrade.fee_open = matchedClosed.open_fee;
          localTrade.fee_close = matchedClosed.close_fee;
          localTrade.fee_total = Number((matchedClosed.open_fee + matchedClosed.close_fee).toFixed(4));
          localTrade.exchange_realized_pnl = matchedClosed.closed_pnl;
          if (matchedClosed.order_id) {
            localTrade.plan_notes = `Синхронизировано с биржей ${acc.exchange.toUpperCase()} (OrderID: ${matchedClosed.order_id}) [EXACT_EXCHANGE_RECONCILED]`;
          }
          recalculateTradeMetrics(localTrade, false);

          sqliteDb.upsertTrade(localTrade);
          broadcastTradeLifecycleEvent('trade:closed', localTrade);
          anyLifecycleChange = true;
          appendLog(
            `freqtrade.exchange.${acc.exchange}`,
            'INFO',
            `🏁 [EXCHANGE CLOSE SYNC] Позиция #${localTrade.trade_id} [${localTrade.pair}] закрыта на бирже ${acc.exchange.toUpperCase()} (Вход: ${localTrade.open_rate}$ ➔ Выход: ${closePrice}$) | Реальный PnL биржи: ${localTrade.profit_abs}$ (Комиссия: ${localTrade.fee_total}$)`,
            { userId: acc.user_id || 'owner' }
          );
        }
      }

      // 4. Догоняющая сверка недавно закрытых сделок (за последние 10 минут), у которых в момент мгновенного закрытия по WS/API
      // биржа ещё не успела проиндексировать запись (или Binance WS прислал оценку openFee вместо userTrades)
      const recentlyClosedPendingExactPnl = tradesStore.filter(
        (t) =>
          !t.is_open &&
          t.exchange === acc.exchange &&
          tradeMatchesAccount(t, acc, targetAccountId) &&
          (typeof t.exchange_realized_pnl !== 'number' ||
            (t.exit_reason === 'exchange_ws_tp_sync' &&
              !String(t.plan_notes || '').includes('[EXACT_EXCHANGE_RECONCILED]'))) &&
          t.close_timestamp &&
          Date.now() - t.close_timestamp < 600_000
      );
      if (recentlyClosedPendingExactPnl.length > 0) {
        const pendingPairs = Array.from(new Set(recentlyClosedPendingExactPnl.map((t) => t.pair)));
        const reconcilRes = await fetchExchangeClosedPnl(creds, 50, pendingPairs, true).catch(() => ({
          success: false,
          closed: [],
        }));
        if (reconcilRes.success && reconcilRes.closed.length > 0) {
          const usedOrderIds = new Set<string>();
          for (const closedTrade of recentlyClosedPendingExactPnl) {
            const exactRec = reconcilRes.closed.find(
              (c) =>
                !usedOrderIds.has(c.order_id) &&
                c.pair === closedTrade.pair &&
                (c.is_short === closedTrade.is_short || c.order_id.startsWith('inc-')) &&
                c.updated_time >= (closedTrade.open_timestamp || 0) - 60_000 &&
                Math.abs(c.updated_time - (closedTrade.close_timestamp || Date.now())) < 300_000
            );
            if (exactRec) {
              usedOrderIds.add(exactRec.order_id);
              if (exactRec.entry_price > 0 && !exactRec.order_id.startsWith('inc-')) {
                closedTrade.open_rate = roundPrice(exactRec.entry_price);
              }
              if (exactRec.exit_price > 0) {
                closedTrade.close_rate = roundPrice(exactRec.exit_price);
                closedTrade.current_rate = closedTrade.close_rate;
              }
              if (exactRec.open_fee > 0) closedTrade.fee_open = exactRec.open_fee;
              if (exactRec.close_fee > 0) closedTrade.fee_close = exactRec.close_fee;
              closedTrade.fee_total = Number(
                ((closedTrade.fee_open || 0) + (closedTrade.fee_close || 0)).toFixed(4)
              );
              closedTrade.exchange_realized_pnl = exactRec.closed_pnl;
              const baseNote = String(closedTrade.plan_notes || '').trim();
              closedTrade.plan_notes = baseNote.includes('[EXACT_EXCHANGE_RECONCILED]')
                ? baseNote
                : `${baseNote ? `${baseNote} ` : ''}[EXACT_EXCHANGE_RECONCILED]`;
              recalculateTradeMetrics(closedTrade, false);
              sqliteDb.upsertTrade(closedTrade);
              broadcastTradeLifecycleEvent('trade:updated', closedTrade);
              anyLifecycleChange = true;
            }
          }
        }
      }

      if (anyLifecycleChange) {
        scheduleScopeStateSync(acc.user_id || 'owner');
      }
    }
  } catch {
    // ignore transient position sync errors
  }
}

let exchangeSyncInFlight: Promise<void> | null = null;
const lastSyncErrorLogByAcc = new Map<string, { msg: string; ts: number }>();

function triggerBackgroundExchangeSync(force = false): void {
  if (!force && Date.now() - lastExchangeBalanceSyncTs < 6_000) return;
  if (exchangeSyncInFlight) return;
  exchangeSyncInFlight = syncRealExchangeBalancesIfNeeded(force).finally(() => {
    exchangeSyncInFlight = null;
  });
}

async function syncRealExchangeBalancesIfNeeded(force = false): Promise<void> {
  if (!force && Date.now() - lastExchangeBalanceSyncTs < 6_000) return;
  lastExchangeBalanceSyncTs = Date.now();
  const enabledAccs = exchangeAccountsStore.filter((a) => a.enabled);
  for (const acc of enabledAccs) {
    const creds = getAccountCredentialsFromStore(acc);
    if (!creds || isSimulatedTestApiKey(creds.apiKey)) continue;
    try {
      const check = await testExchangeConnection(creds);
      if (check.success) {
        lastSyncErrorLogByAcc.delete(acc.id);
        let changed = false;
        if (check.exchange && acc.exchange !== check.exchange) {
          acc.exchange = check.exchange;
          changed = true;
        }
        if (typeof check.is_testnet === 'boolean' && acc.is_testnet !== check.is_testnet) {
          acc.is_testnet = check.is_testnet;
          changed = true;
        }
        if (check.network_label && acc.network_label !== check.network_label) {
          acc.network_label = check.network_label;
          changed = true;
        }
        const exactWallet = check.wallet_balance_usdt ?? check.balance_usdt;
        if (typeof exactWallet === 'number' && exactWallet > 0) {
          if (Math.abs((acc.balance_usdt || 0) - exactWallet) >= 0.001) {
            acc.balance_usdt = Number(exactWallet.toFixed(4));
            changed = true;
          }
          acc.wallet_balance_usdt = Number(exactWallet.toFixed(4));
        }
        if (typeof check.unrealized_pnl_usdt === 'number') {
          acc.unrealized_pnl = Number(check.unrealized_pnl_usdt.toFixed(4));
        }
        if (typeof check.equity_usdt === 'number') {
          acc.equity_usdt = Number(check.equity_usdt.toFixed(4));
        }
        if (typeof check.available_balance_usdt === 'number') {
          acc.available_balance_usdt = Number(check.available_balance_usdt.toFixed(2));
        }
        if (typeof check.used_margin_usdt === 'number') {
          acc.used_margin_usdt = Number(check.used_margin_usdt.toFixed(2));
        }
        acc.status = 'connected';
        acc.last_sync = new Date().toISOString().replace('T', ' ').slice(0, 19);
        if (changed || force) {
          sqliteDb.upsertExchangeAccount(acc);
          appendLog(
            'freqtrade.exchange.sync',
            'INFO',
            `🔄 Синхронизирован счёт биржи ${check.network_label || acc.exchange.toUpperCase()} (${acc.name}): Баланс=${acc.balance_usdt.toFixed(2)} USDT | Плавающий PnL=${acc.unrealized_pnl >= 0 ? '+' : ''}${acc.unrealized_pnl.toFixed(2)} USDT | Пинг: ${check.latency_ms} мс`,
            { userId: acc.user_id || 'owner' }
          );
        }
      } else {
        // Не дублируем одно и то же предупреждение в логах чаще чем раз в 5 минут
        const prevErr = lastSyncErrorLogByAcc.get(acc.id);
        if (!prevErr || prevErr.msg !== check.message || Date.now() - prevErr.ts > 5 * 60_000) {
          lastSyncErrorLogByAcc.set(acc.id, { msg: check.message, ts: Date.now() });
          appendLog(
            'freqtrade.exchange.sync',
            'WARNING',
            `⚠️ Проверка связи с биржей ${acc.exchange.toUpperCase()} (${acc.name}): ${check.message}`,
            { userId: acc.user_id || 'owner' }
          );
        }
      }
      // Синхронизируем реальные открытые позиции и закрытые сделки с биржи
      await syncPositionsAndHistoryFromExchanges(acc, false, force);
    } catch {
      // ignore transient network error
    }
  }
}

// ============================================================================
// ПРАВИЛА РАЗВОРОТА И ЖУРНАЛ СИГНАЛОВ
// По истории 30 монет: свечные модели на 1H и развороты против дневного тренда не лучше случайного входа;
// преимущество было только у разворота ПО дневному тренду у сильного уровня 4H. Поэтому решения,
// которые ставят на разворот (усреднение, вход по отбою), принимаются по закрытым свечам 4H и только
// по дневному тренду. Каждый замеченный сигнал пишется в журнал, а через 48 свечей 4H фиксируется его
// исход (разворот: +2 ATR раньше −1 ATR; пробой: наоборот) — так бот копит собственную статистику.
// ============================================================================

const reversalContextCache = new Map<
  string,
  { ts: number; closed4h: RawCandle[]; dailyDirection: 'UP' | 'DOWN' | 'RANGE' }
>();

async function getReversalContext(
  pair: string
): Promise<{ closed4h: RawCandle[]; dailyDirection: 'UP' | 'DOWN' | 'RANGE' }> {
  const cached = reversalContextCache.get(pair);
  if (cached && Date.now() - cached.ts < 5 * 60_000) return cached;
  const [{ candles: c4h }, { candles: c1d }] = await Promise.all([
    fetchRealCandles(pair, '4h', 300),
    fetchRealCandles(pair, '1d', 300),
  ]);
  const ctx = {
    ts: Date.now(),
    closed4h: c4h.slice(0, -1),
    dailyDirection: assessTimeframeTrend(c1d, '1D').direction,
  };
  reversalContextCache.set(pair, ctx);
  return ctx;
}

function atrOfLastCandle(candles: RawCandle[], period = 14): number {
  if (candles.length < period + 2) return 0;
  let atr = 0;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close));
    atr = i <= period ? (atr * (i - 1) + tr) / i : (atr * (period - 1) + tr) / period;
  }
  return atr;
}

function journalReversalSignal(params: {
  pair: string;
  candles4h: RawCandle[];
  side: 'support' | 'resistance';
  level: number;
  purpose: 'entry' | 'dca' | 'tp_exit';
  dailyDirection: 'UP' | 'DOWN' | 'RANGE';
  withTrend: boolean;
  acted: boolean;
}): void {
  const last = params.candles4h[params.candles4h.length - 1];
  const atr = atrOfLastCandle(params.candles4h);
  if (!last || !(atr > 0)) return;
  sqliteDb.recordReversalSignal({
    pair: params.pair,
    timeframe: '4h',
    candle_ts: last.timestamp,
    side: params.side,
    level: params.level,
    price: last.close,
    atr,
    purpose: params.purpose,
    daily_trend: params.dailyDirection,
    with_trend: params.withTrend,
    acted: params.acted,
  });
}

const REVERSAL_JOURNAL_HORIZON = 48;
let reversalJournalResolving = false;

/** Проставляет исход сигналам журнала, для которых уже прошли свечи 4H после сигнала. */
async function resolvePendingReversalSignals(): Promise<void> {
  if (reversalJournalResolving) return;
  reversalJournalResolving = true;
  try {
    const pending = sqliteDb.listPendingReversalSignals(300);
    const byPair = new Map<string, any[]>();
    for (const row of pending) {
      if (!byPair.has(row.pair)) byPair.set(row.pair, []);
      byPair.get(row.pair)!.push(row);
    }
    for (const [pair, rows] of byPair) {
      const { candles } = await fetchRealCandles(pair, '4h', 300);
      const closed = candles.slice(0, -1);
      for (const row of rows) {
        const idx = closed.findIndex((c) => c.timestamp === Number(row.candle_ts));
        if (idx < 0) {
          // Свеча сигнала ушла за пределы загруженной истории — исход уже не восстановить
          if (Date.now() - Number(row.candle_ts) > 60 * 86_400_000) {
            sqliteDb.resolveReversalSignal(row.id, 'unclear', null);
          }
          continue;
        }
        const isSupport = row.side === 'support';
        const tp = isSupport ? row.price + 2 * row.atr : row.price - 2 * row.atr;
        const sl = isSupport ? row.price - row.atr : row.price + row.atr;
        let outcome: string | null = null;
        let bars: number | null = null;
        for (let j = idx + 1; j < closed.length && j <= idx + REVERSAL_JOURNAL_HORIZON; j++) {
          const x = closed[j];
          if (isSupport ? x.low <= sl : x.high >= sl) {
            outcome = 'breakout';
            bars = j - idx;
            break;
          }
          if (isSupport ? x.high >= tp : x.low <= tp) {
            outcome = 'reversal';
            bars = j - idx;
            break;
          }
        }
        if (!outcome && closed.length - 1 - idx >= REVERSAL_JOURNAL_HORIZON) outcome = 'unclear';
        if (outcome) sqliteDb.resolveReversalSignal(row.id, outcome, bars);
      }
    }
  } catch {
    // не критично: попробуем в следующий раз
  } finally {
    reversalJournalResolving = false;
  }
}

/**
 * Core ScalpBot processing loop:
 * 1. Updates ALL active enabled accounts' open trades (Target TP, SL, 4H Hedge Leg, Zero-Loss Guard, Smart Level DCA).
 * 2. Scans active pairs once per cycle and independently opens positions for every enabled exchange account
 *    based on each account's own wallet balance (0.5% stake), max leverage, and exchange tradability.
 */
let isBotCycleRunning = false;
async function runScalpBotCycle(waitForActive = false) {
  if (waitForActive && isBotCycleRunning) {
    const startWait = Date.now();
    while (isBotCycleRunning && Date.now() - startWait < 8000) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (isBotCycleRunning) return;
  if (!hasConnectedExchangeAccount()) {
    botConfig.state = 'stopped';
    return;
  }
  isBotCycleRunning = true;
  try {
    await initializeBotTrades();
    if (!hasConnectedExchangeAccount()) {
      botConfig.state = 'stopped';
      return;
    }

    if (exchangeSyncInFlight) {
      await exchangeSyncInFlight.catch(() => {});
    }
    await syncRealExchangeBalancesIfNeeded(false);

    const activeAccounts = exchangeAccountsStore.filter(
      (a) => a.enabled && !isUserBotStopped(a.user_id || 'owner')
    );
    if (activeAccounts.length === 0) return;

    // Fetch live exchange positions for ALL real enabled accounts (keyed strictly per account ID)
    const liveExchangePosMap = new Map<string, { mark_price: number; unrealized_pnl: number; size: number }>();
    for (const acc of activeAccounts) {
      if (!acc?.api_key_raw || isSimulatedTestApiKey(acc.api_key_raw)) continue;
      const creds = getAccountCredentialsFromStore(acc);
      if (!creds) continue;
      const livePosRes = await fetchExchangeOpenPositions(creds);
      if (livePosRes.success) {
        for (const p of livePosRes.positions) {
          liveExchangePosMap.set(`${acc.id}:${p.pair}:${p.is_short ? 'S' : 'L'}`, {
            mark_price: p.mark_price,
            unrealized_pnl: p.unrealized_pnl,
            size: p.size,
          });
        }
      }
    }

    const openTrades = tradesStore.filter((t) => {
      if (!t.is_open) return false;
      const matchedAcc = resolveExchangeAccountRecord(t.account_id || 'master');
      return Boolean(
        matchedAcc &&
          matchedAcc.enabled &&
          !isUserBotStopped(matchedAcc.user_id || 'owner') &&
          tradeMatchesAccount(t, matchedAcc, getTargetAccountIdForRecord(matchedAcc))
      );
    });

    // 1. Evaluate all currently open trades across all enabled accounts (TP, SL, 4H Hedge Leg, Smart Level DCA)
    for (const trade of openTrades) {
      const tradeAcc = resolveExchangeAccountRecord(trade.account_id || 'master');
      if (!tradeAcc || !tradeAcc.enabled || isUserBotStopped(tradeAcc.user_id || 'owner')) continue;
      const tradeAccScopeId = getTargetAccountIdForRecord(tradeAcc);
      const tradeUserId = resolveTradeUserId(trade);
      // Раздел 3 (Фаза 3: Локальный слом структуры на младшем таймфрейме):
      // Всегда запрашиваем свечи рабочего младшего ТФ (botConfig.timeframe = 1h/15m), чтобы 3-фазный разворот проверялся именно на младшем ТФ, а не на 4H/1D!
      const workingLtf = botConfig.timeframe || '1h';
      const { candles: candles1h } = await fetchRealCandles(trade.pair, workingLtf, 60);
      if (!candles1h || candles1h.length === 0) continue;

      const liveExPos = liveExchangePosMap.get(
        `${tradeAcc.id}:${trade.pair}:${trade.is_short ? 'S' : 'L'}`
      );
      // Для Testnet живые Mainnet-тикеры не используем: цена и PnL берутся из позиции самой тестовой биржи
      const tradeOnTestnet = isTestnetTrade(trade);
      const execInfo = tradeOnTestnet
        ? undefined
        : getFuturesExecutionPrice(trade.pair, trade.is_short, true, trade.exchange);
      const currentPrice =
        execInfo && execInfo.markPrice > 0
          ? roundPrice(execInfo.markPrice)
          : liveExPos && liveExPos.mark_price > 0
          ? roundPrice(liveExPos.mark_price)
          : tradeOnTestnet && trade.exchange_mark_price && trade.exchange_mark_price > 0
          ? roundPrice(trade.exchange_mark_price)
          : candles1h[candles1h.length - 1].close;
      const closeExecPrice =
        execInfo && execInfo.executionPrice > 0
          ? roundPrice(execInfo.executionPrice)
          : currentPrice;

      trade.current_rate = currentPrice;
      if (execInfo && execInfo.markPrice > 0 && trade.open_rate > 0 && trade.amount > 0) {
        trade.exchange_mark_price = execInfo.markPrice;
        const wsUpl =
          (trade.is_short ? trade.open_rate - execInfo.markPrice : execInfo.markPrice - trade.open_rate) *
          trade.amount;
        trade.exchange_unrealized_pnl = Number(wsUpl.toFixed(4));
        trade.exchange_synced_at = execInfo.updatedAt;
      } else if (liveExPos) {
        trade.exchange_mark_price = liveExPos.mark_price;
        trade.exchange_unrealized_pnl = liveExPos.unrealized_pnl;
        trade.exchange_synced_at = Date.now();
      }
      recalculateTradeMetrics(trade, false);

      // ZERO-LOSS EXCHANGE GUARD: проверяем чистый PnL по фактической цене исполнения стакана (Bid/Ask) и Mark Price
      const execUnrealized =
        trade.open_rate > 0 && trade.amount > 0
          ? Number(
              (
                (trade.is_short ? trade.open_rate - closeExecPrice : closeExecPrice - trade.open_rate) *
                trade.amount
              ).toFixed(4)
            )
          : liveExPos?.unrealized_pnl;
      const closeProfitGuard = verifySafeProfitableClose(
        trade,
        {
          mark_price: currentPrice,
          unrealized_pnl: execUnrealized,
          size: trade.amount,
        },
        closeExecPrice
      );

      // Находим парную ногу хедж-кампании (если открыта)
      const openSibling = trade.campaign_id
        ? tradesStore.find(
            (s) =>
              s.is_open &&
              resolveTradeUserId(s) === tradeUserId &&
              tradeMatchesAccount(s, tradeAcc, tradeAccScopeId) &&
              s.campaign_id === trade.campaign_id &&
              s.trade_id !== trade.trade_id
          )
        : undefined;

      // Определяем роль ноги в кампании (primary = 1.0x по тренду, insurance = 0.5x страховка против тренда)
      if (trade.campaign_id && !trade.campaign_role && openSibling) {
        if ((trade.initial_stake || trade.stake_amount) > (openSibling.initial_stake || openSibling.stake_amount) * 1.15) {
          trade.campaign_role = 'primary';
          openSibling.campaign_role = 'insurance';
        } else if ((openSibling.initial_stake || openSibling.stake_amount) > (trade.initial_stake || trade.stake_amount) * 1.15) {
          trade.campaign_role = 'insurance';
          openSibling.campaign_role = 'primary';
        }
      }

      // СЦЕНАРИЙ 4 (Пункт 4.3): Защита от «распила» (Whipsaw Stop) на повторно открытой страховочной позиции
      if (
        trade.campaign_role === 'insurance' &&
        trade.whipsaw_stop_price &&
        trade.whipsaw_stop_price > 0
      ) {
        const whipsawTriggered = trade.is_short
          ? currentPrice >= trade.whipsaw_stop_price
          : currentPrice <= trade.whipsaw_stop_price;
        if (whipsawTriggered) {
          let closedWhipsaw = false;
          const lockKey = getPosLockKey(trade.account_id || tradeAccScopeId, trade.pair, trade.is_short);
          await withPositionLock(lockKey, async () => {
            if (!trade.is_open) {
              closedWhipsaw = true;
              return;
            }
            const closeOrderRes = await dispatchOrderToExchangeAccount(tradeAcc, {
              pair: trade.pair,
              action: 'CLOSE',
              isShort: trade.is_short,
              quantity: trade.amount,
              referencePrice: closeExecPrice,
              leverage: trade.leverage || 25,
            });
            if (tradeAcc && !isSimulatedTestApiKey(tradeAcc.api_key_raw) && !closeOrderRes?.success) {
              return;
            }
            const actualClosePrice =
              closeOrderRes?.success && closeOrderRes.price > 0
                ? roundPrice(closeOrderRes.price)
                : closeExecPrice;
            const now = Date.now();
            const nowStr = new Date(now).toISOString().replace('T', ' ').slice(0, 19);
            sqliteDb.runInTransaction(() => {
              trade.is_open = false;
              trade.close_rate = actualClosePrice;
              trade.current_rate = actualClosePrice;
              trade.close_date = nowStr;
              trade.close_timestamp = now;
              trade.exit_reason = 'whipsaw_rehedge_stop';
              trade.trade_state = 'CLOSED';
              trade.whipsaw_stop_price = undefined;
              recalculateTradeMetrics(trade, false);
              sqliteDb.upsertTrade(trade);
              if (openSibling) {
                openSibling.campaign_banked_profit = Number(
                  ((openSibling.campaign_banked_profit || 0) + (trade.net_profit ?? trade.profit_abs ?? 0)).toFixed(4)
                );
                recalculateTradeMetrics(openSibling, false);
                sqliteDb.upsertTrade(openSibling);
              }
            });
            appendLog(
              'freqtrade.bot.hedge',
              'WARNING',
              `🛡️ [Whipsaw Guard] Повторная страховка #${trade.trade_id} [${trade.pair}] закрыта по короткому стопу ${actualClosePrice}$ (возврат цены за уровень L1). Основная позиция продолжает движение к разгрузке.`,
              { userId: tradeUserId }
            );
            broadcastTradeLifecycleEvent('trade:closed', trade);
            closedWhipsaw = true;
          });
          if (closedWhipsaw) continue;
        }
      }

      // СЦЕНАРИЙ 4 (Пункт 4.1): Срабатывание защитного стоп-ордера повторного хеджирования (Re-Hedge Stop за тенью разворотной свечи)
      // Работает как для двухсторонней кампании, так и для одностороннего скальпинга после DCA #1 на L1!
      if (
        trade.rehedge_stop_price &&
        trade.rehedge_stop_price > 0 &&
        !openSibling
      ) {
        const rehedgeTriggered = trade.is_short
          ? currentPrice >= trade.rehedge_stop_price
          : currentPrice <= trade.rehedge_stop_price;
        if (rehedgeTriggered) {
          const rehedgePrice = trade.rehedge_stop_price;
          const storedWhipsawPrice =
            trade.whipsaw_stop_price && trade.whipsaw_stop_price > 0
              ? trade.whipsaw_stop_price
              : roundPrice(rehedgePrice * (trade.is_short ? 0.996 : 1.004));
          const rehedgeStake = Math.max(
            botConfig.min_stake_amount || 5,
            Number((trade.stake_amount * 0.5).toFixed(2))
          );
          if (!trade.campaign_id) {
            trade.campaign_id = `hedge-${trade.pair.split(':')[0].replace('/', '')}-${Date.now()}`;
          }
          trade.campaign_role = 'primary';
          trade.rehedge_stop_price = undefined;
          trade.rehedge_stop_qty = undefined;
          sqliteDb.upsertTrade(trade);

          try {
            const [{ candles: c4h }, { candles: c1d }] = await Promise.all([
              fetchRealCandles(trade.pair, '4h', 120),
              fetchRealCandles(trade.pair, '1d', 90),
            ]);
            const mtfRehedge = analyzeMultiTimeframe(trade.pair, candles1h, c4h, c1d);
            const newInsuranceSide: 'long' | 'short' = trade.is_short ? 'long' : 'short';
            const newInsuranceTrade = await createScalpBotPosition(
              trade.pair,
              newInsuranceSide,
              currentPrice,
              mtfRehedge,
              c4h,
              c1d,
              `ReHedge_${newInsuranceSide === 'short' ? 'Short' : 'Long'}_L2`,
              {
                accountId: tradeAcc.id,
                accountName: tradeAcc.name,
                stake: rehedgeStake,
                leverage: trade.leverage || 25,
                campaignId: trade.campaign_id,
                campaignRole: 'insurance',
                whipsawStopPrice: storedWhipsawPrice,
                strategyName: 'GlobalHedgeStrategy',
                timeframeOverride: trade.timeframe || '4h',
              }
            );
            appendLog(
              'freqtrade.bot.hedge',
              'WARNING',
              `🔒 [Сценарий 4: Повторный лок] Ложный разворот на L1 по [${trade.pair}] (пробит Re-Hedge Stop ${rehedgePrice}$): открыта новая страховка #${newInsuranceTrade.trade_id} (${newInsuranceSide.toUpperCase()}, 0.5x от главной ноги = ${rehedgeStake}$) с защитой от распила ${storedWhipsawPrice}$ до уровня L2.`,
              { userId: tradeUserId }
            );
          } catch (rehedgeErr: any) {
            appendLog(
              'freqtrade.bot.hedge',
              'ERROR',
              `⚠️ Ошибка открытия повторного лока [${trade.pair}]: ${rehedgeErr?.message || rehedgeErr}`,
              { userId: tradeUserId }
            );
          }
        }
      }

      // СЦЕНАРИЙ 6: Затяжной флэт в середине коридора (> 24 часов без доjścia до L1 и без усреднений)
      if (
        openSibling &&
        (trade.dca_count || 0) === 0 &&
        (openSibling.dca_count || 0) === 0 &&
        trade.open_timestamp > 0 &&
        Date.now() - trade.open_timestamp >= 24 * 3600 * 1000
      ) {
        const distFromEntryPct =
          (Math.abs(currentPrice - trade.open_rate) / Math.max(1e-8, trade.open_rate)) * 100;
        if (distFromEntryPct <= 0.15) {
          for (const leg of [trade, openSibling]) {
            if (!leg.is_open) continue;
            const legLockKey = getPosLockKey(leg.account_id || tradeAccScopeId, leg.pair, leg.is_short);
            await withPositionLock(legLockKey, async () => {
              if (!leg.is_open) return;
              const legExec = getTradeExecutionQuote(leg, true);
              const legClosePrice =
                legExec && legExec.executionPrice > 0 ? roundPrice(legExec.executionPrice) : currentPrice;
              const closeRes = await dispatchOrderToExchangeAccount(tradeAcc, {
                pair: leg.pair,
                action: 'CLOSE',
                isShort: leg.is_short,
                quantity: leg.amount,
                referencePrice: legClosePrice,
                leverage: leg.leverage || 25,
              });
              if (tradeAcc && !isSimulatedTestApiKey(tradeAcc.api_key_raw) && !closeRes?.success) return;
              const actualPrice =
                closeRes?.success && closeRes.price > 0 ? roundPrice(closeRes.price) : legClosePrice;
              const now = Date.now();
              const nowStr = new Date(now).toISOString().replace('T', ' ').slice(0, 19);
              sqliteDb.runInTransaction(() => {
                leg.is_open = false;
                leg.close_rate = actualPrice;
                leg.current_rate = actualPrice;
                leg.close_date = nowStr;
                leg.close_timestamp = now;
                leg.exit_reason = 'hedge_flat_corridor_exit';
                leg.trade_state = 'CLOSED';
                leg.planned_dca_levels = [];
                recalculateTradeMetrics(leg, false);
                sqliteDb.upsertTrade(leg);
              });
              broadcastTradeLifecycleEvent('trade:closed', leg);
            });
          }
          appendLog(
            'freqtrade.bot.hedge',
            'INFO',
            `⏳ [Сценарий 6: Выход из флэта] Кампания ${trade.campaign_id} [${trade.pair}] расформирована в точке исходного входа (${currentPrice}$) спустя >24ч затяжной пилы без касания уровней.`,
            { userId: tradeUserId }
          );
          continue;
        }
      }

      // СЦЕНАРИЙ 1 (Варианты А и Б) и СЦЕНАРИЙ 2: Цена идёт ПО ТРЕНДУ к уровню L1 при открытом асимметричном замке (Primary 1.0x + Insurance 0.5x)
      if (
        openSibling &&
        trade.campaign_role === 'primary' &&
        openSibling.campaign_role === 'insurance' &&
        trade.take_profit_abs > 0
      ) {
        const nearOrBeyondPrimaryTp = trade.is_short
          ? currentPrice <= trade.take_profit_abs * 1.0035
          : currentPrice >= trade.take_profit_abs * 0.9965;
        if (nearOrBeyondPrimaryTp) {
          // Проверяем 3-фазный разворот от уровня L1 против основного тренда (если мы в шорте, L1 — поддержка, ждём отскок вверх true; если в лонге, L1 — сопротивление, ждём отбой вниз false)
          const isBounceFromSupportAtTp = trade.is_short;
          // Здесь разворот нужен только для фиксации прибыли у цели, поэтому смотрим младший ТФ, но только закрытые свечи
          const levelReversalAtTp = detectThreePhaseLevelReversal(
            candles1h.slice(0, -1),
            trade.take_profit_abs,
            isBounceFromSupportAtTp,
            0.75
          );
          const primaryNetPnl = trade.net_profit ?? trade.profit_abs ?? 0;
          const insuranceNetPnl = openSibling.net_profit ?? openSibling.profit_abs ?? 0;
          const combinedCycleNetPnl = Number((primaryNetPnl + insuranceNetPnl).toFixed(4));

          if (levelReversalAtTp.confirmed && combinedCycleNetPnl > 0.05 && closeProfitGuard.ok) {
            // СЦЕНАРИЙ 1 (Вариант А — Прямая фиксация цикла): На уровне L1 сформировался разворот -> закрываем ОБЕ позиции одновременно в чистый плюс за счёт перевеса 2:1!
            for (const leg of [trade, openSibling]) {
              const legLockKey = getPosLockKey(leg.account_id || tradeAccScopeId, leg.pair, leg.is_short);
              await withPositionLock(legLockKey, async () => {
                if (!leg.is_open) return;
                const legExec = getTradeExecutionQuote(leg, true);
                const legClosePrice =
                  legExec && legExec.executionPrice > 0 ? roundPrice(legExec.executionPrice) : currentPrice;
                const closeRes = await dispatchOrderToExchangeAccount(tradeAcc, {
                  pair: leg.pair,
                  action: 'CLOSE',
                  isShort: leg.is_short,
                  quantity: leg.amount,
                  referencePrice: legClosePrice,
                  leverage: leg.leverage || 25,
                });
                if (tradeAcc && !isSimulatedTestApiKey(tradeAcc.api_key_raw) && !closeRes?.success) return;
                const actualPrice =
                  closeRes?.success && closeRes.price > 0 ? roundPrice(closeRes.price) : legClosePrice;
                const now = Date.now();
                const nowStr = new Date(now).toISOString().replace('T', ' ').slice(0, 19);
                sqliteDb.runInTransaction(() => {
                  leg.is_open = false;
                  leg.close_rate = actualPrice;
                  leg.current_rate = actualPrice;
                  leg.close_date = nowStr;
                  leg.close_timestamp = now;
                  leg.exit_reason = 'asymmetric_hedge_cycle_profit';
                  leg.trade_state = 'CLOSED';
                  leg.planned_dca_levels = [];
                  recalculateTradeMetrics(leg, false);
                  sqliteDb.upsertTrade(leg);
                });
                broadcastTradeLifecycleEvent('trade:closed', leg);
              });
            }
            appendLog(
              'freqtrade.bot.hedge',
              'INFO',
              `🏆 [Сценарий 1А: Прибыль цикла 2:1] На уровне ${trade.take_profit_abs}$ подтверждён 3-фазный разворот (${levelReversalAtTp.reason}). Обе ноги [${trade.pair}] закрыты одновременно с чистым профитом корзины +${combinedCycleNetPnl}$!`,
              { userId: tradeUserId }
            );
            continue;
          } else if (
            levelReversalAtTp.confirmed &&
            combinedCycleNetPnl <= 0.05 &&
            primaryNetPnl > 0.05 &&
            closeProfitGuard.ok
          ) {
            // СЦЕНАРИЙ 1 (Вариант Б — Отыгрыш отката):
            // 1. Закрываем плюсовую основную ногу и отправляем её профит в копилку P_bank.
            // 2. Переводим страховочную ногу в статус основной (primary), усредняем на развороте у уровня и ставим общий стоп за тень разворотной свечи!
            let closedPrimaryVariantB = false;
            const primaryLockKey = getPosLockKey(trade.account_id || tradeAccScopeId, trade.pair, trade.is_short);
            await withPositionLock(primaryLockKey, async () => {
              if (!trade.is_open) return;
              const closeRes = await dispatchOrderToExchangeAccount(tradeAcc, {
                pair: trade.pair,
                action: 'CLOSE',
                isShort: trade.is_short,
                quantity: trade.amount,
                referencePrice: closeExecPrice,
                leverage: trade.leverage || 25,
              });
              if (tradeAcc && !isSimulatedTestApiKey(tradeAcc.api_key_raw) && !closeRes?.success) return;
              const actualPrice =
                closeRes?.success && closeRes.price > 0 ? roundPrice(closeRes.price) : closeExecPrice;
              const now = Date.now();
              const nowStr = new Date(now).toISOString().replace('T', ' ').slice(0, 19);
              sqliteDb.runInTransaction(() => {
                trade.is_open = false;
                trade.close_rate = actualPrice;
                trade.current_rate = actualPrice;
                trade.close_date = nowStr;
                trade.close_timestamp = now;
                trade.exit_reason = 'scenario1_variant_b_primary_harvest';
                trade.trade_state = 'CLOSED';
                trade.planned_dca_levels = [];
                recalculateTradeMetrics(trade, false);
                sqliteDb.upsertTrade(trade);

                const harvested = Math.max(0, Number((trade.net_profit ?? trade.profit_abs ?? 0).toFixed(4)));
                openSibling.campaign_banked_profit = Number(
                  ((openSibling.campaign_banked_profit || 0) + harvested).toFixed(4)
                );
                // Страховочная нога (против дневного тренда) больше НЕ превращается в основную и НЕ усредняется:
                // это была бы ставка на разворот против тренда, а на истории такие развороты не лучше случайных.
                // Она остаётся страховкой со своим тейком; прибыль основной ноги уже лежит в банке P_bank.
                recalculateTradeMetrics(openSibling, false);
                sqliteDb.upsertTrade(openSibling);
              });
              broadcastTradeLifecycleEvent('trade:closed', trade);
              broadcastTradeLifecycleEvent('trade:updated', openSibling);
              closedPrimaryVariantB = true;
            });
            if (closedPrimaryVariantB) {
              appendLog(
                'freqtrade.bot.hedge',
                'INFO',
                `🔄 [Сценарий 1Б: Отыгрыш отката] Основная нога #${trade.trade_id} [${trade.pair}] зафиксирована на уровне ${trade.take_profit_abs}$ в банк P_bank (+${openSibling.campaign_banked_profit}$). Страховочная нога остаётся страховкой (без усреднения против тренда).$!`,
                { userId: tradeUserId }
              );
              continue;
            }
          }

          // СЦЕНАРИЙ 2: Цена уверенно пробивает уровень L1 по тренду без разворота -> тралим стоп за пробитый уровень и переносим цель к следующему глобальному уровню L2
          const brokeBeyondTp = trade.is_short
            ? currentPrice <= trade.take_profit_abs * 0.995
            : currentPrice >= trade.take_profit_abs * 1.005;
          if (brokeBeyondTp && !levelReversalAtTp.confirmed && !trade.tp_manual_override) {
            const brokenLevel = trade.take_profit_abs;
            const trailedSl = roundPrice(brokenLevel * (trade.is_short ? 1.004 : 0.996));
            // Если у страховочной ноги есть уровни или известна дистанция до следующего глобального уровня — целимся туда, иначе +3.2%
            const siblingNextLvl = Array.isArray(openSibling.planned_dca_levels)
              ? openSibling.planned_dca_levels.find(
                  (l) =>
                    !l.filled &&
                    (trade.is_short
                      ? l.price <= brokenLevel * 0.98
                      : l.price >= brokenLevel * 1.02)
                )?.price
              : undefined;
            const shiftedTp = siblingNextLvl
              ? roundPrice(siblingNextLvl)
              : roundPrice(brokenLevel * (trade.is_short ? 0.968 : 1.032));
            trade.stop_loss_abs = trailedSl;
            trade.take_profit_abs = shiftedTp;
            trade.tp_reason = `Сценарий 2: пробой уровня ${brokenLevel}$ по тренду -> трал к следующему уровню L2 (${shiftedTp}$)`;
            recalculateTradeMetrics(trade, false);
            sqliteDb.upsertTrade(trade);
            appendLog(
              'freqtrade.bot.hedge',
              'INFO',
              `🚀 [Сценарий 2: Пробой по тренду] Уровень ${brokenLevel}$ [${trade.pair}] пробит без разворота: стоп подтянут за уровень (${trailedSl}$), цель перенесена к следующему уровню L2 (${shiftedTp}$).`,
              { userId: tradeUserId }
            );
            broadcastTradeLifecycleEvent('trade:updated', trade);
          }
        }
      }

      // 1A-SL. Исполнение защитного стоп-приказа в безубытке/профите (Сценарий 2 — возврат за пробитый уровень, Сценарий 1Б, Раздел 5Б — стоп в безубыток на отскоке)
      if (trade.stop_loss_abs > 0 && closeProfitGuard.ok) {
        const isProfitableStopHit = trade.is_short
          ? currentPrice >= trade.stop_loss_abs && trade.stop_loss_abs < trade.open_rate
          : currentPrice <= trade.stop_loss_abs && trade.stop_loss_abs > trade.open_rate;
        const isBankCoveredStopHit =
          (trade.campaign_banked_profit || 0) > 0 &&
          (trade.is_short
            ? currentPrice >= trade.stop_loss_abs
            : currentPrice <= trade.stop_loss_abs);
        if (isProfitableStopHit || isBankCoveredStopHit) {
          let closedByTrailedSl = false;
          const legsToClose = openSibling ? [trade, openSibling] : [trade];
          for (const leg of legsToClose) {
            if (!leg.is_open) continue;
            const legLockKey = getPosLockKey(leg.account_id || tradeAccScopeId, leg.pair, leg.is_short);
            await withPositionLock(legLockKey, async () => {
              if (!leg.is_open) return;
              const legExec = getTradeExecutionQuote(leg, true);
              const legClosePrice =
                legExec && legExec.executionPrice > 0 ? roundPrice(legExec.executionPrice) : currentPrice;
              const closeRes = await dispatchOrderToExchangeAccount(tradeAcc, {
                pair: leg.pair,
                action: 'CLOSE',
                isShort: leg.is_short,
                quantity: leg.amount,
                referencePrice: legClosePrice,
                leverage: leg.leverage || 25,
              });
              if (tradeAcc && !isSimulatedTestApiKey(tradeAcc.api_key_raw) && !closeRes?.success) return;
              const actualPrice =
                closeRes?.success && closeRes.price > 0 ? roundPrice(closeRes.price) : legClosePrice;
              const now = Date.now();
              const nowStr = new Date(now).toISOString().replace('T', ' ').slice(0, 19);
              sqliteDb.runInTransaction(() => {
                leg.is_open = false;
                leg.close_rate = actualPrice;
                leg.current_rate = actualPrice;
                leg.close_date = nowStr;
                leg.close_timestamp = now;
                leg.exit_reason = 'trailed_breakeven_stop_profit';
                leg.trade_state = 'CLOSED';
                leg.planned_dca_levels = [];
                leg.rehedge_stop_price = undefined;
                recalculateTradeMetrics(leg, false);
                sqliteDb.upsertTrade(leg);
              });
              broadcastTradeLifecycleEvent('trade:closed', leg);
              closedByTrailedSl = true;
            });
          }
          if (closedByTrailedSl) {
            appendLog(
              'freqtrade.bot.hedge',
              'INFO',
              `🛡️ [Защитный Стоп в Плюс/БУ] Сработал подтянутый стоп-приказ ${trade.stop_loss_abs}$ по [${trade.pair}] #${trade.trade_id}: позиция закрыта в чистый плюс (+${trade.profit_abs}$, P_bank=${trade.campaign_banked_profit || 0}$)!`,
              { userId: tradeUserId }
            );
            continue;
          }
        }
      }

      // 1A. Target TP check (только когда НЕТ активной второй ноги замка — то есть после закрытия страховки при разгрузке основной ноги на отскоке, либо для одиночной сделки).
      // Пока открыты ОБЕ ноги замка (Boolean(openSibling)), касание уровня НЕ закрывает ногу вслепую — работа идёт строго по Сценариям 1А, 1Б, 2, 3, 4 и 5!
      if (trade.take_profit_abs > 0 && !openSibling) {
        const isTpHit = trade.is_short
          ? currentPrice <= trade.take_profit_abs || closeExecPrice <= trade.take_profit_abs
          : currentPrice >= trade.take_profit_abs || closeExecPrice >= trade.take_profit_abs;
        if (isTpHit && closeProfitGuard.ok) {
          let closedInCycle = false;
          const lockKey = getPosLockKey(trade.account_id || tradeAccScopeId, trade.pair, trade.is_short);
          await withPositionLock(lockKey, async () => {
            if (!trade.is_open) {
              closedInCycle = true;
              return;
            }
            const closeOrderRes = await dispatchOrderToExchangeAccount(tradeAcc, {
              pair: trade.pair,
              action: 'CLOSE',
              isShort: trade.is_short,
              quantity: trade.amount,
              referencePrice: closeExecPrice,
              leverage: trade.leverage || 25,
            });
            if (tradeAcc && !isSimulatedTestApiKey(tradeAcc.api_key_raw) && !closeOrderRes?.success) {
              return;
            }

            const actualClosePrice =
              closeOrderRes?.success && closeOrderRes.price > 0
                ? roundPrice(closeOrderRes.price)
                : closeExecPrice;
            const now =
              closeOrderRes?.exchange_time && closeOrderRes.exchange_time > 0
                ? closeOrderRes.exchange_time
                : Date.now();
            const nowStr = new Date(now).toISOString().replace('T', ' ').slice(0, 19);
            sqliteDb.runInTransaction(() => {
              trade.is_open = false;
              trade.close_rate = actualClosePrice;
              trade.current_rate = actualClosePrice;
              trade.close_date = nowStr;
              trade.close_timestamp = now;
              if (closeOrderRes?.open_fee_usdt && closeOrderRes.open_fee_usdt > 0) {
                trade.fee_open = Number(closeOrderRes.open_fee_usdt.toFixed(4));
              }
              if (closeOrderRes?.commission_usdt && closeOrderRes.commission_usdt > 0) {
                trade.fee_close = Number(closeOrderRes.commission_usdt.toFixed(4));
              }
              if (typeof closeOrderRes?.realized_pnl_usdt === 'number') {
                const totalFees = (trade.fee_open || 0) + (trade.fee_close || 0);
                trade.exchange_realized_pnl = Number(
                  (closeOrderRes.realized_pnl_usdt - totalFees).toFixed(4)
                );
              }
              trade.exit_reason = 'roi_target_tp';
              trade.trade_state = 'CLOSED';
              trade.planned_dca_levels = [];
              trade.rehedge_stop_price = undefined;
              recalculateTradeMetrics(trade, false);
              sqliteDb.upsertTrade(trade);
              sqliteDb.recordOrder({
                trade_id: trade.trade_id,
                pair: trade.pair,
                order_type: 'market',
                side: trade.is_short ? 'buy' : 'sell',
                price: actualClosePrice,
                amount: trade.amount,
                cost: Number((actualClosePrice * trade.amount).toFixed(4)),
                fee: trade.fee_close || 0,
                realized_pnl: trade.net_profit || trade.profit_abs,
                action_type: 'TAKE_PROFIT',
                notes: `Target TP hit at ${actualClosePrice}, Net PnL: +${trade.profit_abs} USDT (Fee total: ${trade.fee_total} USDT)`,
              });

              if (tradeAcc) {
                const remAccOpen = tradesStore.filter(
                  (t) => t.is_open && tradeMatchesAccount(t, tradeAcc, tradeAccScopeId)
                );
                tradeAcc.open_trades_count = remAccOpen.length;
                tradeAcc.used_margin_usdt = Number(remAccOpen.reduce((s, t) => s + (t.stake_amount || 0), 0).toFixed(2));
                tradeAcc.unrealized_pnl = Number(remAccOpen.reduce((s, t) => s + (t.profit_abs || 0), 0).toFixed(4));
              }
            });

            cooldownPairs.set(`${tradeAcc.id}:${trade.pair}`, Date.now());
            if (!isSimulatedTestApiKey(tradeAcc.api_key_raw) && typeof trade.exchange_realized_pnl !== 'number') {
              setTimeout(() => {
                void syncRealExchangeBalancesIfNeeded(true);
              }, 2200);
            }
            appendLog(
              'freqtrade.bot.exit',
              'INFO',
              `🎯 Target TP Hit [${trade.pair}] #${trade.trade_id} (${tradeAcc.name}): закрыто по реальной цене биржи ${actualClosePrice}$ | Чистый PnL: +${trade.profit_abs}$ (комиссия: ${trade.fee_total}$)`,
              { userId: tradeUserId }
            );
            broadcastTradeLifecycleEvent('trade:closed', trade);
            closedInCycle = true;
          });
          if (closedInCycle) continue;
        } else if (
          isTpHit &&
          !closeProfitGuard.ok &&
          trade.min_profitable_tp &&
          !trade.tp_manual_override
        ) {
          trade.take_profit_abs = trade.min_profitable_tp;
          recalculateTradeMetrics(trade, false);
          sqliteDb.upsertTrade(trade);
          const tradeCreds = getAccountCredentialsFromStore(tradeAcc);
          if (tradeCreds && !isSimulatedTestApiKey(tradeCreds.apiKey) && trade.take_profit_abs > 0) {
            placeOrUpdateExchangeTakeProfitOrder(tradeCreds, {
              pair: trade.pair,
              isShort: trade.is_short,
              quantity: trade.amount,
              takeProfitPrice: trade.take_profit_abs,
            }).catch(() => {});
          }
          broadcastTradeLifecycleEvent('trade:updated', trade);
        }
      }

      // 1C. СЦЕНАРИЙ 3 (Пункт 3.4) и РАЗДЕЛ 5 (Стоп в безубыток + тейк на отскоке L1, Разгрузка L2 и «Откусывание хвоста»)
      if (
        (trade.campaign_banked_profit !== undefined && trade.campaign_banked_profit !== null && trade.campaign_banked_profit > 0) ||
        (trade.dca_count || 0) >= 1
      ) {
        if (closeProfitGuard.ok && currentPrice && trade.min_profitable_tp) {
          const reachedMinProfit = trade.is_short
            ? currentPrice <= trade.min_profitable_tp && closeExecPrice <= trade.min_profitable_tp
            : currentPrice >= trade.min_profitable_tp && closeExecPrice >= trade.min_profitable_tp;
          if (reachedMinProfit) {
            // Сразу удаляем отложенный ордер повторного хеджа (Сценарий 3.4: «отложенный ордер страховки удаляется»)
            trade.rehedge_stop_price = undefined;
            trade.rehedge_stop_qty = undefined;

            // Раздел 5Б («Первое усреднение: закрытие через стоп в безубыток + тейк»)
            // и Раздел 5В («Второе усреднение: режим приоритета разгрузки — закрывается минимум половина или вся тяжелая позиция; если импульс отскока сильный — остаток дотягивается до полного безубытка»):
            const lastCandle = candles1h[candles1h.length - 1];
            const isStrongCandleInOurDirection =
              Boolean(lastCandle) &&
              (trade.is_short
                ? lastCandle.close < lastCandle.open && currentPrice <= trade.min_profitable_tp * 0.9985
                : lastCandle.close > lastCandle.open && currentPrice >= trade.min_profitable_tp * 1.0015);
            const alreadyLockedBeStop =
              trade.stop_loss_abs > 0 &&
              (trade.is_short
                ? trade.stop_loss_abs <= trade.min_profitable_tp * 1.001
                : trade.stop_loss_abs >= trade.min_profitable_tp * 0.999);

            if (
              (trade.dca_count || 0) === 1 &&
              isStrongCandleInOurDirection &&
              !alreadyLockedBeStop &&
              !trade.tp_manual_override
            ) {
              trade.stop_loss_abs = roundPrice(trade.min_profitable_tp);
              trade.take_profit_abs = roundPrice(
                currentPrice * (trade.is_short ? 0.994 : 1.006)
              );
              sqliteDb.upsertTrade(trade);
              appendLog(
                'freqtrade.bot.hedge',
                'INFO',
                `🛡️ [Раздел 5Б: Стоп в Безубыток + Тейк] [${trade.pair}] #${trade.trade_id} прошёл точку общего безубытка корзины (${trade.min_profitable_tp}$): отложенный Re-Hedge ордер удалён, защитный стоп переведён в чистый плюс ${trade.stop_loss_abs}$, тейк сдвинут на продолжение отскока ${trade.take_profit_abs}$!`,
                { userId: tradeUserId }
              );
              broadcastTradeLifecycleEvent('trade:updated', trade);
              continue;
            }

            if (
              (trade.dca_count || 0) >= 2 &&
              isStrongCandleInOurDirection &&
              !alreadyLockedBeStop &&
              !trade.tp_manual_override &&
              trade.amount > 0
            ) {
              // Раздел 5В: При сильном импульсе отскока от 2-го уровня усреднения закрываем 50% (половину) тяжелой позиции,
              // фиксируем стоп в точке разгрузки и дотягиваем оставшиеся 50% до полного безубытка (breakeven_price)!
              const unloadQty = Number((trade.amount * 0.5).toFixed(6));
              const remainQty = Number((trade.amount - unloadQty).toFixed(6));
              if (unloadQty > 0 && remainQty > 0) {
                const partialRes = await dispatchOrderToExchangeAccount(tradeAcc, {
                  pair: trade.pair,
                  action: 'CLOSE',
                  isShort: trade.is_short,
                  quantity: unloadQty,
                  referencePrice: closeExecPrice,
                  leverage: trade.leverage || 25,
                });
                if (!tradeAcc || isSimulatedTestApiKey(tradeAcc.api_key_raw) || partialRes?.success) {
                  const fillPrice =
                    partialRes?.success && partialRes.price > 0
                      ? roundPrice(partialRes.price)
                      : closeExecPrice;
                  const partialGross = trade.is_short
                    ? (trade.open_rate - fillPrice) * unloadQty
                    : (fillPrice - trade.open_rate) * unloadQty;
                  const partialFee =
                    partialRes?.commission_usdt && partialRes.commission_usdt > 0
                      ? partialRes.commission_usdt
                      : fillPrice * unloadQty * 0.00055;
                  const partialNet = Number((partialGross - partialFee).toFixed(4));
                  sqliteDb.runInTransaction(() => {
                    trade.amount = remainQty;
                    trade.stake_amount = Number(
                      ((remainQty * trade.open_rate) / (trade.leverage || 1)).toFixed(4)
                    );
                    trade.fee_open = Number(((trade.fee_open || 0) * 0.5).toFixed(4));
                    trade.campaign_banked_profit = Number(
                      ((trade.campaign_banked_profit || 0) + partialNet).toFixed(4)
                    );
                    trade.stop_loss_abs = roundPrice(
                      trade.min_profitable_tp || trade.breakeven_price || currentPrice
                    );
                    trade.take_profit_abs = roundPrice(
                      trade.breakeven_price || currentPrice * (trade.is_short ? 0.995 : 1.005)
                    );
                    recalculateTradeMetrics(trade, false);
                    sqliteDb.upsertTrade(trade);
                    sqliteDb.recordOrder({
                      trade_id: trade.trade_id,
                      pair: trade.pair,
                      order_type: 'market',
                      side: trade.is_short ? 'buy' : 'sell',
                      price: fillPrice,
                      amount: unloadQty,
                      cost: Number((fillPrice * unloadQty).toFixed(4)),
                      fee: Number(partialFee.toFixed(4)),
                      realized_pnl: partialNet,
                      action_type: 'HEDGE_L2_PARTIAL_UNLOAD',
                      notes: `[Раздел 5В] Частичная разгрузка 50% на 2-м усреднении по ${fillPrice}$`,
                    });
                  });
                  appendLog(
                    'freqtrade.bot.hedge',
                    'INFO',
                    `⚖️ [Раздел 5В: Частичная разгрузка 50% на 2-м усреднении] [${trade.pair}] #${trade.trade_id}: разгружена половина тяжелой позиции (${unloadQty}) по ${fillPrice}$, стоп закреплён на ${trade.stop_loss_abs}$, остаток (${remainQty}) дотягивается до полного безубытка ${trade.take_profit_abs}$!`,
                    { userId: tradeUserId }
                  );
                  broadcastTradeLifecycleEvent('trade:updated', trade);
                  continue;
                }
              }
            }

            let closedHedgeInCycle = false;
            const lockKey = getPosLockKey(trade.account_id || tradeAccScopeId, trade.pair, trade.is_short);
            await withPositionLock(lockKey, async () => {
              if (!trade.is_open) {
                closedHedgeInCycle = true;
                return;
              }
              const closeOrderRes = await dispatchOrderToExchangeAccount(tradeAcc, {
                pair: trade.pair,
                action: 'CLOSE',
                isShort: trade.is_short,
                quantity: trade.amount,
                referencePrice: closeExecPrice,
                leverage: trade.leverage || 25,
              });
              if (tradeAcc && !isSimulatedTestApiKey(tradeAcc.api_key_raw) && !closeOrderRes?.success) {
                return;
              }

              const actualClosePrice =
                closeOrderRes?.success && closeOrderRes.price > 0
                  ? roundPrice(closeOrderRes.price)
                  : closeExecPrice;
              const now =
                closeOrderRes?.exchange_time && closeOrderRes.exchange_time > 0
                  ? closeOrderRes.exchange_time
                  : Date.now();
              const nowStr = new Date(now).toISOString().replace('T', ' ').slice(0, 19);
              sqliteDb.runInTransaction(() => {
                trade.is_open = false;
                trade.close_rate = actualClosePrice;
                trade.current_rate = actualClosePrice;
                trade.close_date = nowStr;
                trade.close_timestamp = now;
                if (closeOrderRes?.open_fee_usdt && closeOrderRes.open_fee_usdt > 0) {
                  trade.fee_open = Number(closeOrderRes.open_fee_usdt.toFixed(4));
                }
                if (closeOrderRes?.commission_usdt && closeOrderRes.commission_usdt > 0) {
                  trade.fee_close = Number(closeOrderRes.commission_usdt.toFixed(4));
                }
                if (typeof closeOrderRes?.realized_pnl_usdt === 'number') {
                  const totalFees = (trade.fee_open || 0) + (trade.fee_close || 0);
                  trade.exchange_realized_pnl = Number(
                    (closeOrderRes.realized_pnl_usdt - totalFees).toFixed(4)
                  );
                }
                trade.exit_reason =
                  (trade.dca_count || 0) >= 2
                    ? 'hedge_l2_unloading_exit'
                    : 'hedge_breakeven_profit';
                trade.trade_state = 'CLOSED';
                trade.planned_dca_levels = [];
                trade.rehedge_stop_price = undefined;
                trade.rehedge_stop_qty = undefined;
                recalculateTradeMetrics(trade, false);
                sqliteDb.upsertTrade(trade);
                sqliteDb.recordOrder({
                  trade_id: trade.trade_id,
                  pair: trade.pair,
                  order_type: 'market',
                  side: trade.is_short ? 'buy' : 'sell',
                  price: actualClosePrice,
                  amount: trade.amount,
                  cost: Number((actualClosePrice * trade.amount).toFixed(4)),
                  fee: trade.fee_close || 0,
                  realized_pnl: trade.net_profit || trade.profit_abs,
                  action_type: 'HEDGE_PROFIT_EXIT',
                  notes: `Выход на отскоке по формуле общего безубытка корзины (${actualClosePrice}$), P_bank=${trade.campaign_banked_profit || 0}$`,
                });
                if (tradeAcc) {
                  const remAccOpen = tradesStore.filter(
                    (t) => t.is_open && tradeMatchesAccount(t, tradeAcc, tradeAccScopeId)
                  );
                  tradeAcc.open_trades_count = remAccOpen.length;
                  tradeAcc.used_margin_usdt = Number(remAccOpen.reduce((s, t) => s + (t.stake_amount || 0), 0).toFixed(2));
                  tradeAcc.unrealized_pnl = Number(remAccOpen.reduce((s, t) => s + (t.profit_abs || 0), 0).toFixed(4));
                }
              });
              cooldownPairs.set(`${tradeAcc.id}:${trade.pair}`, Date.now());
              appendLog(
                'freqtrade.bot.hedge',
                'INFO',
                `⚖️ [Выход на отскоке] Позиция #${trade.trade_id} [${trade.pair}] (${tradeAcc.name}) закрыта по ${actualClosePrice}$ (DCA #${trade.dca_count || 0}, P_bank=${trade.campaign_banked_profit || 0}$). Ордер повторного хеджа снят, цикл завершён в плюс!`,
                { userId: tradeUserId }
              );
              broadcastTradeLifecycleEvent('trade:closed', trade);
              closedHedgeInCycle = true;
            });
            if (closedHedgeInCycle) continue;
          }
        }

        // РАЗДЕЛ 5В: Частичная разгрузка («Откусывание хвоста») за счёт накопленного банка страховки P_bank
        if (
          trade.is_open &&
          (trade.dca_count || 0) >= 1 &&
          (trade.campaign_banked_profit || 0) > 0.5 &&
          Array.isArray(trade.orders) &&
          trade.orders.length >= 2 &&
          trade.min_profitable_tp
        ) {
          const lastDcaOrder = trade.orders[trade.orders.length - 1];
          const bounceSpan = Math.abs(trade.min_profitable_tp - lastDcaOrder.price);
          const currentBounce = trade.is_short
            ? lastDcaOrder.price - currentPrice
            : currentPrice - lastDcaOrder.price;
          const bounceProgress = bounceSpan > 1e-8 ? currentBounce / bounceSpan : 0;
          // Если отскок прошёл минимум 45% пути к точке безубытка и начал тормозить
          if (bounceProgress >= 0.45 && bounceProgress < 0.96) {
            const tailOrder = trade.orders[0];
            const tailBite = calculateTailBitePartialClose({
              orders: trade.orders,
              currentPrice: closeExecPrice,
              isShort: trade.is_short,
              bankedProfitUsdt: trade.campaign_banked_profit || 0,
              feeRate: getExchangeTakerFeeRate(tradeAcc.exchange),
            });
            if (tailBite.canBite && tailBite.closeQty > 0) {
              const lockKey = getPosLockKey(trade.account_id || tradeAccScopeId, trade.pair, trade.is_short);
              await withPositionLock(lockKey, async () => {
                if (!trade.is_open) return;
                const partCloseRes = await dispatchOrderToExchangeAccount(tradeAcc, {
                  pair: trade.pair,
                  action: 'CLOSE',
                  isShort: trade.is_short,
                  quantity: tailBite.closeQty,
                  referencePrice: closeExecPrice,
                  leverage: trade.leverage || 25,
                });
                if (tradeAcc && !isSimulatedTestApiKey(tradeAcc.api_key_raw) && !partCloseRes?.success) {
                  return;
                }
                const ratioRemaining = tailBite.remainingQty / Math.max(1e-8, trade.amount);
                sqliteDb.runInTransaction(() => {
                  tailOrder.amount = Number(Math.max(0, tailOrder.amount - tailBite.closeQty).toFixed(4));
                  tailOrder.stake_amount = Number((tailOrder.stake_amount * ratioRemaining).toFixed(2));
                  trade.amount = tailBite.remainingQty;
                  trade.stake_amount = Number((trade.stake_amount * ratioRemaining).toFixed(2));
                  trade.open_rate = roundPrice(tailBite.newAvgEntryPrice);
                  trade.campaign_banked_profit = tailBite.remainingBankProfit;
                  trade.tail_bites_count = (trade.tail_bites_count || 0) + 1;
                  recalculateTradeMetrics(trade, false);
                  sqliteDb.upsertTrade(trade);
                });
                appendLog(
                  'freqtrade.bot.hedge',
                  'INFO',
                  `✂️ [Откусывание хвоста] [${trade.pair}] #${trade.trade_id}: закрыт кусок верхнего хвоста ${tailBite.closeQty} за счёт банка P_bank (-${tailBite.consumedBankProfit}$). Новая средняя: ${trade.open_rate}$, остаток P_bank: ${trade.campaign_banked_profit}$`,
                  { userId: tradeUserId }
                );
                broadcastTradeLifecycleEvent('trade:updated', trade);
              });
            }
          }
        }
      }

      // 1D. СЦЕНАРИЙ 3 и СЦЕНАРИЙ 5: Цена идёт ПРОТИВ основной позиции к сильному уровню L1/L2 -> Ждём 3-фазный разворот -> Закрываем страховку в банк P_bank -> Усредняем основную ногу + ставим Re-Hedge Stop
      const maxAllowedDca = Math.min(3, Math.max(1, botConfig.max_dca_orders || 2));
      const isPrimaryOrStandalone = trade.campaign_role !== 'insurance';
      if (
        botConfig.dca_enabled &&
        isPrimaryOrStandalone &&
        (trade.dca_count || 0) < maxAllowedDca
      ) {
        // Определяем целевой сильный уровень L1 или L2 для усреднения
        let targetDcaLevelPrice = trade.next_dca_price || 0;
        const targetDcaLevelObj = Array.isArray(trade.planned_dca_levels)
          ? trade.planned_dca_levels.find((l) => !l.filled && l.step === (trade.dca_count || 0) + 1)
          : undefined;
        if (!targetDcaLevelPrice && targetDcaLevelObj && targetDcaLevelObj.price > 0) {
          targetDcaLevelPrice = targetDcaLevelObj.price;
        } else if (!targetDcaLevelPrice || targetDcaLevelPrice <= 0) {
          targetDcaLevelPrice = trade.is_short
            ? trade.resistance_level || 0
            : trade.support_level || 0;
        }

        if (targetDcaLevelPrice > 0) {
          const isNearOrPastDcaLevel = trade.is_short
            ? currentPrice >= targetDcaLevelPrice * 0.9965
            : currentPrice <= targetDcaLevelPrice * 1.0035;

          if (isNearOrPastDcaLevel) {
            // СЦЕНАРИЙ 3 (Раздел 3) и СЦЕНАРИЙ 5 (Новостной сквиз):
            // Если цена на новостном сквизе пробила первый уровень L1 без торможения и ушла глубже (ко второму уровню L2 или экстремуму паники),
            // проверяем 3-фазный разворот как на L1, так и на дальнем уровне L2 (где паника остановилась)!
            const isBounceFromSupport = !trade.is_short;
            // Правила разворота по данным истории 30 монет: усредняемся только если разворот идёт ПО дневному
            // тренду (основная нога совпадает с ним) и подтверждён ЗАКРЫТЫМИ свечами 4H. Развороты против
            // дневного тренда и 1H-свечные модели на истории преимущества не давали — на них не ставим.
            const reversalCtx = await getReversalContext(trade.pair);
            const dcaWithDailyTrend = trade.is_short
              ? reversalCtx.dailyDirection === 'DOWN'
              : reversalCtx.dailyDirection === 'UP';
            let reversalCheck = detectThreePhaseLevelReversal(
              reversalCtx.closed4h,
              targetDcaLevelPrice,
              isBounceFromSupport,
              0.75
            );
            const blewPastL1Squeeze = trade.is_short
              ? currentPrice >= targetDcaLevelPrice * 1.012
              : currentPrice <= targetDcaLevelPrice * 0.988;
            if (!reversalCheck.confirmed && blewPastL1Squeeze) {
              const deeperLevels: number[] = [];
              if (Array.isArray(trade.planned_dca_levels)) {
                for (const l of trade.planned_dca_levels) {
                  if (
                    !l.filled &&
                    l.price > 0 &&
                    (trade.is_short ? l.price > targetDcaLevelPrice : l.price < targetDcaLevelPrice)
                  ) {
                    deeperLevels.push(l.price);
                  }
                }
              }
              for (const deepLvlPrice of deeperLevels) {
                const deepRev = detectThreePhaseLevelReversal(
                  reversalCtx.closed4h,
                  deepLvlPrice,
                  isBounceFromSupport,
                  0.85
                );
                if (deepRev.confirmed) {
                  reversalCheck = {
                    ...deepRev,
                    reason: `[Сценарий 5: Новостной сквиз до дальнего уровня ${deepLvlPrice}$] ${deepRev.reason}`,
                  };
                  targetDcaLevelPrice = deepLvlPrice;
                  break;
                }
              }
            }

            if (reversalCheck.confirmed) {
              journalReversalSignal({
                pair: trade.pair,
                candles4h: reversalCtx.closed4h,
                side: isBounceFromSupport ? 'support' : 'resistance',
                level: targetDcaLevelPrice,
                purpose: 'dca',
                dailyDirection: reversalCtx.dailyDirection,
                withTrend: dcaWithDailyTrend,
                acted: dcaWithDailyTrend,
              });
            }
            if (reversalCheck.confirmed && !dcaWithDailyTrend) {
              const skipKey = trade.trade_id;
              if (Date.now() - (dcaRiskSkipLogTs.get(skipKey) || 0) > 30 * 60_000) {
                dcaRiskSkipLogTs.set(skipKey, Date.now());
                appendLog(
                  'freqtrade.bot.dca',
                  'INFO',
                  `⏸️ [${trade.pair}] #${trade.trade_id}: разворот у уровня ${targetDcaLevelPrice}$ есть, но он ПРОТИВ дневного тренда (${reversalCtx.dailyDirection === 'RANGE' ? 'дневной флэт' : 'дневной тренд ' + (reversalCtx.dailyDirection === 'UP' ? 'вверх' : 'вниз')}) — усреднение пропущено: на истории такие развороты не лучше случайных.`,
                  { userId: tradeUserId }
                );
              }
            }
            if (reversalCheck.confirmed && dcaWithDailyTrend) {
              const { compoundedBalance } = getCompoundedAccountBalance(tradeAcc.id);
              const accOpenTrades = tradesStore.filter(
                (t) => t.is_open && tradeMatchesAccount(t, tradeAcc, tradeAccScopeId)
              );
              const usedMargin = accOpenTrades.reduce((s, t) => s + (t.stake_amount || 0), 0);
              const otherActiveCoinsCount = new Set(
                accOpenTrades.filter((t) => t.pair !== trade.pair).map((t) => t.pair)
              ).size;
              const dcaPermission = canExecuteDca({
                pair: trade.pair,
                dcaCount: trade.dca_count || 0,
                initialAmount: trade.initial_amount || trade.amount,
                currentAmount: trade.amount,
                currentPrice,
                openRate: trade.open_rate,
                isShort: trade.is_short,
                leverage: trade.leverage || 25,
                totalBalanceUsdt: compoundedBalance,
                usedMarginUsdt: usedMargin,
                otherActiveCoinsCount,
                campaignRole: trade.campaign_role === 'insurance' ? 'insurance' : 'primary',
                hasOpenPrimarySibling: Boolean(openSibling && openSibling.campaign_role === 'primary'),
              });

              if (dcaPermission.allowed) {
                const dcaSizing = calculateDynamicDcaAmount({
                  currentAmount: trade.amount,
                  openRate: trade.open_rate,
                  currentPrice,
                  isShort: trade.is_short,
                  leverage: trade.leverage || 25,
                  totalBalanceUsdt: compoundedBalance,
                  usedMarginUsdt: usedMargin,
                  otherActiveCoinsCount,
                  maxPairMarginPct: botConfig.max_pair_margin_pct || 20,
                  minStakeUsdt: botConfig.min_stake_amount || 5,
                });

                if (dcaSizing.addStake > 0 && dcaSizing.addAmount > 0) {
                  // ШАГ 1 (Пункт 3.1): Если открыта страховочная позиция (Insurance) и она в плюсе — сначала фиксируем её прибыль в банк P_bank!
                  if (openSibling && openSibling.is_open && openSibling.campaign_role === 'insurance') {
                    const insLockKey = getPosLockKey(
                      openSibling.account_id || tradeAccScopeId,
                      openSibling.pair,
                      openSibling.is_short
                    );
                    await withPositionLock(insLockKey, async () => {
                      if (!openSibling.is_open) return;
                      const insExec = getTradeExecutionQuote(openSibling, true);
                      const insClosePrice =
                        insExec && insExec.executionPrice > 0
                          ? roundPrice(insExec.executionPrice)
                          : currentPrice;
                      const insCloseRes = await dispatchOrderToExchangeAccount(tradeAcc, {
                        pair: openSibling.pair,
                        action: 'CLOSE',
                        isShort: openSibling.is_short,
                        quantity: openSibling.amount,
                        referencePrice: insClosePrice,
                        leverage: openSibling.leverage || 25,
                      });
                      if (
                        tradeAcc &&
                        !isSimulatedTestApiKey(tradeAcc.api_key_raw) &&
                        !insCloseRes?.success
                      ) {
                        return;
                      }
                      const actualInsClose =
                        insCloseRes?.success && insCloseRes.price > 0
                          ? roundPrice(insCloseRes.price)
                          : insClosePrice;
                      const now = Date.now();
                      const nowStr = new Date(now).toISOString().replace('T', ' ').slice(0, 19);
                      sqliteDb.runInTransaction(() => {
                        openSibling.is_open = false;
                        openSibling.close_rate = actualInsClose;
                        openSibling.current_rate = actualInsClose;
                        openSibling.close_date = nowStr;
                        openSibling.close_timestamp = now;
                        openSibling.exit_reason = 'hedge_insurance_profit_harvest';
                        openSibling.trade_state = 'CLOSED';
                        openSibling.planned_dca_levels = [];
                        recalculateTradeMetrics(openSibling, false);
                        sqliteDb.upsertTrade(openSibling);

                        const harvestedProfit = Math.max(
                          0,
                          Number((openSibling.net_profit ?? openSibling.profit_abs ?? 0).toFixed(4))
                        );
                        trade.campaign_banked_profit = Number(
                          ((trade.campaign_banked_profit || 0) + harvestedProfit).toFixed(4)
                        );
                        sqliteDb.upsertTrade(trade);
                      });
                      broadcastTradeLifecycleEvent('trade:closed', openSibling);
                      appendLog(
                        'freqtrade.bot.hedge',
                        'INFO',
                        `💰 [Сценарий 3.1: Фиксация страховки] Страховочная нога #${openSibling.trade_id} [${openSibling.pair}] закрыта на уровне L${(trade.dca_count || 0) + 1} (${actualInsClose}$). В банк кампании P_bank зачислено: +${trade.campaign_banked_profit}$`,
                        { userId: tradeUserId }
                      );
                    });
                  }

                  // ШАГ 2 (Пункт 3.2): Усредняем основную позицию по рынку на подтверждённом развороте от уровня!
                  const primaryLockKey = getPosLockKey(
                    trade.account_id || tradeAccScopeId,
                    trade.pair,
                    trade.is_short
                  );
                  await withPositionLock(primaryLockKey, async () => {
                    if (!trade.is_open) return;
                    const dcaOrderRes = await dispatchOrderToExchangeAccount(tradeAcc, {
                      pair: trade.pair,
                      action: 'DCA',
                      isShort: trade.is_short,
                      quantity: dcaSizing.addAmount,
                      referencePrice: currentPrice,
                      leverage: trade.leverage || 25,
                    });
                    if (
                      tradeAcc &&
                      !isSimulatedTestApiKey(tradeAcc.api_key_raw) &&
                      !dcaOrderRes?.success
                    ) {
                      return;
                    }
                    const fillPrice =
                      dcaOrderRes?.success && dcaOrderRes.price > 0
                        ? roundPrice(dcaOrderRes.price)
                        : currentPrice;
                    const fillQty =
                      dcaOrderRes?.success && dcaOrderRes.qty > 0
                        ? dcaOrderRes.qty
                        : dcaSizing.addAmount;
                    const now = Date.now();
                    const nowStr = new Date(now).toISOString().replace('T', ' ').slice(0, 19);
                    const newStep = (trade.dca_count || 0) + 1;

                    sqliteDb.runInTransaction(() => {
                      const prevTotalQty = trade.amount;
                      const newTotalQty = Number((prevTotalQty + fillQty).toFixed(4));
                      const weightedAvgPrice =
                        (trade.open_rate * prevTotalQty + fillPrice * fillQty) /
                        Math.max(1e-8, newTotalQty);
                      trade.open_rate = roundPrice(weightedAvgPrice);
                      trade.amount = newTotalQty;
                      trade.stake_amount = Number(
                        (trade.stake_amount + dcaSizing.addStake).toFixed(2)
                      );
                      trade.dca_count = newStep;
                      trade.last_dca_date = nowStr;
                      trade.trade_state = 'DCA_ACTIVE';

                      // ШАГ 3 (Пункт 3.3): Ставим обязательный защитный стоп-ордер повторного хеджирования (Re-Hedge Stop) за тенью разворотной свечи!
                      trade.rehedge_stop_price = roundPrice(reversalCheck.rehedgeStopPrice);
                      trade.rehedge_stop_qty = Number((trade.amount * 0.5).toFixed(4));
                      trade.whipsaw_stop_price = roundPrice(reversalCheck.whipsawStopPrice);

                      if (!Array.isArray(trade.orders)) trade.orders = [];
                      trade.orders.push({
                        id: dcaOrderRes?.order_id || `ord-${trade.trade_id}-dca-${newStep}`,
                        step: newStep,
                        label: `Усреднение #${newStep} на уровне L${newStep} (3-фазный разворот)`,
                        side: trade.is_short ? 'short' : 'long',
                        price: fillPrice,
                        amount: fillQty,
                        stake_amount: dcaSizing.addStake,
                        timestamp: now,
                        date: nowStr,
                      });

                      if (Array.isArray(trade.planned_dca_levels)) {
                        const curLvl = trade.planned_dca_levels.find((l) => l.step === newStep);
                        if (curLvl) {
                          curLvl.filled = true;
                          curLvl.filled_at = nowStr;
                        }
                        const nextLvl = trade.planned_dca_levels.find(
                          (l) => !l.filled && l.step === newStep + 1
                        );
                        trade.next_dca_price = nextLvl ? nextLvl.price : undefined;
                      } else {
                        trade.next_dca_price = undefined;
                      }

                      recalculateTradeMetrics(trade, false);
                      if (!trade.tp_manual_override && trade.min_profitable_tp) {
                        trade.take_profit_abs = trade.min_profitable_tp;
                      }
                      sqliteDb.upsertTrade(trade);
                      sqliteDb.recordOrder({
                        trade_id: trade.trade_id,
                        pair: trade.pair,
                        order_type: 'market',
                        side: trade.is_short ? 'sell' : 'buy',
                        price: fillPrice,
                        amount: fillQty,
                        cost: dcaSizing.addStake,
                        fee: Number((fillPrice * fillQty * TAKER_FEE_RATE).toFixed(4)),
                        realized_pnl: 0,
                        action_type: 'DCA_REVERSAL_ENTRY',
                        notes: `DCA #${newStep} @ ${fillPrice}$ (${reversalCheck.reason}) | Новая средняя: ${trade.open_rate}$ | Выход P_exit: ${trade.min_profitable_tp}$ | Re-Hedge Stop: ${trade.rehedge_stop_price}$`,
                      });
                    });

                    appendLog(
                      'freqtrade.bot.dca',
                      'INFO',
                      `🔄 [Сценарий 3: Разворотное усреднение #${newStep}] [${trade.pair}] #${trade.trade_id} @ ${fillPrice}$ (${reversalCheck.reason}) | Новая средняя: ${trade.open_rate}$ | Точка схлопывания корзины P_exit: ${trade.min_profitable_tp}$ (P_bank=${trade.campaign_banked_profit || 0}$) | Защитный Re-Hedge Stop за тенью: ${trade.rehedge_stop_price}$`,
                      { userId: tradeUserId }
                    );
                    broadcastTradeLifecycleEvent('trade:updated', trade);
                  });
                }
              }
            }
          }
        }
      }

      sqliteDb.upsertTrade(trade);
    }

    // 2. Scan for new entries for any enabled account whose user has NOT stopped or paused new entries
    const entryEnabledAccounts = activeAccounts.filter(
      (acc) => !isUserNewEntriesPaused(acc.user_id || 'owner')
    );
    if (entryEnabledAccounts.length === 0) {
      return;
    }

    const { candles: btc1h } = await fetchRealCandles('BTC/USDT:USDT', '1h', 60);
    const btcGuard = checkBtcMarketHealth(btc1h);

    // Scan all active USDT-M Futures with volume >= $50M, prioritized by 24h price swing / volatility
    const candidatePairs = await fetchTopVolatileFuturesPairs(50_000_000);
    const openedPerAccount = new Map<string, number>();

    let scannedCount = 0;
    let openedInThisCycle = 0;
    for (const pair of candidatePairs) {
      if (blacklist.includes(pair)) continue;

      // Determine which enabled accounts are eligible to evaluate this pair
      const eligiblePreTradability = entryEnabledAccounts.filter((acc) => {
        if ((openedPerAccount.get(acc.id) || 0) >= 3) return false;
        const lastCd = cooldownPairs.get(`${acc.id}:${pair}`) || 0;
        if (Date.now() - lastCd < 3 * 60_000) return false;
        const accScopeId = getTargetAccountIdForRecord(acc);
        const accOpen = tradesStore.filter((t) => t.is_open && tradeMatchesAccount(t, acc, accScopeId));
        if (accOpen.some((t) => t.pair === pair)) return false;
        if (accOpen.length >= botConfig.max_open_trades) return false;
        const { compoundedBalance: accDeposit } = getCompoundedAccountBalance(acc.id);
        const accUsedMargin = accOpen.reduce((sum, t) => sum + t.stake_amount, 0);
        return accDeposit > 0 && (accUsedMargin / accDeposit) * 100 < 40.0;
      });

      if (eligiblePreTradability.length === 0) {
        // Stop early if every active account has hit max_open_trades or per-cycle cap
        const anyAccountCanStillOpenMore = entryEnabledAccounts.some((acc) => {
          if ((openedPerAccount.get(acc.id) || 0) >= 3) return false;
          const accScopeId = getTargetAccountIdForRecord(acc);
          const accOpenCount = tradesStore.filter(
            (t) => t.is_open && tradeMatchesAccount(t, acc, accScopeId)
          ).length;
          return accOpenCount < botConfig.max_open_trades;
        });
        if (!anyAccountCanStillOpenMore) break;
        continue;
      }

      // Check exchange tradability once per distinct (exchange, is_testnet)
      const tradableByNet = new Map<string, boolean>();
      const eligibleAccounts: ExchangeAccountRecord[] = [];
      for (const acc of eligiblePreTradability) {
        const netKey = `${acc.exchange}:${Boolean(acc.is_testnet)}`;
        let ok = tradableByNet.get(netKey);
        if (ok === undefined) {
          ok = await isPairTradableOnExchange(pair, acc.exchange, acc.is_testnet);
          tradableByNet.set(netKey, ok);
        }
        if (ok) eligibleAccounts.push(acc);
      }
      if (eligibleAccounts.length === 0) continue;

      scannedCount++;
      if (scannedCount > 24) break;

      // Top-Down Анализ: 1W (300 свечей) -> 1D (1000 свечей) -> 4H (1000 свечей) -> 1H (500 свечей) — единые ключи кэша с getOrComputeMtfBotLevels
      const [{ candles: c1w }, { candles: c1h }, { candles: c4h }, { candles: c1d }] =
        await Promise.all([
          fetchRealCandles(pair, '1w', 300),
          fetchRealCandles(pair, botConfig.timeframe, 500),
          fetchRealCandles(pair, '4h', 1000),
          fetchRealCandles(pair, '1d', 1000),
        ]);
      if (c1h.length < 35 || c4h.length < 25) continue;

      const wsRefTick = getFuturesExecutionPrice(pair, false, false, eligibleAccounts[0]?.exchange);
      const livePrice =
        wsRefTick && wsRefTick.markPrice > 0
          ? wsRefTick.markPrice
          : c1h[c1h.length - 1].close;
      const pairLevels = await getOrComputeMtfBotLevels(pair, botConfig.timeframe);
      const manualSupLvl =
        pairLevels.find((l) => l.role === 'support' && l.manual_override) ||
        pairLevels.find((l) => l.role === 'support');
      const manualResLvl =
        pairLevels.find((l) => l.role === 'resistance' && l.manual_override) ||
        pairLevels.find((l) => l.role === 'resistance');

      const mtf = analyzeMultiTimeframe(
        pair,
        c1h,
        c4h,
        c1d,
        {
          support: manualSupLvl?.manual_override ? manualSupLvl.price : undefined,
          resistance: manualResLvl?.manual_override ? manualResLvl.price : undefined,
        },
        c1w
      );

      const customSup = manualSupLvl?.price || mtf.key_4h_support;
      const customRes = manualResLvl?.price || mtf.key_4h_resistance;

      const hedgeEval = evaluateGlobalHedgeStrategy(c1h, c4h, c1d, mtf, btcGuard.isSafe, c1w);
      if (hedgeEval.level_bounce) {
        // Отбой от сильного уровня по дневному тренду (закрытые 4H) — в журнал сигналов разворота
        journalReversalSignal({
          pair,
          candles4h: c4h.slice(0, -1),
          side: hedgeEval.level_bounce.side,
          level: hedgeEval.level_bounce.level,
          purpose: 'entry',
          dailyDirection: mtf.market_regime?.d1.direction || 'RANGE',
          withTrend: true,
          acted: hedgeEval.should_open_hedge,
        });
      }
      const effectiveTrend = mtf.market_trend || 'NEUTRAL';

      sqliteDb.recordSignal({
        pair,
        signal_type: 'MTF_SCAN',
        direction: hedgeEval.should_open_hedge
          ? `hedge_${hedgeEval.primary_side}`
          : effectiveTrend === 'BEARISH'
          ? 'short'
          : effectiveTrend === 'BULLISH'
          ? 'long'
          : mtf.d1_trend.toLowerCase(),
        confidence: hedgeEval.should_open_hedge ? 0.92 : 0.65,
        price: livePrice,
        reason: `Асимметричный 2:1 Хедж [${pair}]: Приоритет=${hedgeEval.dominant_trend} (Основная 1.0x=${hedgeEval.primary_side.toUpperCase()}, Страховка 0.5x=${hedgeEval.insurance_side.toUpperCase()}) | Global Sup=${roundPrice(customSup)} Res=${roundPrice(customRes)} | Статус=${hedgeEval.should_open_hedge ? hedgeEval.reason : hedgeEval.reason}`,
      });

      // ЕДИНСТВЕННАЯ ОСНОВНАЯ СТРАТЕГИЯ БОТА: «Асимметричный уровневый хедж с разворотным усреднением» (Разделы 1–7 Регламента).
      // Бот открывает ТОЛЬКО асимметричный двусторонний замок 2:1 (Основная нога 1.0x по приоритету + Страховочная нога 0.5x против приоритета)
      // строго в середине диапазона между сильными уровнями (25%..75%) либо сразу после подтверждённого 3-фазного отбоя от сильного уровня!
      for (const acc of eligibleAccounts) {
        const accScopeId = getTargetAccountIdForRecord(acc);
        const accOpen = tradesStore.filter((t) => t.is_open && tradeMatchesAccount(t, acc, accScopeId));
        if (accOpen.some((t) => t.pair === pair)) continue;
        if (accOpen.length + 2 > botConfig.max_open_trades) continue;
        const { compoundedBalance: accDeposit } = getCompoundedAccountBalance(acc.id);
        const accUsedMargin = accOpen.reduce((sum, t) => sum + t.stake_amount, 0);
        if (accDeposit <= 0 || (accUsedMargin / accDeposit) * 100 >= 40.0) continue;

        if (!hedgeEval.should_open_hedge) continue;

        try {
          await openHedgeCampaign(pair, livePrice, mtf, c4h, c1d, {
            accountId: acc.id,
            accountName: acc.name,
            horizon: hedgeEval.horizon,
            longTpPrice: hedgeEval.long_tp_price,
            shortTpPrice: hedgeEval.short_tp_price,
            primarySide: hedgeEval.primary_side,
            candles1w: c1w,
          });
          openedPerAccount.set(acc.id, (openedPerAccount.get(acc.id) || 0) + 2);
          openedInThisCycle += 2;
        } catch (entryErr: any) {
          cooldownPairs.set(`${acc.id}:${pair}`, Date.now());
          appendLog(
            'freqtrade.bot.entry',
            'WARNING',
            `⚠️ Не удалось открыть сделку [${pair}] (${acc.name}): ${entryErr?.message || 'Ошибка биржи'}`,
            { userId: acc.user_id || 'owner' }
          );
        }
      }
    }

    if (scannedCount > 0) {
      const totalOpenAfter = tradesStore.filter((t) => t.is_open).length;
      appendLog(
        'freqtrade.scanner',
        'INFO',
        `🔍 Цикл авто-анализа завершён: проверено ${scannedCount} пар | Открыто за цикл: ${openedInThisCycle} | Активных аккаунтов: ${activeAccounts.length} | Всего активных сделок в системе: ${totalOpenAfter}`,
        { publicMarket: true }
      );
    }
  } catch (err) {
    console.error('Error in runScalpBotCycle:', err);
  } finally {
    isBotCycleRunning = false;
  }
}

async function openHedgeCampaign(
  pair: string,
  entryPrice: number,
  mtf: ReturnType<typeof analyzeMultiTimeframe>,
  candles4h: RawCandle[],
  candles1d: RawCandle[],
  customOpts?: {
    accountId?: string;
    accountName?: string;
    stake?: number;
    leverage?: number;
    skipClientSync?: boolean;
    horizon?: 'MEDIUM_TERM_4H' | 'LONG_TERM_1D';
    longTpPrice?: number;
    shortTpPrice?: number;
    primarySide?: 'long' | 'short';
    candles1w?: RawCandle[];
  }
): Promise<{ longTrade: FreqtradeTrade; shortTrade: FreqtradeTrade | null }> {
  const cleanPair = pair.toUpperCase();
  const targetAcc = resolveExchangeAccountRecord(customOpts?.accountId || 'master');
  if (!targetAcc || !targetAcc.enabled) {
    throw new Error('Целевой биржевой аккаунт не подключён или поставлен на паузу');
  }
  const targetUserId = targetAcc.user_id || 'owner';
  const campaignId = `hedge-${cleanPair.split(':')[0].replace('/', '')}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
  const horizonTag = customOpts?.horizon === 'LONG_TERM_1D' ? '1D_LongTerm_Hedge' : '4H_MedTerm_Hedge';
  const hedgeTimeframe = customOpts?.horizon === 'LONG_TERM_1D' ? '1d' : '4h';

  // 1. Check/enable Hedge Mode ONLY for the target account and pre-load pair levels in parallel
  const targetCreds = getAccountCredentialsFromStore(targetAcc);
  const [targetHedgeStatus, preloadedPairLevels] = await Promise.all([
    targetCreds ? ensureExchangeHedgeMode(targetCreds, cleanPair) : Promise.resolve({ enabled: true, message: 'No creds' }),
    getOrComputeMtfBotLevels(cleanPair, hedgeTimeframe, false, targetUserId),
  ]);

  const canOpenBothSides =
    !targetCreds || isSimulatedTestApiKey(targetCreds.apiKey) || (targetHedgeStatus?.enabled ?? true);

  if (!canOpenBothSides) {
    const fallbackSide: 'long' | 'short' =
      customOpts?.primarySide ||
      (mtf.market_regime?.primary_side || (mtf.d1_trend === 'BEARISH' || mtf.d1_trend === 'MILD_BEARISH' ? 'short' : 'long'));
    appendLog(
      'freqtrade.bot.hedge',
      'WARNING',
      `⚠️ [${cleanPair}] (${targetAcc.name}) На бирже активен режим One-Way Mode (${targetHedgeStatus?.message || 'переключение на Hedge Mode требует закрытия текущих сделок'}). Открываю среднесрочную сделку по тренду (${fallbackSide.toUpperCase()}) без схлопывания.`,
      { userId: targetUserId }
    );
    const singleTrade = await createScalpBotPosition(
      cleanPair,
      fallbackSide,
      entryPrice,
      mtf,
      candles4h,
      candles1d,
      fallbackSide === 'short' ? `${horizonTag}_Short` : `${horizonTag}_Long`,
      {
        ...customOpts,
        accountId: targetAcc.id,
        accountName: customOpts?.accountName || targetAcc.name,
        customTp: fallbackSide === 'short' ? customOpts?.shortTpPrice : customOpts?.longTpPrice,
        campaignId,
        preloadedPairLevels,
        strategyName: 'GlobalHedgeStrategy',
        timeframeOverride: hedgeTimeframe,
      }
    );
    return { longTrade: singleTrade, shortTrade: null };
  }

  // Определяем доминирующий тренд старшего ТФ для асимметричного замка 2:1 (Раздел 1 и 2Б Регламента)
  // Сторона основной ноги — по режиму рынка (дневной тренд, подтверждённый 4H). Если направления нет
  // (флэт/конфликт — бывает только при ручном входе), берём дневной тренд без перекоса в шорт.
  const regimeSide = mtf.market_regime?.primary_side;
  const dominantBearish = regimeSide
    ? regimeSide === 'short'
    : mtf.d1_trend === 'BEARISH' || mtf.d1_trend === 'MILD_BEARISH';
  const primarySide: 'long' | 'short' =
    customOpts?.primarySide || (dominantBearish ? 'short' : 'long');
  const longRole: 'primary' | 'insurance' = primarySide === 'long' ? 'primary' : 'insurance';
  const shortRole: 'primary' | 'insurance' = primarySide === 'short' ? 'primary' : 'insurance';

  const { compoundedBalance: accEquity } = getCompoundedAccountBalance(targetAcc.id);
  const basePrimaryStake =
    customOpts?.stake && customOpts.stake > 0
      ? customOpts.stake
      : Math.max(botConfig.min_stake_amount || 5, Number((accEquity * 0.005).toFixed(2)));
  const halfInsuranceStake = Number((basePrimaryStake * 0.5).toFixed(2));
  const longStake = longRole === 'primary' ? basePrimaryStake : halfInsuranceStake;
  const shortStake = shortRole === 'primary' ? basePrimaryStake : halfInsuranceStake;

  appendLog(
    'freqtrade.bot.hedge',
    'INFO',
    `⚖️ [Асимметричный Хедж 2:1] (${targetAcc.name}) Открываю кампанию ${campaignId} [${cleanPair}] @ ${entryPrice}$: Основная нога ${primarySide.toUpperCase()} (1.0x = ${basePrimaryStake}$) + Страховочная нога ${primarySide === 'long' ? 'SHORT' : 'LONG'} (0.5x = ${halfInsuranceStake}$)`,
    { userId: targetUserId }
  );

  // 2. Open LONG and SHORT in parallel with 2:1 asymmetric stake sizing
  const [longTrade, shortTrade] = await Promise.all([
    createScalpBotPosition(
      cleanPair,
      'long',
      entryPrice,
      mtf,
      candles4h,
      candles1d,
      `${horizonTag}_Long_${longRole === 'primary' ? 'Primary1x' : 'Insurance0.5x'}`,
      {
        ...customOpts,
        accountId: targetAcc.id,
        accountName: customOpts?.accountName || targetAcc.name,
        stake: longStake,
        customTp: customOpts?.longTpPrice,
        campaignId,
        campaignRole: longRole,
        preloadedPairLevels,
        strategyName: 'GlobalHedgeStrategy',
        timeframeOverride: hedgeTimeframe,
      }
    ),
    createScalpBotPosition(
      cleanPair,
      'short',
      entryPrice,
      mtf,
      candles4h,
      candles1d,
      `${horizonTag}_Short_${shortRole === 'primary' ? 'Primary1x' : 'Insurance0.5x'}`,
      {
        ...customOpts,
        accountId: targetAcc.id,
        accountName: customOpts?.accountName || targetAcc.name,
        stake: shortStake,
        customTp: customOpts?.shortTpPrice,
        campaignId,
        campaignRole: shortRole,
        preloadedPairLevels,
        strategyName: 'GlobalHedgeStrategy',
        timeframeOverride: hedgeTimeframe,
      }
    ),
  ]);

  return { longTrade, shortTrade };
}

async function createScalpBotPosition(
  pair: string,
  side: 'long' | 'short',
  entryPrice: number,
  mtf: ReturnType<typeof analyzeMultiTimeframe>,
  candles4h: RawCandle[],
  candles1d: RawCandle[],
  enterTag: string,
  customOpts?: {
    stake?: number;
    leverage?: number;
    customTp?: number;
    customSl?: number;
    campaignId?: string;
    campaignRole?: 'primary' | 'insurance' | 'standalone';
    whipsawStopPrice?: number;
    accountId?: string;
    accountName?: string;
    isCopyChild?: boolean;
    parentTradeId?: number;
    skipClientSync?: boolean;
    preloadedPairLevels?: Awaited<ReturnType<typeof getOrComputeMtfBotLevels>>;
    strategyName?: string;
    timeframeOverride?: string;
    candles1w?: RawCandle[];
  }
): Promise<FreqtradeTrade> {
  const targetExchangeAcc = resolveExchangeAccountRecord(customOpts?.accountId || 'master');
  if (!targetExchangeAcc || !targetExchangeAcc.enabled) {
    throw new Error('Бот не может открывать сделки без подключенного и активного биржевого аккаунта');
  }

  const cleanPair = pair.toUpperCase();
  const isShort = side === 'short';
  const liveExQuote = getFuturesExecutionPrice(
    cleanPair,
    isShort,
    false,
    targetExchangeAcc.exchange
  );
  let entryRate = roundPrice(
    liveExQuote && liveExQuote.executionPrice > 0
      ? liveExQuote.executionPrice
      : liveExQuote && liveExQuote.markPrice > 0
      ? liveExQuote.markPrice
      : entryPrice
  );
  const targetAccId = getTargetAccountIdForRecord(targetExchangeAcc);
  const targetUserId = targetExchangeAcc.user_id || 'owner';
  const accLockKey = getPosLockKey(targetExchangeAcc.id, cleanPair, isShort);

  const createdTrade = await withPositionLock(accLockKey, async () => {
    // Защита от дублирования: не открывать вторую сделку в ту же сторону на одной и той же монете для одного аккаунта
    const existingSameSide = tradesStore.find(
      (t) =>
        t.is_open &&
        tradeMatchesAccount(t, targetExchangeAcc, targetAccId) &&
        t.pair === cleanPair &&
        t.is_short === isShort
    );
    if (existingSameSide) {
      if (customOpts?.campaignId && existingSameSide.campaign_id !== customOpts.campaignId) {
        existingSameSide.campaign_id = customOpts.campaignId;
        if (customOpts.strategyName) {
          existingSameSide.strategy = customOpts.strategyName;
        }
        sqliteDb.upsertTrade(existingSameSide);
      }
      return existingSameSide;
    }

    const { compoundedBalance: totalDeposit } = getCompoundedAccountBalance(targetExchangeAcc.id);
    // Dynamic compounded stake: strictly 0.5% of THIS account's own wallet equity
    const dynamicStake = Math.max(
      botConfig.min_stake_amount || 5,
      Number((totalDeposit * 0.005).toFixed(2))
    );

    const stake =
      customOpts?.stake && customOpts.stake > 0 ? customOpts.stake : dynamicStake;
    const leverage =
      customOpts?.leverage && customOpts.leverage >= 1
        ? Math.round(customOpts.leverage)
        : (targetExchangeAcc.max_leverage || botConfig.leverage || 25);

    const notional = stake * leverage;
    let amount = Number((notional / Math.max(1e-8, entryRate)).toFixed(4));

    // Отправляем реальный рыночный ордер (OPEN) на подключенную биржу (Binance Futures / Bybit / BingX и др.)
    const primaryOrderRes = await dispatchOrderToExchangeAccount(targetExchangeAcc, {
      pair: cleanPair,
      action: 'OPEN',
      isShort,
      quantity: amount,
      referencePrice: entryRate,
      leverage,
    });

    if (
      targetExchangeAcc &&
      !isSimulatedTestApiKey(targetExchangeAcc.api_key_raw) &&
      !primaryOrderRes?.success
    ) {
      throw new Error(
        primaryOrderRes?.error ||
          `Биржа ${targetExchangeAcc.exchange.toUpperCase()} отклонила ордер на открытие сделки [${cleanPair}]`
      );
    }

    if (primaryOrderRes?.success && !primaryOrderRes.is_simulated_test) {
      if (primaryOrderRes.qty > 0) amount = primaryOrderRes.qty;
      if (primaryOrderRes.price > 0) entryRate = roundPrice(primaryOrderRes.price);
    }

    const [base, quote] = cleanPair.split(':')[0].split('/');
    const id = nextTradeId++;
    const now = Date.now();
    const nowStr = new Date(now).toISOString().replace('T', ' ').slice(0, 19);

    const hasCustomTp = Boolean(customOpts?.customTp && customOpts.customTp > 0);
    const hasCustomSl = Boolean(customOpts?.customSl && customOpts.customSl > 0);

    // Загружаем актуальные уровни бота (или используем уже предзагруженные уровни при параллельном открытии 2-стороннего хеджа)
    const activePairLevels =
      customOpts?.preloadedPairLevels ??
      (await getOrComputeMtfBotLevels(cleanPair, botConfig.timeframe, false, targetUserId));
    const manualSupLvl = activePairLevels.find(
      (l) => l.role === 'support' && l.manual_override && !l.id.startsWith('lvl-') && l.price < entryRate
    );
    const manualResLvl = activePairLevels.find(
      (l) => l.role === 'resistance' && l.manual_override && !l.id.startsWith('lvl-') && l.price > entryRate
    );
    const manualDcaSupLvl =
      manualSupLvl && (entryRate - manualSupLvl.price) / Math.max(1e-8, entryRate) >= 0.028
        ? manualSupLvl
        : undefined;
    const manualDcaResLvl =
      manualResLvl && (manualResLvl.price - entryRate) / Math.max(1e-8, entryRate) >= 0.028
        ? manualResLvl
        : undefined;
    const effectiveSup = manualSupLvl ? manualSupLvl.price : roundPrice(mtf.key_4h_support);
    const effectiveRes = manualResLvl ? manualResLvl.price : roundPrice(mtf.key_4h_resistance);

    const isGlobalHedge = Boolean(
      customOpts?.campaignId || customOpts?.strategyName === 'GlobalHedgeStrategy'
    );

    // Тейк-профит: если не задан явно (хедж передаёт свой), — 1.25 ATR(4H) от фактической цены входа или ближайший
    // уровень по ходу − 0.35 ATR (что ближе), не ближе 0.8%. Ручной уровень пользователя учитывается как цель.
    let rawTp: number;
    let tpHorizon: string;
    let tpReason: string;
    if (hasCustomTp) {
      rawTp = Number(customOpts!.customTp);
      tpHorizon = 'MANUAL';
      tpReason = 'Целевой уровень TP кампании';
    } else {
      const tpTarget = computeTakeProfitTarget({
        entry: entryRate,
        isShort,
        atr: closedCandlesAtr(candles4h),
        levels: isShort
          ? [manualSupLvl?.price, effectiveSup, ...(mtf.chart_targets_short || []).map((c) => c.level_price || c.price)]
          : [manualResLvl?.price, effectiveRes, ...(mtf.chart_targets_long || []).map((c) => c.level_price || c.price)],
      });
      rawTp = tpTarget.price;
      tpHorizon = tpTarget.source;
      tpReason = tpTarget.reason;
    }
    const targetTp = roundPrice(rawTp);
    const computedTpPct = Number(
      ((Math.abs(targetTp - entryRate) / Math.max(1e-8, entryRate)) * 100).toFixed(2)
    );

    const resolvedStrategyName =
      customOpts?.strategyName || (isGlobalHedge ? 'GlobalHedgeStrategy' : 'ScalpingStrategy');
    const resolvedTimeframe =
      customOpts?.timeframeOverride || (isGlobalHedge ? '4h' : botConfig.timeframe);
    const planNotes = `${side.toUpperCase()} [${resolvedStrategyName}] | 1D: ${mtf.d1_trend} | 4H: ${mtf.h4_trend} | ${isShort ? `Global Res: ${effectiveRes}` : `Global Sup: ${effectiveSup}`} | TP (${tpHorizon}): ${targetTp} [${tpReason}]`;

    const initialOrderEntry: TradeOrderEntry & { commission_usdt?: number } = {
      id: primaryOrderRes?.order_id || `ord-${id}-0`,
      step: 0,
      label: `Нач. вход #1 (${isShort ? 'Шорт' : 'Лонг'} · ${resolvedStrategyName})`,
      side: isShort ? 'short' : 'long',
      price: entryRate,
      amount,
      stake_amount: stake,
      timestamp: now,
      date: nowStr,
    };
    if (primaryOrderRes?.commission_usdt && primaryOrderRes.commission_usdt > 0) {
      initialOrderEntry.commission_usdt = Number(primaryOrderRes.commission_usdt.toFixed(4));
    }

    const resolvedCampaignRole: 'primary' | 'insurance' | 'standalone' =
      customOpts?.campaignRole || (customOpts?.campaignId ? 'primary' : 'standalone');

    // Для основной позиции (primary / standalone) рассчитываем до 2 глобальных уровней усреднения (L1 и L2) на сильных зонах П/С 4H/1D
    const plannedDcaLevels: NonNullable<FreqtradeTrade['planned_dca_levels']> = [];
    if (botConfig.dca_enabled && resolvedCampaignRole !== 'insurance') {
      const dcaLvl1 = findStrongestDcaLevel(
        candles4h,
        candles1d,
        entryRate,
        isShort,
        2.6,
        95.0,
        customOpts?.candles1w
      );
      const l1Price = manualDcaSupLvl && !isShort
        ? roundPrice(manualDcaSupLvl.price)
        : manualDcaResLvl && isShort
        ? roundPrice(manualDcaResLvl.price)
        : roundPrice(dcaLvl1.price);

      if (l1Price > 0) {
        const l1Stake = Number((stake * 1.0).toFixed(2));
        const l1Amount = Number(((l1Stake * leverage) / Math.max(1e-8, l1Price)).toFixed(4));
        plannedDcaLevels.push({
          step: 1,
          label: `L1 Усреднение #1 (${dcaLvl1.source || '4H/1D S/R'} · сила ${dcaLvl1.strength_score || 16}★)`,
          price: l1Price,
          stake_amount: l1Stake,
          amount: l1Amount,
          distance_pct: Number(((Math.abs(l1Price - entryRate) / Math.max(1e-8, entryRate)) * 100).toFixed(2)),
          filled: false,
        });

        // Глобальный уровень экстренной разгрузки L2 (Раздел 5В / Табу №1: максимум 2 усреднения за цикл)
        const l2Price = roundPrice(dcaLvl1.second_price || 0);
        if (l2Price > 0 && Math.abs(l2Price - l1Price) / Math.max(1e-8, l1Price) >= 0.02) {
          const l2Stake = Number((stake * 1.5).toFixed(2));
          const l2Amount = Number(((l2Stake * leverage) / Math.max(1e-8, l2Price)).toFixed(4));
          plannedDcaLevels.push({
            step: 2,
            label: `L2 Экстренная разгрузка #2 (${dcaLvl1.source || '1D/1W S/R'})`,
            price: l2Price,
            stake_amount: l2Stake,
            amount: l2Amount,
            distance_pct: Number(((Math.abs(l2Price - entryRate) / Math.max(1e-8, entryRate)) * 100).toFixed(2)),
            filled: false,
          });
        }
      }
    }

    const newTrade: FreqtradeTrade = {
      trade_id: id,
      pair: cleanPair,
      base_currency: base || 'ETH',
      quote_currency: quote || 'USDT',
      is_open: true,
      is_short: isShort,
      exchange: targetExchangeAcc.exchange || 'binance',
      amount,
      initial_amount: amount,
      stake_amount: stake,
      initial_stake: stake,
      strategy: resolvedStrategyName,
      timeframe: resolvedTimeframe,
      enter_tag: enterTag || (isShort ? 'Short' : 'Long'),
      open_date: nowStr,
      open_timestamp: now,
      open_rate: entryRate,
      initial_open_rate: entryRate,
      dca_count: 0,
      last_dca_date: null,
      current_rate: entryRate,
      close_date: null,
      close_timestamp: null,
      close_rate: null,
      profit_ratio: 0,
      profit_pct: 0,
      profit_abs: 0,
      fee_open:
        primaryOrderRes?.commission_usdt && primaryOrderRes.commission_usdt > 0
          ? Number(primaryOrderRes.commission_usdt.toFixed(4))
          : undefined,
      take_profit_abs: targetTp,
      take_profit_pct: computedTpPct,
      tp_manual_override: hasCustomTp,
      tp_horizon: tpHorizon,
      tp_reason: tpReason,
      stop_loss_abs: hasCustomSl ? roundPrice(Number(customOpts!.customSl)) : 0,
      stop_loss_pct: -3.0,
      sl_manual_override: hasCustomSl,
      initial_stop_loss_abs: hasCustomSl
        ? roundPrice(Number(customOpts!.customSl))
        : roundPrice(isShort ? mtf.recommended_sl_short : mtf.recommended_sl_long),
      initial_stop_loss_pct: -3.0,
      exit_reason: null,
      leverage,
      support_level: effectiveSup,
      resistance_level: effectiveRes,
      next_dca_price: plannedDcaLevels[0]?.price,
      trade_state: 'WAITING_PULLBACK',
      pullback_min_profit_pct: 0.5,
      plan_notes: planNotes,
      campaign_id: customOpts?.campaignId,
      campaign_role: resolvedCampaignRole,
      whipsaw_stop_price: customOpts?.whipsawStopPrice,
      user_id: targetUserId,
      account_id: targetAccId,
      account_name: customOpts?.accountName || targetExchangeAcc.name || 'Main',
      orders: [initialOrderEntry],
      planned_dca_levels: plannedDcaLevels,
    };

    sqliteDb.runInTransaction(() => {
      recalculateTradeMetrics(newTrade, false);
      if (!hasCustomTp && newTrade.min_profitable_tp && newTrade.min_profitable_tp > 0) {
        newTrade.take_profit_abs = newTrade.is_short
          ? Math.min(newTrade.take_profit_abs || newTrade.min_profitable_tp, newTrade.min_profitable_tp)
          : Math.max(newTrade.take_profit_abs || newTrade.min_profitable_tp, newTrade.min_profitable_tp);
        recalculateTradeMetrics(newTrade, false);
      }

      tradesStore.unshift(newTrade);
      sqliteDb.upsertTrade(newTrade);

      // Нативный лимитный TP на биржу ставится ТОЛЬКО для одиночных сделок без активного замка (!newTrade.campaign_id),
      // чтобы биржа не закрыла одну ногу замка на голом касании уровня без 3-фазного разворота (Раздел 3, Сценарий 1 и Сценарий 2)!
      const targetCreds = getAccountCredentialsFromStore(targetExchangeAcc);
      if (
        targetCreds &&
        !isSimulatedTestApiKey(targetCreds.apiKey) &&
        !newTrade.campaign_id &&
        newTrade.campaign_role !== 'insurance' &&
        newTrade.take_profit_abs > 0
      ) {
        const safeExchangeTp =
          !newTrade.tp_manual_override && newTrade.min_profitable_tp
            ? newTrade.is_short
              ? Math.min(newTrade.take_profit_abs, newTrade.min_profitable_tp)
              : Math.max(newTrade.take_profit_abs, newTrade.min_profitable_tp)
            : newTrade.take_profit_abs;
        placeOrUpdateExchangeTakeProfitOrder(targetCreds, {
          pair: cleanPair,
          isShort,
          quantity: newTrade.amount,
          takeProfitPrice: safeExchangeTp,
        }).catch(() => {});
      }
      sqliteDb.recordOrder({
        trade_id: id,
        pair: cleanPair,
        order_type: 'market',
        side: isShort ? 'sell' : 'buy',
        price: entryRate,
        amount,
        cost: stake,
        fee: newTrade.fee_open || Number((entryRate * amount * TAKER_FEE_RATE).toFixed(4)),
        realized_pnl: 0,
        action_type: 'INITIAL_ENTRY',
        notes: planNotes,
      });
      sqliteDb.recordSignal({
        pair: cleanPair,
        signal_type: 'ENTRY',
        direction: side,
        confidence: 0.88,
        price: entryRate,
        reason: planNotes,
      });
    });

    appendLog(
      'freqtrade.bot',
      'INFO',
      `🟢 Открыта позиция #${id} [${cleanPair}] (${targetExchangeAcc.name}) ${isShort ? 'SHORT' : 'LONG'} ${leverage}x @ ${entryRate}$ | Маржа 0.5%: ${stake}$ (депозит $${totalDeposit}) | TP (${tpHorizon}): ${newTrade.take_profit_abs}$ [${tpReason}]`,
      { userId: targetUserId }
    );

    subscribePairKlineStream(cleanPair, botConfig.timeframe || '1h');
    broadcastTradeLifecycleEvent('trade:opened', newTrade);
    return newTrade;
  });

  if (!customOpts?.skipClientSync) {
    syncRealExchangeBalancesIfNeeded(true).catch(() => {});
  }
  return createdTrade;
}

// Ограничение перебора паролей и кодов на /api/v1/auth/login: 5 неудачных попыток за 15 минут с одного IP
const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 15 * 60_000;
const failedLoginAttempts = new Map<string, { count: number; firstAt: number }>();

function getLoginBlockRemainingMs(ip: string): number {
  const entry = failedLoginAttempts.get(ip);
  if (!entry) return 0;
  const elapsed = Date.now() - entry.firstAt;
  if (elapsed >= LOGIN_WINDOW_MS) {
    failedLoginAttempts.delete(ip);
    return 0;
  }
  return entry.count >= LOGIN_MAX_FAILURES ? LOGIN_WINDOW_MS - elapsed : 0;
}

function registerFailedLogin(ip: string): void {
  const now = Date.now();
  const entry = failedLoginAttempts.get(ip);
  if (!entry || now - entry.firstAt >= LOGIN_WINDOW_MS) {
    failedLoginAttempts.set(ip, { count: 1, firstAt: now });
  } else {
    entry.count += 1;
  }
  if (failedLoginAttempts.size > 10_000) {
    for (const [key, val] of failedLoginAttempts) {
      if (now - val.firstAt >= LOGIN_WINDOW_MS) failedLoginAttempts.delete(key);
    }
  }
}

async function startServer() {
  const app = express();
  // За прокси хостинга (Render, Railway) реальный IP клиента приходит в X-Forwarded-For.
  // Без trust proxy все посетители выглядят как один IP прокси, и 5 чужих ошибок входа блокируют вход всем.
  // Локально заголовку не доверяем, чтобы лимит нельзя было обойти подменой IP.
  const behindHostingProxy = Boolean(
    process.env.RENDER ||
      process.env.RAILWAY_ENVIRONMENT ||
      process.env.RAILWAY_ENVIRONMENT_NAME ||
      process.env.RAILWAY_PROJECT_ID ||
      process.env.TRUST_PROXY === 'true'
  );
  if (behindHostingProxy) {
    app.set('trust proxy', 1);
  }
  app.use(express.json());

  initializeBotTrades().catch(console.error);
  setInterval(() => {
    const hasRealActiveAccount = exchangeAccountsStore.some(
      (a) => a.enabled && !isSimulatedTestApiKey(a.api_key_raw)
    );
    if (hasRealActiveAccount) {
      triggerBackgroundExchangeSync(false);
    }
  }, 5_000);

  setInterval(() => {
    const hasRealActiveAccount = exchangeAccountsStore.some(
      (a) => a.enabled && !isSimulatedTestApiKey(a.api_key_raw)
    );
    if (hasRealActiveAccount) {
      runScalpBotCycle().catch(() => {});
    }
  }, 8_000);

  // Исходы сигналов разворота: раз в 10 минут проверяем, что стало с ценой после сигнала
  setInterval(() => {
    resolvePendingReversalSignals().catch(() => {});
  }, 10 * 60_000);
  setTimeout(() => {
    resolvePendingReversalSignals().catch(() => {});
  }, 60_000);

  app.get('/api/v1/ping', (_req, res) => {
    res.json({ status: 'pong' });
  });

  // Журнал сигналов разворота бота: что он видел, на что действовал и чем это закончилось
  app.get('/api/v1/reversal_journal', (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const pair = req.query.pair ? String(req.query.pair).toUpperCase() : undefined;
    const journal = sqliteDb.getReversalJournal(pair, 30);
    const all = pair ? sqliteDb.getReversalJournal(undefined, 0) : journal;
    res.json({
      pair: pair || null,
      horizon_bars: REVERSAL_JOURNAL_HORIZON,
      groups: journal.groups,
      all_groups: all.groups,
      recent: journal.rows,
    });
  });

  interface ResolvedAuth {
    authenticated: boolean;
    userId: string;
    role: 'owner' | 'client';
    login?: string;
    accountId?: string;
    inviteId?: string;
  }

  function resolveScopeUserId(scopeOrAccountOrUserId?: string): string | null {
    if (!scopeOrAccountOrUserId) return null;
    if (scopeOrAccountOrUserId === 'owner' || scopeOrAccountOrUserId === 'master') {
      return 'owner';
    }
    if (
      scopeOrAccountOrUserId.startsWith('invite:') ||
      scopeOrAccountOrUserId.startsWith('account:')
    ) {
      return scopeOrAccountOrUserId;
    }
    const acc = exchangeAccountsStore.find((a) => a.id === scopeOrAccountOrUserId);
    return acc ? acc.user_id || 'owner' : null;
  }

  function resolveAuthFromCredentials(params: {
    token?: string;
    clientCode?: string;
    accountId?: string;
  }): ResolvedAuth {
    const code = String(params.clientCode || '').trim().toUpperCase();
    if (code && code.length >= 6) {
      const byCode = exchangeAccountsStore.find(
        (a) =>
          a.client_access_code.toUpperCase() === code &&
          (a.user_id || 'owner') !== 'owner' &&
          !a.is_owner
      );
      if (byCode) {
        const uId = byCode.user_id || `account:${byCode.id}`;
        return {
          authenticated: true,
          userId: uId,
          role: 'client',
          login: byCode.name,
          accountId: byCode.id,
        };
      }
    }

    const token = String(params.token || '').trim();
    if (token) {
      const verified = sqliteDb.verifyAuthToken(token);
      if (verified.valid) {
        if (verified.role === 'owner') {
          return {
            authenticated: true,
            userId: 'owner',
            role: 'owner',
            login: verified.login,
            inviteId: verified.inviteId,
          };
        }
        if (verified.userId && verified.userId !== 'owner') {
          return {
            authenticated: true,
            userId: verified.userId,
            role: 'client',
            login: verified.login,
            inviteId: verified.inviteId,
            accountId: verified.accountId,
          };
        }
        if (verified.inviteId) {
          return {
            authenticated: true,
            userId: `invite:${verified.inviteId}`,
            role: 'client',
            login: verified.login,
            inviteId: verified.inviteId,
          };
        }
        if (verified.accountId) {
          const acc = exchangeAccountsStore.find((a) => a.id === verified.accountId);
          if (acc && (acc.user_id || 'owner') !== 'owner' && !acc.is_owner) {
            return {
              authenticated: true,
              userId: acc.user_id || `account:${verified.accountId}`,
              role: 'client',
              login: verified.login || acc.name,
              accountId: verified.accountId,
            };
          }
        }
      }
    }

    const cfg = sqliteDb.getSiteAuthConfig();
    if (!cfg.require_login) {
      const reqAccId = String(params.accountId || '').trim();
      if (reqAccId && reqAccId !== 'master') {
        const byId = exchangeAccountsStore.find((a) => a.id === reqAccId);
        if (byId) {
          const uId = byId.user_id || 'owner';
          return {
            authenticated: true,
            userId: uId,
            role: uId === 'owner' ? 'owner' : 'client',
            login: byId.name,
            accountId: byId.id,
          };
        }
      }
      return {
        authenticated: true,
        userId: 'owner',
        role: 'owner',
        login: cfg.owner_login,
      };
    }

    return {
      authenticated: false,
      userId: '',
      role: 'client',
    };
  }

  function resolveInviteSessionUserId(
    consumed: { id: string; role: 'owner' | 'client'; label: string },
    existingBearerToken?: string
  ): string {
    if (consumed.role === 'owner') return 'owner';
    if (existingBearerToken) {
      const verified = sqliteDb.verifyAuthToken(existingBearerToken);
      if (
        verified.valid &&
        verified.role === 'client' &&
        verified.inviteId === consumed.id &&
        verified.userId &&
        verified.userId.startsWith(`invite:${consumed.id}`)
      ) {
        return verified.userId;
      }
    }
    return `invite:${consumed.id}:${crypto.randomBytes(6).toString('hex')}`;
  }

  function resolveRequestAuth(req: express.Request): ResolvedAuth {
    const authHeader = String(req.headers.authorization || '');
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const clientCode = String(req.query.code || req.query.client || '').trim();
    const reqAccId = String(req.query.account_id || '').trim();
    return resolveAuthFromCredentials({ token, clientCode, accountId: reqAccId });
  }

  function requireAuth(req: express.Request, res: express.Response): ResolvedAuth | null {
    const auth = resolveRequestAuth(req);
    if (!auth.authenticated) {
      res.status(401).json({ error: 'Требуется авторизация' });
      return null;
    }
    return auth;
  }

  function requireOwner(req: express.Request, res: express.Response): ResolvedAuth | null {
    const auth = requireAuth(req, res);
    if (!auth) return null;
    if (auth.role !== 'owner') {
      res.status(403).json({ error: 'Доступно только владельцу терминала' });
      return null;
    }
    return auth;
  }

  function getAccountsForUser(auth: {
    userId: string;
    role?: 'owner' | 'client';
    accountId?: string;
  }): ExchangeAccountRecord[] {
    if (auth.role === 'client' && auth.accountId) {
      return exchangeAccountsStore.filter((a) => a.id === auth.accountId);
    }
    return exchangeAccountsStore.filter((a) => (a.user_id || 'owner') === auth.userId);
  }

  function filterTradesForUserScope(auth: {
    userId: string;
    role?: 'owner' | 'client';
    accountId?: string;
  }): FreqtradeTrade[] {
    const userAccs = getAccountsForUser(auth);
    if (userAccs.length === 0) {
      return [];
    }
    const connectedAt = userAccs.reduce((minTs, a) => {
      const ts = a.connected_at || 0;
      if (ts <= 0) return minTs;
      return minTs === 0 ? ts : Math.min(minTs, ts);
    }, 0);

    return tradesStore.filter((t) => {
      if (resolveTradeUserId(t) !== auth.userId) return false;
      if (auth.role === 'client' && auth.accountId && t.account_id !== auth.accountId) {
        return false;
      }
      if (t.is_open) return true;
      if (t.enter_tag === 'EXCHANGE_HISTORY' || t.exit_reason === 'exchange_closed_pnl') {
        return false;
      }
      const closedTs = t.close_timestamp || 0;
      if (connectedAt > 0 && closedTs > 0 && closedTs < connectedAt - 1000) {
        return false;
      }
      return true;
    });
  }

  function getCompoundedBalanceForUser(
    userAccs: ExchangeAccountRecord[],
    scopedTrades: FreqtradeTrade[]
  ): {
    baseDeposit: number;
    closedNetProfit: number;
    compoundedBalance: number;
  } {
    const enabledAccs = userAccs.filter((a) => a.enabled);
    if (enabledAccs.length === 0) {
      return { baseDeposit: 0, closedNetProfit: 0, compoundedBalance: 0 };
    }
    let sumWallet = 0;
    let sumBaseDep = 0;
    let sumClosedProfit = 0;
    let anySim = false;
    for (const a of enabledAccs) {
      const wBal = Number(a.wallet_balance_usdt ?? a.balance_usdt ?? 0);
      const targetId = getTargetAccountIdForRecord(a);
      const aClosed = scopedTrades
        .filter((t) => !t.is_open && tradeMatchesAccount(t, a, targetId))
        .reduce((s, t) => s + (t.net_profit ?? t.profit_abs ?? 0), 0);
      const isReal = Boolean(a.api_key_raw && !isSimulatedTestApiKey(a.api_key_raw));
      if (!isReal) anySim = true;
      sumWallet += wBal;
      sumClosedProfit += aClosed;
      sumBaseDep += isReal ? inferInitialDeposit(a, wBal, aClosed) : wBal;
    }
    return {
      baseDeposit: Number(sumBaseDep.toFixed(2)),
      closedNetProfit: Number(sumClosedProfit.toFixed(2)),
      compoundedBalance: Number(
        Math.max(0, anySim ? sumWallet + sumClosedProfit : sumWallet).toFixed(2)
      ),
    };
  }

  function getAggregatedMetricsForUser(
    userAccs: ExchangeAccountRecord[],
    openTrades: FreqtradeTrade[],
    closedTrades: FreqtradeTrade[]
  ) {
    const enabledAccs = userAccs.filter((a) => a.enabled);
    const compounded = getCompoundedBalanceForUser(userAccs, [...openTrades, ...closedTrades]);
    const localUsedStake = Number(openTrades.reduce((acc, t) => acc + t.stake_amount, 0).toFixed(2));
    const localOpenPnl = Number(openTrades.reduce((acc, t) => acc + t.profit_abs, 0).toFixed(4));

    if (enabledAccs.length === 0) {
      return {
        compounded,
        baseDeposit: 0,
        totalBalance: 0,
        openProfitAbs: localOpenPnl,
        equityBalance: Number(localOpenPnl.toFixed(4)),
        usedStake: localUsedStake,
        freeBalance: 0,
      };
    }

    let sumWallet = 0;
    let sumOpenPnl = 0;
    let sumUsedStake = 0;
    let sumFree = 0;
    let sumExchangeEquity = 0;
    let allEquityFromExchange = true;
    let anySim = false;
    for (const a of enabledAccs) {
      const aIsReal = Boolean(a.api_key_raw && !isSimulatedTestApiKey(a.api_key_raw));
      if (!aIsReal) anySim = true;
      const aTargetId = getTargetAccountIdForRecord(a);
      const aOpen = openTrades.filter((t) => tradeMatchesAccount(t, a, aTargetId));
      const wBal = Number(a.wallet_balance_usdt ?? a.balance_usdt ?? 0);
      const aLocalUsed = aOpen.reduce(
        (s, t) =>
          s +
          sanitizePositionMarginUsdt(
            Number(t.stake_amount || 0),
            Number(t.amount || 0),
            Number(t.open_rate || 0),
            Number(t.leverage || a.max_leverage || 25)
          ),
        0
      );
      const aLocalPnl = aOpen.reduce((s, t) => s + t.profit_abs, 0);
      const sanitizedAccUsed = sanitizeWalletUsedMarginUsdt(
        Number(a.used_margin_usdt || 0),
        wBal,
        aLocalUsed,
        aOpen.length
      );
      if (typeof a.used_margin_usdt === 'number' && Math.abs(a.used_margin_usdt - sanitizedAccUsed) > 1.0) {
        a.used_margin_usdt = sanitizedAccUsed;
      }
      const aUsed =
        aIsReal && sanitizedAccUsed > 0
          ? sanitizedAccUsed
          : aLocalUsed;
      // Для реального ключа (включая Testnet) плавающий PnL счёта берём 1 в 1 с биржи:
      // сумма локальных сделок могла отличаться (другой источник цен, ручные позиции, неполный список).
      const aPnl =
        aIsReal && typeof a.unrealized_pnl === 'number' && Number.isFinite(a.unrealized_pnl)
          ? a.unrealized_pnl
          : aOpen.length > 0
          ? aLocalPnl
          : 0;
      if (
        aIsReal &&
        typeof a.equity_usdt === 'number' &&
        Number.isFinite(a.equity_usdt) &&
        a.equity_usdt > 0
      ) {
        sumExchangeEquity += a.equity_usdt;
      } else {
        allEquityFromExchange = false;
      }
      const computedFree = Math.max(0, wBal + Math.min(0, aPnl) - aUsed);
      const aFree =
        aIsReal &&
        typeof a.available_balance_usdt === 'number' &&
        Number.isFinite(a.available_balance_usdt) &&
        a.available_balance_usdt >= 0 &&
        a.available_balance_usdt <= wBal + Math.max(0, aPnl) + 1.0
          ? a.available_balance_usdt
          : computedFree;
      sumWallet += wBal;
      sumOpenPnl += aPnl;
      sumUsedStake += aUsed;
      sumFree += aFree;
    }

    const totalBalance = anySim
      ? Number(compounded.compoundedBalance.toFixed(2))
      : Number(sumWallet.toFixed(4));
    const openProfitAbs = Number(sumOpenPnl.toFixed(4));
    const freeBalance = anySim
      ? Number(Math.max(0, totalBalance - sumUsedStake).toFixed(2))
      : Number(sumFree.toFixed(2));
    return {
      compounded,
      baseDeposit: compounded.baseDeposit,
      totalBalance,
      openProfitAbs,
      // Эквити (Margin Balance) — как показывает биржа, если она его отдала по всем реальным счетам
      equityBalance:
        !anySim && allEquityFromExchange
          ? Number(sumExchangeEquity.toFixed(4))
          : Number((totalBalance + openProfitAbs).toFixed(4)),
      usedStake: Number(sumUsedStake.toFixed(2)),
      freeBalance,
    };
  }

  // ============================================================================
  // АВТОРИЗАЦИЯ ВЛАДЕЛЬЦА САЙТА (ЧЕРЕЗ СЕКРЕТЫ) И ДОСТУП ПО ССЫЛКЕ (?invite=...)
  // ============================================================================
  app.get('/api/v1/auth/status', (req, res) => {
    const cfg = sqliteDb.getSiteAuthConfig();
    const authHeader = String(req.headers.authorization || '');
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

    // 1. Если передан ?invite=... в URL, проверяем пригласительную ссылку
    const inviteParam = String(req.query.invite || '').trim();
    if (inviteParam) {
      const consumed = sqliteDb.consumeInviteToken(inviteParam);
      if (consumed) {
        const uId = resolveInviteSessionUserId(consumed, token);
        const sessionToken = sqliteDb.createAuthToken({
          role: consumed.role,
          login: consumed.label,
          inviteId: consumed.id,
          userId: uId,
        });
        appendLog(
          'freqtrade.auth',
          'INFO',
          `Вход по персональной ссылке доступа: ${consumed.label} (роль: ${consumed.role})`,
          { userId: uId }
        );
        res.json({
          require_login: true,
          password_changed: cfg.password_changed,
          has_env_secrets: cfg.has_env_secrets,
          authenticated: true,
          role: consumed.role,
          login: consumed.label,
          user_id: uId,
          token: sessionToken,
        });
        return;
      }
    }

    // 2. Если передан ?client=... или ?code=... в URL, проверяем ссылку клиента
    const clientParam = String(req.query.client || req.query.code || '').trim().toUpperCase();
    if (clientParam) {
      const acc = sqliteDb.verifyClientAccessCode(clientParam);
      if (acc) {
        const uId = acc.user_id || `account:${acc.id}`;
        const sessionToken = sqliteDb.createAuthToken({
          role: 'client',
          login: acc.name,
          accountId: acc.id,
          userId: uId,
        });
        appendLog(
          'freqtrade.auth',
          'INFO',
          `Вход по персональному коду аккаунта: ${acc.name} (${String(acc.exchange).toUpperCase()}, код: ${acc.client_access_code})`,
          { userId: uId }
        );
        res.json({
          require_login: true,
          password_changed: cfg.password_changed,
          has_env_secrets: cfg.has_env_secrets,
          authenticated: true,
          role: 'client',
          login: acc.name,
          account_id: acc.id,
          user_id: uId,
          client_code: acc.client_access_code,
          token: sessionToken,
        });
        return;
      }
    }

    const verified = token ? sqliteDb.verifyAuthToken(token) : { valid: false };

    if (!cfg.require_login) {
      res.json({
        require_login: false,
        password_changed: cfg.password_changed,
        has_env_secrets: cfg.has_env_secrets,
        owner_login: cfg.owner_login,
        authenticated: true,
        role: 'owner',
        user_id: 'owner',
        login: cfg.owner_login,
      });
      return;
    }

    if (verified.valid) {
      let clientCode: string | undefined;
      let accountId = verified.accountId;
      let userId = verified.role === 'owner' ? 'owner' : verified.userId || 'client:unknown';
      if (verified.role === 'client') {
        if (!verified.userId && verified.inviteId) {
          userId = `invite:${verified.inviteId}`;
        } else if (verified.accountId) {
          const acc = exchangeAccountsStore.find((a) => a.id === verified.accountId);
          if (acc) {
            clientCode = acc.client_access_code;
            if (!verified.userId) userId = acc.user_id || `account:${verified.accountId}`;
          }
        }
        if (!clientCode) {
          const userAcc = exchangeAccountsStore.find((a) => (a.user_id || 'owner') === userId);
          if (userAcc) {
            clientCode = userAcc.client_access_code;
            if (!accountId) accountId = userAcc.id;
          }
        }
      }
      res.json({
        require_login: true,
        password_changed: cfg.password_changed,
        has_env_secrets: cfg.has_env_secrets,
        owner_login: verified.role === 'owner' ? cfg.owner_login : undefined,
        authenticated: true,
        role: verified.role || 'owner',
        user_id: userId,
        login: verified.login || cfg.owner_login,
        account_id: accountId,
        client_code: clientCode,
      });
      return;
    }

    // Неавторизованный посетитель — не раскрываем логин владельца
    res.json({
      require_login: true,
      password_changed: cfg.password_changed,
      has_env_secrets: cfg.has_env_secrets,
      authenticated: false,
    });
  });

  app.post('/api/v1/auth/login', (req, res) => {
    const clientIp = String(req.ip || req.socket.remoteAddress || 'unknown');
    const blockedForMs = getLoginBlockRemainingMs(clientIp);
    if (blockedForMs > 0) {
      res.setHeader('Retry-After', String(Math.ceil(blockedForMs / 1000)));
      res.status(429).json({
        error: `Слишком много неудачных попыток входа. Повторите через ${Math.ceil(blockedForMs / 60_000)} мин.`,
      });
      return;
    }
    // Любой ответ 401 из этого обработчика считается неудачной попыткой; успешный вход сбрасывает счётчик
    res.on('finish', () => {
      if (res.statusCode === 401) registerFailedLogin(clientIp);
      else if (res.statusCode === 200) failedLoginAttempts.delete(clientIp);
    });

    const { mode = 'owner', login, password, access_code, invite_token } = req.body || {};
    const authHeader = String(req.headers.authorization || '');
    const existingBearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

    if (mode === 'invite') {
      const consumed = sqliteDb.consumeInviteToken(String(invite_token || ''));
      if (!consumed) {
        res.status(401).json({ error: 'Ссылка доступа недействительна или отозвана владельцем' });
        return;
      }
      const uId = resolveInviteSessionUserId(consumed, existingBearer);
      const token = sqliteDb.createAuthToken({
        role: consumed.role,
        login: consumed.label,
        inviteId: consumed.id,
        userId: uId,
      });
      appendLog(
        'freqtrade.auth',
        'INFO',
        `Вход по персональной ссылке доступа: ${consumed.label} (${consumed.role})`,
        { userId: uId }
      );
      res.json({
        authenticated: true,
        role: consumed.role,
        user_id: uId,
        login: consumed.label,
        token,
      });
      return;
    }

    if (mode === 'client') {
      const acc = sqliteDb.verifyClientAccessCode(String(access_code || ''));
      if (!acc) {
        res.status(401).json({ error: 'Неверный код доступа' });
        return;
      }
      const uId = acc.user_id || `account:${acc.id}`;
      const token = sqliteDb.createAuthToken({
        role: 'client',
        login: String(acc.name || 'Пользователь'),
        accountId: String(acc.id),
        userId: uId,
      });
      appendLog(
        'freqtrade.auth',
        'INFO',
        `Вход по коду доступа аккаунта: ${acc.name} (${String(acc.exchange).toUpperCase()})`,
        { userId: uId }
      );
      res.json({
        authenticated: true,
        role: 'client',
        user_id: uId,
        login: String(acc.name),
        account_id: String(acc.id),
        token,
      });
      return;
    }

    const ok = sqliteDb.verifyOwnerCredentials(String(login || ''), String(password || ''));
    if (!ok) {
      res.status(401).json({ error: 'Неверный логин или пароль владельца' });
      return;
    }
    const cfg = sqliteDb.getSiteAuthConfig();
    const token = sqliteDb.createAuthToken({
      role: 'owner',
      login: cfg.owner_login,
    });
    appendLog('freqtrade.auth', 'INFO', `Выполнен вход владельца терминала (${cfg.owner_login})`, {
      userId: 'owner',
    });
    res.json({
      authenticated: true,
      role: 'owner',
      user_id: 'owner',
      login: cfg.owner_login,
      owner_login: cfg.owner_login,
      password_changed: cfg.password_changed,
      has_env_secrets: cfg.has_env_secrets,
      require_login: cfg.require_login,
      token,
    });
  });

  app.get('/api/v1/auth/invites', (req, res) => {
    const auth = requireOwner(req, res);
    if (!auth) return;
    res.json({ invites: sqliteDb.listInviteLinks() });
  });

  app.post('/api/v1/auth/invites', (req, res) => {
    const auth = requireOwner(req, res);
    if (!auth) return;
    const { label = 'Гостевой доступ', role = 'client' } = req.body || {};
    const invite = sqliteDb.createInviteLink(
      String(label),
      role === 'owner' ? 'owner' : 'client'
    );
    appendLog(
      'freqtrade.auth',
      'INFO',
      `Создана ссылка доступа для "${invite.label}" (роль: ${invite.role})`,
      { userId: 'owner' }
    );
    res.json({ invite, invites: sqliteDb.listInviteLinks() });
  });

  app.delete('/api/v1/auth/invites/:id', (req, res) => {
    const auth = requireOwner(req, res);
    if (!auth) return;
    const id = String(req.params.id);
    sqliteDb.deleteInviteLink(id);
    appendLog('freqtrade.auth', 'WARNING', `Отозвана и удалена ссылка доступа #${id}`, {
      userId: 'owner',
    });
    res.json({ removed_id: id, invites: sqliteDb.listInviteLinks() });
  });

  app.patch('/api/v1/auth/settings', (req, res) => {
    const cfg = sqliteDb.getSiteAuthConfig();
    if (cfg.require_login) {
      const auth = requireOwner(req, res);
      if (!auth) return;
    }

    const { new_login, new_password, require_login } = req.body || {};
    const updated = sqliteDb.updateOwnerCredentials({
      newLogin: new_login !== undefined ? String(new_login) : undefined,
      newPassword: new_password !== undefined ? String(new_password) : undefined,
      requireLogin: require_login !== undefined ? Boolean(require_login) : undefined,
    });
    const freshToken = sqliteDb.createAuthToken({
      role: 'owner',
      login: updated.owner_login,
    });
    appendLog(
      'freqtrade.auth',
      'INFO',
      `Обновлены настройки безопасности сайта: логин=${updated.owner_login}, вход по паролю=${updated.require_login ? 'ВКЛ' : 'ВЫКЛ'}`,
      { userId: 'owner' }
    );
    res.json({
      ...updated,
      token: freshToken,
    });
  });

  app.get('/api/v1/show_config', (req, res) => {
    const auth = resolveRequestAuth(req);
    const userAccs = auth.authenticated ? getAccountsForUser(auth) : [];
    const activeUserAccs = userAccs.filter((a) => a.enabled);
    const userConnected = activeUserAccs.length > 0;
    const anyConnected = hasConnectedExchangeAccount();
    const userStopped = auth.authenticated ? isUserBotStopped(auth.userId) : ownerManuallyStoppedBot;
    const userPausedEntries = auth.authenticated
      ? isUserNewEntriesPaused(auth.userId)
      : Boolean(botConfig.pause_new_entries);
    const userBalance = Number(
      activeUserAccs.reduce((s, a) => s + Number(a.wallet_balance_usdt ?? a.balance_usdt ?? 0), 0).toFixed(2)
    );

    if (!anyConnected) {
      botConfig.state = 'stopped';
    }
    res.json({
      ...botConfig,
      state: userConnected && !userStopped ? 'running' : 'stopped',
      pause_new_entries: userPausedEntries,
      starting_balance: userConnected ? userBalance : 0,
      exchange_connected: userConnected,
      active_accounts_count: activeUserAccs.length,
      available_strategies: ['ScalpingStrategy', 'GlobalHedgeStrategy'],
      available_timeframes: ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '1w'],
    });
  });

  app.get('/api/v1/mtf_analysis', async (req, res) => {
    const pair = String(req.query.pair || 'ETH/USDT:USDT').toUpperCase();
    const [{ candles: c1w }, { candles: c1d }, { candles: c4h }, { candles: c1h }] =
      await Promise.all([
        fetchRealCandles(pair, '1w', 300),
        fetchRealCandles(pair, '1d', 1000),
        fetchRealCandles(pair, '4h', 1000),
        fetchRealCandles(pair, '1h', 250),
      ]);
    const mtf = analyzeMultiTimeframe(pair, c1h, c4h, c1d, undefined, c1w);
    const { candles: btcCandles } = await fetchRealCandles('BTC/USDT:USDT', '1h', 60);
    const btcGuard = checkBtcMarketHealth(btcCandles);
    const strategyEval =
      c1h.length >= 30
        ? evaluateScalpingStrategy(
            c1h,
            mtf.key_4h_support,
            mtf.key_4h_resistance,
            mtf.institutional_levels
          )
        : null;
    res.json({
      pair,
      mtf,
      btc_guard: btcGuard,
      strategy_signal: strategyEval,
    });
  });

  // Режим рынка по паре: тренд 1D (фон) и 4H (фаза), можно ли входить и в какую сторону — с объяснением
  app.get('/api/v1/trend', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const pair = String(req.query.pair || 'BTC/USDT:USDT').toUpperCase();
    try {
      const [{ candles: c1d }, { candles: c4h }] = await Promise.all([
        fetchRealCandles(pair, '1d', 1000),
        fetchRealCandles(pair, '4h', 1000),
      ]);
      const d1 = assessTimeframeTrend(c1d, '1D');
      const h4 = assessTimeframeTrend(c4h, '4H');
      res.json({ pair, ...assessMarketRegime(d1, h4), updated_at: Date.now() });
    } catch (err: any) {
      res.status(500).json({ error: `Не удалось определить тренд: ${err?.message || err}` });
    }
  });

  // Разбор истории монеты: все подходы к уровням на графике — чем закончились (разворот/пробой) и что было перед этим
  app.get('/api/v1/reversal_history', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const pair = String(req.query.pair || 'BTC/USDT:USDT').toUpperCase();
    const timeframe = String(req.query.timeframe || '4h');
    try {
      const [{ candles }, { candles: c1d }] = await Promise.all([
        fetchRealCandles(pair, timeframe, 1000),
        fetchRealCandles(pair, '1d', 1000),
      ]);
      res.json({ pair, ...analyzeReversalHistory(candles, c1d, timeframe) });
    } catch (err: any) {
      res.status(500).json({ error: `Не удалось разобрать историю: ${err?.message || err}` });
    }
  });

  app.get('/api/v1/volatile_scan', async (req, res) => {
    const minVol = Number(req.query.min_volume) || 50_000_000;
    const limit = Math.min(25, Math.max(1, Number(req.query.limit) || 10));
    const pairs = await fetchTopVolatileFuturesPairs(minVol);
    const topSlice = pairs.slice(0, limit);
    const analyzed = await Promise.all(
      topSlice.map(async (pair) => {
        const ticker = tickerCache.get(pair);
        const [{ candles: c1w }, { candles: c1d }, { candles: c4h }, { candles: c1h }] =
          await Promise.all([
            fetchRealCandles(pair, '1w', 300),
            fetchRealCandles(pair, '1d', 1000),
            fetchRealCandles(pair, '4h', 1000),
            fetchRealCandles(pair, '1h', 100),
          ]);
        const mtf = analyzeMultiTimeframe(pair, c1h, c4h, c1d, undefined, c1w);
        const sig =
          c1h.length >= 30
            ? evaluateScalpingStrategy(
                c1h,
                mtf.key_4h_support,
                mtf.key_4h_resistance,
                mtf.institutional_levels
              )
            : null;
        const swing24h =
          ticker && ticker.low24h > 0
            ? Number((((ticker.high24h - ticker.low24h) / ticker.low24h) * 100).toFixed(2))
            : 0;
        return {
          pair,
          price: ticker?.price || (c1h[c1h.length - 1]?.close ?? 0),
          volume24h_usdt: ticker?.volume24h || 0,
          change24h_pct: ticker?.change24h || 0,
          swing24h_pct: swing24h,
          d1_trend: mtf.d1_trend,
          h4_trend: mtf.h4_trend,
          h1_trend: mtf.h1_trend,
          market_trend: mtf.market_trend,
          market_regime: mtf.market_regime?.regime,
          market_regime_summary: mtf.market_regime?.summary,
          allow_long: mtf.allow_long,
          allow_short: mtf.allow_short,
          key_4h_support: roundPrice(mtf.key_4h_support),
          key_4h_resistance: roundPrice(mtf.key_4h_resistance),
          recommended_tp_long: roundPrice(mtf.recommended_tp_long),
          recommended_tp_short: roundPrice(mtf.recommended_tp_short),
          enter_long: Boolean(sig?.enter_long),
          enter_short: Boolean(sig?.enter_short),
          enter_tag: sig?.enter_tag || '',
        };
      })
    );
    res.json({
      min_volume_usdt: minVol,
      total_qualified_pairs: pairs.length,
      analyzed_count: analyzed.length,
      pairs: analyzed,
    });
  });

  app.post('/api/v1/scan_cycle', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    if (!hasConnectedExchangeAccount(auth.userId)) {
      res.status(400).json({
        error: 'Бот не может запускать цикл анализа без подключенной биржи.',
        state: 'stopped',
      });
      return;
    }
    await runScalpBotCycle(true);
    const userOpen = filterTradesForUserScope(auth).filter((t) => t.is_open).length;
    res.json({
      status: 'completed',
      state: !isUserBotStopped(auth.userId) ? 'running' : 'stopped',
      open_trades_count: userOpen,
    });
  });

  // Полная симуляция сбоя/перезапуска памяти сервера с холодным восстановлением из trades.sqlite и доанализом открытых позиций
  app.post('/api/v1/simulate_crash_recovery', async (req, res) => {
    const auth = requireOwner(req, res);
    if (!auth) return;
    tradesStore = [];
    exchangeAccountsStore = [];
    botLevelsStore.clear();
    chartDrawingsStore.clear();
    candleCache.clear();
    initializedTrades = false;
    await initializeBotTrades();
    const realEnabledAccs = exchangeAccountsStore.filter(
      (a) => a.enabled && a.api_key_raw && !isSimulatedTestApiKey(a.api_key_raw)
    );
    if (realEnabledAccs.length > 0) {
      await Promise.all(realEnabledAccs.map((a) => syncPositionsAndHistoryFromExchanges(a, true)));
    }
    res.json({
      status: 'recovered_from_sqlite',
      state: botConfig.state,
      restored_trades_count: tradesStore.length,
      open_owner_trades: tradesStore.filter((t) => t.is_open && resolveTradeUserId(t) === 'owner')
        .length,
      averaged_owner_trades: tradesStore.filter(
        (t) => t.is_open && resolveTradeUserId(t) === 'owner' && (t.dca_count || 0) > 0
      ).length,
      accounts_count: exchangeAccountsStore.length,
    });
  });

  app.get('/api/orders', (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    res.json(sqliteDb.getRecentOrders(150, auth.userId));
  });

  app.get('/api/analytics/pnl', (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    res.json(sqliteDb.getPnlAnalytics(auth.userId));
  });

  app.get('/api/signals', (req, res) => {
    const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 50));
    res.json(sqliteDb.getRecentSignals(limit));
  });

  app.get('/api/v1/status', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    await initializeBotTrades();
    if (req.query.sync === 'true') {
      await syncRealExchangeBalancesIfNeeded(true);
    } else {
      triggerBackgroundExchangeSync(false);
    }
    const scopedTrades = filterTradesForUserScope(auth);
    for (const t of scopedTrades) {
      if (t.is_open) {
        refreshTradeLivePriceFromWs(t);
        recalculateTradeMetrics(t);
      }
    }
    res.json(scopedTrades.filter((t) => t.is_open));
  });

  app.get('/api/v1/trades/open', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    await initializeBotTrades();
    const scopedTrades = filterTradesForUserScope(auth);
    for (const t of scopedTrades) {
      if (t.is_open) {
        refreshTradeLivePriceFromWs(t);
        recalculateTradeMetrics(t);
      }
    }
    res.json(scopedTrades.filter((t) => t.is_open));
  });

  app.get('/api/v1/trades', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    await initializeBotTrades();
    if (req.query.sync === 'true') {
      await syncRealExchangeBalancesIfNeeded(true);
    } else {
      triggerBackgroundExchangeSync(false);
    }
    const scopedTrades = filterTradesForUserScope(auth);
    const closed = scopedTrades.filter((t) => !t.is_open);
    res.json({
      trades: closed,
      trades_count: closed.length,
      total_trades: closed.length,
    });
  });

  app.get('/api/v1/profit', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    await initializeBotTrades();
    if (req.query.sync === 'true') {
      await syncRealExchangeBalancesIfNeeded(true);
    } else {
      triggerBackgroundExchangeSync(false);
    }
    const userAccs = getAccountsForUser(auth);
    const scopedTrades = filterTradesForUserScope(auth);
    for (const t of scopedTrades) {
      if (t.is_open) {
        refreshTradeLivePriceFromWs(t);
        recalculateTradeMetrics(t, false);
      }
    }
    const open = scopedTrades.filter((t) => t.is_open);
    const closed = scopedTrades.filter((t) => !t.is_open);
    const closedProfitAbs = Number(
      closed.reduce((acc, t) => acc + (t.net_profit ?? t.profit_abs ?? 0), 0).toFixed(4)
    );
    const metrics = getAggregatedMetricsForUser(userAccs, open, closed);
    const openProfitAbs = metrics.openProfitAbs;
    const allProfitAbs = Number((closedProfitAbs + openProfitAbs).toFixed(4));
    const totalFeesUsdt = Number(
      scopedTrades
        .reduce((acc, t) => acc + (t.fee_total ?? (t.fee_open || 0) + (t.fee_close || 0)), 0)
        .toFixed(4)
    );
    const closedFeesUsdt = Number(
      closed
        .reduce((acc, t) => acc + (t.fee_total ?? (t.fee_open || 0) + (t.fee_close || 0)), 0)
        .toFixed(4)
    );
    const wins = closed.filter((t) => (t.net_profit ?? t.profit_abs) >= 0).length;
    const losses = closed.filter((t) => (t.net_profit ?? t.profit_abs) < 0).length;
    const winrate = closed.length > 0 ? Number(((wins / closed.length) * 100).toFixed(1)) : 0;

    const baseDeposit = metrics.baseDeposit;
    const exactWalletBalance = metrics.totalBalance;
    const exactEquity = metrics.equityBalance;

    res.json({
      profit_closed_coin: closedProfitAbs,
      profit_closed_percent: baseDeposit > 0 ? Number(((closedProfitAbs / baseDeposit) * 100).toFixed(2)) : 0,
      profit_closed_fiat: closedProfitAbs,
      profit_all_coin: allProfitAbs,
      profit_all_percent: baseDeposit > 0 ? Number(((allProfitAbs / baseDeposit) * 100).toFixed(2)) : 0,
      profit_all_fiat: allProfitAbs,
      profit_open_coin: openProfitAbs,
      profit_open_percent: baseDeposit > 0 ? Number(((openProfitAbs / baseDeposit) * 100).toFixed(2)) : 0,
      total_fees_usdt: totalFeesUsdt,
      closed_fees_usdt: closedFeesUsdt,
      trade_count: scopedTrades.length,
      closed_trade_count: closed.length,
      open_trade_count: open.length,
      winning_trades: wins,
      losing_trades: losses,
      winrate,
      expectancy: 0,
      max_drawdown: 0,
      max_drawdown_abs: 0,
      best_pair: closed[0]?.pair || open[0]?.pair || 'ETH/USDT:USDT',
      best_rate: 0,
      starting_balance: baseDeposit,
      current_balance: exactWalletBalance,
      wallet_balance: exactWalletBalance,
      equity_balance: exactEquity,
      unrealized_pnl: openProfitAbs,
    });
  });

  app.get('/api/v1/daily', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    await initializeBotTrades();
    const userAccs = getAccountsForUser(auth);
    const scopedTrades = filterTradesForUserScope(auth);
    const compounded = getCompoundedBalanceForUser(userAccs, scopedTrades);
    const baseDeposit = compounded.baseDeposit > 0 ? compounded.baseDeposit : 0;

    // Агрегируем строго закрытые сделки по дате их закрытия (YYYY-MM-DD) с использованием чистого PnL (net_profit)
    const closedTrades = scopedTrades.filter((t) => !t.is_open);
    const dailyMap = new Map<
      string,
      {
        date: string;
        abs_profit: number;
        rel_profit: number;
        fiat_value: number;
        trade_count: number;
        trades_count: number;
        wins: number;
        losses: number;
        equity: number;
      }
    >();

    // Предзаполняем последние 7 календарных дней (включая сегодня), чтобы таблица и график Прибыли по дням всегда были полными
    for (let i = 0; i < 7; i++) {
      const dStr = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      dailyMap.set(dStr, {
        date: dStr,
        abs_profit: 0,
        rel_profit: 0,
        fiat_value: 0,
        trade_count: 0,
        trades_count: 0,
        wins: 0,
        losses: 0,
        equity: baseDeposit,
      });
    }

    for (const t of closedTrades) {
      const dStr =
        (t.close_date || t.open_date || '').slice(0, 10) ||
        new Date().toISOString().slice(0, 10);
      const netPnl = Number(t.net_profit ?? t.profit_abs ?? 0);
      const curr = dailyMap.get(dStr) || {
        date: dStr,
        abs_profit: 0,
        rel_profit: 0,
        fiat_value: 0,
        trade_count: 0,
        trades_count: 0,
        wins: 0,
        losses: 0,
        equity: baseDeposit,
      };
      curr.abs_profit = Number((curr.abs_profit + netPnl).toFixed(4));
      curr.fiat_value = curr.abs_profit;
      curr.rel_profit =
        baseDeposit > 0 ? Number(((curr.abs_profit / baseDeposit) * 100).toFixed(2)) : 0;
      curr.trade_count += 1;
      curr.trades_count += 1;
      if (netPnl >= 0) curr.wins += 1;
      else curr.losses += 1;
      dailyMap.set(dStr, curr);
    }

    const sortedAsc = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));
    let runningEquity = baseDeposit;
    for (const day of sortedAsc) {
      runningEquity = Number((runningEquity + day.abs_profit).toFixed(2));
      day.equity = runningEquity;
    }
    const sortedDesc = [...sortedAsc].sort((a, b) => b.date.localeCompare(a.date));

    res.json({
      data: sortedDesc,
      fiat_display_currency: 'USD',
      stake_currency: 'USDT',
      starting_balance: baseDeposit,
    });
  });

  app.get('/api/v1/balance', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    await initializeBotTrades();
    if (req.query.sync === 'true') {
      await syncRealExchangeBalancesIfNeeded(true);
    } else {
      triggerBackgroundExchangeSync(false);
    }
    const userAccs = getAccountsForUser(auth);
    const scopedTrades = filterTradesForUserScope(auth);
    for (const t of scopedTrades) {
      if (t.is_open) {
        refreshTradeLivePriceFromWs(t);
        recalculateTradeMetrics(t, false);
      }
    }
    const openTrades = scopedTrades.filter((t) => t.is_open);
    const closedTrades = scopedTrades.filter((t) => !t.is_open);
    const metrics = getAggregatedMetricsForUser(userAccs, openTrades, closedTrades);
    const baseStartingBalance = metrics.baseDeposit;
    const totalBalance = metrics.totalBalance;
    const unrealizedPnl = metrics.openProfitAbs;
    const equityBalance = metrics.equityBalance;
    const usedStake = metrics.usedStake;
    const freeBalance = metrics.freeBalance;
    res.json({
      currencies: [
        {
          currency: 'USDT',
          free: freeBalance,
          used: usedStake,
          balance: totalBalance,
          est_stake: equityBalance,
          stake: 'USDT',
        },
      ],
      total: totalBalance,
      wallet_balance: totalBalance,
      unrealized_pnl: unrealizedPnl,
      equity: equityBalance,
      equity_balance: equityBalance,
      available_balance: freeBalance,
      used_margin: usedStake,
      symbol: 'USDT',
      value: totalBalance,
      starting_capital: baseStartingBalance,
      starting_capital_ratio: 0,
    });
  });

  app.get('/api/v1/performance', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    await initializeBotTrades();
    const scopedTrades = filterTradesForUserScope(auth);
    const map = new Map<string, { pair: string; profit_pct: number; profit_abs: number; count: number }>();
    for (const t of scopedTrades) {
      const curr = map.get(t.pair) || { pair: t.pair, profit_pct: 0, profit_abs: 0, count: 0 };
      curr.profit_pct = Number((curr.profit_pct + t.profit_pct).toFixed(2));
      curr.profit_abs = Number((curr.profit_abs + t.profit_abs).toFixed(3));
      curr.count += 1;
      map.set(t.pair, curr);
    }
    res.json(Array.from(map.values()));
  });

  app.get('/api/v1/whitelist', async (_req, res) => {
    const allMarketPairs = await fetchAllMarketPairs();
    const activeWhitelist = allMarketPairs.filter((p) => !blacklist.includes(p));
    const pairMetrics = activeWhitelist.map((pair) => {
      const t = tickerCache.get(pair);
      return {
        pair,
        price: t?.price || 0,
        change24h: t?.change24h || 0,
        volume24h: t?.volume24h || 0,
        high24h: t?.high24h || 0,
        low24h: t?.low24h || 0,
      };
    });
    res.json({
      whitelist: activeWhitelist,
      length: activeWhitelist.length,
      method: ['VolumePairList'],
      pair_metrics: pairMetrics,
    });
  });

  app.get('/api/v1/blacklist', (_req, res) => {
    res.json({ blacklist, length: blacklist.length, method: ['StaticPairList'] });
  });

  app.post('/api/v1/blacklist', (req, res) => {
    const auth = requireOwner(req, res);
    if (!auth) return;
    const { blacklist: newPairs } = req.body || {};
    if (Array.isArray(newPairs)) {
      for (const p of newPairs) {
        const clean = String(p).trim().toUpperCase();
        if (clean && !blacklist.includes(clean)) blacklist.push(clean);
      }
    }
    res.json({ blacklist, length: blacklist.length });
  });

  app.delete('/api/v1/blacklist', (req, res) => {
    const auth = requireOwner(req, res);
    if (!auth) return;
    const p = String(req.query.pairs_to_delete || '').toUpperCase();
    if (p) blacklist = blacklist.filter((item) => item !== p);
    res.json({ blacklist, length: blacklist.length });
  });

  app.get('/api/v1/locks', (_req, res) => {
    res.json({ lock_count: pairLocks.length, locks: pairLocks });
  });

  app.post('/api/v1/locks', (req, res) => {
    const auth = requireOwner(req, res);
    if (!auth) return;
    const { pair, until, reason = 'Manual Lock', side = '*' } = req.body || {};
    const lock = {
      id: Date.now(),
      pair: String(pair || 'ETH/USDT:USDT').toUpperCase(),
      lock_time: new Date().toISOString(),
      lock_end_time: until || new Date(Date.now() + 3600_000).toISOString(),
      reason,
      side,
      active: true,
    };
    pairLocks.push(lock);
    res.json(lock);
  });

  app.delete('/api/v1/locks/:id', (req, res) => {
    const auth = requireOwner(req, res);
    if (!auth) return;
    const id = Number(req.params.id);
    pairLocks = pairLocks.filter((l) => l.id !== id);
    res.json({ lock_count: pairLocks.length, locks: pairLocks });
  });

  app.get('/api/v1/pair_candles', async (req, res) => {
    await initializeBotTrades();
    const pair = String(req.query.pair || 'ETH/USDT:USDT').toUpperCase();
    const timeframe = String(req.query.timeframe || botConfig.timeframe);
    const strategy = String(req.query.strategy || botConfig.strategy);
    const limit = Math.min(1000, Math.max(60, Number(req.query.limit) || 1000));
    const endTime = req.query.endTime ? Number(req.query.endTime) : undefined;

    const { candles, source } = await fetchChartCandles(pair, timeframe, limit, endTime);

    // Update current rate for open trades on this pair using live WS Futures Mark Price first
    if (!endTime && candles.length > 0) {
      const cLatest = candles[candles.length - 1];
      for (const t of tradesStore) {
        if (t.is_open && t.pair === pair && cLatest) {
          const updatedFromWs = refreshTradeLivePriceFromWs(t);
          if (!updatedFromWs && (!t.exchange_mark_price || !t.exchange_synced_at || Date.now() - t.exchange_synced_at >= 60_000)) {
            t.current_rate = cLatest.close;
          }
          recalculateTradeMetrics(t);
        }
      }
    }

    const dataframe = buildFreqtradeDataframe(pair, timeframe, strategy, candles, source);
    res.json(dataframe);
  });

  app.get('/api/v1/logs', (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const scopedLogs = botLogs.filter((l) => l.publicMarket || l.userId === auth.userId);
    res.json({ log_count: scopedLogs.length, logs: [...scopedLogs].reverse() });
  });

  app.post('/api/v1/start', (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    if (!hasConnectedExchangeAccount(auth.userId)) {
      appendLog(
        'freqtrade.rpc.rpc',
        'ERROR',
        'Отказ запуска: не подключен ни один биржевой аккаунт (API). Подключите биржу во вкладке «API-аккаунты».',
        { userId: auth.userId }
      );
      res.status(400).json({
        error:
          'Невозможно запустить бота без подключенной биржи. Добавьте API-ключ во вкладке «API-аккаунты».',
        status: 'stopped (no exchange connected)',
        state: 'stopped',
      });
      return;
    }
    setUserBotStopped(auth.userId, false);
    setUserNewEntriesPaused(auth.userId, false);
    if (hasConnectedExchangeAccount()) {
      botConfig.state = 'running';
    }
    appendLog('freqtrade.rpc.rpc', 'INFO', 'Changing state to: RUNNING (Новые входы разрешены)', {
      userId: auth.userId,
    });
    scheduleScopeStateSync(auth.userId);
    res.json({
      status: 'starting trader ...',
      state: 'running',
      pause_new_entries: false,
    });
  });

  app.post('/api/v1/stop', (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    setUserBotStopped(auth.userId, true);
    appendLog('freqtrade.rpc.rpc', 'WARNING', 'Changing state to: STOPPED', {
      userId: auth.userId,
    });
    scheduleScopeStateSync(auth.userId);
    res.json({
      status: 'stopping trader ...',
      state: 'stopped',
      pause_new_entries: isUserNewEntriesPaused(auth.userId),
    });
  });

  app.post('/api/v1/stopbuy', (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const nextPaused = !isUserNewEntriesPaused(auth.userId);
    setUserNewEntriesPaused(auth.userId, nextPaused);
    appendLog(
      'freqtrade.rpc.rpc',
      'INFO',
      nextPaused
        ? '⏸️ Включен режим «Остановить открытие новых сделок»: бот прекратил новые входы, но продолжает усреднять (DCA) и закрывать в плюс текущие позиции.'
        : '▶️ Отключена пауза новых входов: бот снова ищет точки входа по стратегиям ScalpingStrategy и GlobalHedgeStrategy.',
      { userId: auth.userId }
    );
    scheduleScopeStateSync(auth.userId);
    res.json({
      status: nextPaused ? 'paused new entries' : 'resumed new entries',
      state: hasConnectedExchangeAccount(auth.userId) && !isUserBotStopped(auth.userId) ? 'running' : 'stopped',
      pause_new_entries: nextPaused,
    });
  });

  app.post('/api/v1/bot/pause_entries', (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const explicitVal = req.body?.pause_new_entries;
    const nextPaused =
      typeof explicitVal === 'boolean' ? explicitVal : !isUserNewEntriesPaused(auth.userId);
    setUserNewEntriesPaused(auth.userId, nextPaused);
    appendLog(
      'freqtrade.rpc.rpc',
      'INFO',
      nextPaused
        ? '⏸️ Включен режим «Без новых сделок»: бот НЕ открывает новые позиции, продолжая вести, усреднять (DCA) и закрывать в плюс уже открытые сделки.'
        : '▶️ Разрешено открытие новых сделок: сканер рынка и входы по стратегиям активны.',
      { userId: auth.userId }
    );
    scheduleScopeStateSync(auth.userId);
    res.json({
      status: nextPaused ? 'paused_new_entries' : 'active_entries',
      state: hasConnectedExchangeAccount(auth.userId) && !isUserBotStopped(auth.userId) ? 'running' : 'stopped',
      pause_new_entries: nextPaused,
    });
  });

  app.post('/api/v1/reload_config', (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    candleCache.clear();
    appendLog('freqtrade.rpc.rpc', 'INFO', 'Reloading config ...', { userId: auth.userId });
    scheduleScopeStateSync(auth.userId);
    res.json({
      status: 'Reloading config ...',
      state: hasConnectedExchangeAccount(auth.userId) && !isUserBotStopped(auth.userId) ? 'running' : 'stopped',
    });
  });

  app.patch('/api/v1/config', (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const { strategy, timeframe } = req.body || {};
    if (strategy && auth.role === 'owner') botConfig.strategy = String(strategy);
    if (timeframe && auth.role === 'owner') botConfig.timeframe = String(timeframe);
    res.json({
      ...botConfig,
      state: hasConnectedExchangeAccount(auth.userId) && !isUserBotStopped(auth.userId) ? 'running' : 'stopped',
      pause_new_entries: isUserNewEntriesPaused(auth.userId),
    });
  });

  app.post('/api/v1/forceenter', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    await initializeBotTrades();
    const userAccs = getAccountsForUser(auth).filter((a) => a.enabled);
    if (userAccs.length === 0) {
      res.status(400).json({
        error:
          'Бот не может открывать сделки без подключенного API-аккаунта. Сначала подключите ваш биржевой аккаунт во вкладке «API-аккаунты».',
      });
      return;
    }
    const {
      pair = 'ETH/USDT:USDT',
      side = 'long',
      price: customPrice,
      stakeamount,
      leverage: customLeverage,
      take_profit_abs: customTp,
      stop_loss_abs: customSl,
      account_id: requestedAccountId,
    } = req.body || {};

    let targetAcc: ExchangeAccountRecord | undefined;
    if (requestedAccountId) {
      const reqAccStr = String(requestedAccountId).trim();
      targetAcc = userAccs.find(
        (a) =>
          a.id === reqAccStr ||
          (reqAccStr === 'master' && auth.role === 'owner' && (a.user_id || 'owner') === 'owner')
      );
      if (!targetAcc) {
        res.status(403).json({
          error: 'Указанный биржевой аккаунт не принадлежит вашему профилю или отключен.',
        });
        return;
      }
    } else {
      targetAcc = userAccs[0];
    }

    const cleanPair = String(pair).toUpperCase();
    const [{ candles: c1w }, { candles: c1d }, { candles: c4h }, { candles: c1h }] =
      await Promise.all([
        fetchRealCandles(cleanPair, '1w', 300),
        fetchRealCandles(cleanPair, '1d', 1000),
        fetchRealCandles(cleanPair, '4h', 1000),
        fetchRealCandles(cleanPair, '1h', 250),
      ]);
    const latestPrice = c1h.length > 0 ? c1h[c1h.length - 1].close : 100;
    const entryRate = roundPrice(
      customPrice && Number(customPrice) > 0 ? Number(customPrice) : latestPrice
    );
    const mtf = analyzeMultiTimeframe(cleanPair, c1h, c4h, c1d, undefined, c1w);
    const normalizedSide = String(side || 'long').toLowerCase();
    if (normalizedSide === 'hedge' || normalizedSide === 'both') {
      try {
        const { longTrade, shortTrade } = await openHedgeCampaign(
          cleanPair,
          entryRate,
          mtf,
          c4h,
          c1d,
          {
            stake: stakeamount && Number(stakeamount) > 0 ? Number(stakeamount) : undefined,
            leverage:
              customLeverage && Number(customLeverage) >= 1 ? Number(customLeverage) : undefined,
            accountId: targetAcc.id,
            accountName: targetAcc.name,
            candles1w: c1w,
          }
        );
        res.json({
          ...longTrade,
          hedge_campaign: true,
          long_trade: longTrade,
          short_trade: shortTrade,
        });
        return;
      } catch (err: any) {
        res.status(400).json({
          error: err?.message || 'Ошибка при открытии 2-сторонней хедж-сделки на бирже.',
        });
        return;
      }
    }

    const isShort = normalizedSide === 'short';
    const preloadedPairLevels = await getOrComputeMtfBotLevels(
      cleanPair,
      botConfig.timeframe,
      false,
      auth.userId
    );

    let newTrade: FreqtradeTrade;
    try {
      newTrade = await createScalpBotPosition(
        cleanPair,
        isShort ? 'short' : 'long',
        entryRate,
        mtf,
        c4h,
        c1d,
        isShort ? 'Short (MTF)' : 'Long (MTF)',
        {
          stake: stakeamount && Number(stakeamount) > 0 ? Number(stakeamount) : undefined,
          leverage: customLeverage && Number(customLeverage) >= 1 ? Number(customLeverage) : undefined,
          customTp: customTp && Number(customTp) > 0 ? Number(customTp) : undefined,
          customSl: customSl && Number(customSl) > 0 ? Number(customSl) : undefined,
          accountId: targetAcc.id,
          accountName: targetAcc.name,
          preloadedPairLevels,
          candles1w: c1w,
        }
      );
    } catch (err: any) {
      res.status(400).json({
        error: err?.message || 'Ошибка при открытии сделки на бирже.',
      });
      return;
    }

    res.json(newTrade);
  });

  // Bot Averaging (DCA) endpoint — completely disabled
  app.post('/api/v1/dca', (_req, res) => {
    res.status(400).json({
      error: 'Усреднение (DCA) полностью отключено в боте.',
    });
  });

  // Update trade levels (TP, SL, Support, Resistance) when dragged by the user on the chart
  app.patch('/api/v1/trade_levels', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    await initializeBotTrades();
    const { tradeid, level_type, price, dca_index } = req.body || {};
    if (level_type === 'rehedge_stop' && (!Number.isFinite(Number(price)) || Number(price) <= 0)) {
      res.status(400).json({
        error:
          'Раздел 6.3 (Табу №3): Запрет на ручную отмену отложенного ордера перестраховки (Re-Hedge Stop) пока позиция в просадке.',
      });
      return;
    }
    const id = Number(tradeid);
    const requestedPrice = roundPrice(Number(price));
    if (!Number.isFinite(requestedPrice) || requestedPrice <= 0) {
      res.status(400).json({ error: 'Invalid price' });
      return;
    }

    const trade = tradesStore.find((t) => t.trade_id === id && t.is_open);
    if (!trade) {
      res.status(404).json({ error: `Open trade #${id} not found` });
      return;
    }
    if (
      resolveTradeUserId(trade) !== auth.userId ||
      (auth.role === 'client' && auth.accountId && trade.account_id !== auth.accountId)
    ) {
      res.status(403).json({ error: 'Нет доступа к чужой сделке' });
      return;
    }

    recalculateTradeMetrics(trade, false);
    let prevPrice = 0;
    let effectivePrice = requestedPrice;
    const clampedToBreakeven = false;
    let clampWarning: string | undefined;

    sqliteDb.runInTransaction(() => {
      if (level_type === 'tp') {
        prevPrice = trade.take_profit_abs;
        const minProfitableTp = trade.min_profitable_tp || trade.breakeven_price || trade.open_rate;
        const wouldCloseInLossOrFeeMinus = trade.is_short
          ? requestedPrice > minProfitableTp
          : requestedPrice < minProfitableTp;

        effectivePrice = requestedPrice;
        if (wouldCloseInLossOrFeeMinus) {
          clampWarning = `TP установлен вручную на ${effectivePrice}$ (ниже зоны безубытка ${minProfitableTp}$ с учётом комиссий).`;
        }

        trade.take_profit_abs = effectivePrice;
        trade.tp_manual_override = true;
        recalculateTradeMetrics(trade, false);
        const tpCreds = getAccountCredentialsFromStore(trade.account_id || 'master');
        if (tpCreds && !isSimulatedTestApiKey(tpCreds.apiKey) && trade.take_profit_abs > 0) {
          placeOrUpdateExchangeTakeProfitOrder(tpCreds, {
            pair: trade.pair,
            isShort: trade.is_short,
            quantity: trade.amount,
            takeProfitPrice: trade.take_profit_abs,
          }).catch(() => {});
        }
        appendLog(
          'freqtrade.bot.levels',
          wouldCloseInLossOrFeeMinus ? 'WARNING' : 'INFO',
          `[${trade.pair}] TP изменен вручную на графике: ${prevPrice}$ ➔ ${trade.take_profit_abs}$ (ROI: ${trade.take_profit_pct}%). Синхронизировано с биржей и trades.sqlite.`,
          { userId: auth.userId }
        );
      } else if (level_type === 'sl') {
        prevPrice = trade.stop_loss_abs;
        trade.stop_loss_abs = effectivePrice;
        trade.sl_manual_override = true;
        recalculateTradeMetrics(trade, false);
        appendLog(
          'freqtrade.bot.levels',
          'INFO',
          `[${trade.pair}] SL изменен вручную на графике: ${prevPrice}$ ➔ ${effectivePrice}$ (${trade.stop_loss_pct}%). Сохранено в trades.sqlite.`,
          { userId: auth.userId }
        );
      } else if (level_type === 'support') {
        prevPrice = trade.support_level || 0;
        trade.support_level = effectivePrice;
        recalculateTradeMetrics(trade, false);
      } else if (level_type === 'resistance') {
        prevPrice = trade.resistance_level || 0;
        trade.resistance_level = effectivePrice;
        recalculateTradeMetrics(trade, false);
      } else if (level_type === 'dca') {
        const idx = Number.isFinite(Number(dca_index)) ? Number(dca_index) : 0;
        if (Array.isArray(trade.planned_dca_levels) && trade.planned_dca_levels[idx]) {
          prevPrice = trade.planned_dca_levels[idx].price;
          trade.planned_dca_levels[idx].price = effectivePrice;
          recalculateTradeMetrics(trade, false);
        }
      }

      sqliteDb.upsertTrade(trade);
    });

    broadcastTradeLifecycleEvent('trade:updated', trade);
    scheduleScopeStateSync(auth.userId);

    res.json({
      result: 'Level updated and synced with bot SQLite database',
      level_type,
      previous_price: prevPrice,
      new_price: effectivePrice,
      clamped_to_breakeven: clampedToBreakeven,
      warning: clampWarning,
      trade,
    });
  });

  // Get MTF & Timeframe Bot Levels (Support & Resistance with touches/bounces/strength_score) for a pair & timeframe
  app.get('/api/v1/pair_levels', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    await initializeBotTrades();
    const pair = String(req.query.pair || 'ETH/USDT:USDT').toUpperCase();
    const timeframe = String(req.query.timeframe || botConfig.timeframe || '1h').toLowerCase();
    const levels = await getOrComputeMtfBotLevels(pair, timeframe, false, auth.userId);
    res.json({ pair, timeframe, levels });
  });

  // Add a new Bot Level on a pair (persisted per user in trades.sqlite)
  app.post('/api/v1/pair_levels', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    await initializeBotTrades();
    const { pair = 'ETH/USDT:USDT', timeframe = botConfig.timeframe, price, role, label } = req.body || {};
    const cleanPair = String(pair).toUpperCase();
    const normTf = String(timeframe || '1h').toLowerCase();
    const cleanPrice = roundPrice(Number(price));
    if (!Number.isFinite(cleanPrice) || cleanPrice <= 0) {
      res.status(400).json({ error: 'Invalid level price' });
      return;
    }
    const existing = await getOrComputeMtfBotLevels(cleanPair, normTf, false, auth.userId);
    const nextIdx = existing.length + 1;
    const nowStr = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const livePrice = tickerCache.get(cleanPair)?.price || 0;
    const cleanRole: 'support' | 'resistance' =
      role === 'resistance'
        ? 'resistance'
        : role === 'support'
        ? 'support'
        : livePrice > 0 && cleanPrice >= livePrice
        ? 'resistance'
        : 'support';
    const newLevel: BotChartLevel = {
      id: `lvl-${cleanPair}-${Date.now()}`,
      pair: cleanPair,
      label: label || `MANUAL LVL ${nextIdx} (${cleanRole === 'resistance' ? 'RES' : 'SUP'})`,
      role: cleanRole,
      price: cleanPrice,
      touches: 1,
      bounces: 1,
      breaks: 0,
      strength_score: 10,
      source: 'MANUAL',
      manual_override: true,
      updated_at: nowStr,
    };
    const userPrefix = `${auth.userId}::${cleanPair}`;
    for (const k of Array.from(botLevelsStore.keys())) {
      if (k === userPrefix || k.startsWith(`${userPrefix}_`)) {
        botLevelsStore.delete(k);
      }
    }
    sqliteDb.upsertBotLevel(
      {
        ...newLevel,
        touches: 1,
        bounces: 1,
        breaks: 0,
        strength_score: 10,
        source: 'MANUAL',
        manual_override: true,
        deleted: false,
      },
      auth.userId
    );
    const refreshed = await getOrComputeMtfBotLevels(cleanPair, normTf, false, auth.userId);
    appendLog(
      'freqtrade.bot.levels',
      'INFO',
      `[${cleanPair}] Добавлен уровень бота ${newLevel.label} @ ${cleanPrice}$`,
      { userId: auth.userId }
    );
    res.json({ pair: cleanPair, level: newLevel, levels: refreshed });
  });

  // Update a Bot Level price when dragged on the chart (persisted per user in trades.sqlite & synced to user's open trades)
  app.patch('/api/v1/pair_levels', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    await initializeBotTrades();
    const { pair = 'ETH/USDT:USDT', timeframe = botConfig.timeframe, id, price, role } = req.body || {};
    const cleanPair = String(pair).toUpperCase();
    const normTf = String(timeframe || '1h').toLowerCase();
    const newPrice = roundPrice(Number(price));
    if (!Number.isFinite(newPrice) || newPrice <= 0) {
      res.status(400).json({ error: 'Invalid level price' });
      return;
    }
    const existing = await getOrComputeMtfBotLevels(cleanPair, normTf, false, auth.userId);
    const allDbLevels = sqliteDb.getAllBotLevelsForPairIncludeDeleted(cleanPair, auth.userId);
    const target = existing.find((l) => l.id === id) || allDbLevels.find((l) => l.id === id);
    if (!target) {
      res.status(404).json({ error: 'Bot level not found' });
      return;
    }
    const prevPrice = target.price;
    target.price = newPrice;
    target.manual_override = true;
    target.updated_at = new Date().toISOString().replace('T', ' ').slice(0, 19);

    // Keep global SUP/RES explicit role, while allowing user-added LVL/local lines to adapt role when dragged across live price
    const isCustomManualLvl = target.id.startsWith('lvl-');
    const isGlobalSupRes =
      target.id.startsWith('tf-sup-') ||
      target.id.startsWith('mtf-sup-') ||
      target.id.startsWith('tf-res-') ||
      target.id.startsWith('mtf-res-');
    const livePairPrice = tickerCache.get(cleanPair)?.price || 0;
    if (role === 'support' || role === 'resistance') {
      target.role = role;
    } else if (isCustomManualLvl && livePairPrice > 0) {
      target.role = newPrice >= livePairPrice ? 'resistance' : 'support';
      target.label = target.label.replace(/\((SUP|RES)\)/i, `(${target.role === 'resistance' ? 'RES' : 'SUP'})`);
    } else if (target.id.includes('-sup-') || target.label.toUpperCase().includes('SUP')) {
      target.role = 'support';
    } else if (target.id.includes('-res-') || target.label.toUpperCase().includes('RES')) {
      target.role = 'resistance';
    }

    sqliteDb.runInTransaction(() => {
      sqliteDb.upsertBotLevel(
        {
          id: target.id,
          pair: cleanPair,
          label: target.label,
          role: target.role,
          price: target.price,
          touches: target.touches || 1,
          bounces: target.bounces || 1,
          breaks: target.breaks || 0,
          strength_score: target.strength_score || 10,
          source: target.source || normTf.toUpperCase(),
          manual_override: true,
          deleted: false,
          updated_at: target.updated_at,
        },
        auth.userId
      );

      // Only clean up sibling auto-levels and bind global trade S/R for this user's own open trades
      if (isGlobalSupRes) {
        sqliteDb.replaceAutoBotLevelsWithManual(cleanPair, target.role, target.id, auth.userId);

        for (const t of tradesStore) {
          if (t.is_open && t.pair === cleanPair && resolveTradeUserId(t) === auth.userId) {
            if (target.role === 'support') {
              t.support_level = newPrice;
            } else {
              t.resistance_level = newPrice;
            }
            recalculateTradeMetrics(t, false);
            sqliteDb.upsertTrade(t);
          }
        }
      }
    });

    const userPrefix = `${auth.userId}::${cleanPair}`;
    for (const k of Array.from(botLevelsStore.keys())) {
      if (k === userPrefix || k.startsWith(`${userPrefix}_`)) {
        botLevelsStore.delete(k);
      }
    }
    const refreshedLevels = await getOrComputeMtfBotLevels(cleanPair, normTf, false, auth.userId);
    const updatedPairTrades = tradesStore.filter(
      (t) => t.is_open && t.pair === cleanPair && resolveTradeUserId(t) === auth.userId
    );

    appendLog(
      'freqtrade.bot.levels',
      'INFO',
      `[${cleanPair}] Уровень ${target.label} (${target.role.toUpperCase()}) перенесен на графике: ${prevPrice}$ ➔ ${newPrice}$.`,
      { userId: auth.userId }
    );
    res.json({
      pair: cleanPair,
      previous_price: prevPrice,
      level: target,
      levels: refreshedLevels,
      updated_trades: updatedPairTrades,
    });
  });

  // Delete a single Bot Level (marks deleted per user in trades.sqlite so auto-MTF won't recreate it)
  app.delete('/api/v1/pair_levels/:id', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    await initializeBotTrades();
    const id = String(req.params.id);
    const pair = String(req.query.pair || 'ETH/USDT:USDT').toUpperCase();
    const timeframe = String(req.query.timeframe || botConfig.timeframe || '1h').toLowerCase();
    const existing = await getOrComputeMtfBotLevels(pair, timeframe, false, auth.userId);
    const removed = existing.find((l) => l.id === id);
    const next = existing.filter((l) => l.id !== id);
    const userPrefix = `${auth.userId}::${pair}`;
    for (const k of Array.from(botLevelsStore.keys())) {
      if (k === userPrefix || k.startsWith(`${userPrefix}_`)) {
        botLevelsStore.delete(k);
      }
    }
    botLevelsStore.set(`${auth.userId}::${pair}_${timeframe}`, next);
    sqliteDb.markBotLevelDeleted(id, auth.userId);
    appendLog(
      'freqtrade.bot.levels',
      'INFO',
      `[${pair}] Удален уровень бота ${removed ? `${removed.label} @ ${removed.price}$` : id}. Триггер уровня отменен.`,
      { userId: auth.userId }
    );
    res.json({ pair, removed_id: id, levels: next });
  });

  // Clear all Bot Levels for a pair for the current user
  app.delete('/api/v1/pair_levels', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    await initializeBotTrades();
    const pair = String(req.query.pair || 'ETH/USDT:USDT').toUpperCase();
    const userPrefix = `${auth.userId}::${pair}`;
    for (const k of Array.from(botLevelsStore.keys())) {
      if (k === userPrefix || k.startsWith(`${userPrefix}_`)) {
        botLevelsStore.delete(k);
      }
    }
    sqliteDb.clearBotLevelsForPair(pair, auth.userId);
    appendLog('freqtrade.bot.levels', 'INFO', `[${pair}] Очищены все уровни бота на графике`, {
      userId: auth.userId,
    });
    res.json({ pair, levels: [] });
  });

  // ============================================================================
  // TRADINGVIEW CHART DRAWINGS & PINNED MEASURE RULERS API (Persisted per user in trades.sqlite)
  // ============================================================================
  app.get('/api/v1/chart_drawings', (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const pair = String(req.query.pair || 'ETH/USDT:USDT').toUpperCase();
    const cacheKey = `${auth.userId}::${pair}`;
    if (!chartDrawingsStore.has(cacheKey)) {
      chartDrawingsStore.set(cacheKey, sqliteDb.getChartDrawingsForPair(pair, auth.userId));
    }
    const drawings = chartDrawingsStore.get(cacheKey) || [];
    res.json({ pair, drawings });
  });

  app.post('/api/v1/chart_drawings', (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const { pair = 'ETH/USDT:USDT', tool, points, color = '#2962ff', text, locked = false } =
      req.body || {};
    const cleanPair = String(pair).toUpperCase();
    if (!tool || !Array.isArray(points) || points.length === 0) {
      res.status(400).json({ error: 'Invalid drawing payload' });
      return;
    }
    const cacheKey = `${auth.userId}::${cleanPair}`;
    if (!chartDrawingsStore.has(cacheKey)) {
      chartDrawingsStore.set(cacheKey, sqliteDb.getChartDrawingsForPair(cleanPair, auth.userId));
    }
    const existing = chartDrawingsStore.get(cacheKey) || [];
    const newDrawing: ChartDrawingObject = {
      id: `drw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      pair: cleanPair,
      tool,
      points: points.map((pt: any) => ({
        timestamp: Number(pt.timestamp),
        price: roundPrice(Number(pt.price)),
      })),
      color: String(color),
      text: text ? String(text) : undefined,
      locked: Boolean(locked),
      user_id: auth.userId,
      created_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    };
    existing.push(newDrawing);
    chartDrawingsStore.set(cacheKey, existing);
    sqliteDb.upsertChartDrawing(newDrawing);
    res.json({ pair: cleanPair, drawing: newDrawing, drawings: existing });
  });

  app.patch('/api/v1/chart_drawings/:id', (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const id = String(req.params.id);
    const { pair = 'ETH/USDT:USDT', points, color, text, locked } = req.body || {};
    const cleanPair = String(pair).toUpperCase();
    const cacheKey = `${auth.userId}::${cleanPair}`;
    if (!chartDrawingsStore.has(cacheKey)) {
      chartDrawingsStore.set(cacheKey, sqliteDb.getChartDrawingsForPair(cleanPair, auth.userId));
    }
    const existing = chartDrawingsStore.get(cacheKey) || [];
    const target = existing.find((d) => d.id === id);
    if (!target) {
      res.status(404).json({ error: 'Drawing not found' });
      return;
    }
    if (Array.isArray(points) && points.length > 0) {
      target.points = points.map((pt: any) => ({
        timestamp: Number(pt.timestamp),
        price: roundPrice(Number(pt.price)),
      }));
    }
    if (color !== undefined) target.color = String(color);
    if (text !== undefined) target.text = String(text);
    if (locked !== undefined) target.locked = Boolean(locked);
    target.user_id = auth.userId;
    sqliteDb.upsertChartDrawing(target);
    res.json({ pair: cleanPair, drawing: target, drawings: existing });
  });

  app.delete('/api/v1/chart_drawings/:id', (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const id = String(req.params.id);
    const pair = String(req.query.pair || 'ETH/USDT:USDT').toUpperCase();
    const cacheKey = `${auth.userId}::${pair}`;
    if (!chartDrawingsStore.has(cacheKey)) {
      chartDrawingsStore.set(cacheKey, sqliteDb.getChartDrawingsForPair(pair, auth.userId));
    }
    const existing = chartDrawingsStore.get(cacheKey) || [];
    const next = existing.filter((d) => d.id !== id);
    chartDrawingsStore.set(cacheKey, next);
    sqliteDb.deleteChartDrawing(id, auth.userId);
    res.json({ pair, removed_id: id, drawings: next });
  });

  app.delete('/api/v1/chart_drawings', (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const pair = String(req.query.pair || 'ETH/USDT:USDT').toUpperCase();
    const cacheKey = `${auth.userId}::${pair}`;
    chartDrawingsStore.set(cacheKey, []);
    sqliteDb.clearChartDrawingsForPair(pair, auth.userId);
    res.json({ pair, drawings: [] });
  });

  // ============================================================================
  // MULTI-EXCHANGE API ACCOUNTS & CLIENT ACCESS MANAGEMENT
  // Supported Exchanges: Binance, Bybit, OKX, Bitget, BingX
  // ============================================================================
  function buildAccountPayload(acc: ExchangeAccountRecord) {
    if (!acc.enabled) {
      return serializeAccountForClient({
        ...acc,
        open_trades_count: 0,
        unrealized_pnl: 0,
        used_margin_usdt: 0,
        available_balance_usdt: Number((acc.wallet_balance_usdt ?? acc.balance_usdt ?? 0).toFixed(2)),
        status: 'paused' as const,
      });
    }
    const targetId = getTargetAccountIdForRecord(acc);
    const accOpen = tradesStore.filter(
      (t) => t.is_open && tradeMatchesAccount(t, acc, targetId)
    );
    const accOpenPnl = accOpen.reduce((sum, t) => sum + t.profit_abs, 0);
    const accLocalUsed = Number(
      accOpen
        .reduce(
          (sum, t) =>
            sum +
            sanitizePositionMarginUsdt(
              Number(t.stake_amount || 0),
              Number(t.amount || 0),
              Number(t.open_rate || 0),
              Number(t.leverage || acc.max_leverage || 25)
            ),
          0
        )
        .toFixed(2)
    );
    const liveUnrealized =
      typeof acc.unrealized_pnl === 'number' && Number.isFinite(acc.unrealized_pnl) && acc.unrealized_pnl !== 0
        ? acc.unrealized_pnl
        : accOpenPnl;
    const walletBal = Number((acc.wallet_balance_usdt ?? acc.balance_usdt ?? 0).toFixed(2));
    const sanitizedAccUsed = sanitizeWalletUsedMarginUsdt(
      Number(acc.used_margin_usdt || 0),
      walletBal,
      accLocalUsed,
      accOpen.length
    );
    const usedMargin =
      sanitizedAccUsed > 0
        ? accOpen.length > 0 && acc.open_trades_count === accOpen.length
          ? Number(sanitizedAccUsed.toFixed(2))
          : accOpen.length > 0
          ? accLocalUsed
          : Number(sanitizedAccUsed.toFixed(2))
        : accLocalUsed;
    const computedAvail = Number(
      Math.max(0, walletBal + Math.min(0, liveUnrealized) - usedMargin).toFixed(2)
    );
    const availBal =
      typeof acc.available_balance_usdt === 'number' &&
      Number.isFinite(acc.available_balance_usdt) &&
      acc.available_balance_usdt >= 0 &&
      acc.available_balance_usdt <= walletBal + Math.max(0, liveUnrealized) + 1.0
        ? Number(acc.available_balance_usdt.toFixed(2))
        : computedAvail;
    return serializeAccountForClient({
      ...acc,
      open_trades_count: accOpen.length,
      unrealized_pnl: Number(liveUnrealized.toFixed(4)),
      used_margin_usdt: usedMargin,
      available_balance_usdt: availBal,
      status: 'connected' as const,
    });
  }

  app.get('/api/v1/accounts', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    await initializeBotTrades();
    if (req.query.sync === 'true') {
      await syncRealExchangeBalancesIfNeeded(true);
    } else {
      triggerBackgroundExchangeSync(false);
    }
    const synced = getAccountsForUser(auth).map(buildAccountPayload);
    res.json({ accounts: synced });
  });

  app.post('/api/v1/accounts', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    await initializeBotTrades();
    const {
      name,
      owner_label,
      exchange = 'bybit',
      market_type = 'futures',
      api_key,
      api_secret,
      passphrase,
      max_leverage = 25,
      balance_usdt,
      client_access_code,
      is_testnet = false,
    } = req.body || {};

    const validExchanges: SupportedExchange[] = ['binance', 'bybit', 'okx', 'bitget', 'bingx'];
    let cleanExchange: SupportedExchange = validExchanges.includes(exchange)
      ? exchange
      : 'bybit';

    const cleanKeyInput = sanitizeCredentialString(String(api_key || ''));
    const cleanSecretInput = sanitizeCredentialString(String(api_secret || ''));
    const cleanPassInput = passphrase ? sanitizeCredentialString(String(passphrase)) : '';

    if (!name || !cleanKeyInput || !cleanSecretInput) {
      res.status(400).json({ error: 'Укажите название аккаунта, API Key и Secret Key' });
      return;
    }

    let resolvedBalanceUsdt = Number(balance_usdt);
    let resolvedIsTestnet = Boolean(is_testnet);
    let resolvedNetworkLabel: string | undefined;
    let liveCheckResult: any = null;

    // Для реальных API-ключей всегда проверяем подключение к бирже (с авто-определением биржи, Mainnet / Testnet / Demo и запросом реального баланса USDT)
    if (!isSimulatedTestApiKey(cleanKeyInput)) {
      try {
        const liveCheck = await testExchangeConnection({
          exchange: cleanExchange,
          apiKey: cleanKeyInput,
          apiSecret: cleanSecretInput,
          passphrase: cleanPassInput || undefined,
          isTestnet: resolvedIsTestnet,
        });
        liveCheckResult = liveCheck;
        if (liveCheck.exchange && validExchanges.includes(liveCheck.exchange)) {
          cleanExchange = liveCheck.exchange;
        }
        if (typeof liveCheck.is_testnet === 'boolean') {
          resolvedIsTestnet = liveCheck.is_testnet;
        }
        if (liveCheck.network_label) {
          resolvedNetworkLabel = liveCheck.network_label;
        }
        if (
          liveCheck.success &&
          typeof liveCheck.balance_usdt === 'number' &&
          liveCheck.balance_usdt > 0
        ) {
          resolvedBalanceUsdt = Number(liveCheck.balance_usdt.toFixed(2));
        }
        appendLog(
          'freqtrade.exchange.connect',
          liveCheck.success ? 'INFO' : 'WARNING',
          liveCheck.success
            ? `🔗 Успешное подключение к ${resolvedNetworkLabel || cleanExchange.toUpperCase()} (${String(name).trim()}): реальный баланс = ${resolvedBalanceUsdt > 0 ? resolvedBalanceUsdt.toFixed(2) : '0.00'} USDT | Пинг: ${liveCheck.latency_ms} мс`
            : `⚠️ Подключение API ${cleanExchange.toUpperCase()} (${String(name).trim()}): ${liveCheck.message}`,
          { userId: auth.userId }
        );
      } catch (connErr: any) {
        liveCheckResult = {
          success: false,
          exchange: cleanExchange,
          message: connErr?.message || 'Таймаут или ошибка проверки подключения к бирже',
        };
      }
      if (!liveCheckResult || !liveCheckResult.success) {
        res.status(400).json({
          error:
            liveCheckResult?.message ||
            `Не удалось подтвердить подключение к бирже ${cleanExchange.toUpperCase()}. Проверьте API Key, Secret Key и права на фьючерсы.`,
          connection_check: liveCheckResult,
        });
        return;
      }
    }

    if (!Number.isFinite(resolvedBalanceUsdt) || resolvedBalanceUsdt <= 0) {
      resolvedBalanceUsdt = Number(balance_usdt) > 0 ? Number(balance_usdt) : 1000;
    }

    const cleanName = String(name).trim();
    const generatedCode =
      client_access_code && String(client_access_code).trim().length >= 8
        ? String(client_access_code).trim().toUpperCase()
        : generateSecureClientAccessCode(cleanExchange);

    // Проверка: не подключен ли этот же реальный API-ключ в другом профиле
    const existingByRawKey = !isSimulatedTestApiKey(cleanKeyInput)
      ? exchangeAccountsStore.find(
          (a) => sanitizeCredentialString(a.api_key_raw) === cleanKeyInput
        )
      : undefined;

    if (existingByRawKey && (existingByRawKey.user_id || 'owner') !== auth.userId) {
      const existingIsOwner = (existingByRawKey.user_id || 'owner') === 'owner' || existingByRawKey.is_owner;
      const sameSecret =
        sanitizeCredentialString(existingByRawKey.api_secret_raw) === cleanSecretInput;
      if (existingIsOwner || !sameSecret) {
        res.status(403).json({
          error:
            'Этот API-ключ уже используется другим пользователем. Подключите собственный API-ключ биржи.',
        });
        return;
      }
      // Тот же клиент повторно ввёл свои API Key + Secret Key с нового устройства/браузера — перепривязываем его аккаунт и сделки к текущей сессии
      existingByRawKey.user_id = auth.userId;
      sqliteDb.upsertExchangeAccount(existingByRawKey);
    }

    // Защита от дублирования строго в рамках аккаунтов текущего пользователя
    const userOwnedAccs = getAccountsForUser(auth);
    const existingAcc =
      (existingByRawKey && (existingByRawKey.user_id || 'owner') === auth.userId
        ? existingByRawKey
        : undefined) ||
      userOwnedAccs.find(
        (a) =>
          (client_access_code && a.client_access_code.toUpperCase() === generatedCode) ||
          (a.name.toLowerCase() === cleanName.toLowerCase() && a.exchange === cleanExchange)
      );

    const effectiveIsOwner = auth.role === 'owner';

    if (existingAcc) {
      const apiKeyChanged = existingAcc.api_key_raw !== cleanKeyInput;
      existingAcc.name = cleanName;
      existingAcc.owner_label = owner_label ? String(owner_label).trim() : cleanName;
      existingAcc.exchange = cleanExchange;
      existingAcc.market_type = market_type === 'spot' ? 'spot' : 'futures';
      existingAcc.api_key_masked = maskApiKey(String(api_key));
      existingAcc.api_key_raw = cleanKeyInput;
      existingAcc.api_secret_raw = cleanSecretInput;
      existingAcc.passphrase_raw = cleanPassInput;
      existingAcc.has_passphrase = Boolean(cleanPassInput.length > 0);
      existingAcc.is_owner = effectiveIsOwner;
      existingAcc.user_id = auth.userId;
      existingAcc.client_access_code =
        existingAcc.client_access_code && existingAcc.client_access_code.length >= 12
          ? existingAcc.client_access_code
          : generatedCode;
      existingAcc.enabled = true;
      existingAcc.copy_trading = false;
      existingAcc.copy_multiplier = 1.0;
      existingAcc.max_leverage = Math.max(1, Math.min(50, Math.round(Number(max_leverage) || 25)));
      if (resolvedBalanceUsdt > 0) {
        existingAcc.balance_usdt = resolvedBalanceUsdt;
      }
      if (liveCheckResult?.success) {
        if (typeof liveCheckResult.wallet_balance_usdt === 'number') {
          existingAcc.wallet_balance_usdt = Number(liveCheckResult.wallet_balance_usdt.toFixed(4));
        }
        if (typeof liveCheckResult.used_margin_usdt === 'number') {
          existingAcc.used_margin_usdt = Number(liveCheckResult.used_margin_usdt.toFixed(2));
        }
        if (typeof liveCheckResult.available_balance_usdt === 'number') {
          existingAcc.available_balance_usdt = Number(liveCheckResult.available_balance_usdt.toFixed(2));
        }
        if (typeof liveCheckResult.unrealized_pnl_usdt === 'number') {
          existingAcc.unrealized_pnl = Number(liveCheckResult.unrealized_pnl_usdt.toFixed(4));
        }
        if (typeof liveCheckResult.equity_usdt === 'number') {
          existingAcc.equity_usdt = Number(liveCheckResult.equity_usdt.toFixed(4));
        }
      }
      if (apiKeyChanged || !existingAcc.connected_at) {
        existingAcc.connected_at = Date.now();
      }
      existingAcc.is_testnet = resolvedIsTestnet;
      existingAcc.network_label = resolvedNetworkLabel;
      existingAcc.status = 'connected';
      existingAcc.last_sync = new Date().toISOString().replace('T', ' ').slice(0, 19);

      sqliteDb.upsertExchangeAccount(existingAcc);
      setUserBotStopped(auth.userId, false);

      if (!isSimulatedTestApiKey(cleanKeyInput)) {
        await syncPositionsAndHistoryFromExchanges(existingAcc, true);
        const existingCreds = getAccountCredentialsFromStore(existingAcc);
        if (existingCreds) {
          prewarmExchangeAccountCaches(existingCreds).catch(() => {});
        }
      }
      botConfig.state = hasConnectedExchangeAccount() ? 'running' : 'stopped';
      if (!isSimulatedTestApiKey(cleanKeyInput) && !isUserBotStopped(auth.userId)) {
        runScalpBotCycle(false).catch(() => {});
      }
      scheduleScopeStateSync(auth.userId);

      res.json({
        account: buildAccountPayload(existingAcc),
        accounts: getAccountsForUser(auth).map(buildAccountPayload),
        connection_check: liveCheckResult,
      });
      return;
    }

    const nowTs = Date.now();
    const newAcc: ExchangeAccountRecord = {
      id: `acc-${cleanExchange}-${nowTs}-${Math.random().toString(36).slice(2, 5)}`,
      name: cleanName,
      owner_label: owner_label ? String(owner_label).trim() : cleanName,
      exchange: cleanExchange,
      market_type: market_type === 'spot' ? 'spot' : 'futures',
      api_key_masked: maskApiKey(String(api_key)),
      api_key_raw: cleanKeyInput,
      api_secret_raw: cleanSecretInput,
      passphrase_raw: cleanPassInput,
      has_passphrase: Boolean(cleanPassInput.length > 0),
      is_owner: effectiveIsOwner,
      user_id: auth.userId,
      client_access_code: generatedCode,
      enabled: true,
      copy_trading: false,
      copy_multiplier: 1.0,
      max_leverage: Math.max(1, Math.min(50, Math.round(Number(max_leverage) || 25))),
      balance_usdt: resolvedBalanceUsdt,
      wallet_balance_usdt:
        liveCheckResult?.success && typeof liveCheckResult.wallet_balance_usdt === 'number'
          ? Number(liveCheckResult.wallet_balance_usdt.toFixed(4))
          : resolvedBalanceUsdt,
      equity_usdt:
        liveCheckResult?.success && typeof liveCheckResult.equity_usdt === 'number'
          ? Number(liveCheckResult.equity_usdt.toFixed(4))
          : resolvedBalanceUsdt,
      available_balance_usdt:
        liveCheckResult?.success && typeof liveCheckResult.available_balance_usdt === 'number'
          ? Number(liveCheckResult.available_balance_usdt.toFixed(2))
          : resolvedBalanceUsdt,
      used_margin_usdt:
        liveCheckResult?.success && typeof liveCheckResult.used_margin_usdt === 'number'
          ? Number(liveCheckResult.used_margin_usdt.toFixed(2))
          : 0,
      unrealized_pnl:
        liveCheckResult?.success && typeof liveCheckResult.unrealized_pnl_usdt === 'number'
          ? Number(liveCheckResult.unrealized_pnl_usdt.toFixed(4))
          : 0,
      open_trades_count: 0,
      status: 'connected',
      last_sync: new Date(nowTs).toISOString().replace('T', ' ').slice(0, 19),
      connected_at: nowTs,
      is_testnet: resolvedIsTestnet,
      network_label: resolvedNetworkLabel,
    };

    exchangeAccountsStore.push(newAcc);
    sqliteDb.upsertExchangeAccount(newAcc);
    setUserBotStopped(auth.userId, false);

    appendLog(
      'freqtrade.exchange.accounts',
      'INFO',
      `Подключен новый API-аккаунт: ${newAcc.name} (${resolvedNetworkLabel || `${cleanExchange.toUpperCase()} ${newAcc.market_type.toUpperCase()}`}) | Баланс: ${newAcc.balance_usdt.toFixed(2)} USDT | Ключ: ${newAcc.api_key_masked}`,
      { userId: auth.userId }
    );

    if (!isSimulatedTestApiKey(cleanKeyInput)) {
      await syncPositionsAndHistoryFromExchanges(newAcc, true);
      const newCreds = getAccountCredentialsFromStore(newAcc);
      if (newCreds) {
        prewarmExchangeAccountCaches(newCreds).catch(() => {});
      }
    }
    botConfig.state = hasConnectedExchangeAccount() ? 'running' : 'stopped';
    if (!isSimulatedTestApiKey(cleanKeyInput) && !isUserBotStopped(auth.userId)) {
      runScalpBotCycle(false).catch(() => {});
    }
    scheduleScopeStateSync(auth.userId);

    res.json({
      account: buildAccountPayload(newAcc),
      accounts: getAccountsForUser(auth).map(buildAccountPayload),
      connection_check: liveCheckResult,
    });
  });

  app.patch('/api/v1/accounts/:id', (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const id = String(req.params.id);
    const target = exchangeAccountsStore.find((a) => a.id === id);
    if (!target) {
      res.status(404).json({ error: 'Аккаунт не найден' });
      return;
    }
    if (
      (target.user_id || 'owner') !== auth.userId ||
      (auth.role === 'client' && auth.accountId && target.id !== auth.accountId)
    ) {
      res.status(403).json({ error: 'Нет доступа к чужому аккаунту' });
      return;
    }
    const {
      name,
      enabled,
      max_leverage,
      balance_usdt,
      client_access_code,
    } = req.body || {};

    if (name !== undefined) target.name = String(name).trim();
    target.is_owner = auth.role === 'owner';
    target.copy_trading = false;
    target.copy_multiplier = 1.0;

    if (enabled !== undefined) {
      target.enabled = Boolean(enabled);
      target.status = target.enabled ? 'connected' : 'paused';
      if (!target.enabled) {
        if (target.api_key_raw) {
          stopExchangePrivateStream(target.exchange, target.api_key_raw);
        }
      } else {
        const tCreds = getAccountCredentialsFromStore(target);
        if (tCreds) prewarmExchangeAccountCaches(tCreds).catch(() => {});
      }
    }
    if (max_leverage !== undefined) {
      target.max_leverage = Math.max(1, Math.min(50, Math.round(Number(max_leverage) || 25)));
    }
    if (balance_usdt !== undefined && Number(balance_usdt) >= 0) {
      target.balance_usdt = Number(balance_usdt);
    }
    if (client_access_code !== undefined && String(client_access_code).trim()) {
      target.client_access_code = String(client_access_code).trim().toUpperCase();
    }
    target.last_sync = new Date().toISOString().replace('T', ' ').slice(0, 19);

    sqliteDb.upsertExchangeAccount(target);
    botConfig.state = hasConnectedExchangeAccount() && !ownerManuallyStoppedBot ? 'running' : 'stopped';

    if (enabled === true && target.enabled && !isSimulatedTestApiKey(target.api_key_raw)) {
      syncPositionsAndHistoryFromExchanges(target, true, true).catch(() => {});
    }

    appendLog(
      'freqtrade.exchange.accounts',
      'INFO',
      `Обновлены параметры аккаунта ${target.name} (${target.exchange.toUpperCase()}): Активен=${target.enabled}, Плечо=x${target.max_leverage}`,
      { userId: auth.userId }
    );
    scheduleScopeStateSync(auth.userId);
    res.json({
      account: buildAccountPayload(target),
      accounts: getAccountsForUser(auth).map(buildAccountPayload),
    });
  });

  app.delete('/api/v1/accounts/:id', (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const id = String(req.params.id);
    const target = exchangeAccountsStore.find((a) => a.id === id);
    if (!target) {
      res.status(404).json({ error: 'Аккаунт не найден' });
      return;
    }
    if (
      (target.user_id || 'owner') !== auth.userId ||
      (auth.role === 'client' && auth.accountId && target.id !== auth.accountId)
    ) {
      res.status(403).json({ error: 'Нет доступа к чужому аккаунту' });
      return;
    }
    if (target.api_key_raw) {
      stopExchangePrivateStream(target.exchange, target.api_key_raw);
    }
    const targetScopeId = getTargetAccountIdForRecord(target);
    exchangeAccountsStore = exchangeAccountsStore.filter((a) => a.id !== id);
    sqliteDb.deleteExchangeAccount(id);

    // Удаляем только сделки удалённого аккаунта
    const accountTrades = tradesStore.filter(
      (t) => resolveTradeUserId(t) === auth.userId && tradeMatchesAccount(t, target, targetScopeId)
    );
    for (const ct of accountTrades) {
      sqliteDb.deleteTrade(ct.trade_id);
    }
    const removedIds = new Set(accountTrades.map((t) => t.trade_id));
    tradesStore = tradesStore.filter((t) => !removedIds.has(t.trade_id));

    // Если больше нет ни одного активного аккаунта в системе — останавливаем движок
    if (!hasConnectedExchangeAccount()) {
      botConfig.state = 'stopped';
    }

    appendLog(
      'freqtrade.exchange.accounts',
      'WARNING',
      `Отключен и удален API-аккаунт: ${target.name} (${target.exchange.toUpperCase()})`,
      { userId: auth.userId }
    );
    scheduleScopeStateSync(auth.userId);
    res.json({ removed_id: id, accounts: getAccountsForUser(auth).map(buildAccountPayload) });
  });

  app.delete('/api/v1/accounts', (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const explicitUserClear = req.query.confirm === 'true';
    const userAccs = getAccountsForUser(auth);
    const userAccIds = new Set(userAccs.map((a) => a.id));
    for (const acc of userAccs) {
      if (acc.api_key_raw) {
        stopExchangePrivateStream(acc.exchange, acc.api_key_raw);
      }
    }
    exchangeAccountsStore = exchangeAccountsStore.filter((a) => !userAccIds.has(a.id));
    if (auth.role === 'client' && auth.accountId) {
      sqliteDb.deleteExchangeAccount(auth.accountId);
    } else {
      sqliteDb.clearExchangeAccountsForUser(auth.userId, explicitUserClear);
    }

    const userTrades = tradesStore.filter(
      (t) =>
        resolveTradeUserId(t) === auth.userId &&
        (!auth.accountId || t.account_id === auth.accountId)
    );
    for (const t of userTrades) {
      sqliteDb.deleteTrade(t.trade_id);
    }
    const removedTradeIds = new Set(userTrades.map((t) => t.trade_id));
    tradesStore = tradesStore.filter((t) => !removedTradeIds.has(t.trade_id));

    if (!hasConnectedExchangeAccount()) {
      botConfig.state = 'stopped';
    }
    appendLog(
      'freqtrade.exchange.accounts',
      'WARNING',
      `API-аккаунты профиля очищены пользователем (${auth.login || auth.userId}).`,
      { userId: auth.userId }
    );
    scheduleScopeStateSync(auth.userId);
    res.json({ accounts: [] });
  });

  app.post('/api/v1/accounts/test-connection', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const { account_id, exchange, api_key, api_secret, passphrase, is_testnet } = req.body || {};
    let credsExchange = exchange;
    let credsKey = api_key;
    let credsSecret = api_secret;
    let credsPass = passphrase;
    let credsIsTestnet = is_testnet !== undefined ? Boolean(is_testnet) : undefined;
    let targetAcc: ExchangeAccountRecord | undefined;

    if (account_id) {
      const allAccs = sqliteDb.loadExchangeAccounts();
      const acc = allAccs.find((a) => a.id === account_id);
      if (acc && (acc.user_id || 'owner') !== auth.userId) {
        res.status(403).json({
          success: false,
          exchange: String(credsExchange || 'bybit'),
          latency_ms: 0,
          permissions: [],
          message: 'Нет доступа к чужому аккаунту',
          live_verified: false,
        });
        return;
      }
      targetAcc = exchangeAccountsStore.find((a) => a.id === account_id);
      if (acc) {
        credsExchange = acc.exchange;
        credsKey = acc.api_key_raw;
        credsSecret = acc.api_secret_raw;
        credsPass = acc.passphrase_raw;
        if (credsIsTestnet === undefined) {
          credsIsTestnet = Boolean(acc.is_testnet);
        }
      }
    }

    if (!credsKey || !credsSecret) {
      res.status(400).json({
        success: false,
        exchange: String(credsExchange || 'bybit'),
        latency_ms: 0,
        permissions: [],
        message: 'Для проверки соединения необходимы реальные API Key и Secret Key',
        live_verified: false,
      });
      return;
    }

    const testRes = await testExchangeConnection({
      exchange: credsExchange || 'bybit',
      apiKey: String(credsKey),
      apiSecret: String(credsSecret),
      passphrase: credsPass ? String(credsPass) : undefined,
      isTestnet: credsIsTestnet,
    });

    if (targetAcc && testRes.success) {
      if (typeof testRes.is_testnet === 'boolean') {
        targetAcc.is_testnet = testRes.is_testnet;
      }
      if (testRes.network_label) {
        targetAcc.network_label = testRes.network_label;
      }
      const exactBal = testRes.wallet_balance_usdt ?? testRes.balance_usdt;
      if (typeof exactBal === 'number' && exactBal > 0) {
        targetAcc.balance_usdt = Number(exactBal.toFixed(2));
        targetAcc.wallet_balance_usdt = Number(exactBal.toFixed(4));
      }
      if (typeof testRes.used_margin_usdt === 'number') {
        targetAcc.used_margin_usdt = Number(testRes.used_margin_usdt.toFixed(2));
      }
      if (typeof testRes.available_balance_usdt === 'number') {
        targetAcc.available_balance_usdt = Number(testRes.available_balance_usdt.toFixed(2));
      }
      if (typeof testRes.unrealized_pnl_usdt === 'number') {
        targetAcc.unrealized_pnl = Number(testRes.unrealized_pnl_usdt.toFixed(4));
      }
      if (typeof testRes.equity_usdt === 'number') {
        targetAcc.equity_usdt = Number(testRes.equity_usdt.toFixed(4));
      }
      targetAcc.status = 'connected';
      targetAcc.last_sync = new Date().toISOString().replace('T', ' ').slice(0, 19);
      sqliteDb.upsertExchangeAccount(targetAcc);
      if (!isSimulatedTestApiKey(String(credsKey))) {
        await syncPositionsAndHistoryFromExchanges(targetAcc, true);
      }
      if (!ownerManuallyStoppedBot) {
        runScalpBotCycle(false).catch(() => {});
      }
      scheduleScopeStateSync(auth.userId);
    }

    appendLog(
      'freqtrade.exchange.test',
      testRes.success ? 'INFO' : 'WARNING',
      `Тестирование API ${String(credsExchange).toUpperCase()}${targetAcc ? ` (${targetAcc.name})` : ''}: ${testRes.message}`,
      { userId: auth.userId }
    );

    res.json(testRes);
  });

  app.get('/api/v1/client/dashboard', async (req, res) => {
    await initializeBotTrades();
    const authHeader = String(req.headers.authorization || '');
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const verified = token ? sqliteDb.verifyAuthToken(token) : { valid: false };

    const codeParam = String(req.query.code || req.query.client || '').trim().toUpperCase();
    let acc: ExchangeAccountRecord | null = null;
    if (codeParam) {
      const matched = sqliteDb.verifyClientAccessCode(codeParam);
      if (matched) {
        acc = exchangeAccountsStore.find((a) => a.id === matched.id) || matched;
      }
    }
    if (!acc && verified.valid) {
      if (verified.accountId) {
        acc = exchangeAccountsStore.find((a) => a.id === verified.accountId) || null;
      } else if (verified.userId) {
        acc = exchangeAccountsStore.find((a) => (a.user_id || 'owner') === verified.userId) || null;
      } else if (verified.inviteId) {
        const uId = `invite:${verified.inviteId}`;
        acc = exchangeAccountsStore.find((a) => (a.user_id || 'owner') === uId) || null;
      } else if (verified.role === 'owner') {
        acc = exchangeAccountsStore.find((a) => (a.user_id || 'owner') === 'owner') || null;
      }
    }

    if (!acc) {
      res.status(401).json({ error: 'Аккаунт не найден или требуется авторизация' });
      return;
    }

    const accUserId = acc.user_id || 'owner';
    const accScopeId = getTargetAccountIdForRecord(acc);
    const clientConnectedAt = acc.connected_at || 0;
    // Изолированные сделки этого аккаунта
    const clientOpenTrades = tradesStore.filter(
      (t) => t.is_open && resolveTradeUserId(t) === accUserId && tradeMatchesAccount(t, acc!, accScopeId)
    );
    const clientClosedTrades = tradesStore.filter(
      (t) =>
        !t.is_open &&
        resolveTradeUserId(t) === accUserId &&
        tradeMatchesAccount(t, acc!, accScopeId) &&
        t.enter_tag !== 'EXCHANGE_HISTORY' &&
        t.exit_reason !== 'exchange_closed_pnl' &&
        !(clientConnectedAt > 0 && (t.close_timestamp || 0) > 0 && (t.close_timestamp || 0) < clientConnectedAt - 1000)
    );

    const isRealClientAcc = Boolean(
      acc.api_key_raw && !isSimulatedTestApiKey(acc.api_key_raw)
    );
    const clientUnrealizedPnl =
      isRealClientAcc && typeof acc.unrealized_pnl === 'number' && clientOpenTrades.length > 0
        ? Number(acc.unrealized_pnl.toFixed(2))
        : Number(clientOpenTrades.reduce((sum, t) => sum + t.profit_abs, 0).toFixed(2));
    const clientTotalProfit = Number(
      clientClosedTrades.reduce((sum, t) => sum + (t.net_profit ?? t.profit_abs ?? 0), 0).toFixed(2)
    );
    const winningTrades = clientClosedTrades.filter(
      (t) => (t.net_profit ?? t.profit_abs ?? 0) >= 0
    ).length;
    const winrate =
      clientClosedTrades.length > 0
        ? Number(((winningTrades / clientClosedTrades.length) * 100).toFixed(1))
        : 100;

    const { compoundedBalance: clientCompoundedBalance } = getCompoundedAccountBalance(acc.id);

    res.json({
      account: {
        id: acc.id,
        name: acc.name,
        exchange: acc.exchange,
        balance_usdt: clientCompoundedBalance,
        wallet_balance_usdt: acc.wallet_balance_usdt ?? clientCompoundedBalance,
        equity_usdt:
          acc.equity_usdt ?? Number((clientCompoundedBalance + clientUnrealizedPnl).toFixed(2)),
        available_balance_usdt: acc.available_balance_usdt,
        used_margin_usdt: acc.used_margin_usdt,
        open_trades_count: clientOpenTrades.length,
        unrealized_pnl: clientUnrealizedPnl,
        copy_trading: false,
        stake_pct: 0.5,
        leverage: acc.max_leverage || 25,
        last_sync: acc.last_sync,
      },
      open_trades: clientOpenTrades,
      closed_trades: clientClosedTrades,
      total_profit_usdt: clientTotalProfit,
      winrate,
      current_pair: clientOpenTrades[0]?.pair || 'ETH/USDT:USDT',
    });
  });

  app.post('/api/v1/forceexit', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    await initializeBotTrades();
    const { tradeid } = req.body || {};
    if (tradeid === 'all') {
      const now = Date.now();
      const nowStr = new Date(now).toISOString().replace('T', ' ').slice(0, 19);
      const targetTrades = filterTradesForUserScope(auth);
      let closedCount = 0;
      let skippedNegativeCount = 0;
      const tradesToClose: Array<{ trade: FreqtradeTrade; closeRes: PlacedOrderResult | null }> = [];
      for (const t of targetTrades) {
        if (t.is_open) {
          const liveRefPrice = getTradeReferencePrice(t);
          const livePrice = liveRefPrice > 0 ? liveRefPrice : t.current_rate;
          if (livePrice > 0) {
            t.current_rate = livePrice;
          }
          recalculateTradeMetrics(t, false);
          const guard = verifySafeProfitableClose(t, undefined, t.current_rate);
          if (!guard.ok) {
            skippedNegativeCount++;
            sqliteDb.upsertTrade(t);
            continue;
          }
          const tAccId = t.account_id || 'master';
          const closeRes = await dispatchOrderToExchangeAccount(tAccId, {
            pair: t.pair,
            isShort: t.is_short,
            action: 'CLOSE',
            quantity: t.amount,
            leverage: t.leverage || 25,
            referencePrice: t.current_rate,
          });
          const tCreds = getAccountCredentialsFromStore(tAccId);
          if (tCreds && !isSimulatedTestApiKey(tCreds.apiKey) && (!closeRes || !closeRes.success)) {
            continue;
          }
          tradesToClose.push({ trade: t, closeRes });
        }
      }

      sqliteDb.runInTransaction(() => {
        for (const { trade: t, closeRes } of tradesToClose) {
          t.is_open = false;
          t.close_date = closeRes?.exchange_time
            ? new Date(closeRes.exchange_time).toISOString().replace('T', ' ').slice(0, 19)
            : nowStr;
          t.close_timestamp = closeRes?.exchange_time || now;
          t.close_rate =
            closeRes?.success && closeRes.price > 0 ? roundPrice(closeRes.price) : t.current_rate;
          if (closeRes?.open_fee_usdt && closeRes.open_fee_usdt > 0) {
            t.fee_open = Number(closeRes.open_fee_usdt.toFixed(4));
          }
          if (closeRes?.commission_usdt && closeRes.commission_usdt > 0) {
            t.fee_close = Number(closeRes.commission_usdt.toFixed(4));
          }
          if (typeof closeRes?.realized_pnl_usdt === 'number') {
            const totalFees = (t.fee_open || 0) + (t.fee_close || 0);
            t.exchange_realized_pnl = Number((closeRes.realized_pnl_usdt - totalFees).toFixed(4));
          }
          t.exit_reason = 'force_exit';
          t.trade_state = 'CLOSED';
          t.planned_dca_levels = [];
          recalculateTradeMetrics(t, false);
          sqliteDb.upsertTrade(t);
          sqliteDb.recordOrder({
            trade_id: t.trade_id,
            pair: t.pair,
            order_type: 'market',
            side: t.is_short ? 'buy' : 'sell',
            price: t.close_rate || t.current_rate,
            amount: t.amount,
            cost: Number(((t.close_rate || t.current_rate) * t.amount).toFixed(4)),
            fee: t.fee_close || 0,
            realized_pnl: t.net_profit || t.profit_abs,
            action_type: 'FORCE_EXIT',
            notes: 'Force exit all profitable trades',
          });
          closedCount++;
        }
      });
      for (const { trade: t } of tradesToClose) {
        broadcastTradeLifecycleEvent('trade:closed', t);
      }
      if (closedCount > 0) {
        if (tradesToClose.some(({ trade }) => typeof trade.exchange_realized_pnl !== 'number')) {
          setTimeout(() => {
            void syncRealExchangeBalancesIfNeeded(true);
          }, 2200);
        }
        for (const userAcc of getAccountsForUser(auth)) {
          const accScopeId = getTargetAccountIdForRecord(userAcc);
          const remainingOpen = tradesStore.filter(
            (x) =>
              x.is_open &&
              resolveTradeUserId(x) === auth.userId &&
              tradeMatchesAccount(x, userAcc, accScopeId)
          );
          userAcc.open_trades_count = remainingOpen.length;
          userAcc.used_margin_usdt = Number(
            remainingOpen.reduce((s, x) => s + x.stake_amount, 0).toFixed(2)
          );
          userAcc.unrealized_pnl = Number(
            remainingOpen.reduce((s, x) => s + (x.profit_abs || 0), 0).toFixed(4)
          );
        }
        syncRealExchangeBalancesIfNeeded(true).catch(() => {});
        scheduleScopeStateSync(auth.userId);
      }
      if (closedCount === 0 && skippedNegativeCount > 0) {
        res.status(400).json({
          error: `Защита от закрытия в минус: все открытые сделки (${skippedNegativeCount} шт.) сейчас не проходят защитный порог чистой прибыли с учётом всех комиссий и резерва проскальзывания. Бот удерживает их до выхода в уверенный чистый плюс по Take-Profit.`,
          closed_count: 0,
          protected_count: skippedNegativeCount,
        });
        return;
      }
      res.json({
        result: `Закрыто плюсовых сделок: ${closedCount}. Защищено от закрытия в минус: ${skippedNegativeCount}.`,
        closed_count: closedCount,
        protected_count: skippedNegativeCount,
      });
      return;
    }

    const id = Number(tradeid);
    const trade = tradesStore.find((t) => t.trade_id === id && t.is_open);
    if (!trade) {
      res.status(404).json({ error: `Open trade #${id} not found` });
      return;
    }
    if (
      resolveTradeUserId(trade) !== auth.userId ||
      (auth.role === 'client' && auth.accountId && trade.account_id !== auth.accountId)
    ) {
      res.status(403).json({ error: 'Нет доступа к чужой сделке' });
      return;
    }

    const liveRefPrice = getTradeReferencePrice(trade);
    const livePrice = liveRefPrice > 0 ? liveRefPrice : trade.current_rate;
    if (livePrice > 0) {
      trade.current_rate = livePrice;
    }
    recalculateTradeMetrics(trade, false);
    const netProfitUsdt = trade.net_profit ?? trade.profit_abs;
    const closeGuard = verifySafeProfitableClose(trade, undefined, trade.current_rate);
    if (!closeGuard.ok) {
      sqliteDb.upsertTrade(trade);
      appendLog(
        'freqtrade.bot.guard',
        'WARNING',
        `🛡️ Заблокировано закрытие сделки #${id} [${trade.pair}] в минус/на грани комиссий: ${closeGuard.reason}. Точка безубытка: ${trade.breakeven_price}$, мин. плюсовой TP: ${trade.min_profitable_tp}$.`,
        { userId: auth.userId }
      );
      res.status(400).json({
        error: `Запрещено закрывать сделку #${id} (${trade.pair})! ${closeGuard.reason}. Чистый PnL с учётом всех комиссий ($${trade.fee_total}): ${netProfitUsdt}$ (${trade.net_profit_percent}%). Точка безубытка: ${trade.breakeven_price}$, мин. безопасный TP: ${trade.min_profitable_tp}$. Дождитесь выхода позиции в уверенный чистый плюс.`,
        net_profit: netProfitUsdt,
        fee_total: trade.fee_total,
        breakeven_price: trade.breakeven_price,
        min_profitable_tp: trade.min_profitable_tp,
      });
      return;
    }

    // Отправка реального ордера закрытия на биржу
    const targetAccId = trade.account_id || 'master';
    const closeOrderRes = await dispatchOrderToExchangeAccount(targetAccId, {
      pair: trade.pair,
      isShort: trade.is_short,
      action: 'CLOSE',
      quantity: trade.amount,
      leverage: trade.leverage || 25,
      referencePrice: trade.current_rate,
    });
    const targetCreds = getAccountCredentialsFromStore(targetAccId);
    if (
      targetCreds &&
      !isSimulatedTestApiKey(targetCreds.apiKey) &&
      (!closeOrderRes || !closeOrderRes.success)
    ) {
      res.status(400).json({
        error:
          closeOrderRes?.error ||
          `Биржа отклонила закрытие сделки #${id} (${trade.pair}).`,
      });
      return;
    }

    const closeTs =
      closeOrderRes?.exchange_time && closeOrderRes.exchange_time > 0
        ? closeOrderRes.exchange_time
        : Date.now();
    const closeDateStr = new Date(closeTs).toISOString().replace('T', ' ').slice(0, 19);
    sqliteDb.runInTransaction(() => {
      trade.is_open = false;
      trade.close_date = closeDateStr;
      trade.close_timestamp = closeTs;
      trade.close_rate =
        closeOrderRes?.success && closeOrderRes.price > 0
          ? roundPrice(closeOrderRes.price)
          : trade.current_rate;
      if (closeOrderRes?.open_fee_usdt && closeOrderRes.open_fee_usdt > 0) {
        trade.fee_open = Number(closeOrderRes.open_fee_usdt.toFixed(4));
      }
      if (closeOrderRes?.commission_usdt && closeOrderRes.commission_usdt > 0) {
        trade.fee_close = Number(closeOrderRes.commission_usdt.toFixed(4));
      }
      if (typeof closeOrderRes?.realized_pnl_usdt === 'number') {
        const totalFees = (trade.fee_open || 0) + (trade.fee_close || 0);
        trade.exchange_realized_pnl = Number(
          (closeOrderRes.realized_pnl_usdt - totalFees).toFixed(4)
        );
      }
      trade.exit_reason = 'force_exit';
      trade.trade_state = 'CLOSED';
      trade.planned_dca_levels = [];
      recalculateTradeMetrics(trade, false);
      sqliteDb.upsertTrade(trade);
      sqliteDb.recordOrder({
        trade_id: trade.trade_id,
        pair: trade.pair,
        order_type: 'market',
        side: trade.is_short ? 'buy' : 'sell',
        price: trade.close_rate,
        amount: trade.amount,
        cost: Number((trade.close_rate * trade.amount).toFixed(4)),
        fee: trade.fee_close || 0,
        realized_pnl: trade.net_profit || trade.profit_abs,
        action_type: 'FORCE_EXIT',
        notes: `Manual force exit in net profit (+${trade.profit_abs} USDT after ${trade.fee_total} USDT fees)${closeOrderRes?.order_id ? ` | ExOrderId: ${closeOrderRes.order_id}` : ''}`,
      });
    });
    const closedAcc = resolveExchangeAccountRecord(targetAccId);
    if (closedAcc) {
      const closedAccScopeId = getTargetAccountIdForRecord(closedAcc);
      const remainingAccOpen = tradesStore.filter(
        (x) =>
          x.is_open &&
          resolveTradeUserId(x) === auth.userId &&
          tradeMatchesAccount(x, closedAcc, closedAccScopeId)
      );
      closedAcc.open_trades_count = remainingAccOpen.length;
      closedAcc.used_margin_usdt = Number(remainingAccOpen.reduce((s, x) => s + x.stake_amount, 0).toFixed(2));
      closedAcc.unrealized_pnl = Number(remainingAccOpen.reduce((s, x) => s + (x.profit_abs || 0), 0).toFixed(4));
    }
    syncRealExchangeBalancesIfNeeded(true).catch(() => {});
    appendLog(
      'freqtrade.rpc.rpc',
      'INFO',
      `Закрыта сделка #${id} (${trade.pair}) @ ${trade.close_rate} $ | Чистый итог: +${trade.profit_abs} $ (комиссия: ${trade.fee_total}$)`,
      { userId: auth.userId }
    );
    broadcastTradeLifecycleEvent('trade:closed', trade);
    scheduleScopeStateSync(auth.userId);
    res.json({ result: `Closed trade #${id}`, trade });
  });

  app.delete('/api/v1/trades/:id', (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const id = Number(req.params.id);
    const targetTrade = tradesStore.find((t) => t.trade_id === id);
    if (!targetTrade) {
      res.status(404).json({ error: `Сделка #${id} не найдена` });
      return;
    }
    if (
      resolveTradeUserId(targetTrade) !== auth.userId ||
      (auth.role === 'client' && auth.accountId && targetTrade.account_id !== auth.accountId)
    ) {
      res.status(403).json({ error: 'Нет доступа к чужой сделке' });
      return;
    }
    const accId = targetTrade.account_id || 'master';
    dismissedExchangeSyncKeys.add(
      `open:${accId}:${targetTrade.pair}:${targetTrade.is_short ? 'S' : 'L'}:${targetTrade.open_rate}`
    );
    if (targetTrade.close_timestamp) {
      dismissedExchangeSyncKeys.add(`closed:${accId}:${targetTrade.pair}:${targetTrade.close_timestamp}`);
    }
    tradesStore = tradesStore.filter((t) => t.trade_id !== id);
    sqliteDb.deleteTrade(id);
    scheduleScopeStateSync(auth.userId);
    res.json({ result_msg: `Deleted trade #${id}`, deleted_ids: [id] });
  });

  app.get('/api/v1/ws_status', (_req, res) => {
    res.json({
      status: 'ok',
      ui_ws_clients: getConnectedUiClientsCount(),
      websocket: getWebSocketEngineStatus(),
    });
  });

  const httpServer = http.createServer(app);

  // Мгновенное закрытие/синхронизация позиции при срабатывании биржевого TP или ручного закрытия на бирже через приватный WS
  const handleInstantExchangeCloseFromWs = async (params: {
    exchange: 'binance' | 'bybit';
    apiKey: string;
    pair: string;
    isShort: boolean;
    closePrice?: number;
    fee?: number;
    realizedPnl?: number;
    closedTime?: number;
    orderId?: string;
    qty?: number;
    fromPositionZero: boolean;
  }) => {
    await initializeBotTrades();
    const matchedAcc = exchangeAccountsStore.find(
      (a) => a.enabled && sanitizeCredentialString(a.api_key_raw) === params.apiKey
    );
    if (!matchedAcc) return;

    const targetAccountId = getTargetAccountIdForRecord(matchedAcc);

    // Если это событие срабатывания ордера, убедимся что закрыта вся или >= 90% позиции
    const preMatch = tradesStore.find(
      (t) =>
        t.is_open &&
        tradeMatchesAccount(t, matchedAcc, targetAccountId) &&
        t.pair === params.pair &&
        t.is_short === params.isShort
    );
    if (!preMatch) return;
    if (!params.fromPositionZero && params.qty && preMatch.amount > 0 && params.qty < preMatch.amount * 0.9) {
      return;
    }

    const lockKey = getPosLockKey(targetAccountId, preMatch.pair, preMatch.is_short);
    if (activePositionKeys.has(lockKey)) return;

    await withPositionLock(lockKey, async () => {
      const trade = tradesStore.find((t) => t.trade_id === preMatch.trade_id && t.is_open);
      if (!trade) return;

      const execInfo = getTradeExecutionQuote(trade, true);
      let closePrice =
        params.closePrice && params.closePrice > 0
          ? roundPrice(params.closePrice)
          : trade.current_rate && trade.current_rate > 0
          ? roundPrice(trade.current_rate)
          : execInfo && execInfo.executionPrice > 0
          ? roundPrice(execInfo.executionPrice)
          : roundPrice(trade.open_rate);
      let closeTs = params.closedTime && params.closedTime > 0 ? params.closedTime : Date.now();
      let closeFee = params.fee && params.fee > 0 ? Number(params.fee.toFixed(4)) : trade.fee_close || 0;
      let realizedNetPnl: number | undefined;
      let exOrderId = params.orderId || '';

      if (typeof params.realizedPnl === 'number' && Number.isFinite(params.realizedPnl)) {
        const totalFees = Number(((trade.fee_open || 0) + closeFee).toFixed(4));
        realizedNetPnl = Number((params.realizedPnl - totalFees).toFixed(4));
      } else {
        const creds = getAccountCredentialsFromStore(matchedAcc);
        if (creds && !isSimulatedTestApiKey(creds.apiKey)) {
          for (let attempt = 0; attempt < 2; attempt++) {
            if (attempt === 1) {
              await new Promise((r) => setTimeout(r, 1200));
            }
            const closedPnlRes = await fetchExchangeClosedPnl(creds, 15, [trade.pair], true).catch(() => ({
              success: false,
              closed: [],
            }));
            if (closedPnlRes.success && closedPnlRes.closed.length > 0) {
              const matched = closedPnlRes.closed.find(
                (c) =>
                  c.pair === trade.pair &&
                  (c.is_short === trade.is_short || c.order_id.startsWith('inc-')) &&
                  c.updated_time >= (trade.open_timestamp || 0) - 120_000
              );
              if (matched) {
                if (matched.entry_price > 0 && !matched.order_id.startsWith('inc-')) {
                  trade.open_rate = roundPrice(matched.entry_price);
                }
                if (matched.exit_price > 0) closePrice = roundPrice(matched.exit_price);
                if (matched.updated_time > 0) closeTs = matched.updated_time;
                if (matched.open_fee > 0) trade.fee_open = matched.open_fee;
                if (matched.close_fee > 0) closeFee = matched.close_fee;
                realizedNetPnl = matched.closed_pnl;
                if (matched.order_id) exOrderId = matched.order_id;
                break;
              }
            }
          }
        }
      }

      const closeDateStr = new Date(closeTs).toISOString().replace('T', ' ').slice(0, 19);
      sqliteDb.runInTransaction(() => {
        trade.is_open = false;
        trade.close_rate = closePrice;
        trade.current_rate = closePrice;
        trade.close_timestamp = closeTs;
        trade.close_date = closeDateStr;
        if (closeFee > 0) trade.fee_close = closeFee;
        if (typeof realizedNetPnl === 'number') {
          trade.exchange_realized_pnl = realizedNetPnl;
        }
        trade.exit_reason = 'exchange_ws_tp_sync';
        trade.trade_state = 'CLOSED';
        trade.planned_dca_levels = [];
        if (exOrderId) {
          trade.plan_notes = `Мгновенно закрыто на бирже ${matchedAcc.exchange.toUpperCase()} (OrderID: ${exOrderId})`;
        }
        recalculateTradeMetrics(trade, false);
        sqliteDb.upsertTrade(trade);
        sqliteDb.recordOrder({
          trade_id: trade.trade_id,
          pair: trade.pair,
          order_type: 'market',
          side: trade.is_short ? 'buy' : 'sell',
          price: closePrice,
          amount: trade.amount,
          cost: Number((closePrice * trade.amount).toFixed(4)),
          fee: trade.fee_close || 0,
          realized_pnl: trade.net_profit || trade.profit_abs,
          action_type: 'EXCHANGE_TP_WS_SYNC',
          notes: `Instant WS exchange close sync @ ${closePrice}${exOrderId ? ` | OrderID: ${exOrderId}` : ''}`,
        });

        const remOpen = tradesStore.filter(
          (x) => x.is_open && tradeMatchesAccount(x, matchedAcc, targetAccountId)
        );
        matchedAcc.open_trades_count = remOpen.length;
        matchedAcc.used_margin_usdt = Number(
          remOpen.reduce((s, x) => s + (x.stake_amount || 0), 0).toFixed(2)
        );
        matchedAcc.unrealized_pnl = Number(
          remOpen.reduce((s, x) => s + (x.profit_abs || 0), 0).toFixed(4)
        );
      });

      const accUserId = matchedAcc.user_id || 'owner';
      cooldownPairs.set(`${matchedAcc.id}:${trade.pair}`, Date.now());
      appendLog(
        `freqtrade.exchange.${matchedAcc.exchange}`,
        'INFO',
        `⚡ [WS EXCHANGE CLOSE 1:1] Сделка #${trade.trade_id} [${trade.pair}] мгновенно синхронизирована после закрытия на бирже @ ${closePrice}$ | Чистый PnL: ${trade.profit_abs >= 0 ? '+' : ''}${trade.profit_abs}$ (Комиссия: ${trade.fee_total}$)`,
        { userId: accUserId }
      );
      broadcastTradeLifecycleEvent('trade:closed', trade);
      scheduleScopeStateSync(accUserId);
    });
  };

  onWsExchangeExecution((evt: WsOrderFillEvent) => {
    if (!evt.isCloseFill) {
      // Если пришёл приватный WS-отчёт об исполнении начального входа (OPEN), фиксируем точную цену исполнения биржи 1:1
      if (evt.avgPrice > 0 && evt.qty > 0) {
        const matchedAcc = exchangeAccountsStore.find(
          (a) => a.enabled && sanitizeCredentialString(a.api_key_raw) === evt.apiKey
        );
        if (matchedAcc) {
          const targetAccountId = getTargetAccountIdForRecord(matchedAcc);
          const openTr = tradesStore.find(
            (t) =>
              t.is_open &&
              tradeMatchesAccount(t, matchedAcc, targetAccountId) &&
              t.pair === evt.pair &&
              t.is_short === evt.isShort &&
              (t.dca_count || 0) === 0 &&
              Date.now() - (t.open_timestamp || 0) < 90_000
          );
          if (openTr) {
            const exactFill = roundPrice(evt.avgPrice);
            if (Math.abs(openTr.open_rate - exactFill) / Math.max(1e-8, exactFill) > 0.0001) {
              openTr.open_rate = exactFill;
              openTr.initial_open_rate = exactFill;
              if (Array.isArray(openTr.orders) && openTr.orders.length === 1) {
                openTr.orders[0].price = exactFill;
              }
              recalculateTradeMetrics(openTr, false);
              sqliteDb.upsertTrade(openTr);
              broadcastTradeLifecycleEvent('trade:updated', openTr);
              scheduleScopeStateSync(matchedAcc.user_id || 'owner');
            }
          }
        }
      }
      return;
    }
    void handleInstantExchangeCloseFromWs({
      exchange: evt.exchange,
      apiKey: evt.apiKey,
      pair: evt.pair,
      isShort: evt.isShort,
      closePrice: evt.avgPrice,
      fee: evt.fee,
      realizedPnl: evt.realizedPnl,
      closedTime: evt.tradeTime,
      orderId: evt.orderId,
      qty: evt.qty,
      fromPositionZero: false,
    });
  });

  onWsExchangePositionClosed((evt: WsPositionClosedEvent) => {
    void handleInstantExchangeCloseFromWs({
      exchange: evt.exchange,
      apiKey: evt.apiKey,
      pair: evt.pair,
      isShort: evt.isShort,
      closedTime: evt.closedTime,
      fromPositionZero: true,
    });
  });

  // Запускаем постоянные WebSocket-потоки бирж (Bybit V5 Linear WS + Binance USD-M Futures WS + User Data Streams)
  startPublicMarketWebSockets();
  for (const p of PINNED_PAIRS.slice(0, 6)) {
    subscribePairKlineStream(p, '1h');
    subscribePairKlineStream(p, '4h');
  }
  onWsAccountUpdate((wsState) => {
    const updatedUserIds = new Set<string>();
    for (const acc of exchangeAccountsStore) {
      if (acc.enabled && sanitizeCredentialString(acc.api_key_raw) === wsState.apiKey) {
        const targetAccountId = getTargetAccountIdForRecord(acc);
        const accOpenTrades = tradesStore.filter(
          (t) => t.is_open && tradeMatchesAccount(t, acc, targetAccountId)
        );
        const localOpenMargin = Number(
          accOpenTrades
            .reduce(
              (s, t) =>
                s +
                sanitizePositionMarginUsdt(
                  Number(t.stake_amount || 0),
                  Number(t.amount || 0),
                  Number(t.open_rate || 0),
                  Number(t.leverage || acc.max_leverage || 25)
                ),
              0
            )
            .toFixed(2)
        );

        acc.balance_usdt = Number(wsState.walletBalanceUsdt.toFixed(4));
        acc.wallet_balance_usdt = Number(wsState.walletBalanceUsdt.toFixed(4));
        acc.unrealized_pnl = Number(wsState.unrealizedPnlUsdt.toFixed(4));
        acc.equity_usdt = Number(wsState.equityUsdt.toFixed(4));

        const sanitizedWsMargin = sanitizeWalletUsedMarginUsdt(
          wsState.usedMarginUsdt,
          acc.wallet_balance_usdt,
          localOpenMargin,
          wsState.positionsSynced ? wsState.positions.length : accOpenTrades.length
        );

        if (sanitizedWsMargin > 0) {
          acc.used_margin_usdt = Number(
            (wsState.positionsSynced ? sanitizedWsMargin : Math.max(sanitizedWsMargin, localOpenMargin)).toFixed(2)
          );
        } else if (wsState.positionsSynced && wsState.positions.length === 0) {
          acc.used_margin_usdt = 0;
        } else if (localOpenMargin > 0) {
          acc.used_margin_usdt = localOpenMargin;
        }

        acc.available_balance_usdt =
          typeof wsState.availableBalanceUsdt === 'number' &&
          Number.isFinite(wsState.availableBalanceUsdt) &&
          wsState.availableBalanceUsdt >= 0 &&
          wsState.availableBalanceUsdt <= acc.wallet_balance_usdt + Math.max(0, acc.unrealized_pnl || 0) + 1.0
            ? Number(wsState.availableBalanceUsdt.toFixed(2))
            : Number(
                Math.max(0, acc.wallet_balance_usdt + Math.min(0, acc.unrealized_pnl || 0) - (acc.used_margin_usdt || 0)).toFixed(2)
              );
        if (wsState.positionsSynced) {
          acc.open_trades_count = wsState.positions.length;
        }
        acc.status = 'connected';

        // Мгновенно синхронизируем объём, маржу и PnL открытых позиций по приватным WS-событиям биржи,
        // НО если объём увеличился (внешний DCA) — НЕ перезаписываем existing.amount вслепую без сохранения шага DCA,
        // а вызываем syncPositionsAndHistoryFromExchanges, чтобы шаг DCA сохранился в orders и dca_count!
        let needsFullPositionSync = false;
        for (const pos of wsState.positions) {
          const posLockKey = getPosLockKey(targetAccountId, pos.pair, pos.is_short);
          if (activePositionKeys.has(posLockKey)) {
            continue;
          }
          const existing = accOpenTrades.find(
            (t) => t.pair === pos.pair && t.is_short === pos.is_short
          );
          if (existing) {
            const sizeIncreased = pos.size > existing.amount * 1.02;
            if (sizeIncreased) {
              needsFullPositionSync = true;
              continue;
            }
            const isInitialFillAlign =
              !sizeIncreased &&
              (existing.dca_count || 0) === 0 &&
              pos.entry_price > 0 &&
              Date.now() - (existing.open_timestamp || 0) < 120_000 &&
              Math.abs(existing.open_rate - pos.entry_price) / Math.max(1e-8, pos.entry_price) > 0.0002;
            if (isInitialFillAlign) {
              const exactEntry = roundPrice(pos.entry_price);
              existing.open_rate = exactEntry;
              existing.initial_open_rate = exactEntry;
              if (Array.isArray(existing.orders) && existing.orders.length === 1) {
                existing.orders[0].price = exactEntry;
              }
            }
            if (pos.size > 0) existing.amount = Number(pos.size.toFixed(4));
            const sanitizedPosIm = sanitizePositionMarginUsdt(
              pos.margin_usdt,
              pos.size > 0 ? pos.size : existing.amount,
              existing.open_rate,
              pos.leverage || existing.leverage || 25
            );
            if (sanitizedPosIm > 0) existing.stake_amount = Number(sanitizedPosIm.toFixed(2));
            if (pos.mark_price > 0) {
              existing.current_rate = roundPrice(pos.mark_price);
              existing.exchange_mark_price = pos.mark_price;
            }
            existing.exchange_unrealized_pnl = Number(pos.unrealized_pnl || 0);
            existing.exchange_synced_at = Date.now();
            if (pos.take_profit && pos.take_profit > 0 && !existing.tp_manual_override) {
              existing.take_profit_abs = roundPrice(pos.take_profit);
            }
            recalculateTradeMetrics(existing, false);
          } else {
            needsFullPositionSync = true;
          }
        }
        if (needsFullPositionSync) {
          void syncPositionsAndHistoryFromExchanges(acc, false, false);
        }

        updatedUserIds.add(acc.user_id || 'owner');
      }
    }
    for (const userId of updatedUserIds) {
      scheduleScopeStateSync(userId);
    }
  });

  // Подключаем реальный WebSocket-хаб /ws/live для мгновенного push-обновления сайта (цены, свечи, PnL, закрытия, баланс)
  attachLiveWebSocketHub(httpServer, {
    resolveScopeFromAuth: (params) => resolveAuthFromCredentials(params),
    resolveTradeUserId: (trade) => resolveTradeUserId(trade),
    resolveScopeUserId: (scopeOrAccountId) => resolveScopeUserId(scopeOrAccountId),
    buildSnapshotForScope: async (scope) => {
      await initializeBotTrades();
      const anyConnected = hasConnectedExchangeAccount();
      const userAccs = getAccountsForUser(scope);
      const activeUserAccs = userAccs.filter((a) => a.enabled);
      const userConnected = activeUserAccs.length > 0;
      const userBalance = Number(
        activeUserAccs
          .reduce((s, a) => s + Number(a.wallet_balance_usdt ?? a.balance_usdt ?? 0), 0)
          .toFixed(2)
      );

      const scopedTrades = filterTradesForUserScope(scope);
      for (const t of scopedTrades) {
        if (t.is_open) {
          refreshTradeLivePriceFromWs(t);
          recalculateTradeMetrics(t, false);
        }
      }

      const openTrades = scopedTrades.filter((t) => t.is_open);
      const closedTrades = scopedTrades.filter((t) => !t.is_open);
      const metrics = getAggregatedMetricsForUser(userAccs, openTrades, closedTrades);
      const baseDeposit = metrics.baseDeposit;
      const totalBalance = metrics.totalBalance;
      const openProfitAbs = metrics.openProfitAbs;
      const closedProfitAbs = Number(
        closedTrades.reduce((acc, t) => acc + (t.net_profit ?? t.profit_abs ?? 0), 0).toFixed(4)
      );
      const allProfitAbs = Number((closedProfitAbs + openProfitAbs).toFixed(4));
      const equityBalance = metrics.equityBalance;
      const usedStake = metrics.usedStake;
      const freeBalance = metrics.freeBalance;

      const wins = closedTrades.filter((t) => (t.net_profit ?? t.profit_abs) >= 0).length;
      const losses = closedTrades.filter((t) => (t.net_profit ?? t.profit_abs) < 0).length;
      const winrate =
        closedTrades.length > 0 ? Number(((wins / closedTrades.length) * 100).toFixed(1)) : 0;

      const accountsPayload = userAccs.map(buildAccountPayload);
      const scopedLogs = botLogs
        .filter((l) => l.publicMarket || l.userId === scope.userId)
        .slice(-80)
        .reverse();

      const userStopped = isUserBotStopped(scope.userId);
      const userPausedEntries = isUserNewEntriesPaused(scope.userId);

      return {
        botConfig: {
          ...botConfig,
          state: userConnected && !userStopped ? 'running' : 'stopped',
          pause_new_entries: userPausedEntries,
          starting_balance: userConnected ? userBalance : 0,
          exchange_connected: userConnected,
          active_accounts_count: activeUserAccs.length,
          available_strategies: ['ScalpingStrategy', 'GlobalHedgeStrategy'],
          available_timeframes: [
            '1m',
            '3m',
            '5m',
            '15m',
            '30m',
            '1h',
            '2h',
            '4h',
            '6h',
            '8h',
            '12h',
            '1d',
            '1w',
          ],
        },
        openTrades,
        closedTrades,
        balance: {
          currencies: [
            {
              currency: 'USDT',
              free: freeBalance,
              used: usedStake,
              balance: totalBalance,
              est_stake: equityBalance,
              stake: 'USDT',
            },
          ],
          total: totalBalance,
          wallet_balance: totalBalance,
          unrealized_pnl: openProfitAbs,
          equity: equityBalance,
          equity_balance: equityBalance,
          available_balance: freeBalance,
          used_margin: usedStake,
          symbol: 'USDT',
          value: totalBalance,
          starting_capital: baseDeposit,
          starting_capital_ratio: 0,
        },
        profit: {
          profit_closed_coin: closedProfitAbs,
          profit_closed_percent:
            baseDeposit > 0 ? Number(((closedProfitAbs / baseDeposit) * 100).toFixed(2)) : 0,
          profit_closed_fiat: closedProfitAbs,
          profit_all_coin: allProfitAbs,
          profit_all_percent:
            baseDeposit > 0 ? Number(((allProfitAbs / baseDeposit) * 100).toFixed(2)) : 0,
          profit_all_fiat: allProfitAbs,
          profit_open_coin: openProfitAbs,
          profit_open_percent:
            baseDeposit > 0 ? Number(((openProfitAbs / baseDeposit) * 100).toFixed(2)) : 0,
          trade_count: scopedTrades.length,
          closed_trade_count: closedTrades.length,
          open_trade_count: openTrades.length,
          winning_trades: wins,
          losing_trades: losses,
          winrate,
          expectancy: 0,
          max_drawdown: 0,
          max_drawdown_abs: 0,
          best_pair: closedTrades[0]?.pair || openTrades[0]?.pair || 'ETH/USDT:USDT',
          best_rate: 0,
          starting_balance: baseDeposit,
          current_balance: totalBalance,
          wallet_balance: totalBalance,
          equity_balance: equityBalance,
          unrealized_pnl: openProfitAbs,
        },
        logs: scopedLogs,
        accounts: accountsPayload,
        timestamp: Date.now(),
      };
    },
    onClientPairSubscribe: (pair, timeframe) => {
      subscribePairKlineStream(pair, timeframe);
    },
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: {
          server: httpServer,
        },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`FreqtradeUI Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
