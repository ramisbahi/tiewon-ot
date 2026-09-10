FROM node:24-bookworm-slim
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --ignore-scripts && npm cache clean --force
COPY web/lib ../web/lib
COPY bot ../bot
RUN mkdir -p /app/.bot-state && chown node:node /app/.bot-state
USER node
CMD ["node", "--import", "tsx", "../bot/run.ts"]
