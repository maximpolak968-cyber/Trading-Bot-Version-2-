import React, { useEffect, useState } from 'react';

interface TrendState {
  timeframe: string;
  direction: 'UP' | 'DOWN' | 'RANGE';
  strength: 'STRONG' | 'WEAK' | 'NONE';
  adx: number;
  explanation: string;
}

interface TrendRegimeResponse {
  pair: string;
  regime: 'TREND_UP' | 'TREND_DOWN' | 'PULLBACK_UP' | 'PULLBACK_DOWN' | 'CONFLICT' | 'RANGE';
  primary_side: 'long' | 'short' | null;
  allow_entry: boolean;
  d1: TrendState;
  h4: TrendState;
  summary: string;
}

const REGIME_VIEW: Record<TrendRegimeResponse['regime'], { label: string; color: string }> = {
  TREND_UP: { label: 'Тренд вверх', color: '#26a69a' },
  PULLBACK_UP: { label: 'Откат в тренде вверх', color: '#4db6ac' },
  TREND_DOWN: { label: 'Тренд вниз', color: '#ef5350' },
  PULLBACK_DOWN: { label: 'Откат в тренде вниз', color: '#e57373' },
  CONFLICT: { label: 'Конфликт 1D / 4H', color: '#ffa726' },
  RANGE: { label: 'Флэт', color: '#90a4ae' },
};

const arrow = (s: TrendState) => (s.direction === 'UP' ? '↑' : s.direction === 'DOWN' ? '↓' : '→');

/** Значок режима рынка для выбранной пары: тренд 1D/4H и можно ли боту входить. */
export default function TrendRegimeBadge({ pair, authToken }: { pair: string; authToken?: string }) {
  const [data, setData] = useState<TrendRegimeResponse | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/v1/trend?pair=${encodeURIComponent(pair)}`, {
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
        });
        if (!res.ok) return;
        const json = (await res.json()) as TrendRegimeResponse;
        if (!cancelled) setData(json);
      } catch {
        // сеть недоступна — оставляем прошлое значение
      }
    };
    setData(null);
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pair, authToken]);

  if (!data) return null;
  const view = REGIME_VIEW[data.regime];

  return (
    <div
      className="absolute bottom-16 left-12 z-20 select-none"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <div
        className="flex items-center gap-2 rounded px-2 py-1 text-[11px] font-semibold bg-[#1e222d]/90 border"
        style={{ borderColor: view.color, color: view.color }}
      >
        <span>{view.label}</span>
        <span className="text-[#9aa4b2] font-normal">
          1D {arrow(data.d1)} · 4H {arrow(data.h4)}
        </span>
        <span className="text-[#9aa4b2] font-normal">
          {data.allow_entry && data.primary_side
            ? `· основная ${data.primary_side === 'long' ? 'LONG' : 'SHORT'}`
            : '· вход запрещён'}
        </span>
      </div>
      {open && (
        <div className="absolute bottom-full mb-1 w-[380px] rounded bg-[#1e222d] border border-[#2a2e39] p-2 text-[11px] leading-snug text-[#d1d4dc] shadow-lg">
          <div className="mb-1">{data.summary.split('. ')[0]}.</div>
          <div className="text-[#9aa4b2]">{data.d1.explanation}</div>
          <div className="text-[#9aa4b2]">{data.h4.explanation}</div>
          <div className="mt-1 text-[#787b86]">
            Тренд считается по закрытым свечам: направление — наклон EMA50, сила — ADX (ниже 20 — флэт), смена
            состояния подтверждается двумя свечами.
          </div>
        </div>
      )}
    </div>
  );
}
