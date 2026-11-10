import React from 'react';
import { fmtComma, fmtProfitPct } from '../types/frequi';

interface ProfitPillProps {
  profitPct: number;
  profitAbs?: number;
  customText?: string;
  compact?: boolean;
}

export const ProfitPill: React.FC<ProfitPillProps> = ({
  profitPct,
  profitAbs,
  customText,
  compact = false,
}) => {
  const isPositive = profitPct > 0 || (profitPct === 0 && (profitAbs ?? 0) > 0);

  const label =
    customText !== undefined
      ? customText
      : profitAbs !== undefined
      ? `${fmtProfitPct(profitPct)} (${fmtComma(profitAbs, 3)})`
      : fmtProfitPct(profitPct);

  return (
    <div
      className={`inline-flex items-center justify-between rounded-[4px] border font-sans tabular-nums select-none ${
        compact ? 'px-1.5 py-0.5 text-[11px] min-w-[104px]' : 'px-2.5 py-0.5 text-[12px] min-w-[138px]'
      } ${
        isPositive
          ? 'bg-[#122a22] border-[#1fa866] text-[#e2e8f0]'
          : 'bg-[#2c1519] border-[#dc3545] text-[#e2e8f0]'
      }`}
    >
      <span
        className={`text-[10px] mr-1.5 leading-none ${
          isPositive ? 'text-[#22c55e]' : 'text-[#ef4444]'
        }`}
      >
        {isPositive ? '▲' : '▼'}
      </span>
      <span className="flex-1 text-center font-medium whitespace-nowrap">{label}</span>
    </div>
  );
};
