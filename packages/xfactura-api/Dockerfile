FROM oven/bun:1.4.2
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/xfactura-api/package.json packages/xfactura-api/package.json
COPY packages/xfactura-web/package.json packages/xfactura-web/package.json
RUN bun install --frozen-lockfile
COPY packages/xfactura-api packages/xfactura-api
COPY tsconfig.json LICENSE ./
RUN mkdir -p .accounting && chown -R bun:bun .accounting
USER bun
ENV NODE_ENV=production
EXPOSE 8089
CMD ["bun", "packages/xfactura-api/source/index.ts"]
