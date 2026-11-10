# Инструкция по переносу торгового бота на Render.com

Этот проект полностью подготовлен для развертывания на облачной платформе **Render.com** через Docker-контейнер (одновременно работают Node.js веб-панель и Python торговый движок).

---

## Шаг 1. Отправка кода в ваш GitHub-репозиторий

Если репозиторий еще не создан:
1. Создайте новый репозиторий на [GitHub](https://github.com/new) (например, `binance-futures-bot`). Репозиторий рекомендуется сделать **Private** (приватным).
2. Выполните команды в папке с проектом:

```bash
git init
git add .
git commit -m "Подготовка бота для развертывания на Render"
git branch -M main
git remote add origin https://github.com/ВАШ_АККАУНТ/binance-futures-bot.git
git push -u origin main
```

---

## Шаг 2. Развертывание на Render.com

### Вариант А. Через Blueprint (самый быстрый, в 1 клик):
1. Зайдите в [Render Dashboard](https://dashboard.render.com/).
2. Нажмите **New +** в правом верхнем углу и выберите **Blueprint**.
3. Подключите ваш GitHub-аккаунт и выберите репозиторий `binance-futures-bot`.
4. Render автоматически прочитает файл `render.yaml`.
5. В открывшемся окне введите значения для переменных:
   - `BINANCE_API_KEY` — ваш API-ключ от Binance (Testnet или Real).
   - `BINANCE_API_SECRET` — секретный ключ от Binance.
   - `BINANCE_TESTNET` — `true` (для демо-торговли) или `false` (для реальной).
   - `DRY_RUN` — `false` (торговать через ордера) или `true` (эмуляция).
6. Нажмите **Apply**.

---

### Вариант Б. Ручное создание Web Service:
1. В [Render Dashboard](https://dashboard.render.com/) нажмите **New +** -> **Web Service**.
2. Выберите ваш репозиторий.
3. Заполните параметры:
   - **Name**: `binance-futures-bot`
   - **Region**: Frankfurt (или Oregon)
   - **Language / Runtime**: **Docker** (обязательно выберите Docker!)
   - **Plan**: Free (для теста) или Starter (если нужен постоянный диск)
4. Разверните секцию **Environment Variables** (переменные окружения) и добавьте:
   - `NODE_ENV`: `production`
   - `BINANCE_API_KEY`: ваш ключ
   - `BINANCE_API_SECRET`: ваш секрет
   - `BINANCE_TESTNET`: `true` или `false`
   - `DRY_RUN`: `false`
5. (Опционально, для Starter) Вкладка **Disks**:
   - Name: `trading-data`
   - Mount Path: `/data`
   - Size: 1 GB
6. Нажмите **Create Web Service**.

---

## Шаг 3. Проверка работы

1. Во вкладке **Logs** сервиса в Render вы увидите:
   ```text
   === Запуск торгового бота и веб-панели ===
   Запуск торгового ядра Python...
   Торговый бот запущен (PID: ...)
   Запуск Express веб-панели на порту 10000...
   Server running on http://0.0.0.0:10000
   ```
2. Render выдаст вам уникальную ссылку (например, `https://binance-futures-bot.onrender.com`).
3. Откройте эту ссылку в браузере — откроется веб-панель мониторинга и управления ботом.

---

## Важные примечания:
- **Бесплатный тариф Render (Free Tier)**: засыпает при отсутствии входящих HTTP-запросов более 15 минут. Для непрерывной круглосуточной работы бота рекомендуется тариф **Starter** ($7/мес), либо настройка периодического пинга главной страницы веб-панели через любой бесплатный сервис мониторинга (UptimeRobot, CronJob и т.д.).
- **Сохранение базы данных**: на тарифе Starter диск `/data` гарантирует, что история сделок и статистика не обнулятся при обновлении кода или перезагрузке контейнера.
