# ── Etapa 1: dependencias de compilación ─────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

# ── Etapa 2: build ───────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

# ── Etapa 3: dependencias de producción ──────────────────────
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev && npx prisma generate

# ── Etapa 4: imagen final ────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

# openssl lo requiere el motor de Prisma; wget lo usa el healthcheck
RUN apk add --no-cache openssl wget

ENV NODE_ENV=production
ENV TZ=America/Santo_Domingo

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package*.json ./

# El almacenamiento de PDFs y logos se monta como volumen
RUN mkdir -p /app/storage && chown -R node:node /app

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/health || exit 1

CMD ["node", "dist/main.js"]
