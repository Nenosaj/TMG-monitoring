FROM node:24-bookworm-slim

WORKDIR /app

# Install the exact production dependency set before copying source, so Docker
# can reuse this layer when application code changes.
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev --no-audit --no-fund

COPY --chown=node:node server ./server
COPY --chown=node:node public ./public

# Persist local SQLite history log
RUN mkdir -p /app/server/data && chown node:node /app/server/data
VOLUME ["/app/server/data"]

WORKDIR /app/server
ENV NODE_ENV=production \
    PORT=4070
EXPOSE 4070

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
