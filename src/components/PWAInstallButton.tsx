import React, { useState } from 'react';
import { Download, Smartphone, X } from 'lucide-react';
import { usePWAInstall, useOnlineStatus } from '../hooks/usePWAInstall';

export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showGuide, setShowGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  return (
    <>
      <button
        type="button"
        onClick={async () => {
          if (isInstallable) {
            await install();
          } else {
            setShowGuide(true);
          }
        }}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[4px] bg-[#00b4d8]/15 hover:bg-[#00b4d8]/25 border border-[#00b4d8]/40 text-[#38bdf8] text-[11px] font-medium transition-colors"
        title="Установить терминал как приложение (PWA) на компьютер или телефон"
      >
        <Download className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">Приложение</span>
      </button>

      {showGuide && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
          <div className="w-full max-w-md rounded-xl bg-[#1c1f24] border border-[#2d333d] p-5 shadow-2xl text-[#e2e8f0]">
            <div className="flex items-center justify-between pb-3 border-b border-[#2d333d]">
              <div className="flex items-center gap-2">
                <Smartphone className="w-5 h-5 text-[#00b4d8]" />
                <h3 className="text-[15px] font-bold text-white">
                  Установка терминала ScalpBot (PWA)
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowGuide(false)}
                className="text-[#9ca3af] hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="mt-3 space-y-3 text-[12px] text-[#cfd6df]">
              {isIOS ? (
                <div className="p-3 rounded-lg bg-[#141619] border border-[#2a2f38] space-y-1.5">
                  <div className="font-semibold text-[#38bdf8]">На iPhone / iPad (Safari):</div>
                  <div>1. Нажмите кнопку <strong>Поделиться</strong> (Share) в нижней панели Safari.</div>
                  <div>2. Выберите пункт <strong>«На экран Домой» (Add to Home Screen)</strong>.</div>
                </div>
              ) : (
                <>
                  <div className="p-3 rounded-lg bg-[#141619] border border-[#2a2f38] space-y-1.5">
                    <div className="font-semibold text-[#38bdf8]">На компьютере (Chrome / Edge):</div>
                    <div>
                      Откройте прямую ссылку сайта в новой вкладке и нажмите иконку{' '}
                      <strong>«Установить приложение»</strong> в правой части адресной строки браузера.
                    </div>
                  </div>
                  <div className="p-3 rounded-lg bg-[#141619] border border-[#2a2f38] space-y-1.5">
                    <div className="font-semibold text-[#10b981]">На телефоне (Android / iOS):</div>
                    <div>
                      В Chrome нажмите меню <strong>⋮ → «Установить приложение»</strong>. В Safari на iPhone нажмите{' '}
                      <strong>Поделиться → «На экран Домой»</strong>.
                    </div>
                  </div>
                </>
              )}
            </div>

            <button
              type="button"
              onClick={() => setShowGuide(false)}
              className="mt-4 w-full py-2 rounded-lg bg-[#00b4d8] hover:bg-[#0096c7] text-[#090d11] font-semibold text-[12px] transition"
            >
              Понятно
            </button>
          </div>
        </div>
      )}
    </>
  );
};

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div className="fixed bottom-4 left-4 z-[200] flex items-center gap-2 rounded-lg bg-amber-500/95 px-3 py-1.5 text-xs font-medium text-slate-950 shadow-lg">
      <span className="h-2 w-2 rounded-full bg-slate-950 animate-pulse" />
      Автономный режим — ожидание подключения к сети
    </div>
  );
};
