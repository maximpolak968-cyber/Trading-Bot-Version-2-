FROM node:22-bookworm-slim

# Установка системных утилит и Python 3
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    sqlite3 \
    ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Установка зависимостей Python (для пакета freqtrade)
COPY requirements.txt ./
RUN pip3 install --no-cache-dir -r requirements.txt --break-system-packages || true

# Установка зависимостей Node.js (включая devDependencies для сборки Vite + TypeScript)
COPY package*.json ./
RUN npm install --include=dev --legacy-peer-deps

# Копирование исходного кода приложения
COPY . .

# Сборка фронтенда (Vite + PWA Service Worker)
RUN npm run build

# Очистка CRLF (если проект загружен с Windows) и права на исполнение скрипта запуска
RUN sed -i 's/\r$//' ./start.sh && chmod +x ./start.sh

ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

CMD ["bash", "./start.sh"]
