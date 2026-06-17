# trace-cli — runs the collector + realtime trace UI as a service. Sessions persist in Postgres, so the
# collector needs DATABASE_URL (see docker-compose.yml for the wired-up Postgres service).
#
#   docker build -t trace-cli .
#   docker run -p 4747:4747 -e DATABASE_URL=postgres://user:pass@host:5432/trace trace-cli
#   open http://localhost:4747
#
# Then point traces at it from the host:
#   trace dynamic --node 9229 --bp app.js:42 --curl '…' --emit http://localhost:4747
#
# The image is the full CLI (ENTRYPOINT `trace`); CMD defaults to the collector. Override to run other
# subcommands, e.g.  docker run trace-cli doctor.
FROM node:22-slim

WORKDIR /app

# Install deps first so they cache across source changes (--ignore-scripts: skip `prepare` until src exists).
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts

# App source (only what the CLI/collector needs — test fixtures are excluded via .dockerignore).
COPY bin ./bin
COPY src ./src
COPY README.md LICENSE ./

# Compile the TypeScript (class-first build) → dist/, which bin/trace runs.
RUN npm run build

RUN chown -R node:node /app
USER node

EXPOSE 4747

# Sessions persist in Postgres — provide DATABASE_URL at runtime (-e DATABASE_URL=... / compose).
ENTRYPOINT ["node", "bin/trace"]
CMD ["serve", "--port", "4747", "--host", "0.0.0.0"]
