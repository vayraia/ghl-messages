# syntax=docker/dockerfile:1.6

FROM node:22-alpine AS deps
WORKDIR /app
# 1. Copiamos solo lo necesario para resolver dependencias
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --network-timeout 600000

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# 2. Copiamos SOLO los archivos de configuración y el código fuente (quirúrgico)
COPY package.json yarn.lock tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src

# 3. La magia: Compilamos y en el mismo paso le decimos a Yarn que limpie
# los node_modules dejando ÚNICAMENTE las dependencias de producción.
# --prefer-offline evita que Yarn intente descargar cosas de nuevo.
RUN yarn build && yarn install --production --ignore-scripts --prefer-offline

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

RUN addgroup -S app && adduser -S app -G app

# 4. Copiamos los node_modules ya "podados" y la carpeta dist.
# CERO consumo de RAM aquí, solo transferencia de archivos.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

USER app
EXPOSE 3000

CMD ["node", "dist/main.js"]