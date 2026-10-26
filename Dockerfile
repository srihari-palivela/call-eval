# syntax=docker/dockerfile:1

# Build: install everything, bundle the API and build the console.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/framework/package.json packages/framework/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY packages packages
COPY apps apps
RUN npm run build

# Runtime: production dependencies of the API only, the bundled server and the built console.
FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=8787 WEB_DIST=/app/web PGLITE_DIR=/data/pglite UPLOAD_DIR=/data/uploads
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/framework/package.json packages/framework/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace @calleval/api && npm cache clean --force \
  && mkdir -p /data && chown node:node /data
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/web/dist web
USER node
WORKDIR /app/apps/api
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
