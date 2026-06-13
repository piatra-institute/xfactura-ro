FROM node:20-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
COPY . /app
WORKDIR /app

FROM base AS prod-deps
# RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile
RUN pnpm install --prod --frozen-lockfile

FROM base AS build
# RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm install --frozen-lockfile
RUN pnpm run build

FROM base
ENV PORT=8080
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=build /app/build /app/build
EXPOSE 8000
# Runtime needs only node. Invoking pnpm here runs corepack, which at container startup
# tries to fetch+verify the latest pnpm and crashes on npm's rotated signing key
# ("Cannot find matching keyid") — this took api.xfactura.ro down for 402 days (2026-06).
# Running node directly avoids corepack entirely. (The live Deployment overrides command
# to the same effect; this keeps it fixed across rebuilds.)
CMD [ "node", "/app/build/index.js" ]


### Build Command
# > docker build -t xfactura-ro-api .

### Run Command
# > docker run -d -p 8484:8080 xfactura-ro-api
# > docker run --env-file ./.env -d -p 8484:8080 xfactura-ro-api
