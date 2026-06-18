# All-in-one demo image. This single container IS the whole end-to-end demo: it bundles the trace CLI,
# Node, a headless Chromium (the Recorder also renders the React replay frames with it) and ffmpeg (encodes
# the mp4). At runtime it starts the Node/React/Chrome targets on its own loopback, waits for them + the
# collector, then runs test/servers/scenarios.sh, emitting each trace.
FROM node:22-slim

# chromium + ffmpeg for the Chrome trace & video recording; curl for the readiness probes in run.sh.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates chromium ffmpeg \
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
