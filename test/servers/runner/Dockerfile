# Scenario runner — and the image for the traced headless Chrome. Bundles the trace CLI, a headless
# Chromium (the Recorder renders the React debug-replay frames with it), and ffmpeg (encodes the mp4).
# At runtime it shares the demo network namespace, so every target is on localhost; it waits for them,
# then runs test/servers/scenarios.sh, emitting each trace to the collector.
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium ffmpeg curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Chromium won't run as root without --no-sandbox. The Recorder spawns Chrome via $CHROME_BIN, so point
# it at a wrapper that always adds the container-safe flags (no separate code path needed).
RUN printf '#!/bin/sh\nexec /usr/bin/chromium --no-sandbox --disable-dev-shm-usage "$@"\n' \
      > /usr/local/bin/chrome-wrap && chmod +x /usr/local/bin/chrome-wrap
ENV CHROME_BIN=/usr/local/bin/chrome-wrap

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY bin ./bin
COPY src ./src
# CLI only — the runner never serves the UI, so skip the (heavy) Next.js export.
RUN npm run build:cli

# test/servers (scenarios.sh + the app sources, needed for breakpoint + source-map resolution) is
# bind-mounted at runtime so editing a scenario doesn't require a rebuild.
CMD ["bash", "test/servers/runner/run.sh"]
