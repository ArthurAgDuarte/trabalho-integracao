# syntax=docker/dockerfile:1

# 1) Compila o TypeScript.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# 2) Só as dependências de produção (sem TypeScript, Vitest, tsx...).
FROM node:24-slim AS dependencias
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 3) Imagem final. Os arquivos ficam com dono root e a API roda como o usuário
#    "node" (não-root) da imagem oficial: ela consegue ler, mas não alterar o código.
FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencias /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 8000
CMD ["node", "--enable-source-maps", "dist/main.js"]
