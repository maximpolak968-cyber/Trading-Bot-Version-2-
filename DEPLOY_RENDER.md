# Инструкция по развертыванию FreqUI ScalpBot на Render.com

Проект полностью подготовлен для деплоя на **Render.com** (включая сохранение всех сделок, истории усреднений DCA, ручных уровней графика и подключенных API-аккаунтов на постоянном диске `/data/trades.sqlite`).

---

## Шаг 1. Загрузка проекта в GitHub

1. Создайте **Private** (приватный) репозиторий на [GitHub](https://github.com/new), например `frequi-scalpbot-terminal`.
2. Выполните в папке проекта:

```bash
git init
git add .
git commit -m "Ready for Render deployment"
git branch -M main
git remote add origin https://github.com/ВАШ_АККАУНТ/frequi-scalpbot-terminal.git
git push -u origin main
```

---

## Шаг 2. Развертывание на Render.com

### Вариант А (Рекомендуемый) — В 1 клик через Blueprint (`render.yaml`)
1. Откройте [Render Dashboard](https://dashboard.render.com/).
2. Нажмите **New +** ➔ **Blueprint**.
3. Выберите ваш репозиторий `frequi-scalpbot-terminal`.
4. Render автоматически прочитает файл `render.yaml` и настроит:
   - Docker-окружение (`Dockerfile` + `start.sh`)
   - Проверку здоровья сервиса (`Health Check Path: /api/v1/ping`)
   - Постоянный диск `trading-data` объемом `1 GB`, примонтированный в `/data` (`SQLITE_DB_PATH=/data/trades.sqlite`)
5. Задайте значение секретной переменной `OWNER_PASSWORD` (ваш пароль владельца для входа в терминал) и нажмите **Apply**.

---

### Вариант Б — Ручное создание Web Service (Docker или Node)
1. В [Render Dashboard](https://dashboard.render.com/) нажмите **New +** ➔ **Web Service** и выберите репозиторий.
2. Укажите настройки:
   - **Runtime**: `Docker` (или `Node`, если без Docker: Build Command `npm install --include=dev && npm run build`, Start Command `npm start`)
   - **Region**: `Frankfurt (EU Central)`
   - **Plan**: `Starter` (рекомендуется для 24/7 работы без засыпания и подключения постоянного диска `/data`)
   - **Health Check Path**: `/api/v1/ping`
3. В разделе **Environment Variables** добавьте:
   - `NODE_ENV` = `production`
   - `OWNER_LOGIN` = `admin` (или ваш логин владельца)
   - `OWNER_PASSWORD` = ваш надежный пароль владельца
   - `SQLITE_DB_PATH` = `/data/trades.sqlite` (если подключен диск `/data`)
   - `SESSION_SECRET` = длинная случайная строка (секрет подписи сессий; в Blueprint генерируется автоматически)

> ⚠️ Файл `trades.sqlite` и JSON-бэкапы (`.exchange_accounts.backup.json`, `.trades.backup.json`) нельзя коммитить:
> в них хранятся секрет подписи сессий и API-ключи бирж. Они исключены в `.gitignore` и `.dockerignore`,
> а сервер при первом запуске сам создаёт пустую базу.
4. В разделе **Disks** (на тарифе Starter и выше) добавьте диск:
   - **Name**: `trading-data`
   - **Mount Path**: `/data`
   - **Size**: `1 GB`
5. Нажмите **Create Web Service**.

---

## Шаг 3. Подключение биржи и запуск торговли после деплоя

1. Откройте выданный Render URL (например, `https://frequi-scalpbot-terminal.onrender.com`).
2. Войдите под логином и паролем владельца (`OWNER_LOGIN` / `OWNER_PASSWORD`).
3. Перейдите во вкладку **«Аккаунты» (API / Клиенты)** и добавьте ваш API-ключ биржи (`Bybit`, `Binance`, `OKX`, `Bitget` или `BingX`).
4. Нажмите **«Запустить бота»** — бот начнет автоматическое сканирование рынка (Приоритет №1 — 1H Скальпинг, Приоритет №2 — 2-Way 4H Хедж) с защитой от закрытия в минус (`Zero-Loss Guard`) и авто-реинвестом чистой прибыли.
