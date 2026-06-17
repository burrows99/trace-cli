# trace-cli — runs the collector + realtime trace UI as a service.
#
#   docker build -t trace-cli .
#   docker run -p 4747:4747 -v "$PWD/.trace-data:/data" trace-cli
#   open http://localhost:4747
#
# Then point traces at it from the host:
#   trace dynamic --node 9229 --bp app.js:42 --curl '…' --emit http://localhost:4747
#
# The image is the full CLI (ENTRYPOINT `trace`); CMD defaults to the collector. Override to run other
# subcommands, e.g.  docker run trace-cli doctor.
FROM node:22-slim

WORKDIR /app

# Install production deps first so they cache across source changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source (only what the CLI/collector needs — test fixtures are excluded via .dockerignore).
COPY bin ./bin
COPY src ./src
COPY README.md LICENSE ./

# Persist sessions to a mounted volume.
ENV TRACE_DATA=/data
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 4747
VOLUME ["/data"]

ENTRYPOINT ["node", "bin/trace"]
CMD ["serve", "--port", "4747", "--host", "0.0.0.0", "--data", "/data"]
