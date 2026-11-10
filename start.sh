#!/usr/bin/env bash
set -e

echo "=== Запуск сайта и торгового терминала FreqUI ScalpBot ==="

# Поддержка постоянного диска Render (/data) для сохранения БД trades.sqlite
if [ -d "/data" ]; then
  if [ ! -f "/data/trades.sqlite" ] && [ -f "trades.sqlite" ]; then
    echo "Копирование начальной БД на постоянный диск /data..."
    cp trades.sqlite /data/trades.sqlite
  fi
  ln -sf /data/trades.sqlite trades.sqlite
  echo "Связана база данных с постоянным диском: /data/trades.sqlite"
fi

echo "Запуск сервера FreqUI ScalpBot на порту ${PORT:-3000}..."
exec npx tsx server.ts
