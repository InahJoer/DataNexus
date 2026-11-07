FROM node:22.22.3-bookworm-slim AS base

WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

FROM base AS build-deps
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

FROM build-deps AS development
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci
COPY . .
RUN DATABASE_URL=postgresql://datanexus:datanexus@127.0.0.1:5432/datanexus?schema=public npm exec -- prisma generate
ENV NODE_ENV=development PORT=3001
EXPOSE 3001
CMD ["npm", "run", "dev"]

FROM build-deps AS builder
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci
COPY . .
RUN DATABASE_URL=postgresql://datanexus:datanexus@127.0.0.1:5432/datanexus?schema=public npm exec -- prisma generate \
    && npm run build

FROM build-deps AS production-deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev \
    && DATABASE_URL=postgresql://datanexus:datanexus@127.0.0.1:5432/datanexus?schema=public npm exec -- prisma generate

FROM base AS runner
ENV NODE_ENV=production PORT=3001
COPY --from=production-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/prisma ./prisma
COPY --from=builder --chown=node:node /app/package.json ./package.json
RUN mkdir -p /app/storage/reports && chown node:node /app/storage/reports
USER node
EXPOSE 3001
CMD ["sh", "-c", "npm run db:deploy && exec npm run start:prod"]
