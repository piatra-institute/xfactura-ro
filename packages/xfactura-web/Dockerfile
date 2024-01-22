FROM node:20-alpine as builder

WORKDIR /app

COPY .npmrc ./
COPY package*.json ./

RUN yarn install --frozen-lockfile

COPY . .

RUN yarn build



FROM node:20-alpine as runner

WORKDIR /app

COPY --from=builder /app/package*.json .
COPY --from=builder /app/next.config.js ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next

EXPOSE 3000

CMD ["yarn", "start"]


### Build Command
# > docker build -t xfactura-ro .

### Run Command
# > docker run -d -p 8383:3000 -e NEXT_PUBLIC_IN_PRODUCTION=false -e NEXT_PUBLIC_X_DOMAIN=http://localhost:3000 xfactura-ro
