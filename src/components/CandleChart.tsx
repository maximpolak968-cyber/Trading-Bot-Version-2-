import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import {
  RefreshCw,
  Settings,
  ChevronDown,
  Search,
  X,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Minimize2,
  ChevronsLeft,
  ChevronsRight,
  Plus,
  Ruler,
  Crosshair,
  TrendingUp,
  MoveUpRight,
  Minus,
  Columns,
  AlignJustify,
  Square,
  ArrowUpCircle,
  ArrowDownCircle,
  Type,
  Magnet,
  Lock,
  Unlock,
  Eye,
  EyeOff,
  Trash2,
  Activity,
} from 'lucide-react';
import {
  ParsedCandle,
  FreqtradeTrade,
  PlotConfig,
  PairMetric,
  PairCandlesResponse,
  BotChartLevel,
  ChartDrawingObject,
  ChartDrawingPoint,
  DrawingToolType,
  parseDataframeToCandles,
  fmtComma,
} from '../types/frequi';
import { ProfitPill } from './ProfitPill';

export interface TradeLevelUpdatePayload {
  tradeId: number;
  levelType: 'tp' | 'sl' | 'dca';
  step?: number;
  price: number;
}

export interface QuickOrderFromChartPayload {
  pair: string;
  side: 'long' | 'short';
  price?: number;
  take_profit_abs?: number;
  stop_loss_abs?: number;
}

interface CandleChartProps {
  pair: string;
  availablePairs: string[];
  pairMetrics?: PairMetric[];
  onSelectPair: (p: string) => void;
  timeframe: string;
  onSelectTimeframe?: (tf: string) => void;
  strategy: string;
  exchangeSource?: string;
  candles: ParsedCandle[];
  trades: FreqtradeTrade[];
  botLevels?: BotChartLevel[];
  drawings?: ChartDrawingObject[];
  plotConfig: PlotConfig;
  onChangePlotConfig: (cfg: PlotConfig) => void;
  onRefresh: () => void;
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
  loading?: boolean;
}

interface DraggableLevelTarget {
  key: string;
  kind: 'tp' | 'sl' | 'dca' | 'bot_level';
  tradeId?: number;
  step?: number;
  botLevelId?: string;
  label: string;
  price: number;
  y: number;
  badgeX?: number;
  badgeW?: number;
}

interface CanvasDeleteHitBox {
  id: string;
  kind: 'bot_level' | 'drawing';
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
}

interface CanvasActionHitBox {
  id: string;
  kind: 'open_rr_trade';
  drawing: ChartDrawingObject;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface DraggableDrawingPointTarget {
  drawingId: string;
  pointIndex: number;
  x: number;
  y: number;
}

const TIMEFRAMES: { value: string; label: string }[] = [
  { value: '1m', label: '1m' },
  { value: '3m', label: '3m' },
  { value: '5m', label: '5m' },
  { value: '15m', label: '15m' },
  { value: '30m', label: '30m' },
  { value: '1h', label: '1h' },
  { value: '2h', label: '2h' },
  { value: '4h', label: '4h' },
  { value: '6h', label: '6h' },
  { value: '8h', label: '8h' },
  { value: '12h', label: '12h' },
  { value: '1d', label: '1D' },
  { value: '1w', label: '1W' },
];

const TIMEFRAME_MS: Record<string, number> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '6h': 21_600_000,
  '8h': 28_800_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
  '1w': 604_800_000,
};

// Maximum zoomEndPct > 100 allows scrolling forward into "future" empty space on the right like TradingView
const MAX_FUTURE_PCT = 145;
const DEFAULT_START_PCT = 82;
const DEFAULT_END_PCT = 104;

function formatAxisPrice(val: number): string {
  if (!Number.isFinite(val)) return '';
  if (val >= 1000) {
    return val.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
  if (val >= 1) {
    return val.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    });
  }
  return val.toLocaleString('en-US', {
    minimumFractionDigits: 4,
    maximumFractionDigits: 6,
  });
}

function roundDraggedPrice(val: number): number {
  if (!Number.isFinite(val) || val <= 0) return 0;
  if (val >= 1000) return Number(val.toFixed(2));
  if (val >= 1) return Number(val.toFixed(4));
  return Number(val.toFixed(6));
}

function formatCountdown(msRemaining: number): string {
  const totalSec = Math.max(0, Math.floor(msRemaining / 1000));
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hrs > 0) {
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

// Compute Technical Indicators across the full candle array
interface ComputedIndicatorSeries {
  ema20: (number | null)[];
  ema50: (number | null)[];
  sma200: (number | null)[];
  bbUpper: (number | null)[];
  bbMid: (number | null)[];
  bbLower: (number | null)[];
  vwap: (number | null)[];
  rsi14: (number | null)[];
  macdLine: (number | null)[];
  macdSignal: (number | null)[];
  macdHist: (number | null)[];
}

function computeIndicators(candles: ParsedCandle[]): ComputedIndicatorSeries {
  const n = candles.length;
  const ema20: (number | null)[] = new Array(n).fill(null);
  const ema50: (number | null)[] = new Array(n).fill(null);
  const sma200: (number | null)[] = new Array(n).fill(null);
  const bbUpper: (number | null)[] = new Array(n).fill(null);
  const bbMid: (number | null)[] = new Array(n).fill(null);
  const bbLower: (number | null)[] = new Array(n).fill(null);
  const vwap: (number | null)[] = new Array(n).fill(null);
  const rsi14: (number | null)[] = new Array(n).fill(null);
  const macdLine: (number | null)[] = new Array(n).fill(null);
  const macdSignal: (number | null)[] = new Array(n).fill(null);
  const macdHist: (number | null)[] = new Array(n).fill(null);

  if (n === 0) {
    return { ema20, ema50, sma200, bbUpper, bbMid, bbLower, vwap, rsi14, macdLine, macdSignal, macdHist };
  }

  const k20 = 2 / (20 + 1);
  const k50 = 2 / (50 + 1);
  const k12 = 2 / (12 + 1);
  const k26 = 2 / (26 + 1);
  const k9 = 2 / (9 + 1);

  let prevEma20 = candles[0].close;
  let prevEma50 = candles[0].close;
  let prevEma12 = candles[0].close;
  let prevEma26 = candles[0].close;
  let prevSignal = 0;

  let cumPV = 0;
  let cumVol = 0;
  let currentDay = -1;

  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 0; i < n; i++) {
    const c = candles[i];
    const close = c.close;

    // EMA 20 & EMA 50
    prevEma20 = i === 0 ? close : close * k20 + prevEma20 * (1 - k20);
    prevEma50 = i === 0 ? close : close * k50 + prevEma50 * (1 - k50);
    if (i >= 5) ema20[i] = prevEma20;
    if (i >= 15) ema50[i] = prevEma50;

    // EMA 12 & 26 for MACD
    prevEma12 = i === 0 ? close : close * k12 + prevEma12 * (1 - k12);
    prevEma26 = i === 0 ? close : close * k26 + prevEma26 * (1 - k26);
    if (i >= 25) {
      const m = prevEma12 - prevEma26;
      macdLine[i] = m;
      prevSignal = i === 25 ? m : m * k9 + prevSignal * (1 - k9);
      macdSignal[i] = prevSignal;
      macdHist[i] = m - prevSignal;
    }

    // SMA 200
    if (i >= 199) {
      let sum200 = 0;
      for (let j = i - 199; j <= i; j++) sum200 += candles[j].close;
      sma200[i] = sum200 / 200;
    }

    // Bollinger Bands (20, 2)
    if (i >= 19) {
      let sum20 = 0;
      for (let j = i - 19; j <= i; j++) sum20 += candles[j].close;
      const mean = sum20 / 20;
      let variance = 0;
      for (let j = i - 19; j <= i; j++) {
        const d = candles[j].close - mean;
        variance += d * d;
      }
      const std = Math.sqrt(variance / 20);
      bbMid[i] = mean;
      bbUpper[i] = mean + 2 * std;
      bbLower[i] = mean - 2 * std;
    }

    // Daily anchored VWAP
    const dayKey = Math.floor(c.timestamp / 86_400_000);
    if (dayKey !== currentDay) {
      currentDay = dayKey;
      cumPV = 0;
      cumVol = 0;
    }
    const typicalPrice = (c.high + c.low + c.close) / 3;
    cumPV += typicalPrice * c.volume;
    cumVol += c.volume;
    vwap[i] = cumVol > 0 ? cumPV / cumVol : close;

    // RSI 14
    if (i > 0) {
      const diff = close - candles[i - 1].close;
      const gain = diff > 0 ? diff : 0;
      const loss = diff < 0 ? -diff : 0;
      if (i <= 14) {
        avgGain += gain / 14;
        avgLoss += loss / 14;
        if (i === 14) {
          const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
          rsi14[i] = 100 - 100 / (1 + rs);
        }
      } else {
        avgGain = (avgGain * 13 + gain) / 14;
        avgLoss = (avgLoss * 13 + loss) / 14;
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        rsi14[i] = 100 - 100 / (1 + rs);
      }
    }
  }

  return { ema20, ema50, sma200, bbUpper, bbMid, bbLower, vwap, rsi14, macdLine, macdSignal, macdHist };
}


// Draw a TradingView / Bybit horizontal level line with optional [×] delete button on badge
function drawHorizontalLevel(
  ctx: CanvasRenderingContext2D,
  opts: {
    y: number;
    plotLeft: number;
    plotRight: number;
    plotTop: number;
    plotBottom: number;
    rightPriceAxisWidth: number;
    priceText: string;
    badgeText: string;
    lineColor: string;
    badgeBg: string;
    badgeBorder: string;
    badgeTextColor?: string;
    axisTagBg: string;
    lineWidth?: number;
    dash?: number[];
    badgeX?: number;
    isHoveredOrDragged?: boolean;
    deletableId?: string;
    deleteHitBoxes?: CanvasDeleteHitBox[];
  }
) {
  const {
    y,
    plotLeft,
    plotRight,
    plotTop,
    plotBottom,
    rightPriceAxisWidth,
    priceText,
    badgeText,
    lineColor,
    badgeBg,
    badgeBorder,
    badgeTextColor = '#ffffff',
    axisTagBg,
    lineWidth = 1.5,
    dash = [],
    badgeX,
    isHoveredOrDragged = false,
    deletableId,
    deleteHitBoxes,
  } = opts;

  if (y < plotTop + 2 || y > plotBottom - 2) return { boxX: plotLeft + 10, boxW: 60 };

  ctx.save();

  // 1. Horizontal level line across chart
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = isHoveredOrDragged ? lineWidth + 0.9 : lineWidth;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(plotLeft, y);
  ctx.lineTo(plotRight, y);
  ctx.stroke();
  ctx.setLineDash([]);

  // 2. Price tag on the right price axis
  ctx.fillStyle = axisTagBg;
  ctx.fillRect(plotRight + 1, y - 9, rightPriceAxisWidth - 2, 18);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 10.5px monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(priceText, plotRight + 5, y + 0.5);

  // 3. Inline TradingView pill badge on the horizontal line (with optional × delete button)
  ctx.font = 'bold 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  const textW = ctx.measureText(badgeText).width;
  const padX = 6;
  const closeBtnW = deletableId ? 16 : 0;
  const boxH = 18;
  const boxW = textW + padX * 2 + closeBtnW;
  const defaultX = plotRight - boxW - 10;
  const boxX =
    badgeX !== undefined
      ? Math.min(plotRight - boxW - 8, Math.max(plotLeft + 6, badgeX))
      : Math.max(plotLeft + 6, defaultX);
  const boxY = y - boxH / 2;

  ctx.fillStyle = badgeBg;
  ctx.strokeStyle = badgeBorder;
  ctx.lineWidth = isHoveredOrDragged ? 1.6 : 1;
  ctx.beginPath();
  ctx.roundRect(boxX, boxY, boxW, boxH, 3);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = badgeTextColor;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(badgeText, boxX + padX, y + 0.5);

  // Draw interactive [×] button inside the right side of the badge if deletable
  if (deletableId && deleteHitBoxes) {
    const btnX = boxX + boxW - closeBtnW;
    ctx.strokeStyle = badgeBorder;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(btnX, boxY + 2);
    ctx.lineTo(btnX, boxY + boxH - 2);
    ctx.stroke();

    ctx.fillStyle = '#fca5a5';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('×', btnX + closeBtnW / 2, y + 0.5);

    deleteHitBoxes.push({
      id: deletableId,
      kind: 'bot_level',
      x: btnX - 2,
      y: boxY - 2,
      w: closeBtnW + 4,
      h: boxH + 4,
      label: badgeText,
    });
  }

  ctx.restore();
  return { boxX, boxW };
}

export const CandleChart: React.FC<CandleChartProps> = ({
  pair,
  availablePairs,
  pairMetrics = [],
  onSelectPair,
  timeframe,
  onSelectTimeframe,
  strategy,
  exchangeSource,
  candles,
  trades,
  botLevels = [],
  drawings = [],
  plotConfig,
  onChangePlotConfig,
  onRefresh,
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
  loading = false,
}) => {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const indicatorsDropdownRef = useRef<HTMLDivElement>(null);
  const trashDropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const sliderRef = useRef<HTMLDivElement>(null);

  const draggableTargetsRef = useRef<DraggableLevelTarget[]>([]);
  const deleteHitBoxesRef = useRef<CanvasDeleteHitBox[]>([]);
  const actionHitBoxesRef = useRef<CanvasActionHitBox[]>([]);
  const drawingPointTargetsRef = useRef<DraggableDrawingPointTarget[]>([]);

  const [showConfigModal, setShowConfigModal] = useState(false);
  const [showIndicatorsMenu, setShowIndicatorsMenu] = useState(false);
  const [showTrashMenu, setShowTrashMenu] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // TradingView Left Drawing Sidebar State
  const [activeTool, setActiveTool] = useState<DrawingToolType>('cursor');
  const [magnetEnabled, setMagnetEnabled] = useState<boolean>(false);
  const [stayInDrawingMode] = useState<boolean>(false);
  const [lockAllDrawings, setLockAllDrawings] = useState<boolean>(false);
  const [hideAllDrawings, setHideAllDrawings] = useState<boolean>(false);
  const [selectedDrawingId, setSelectedDrawingId] = useState<string | null>(null);

  // In-progress drawing state (e.g. after 1st click of Trendline, Fib, Rect, Ruler)
  const [draftPoints, setDraftPoints] = useState<ChartDrawingPoint[]>([]);

  // Live clock & candle countdown state (updates every 1s like TradingView)
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Binance-style collapsible coin selector state above the chart
  const [isPairDropdownOpen, setIsPairDropdownOpen] = useState(false);
  const [pairSearchQuery, setPairSearchQuery] = useState('');
  const [pairTabFilter, setPairTabFilter] = useState<'all' | 'open'>('all');

  // Older historical candles loaded when scrolling left (TradingView infinite history)
  const [olderCandles, setOlderCandles] = useState<ParsedCandle[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [reachedBeginning, setReachedBeginning] = useState(false);

  // Range slider & TradingView viewport state (allows > 100% for right-side future space!)
  const [zoomStartPct, setZoomStartPct] = useState<number>(DEFAULT_START_PCT);
  const [zoomEndPct, setZoomEndPct] = useState<number>(DEFAULT_END_PCT);

  // Vertical price scale adjustment (TradingView right price axis drag)
  const [priceScaleMult, setPriceScaleMult] = useState<number>(1);
  const [pricePanOffset, setPricePanOffset] = useState<number>(0);

  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);
  const [hoveredLevelKey, setHoveredLevelKey] = useState<string | null>(null);
  const [hoveredDeleteId, setHoveredDeleteId] = useState<string | null>(null);

  // Dragging state (pan, priceAxis, slider, level, or drawing node)
  const [dragMode, setDragMode] = useState<
    'none' | 'pan' | 'priceAxis' | 'slider' | 'level' | 'drawingPoint'
  >('none');
  const [draggingLevel, setDraggingLevel] = useState<{
    target: DraggableLevelTarget;
    currentPrice: number;
  } | null>(null);
  const [draggingDrawingPoint, setDraggingDrawingPoint] = useState<{
    drawingId: string;
    pointIndex: number;
    points: ChartDrawingPoint[];
  } | null>(null);

  // Synchronous refs so fast mousemove -> mouseup never sees stale React closures
  const dragModeRef = useRef<
    'none' | 'pan' | 'priceAxis' | 'slider' | 'level' | 'drawingPoint'
  >('none');
  const dragStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const draggingLevelRef = useRef<{
    target: DraggableLevelTarget;
    currentPrice: number;
  } | null>(null);
  const draggingDrawingPointRef = useRef<{
    drawingId: string;
    pointIndex: number;
    points: ChartDrawingPoint[];
  } | null>(null);

  const [dimensions, setDimensions] = useState<{ width: number; height: number }>({
    width: 960,
    height: 520,
  });

  // Handle Fullscreen toggle
  const toggleFullscreen = useCallback(() => {
    setIsFullscreen((prev) => {
      const next = !prev;
      try {
        if (next && wrapperRef.current?.requestFullscreen) {
          wrapperRef.current.requestFullscreen().catch(() => {});
        } else if (!next && document.fullscreenElement) {
          document.exitFullscreen().catch(() => {});
        }
      } catch {
        // Fallback to fixed inset-0 z-50 fullscreen
      }
      return next;
    });
  }, []);

  // Keyboard shortcuts: Escape cancels active tool/fullscreen; Delete/Backspace deletes selected drawing or hovered level
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (draftPoints.length > 0) {
          setDraftPoints([]);
          return;
        }
        if (activeTool !== 'cursor') {
          setActiveTool('cursor');
          return;
        }
        if (selectedDrawingId) {
          setSelectedDrawingId(null);
          return;
        }
        if (isFullscreen) setIsFullscreen(false);
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // Ignore if typing in input
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

        if (selectedDrawingId && onDeleteDrawing) {
          onDeleteDrawing(selectedDrawingId);
          setSelectedDrawingId(null);
          return;
        }
        if (hoveredLevelKey && hoveredLevelKey.startsWith('bot-') && onDeleteBotLevel) {
          const botId = hoveredLevelKey.replace(/^bot-/, '');
          onDeleteBotLevel(botId);
          setHoveredLevelKey(null);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    isFullscreen,
    activeTool,
    draftPoints.length,
    selectedDrawingId,
    hoveredLevelKey,
    onDeleteDrawing,
    onDeleteBotLevel,
  ]);

  // Reset older history and viewport when pair or timeframe changes
  useEffect(() => {
    setOlderCandles([]);
    setReachedBeginning(false);
    setPriceScaleMult(1);
    setPricePanOffset(0);
    setZoomStartPct(DEFAULT_START_PCT);
    setZoomEndPct(DEFAULT_END_PCT);
    setHoverIndex(null);
    setDraftPoints([]);
    setSelectedDrawingId(null);
  }, [pair, timeframe]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setDimensions({ width: Math.floor(rect.width), height: Math.floor(rect.height) });
      }
    };
    updateSize();
    const obs = new ResizeObserver(updateSize);
    obs.observe(el);
    return () => obs.disconnect();
  }, [isFullscreen]);

  // Merge older historical batches + current candles seamlessly
  const mergedCandles = useMemo(() => {
    if (olderCandles.length === 0) return candles;
    const map = new Map<number, ParsedCandle>();
    for (const c of olderCandles) map.set(c.timestamp, c);
    for (const c of candles) map.set(c.timestamp, c);
    return Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp);
  }, [olderCandles, candles]);

  // Load 1000 older historical candles before the earliest loaded timestamp
  const loadOlderHistory = useCallback(async () => {
    if (loadingOlder || reachedBeginning || mergedCandles.length === 0) return;
    const earliestTs = mergedCandles[0].timestamp;
    setLoadingOlder(true);
    try {
      const res = await fetch(
        `/api/v1/pair_candles?pair=${encodeURIComponent(pair)}&timeframe=${encodeURIComponent(
          timeframe
        )}&strategy=${encodeURIComponent(strategy)}&limit=1000&endTime=${earliestTs - 1}`
      );
      if (res.ok) {
        const df: PairCandlesResponse = await res.json();
        const batch = parseDataframeToCandles(df).filter((c) => c.timestamp < earliestTs);
        if (batch.length === 0) {
          setReachedBeginning(true);
        } else {
          const prevLen = mergedCandles.length;
          const newLen = prevLen + batch.length;
          const addedRatio = (batch.length / newLen) * 100;
          const scaleRatio = prevLen / newLen;

          setOlderCandles((prev) => [...batch, ...prev]);
          setZoomStartPct((prevStart) => Math.min(95, addedRatio + prevStart * scaleRatio));
          setZoomEndPct((prevEnd) => Math.min(MAX_FUTURE_PCT, addedRatio + prevEnd * scaleRatio));
        }
      }
    } catch (err) {
      console.error('Failed to load older candle history:', err);
    } finally {
      setLoadingOlder(false);
    }
  }, [loadingOlder, reachedBeginning, mergedCandles, pair, timeframe, strategy]);

  // Optional Heikin Ashi transform
  const processedCandles = useMemo(() => {
    if (!plotConfig.heikinAshi || mergedCandles.length === 0) return mergedCandles;
    const res: ParsedCandle[] = [];
    for (let i = 0; i < mergedCandles.length; i++) {
      const c = mergedCandles[i];
      const haClose = (c.open + c.high + c.low + c.close) / 4;
      const haOpen = i === 0 ? (c.open + c.close) / 2 : (res[i - 1].open + res[i - 1].close) / 2;
      const haHigh = Math.max(c.high, haOpen, haClose);
      const haLow = Math.min(c.low, haOpen, haClose);
      res.push({ ...c, open: haOpen, high: haHigh, low: haLow, close: haClose });
    }
    return res;
  }, [mergedCandles, plotConfig.heikinAshi]);

  // Full indicator calculations across all loaded candles
  const indicators = useMemo(() => computeIndicators(processedCandles), [processedCandles]);

  // Visible slice supporting future empty slots on the right when zoomEndPct > 100 (TradingView style)
  const visibleSlice = useMemo(() => {
    const total = processedCandles.length;
    if (total === 0) {
      return { items: [] as ParsedCandle[], startIdx: 0, endIdx: 0, totalSlots: 0 };
    }
    const startIdx = Math.max(0, Math.min(total - 5, Math.floor((zoomStartPct / 100) * total)));
    const rawEndSlot = Math.max(startIdx + 10, Math.ceil((zoomEndPct / 100) * total));
    const endIdx = Math.min(total, rawEndSlot);
    const totalSlots = Math.max(endIdx - startIdx, rawEndSlot - startIdx);
    return {
      items: processedCandles.slice(startIdx, endIdx),
      startIdx,
      endIdx,
      totalSlots,
    };
  }, [processedCandles, zoomStartPct, zoomEndPct]);

  const hasSubOscillator = Boolean(plotConfig.showRsi || plotConfig.showMacd);

  // Price & time mapping helper shared between rendering and mouse drag events
  const chartGeometry = useMemo(() => {
    const width = dimensions.width;
    const height = dimensions.height;
    const topMargin = 8;
    const bottomTimeAxisHeight = 26;
    const rightPriceAxisWidth = 82;
    const plotLeft = 8;
    const plotRight = Math.max(plotLeft + 100, width - rightPriceAxisWidth);
    const plotWidth = plotRight - plotLeft;
    const plotTop = topMargin;
    const fullPlotBottom = Math.max(plotTop + 160, height - bottomTimeAxisHeight);

    // Reserve lower 24% of canvas if RSI or MACD oscillator sub-pane is enabled
    const subPaneHeight = hasSubOscillator
      ? Math.max(85, Math.floor((fullPlotBottom - plotTop) * 0.24))
      : 0;
    const plotBottom = fullPlotBottom - subPaneHeight;
    const plotHeight = plotBottom - plotTop;
    const subTop = plotBottom;
    const subBottom = fullPlotBottom;

    const items = visibleSlice.items;
    let minPrice = Infinity;
    let maxPrice = -Infinity;
    for (const c of items) {
      if (c.low < minPrice) minPrice = c.low;
      if (c.high > maxPrice) maxPrice = c.high;
    }

    const pairOpenTrades = trades.filter((t) => t.is_open && t.pair === pair);
    const pairBotLevels = botLevels.filter((l) => l.pair === pair);
    if (plotConfig.showTrades && Number.isFinite(minPrice) && Number.isFinite(maxPrice)) {
      const candleMid = (minPrice + maxPrice) / 2;
      const candleSpan = Math.max(candleMid * 0.002, maxPrice - minPrice);
      const includeIfNear = (p?: number, isManual = false) => {
        const maxDist = isManual
          ? Math.max(candleSpan * 4.5, candleMid * 0.35)
          : Math.max(candleSpan * 1.6, candleMid * 0.08);
        if (p && Number.isFinite(p) && p > 0 && Math.abs(p - candleMid) <= maxDist) {
          if (p < minPrice) minPrice = p;
          if (p > maxPrice) maxPrice = p;
        }
      };
      for (const t of pairOpenTrades) {
        includeIfNear(t.open_rate, true);
        includeIfNear(t.initial_open_rate, false);
        includeIfNear(t.take_profit_abs, Boolean(t.tp_manual_override));
        includeIfNear(t.stop_loss_abs, Boolean(t.sl_manual_override));
        includeIfNear(t.next_dca_price, Boolean(t.dca_manual_override));
        if (Array.isArray(t.planned_dca_levels)) {
          for (const dcaLvl of t.planned_dca_levels) {
            includeIfNear(dcaLvl.price, Boolean(dcaLvl.manual_override || t.dca_manual_override));
          }
        }
      }
      for (const bl of pairBotLevels) {
        includeIfNear(bl.price, Boolean(bl.manual_override));
      }
    }

    if (!Number.isFinite(minPrice) || !Number.isFinite(maxPrice)) {
      minPrice = 90;
      maxPrice = 110;
    }

    const rawRange = Math.max(1e-8, maxPrice - minPrice);
    const midPrice = (maxPrice + minPrice) / 2 + pricePanOffset * rawRange;
    const halfSpan = rawRange * 0.64 * priceScaleMult;
    const paddedMin = midPrice - halfSpan * 1.1;
    const paddedMax = midPrice + halfSpan * 0.9;
    const paddedRange = Math.max(1e-8, paddedMax - paddedMin);

    const priceToY = (p: number) =>
      plotTop + plotHeight - ((p - paddedMin) / paddedRange) * plotHeight;
    const yToPrice = (y: number) =>
      paddedMin + ((plotTop + plotHeight - y) / plotHeight) * paddedRange;

    const totalSlots = Math.max(1, visibleSlice.totalSlots);
    const stepX = plotWidth / totalSlots;
    const candleWidth = Math.max(1.5, Math.min(13, stepX * 0.74));
    const idxToX = (idx: number) => plotLeft + idx * stepX + stepX / 2;

    const tfMs =
      items.length >= 2
        ? Math.max(60_000, items[items.length - 1].timestamp - items[items.length - 2].timestamp)
        : TIMEFRAME_MS[timeframe] || 300_000;

    const slotToTimestamp = (slotIdx: number) => {
      if (items.length === 0) return Date.now();
      if (slotIdx >= 0 && slotIdx < items.length) return items[slotIdx].timestamp;
      if (slotIdx < 0) return items[0].timestamp + slotIdx * tfMs;
      const extraSlots = slotIdx - (items.length - 1);
      return items[items.length - 1].timestamp + extraSlots * tfMs;
    };

    const timestampToSlot = (ts: number): number => {
      if (items.length === 0) return 0;
      const firstTs = items[0].timestamp;
      const lastTs = items[items.length - 1].timestamp;
      if (ts <= firstTs) {
        return (ts - firstTs) / tfMs;
      }
      if (ts > lastTs) {
        return items.length - 1 + (ts - lastTs) / tfMs;
      }
      // Binary search in visible items
      let lo = 0;
      let hi = items.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const mTs = items[mid].timestamp;
        if (mTs === ts) return mid;
        if (mTs < ts) lo = mid + 1;
        else hi = mid - 1;
      }
      return Math.max(0, Math.min(items.length - 1, lo));
    };

    const timestampToX = (ts: number) => idxToX(timestampToSlot(ts));
    const xToTimestamp = (x: number) => {
      const slotIdx = Math.round((x - plotLeft - stepX / 2) / stepX);
      return slotToTimestamp(slotIdx);
    };

    return {
      width,
      height,
      plotLeft,
      plotRight,
      plotWidth,
      plotTop,
      plotBottom,
      plotHeight,
      subTop,
      subBottom,
      subPaneHeight,
      rightPriceAxisWidth,
      paddedMin,
      paddedMax,
      priceToY,
      yToPrice,
      stepX,
      candleWidth,
      idxToX,
      totalSlots,
      tfMs,
      slotToTimestamp,
      timestampToSlot,
      timestampToX,
      xToTimestamp,
    };
  }, [
    dimensions,
    visibleSlice,
    trades,
    botLevels,
    pair,
    timeframe,
    plotConfig.showTrades,
    hasSubOscillator,
    pricePanOffset,
    priceScaleMult,
  ]);

  // Snap point to nearest candle OHLC when Magnet mode is active
  const resolvePointAtCursor = useCallback(
    (x: number, y: number): ChartDrawingPoint => {
      const slotIdx = Math.round(
        (x - chartGeometry.plotLeft - chartGeometry.stepX / 2) / chartGeometry.stepX
      );
      const ts = chartGeometry.slotToTimestamp(slotIdx);
      let price = roundDraggedPrice(chartGeometry.yToPrice(y));

      if (magnetEnabled && slotIdx >= 0 && slotIdx < visibleSlice.items.length) {
        const c = visibleSlice.items[slotIdx];
        const candidates = [c.open, c.high, c.low, c.close];
        let best = price;
        let minDiff = Infinity;
        for (const cand of candidates) {
          const diff = Math.abs(cand - price);
          if (diff < minDiff) {
            minDiff = diff;
            best = cand;
          }
        }
        price = roundDraggedPrice(best);
      }
      return { timestamp: ts, price };
    },
    [chartGeometry, magnetEnabled, visibleSlice.items]
  );

  // Render TradingView Canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const {
      width,
      height,
      plotLeft,
      plotRight,
      plotWidth,
      plotTop,
      plotBottom,
      plotHeight,
      subTop,
      subBottom,
      subPaneHeight,
      rightPriceAxisWidth,
      priceToY,
      yToPrice,
      stepX,
      candleWidth,
      idxToX,
      totalSlots,
      tfMs,
      slotToTimestamp,
      timestampToSlot,
      timestampToX,
    } = chartGeometry;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    // 1. TradingView Dark Canvas Background (#131722)
    ctx.fillStyle = '#131722';
    ctx.fillRect(0, 0, width, height);

    const items = visibleSlice.items;
    if (items.length === 0) {
      ctx.fillStyle = '#9ca3af';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(
        loading ? 'Загрузка рыночных свечей...' : 'Нет данных по графику',
        width / 2,
        height / 2
      );
      return;
    }

    // 2. VERTICAL & HORIZONTAL TRADINGVIEW GRID LINES + BOTTOM TIME AXIS
    const labelEvery = Math.max(1, Math.floor(totalSlots / 10));
    const isHourlyTf = timeframe.endsWith('h');
    let prevDayKey = '';

    ctx.textAlign = 'center';
    ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

    for (let i = 0; i < totalSlots; i += labelEvery) {
      const x = idxToX(i);
      const ts = slotToTimestamp(i);
      const d = new Date(ts);
      const hours = d.getUTCHours();
      const mins = d.getUTCMinutes();
      const day = d.getUTCDate();
      const month = d.getUTCMonth() + 1;
      const dayKey = `${d.getUTCFullYear()}-${month}-${day}`;
      const isNewDay = prevDayKey !== '' && dayKey !== prevDayKey;
      prevDayKey = dayKey;

      ctx.strokeStyle = 'rgba(42, 46, 57, 0.65)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, plotTop);
      ctx.lineTo(x, subBottom);
      ctx.stroke();

      const timePart = `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
      const datePart = `${String(day).padStart(2, '0')}.${String(month).padStart(2, '0')}`;
      let label = timePart;

      if (timeframe === '1d' || timeframe === '1w' || totalSlots > 350) {
        label = datePart;
        ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      } else if ((hours === 0 && mins === 0) || isNewDay) {
        label =
          isHourlyTf && hours !== 0
            ? `${datePart} ${String(hours).padStart(2, '0')}:00`
            : datePart;
        ctx.font = 'bold 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      } else {
        ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      }

      ctx.fillStyle = '#787b86';
      ctx.fillText(label, x, subBottom + 16);
    }

    // Horizontal grid lines & Right Price Axis
    const gridSteps = 6;
    ctx.textAlign = 'left';
    ctx.font = '11px monospace';

    for (let i = 0; i <= gridSteps; i++) {
      const y = plotTop + (plotHeight / gridSteps) * i;
      const val = yToPrice(y);

      ctx.strokeStyle = 'rgba(42, 46, 57, 0.75)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(plotLeft, y);
      ctx.lineTo(plotRight, y);
      ctx.stroke();

      ctx.fillStyle = '#9ca3af';
      ctx.fillText(formatAxisPrice(val), plotRight + 6, y + 4);
    }

    // Axis border lines (Bottom & Right like TradingView)
    ctx.strokeStyle = '#2a2e39';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plotLeft, subBottom);
    ctx.lineTo(width, subBottom);
    ctx.moveTo(plotRight, plotTop);
    ctx.lineTo(plotRight, height);
    if (hasSubOscillator) {
      ctx.moveTo(plotLeft, plotBottom);
      ctx.lineTo(width, plotBottom);
    }
    ctx.stroke();

    // 3. VOLUME BARS ALONG BOTTOM OF MAIN CHART + OPTIONAL VOLUME PROFILE (VPVR)
    if (plotConfig.showVolume) {
      const maxVol = Math.max(1, ...items.map((c) => c.volume));
      const maxVolHeight = plotHeight * 0.14;
      for (let i = 0; i < items.length; i++) {
        const c = items[i];
        const x = idxToX(i);
        const h = (c.volume / maxVol) * maxVolHeight;
        const isBull = c.close >= c.open;
        ctx.fillStyle = isBull ? 'rgba(8, 153, 129, 0.24)' : 'rgba(242, 54, 69, 0.24)';
        ctx.fillRect(x - candleWidth / 2, plotBottom - h, candleWidth, h);
      }
    }

    // 3B. Volume Profile Visible Range (VPVR) on the right side of the main plot
    if (plotConfig.showVolumeProfile && items.length > 5) {
      const bins = 24;
      const vMin = Math.min(...items.map((c) => c.low));
      const vMax = Math.max(...items.map((c) => c.high));
      const vSpan = Math.max(1e-8, vMax - vMin);
      const binStep = vSpan / bins;
      const bullVols = new Array(bins).fill(0);
      const bearVols = new Array(bins).fill(0);

      for (const c of items) {
        const mid = (c.high + c.low + c.close) / 3;
        const bIdx = Math.max(0, Math.min(bins - 1, Math.floor((mid - vMin) / binStep)));
        if (c.close >= c.open) bullVols[bIdx] += c.volume;
        else bearVols[bIdx] += c.volume;
      }

      let maxBinVol = 1;
      let pocBin = 0;
      for (let b = 0; b < bins; b++) {
        const tot = bullVols[b] + bearVols[b];
        if (tot > maxBinVol) {
          maxBinVol = tot;
          pocBin = b;
        }
      }

      const maxBarW = plotWidth * 0.18;
      ctx.save();
      for (let b = 0; b < bins; b++) {
        const pLow = vMin + b * binStep;
        const pHigh = pLow + binStep;
        const yTop = Math.max(plotTop, priceToY(pHigh));
        const yBot = Math.min(plotBottom, priceToY(pLow));
        const barH = Math.max(2, yBot - yTop - 1);
        const bullW = (bullVols[b] / maxBinVol) * maxBarW;
        const bearW = (bearVols[b] / maxBinVol) * maxBarW;

        ctx.fillStyle = 'rgba(8, 153, 129, 0.28)';
        ctx.fillRect(plotRight - bullW - bearW, yTop, bullW, barH);
        ctx.fillStyle = 'rgba(242, 54, 69, 0.28)';
        ctx.fillRect(plotRight - bearW, yTop, bearW, barH);

        if (b === pocBin) {
          const pocY = (yTop + yBot) / 2;
          ctx.strokeStyle = 'rgba(234, 179, 8, 0.85)';
          ctx.lineWidth = 1.4;
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.moveTo(plotLeft, pocY);
          ctx.lineTo(plotRight, pocY);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
      ctx.restore();
    }

    // 4. TECHNICAL OVERLAY INDICATORS (Bollinger Bands, EMA 20, EMA 50, SMA 200, VWAP)
    const drawOverlayLine = (series: (number | null)[], color: string, lineWidth = 1.4, dash: number[] = []) => {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.setLineDash(dash);
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < items.length; i++) {
        const globalIdx = visibleSlice.startIdx + i;
        const val = series[globalIdx];
        if (val === null || val === undefined || !Number.isFinite(val)) continue;
        const x = idxToX(i);
        const y = priceToY(val);
        if (y < plotTop - 20 || y > plotBottom + 20) continue;
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
      ctx.restore();
    };

    if (plotConfig.showBollinger) {
      // Shaded Bollinger channel
      ctx.save();
      ctx.fillStyle = 'rgba(6, 182, 212, 0.08)';
      ctx.beginPath();
      const validIndices: number[] = [];
      for (let i = 0; i < items.length; i++) {
        const gIdx = visibleSlice.startIdx + i;
        if (indicators.bbUpper[gIdx] !== null && indicators.bbLower[gIdx] !== null) {
          validIndices.push(i);
        }
      }
      if (validIndices.length > 1) {
        validIndices.forEach((i, k) => {
          const gIdx = visibleSlice.startIdx + i;
          const x = idxToX(i);
          const y = priceToY(indicators.bbUpper[gIdx]!);
          if (k === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        for (let k = validIndices.length - 1; k >= 0; k--) {
          const i = validIndices[k];
          const gIdx = visibleSlice.startIdx + i;
          const x = idxToX(i);
          const y = priceToY(indicators.bbLower[gIdx]!);
          ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();

      drawOverlayLine(indicators.bbUpper, 'rgba(6, 182, 212, 0.75)', 1.1);
      drawOverlayLine(indicators.bbMid, 'rgba(6, 182, 212, 0.5)', 1.0, [3, 3]);
      drawOverlayLine(indicators.bbLower, 'rgba(6, 182, 212, 0.75)', 1.1);
    }

    if (plotConfig.showEma20) drawOverlayLine(indicators.ema20, '#38bdf8', 1.5);
    if (plotConfig.showEma50) drawOverlayLine(indicators.ema50, '#f59e0b', 1.5);
    if (plotConfig.showSma200) drawOverlayLine(indicators.sma200, '#a855f7', 1.7);
    if (plotConfig.showVwap) drawOverlayLine(indicators.vwap, '#eab308', 1.4, [4, 2]);

    // 5. CANDLESTICKS (TradingView Emerald Green #089981 bullish, Crimson Red #f23645 bearish)
    if (plotConfig.showCandles) {
      for (let i = 0; i < items.length; i++) {
        const c = items[i];
        const x = idxToX(i);
        const isBull = c.close >= c.open;
        const color = isBull ? '#089981' : '#f23645';

        const highY = priceToY(c.high);
        const lowY = priceToY(c.low);
        const openY = priceToY(c.open);
        const closeY = priceToY(c.close);

        ctx.strokeStyle = color;
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.moveTo(x, highY);
        ctx.lineTo(x, lowY);
        ctx.stroke();

        const top = Math.min(openY, closeY);
        const bodyH = Math.max(1.5, Math.abs(closeY - openY));
        ctx.fillStyle = color;
        ctx.fillRect(x - candleWidth / 2, top, candleWidth, bodyH);
      }
    }

    // 6. LIVE CURRENT PRICE LINE, GLOWING DOT & RIGHT AXIS PRICE TAG WITH CANDLE COUNTDOWN (LIKE SCREENSHOT)
    const lastCandle = processedCandles[processedCandles.length - 1];
    if (lastCandle) {
      const curY = priceToY(lastCandle.close);
      const isBullLast = lastCandle.close >= lastCandle.open;
      const liveColor = isBullLast ? '#089981' : '#f23645';

      const lastVisibleIdx = items.length - 1;
      if (
        lastVisibleIdx >= 0 &&
        items[lastVisibleIdx].timestamp === lastCandle.timestamp &&
        curY >= plotTop &&
        curY <= plotBottom
      ) {
        const lastX = idxToX(lastVisibleIdx);
        ctx.save();
        ctx.fillStyle = liveColor;
        ctx.beginPath();
        ctx.arc(lastX, curY, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      if (curY >= plotTop && curY <= plotBottom) {
        ctx.save();
        ctx.strokeStyle = isBullLast ? 'rgba(8, 153, 129, 0.75)' : 'rgba(242, 54, 69, 0.75)';
        ctx.lineWidth = 1.2;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(plotLeft, curY);
        ctx.lineTo(plotRight, curY);
        ctx.stroke();
        ctx.restore();

        // Prominent 2-line live price + countdown tag on right price axis (matching screenshot: 0,9044 / 02:34:31)
        const periodMs = TIMEFRAME_MS[timeframe] || 300_000;
        const nextCloseMs = Math.ceil(nowTick / periodMs) * periodMs;
        const countdownStr = formatCountdown(nextCloseMs - nowTick);

        ctx.fillStyle = liveColor;
        ctx.fillRect(plotRight + 1, curY - 14, rightPriceAxisWidth - 2, 28);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 11px monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(formatAxisPrice(lastCandle.close), plotRight + 5, curY - 5);
        ctx.font = '9.5px monospace';
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.fillText(countdownStr, plotRight + 5, curY + 7.5);
      }
    }

    // 7. STRATEGY BUY (Green ▲) & SELL (Red ▼) MARKERS ON CANDLES
    for (let i = 0; i < items.length; i++) {
      const c = items[i];
      const x = idxToX(i);

      if (plotConfig.showEntry && c.enter_long !== null) {
        const y = priceToY(c.low) + 6;
        ctx.fillStyle = '#10b981';
        ctx.beginPath();
        ctx.moveTo(x, y - 5);
        ctx.lineTo(x - 4.5, y + 4);
        ctx.lineTo(x + 4.5, y + 4);
        ctx.closePath();
        ctx.fill();
      }

      if (plotConfig.showExit && c.exit_long !== null) {
        const y = priceToY(c.high) - 6;
        ctx.fillStyle = '#ef4444';
        ctx.beginPath();
        ctx.moveTo(x, y + 5);
        ctx.lineTo(x - 4.5, y - 4);
        ctx.lineTo(x + 4.5, y - 4);
        ctx.closePath();
        ctx.fill();
      }
    }

    // 8. TRADINGVIEW / BYBIT HORIZONTAL LEVELS & DRAGGABLE TARGETS + DELETE [×] HIT BOXES
    const nextDraggableTargets: DraggableLevelTarget[] = [];
    const nextDeleteHitBoxes: CanvasDeleteHitBox[] = [];
    const nextActionHitBoxes: CanvasActionHitBox[] = [];
    const nextDrawingPointTargets: DraggableDrawingPointTarget[] = [];

    if (plotConfig.showTrades && !hideAllDrawings) {
      // 8B. Bot Support / Resistance / Trigger Levels on this coin (draggable + deletable via [×]!)
      const pairBotLevels = botLevels.filter((l) => l.pair === pair);
      pairBotLevels.forEach((bl, idx) => {
        const tKey = `bot-${bl.id}`;
        const activePrice =
          draggingLevel && draggingLevel.target.key === tKey
            ? draggingLevel.currentPrice
            : bl.price;
        const lvlY = priceToY(activePrice);
        const isActive =
          hoveredLevelKey === tKey || (draggingLevel && draggingLevel.target.key === tKey);

        const botBadgeInfo = drawHorizontalLevel(ctx, {
          y: lvlY,
          plotLeft,
          plotRight,
          plotTop,
          plotBottom,
          rightPriceAxisWidth,
          priceText: formatAxisPrice(activePrice),
          badgeText: `↕ ${bl.label}`,
          lineColor: '#38bdf8',
          badgeBg: 'rgba(12, 45, 72, 0.94)',
          badgeBorder: '#38bdf8',
          badgeTextColor: '#e0f2fe',
          axisTagBg: '#0284c7',
          lineWidth: 1.3,
          dash: [6, 4],
          badgeX: plotLeft + 14 + idx * 145,
          isHoveredOrDragged: Boolean(isActive),
          deletableId: bl.id,
          deleteHitBoxes: nextDeleteHitBoxes,
        });

        nextDraggableTargets.push({
          key: tKey,
          kind: 'bot_level',
          botLevelId: bl.id,
          label: bl.label,
          price: activePrice,
          y: lvlY,
          badgeX: botBadgeInfo.boxX,
          badgeW: botBadgeInfo.boxW,
        });
      });

      // 8C. Active Open & Averaged Trades on this pair
      const pairOpenTrades = trades.filter((t) => t.is_open && t.pair === pair);
      for (let tradeIdx = 0; tradeIdx < pairOpenTrades.length; tradeIdx++) {
        const t = pairOpenTrades[tradeIdx];
        const isShort = t.is_short;
        const dcaCount = t.dca_count || 0;
        const sideEng = isShort ? 'SHORT' : 'LONG';

        // 1) If averaged (dcaCount > 0), draw thin dashed lines for initial entry (ENTRY 1) and filled DCA steps (DCA 1 ✓)
        if (dcaCount > 0 && Array.isArray(t.orders) && t.orders.length > 0) {
          t.orders.forEach((ord, ordIdx) => {
            const ordY = priceToY(ord.price);
            const isInitial = ord.step === 0;
            drawHorizontalLevel(ctx, {
              y: ordY,
              plotLeft,
              plotRight,
              plotTop,
              plotBottom,
              rightPriceAxisWidth,
              priceText: formatAxisPrice(ord.price),
              badgeText: isInitial ? `ENTRY 1` : `DCA ${ord.step} ✓`,
              lineColor: 'rgba(148, 163, 184, 0.55)',
              badgeBg: 'rgba(15, 23, 42, 0.9)',
              badgeBorder: 'rgba(148, 163, 184, 0.45)',
              badgeTextColor: '#cbd5e1',
              axisTagBg: '#475569',
              lineWidth: 1,
              dash: [3, 4],
              badgeX: plotLeft + 14 + ordIdx * 82,
            });
          });

          // Vertical shift arrow from initial entry to new weighted-average entry
          if (t.initial_open_rate && Math.abs(t.initial_open_rate - t.open_rate) > 1e-8) {
            const initY = priceToY(t.initial_open_rate);
            const avgY = priceToY(t.open_rate);
            if (initY >= plotTop && initY <= plotBottom && avgY >= plotTop && avgY <= plotBottom) {
              const arrowX = plotLeft + 88;
              const entryColor = isShort ? '#ef4444' : '#10b981';
              ctx.save();
              ctx.strokeStyle = entryColor;
              ctx.lineWidth = 1.5;
              ctx.setLineDash([2, 2]);
              ctx.beginPath();
              ctx.moveTo(arrowX, initY);
              ctx.lineTo(arrowX, avgY);
              ctx.stroke();
              ctx.setLineDash([]);

              const dir = avgY > initY ? 1 : -1;
              ctx.fillStyle = entryColor;
              ctx.beginPath();
              ctx.moveTo(arrowX, avgY);
              ctx.lineTo(arrowX - 4, avgY - dir * 6);
              ctx.lineTo(arrowX + 4, avgY - dir * 6);
              ctx.closePath();
              ctx.fill();
              ctx.restore();
            }
          }
        }

        // 2) Bot's Planned DCA Averaging Limit Levels (↕ DCA 1, ↕ DCA 2 — draggable!)
        if (Array.isArray(t.planned_dca_levels)) {
          t.planned_dca_levels.forEach((lvl, dcaIdx) => {
            const tKey = `dca-${t.trade_id}-${lvl.step}`;
            const activePrice =
              draggingLevel && draggingLevel.target.key === tKey
                ? draggingLevel.currentPrice
                : lvl.price;
            const lvlY = priceToY(activePrice);
            const isActive =
              hoveredLevelKey === tKey || (draggingLevel && draggingLevel.target.key === tKey);
            const distPct = (((activePrice - t.open_rate) / t.open_rate) * 100).toFixed(2);

            const dcaBadgeX = Math.max(
              plotLeft + 210,
              plotRight - 220 - dcaIdx * 105 - tradeIdx * 95
            );
            const dcaBadgeInfo = drawHorizontalLevel(ctx, {
              y: lvlY,
              plotLeft,
              plotRight,
              plotTop,
              plotBottom,
              rightPriceAxisWidth,
              priceText: formatAxisPrice(activePrice),
              badgeText: isActive ? `↕ DCA ${lvl.step} (${distPct}%)` : `↕ DCA ${lvl.step}`,
              lineColor: '#f59e0b',
              badgeBg: 'rgba(41, 27, 8, 0.94)',
              badgeBorder: '#f59e0b',
              badgeTextColor: '#fde68a',
              axisTagBg: '#d97706',
              lineWidth: 1.4,
              dash: [6, 4],
              badgeX: dcaBadgeX,
              isHoveredOrDragged: Boolean(isActive),
            });

            nextDraggableTargets.push({
              key: tKey,
              kind: 'dca',
              tradeId: t.trade_id,
              step: lvl.step,
              label: `DCA ${lvl.step}`,
              price: activePrice,
              y: lvlY,
              badgeX: dcaBadgeInfo.boxX,
              badgeW: dcaBadgeInfo.boxW,
            });
          });
        }

        // 3) Take-Profit Level (↕ TP — GREEN #10b981, draggable!)
        if (t.take_profit_abs && t.take_profit_abs > 0) {
          const tKey = `tp-${t.trade_id}`;
          const activeTpPrice =
            draggingLevel && draggingLevel.target.key === tKey
              ? draggingLevel.currentPrice
              : t.take_profit_abs;
          const tpY = priceToY(activeTpPrice);
          const isActive =
            hoveredLevelKey === tKey || (draggingLevel && draggingLevel.target.key === tKey);
          const rawRatio = isShort
            ? (t.open_rate - activeTpPrice) / t.open_rate
            : (activeTpPrice - t.open_rate) / t.open_rate;
          const tpPct = (rawRatio * 100 * (t.leverage || 1)).toFixed(2);
          const tpUsd = (t.stake_amount * rawRatio * (t.leverage || 1)).toFixed(2);
          const tpBadgeX =
            pairOpenTrades.length > 1 && tradeIdx > 0
              ? Math.max(plotLeft + 210, plotRight - 135 - tradeIdx * 135)
              : undefined;

          const tpBadgeInfo = drawHorizontalLevel(ctx, {
            y: tpY,
            plotLeft,
            plotRight,
            plotTop,
            plotBottom,
            rightPriceAxisWidth,
            priceText: formatAxisPrice(activeTpPrice),
            badgeText: isActive
              ? `↕ TP (${Number(tpUsd) >= 0 ? '+' : ''}${tpUsd}$ | ${tpPct}%)`
              : pairOpenTrades.length > 1
              ? `↕ TP ${sideEng[0]} (${Number(tpPct) >= 0 ? '+' : ''}${tpPct}%)`
              : `↕ TP (${Number(tpPct) >= 0 ? '+' : ''}${tpPct}%)`,
            lineColor: '#10b981',
            badgeBg: 'rgba(6, 46, 34, 0.95)',
            badgeBorder: '#10b981',
            badgeTextColor: '#6ee7b7',
            axisTagBg: '#10b981',
            lineWidth: 1.6,
            dash: [5, 3],
            badgeX: tpBadgeX,
            isHoveredOrDragged: Boolean(isActive),
          });

          nextDraggableTargets.push({
            key: tKey,
            kind: 'tp',
            tradeId: t.trade_id,
            label: 'TP',
            price: activeTpPrice,
            y: tpY,
            badgeX: tpBadgeInfo.boxX,
            badgeW: tpBadgeInfo.boxW,
          });
        }

        // Stop loss is removed: we trade two-way hedging & DCA without stop loss.

        // 5) MAIN ENTRY / SHIFTED WEIGHTED-AVERAGE ENTRY LINE
        const mainEntryY = priceToY(t.open_rate);
        const pnlSign = t.profit_abs >= 0 ? '+' : '';
        const mainBadgeLabel =
          dcaCount > 0
            ? `AVG ${sideEng} ×${dcaCount} (${pnlSign}${t.profit_abs.toFixed(2)}$)`
            : `${sideEng} ${t.leverage || 1}x (${pnlSign}${t.profit_abs.toFixed(2)}$)`;

        drawHorizontalLevel(ctx, {
          y: mainEntryY,
          plotLeft,
          plotRight,
          plotTop,
          plotBottom,
          rightPriceAxisWidth,
          priceText: formatAxisPrice(t.open_rate),
          badgeText: mainBadgeLabel,
          lineColor: isShort ? '#ef4444' : '#10b981',
          badgeBg: isShort ? 'rgba(69, 10, 10, 0.96)' : 'rgba(6, 46, 34, 0.96)',
          badgeBorder: isShort ? '#ef4444' : '#10b981',
          badgeTextColor: '#ffffff',
          axisTagBg: isShort ? '#dc2626' : '#059669',
          lineWidth: 2.2,
          dash: [],
        });
      }
    }

    // 9. RENDER TRADINGVIEW DRAWINGS & PINNED MEASURE RULERS (with [×] delete button & draggable nodes)
    const renderDrawingItem = (
      drw: ChartDrawingObject,
      isDraft = false
    ) => {
      const pts =
        draggingDrawingPoint && draggingDrawingPoint.drawingId === drw.id
          ? draggingDrawingPoint.points
          : drw.points;
      if (!pts || pts.length === 0) return;

      const isSelected = selectedDrawingId === drw.id;
      const p1 = pts[0];
      const p2 = pts[1] || pts[0];
      const x1 = timestampToX(p1.timestamp);
      const y1 = priceToY(p1.price);
      const x2 = timestampToX(p2.timestamp);
      const y2 = priceToY(p2.price);

      ctx.save();

      // Helper to draw a delete [×] badge on any drawing at (bx, by)
      const drawDeleteBadgeOnObject = (bx: number, by: number, labelText: string, bg: string, border: string) => {
        if (isDraft) return;
        ctx.save();
        ctx.font = 'bold 10.5px monospace';
        const tw = ctx.measureText(labelText).width;
        const padX = 6;
        const closeW = 16;
        const boxW = tw + padX * 2 + closeW;
        const boxH = 19;
        const clampedX = Math.max(plotLeft + 6, Math.min(plotRight - boxW - 6, bx - boxW / 2));
        const clampedY = Math.max(plotTop + 4, Math.min(plotBottom - boxH - 4, by));

        ctx.fillStyle = bg;
        ctx.strokeStyle = border;
        ctx.lineWidth = isSelected ? 1.6 : 1;
        ctx.beginPath();
        ctx.roundRect(clampedX, clampedY, boxW, boxH, 3);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(labelText, clampedX + padX, clampedY + boxH / 2 + 0.5);

        // Divider + [×] button
        const btnX = clampedX + boxW - closeW;
        ctx.strokeStyle = border;
        ctx.beginPath();
        ctx.moveTo(btnX, clampedY + 2);
        ctx.lineTo(btnX, clampedY + boxH - 2);
        ctx.stroke();

        ctx.fillStyle = '#fca5a5';
        ctx.textAlign = 'center';
        ctx.fillText('×', btnX + closeW / 2, clampedY + boxH / 2 + 0.5);

        nextDeleteHitBoxes.push({
          id: drw.id,
          kind: 'drawing',
          x: btnX - 2,
          y: clampedY - 2,
          w: closeW + 4,
          h: boxH + 4,
          label: labelText,
        });
        ctx.restore();
      };

      if (drw.tool === 'ruler') {
        // Pinned TradingView Price & Bars Measure Ruler
        const diffPrice = p2.price - p1.price;
        const diffPct = p1.price > 0 ? (diffPrice / p1.price) * 100 : 0;
        const slot1 = Math.round(timestampToSlot(p1.timestamp));
        const slot2 = Math.round(timestampToSlot(p2.timestamp));
        const barsCount = Math.abs(slot2 - slot1);
        const isUp = diffPrice >= 0;

        const leftX = Math.min(x1, x2);
        const topY = Math.min(y1, y2);
        const w = Math.max(4, Math.abs(x2 - x1));
        const h = Math.max(4, Math.abs(y2 - y1));

        ctx.fillStyle = isUp ? 'rgba(16, 185, 129, 0.16)' : 'rgba(239, 68, 68, 0.16)';
        ctx.strokeStyle = isUp ? '#10b981' : '#ef4444';
        ctx.lineWidth = 1.3;
        ctx.fillRect(leftX, topY, w, h);
        ctx.strokeRect(leftX, topY, w, h);

        // Cross arrows inside ruler box
        const midX = leftX + w / 2;
        const midY = topY + h / 2;
        ctx.strokeStyle = isUp ? 'rgba(16, 185, 129, 0.65)' : 'rgba(239, 68, 68, 0.65)';
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(midX, topY);
        ctx.lineTo(midX, topY + h);
        ctx.moveTo(leftX, midY);
        ctx.lineTo(leftX + w, midY);
        ctx.stroke();
        ctx.setLineDash([]);

        const labelText = `${diffPrice >= 0 ? '+' : ''}${formatAxisPrice(diffPrice)} (${
          diffPct >= 0 ? '+' : ''
        }${diffPct.toFixed(2)}%) · ${barsCount} бар.`;

        if (isDraft) {
          ctx.font = 'bold 11px monospace';
          const tw = ctx.measureText(labelText).width + 14;
          const bx = midX - tw / 2;
          const by = Math.max(plotTop + 4, topY - 24);
          ctx.fillStyle = isUp ? '#064e3b' : '#7f1d1d';
          ctx.fillRect(bx, by, tw, 20);
          ctx.fillStyle = '#ffffff';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(labelText, bx + tw / 2, by + 10);
        } else {
          drawDeleteBadgeOnObject(
            midX,
            topY - 24,
            labelText,
            isUp ? 'rgba(6, 78, 59, 0.96)' : 'rgba(127, 29, 29, 0.96)',
            isUp ? '#10b981' : '#ef4444'
          );
        }
      } else if (drw.tool === 'hline') {
        ctx.strokeStyle = drw.color || '#38bdf8';
        ctx.lineWidth = isSelected ? 2.2 : 1.6;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(plotLeft, y1);
        ctx.lineTo(plotRight, y1);
        ctx.stroke();
        ctx.setLineDash([]);
        drawDeleteBadgeOnObject(
          plotLeft + 110,
          y1 - 20,
          drw.text || `HLINE @ ${formatAxisPrice(p1.price)}`,
          'rgba(12, 45, 72, 0.94)',
          drw.color || '#38bdf8'
        );
      } else if (drw.tool === 'trendline' || drw.tool === 'ray') {
        ctx.strokeStyle = drw.color || '#2962ff';
        ctx.lineWidth = isSelected ? 2.4 : 1.8;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        if (drw.tool === 'ray' && Math.abs(x2 - x1) > 1e-3) {
          const slope = (y2 - y1) / (x2 - x1);
          const targetX = x2 >= x1 ? plotRight : plotLeft;
          const targetY = y1 + slope * (targetX - x1);
          ctx.lineTo(targetX, targetY);
        } else {
          ctx.lineTo(x2, y2);
        }
        ctx.stroke();

        const diffPct = p1.price > 0 ? (((p2.price - p1.price) / p1.price) * 100).toFixed(2) : '0.00';
        drawDeleteBadgeOnObject(
          (x1 + x2) / 2,
          (y1 + y2) / 2 - 22,
          `${drw.tool === 'ray' ? 'RAY' : 'TREND'} (${Number(diffPct) >= 0 ? '+' : ''}${diffPct}%)`,
          'rgba(30, 34, 45, 0.94)',
          drw.color || '#2962ff'
        );
      } else if (drw.tool === 'channel') {
        const offsetPx = 38;
        ctx.strokeStyle = drw.color || '#38bdf8';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.moveTo(x1, y1 - offsetPx);
        ctx.lineTo(x2, y2 - offsetPx);
        ctx.stroke();

        ctx.fillStyle = 'rgba(56, 189, 248, 0.1)';
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.lineTo(x2, y2 - offsetPx);
        ctx.lineTo(x1, y1 - offsetPx);
        ctx.closePath();
        ctx.fill();

        drawDeleteBadgeOnObject(
          (x1 + x2) / 2,
          Math.min(y1, y2) - offsetPx - 20,
          'CHANNEL',
          'rgba(12, 45, 72, 0.94)',
          '#38bdf8'
        );
      } else if (drw.tool === 'rect') {
        const leftX = Math.min(x1, x2);
        const topY = Math.min(y1, y2);
        const w = Math.max(6, Math.abs(x2 - x1));
        const h = Math.max(6, Math.abs(y2 - y1));
        ctx.fillStyle = 'rgba(59, 130, 246, 0.16)';
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 1.4;
        ctx.fillRect(leftX, topY, w, h);
        ctx.strokeRect(leftX, topY, w, h);

        drawDeleteBadgeOnObject(
          leftX + w / 2,
          topY - 22,
          `ZONE ${formatAxisPrice(Math.min(p1.price, p2.price))}–${formatAxisPrice(Math.max(p1.price, p2.price))}`,
          'rgba(23, 37, 84, 0.94)',
          '#3b82f6'
        );
      } else if (drw.tool === 'fib') {
        const fibLevels = [
          { r: 0, color: '#94a3b8' },
          { r: 0.236, color: '#ef4444' },
          { r: 0.382, color: '#f59e0b' },
          { r: 0.5, color: '#10b981' },
          { r: 0.618, color: '#06b6d4' },
          { r: 0.786, color: '#3b82f6' },
          { r: 1, color: '#94a3b8' },
        ];
        const leftX = Math.min(x1, x2);
        const rightX = Math.max(x1 + 50, x2);
        const spanP = p2.price - p1.price;

        for (let k = 0; k < fibLevels.length; k++) {
          const fl = fibLevels[k];
          const lvlPrice = p2.price - spanP * fl.r;
          const ly = priceToY(lvlPrice);

          if (k < fibLevels.length - 1) {
            const nextPrice = p2.price - spanP * fibLevels[k + 1].r;
            const nextY = priceToY(nextPrice);
            ctx.fillStyle = `${fl.color}18`;
            ctx.fillRect(leftX, Math.min(ly, nextY), rightX - leftX, Math.abs(nextY - ly));
          }

          ctx.strokeStyle = fl.color;
          ctx.lineWidth = 1.1;
          ctx.beginPath();
          ctx.moveTo(leftX, ly);
          ctx.lineTo(rightX, ly);
          ctx.stroke();

          ctx.fillStyle = fl.color;
          ctx.font = '10px monospace';
          ctx.textAlign = 'left';
          ctx.fillText(`${fl.r} (${formatAxisPrice(lvlPrice)})`, leftX + 4, ly - 3);
        }

        drawDeleteBadgeOnObject(
          (leftX + rightX) / 2,
          Math.min(y1, y2) - 22,
          'FIB RETRACEMENT',
          'rgba(30, 34, 45, 0.95)',
          '#38bdf8'
        );
      } else if (drw.tool === 'long_rr' || drw.tool === 'short_rr') {
        // TradingView Long / Short Position Risk-Reward Tool
        const isLong = drw.tool === 'long_rr';
        const entryP = p1.price;
        const tpDist = Math.abs(p2.price - p1.price) > 1e-6 ? Math.abs(p2.price - p1.price) : entryP * 0.02;
        const slDist = pts[2] ? Math.abs(pts[2].price - entryP) : tpDist * 0.5;

        const tpPrice = isLong ? entryP + tpDist : entryP - tpDist;
        const slPrice = isLong ? entryP - slDist : entryP + slDist;
        const rrRatio = slDist > 0 ? (tpDist / slDist).toFixed(2) : '2.00';

        const leftX = Math.min(x1, x2);
        const boxW = Math.max(95, Math.abs(x2 - x1));
        const entryY = priceToY(entryP);
        const tpY = priceToY(tpPrice);
        const slY = priceToY(slPrice);

        // Profit zone (Green #10b981)
        ctx.fillStyle = 'rgba(16, 185, 129, 0.22)';
        ctx.strokeStyle = '#10b981';
        ctx.lineWidth = 1.2;
        ctx.fillRect(leftX, Math.min(entryY, tpY), boxW, Math.abs(tpY - entryY));
        ctx.strokeRect(leftX, Math.min(entryY, tpY), boxW, Math.abs(tpY - entryY));

        // Risk zone (Red #ef4444)
        ctx.fillStyle = 'rgba(239, 68, 68, 0.22)';
        ctx.strokeStyle = '#ef4444';
        ctx.fillRect(leftX, Math.min(entryY, slY), boxW, Math.abs(slY - entryY));
        ctx.strokeRect(leftX, Math.min(entryY, slY), boxW, Math.abs(slY - entryY));

        // Entry middle line
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(leftX, entryY);
        ctx.lineTo(leftX + boxW, entryY);
        ctx.stroke();

        const tpPct = ((tpDist / entryP) * 100).toFixed(2);
        const slPct = ((slDist / entryP) * 100).toFixed(2);

        drawDeleteBadgeOnObject(
          leftX + boxW / 2,
          Math.min(tpY, slY) - 22,
          `${isLong ? 'LONG' : 'SHORT'} RR 1:${rrRatio} (TP +${tpPct}% / SL -${slPct}%)`,
          isLong ? 'rgba(6, 78, 59, 0.96)' : 'rgba(127, 29, 29, 0.96)',
          isLong ? '#10b981' : '#ef4444'
        );

        // Interactive button right on the RR box to send this exact trade + TP to the bot (no SL, 2-way / DCA)!
        if (!isDraft && onQuickOrderFromChart) {
          const btnText = `▶ В сделку ${isLong ? 'LONG' : 'SHORT'} (TP боту)`;
          ctx.font = 'bold 10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
          const btw = ctx.measureText(btnText).width + 14;
          const bth = 19;
          const btx = Math.max(plotLeft + 6, Math.min(plotRight - btw - 6, leftX + boxW / 2 - btw / 2));
          const bty = Math.min(plotBottom - bth - 4, Math.max(tpY, slY) + 4);

          ctx.fillStyle = isLong ? '#059669' : '#dc2626';
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(btx, bty, btw, bth, 3);
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = '#ffffff';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(btnText, btx + btw / 2, bty + bth / 2 + 0.5);

          nextActionHitBoxes.push({
            id: `act-${drw.id}`,
            kind: 'open_rr_trade',
            drawing: {
              ...drw,
              points: [
                { timestamp: p1.timestamp, price: roundDraggedPrice(entryP) },
                { timestamp: p2.timestamp, price: roundDraggedPrice(tpPrice) },
                { timestamp: p2.timestamp, price: roundDraggedPrice(slPrice) },
              ],
            },
            x: btx,
            y: bty,
            w: btw,
            h: bth,
          });
        }
      } else if (drw.tool === 'text') {
        drawDeleteBadgeOnObject(
          x1,
          y1 - 10,
          drw.text || ' ЗАМЕТКА / УРОВЕНЬ ',
          'rgba(30, 41, 59, 0.95)',
          '#38bdf8'
        );
      }

      // Draw draggable circular control handles on endpoints when not locked
      if (!isDraft && !lockAllDrawings && !drw.locked) {
        pts.forEach((pt, pIdx) => {
          const px = timestampToX(pt.timestamp);
          const py = priceToY(pt.price);
          ctx.fillStyle = '#131722';
          ctx.strokeStyle = '#38bdf8';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(px, py, 4.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();

          nextDrawingPointTargets.push({
            drawingId: drw.id,
            pointIndex: pIdx,
            x: px,
            y: py,
          });
        });
      }

      ctx.restore();
    };

    if (!hideAllDrawings) {
      for (const drw of drawings) {
        if (drw.pair === pair) {
          renderDrawingItem(drw, false);
        }
      }
      // Also render live draft drawing while user moves cursor after 1st click
      if (draftPoints.length === 1 && mousePos && activeTool !== 'cursor') {
        const cursorPt = resolvePointAtCursor(mousePos.x, mousePos.y);
        renderDrawingItem(
          {
            id: 'draft-preview',
            pair,
            tool: activeTool as Exclude<DrawingToolType, 'cursor'>,
            points: [draftPoints[0], cursorPt],
            color: '#2962ff',
            created_at: '',
          },
          true
        );
      }
    }

    draggableTargetsRef.current = nextDraggableTargets;
    deleteHitBoxesRef.current = nextDeleteHitBoxes;
    actionHitBoxesRef.current = nextActionHitBoxes;
    drawingPointTargetsRef.current = nextDrawingPointTargets;

    // 10. LOWER OSCILLATOR SUB-PANE: RSI (14) OR MACD (12, 26, 9)
    if (hasSubOscillator && subPaneHeight > 40) {
      ctx.save();
      ctx.fillStyle = '#11151f';
      ctx.fillRect(plotLeft, subTop + 1, plotRight - plotLeft, subPaneHeight - 1);

      if (plotConfig.showRsi) {
        const rsiTop = subTop + 14;
        const rsiBot = subBottom - 6;
        const rsiH = Math.max(20, rsiBot - rsiTop);
        const rsiToY = (v: number) => rsiBot - (Math.max(0, Math.min(100, v)) / 100) * rsiH;

        const y70 = rsiToY(70);
        const y30 = rsiToY(30);
        ctx.fillStyle = 'rgba(168, 85, 247, 0.08)';
        ctx.fillRect(plotLeft, y70, plotRight - plotLeft, y30 - y70);

        ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(plotLeft, y70);
        ctx.lineTo(plotRight, y70);
        ctx.moveTo(plotLeft, y30);
        ctx.lineTo(plotRight, y30);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = '#9ca3af';
        ctx.font = '10px monospace';
        ctx.textAlign = 'left';
        ctx.fillText('70', plotRight + 6, y70 + 3);
        ctx.fillText('30', plotRight + 6, y30 + 3);

        ctx.strokeStyle = '#a855f7';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        let started = false;
        let lastRsiVal: number | null = null;
        for (let i = 0; i < items.length; i++) {
          const gIdx = visibleSlice.startIdx + i;
          const v = indicators.rsi14[gIdx];
          if (v === null || v === undefined) continue;
          lastRsiVal = v;
          const x = idxToX(i);
          const y = rsiToY(v);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.stroke();

        ctx.fillStyle = '#c084fc';
        ctx.font = 'bold 10.5px monospace';
        ctx.fillText(
          `RSI (14): ${lastRsiVal !== null ? lastRsiVal.toFixed(2) : '—'}`,
          plotLeft + 8,
          subTop + 12
        );
      } else if (plotConfig.showMacd) {
        const macdTop = subTop + 16;
        const macdBot = subBottom - 6;
        const macdMid = (macdTop + macdBot) / 2;
        const halfH = Math.max(15, (macdBot - macdTop) / 2);

        let maxAbs = 1e-6;
        for (let i = 0; i < items.length; i++) {
          const gIdx = visibleSlice.startIdx + i;
          const m = Math.abs(indicators.macdLine[gIdx] || 0);
          const s = Math.abs(indicators.macdSignal[gIdx] || 0);
          const h = Math.abs(indicators.macdHist[gIdx] || 0);
          maxAbs = Math.max(maxAbs, m, s, h);
        }

        const valToY = (v: number) => macdMid - (v / maxAbs) * halfH;

        for (let i = 0; i < items.length; i++) {
          const gIdx = visibleSlice.startIdx + i;
          const h = indicators.macdHist[gIdx];
          if (h === null) continue;
          const x = idxToX(i);
          const y = valToY(h);
          ctx.fillStyle = h >= 0 ? 'rgba(16, 185, 129, 0.55)' : 'rgba(239, 68, 68, 0.55)';
          ctx.fillRect(x - candleWidth / 2, Math.min(macdMid, y), candleWidth, Math.abs(y - macdMid));
        }

        const drawMacdCurve = (arr: (number | null)[], col: string) => {
          ctx.strokeStyle = col;
          ctx.lineWidth = 1.3;
          ctx.beginPath();
          let st = false;
          for (let i = 0; i < items.length; i++) {
            const v = arr[visibleSlice.startIdx + i];
            if (v === null) continue;
            const x = idxToX(i);
            const y = valToY(v);
            if (!st) {
              ctx.moveTo(x, y);
              st = true;
            } else {
              ctx.lineTo(x, y);
            }
          }
          ctx.stroke();
        };

        drawMacdCurve(indicators.macdLine, '#2962ff');
        drawMacdCurve(indicators.macdSignal, '#f59e0b');

        ctx.fillStyle = '#60a5fa';
        ctx.font = 'bold 10.5px monospace';
        ctx.fillText('MACD (12, 26, 9)', plotLeft + 8, subTop + 12);
      }

      ctx.restore();
    }

    // 11. TRADINGVIEW TOP-LEFT SYMBOL + OHLCV STATUS BAR OVERLAY & CROSSHAIR
    const activeCandle =
      hoverIndex !== null && items[hoverIndex]
        ? items[hoverIndex]
        : items[items.length - 1];

    if (activeCandle) {
      const chg = activeCandle.close - activeCandle.open;
      const chgPct = activeCandle.open > 0 ? (chg / activeCandle.open) * 100 : 0;
      const isBull = chg >= 0;
      const valColor = isBull ? '#089981' : '#f23645';

      ctx.save();
      ctx.font = 'bold 11.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';

      const symHeader = `${pair.split(':')[0].replace('/', '')} · ${timeframe.toUpperCase()} · ${exchangeSource || 'Binance'} · `;
      const symW = ctx.measureText(symHeader).width;

      ctx.font = '11px monospace';
      const ohlcText = `ОТКР ${formatAxisPrice(activeCandle.open)}  МАКС ${formatAxisPrice(
        activeCandle.high
      )}  МИН ${formatAxisPrice(activeCandle.low)}  ЗАКР ${formatAxisPrice(
        activeCandle.close
      )}  ${chg >= 0 ? '+' : ''}${formatAxisPrice(chg)} (${chg >= 0 ? '+' : ''}${chgPct.toFixed(
        2
      )}%)  VOL ${activeCandle.volume.toFixed(1)}`;

      const bgW = symW + ctx.measureText(ohlcText).width + 18;
      ctx.fillStyle = 'rgba(19, 23, 34, 0.86)';
      ctx.fillRect(plotLeft + 4, plotTop + 4, bgW, 21);

      ctx.font = 'bold 11.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.fillStyle = '#e2e8f0';
      ctx.fillText(symHeader, plotLeft + 10, plotTop + 8);

      ctx.font = '11px monospace';
      ctx.fillStyle = valColor;
      ctx.fillText(ohlcText, plotLeft + 10 + symW, plotTop + 8.5);
      ctx.restore();
    }

    if (
      mousePos &&
      mousePos.x >= plotLeft &&
      mousePos.x <= plotRight &&
      mousePos.y >= plotTop &&
      mousePos.y <= subBottom
    ) {
      const slotIdx = Math.max(
        0,
        Math.min(totalSlots - 1, Math.floor((mousePos.x - plotLeft) / stepX))
      );
      const cx = idxToX(slotIdx);

      ctx.save();
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(cx, plotTop);
      ctx.lineTo(cx, subBottom);
      ctx.moveTo(plotLeft, mousePos.y);
      ctx.lineTo(plotRight, mousePos.y);
      ctx.stroke();
      ctx.setLineDash([]);

      if (mousePos.y <= plotBottom) {
        const hoverPrice = yToPrice(mousePos.y);
        ctx.fillStyle = '#363a45';
        ctx.fillRect(plotRight + 1, mousePos.y - 9.5, rightPriceAxisWidth - 2, 19);
        ctx.fillStyle = '#f8fafc';
        ctx.font = '11px monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(formatAxisPrice(hoverPrice), plotRight + 5, mousePos.y + 0.5);
      }

      const hoverTs = slotToTimestamp(slotIdx);
      const hd = new Date(hoverTs);
      const dateTag = `${hd.toISOString().slice(5, 10)} ${hd.toISOString().slice(11, 16)}`;
      ctx.font = '11px monospace';
      const dtw = ctx.measureText(dateTag).width + 12;
      ctx.fillStyle = '#363a45';
      ctx.fillRect(cx - dtw / 2, subBottom + 1, dtw, 20);
      ctx.fillStyle = '#f8fafc';
      ctx.textAlign = 'center';
      ctx.fillText(dateTag, cx, subBottom + 11);
      ctx.restore();
    }
  }, [
    chartGeometry,
    visibleSlice,
    processedCandles,
    indicators,
    plotConfig,
    hoverIndex,
    mousePos,
    hoveredLevelKey,
    draggingLevel,
    draggingDrawingPoint,
    loading,
    trades,
    botLevels,
    drawings,
    pair,
    timeframe,
    exchangeSource,
    activeTool,
    draftPoints,
    selectedDrawingId,
    lockAllDrawings,
    hideAllDrawings,
    hasSubOscillator,
    nowTick,
    resolvePointAtCursor,
    onQuickOrderFromChart,
  ]);

  // Mini sparkline SVG path for bottom DataZoom slider
  const sliderSparklinePoints = useMemo(() => {
    if (processedCandles.length === 0) return '';
    const minP = Math.min(...processedCandles.map((c) => c.close));
    const maxP = Math.max(...processedCandles.map((c) => c.close));
    const range = Math.max(1e-8, maxP - minP);
    const step = Math.max(1, Math.floor(processedCandles.length / 250));
    const pts: string[] = [];
    for (let idx = 0; idx < processedCandles.length; idx += step) {
      const c = processedCandles[idx];
      const x = (idx / Math.max(1, processedCandles.length - 1)) * 1000;
      const y = 22 - ((c.close - minP) / range) * 18;
      pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }
    return pts.join(' ');
  }, [processedCandles]);

  // Hit-test if cursor is over a [×] delete button on any level or drawing/ruler
  const findHitDeleteBox = (x: number, y: number): CanvasDeleteHitBox | null => {
    for (let i = deleteHitBoxesRef.current.length - 1; i >= 0; i--) {
      const b = deleteHitBoxesRef.current[i];
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
        return b;
      }
    }
    return null;
  };

  // Hit-test if cursor is over an action button (e.g. "▶ В сделку LONG/SHORT (TP/SL боту)" on RR box)
  const findHitActionBox = (x: number, y: number): CanvasActionHitBox | null => {
    for (let i = actionHitBoxesRef.current.length - 1; i >= 0; i--) {
      const b = actionHitBoxesRef.current[i];
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
        return b;
      }
    }
    return null;
  };

  // Hit-test if cursor is over a drawing endpoint node
  const findHitDrawingPoint = (x: number, y: number): DraggableDrawingPointTarget | null => {
    if (lockAllDrawings) return null;
    for (let i = drawingPointTargetsRef.current.length - 1; i >= 0; i--) {
      const pt = drawingPointTargetsRef.current[i];
      const dist = Math.hypot(pt.x - x, pt.y - y);
      if (dist <= 8) return pt;
    }
    return null;
  };

  // Find if cursor is over a draggable horizontal level (TP, SL, DCA 1, DCA 2, LVL 1, LVL 2)
  const findHitLevel = (x: number, y: number): DraggableLevelTarget | null => {
    if (x < chartGeometry.plotLeft || x > chartGeometry.plotRight) return null;
    // 1. Direct badge hit-test: if user clicks directly on a pill badge (e.g. SUP on left vs DCA 1 on right), always pick that badge
    for (let i = draggableTargetsRef.current.length - 1; i >= 0; i--) {
      const target = draggableTargetsRef.current[i];
      if (
        target.badgeX !== undefined &&
        target.badgeW !== undefined &&
        x >= target.badgeX - 4 &&
        x <= target.badgeX + target.badgeW + 4 &&
        Math.abs(target.y - y) <= 10
      ) {
        return target;
      }
    }
    // 2. Line proximity hit-test: if two lines overlap in Y, pick the one whose badge is horizontally closer to cursor X
    let best: DraggableLevelTarget | null = null;
    let bestDist = 8;
    let bestXDist = Infinity;
    for (const target of draggableTargetsRef.current) {
      const dist = Math.abs(target.y - y);
      if (dist <= 8) {
        const badgeCenterX =
          target.badgeX !== undefined && target.badgeW !== undefined
            ? target.badgeX + target.badgeW / 2
            : chartGeometry.plotRight - 60;
        const xDist = Math.abs(x - badgeCenterX);
        if (
          best === null ||
          dist < bestDist - 1.5 ||
          (Math.abs(dist - bestDist) <= 1.5 && xDist < bestXDist)
        ) {
          bestDist = dist;
          bestXDist = xDist;
          best = target;
        }
      }
    }
    return best;
  };

  const handleMouseDown = async (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // 1. Check if clicking a [×] delete button on a Bot Level, Pinned Ruler, or Drawing!
    const hitDelete = findHitDeleteBox(x, y);
    if (hitDelete) {
      if (hitDelete.kind === 'bot_level') {
        await onDeleteBotLevel?.(hitDelete.id);
      } else {
        await onDeleteDrawing?.(hitDelete.id);
        if (selectedDrawingId === hitDelete.id) setSelectedDrawingId(null);
      }
      return;
    }

    // 2. Check if clicking "▶ В сделку LONG/SHORT (TP боту)" on a Risk/Reward box!
    const hitAction = findHitActionBox(x, y);
    if (hitAction && hitAction.kind === 'open_rr_trade' && onQuickOrderFromChart) {
      const d = hitAction.drawing;
      const isLong = d.tool === 'long_rr';
      await onQuickOrderFromChart({
        pair,
        side: isLong ? 'long' : 'short',
        price: d.points[0]?.price,
        take_profit_abs: d.points[1]?.price,
      });
      return;
    }

    // 3. If an analytical tool is active in the left TradingView sidebar
    if (activeTool !== 'cursor' && x >= chartGeometry.plotLeft && x <= chartGeometry.plotRight && y <= chartGeometry.plotBottom) {
      const pt = resolvePointAtCursor(x, y);

      // Single-click tools: Horizontal Bot Level (hline) or Text note
      if (activeTool === 'hline') {
        await onAddBotLevel?.(pt.price);
        if (!stayInDrawingMode) setActiveTool('cursor');
        return;
      }
      if (activeTool === 'text') {
        await onAddDrawing?.({
          pair,
          tool: 'text',
          points: [pt],
          color: '#38bdf8',
          text: `УРОВЕНЬ @ ${formatAxisPrice(pt.price)}`,
        });
        if (!stayInDrawingMode) setActiveTool('cursor');
        return;
      }

      // Two-click tools: Trendline, Ray, Channel, Fib, Rect, Long RR, Short RR, and Pinned Ruler!
      if (draftPoints.length === 0) {
        setDraftPoints([pt]);
      } else {
        const p1 = draftPoints[0];
        let p2 = pt;
        // If user clicked twice in exact same spot for Long/Short RR, create sensible default width/target
        if (Math.abs(p2.timestamp - p1.timestamp) < chartGeometry.tfMs) {
          p2 = {
            timestamp: p1.timestamp + chartGeometry.tfMs * 18,
            price: roundDraggedPrice(
              activeTool === 'short_rr' ? p1.price * 0.982 : p1.price * 1.018
            ),
          };
        }
        const pointsList: ChartDrawingPoint[] =
          activeTool === 'long_rr' || activeTool === 'short_rr'
            ? [
                p1,
                p2,
                {
                  timestamp: p2.timestamp,
                  price: roundDraggedPrice(
                    activeTool === 'long_rr'
                      ? p1.price - Math.abs(p2.price - p1.price) * 0.5
                      : p1.price + Math.abs(p2.price - p1.price) * 0.5
                  ),
                },
              ]
            : [p1, p2];

        await onAddDrawing?.({
          pair,
          tool: activeTool,
          points: pointsList,
          color:
            activeTool === 'long_rr'
              ? '#10b981'
              : activeTool === 'short_rr'
              ? '#ef4444'
              : '#2962ff',
        });
        setDraftPoints([]);
        if (!stayInDrawingMode) {
          setActiveTool('cursor');
        }
      }
      return;
    }

    // 4. Check if clicking a draggable endpoint of an existing drawing/ruler
    const hitPoint = findHitDrawingPoint(x, y);
    if (hitPoint) {
      const targetDrw = drawings.find((d) => d.id === hitPoint.drawingId);
      if (targetDrw) {
        const nextDrwPt = {
          drawingId: targetDrw.id,
          pointIndex: hitPoint.pointIndex,
          points: [...targetDrw.points],
        };
        setSelectedDrawingId(targetDrw.id);
        dragModeRef.current = 'drawingPoint';
        draggingDrawingPointRef.current = nextDrwPt;
        setDragMode('drawingPoint');
        setDraggingDrawingPoint(nextDrwPt);
        return;
      }
    }

    // 5. Check if clicking a draggable horizontal level (TP, SL, DCA, or Bot LVL)
    const hitLevel = findHitLevel(x, y);
    if (hitLevel && !lockAllDrawings) {
      const nextLvl = {
        target: hitLevel,
        currentPrice: hitLevel.price,
      };
      dragModeRef.current = 'level';
      draggingLevelRef.current = nextLvl;
      setDragMode('level');
      setDraggingLevel(nextLvl);
      return;
    }

    dragStartRef.current = { x: e.clientX, y: e.clientY };

    if (x > chartGeometry.plotRight) {
      dragModeRef.current = 'priceAxis';
      setDragMode('priceAxis');
    } else {
      dragModeRef.current = 'pan';
      setDragMode('pan');
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setMousePos({ x, y });

    if (dragModeRef.current !== 'none') return;

    const delBox = findHitDeleteBox(x, y);
    setHoveredDeleteId(delBox ? delBox.id : null);

    const hit = findHitLevel(x, y);
    setHoveredLevelKey(hit ? hit.key : null);

    if (x >= chartGeometry.plotLeft && x <= chartGeometry.plotRight && visibleSlice.items.length > 0) {
      const slotIdx = Math.floor((x - chartGeometry.plotLeft) / chartGeometry.stepX);
      if (slotIdx >= 0 && slotIdx < visibleSlice.items.length) {
        setHoverIndex(slotIdx);
      } else {
        setHoverIndex(visibleSlice.items.length - 1);
      }
    } else {
      setHoverIndex(null);
    }
  };

  const chartGeometryRef = useRef(chartGeometry);
  chartGeometryRef.current = chartGeometry;

  const zoomStateRef = useRef({ zoomStartPct, zoomEndPct, priceScaleMult });
  zoomStateRef.current = { zoomStartPct, zoomEndPct, priceScaleMult };

  const dragCallbacksRef = useRef({
    loadOlderHistory,
    resolvePointAtCursor,
    onUpdateTradeLevel,
    onUpdateBotLevel,
    onUpdateDrawing,
  });
  dragCallbacksRef.current = {
    loadOlderHistory,
    resolvePointAtCursor,
    onUpdateTradeLevel,
    onUpdateBotLevel,
    onUpdateDrawing,
  };

  // Mount-once global window drag listener reading/writing synchronous refs so fast mouse drags never lose state
  useEffect(() => {
    const onWindowMouseMove = (e: MouseEvent) => {
      const mode = dragModeRef.current;
      if (mode === 'none') return;
      e.preventDefault();

      const geom = chartGeometryRef.current;
      const cbs = dragCallbacksRef.current;

      if (mode === 'drawingPoint' && draggingDrawingPointRef.current && canvasRef.current) {
        const rect = canvasRef.current.getBoundingClientRect();
        const x = Math.max(geom.plotLeft, Math.min(geom.plotRight, e.clientX - rect.left));
        const y = Math.max(geom.plotTop + 4, Math.min(geom.plotBottom - 4, e.clientY - rect.top));
        const updatedPt = cbs.resolvePointAtCursor(x, y);
        const prev = draggingDrawingPointRef.current;
        const nextPts = prev.points.map((p, idx) => (idx === prev.pointIndex ? updatedPt : p));
        const nextState = { ...prev, points: nextPts };
        draggingDrawingPointRef.current = nextState;
        setDraggingDrawingPoint(nextState);
        return;
      }

      if (mode === 'level' && draggingLevelRef.current && canvasRef.current) {
        const rect = canvasRef.current.getBoundingClientRect();
        const y = Math.max(geom.plotTop + 4, Math.min(geom.plotBottom - 4, e.clientY - rect.top));
        const rawPrice = geom.yToPrice(y);
        const cleanPrice = roundDraggedPrice(rawPrice);
        if (cleanPrice > 0) {
          const prev = draggingLevelRef.current;
          const nextState = { ...prev, currentPrice: cleanPrice };
          draggingLevelRef.current = nextState;
          setDraggingLevel(nextState);
        }
        return;
      }

      if (mode === 'priceAxis') {
        const dy = e.clientY - dragStartRef.current.y;
        const nextScale = Math.max(
          0.15,
          Math.min(6, zoomStateRef.current.priceScaleMult * (1 + dy * 0.005))
        );
        zoomStateRef.current.priceScaleMult = nextScale;
        dragStartRef.current.y = e.clientY;
        setPriceScaleMult(nextScale);
        return;
      }

      if (mode === 'slider') {
        const sliderEl = sliderRef.current;
        if (!sliderEl) return;
        const rect = sliderEl.getBoundingClientRect();
        const pct = ((e.clientX - rect.left) / Math.max(1, rect.width)) * 100;
        const span = Math.max(2, zoomStateRef.current.zoomEndPct - zoomStateRef.current.zoomStartPct);
        const nextStart = Math.max(0, Math.min(MAX_FUTURE_PCT - span, pct - span / 2));
        const nextEnd = nextStart + span;
        zoomStateRef.current.zoomStartPct = nextStart;
        zoomStateRef.current.zoomEndPct = nextEnd;
        setZoomStartPct(nextStart);
        setZoomEndPct(nextEnd);
        if (nextStart <= 18) {
          cbs.loadOlderHistory();
        }
        return;
      }

      if (mode === 'pan') {
        const dx = e.clientX - dragStartRef.current.x;
        const dy = e.clientY - dragStartRef.current.y;
        const span = Math.max(2, zoomStateRef.current.zoomEndPct - zoomStateRef.current.zoomStartPct);
        const pctShift = (dx / geom.plotWidth) * span;
        const nextStart = Math.max(0, Math.min(96, zoomStateRef.current.zoomStartPct - pctShift));
        const nextEnd = Math.min(MAX_FUTURE_PCT, nextStart + span);
        zoomStateRef.current.zoomStartPct = nextStart;
        zoomStateRef.current.zoomEndPct = nextEnd;
        setZoomStartPct(nextStart);
        setZoomEndPct(nextEnd);

        if (e.shiftKey || Math.abs(zoomStateRef.current.priceScaleMult - 1) > 0.02) {
          setPricePanOffset((prev) => prev + dy * 0.0025);
        }

        dragStartRef.current = { x: e.clientX, y: e.clientY };

        if (nextStart <= 18 && dx > 0) {
          cbs.loadOlderHistory();
        }
      }
    };

    const onWindowMouseUp = () => {
      const mode = dragModeRef.current;
      if (mode === 'none') return;

      const cbs = dragCallbacksRef.current;
      const activeDrawingPoint = draggingDrawingPointRef.current;
      const activeLevel = draggingLevelRef.current;

      dragModeRef.current = 'none';
      draggingDrawingPointRef.current = null;
      draggingLevelRef.current = null;

      if (mode === 'drawingPoint' && activeDrawingPoint) {
        cbs.onUpdateDrawing?.(activeDrawingPoint.drawingId, {
          points: activeDrawingPoint.points,
        });
        setDraggingDrawingPoint(null);
      }

      if (mode === 'level' && activeLevel) {
        const { target, currentPrice } = activeLevel;
        if (Math.abs(currentPrice - target.price) > 1e-9) {
          if (
            (target.kind === 'tp' || target.kind === 'sl' || target.kind === 'dca') &&
            target.tradeId !== undefined
          ) {
            cbs.onUpdateTradeLevel?.({
              tradeId: target.tradeId,
              levelType: target.kind,
              step: target.step,
              price: currentPrice,
            });
          } else if (target.kind === 'bot_level' && target.botLevelId) {
            cbs.onUpdateBotLevel?.(target.botLevelId, currentPrice);
          }
        }
        setDraggingLevel(null);
      }
      setDragMode('none');
    };

    window.addEventListener('mousemove', onWindowMouseMove, { passive: false });
    window.addEventListener('mouseup', onWindowMouseUp);
    return () => {
      window.removeEventListener('mousemove', onWindowMouseMove);
      window.removeEventListener('mouseup', onWindowMouseUp);
    };
  }, []);

  // Native non-passive wheel listener to zoom/pan smoothly without scrolling the browser page
  useEffect(() => {
    const containerEl = containerRef.current;
    const sliderEl = sliderRef.current;
    if (!containerEl) return;

    const onNativeWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const rect = containerEl.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const cursorRatio = Math.max(
        0,
        Math.min(1, (x - chartGeometry.plotLeft) / chartGeometry.plotWidth)
      );

      const currentSpan = Math.max(2, zoomEndPct - zoomStartPct);

      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && Math.abs(e.deltaX) > 2) {
        const pctShift = (e.deltaX / chartGeometry.plotWidth) * currentSpan * 0.8;
        const nextStart = Math.max(0, Math.min(96, zoomStartPct + pctShift));
        setZoomStartPct(nextStart);
        setZoomEndPct(Math.min(MAX_FUTURE_PCT, nextStart + currentSpan));
        if (nextStart <= 18 && e.deltaX < 0) {
          loadOlderHistory();
        }
        return;
      }

      const zoomFactor = e.deltaY > 0 ? 1.15 : 0.86;
      const newSpan = Math.max(2, Math.min(120, currentSpan * zoomFactor));

      const anchorPct = zoomStartPct + currentSpan * cursorRatio;
      let newStart = anchorPct - newSpan * cursorRatio;
      let newEnd = newStart + newSpan;

      if (newStart < 0) {
        newStart = 0;
        newEnd = Math.min(MAX_FUTURE_PCT, newSpan);
      }
      if (newEnd > MAX_FUTURE_PCT) {
        newEnd = MAX_FUTURE_PCT;
        newStart = Math.max(0, MAX_FUTURE_PCT - newSpan);
      }

      setZoomStartPct(newStart);
      setZoomEndPct(newEnd);

      if (newStart <= 18 && e.deltaY > 0) {
        loadOlderHistory();
      }
    };

    const onNativeTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        e.preventDefault();
      }
    };

    containerEl.addEventListener('wheel', onNativeWheel, { passive: false });
    containerEl.addEventListener('touchmove', onNativeTouchMove, { passive: false });
    if (sliderEl) {
      sliderEl.addEventListener('wheel', onNativeWheel, { passive: false });
    }

    return () => {
      containerEl.removeEventListener('wheel', onNativeWheel);
      containerEl.removeEventListener('touchmove', onNativeTouchMove);
      if (sliderEl) {
        sliderEl.removeEventListener('wheel', onNativeWheel);
      }
    };
  }, [chartGeometry.plotLeft, chartGeometry.plotWidth, zoomStartPct, zoomEndPct, loadOlderHistory]);

  const handleZoomButton = (direction: 'in' | 'out' | 'all' | 'reset') => {
    if (direction === 'all') {
      setZoomStartPct(0);
      setZoomEndPct(104);
      setPriceScaleMult(1);
      setPricePanOffset(0);
      loadOlderHistory();
      return;
    }
    if (direction === 'reset') {
      setZoomStartPct(DEFAULT_START_PCT);
      setZoomEndPct(DEFAULT_END_PCT);
      setPriceScaleMult(1);
      setPricePanOffset(0);
      return;
    }
    const span = Math.max(2, zoomEndPct - zoomStartPct);
    const nextSpan = direction === 'in' ? Math.max(3, span * 0.75) : Math.min(120, span * 1.35);
    const center = (zoomStartPct + zoomEndPct) / 2;
    const start = Math.max(0, Math.min(96, center - nextSpan / 2));
    setZoomStartPct(start);
    setZoomEndPct(Math.min(MAX_FUTURE_PCT, start + nextSpan));
    if (start <= 18 && direction === 'out') {
      loadOlderHistory();
    }
  };

  // Close popovers when clicking outside
  useEffect(() => {
    const handleClickOutside = (ev: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(ev.target as Node)) {
        setIsPairDropdownOpen(false);
      }
      if (
        indicatorsDropdownRef.current &&
        !indicatorsDropdownRef.current.contains(ev.target as Node)
      ) {
        setShowIndicatorsMenu(false);
      }
      if (trashDropdownRef.current && !trashDropdownRef.current.contains(ev.target as Node)) {
        setShowTrashMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    if (isPairDropdownOpen) {
      setTimeout(() => searchInputRef.current?.focus(), 30);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isPairDropdownOpen, showIndicatorsMenu, showTrashMenu]);

  const metricsMap = useMemo(() => {
    const map = new Map<string, PairMetric>();
    for (const m of pairMetrics) {
      map.set(m.pair, m);
    }
    return map;
  }, [pairMetrics]);

  const openTradesMap = useMemo(() => {
    const map = new Map<string, { pct: number; abs: number; dcaCount: number; isShort: boolean }>();
    for (const t of trades) {
      if (t.is_open) {
        map.set(t.pair, {
          pct: t.profit_pct,
          abs: t.profit_abs,
          dcaCount: t.dca_count || 0,
          isShort: t.is_short,
        });
      }
    }
    return map;
  }, [trades]);

  const filteredDropdownPairs = useMemo(() => {
    const q = pairSearchQuery.trim().toLowerCase();
    return availablePairs.filter((p) => {
      if (pairTabFilter === 'open' && !openTradesMap.has(p)) return false;
      if (!q) return true;
      return p.toLowerCase().includes(q);
    });
  }, [availablePairs, pairSearchQuery, pairTabFilter, openTradesMap]);

  const currentMetric = metricsMap.get(pair);
  const latestCandleClose =
    processedCandles.length > 0
      ? processedCandles[processedCandles.length - 1].close
      : currentMetric?.price || 0;

  const isScrolledAwayFromRealtime =
    Math.abs(zoomEndPct - DEFAULT_END_PCT) > 3 || Math.abs(pricePanOffset) > 0.01;

  const activeIndicatorsCount = [
    plotConfig.showEma20,
    plotConfig.showEma50,
    plotConfig.showSma200,
    plotConfig.showBollinger,
    plotConfig.showVwap,
    plotConfig.showVolumeProfile,
    plotConfig.showRsi,
    plotConfig.showMacd,
  ].filter(Boolean).length;

  const utcPlus3Clock = useMemo(() => {
    const d = new Date(nowTick + 3 * 3600_000);
    return `${d.toISOString().slice(11, 19)} UTC+3`;
  }, [nowTick]);

  return (
    <div
      ref={wrapperRef}
      className={
        isFullscreen
          ? 'fixed inset-0 z-50 w-screen h-screen overflow-hidden flex flex-col bg-[#131722] text-[#d1d5db] select-none'
          : 'flex flex-col w-full h-full max-h-full min-h-0 overflow-hidden bg-[#131722] text-[#d1d5db] select-none'
      }
    >
      {/* TradingView Single Top Toolbar */}
      <div className="shrink-0 flex flex-wrap items-center justify-between gap-1.5 px-2.5 py-1 bg-[#131722] border-b border-[#2a2e39]">
        <div className="flex flex-wrap items-center gap-1.5">
          {/* Collapsible Coin Selector Popover */}
          <div ref={dropdownRef} className="relative">
            <button
              type="button"
              onClick={() => setIsPairDropdownOpen((prev) => !prev)}
              className={`bg-[#1e222d] hover:bg-[#2a2e39] border ${
                isPairDropdownOpen ? 'border-[#089981]' : 'border-[#363a45]'
              } rounded-[4px] px-2.5 py-1 text-[12.5px] text-[#e2e8f0] min-w-[215px] flex items-center justify-between gap-2 transition-colors focus:outline-none`}
            >
              <div className="flex items-center gap-2">
                <span className="font-bold text-white">{pair.split(':')[0]}</span>
                {latestCandleClose > 0 && (
                  <span className="text-[11.5px] font-mono text-[#d1d5db]">
                    {formatAxisPrice(latestCandleClose)}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                {currentMetric && currentMetric.change24h !== 0 && (
                  <span
                    className={`text-[11px] font-mono font-semibold ${
                      currentMetric.change24h >= 0 ? 'text-[#089981]' : 'text-[#f23645]'
                    }`}
                  >
                    {currentMetric.change24h >= 0 ? '+' : ''}
                    {fmtComma(currentMetric.change24h, 2)}%
                  </span>
                )}
                <ChevronDown
                  className={`w-3.5 h-3.5 text-[#9ca3af] transition-transform ${
                    isPairDropdownOpen ? 'rotate-180 text-[#089981]' : ''
                  }`}
                />
              </div>
            </button>

            {isPairDropdownOpen && (
              <div className="absolute left-0 top-full mt-1 w-[360px] sm:w-[410px] bg-[#1e222d] border border-[#363a45] rounded-[4px] shadow-2xl z-50 flex flex-col overflow-hidden">
                <div className="p-2 border-b border-[#2a2e39] bg-[#131722]">
                  <div className="relative flex items-center">
                    <Search className="w-3.5 h-3.5 text-[#8b949e] absolute left-2.5 pointer-events-none" />
                    <input
                      ref={searchInputRef}
                      type="text"
                      value={pairSearchQuery}
                      onChange={(e) => setPairSearchQuery(e.target.value)}
                      placeholder="Поиск монеты (BTC, ETH, SOL, DOT)..."
                      className="w-full pl-8 pr-7 py-1.5 text-[12px] bg-[#1e222d] border border-[#363a45] rounded-[4px] text-[#e2e8f0] placeholder:text-[#6c757d] focus:outline-none focus:border-[#089981]"
                    />
                    {pairSearchQuery && (
                      <button
                        type="button"
                        onClick={() => setPairSearchQuery('')}
                        className="absolute right-2 text-[#8b949e] hover:text-white"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  <div className="flex items-center justify-between mt-2 text-[11px]">
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setPairTabFilter('all')}
                        className={`px-2 py-0.5 rounded-[3px] transition-colors ${
                          pairTabFilter === 'all'
                            ? 'bg-[#089981] text-white font-semibold'
                            : 'bg-[#2a2e39] text-[#9ca3af] hover:text-white'
                        }`}
                      >
                        ALL ({availablePairs.length})
                      </button>
                      <button
                        type="button"
                        onClick={() => setPairTabFilter('open')}
                        className={`px-2 py-0.5 rounded-[3px] transition-colors ${
                          pairTabFilter === 'open'
                            ? 'bg-[#089981] text-white font-semibold'
                            : 'bg-[#2a2e39] text-[#9ca3af] hover:text-white'
                        }`}
                      >
                        ACTIVE ({openTradesMap.size})
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => setIsPairDropdownOpen(false)}
                      className="text-[#9ca3af] hover:text-white px-1.5 py-0.5"
                    >
                      ▲
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-12 px-3 py-1.5 text-[11px] text-[#8b949e] bg-[#161a25] border-b border-[#2a2e39]">
                  <span className="col-span-5">PAIR</span>
                  <span className="col-span-3 text-right">PRICE</span>
                  <span className="col-span-4 text-right">24H % / PnL</span>
                </div>

                <div className="max-h-[320px] overflow-y-auto divide-y divide-[#2a2e39]">
                  {filteredDropdownPairs.length === 0 ? (
                    <div className="py-6 text-center text-[12px] text-[#8b949e]">Монета не найдена</div>
                  ) : (
                    filteredDropdownPairs.map((p) => {
                      const isSelected = p === pair;
                      const m = metricsMap.get(p);
                      const openStat = openTradesMap.get(p);

                      return (
                        <button
                          key={p}
                          type="button"
                          onClick={() => {
                            onSelectPair(p);
                            setIsPairDropdownOpen(false);
                          }}
                          className={`w-full grid grid-cols-12 items-center px-3 py-2 text-left text-[12px] transition-colors ${
                            isSelected
                              ? 'bg-[#089981]/25 text-white font-semibold'
                              : 'bg-[#1e222d] hover:bg-[#2a2e39] text-[#e2e8f0]'
                          }`}
                        >
                          <span className="col-span-5 font-medium truncate">{p.split(':')[0]}</span>
                          <span className="col-span-3 text-right font-mono text-[11px] text-[#cfd6df]">
                            {m && m.price > 0 ? formatAxisPrice(m.price) : '—'}
                          </span>
                          <span className="col-span-4 flex justify-end">
                            {openStat !== undefined ? (
                              <ProfitPill
                                profitPct={openStat.pct}
                                profitAbs={openStat.abs}
                                compact
                              />
                            ) : m ? (
                              <span
                                className={`font-mono text-[11px] ${
                                  m.change24h >= 0 ? 'text-[#089981]' : 'text-[#f23645]'
                                }`}
                              >
                                {m.change24h >= 0 ? '+' : ''}
                                {fmtComma(m.change24h, 2)}%
                              </span>
                            ) : (
                              <span className="text-[11px] text-[#6c757d]">0.00%</span>
                            )}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>

          {/* English Timeframe Switcher (1m 5m 15m 30m 1h 2h 4h 6h 12h 1D 1W) */}
          <div className="inline-flex items-center bg-[#1e222d] border border-[#363a45] rounded-[4px] p-0.5">
            {TIMEFRAMES.map((tf) => {
              const active = timeframe === tf.value;
              return (
                <button
                  key={tf.value}
                  type="button"
                  onClick={() => onSelectTimeframe?.(tf.value)}
                  className={`px-1.5 py-0.5 text-[11px] rounded-[3px] font-mono font-medium transition-colors ${
                    active
                      ? 'bg-[#2962ff] text-white font-bold'
                      : 'text-[#9ca3af] hover:text-white'
                  }`}
                  title={`Таймфрейм ${tf.label}`}
                >
                  {tf.label}
                </button>
              );
            })}
          </div>

          {/* TradingView Indicators Dropdown (fx Индикаторы) */}
          <div ref={indicatorsDropdownRef} className="relative">
            <button
              type="button"
              onClick={() => setShowIndicatorsMenu((v) => !v)}
              className={`px-2 py-1 text-[11px] font-mono rounded-[4px] border inline-flex items-center gap-1 transition-colors ${
                showIndicatorsMenu || activeIndicatorsCount > 0
                  ? 'bg-[#2962ff]/20 border-[#2962ff] text-[#60a5fa]'
                  : 'bg-[#1e222d] hover:bg-[#2a2e39] border-[#363a45] text-[#cfd6df]'
              }`}
              title="Индикаторы технического анализа TradingView"
            >
              <Activity className="w-3.5 h-3.5" />
              <span>fx Индикаторы</span>
              {activeIndicatorsCount > 0 && (
                <span className="px-1 rounded bg-[#2962ff] text-white text-[9.5px] font-bold">
                  {activeIndicatorsCount}
                </span>
              )}
            </button>

            {showIndicatorsMenu && (
              <div className="absolute left-0 top-full mt-1 w-[265px] bg-[#1e222d] border border-[#363a45] rounded-[4px] shadow-2xl z-50 p-2 space-y-1.5 text-[11.5px]">
                <div className="text-[10.5px] font-semibold text-[#9ca3af] px-1 uppercase">
                  На основном графике
                </div>
                {[
                  { key: 'showEma20', label: 'EMA 20 (Экспоненц. средняя)', color: '#38bdf8' },
                  { key: 'showEma50', label: 'EMA 50 (Экспоненц. средняя)', color: '#f59e0b' },
                  { key: 'showSma200', label: 'SMA 200 (Простая средняя)', color: '#a855f7' },
                  { key: 'showBollinger', label: 'Bollinger Bands (20, 2)', color: '#06b6d4' },
                  { key: 'showVwap', label: 'VWAP (Средневзв. по объёму)', color: '#eab308' },
                  {
                    key: 'showVolumeProfile',
                    label: 'Volume Profile (VPVR + POC)',
                    color: '#10b981',
                  },
                ].map((item) => {
                  const active = Boolean((plotConfig as any)[item.key]);
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() =>
                        onChangePlotConfig({
                          ...plotConfig,
                          [item.key]: !active,
                        })
                      }
                      className={`w-full px-2 py-1 rounded-[3px] flex items-center justify-between text-left transition-colors ${
                        active ? 'bg-[#2962ff]/25 text-white' : 'hover:bg-[#2a2e39] text-[#cfd6df]'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <span
                          className="w-2.5 h-2.5 rounded-full inline-block"
                          style={{ backgroundColor: item.color }}
                        />
                        <span>{item.label}</span>
                      </span>
                      <span className="font-mono text-[10px] text-[#60a5fa]">
                        {active ? 'ВКЛ' : ''}
                      </span>
                    </button>
                  );
                })}

                <div className="border-t border-[#2a2e39] pt-1.5 text-[10.5px] font-semibold text-[#9ca3af] px-1 uppercase">
                  Осцилляторы (нижняя панель)
                </div>
                {[
                  {
                    key: 'showRsi',
                    otherKey: 'showMacd',
                    label: 'RSI 14 (Индекс отн. силы)',
                    color: '#a855f7',
                  },
                  {
                    key: 'showMacd',
                    otherKey: 'showRsi',
                    label: 'MACD (12, 26, 9 Гистограмма)',
                    color: '#2962ff',
                  },
                ].map((item) => {
                  const active = Boolean((plotConfig as any)[item.key]);
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() =>
                        onChangePlotConfig({
                          ...plotConfig,
                          [item.key]: !active,
                          [item.otherKey]: false,
                        })
                      }
                      className={`w-full px-2 py-1 rounded-[3px] flex items-center justify-between text-left transition-colors ${
                        active ? 'bg-[#2962ff]/25 text-white' : 'hover:bg-[#2a2e39] text-[#cfd6df]'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <span
                          className="w-2.5 h-2.5 rounded-full inline-block"
                          style={{ backgroundColor: item.color }}
                        />
                        <span>{item.label}</span>
                      </span>
                      <span className="font-mono text-[10px] text-[#60a5fa]">
                        {active ? 'ВКЛ' : ''}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Refresh & TradingView Navigation Controls */}
          <div className="inline-flex items-center gap-1">
            <button
              type="button"
              onClick={onRefresh}
              title="Обновить свечи"
              className="p-1 bg-[#1e222d] hover:bg-[#2a2e39] border border-[#363a45] rounded-[4px] text-[#cfd6df]"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>

            <button
              type="button"
              onClick={loadOlderHistory}
              disabled={loadingOlder || reachedBeginning}
              className="px-1.5 py-0.5 text-[11px] font-mono bg-[#1e222d] hover:bg-[#2a2e39] disabled:opacity-50 border border-[#363a45] rounded-[4px] text-[#cfd6df] inline-flex items-center gap-0.5"
              title="Догрузить +1000 прошлых исторических свечей"
            >
              <ChevronsLeft className="w-3.5 h-3.5 text-[#38bdf8]" />
              <span>{loadingOlder ? '..' : '+1K'}</span>
            </button>

            <button
              type="button"
              onClick={() => handleZoomButton('all')}
              className="px-1.5 py-0.5 text-[11px] font-mono bg-[#1e222d] hover:bg-[#2a2e39] border border-[#363a45] rounded-[4px] text-[#cfd6df]"
              title="Показать всю загруженную историю"
            >
              ALL
            </button>

            <button
              type="button"
              onClick={() => handleZoomButton('in')}
              className="p-1 bg-[#1e222d] hover:bg-[#2a2e39] border border-[#363a45] rounded-[4px] text-[#cfd6df]"
              title="Приблизить"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>

            <button
              type="button"
              onClick={() => handleZoomButton('out')}
              className="p-1 bg-[#1e222d] hover:bg-[#2a2e39] border border-[#363a45] rounded-[4px] text-[#cfd6df]"
              title="Отдалить"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>

            <button
              type="button"
              onClick={() => handleZoomButton('reset')}
              className="px-1.5 py-0.5 text-[11px] font-mono bg-[#1e222d] hover:bg-[#2a2e39] border border-[#363a45] rounded-[4px] text-[#cfd6df] inline-flex items-center gap-0.5"
              title="К текущей свече (с правым отступом TradingView)"
            >
              <span>NOW</span>
              <ChevronsRight className="w-3.5 h-3.5 text-[#089981]" />
            </button>

            {/* Quick Pinned Measure Ruler Button in Top Bar */}
            <button
              type="button"
              onClick={() => {
                setActiveTool((prev) => (prev === 'ruler' ? 'cursor' : 'ruler'));
                setDraftPoints([]);
              }}
              className={`p-1 border rounded-[4px] ${
                activeTool === 'ruler'
                  ? 'bg-[#2962ff] border-[#2962ff] text-white'
                  : 'bg-[#1e222d] hover:bg-[#2a2e39] border-[#363a45] text-[#cfd6df]'
              }`}
              title="Фиксируемая линейка цены и баров (клик 1-я точка -> клик 2-я точка, удаление по ×)"
            >
              <Ruler className="w-3.5 h-3.5" />
            </button>

            {/* Add Bot Level (+LVL) on current coin */}
            {onAddBotLevel && latestCandleClose > 0 && (
              <button
                type="button"
                onClick={() => onAddBotLevel(roundDraggedPrice(latestCandleClose * 0.995))}
                className="px-1.5 py-0.5 text-[11px] font-mono bg-[#0c2d48] hover:bg-[#0284c7] border border-[#38bdf8]/60 rounded-[4px] text-[#e0f2fe] inline-flex items-center gap-0.5"
                title="Добавить новый уровень бота (LVL) на график (удаляется по кнопке × на уровне)"
              >
                <Plus className="w-3 h-3" />
                <span>LVL</span>
              </button>
            )}
          </div>
        </div>

        {/* Right Controls: Standard English Trading Abbreviations + Fullscreen Toggle */}
        <div className="flex items-center gap-2 text-[11px] font-mono whitespace-nowrap">
          <button
            type="button"
            title="Свечи (OHLC)"
            onClick={() =>
              onChangePlotConfig({ ...plotConfig, showCandles: !plotConfig.showCandles })
            }
            className={`inline-flex items-center gap-1 ${
              plotConfig.showCandles ? 'text-[#e2e8f0]' : 'text-[#6c757d] line-through'
            }`}
          >
            <span className="w-2.5 h-2 rounded-[2px] bg-[#089981] inline-block" />
            <span>OHLC</span>
          </button>

          <button
            type="button"
            title="Объём (VOL)"
            onClick={() =>
              onChangePlotConfig({ ...plotConfig, showVolume: !plotConfig.showVolume })
            }
            className={`inline-flex items-center gap-1 ${
              plotConfig.showVolume ? 'text-[#e2e8f0]' : 'text-[#6c757d] line-through'
            }`}
          >
            <span className="w-2.5 h-2 rounded-[2px] bg-[#6c757d] inline-block" />
            <span>VOL</span>
          </button>

          <button
            type="button"
            title="Сигналы входа (BUY)"
            onClick={() =>
              onChangePlotConfig({ ...plotConfig, showEntry: !plotConfig.showEntry })
            }
            className={`inline-flex items-center gap-1 ${
              plotConfig.showEntry ? 'text-[#e2e8f0]' : 'text-[#6c757d] line-through'
            }`}
          >
            <span className="text-[#10b981] text-[10px] leading-none">▲</span>
            <span>BUY</span>
          </button>

          <button
            type="button"
            title="Сигналы выхода (SELL)"
            onClick={() =>
              onChangePlotConfig({ ...plotConfig, showExit: !plotConfig.showExit })
            }
            className={`inline-flex items-center gap-1 ${
              plotConfig.showExit ? 'text-[#e2e8f0]' : 'text-[#6c757d] line-through'
            }`}
          >
            <span className="text-[#ef4444] text-[10px] leading-none">▼</span>
            <span>SELL</span>
          </button>

          <button
            type="button"
            title="Линии сделок, TP, SL, DCA и уровни бота (LVL)"
            onClick={() =>
              onChangePlotConfig({ ...plotConfig, showTrades: !plotConfig.showTrades })
            }
            className={`inline-flex items-center gap-1 ${
              plotConfig.showTrades ? 'text-[#e2e8f0]' : 'text-[#6c757d] line-through'
            }`}
          >
            <span className="w-2 h-2 rounded-full bg-[#10b981] inline-block" />
            <span>LVL</span>
          </button>

          <label
            className="inline-flex items-center gap-1 text-[#cfd6df] cursor-pointer"
            title="Свечи Heikin Ashi (HA)"
          >
            <input
              type="checkbox"
              checked={plotConfig.heikinAshi}
              onChange={(e) =>
                onChangePlotConfig({ ...plotConfig, heikinAshi: e.target.checked })
              }
              className="w-3 h-3 rounded accent-[#2962ff]"
            />
            <span>HA</span>
          </label>

          <button
            type="button"
            onClick={() => {
              setPriceScaleMult(1);
              setPricePanOffset(0);
            }}
            title="Автоматический масштаб цены по вертикали"
            className={`px-1.5 py-0.5 rounded-[3px] border text-[10.5px] ${
              Math.abs(priceScaleMult - 1) < 0.02 && Math.abs(pricePanOffset) < 0.01
                ? 'bg-[#2962ff]/20 border-[#2962ff] text-[#60a5fa]'
                : 'bg-[#1e222d] border-[#363a45] text-[#9ca3af] hover:text-white'
            }`}
          >
            AUTO
          </button>

          <button
            type="button"
            onClick={() => setShowConfigModal((v) => !v)}
            title="Подсказка по управлению графиком"
            className="p-1 bg-[#1e222d] hover:bg-[#2a2e39] border border-[#363a45] rounded-[4px] text-[#cfd6df]"
          >
            <Settings className="w-3.5 h-3.5" />
          </button>

          {/* TradingView Fullscreen Button */}
          <button
            type="button"
            onClick={toggleFullscreen}
            title={isFullscreen ? 'Выйти из полноэкранного режима (Esc)' : 'Развернуть график на весь экран'}
            className={`p-1 border rounded-[4px] transition-colors ${
              isFullscreen
                ? 'bg-[#2962ff] border-[#2962ff] text-white'
                : 'bg-[#1e222d] hover:bg-[#2a2e39] border-[#363a45] text-[#cfd6df]'
            }`}
          >
            {isFullscreen ? (
              <Minimize2 className="w-3.5 h-3.5" />
            ) : (
              <Maximize2 className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* Compact Help Drawer */}
      {showConfigModal && (
        <div className="px-3 py-1.5 bg-[#1e222d] border-b border-[#2a2e39] flex flex-wrap items-center gap-4 text-[11px] text-[#cfd6df]">
          <span>• Уровни (↕ TP, ↕ SL, ↕ DCA, ↕ LVL) перетаскиваются мышкой, а кнопка [×] на плашке удаляет уровень или линейку</span>
          <span>• Слева на графике — панель инструментов анализа TradingView (Тренд, Фибоначчи, Зоны, LONG/SHORT RR, Фиксируемая линейка)</span>
        </div>
      )}

      {/* Middle Workspace: Left TradingView Drawing Sidebar + Main Chart Canvas */}
      <div className="flex-1 flex min-h-0 w-full overflow-hidden">
        {/* ===================================================================
            TRADINGVIEW LEFT VERTICAL DRAWING SIDEBAR (MATCHING SCREENSHOT)
        =================================================================== */}
        <div className="w-[38px] shrink-0 min-h-0 overflow-y-auto bg-[#131722] border-r border-[#2a2e39] flex flex-col items-center py-1 gap-0.5 z-20">
          {[
            { id: 'cursor', icon: Crosshair, title: 'Перекрестие (Курсор)' },
            { id: 'trendline', icon: TrendingUp, title: 'Линия тренда (2 клика)' },
            { id: 'ray', icon: MoveUpRight, title: 'Луч (2 клика)' },
            { id: 'hline', icon: Minus, title: 'Горизонтальный уровень бота (+LVL в 1 клик)' },
            { id: 'channel', icon: Columns, title: 'Параллельный канал (2 клика)' },
            { id: 'fib', icon: AlignJustify, title: 'Уровни коррекции Фибоначчи (2 клика)' },
            { id: 'rect', icon: Square, title: 'Прямоугольная зона / Ордер-блок (2 клика)' },
            {
              id: 'long_rr',
              icon: ArrowUpCircle,
              title: 'Длинная позиция LONG Risk/Reward (с кнопкой передачи TP/SL боту)',
            },
            {
              id: 'short_rr',
              icon: ArrowDownCircle,
              title: 'Короткая позиция SHORT Risk/Reward (с кнопкой передачи TP/SL боту)',
            },
            { id: 'text', icon: Type, title: 'Текстовая метка на графике' },
            {
              id: 'ruler',
              icon: Ruler,
              title: 'Фиксируемая линейка цены и баров (удаляется кнопкой × на замере)',
            },
          ].map((toolItem) => {
            const Icon = toolItem.icon;
            const active = activeTool === toolItem.id;
            return (
              <button
                key={toolItem.id}
                type="button"
                onClick={() => {
                  setActiveTool(toolItem.id as DrawingToolType);
                  setDraftPoints([]);
                }}
                title={toolItem.title}
                className={`w-7 h-7 rounded-[4px] flex items-center justify-center transition-colors ${
                  active
                    ? 'bg-[#2962ff] text-white'
                    : 'text-[#9ca3af] hover:bg-[#1e222d] hover:text-white'
                }`}
              >
                <Icon className="w-4 h-4" />
              </button>
            );
          })}

          <div className="w-5 border-t border-[#2a2e39] my-0.5" />

          {/* Magnet Mode (Притягивание к OHLC свечи) */}
          <button
            type="button"
            onClick={() => setMagnetEnabled((v) => !v)}
            title="Магнит (притягивать точки к High/Low/Open/Close свечей)"
            className={`w-7 h-7 rounded-[4px] flex items-center justify-center transition-colors ${
              magnetEnabled
                ? 'bg-[#2962ff]/25 text-[#60a5fa] border border-[#2962ff]/60'
                : 'text-[#9ca3af] hover:bg-[#1e222d] hover:text-white'
            }`}
          >
            <Magnet className="w-4 h-4" />
          </button>

          {/* Lock All Drawings & Levels */}
          <button
            type="button"
            onClick={() => setLockAllDrawings((v) => !v)}
            title={
              lockAllDrawings
                ? 'Разблокировать перетаскивание уровней и рисунков'
                : 'Зафиксировать все уровни и рисунки от случайного сдвига'
            }
            className={`w-7 h-7 rounded-[4px] flex items-center justify-center transition-colors ${
              lockAllDrawings
                ? 'bg-[#f59e0b]/25 text-[#fbbf24] border border-[#f59e0b]/60'
                : 'text-[#9ca3af] hover:bg-[#1e222d] hover:text-white'
            }`}
          >
            {lockAllDrawings ? <Lock className="w-4 h-4" /> : <Unlock className="w-4 h-4" />}
          </button>

          {/* Hide / Show All Drawings & Levels */}
          <button
            type="button"
            onClick={() => setHideAllDrawings((v) => !v)}
            title={hideAllDrawings ? 'Показать все уровни и рисунки' : 'Скрыть все рисунки и уровни'}
            className={`w-7 h-7 rounded-[4px] flex items-center justify-center transition-colors ${
              hideAllDrawings
                ? 'bg-[#ef4444]/25 text-[#fca5a5] border border-[#ef4444]/60'
                : 'text-[#9ca3af] hover:bg-[#1e222d] hover:text-white'
            }`}
          >
            {hideAllDrawings ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>

          {/* Trash / Clear Menu */}
          <div ref={trashDropdownRef} className="relative mt-auto">
            <button
              type="button"
              onClick={() => setShowTrashMenu((v) => !v)}
              title="Удалить уровни, линейки или рисунки с графика"
              className="w-7 h-7 rounded-[4px] flex items-center justify-center text-[#9ca3af] hover:bg-[#3b1219] hover:text-[#fca5a5] transition-colors"
            >
              <Trash2 className="w-4 h-4" />
            </button>

            {showTrashMenu && (
              <div className="absolute left-full bottom-0 ml-1.5 w-[235px] bg-[#1e222d] border border-[#363a45] rounded-[4px] shadow-2xl z-50 p-1.5 space-y-1 text-[11.5px]">
                <button
                  type="button"
                  onClick={() => {
                    onClearAllDrawings?.();
                    setSelectedDrawingId(null);
                    setShowTrashMenu(false);
                  }}
                  className="w-full px-2.5 py-1.5 text-left rounded-[3px] hover:bg-[#2a2e39] text-[#e2e8f0] flex items-center justify-between"
                >
                  <span>Удалить все рисунки и линейки</span>
                  <span className="font-mono text-[10px] text-[#9ca3af]">
                    ({drawings.filter((d) => d.pair === pair).length})
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onClearAllBotLevels?.();
                    setShowTrashMenu(false);
                  }}
                  className="w-full px-2.5 py-1.5 text-left rounded-[3px] hover:bg-[#2a2e39] text-[#38bdf8] flex items-center justify-between"
                >
                  <span>Удалить все уровни бота (LVL)</span>
                  <span className="font-mono text-[10px]">
                    ({botLevels.filter((l) => l.pair === pair).length})
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onClearAllDrawings?.();
                    onClearAllBotLevels?.();
                    setSelectedDrawingId(null);
                    setShowTrashMenu(false);
                  }}
                  className="w-full px-2.5 py-1.5 text-left rounded-[3px] hover:bg-[#3b1219] text-[#fca5a5] font-semibold"
                >
                  Очистить всё на {pair.split('/')[0]}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Main TradingView Canvas Container */}
        <div
          ref={containerRef}
          className="relative flex-1 min-h-0 h-full w-full overflow-hidden overscroll-contain touch-none"
        >
          {/* Top-Left TradingView Quick SELL / BUY Buttons (matching user screenshot) */}
          {plotConfig.showQuickOrderButtons !== false && onQuickOrderFromChart && latestCandleClose > 0 && (
            <div className="absolute left-3.5 top-8 z-10 flex items-center gap-1.5 pointer-events-auto">
              <button
                type="button"
                onClick={() =>
                  onQuickOrderFromChart({
                    pair,
                    side: 'short',
                    price: latestCandleClose,
                  })
                }
                className="px-2.5 py-1 rounded-[4px] bg-[#131722]/90 hover:bg-[#ef4444] border border-[#ef4444] text-[#ef4444] hover:text-white transition-colors flex flex-col items-center leading-tight shadow-md"
                title="Быстрое открытие SHORT по текущей цене"
              >
                <span className="text-[11px] font-mono font-bold">
                  {formatAxisPrice(latestCandleClose * 0.9999)}
                </span>
                <span className="text-[9px] font-bold tracking-wider uppercase">ПРОДАТЬ</span>
              </button>

              <span className="text-[10px] font-mono text-[#9ca3af] px-0.5">
                {formatAxisPrice(latestCandleClose * 0.0002)}
              </span>

              <button
                type="button"
                onClick={() =>
                  onQuickOrderFromChart({
                    pair,
                    side: 'long',
                    price: latestCandleClose,
                  })
                }
                className="px-2.5 py-1 rounded-[4px] bg-[#131722]/90 hover:bg-[#2962ff] border border-[#2962ff] text-[#60a5fa] hover:text-white transition-colors flex flex-col items-center leading-tight shadow-md"
                title="Быстрое открытие LONG по текущей цене"
              >
                <span className="text-[11px] font-mono font-bold">
                  {formatAxisPrice(latestCandleClose * 1.0001)}
                </span>
                <span className="text-[9px] font-bold tracking-wider uppercase">КУПИТЬ</span>
              </button>
            </div>
          )}

          {/* Active tool hint pill when drawing */}
          {activeTool !== 'cursor' && (
            <div className="absolute top-8 left-1/2 -translate-x-1/2 z-20 px-3 py-1 rounded-full bg-[#2962ff] text-white text-[11px] font-medium shadow-lg flex items-center gap-2">
              <span>
                Инструмент: <strong className="uppercase">{activeTool}</strong> —{' '}
                {draftPoints.length === 0
                  ? 'кликните 1-ю точку на графике'
                  : 'кликните 2-ю точку для фиксации на графике'}
              </span>
              <button
                type="button"
                onClick={() => {
                  setActiveTool('cursor');
                  setDraftPoints([]);
                }}
                className="hover:text-black/80 font-bold"
              >
                ✕
              </button>
            </div>
          )}

          <canvas
            ref={canvasRef}
            onMouseMove={handleMouseMove}
            onMouseDown={handleMouseDown}
            onDoubleClick={() => {
              setPriceScaleMult(1);
              setPricePanOffset(0);
            }}
            onMouseLeave={() => {
              setHoverIndex(null);
              setMousePos(null);
              setHoveredLevelKey(null);
              setHoveredDeleteId(null);
            }}
            className={`absolute inset-0 block w-full h-full ${
              hoveredDeleteId
                ? 'cursor-pointer'
                : activeTool !== 'cursor'
                ? 'cursor-crosshair'
                : dragMode === 'level' || hoveredLevelKey
                ? 'cursor-ns-resize'
                : dragMode === 'drawingPoint'
                ? 'cursor-move'
                : dragMode === 'pan'
                ? 'cursor-grabbing'
                : dragMode === 'priceAxis'
                ? 'cursor-ns-resize'
                : 'cursor-crosshair'
            }`}
          />

          {/* Floating TradingView "Jump to Latest Candle (>>)" Button when scrolled away */}
          {isScrolledAwayFromRealtime && (
            <button
              type="button"
              onClick={() => handleZoomButton('reset')}
              title="Вернуться к текущей цене и последней свече"
              className="absolute right-[96px] bottom-4 px-2.5 py-1 rounded-full bg-[#1e222d]/95 hover:bg-[#2962ff] border border-[#363a45] text-[#e2e8f0] hover:text-white text-[11px] font-mono shadow-lg flex items-center gap-1 transition-colors"
            >
              <span>NOW</span>
              <ChevronsRight className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Bottom DataZoom Navigator Slider + TradingView Quick Date Ranges & UTC+3 Clock */}
      <div className="shrink-0 px-2.5 py-1 bg-[#131722] border-t border-[#2a2e39] space-y-0.5">
        <div
          ref={sliderRef}
          onMouseDown={(e) => {
            e.preventDefault();
            dragModeRef.current = 'slider';
            setDragMode('slider');
          }}
          className="relative h-[22px] w-full bg-[#161a25] border border-[#2a2e39] rounded-[3px] overflow-hidden cursor-ew-resize select-none"
        >
          <svg
            viewBox="0 0 1000 24"
            preserveAspectRatio="none"
            className="w-full h-full opacity-55"
          >
            <polyline
              fill="none"
              stroke="#3b82f6"
              strokeWidth="1.5"
              points={sliderSparklinePoints}
            />
          </svg>

          <div
            className="absolute top-0 bottom-0 bg-[#2962ff]/20 border-x-2 border-[#2962ff]"
            style={{
              left: `${Math.max(0, Math.min(98, (zoomStartPct / MAX_FUTURE_PCT) * 100))}%`,
              width: `${Math.max(
                2,
                Math.min(100, ((zoomEndPct - zoomStartPct) / MAX_FUTURE_PCT) * 100)
              )}%`,
            }}
          />
        </div>

        {/* Bottom TradingView Status Bar: Date Range Presets + Live UTC+3 Clock */}
        <div className="flex flex-wrap items-center justify-between text-[11px] font-mono text-[#9ca3af] pt-0.5">
          <div className="flex items-center gap-1">
            {[
              { label: '1Д', durationMs: 86_400_000 },
              { label: '5Д', durationMs: 5 * 86_400_000 },
              { label: '1М', durationMs: 30 * 86_400_000 },
              { label: '3М', durationMs: 90 * 86_400_000 },
              { label: 'Все', durationMs: 0 },
            ].map((rng) => (
              <button
                key={rng.label}
                type="button"
                onClick={() => {
                  if (rng.durationMs === 0) {
                    loadOlderHistory();
                    setZoomStartPct(0);
                    setZoomEndPct(DEFAULT_END_PCT);
                    return;
                  }
                  const tfMs = TIMEFRAME_MS[timeframe.toLowerCase()] || 3_600_000;
                  const totalBars = Math.max(10, processedCandles.length);
                  const neededBars = Math.max(12, Math.round(rng.durationMs / tfMs));
                  if (neededBars >= totalBars) {
                    loadOlderHistory();
                    setZoomStartPct(0);
                  } else {
                    const startPct = Math.max(
                      0,
                      Math.min(95, ((totalBars - neededBars) / totalBars) * 100)
                    );
                    setZoomStartPct(startPct);
                  }
                  setZoomEndPct(DEFAULT_END_PCT);
                }}
                className="px-1.5 py-0.5 rounded hover:bg-[#1e222d] hover:text-white transition-colors"
              >
                {rng.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-3">
            <span>{utcPlus3Clock}</span>
            <button
              type="button"
              onClick={() => {
                setPriceScaleMult(1);
                setPricePanOffset(0);
              }}
              className={`hover:text-white ${
                Math.abs(priceScaleMult - 1) < 0.02 ? 'text-[#2962ff] font-bold' : ''
              }`}
            >
              Авто
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
