import React, { useEffect, useState } from 'react';
import type { ReversalChartMarker } from './CandleChart';

interface ReversalEvent {
  timestamp: number;
  side: 'support' | 'resistance';
  level: number;
  price: number;
  atr: number;
  outcome: 'reversal' | 'breakout' | 'unclear' | 'pending';
  bars_to_outcome: number | null;
  max_move_atr: number;
  features: {
    daily_trend: 'UP' | 'DOWN' | 'RANGE';
    with_daily_trend: boolean;
    rsi: number;
    rsi_divergence: boolean;
    volume_x: number;
    wick_pct: number;
    swept_and_closed_back: boolean;
    extension_atr: number;
    level_touches: number;
    bot_three_phase: boolean;
  };
}

interface ReversalHistoryResponse {
  pair: string;
  timeframe: string;
  horizon_bars: number;
  total_events: number;
  resolved_events: number;
  reversal_pct: number;
  breakout_pct: number;
  unclear_pct: number;
  random_baseline_pct: number;
  feature_stats: Array<{ key: string; label: string; events: number; reversal_pct: number }>;
  events: ReversalEvent[];
}

const OUTCOME_RU: Record<ReversalEvent['outcome'], string> = {
  reversal: 'Разворот',
  breakout: 'Пробой',
  unclear: 'Неясно',
  pending: 'Ещё идёт',
};
const TREND_RU = { UP: 'вверх', DOWN: 'вниз', RANGE: 'флэт' } as const;

const fmtDate = (ts: number) => {
  const d = new Date(ts);
  return `${d.toISOString().slice(5, 10)} ${d.toISOString().slice(11, 16)}`;
};

/** Строки «что было в момент подхода и чем закончилось» — для подсказки на графике. */
export function describeReversalEvent(e: ReversalEvent, horizon: number): string[] {
  const f = e.features;
  const where = e.side === 'support' ? 'к поддержке' : 'к сопротивлению';
  const outcomeLine =
    e.outcome === 'reversal'
      ? `→ Разворот: прошла 2 ATR за ${e.bars_to_outcome} св.`
      : e.outcome === 'breakout'
      ? `→ Пробой: ушла на 1 ATR за уровень за ${e.bars_to_outcome} св.`
      : e.outcome === 'pending'
      ? '→ Исход ещё не известен'
      : `→ Неясно: за ${horizon} св. ни разворота, ни пробоя (макс. ход ${e.max_move_atr} ATR)`;
  return [
    `${OUTCOME_RU[e.outcome]} · ${fmtDate(e.timestamp)} · подход ${where} ${e.level}`,
    `Дневной тренд: ${TREND_RU[f.daily_trend]}${f.with_daily_trend ? ' (разворот по тренду)' : f.daily_trend === 'RANGE' ? '' : ' (против тренда)'}`,
    `RSI ${f.rsi}${f.rsi_divergence ? ', есть дивергенция' : ''} · объём ×${f.volume_x}`,
    `Тень свечи ${f.wick_pct}%${f.swept_and_closed_back ? ' · снос за уровень и возврат' : ''}`,
    `От EMA20: ${f.extension_atr} ATR · касаний уровня раньше: ${f.level_touches}`,
    `3-фазный сигнал бота: ${f.bot_three_phase ? 'был' : 'не было'}`,
    outcomeLine,
  ];
}

/** Кнопка и панель «Разбор разворотов»: метки на графике + статистика монеты. */
export default function ReversalHistoryPanel({
  pair,
  timeframe,
  authToken,
  onMarkers,
}: {
  pair: string;
  timeframe: string;
  authToken?: string;
  onMarkers: (markers: ReversalChartMarker[]) => void;
}) {
  const [enabled, setEnabled] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [data, setData] = useState<ReversalHistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      onMarkers([]);
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/v1/reversal_history?pair=${encodeURIComponent(pair)}&timeframe=${encodeURIComponent(timeframe)}`, {
      headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
    })
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error || 'Ошибка загрузки');
        return json as ReversalHistoryResponse;
      })
      .then((json) => {
        if (cancelled) return;
        setData(json);
        onMarkers(
          json.events.map((e) => ({
            timestamp: e.timestamp,
            side: e.side,
            level: e.level,
            outcome: e.outcome,
            details: describeReversalEvent(e, json.horizon_bars),
          }))
        );
      })
      .catch((err) => !cancelled && setError(String(err?.message || err)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // onMarkers — сеттер состояния родителя, стабилен
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, pair, timeframe, authToken]);

  if (!enabled) {
    return (
      <button
        type="button"
        onClick={() => setEnabled(true)}
        className="absolute bottom-24 left-12 z-20 rounded border border-[#2a2e39] bg-[#1e222d]/90 px-2 py-1 text-[11px] font-semibold text-[#d1d4dc] hover:border-[#2962ff]"
        title="Показать на графике все прошлые подходы цены к уровням: где был разворот, а где пробой, и что было перед этим"
      >
        ⟲ Разбор разворотов
      </button>
    );
  }

  const baseline = data?.random_baseline_pct ?? 33.3;
  const colorFor = (pct: number) => (pct >= baseline + 5 ? '#26a69a' : pct <= baseline - 5 ? '#ef5350' : '#d1d4dc');
  const resolvedRecent = (data?.events || []).slice(-8).reverse();

  return (
    <div className="absolute bottom-24 left-12 z-20 w-[340px] rounded border border-[#2a2e39] bg-[#1e222d]/95 text-[11px] text-[#d1d4dc] shadow-lg">
      <div className="flex items-center justify-between border-b border-[#2a2e39] px-2 py-1">
        <span className="font-semibold">
          ⟲ Разбор разворотов · {pair.split(':')[0]} · {timeframe}
        </span>
        <span className="flex gap-2">
          <button type="button" className="text-[#9aa4b2] hover:text-white" onClick={() => setCollapsed((v) => !v)}>
            {collapsed ? '▴' : '▾'}
          </button>
          <button type="button" className="text-[#9aa4b2] hover:text-white" onClick={() => setEnabled(false)}>
            ✕
          </button>
        </span>
      </div>
      {!collapsed && (
        <div className="max-h-[360px] overflow-y-auto p-2">
          {loading && <div className="text-[#9aa4b2]">Разбираю историю монеты…</div>}
          {error && <div className="text-[#ef5350]">{error}</div>}
          {data && !loading && (
            <>
              <div className="mb-1 flex gap-3 text-[10px]">
                <span><span className="text-[#26a69a]">▲▼</span> разворот</span>
                <span><span className="text-[#ef5350]">▲▼</span> пробой</span>
                <span><span className="text-[#78909c]">▲▼</span> неясно</span>
                <span><span className="text-[#fbc02d]">△▽</span> ещё идёт</span>
              </div>
              <div className="mb-2 text-[#9aa4b2]">
                Подходов к уровням на графике: <b className="text-[#d1d4dc]">{data.total_events}</b> (с итогом: {data.resolved_events}).
                Разворот = цена ушла на 2 ATR от уровня раньше, чем на 1 ATR против, за {data.horizon_bars} свечей.
              </div>
              <div className="mb-2 grid grid-cols-3 gap-1 text-center">
                <div className="rounded bg-[#131722] p-1">
                  <div className="text-[#9aa4b2]">Разворот</div>
                  <div className="text-[13px] font-semibold" style={{ color: colorFor(data.reversal_pct) }}>
                    {data.reversal_pct}%
                  </div>
                </div>
                <div className="rounded bg-[#131722] p-1">
                  <div className="text-[#9aa4b2]">Пробой</div>
                  <div className="text-[13px] font-semibold">{data.breakout_pct}%</div>
                </div>
                <div className="rounded bg-[#131722] p-1">
                  <div className="text-[#9aa4b2]">Неясно</div>
                  <div className="text-[13px] font-semibold">{data.unclear_pct}%</div>
                </div>
              </div>
              <div className="mb-1 text-[#9aa4b2]">
                Случайный вход даёт «разворот» примерно в {baseline}% случаев. Признак полезен, только если заметно выше.
              </div>
              <table className="mb-2 w-full">
                <thead>
                  <tr className="text-[#787b86]">
                    <th className="text-left font-normal">Что было в момент подхода</th>
                    <th className="text-right font-normal">случаев</th>
                    <th className="text-right font-normal">разворот</th>
                  </tr>
                </thead>
                <tbody>
                  {data.feature_stats.map((s) => (
                    <tr key={s.key}>
                      <td>{s.label}</td>
                      <td className="text-right text-[#9aa4b2]">{s.events}</td>
                      <td className="text-right font-semibold" style={{ color: s.events >= 5 ? colorFor(s.reversal_pct) : '#787b86' }}>
                        {s.events > 0 ? `${s.reversal_pct}%` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mb-1 text-[#787b86]">
                Меньше ~20 случаев — это ещё не закономерность, а случайность. По одной монете выводы ненадёжны: на 30 монетах
                ни один свечной признак не дал преимущества, работал только разворот по дневному тренду.
              </div>
              <div className="mt-2 font-semibold">Последние подходы</div>
              {resolvedRecent.map((e) => (
                <div key={e.timestamp} className="mt-1 border-t border-[#2a2e39] pt-1">
                  {describeReversalEvent(e, data.horizon_bars).map((line, idx) => (
                    <div key={idx} className={idx === 0 ? 'font-semibold' : 'text-[#9aa4b2]'}>
                      {line}
                    </div>
                  ))}
                </div>
              ))}
              <div className="mt-2 text-[#787b86]">Наведите курсор на метку на графике — там те же детали.</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
