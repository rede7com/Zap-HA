FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY app/package.json app/package-lock.json app/ajustes.cjs ./
RUN npm ci --omit=dev --no-audit --no-fund && node ajustes.cjs

COPY app/server.mjs app/painel.html ./
COPY integracao /integracao

CMD ["node", "server.mjs"]
