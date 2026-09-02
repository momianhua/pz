FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV HOST=0.0.0.0 PORT=8080 ENGINE_MODE=mock STATE_FILE=/app/data/state.json
EXPOSE 8080
CMD ["node", "src/server.js"]
