# Сборка образа gateway вместе с собранной веб-мордой.
#
# Один контейнер отдаёт и приложение, и API — чтобы всё открывалось по одному
# адресу и не приходилось разводить настройки для разработки и для сервера.
#
# Образ на Debian (slim), а не на Alpine: SQLite взят встроенный в Node, но
# musl регулярно преподносит сюрпризы с нативными модулями, а выигрыш в
# размере здесь не стоит риска.

# ─────────────────────────── сборка ───────────────────────────
FROM node:24-slim AS build
WORKDIR /app

# Сначала только манифесты: пока они не менялись, слой с зависимостями
# берётся из кэша и npm ci не перезапускается.
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/web/package.json           apps/web/
COPY services/gateway/package.json   services/gateway/
RUN npm ci

COPY . .

# Протокол собирается первым: на его объявления ссылается gateway.
RUN npm run build -w @complex/protocol \
 && npm run build -w @complex/web \
 && npm run build -w @complex/gateway

# ─────────────────────────── запуск ───────────────────────────
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Единственная зависимость времени выполнения — ws. Протокол состоит из одних
# типов и в собранный код не попадает, SQLite встроен в Node.
COPY --from=build /app/node_modules/ws ./node_modules/ws

COPY --from=build /app/services/gateway/dist ./dist
COPY --from=build /app/apps/web/dist         ./web

# Доменные скрипты для Rhino: gateway читает их с диска и отправляет в движок
# целиком. Держим настоящими файлами .py, а не строками внутри TypeScript, —
# поэтому они и попадают в образ отдельно от собранного кода.
COPY --from=build /app/engines/rhino/scripts ./engines/rhino/scripts

# Работаем от непривилегированного пользователя, он есть в образе node.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV WEB_ROOT=/app/web
ENV DB_PATH=/data/complex.db
ENV PORT=8787

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
