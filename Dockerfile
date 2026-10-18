# School17 backend (NestJS + Prisma). Build:  docker build -t school17-backend ./backend
# Needs a PostgreSQL database (DATABASE_URL) and the secrets listed in .env.example. See ../deploy/README.md.

# ---- build ----
FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

# ---- run ----
FROM node:20-bookworm-slim AS run
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PORT=3000 \
    FILES_DIR=/data/files
# the Prisma command line is needed at start to apply database migrations, so node_modules is kept whole
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json package-lock.json ./
RUN mkdir -p /data/files /app/uploads/avatars && chown -R node:node /data /app/uploads
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "require('net').connect(process.env.PORT||3000,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"
# migrations first (safe to repeat), then the server
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main"]
