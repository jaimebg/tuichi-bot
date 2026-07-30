# syntax=docker/dockerfile:1

FROM node:22-slim AS build
WORKDIR /app
# Herramientas de compilación para better-sqlite3, solo en la etapa de build.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY resources ./resources
# data/ llega por volumen; se crea aquí para que exista con el dueño correcto.
RUN mkdir -p data && chown -R node:node /app
USER node
EXPOSE 8910 9090
CMD ["node", "src/index.js"]
