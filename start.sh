#!/usr/bin/env bash
set -e

echo "=== Запуск сайта и торгового терминала FreqUI ScalpBot ==="

# Поддержка постоянного диска Render (/data) для сохранения БД trades.sqlite
if [ -d "/data" ]; then
  # Шаблонная БД из репозитория НЕ копируется: в ней лежит секрет подписи сессий.
  # Если базы на диске ещё нет, сервер создаст чистую сам.
  ln -sf /data/trades.sqlite trades.sqlite
  echo "Связана база данных с постоянным диском: /data/trades.sqlite"
fi

echo "Запуск сервера FreqUI ScalpBot на порту ${PORT:-3000}..."
exec npx tsx server.ts
