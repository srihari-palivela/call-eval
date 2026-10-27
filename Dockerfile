# syntax=docker/dockerfile:1

# Console and landing site: build both React apps.
FROM node:22-bookworm-slim AS web
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/framework/package.json packages/framework/
COPY apps/web/package.json apps/web/
COPY apps/site/package.json apps/site/
RUN npm ci
COPY packages packages
COPY apps/web apps/web
COPY apps/site apps/site
RUN npm run build -w @calleval/web && npm run build -w @calleval/site

# API: the Python service with its locked dependencies, plus the built console.
FROM python:3.12-slim-bookworm
ENV PYTHONUNBUFFERED=1 UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PATH=/app/api/.venv/bin:$PATH \
    PORT=8787 WEB_DIST=/app/web SITE_DIST=/app/site PG_DIR=/data/pg UPLOAD_DIR=/data/uploads PG_BIN=/usr/lib/postgresql/15/bin
# PostgreSQL binaries back the embedded database when DATABASE_URL is unset (docker compose sets it).
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-15 && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir uv==0.12.19
WORKDIR /app/api
COPY apps/api/pyproject.toml apps/api/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY apps/api/calleval calleval
RUN uv sync --frozen --no-dev
COPY --from=web /app/apps/web/dist /app/web
COPY --from=web /app/apps/site/dist /app/site
# The embedded PostgreSQL (used when DATABASE_URL is unset) refuses to run as root.
RUN useradd --create-home app && mkdir -p /data && chown app:app /data
USER app
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/healthz' % os.environ.get('PORT', '8787'))"
# `calleval` is on PATH, so `docker compose exec app calleval users create …` works.
CMD ["calleval", "serve"]
