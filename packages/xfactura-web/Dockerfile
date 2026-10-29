FROM oven/bun:1.4.2 AS bun
FROM node:24-bookworm-slim AS builder
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/xfactura-core/package.json packages/xfactura-core/package.json
COPY packages/xfactura-api/package.json packages/xfactura-api/package.json
COPY packages/xfactura-web/package.json packages/xfactura-web/package.json
RUN bun install --frozen-lockfile
COPY packages/xfactura-core packages/xfactura-core
COPY packages/xfactura-api packages/xfactura-api
COPY packages/xfactura-web packages/xfactura-web
COPY tsconfig.json LICENSE ./
ARG ACCOUNTING_API_URL=http://api:8089
ENV ACCOUNTING_API_URL=$ACCOUNTING_API_URL
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run --cwd packages/xfactura-web build

FROM node:24-bookworm-slim AS runner
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app
# Include the built app, public assets and the workspace packages it transpiles.
COPY --from=builder --chown=node:node /app /app
USER node
WORKDIR /app/packages/xfactura-web
EXPOSE 3000
CMD ["node", "node_modules/next/dist/bin/next", "start"]
