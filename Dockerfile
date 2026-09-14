FROM node:22-alpine
# docker-cli so LW_SOURCE=docker can run `docker logs -f` against the host's
# daemon when /var/run/docker.sock is mounted. Not needed for file/journald.
RUN apk add --no-cache docker-cli
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.js ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
ENV LW_PORT=3000 LW_BUNDLE_DIR=/bundles
VOLUME /bundles
EXPOSE 3000
CMD ["node", "server.js"]
