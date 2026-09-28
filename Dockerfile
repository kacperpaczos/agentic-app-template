# Obraz produkcyjny AgenticApp — budowany wyłącznie ze źródeł.
#
# Buduj bez żadnego cache warstw:
#     docker build --no-cache --pull -t agenticapp:czysty .
#
# Nic z hosta nie wchodzi do obrazu poza źródłami: `.dockerignore` odcina
# node_modules, dist, data, backups i katalogi testowe, więc zawartość obrazu
# pochodzi z kodu i `pnpm-lock.yaml`, a nie ze stanu katalogu roboczego.
#
# Etap builder instaluje cały obszar roboczy i buduje; etap runtime dostaje
# wyłącznie zbudowane artefakty i zależności produkcyjne. Kod źródłowy
# TypeScript nie trafia do obrazu końcowego — backend jest jednym plikiem
# `dist/server.js` z esbuild, a frontend statycznym katalogiem z Vite.

# --------------------------------------------------------------------------
# 1. Budowanie
# --------------------------------------------------------------------------
FROM node:24-bookworm-slim AS builder

# `better-sqlite3` to moduł natywny. Zwykle pobiera gotowy binarny artefakt,
# ale gdy dla danej platformy go nie ma, kompiluje się ze źródeł — te trzy
# pakiety są wtedy niezbędne i istnieją tylko w tym etapie.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"

# Jedna z zależności (`@openuidev/lang-core`) wysyła w kroku postinstall
# pseudonimową telemetrię instalacji do PostHog — widać to w logu budowania.
# W obrazie, który ma być powtarzalnym artefaktem i budować się w CI, wołanie do
# sieci przy każdym budowaniu nie jest pożądane. Standardowe `DO_NOT_TRACK`
# wyłącza to bez modyfikowania samej zależności; zmienna dotyczy wyłącznie tego
# etapu budowania i nie trafia do obrazu końcowego.
ENV DO_NOT_TRACK=1

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

WORKDIR /build

# Manifesty osobno od reszty źródeł: instalacja zależy tylko od nich, więc
# zmiana kodu aplikacji nie unieważnia tego kroku przy zwykłym budowaniu.
# Przy `--no-cache` i tak wszystko wykonuje się od nowa.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/server/package.json        apps/server/
COPY apps/web/package.json           apps/web/
COPY packages/platform-contracts/package.json   packages/platform-contracts/
COPY packages/platform-server/package.json      packages/platform-server/
COPY packages/platform-ui/package.json          packages/platform-ui/
COPY packages/module-procurement/package.json   packages/module-procurement/
COPY packages/module-devkit-probe/package.json  packages/module-devkit-probe/

# `--frozen-lockfile`: wersje pochodzą z pnpm-lock.yaml i nie mogą zostać
# ciszej podniesione podczas budowania obrazu.
RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm build

# Zależności produkcyjne w osobnym drzewie. `pnpm deploy` rozwiązuje linki do
# pakietów obszaru roboczego w prawdziwe katalogi, więc wynik działa bez
# całego obszaru roboczego obok.
RUN pnpm --filter @app/server deploy --prod /prod

# --------------------------------------------------------------------------
# 2. Uruchomienie
# --------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

# Kompilatora nie ma w obrazie końcowym: moduł natywny został już zbudowany.
ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder /prod/node_modules       ./node_modules
COPY --from=builder /build/apps/server/dist  ./dist
COPY --from=builder /build/apps/web/dist     ./web

# Katalog danych jest wolumenem. Obraz nie niesie żadnej bazy ani plików —
# stan aplikacji nigdy nie jest częścią artefaktu.
ENV APP_DATA_DIR=/data \
    APP_WEB_DIST=/app/web \
    PORT=8791
VOLUME ["/data"]
EXPOSE 8791

# Bez roota. Katalog danych musi należeć do tego użytkownika, stąd `chown`
# przy tworzeniu punktu montowania.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

# Migracje przy starcie wykonuje sam `createPlatform`, więc osobny krok nie
# jest potrzebny — a przy pustym wolumenie powstaje kompletny schemat.
CMD ["node", "dist/server.js"]
