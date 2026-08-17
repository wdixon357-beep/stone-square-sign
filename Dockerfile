FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json server.js db.js ./
COPY assets ./assets
COPY public ./public
RUN mkdir -p /var/data/lodge-signing && chown -R node:node /app /var/data/lodge-signing
USER node
EXPOSE 3000
CMD ["node", "server.js"]
