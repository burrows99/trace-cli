# Python tax service for the self-contained demo (docker compose --profile demo).
# debugpy is baked in; the source is mounted at runtime from ./test/servers. PORT/DEBUG_PORT come from
# compose, and server.py binds 127.0.0.1 — reachable because the runner shares this container's netns.
FROM python:3.12-slim
RUN pip install --no-cache-dir debugpy
WORKDIR /app
CMD ["python", "test/servers/python-api/server.py"]
