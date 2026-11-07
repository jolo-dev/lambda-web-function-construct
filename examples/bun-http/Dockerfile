FROM oven/bun:1.4.4-slim

WORKDIR /var/task

COPY shared/ ./shared/
COPY bun-http/index.ts ./bun-http/index.ts
COPY bun-http/runtime.ts ./bun-http/runtime.ts

ENTRYPOINT ["bun", "run", "/var/task/bun-http/runtime.ts"]
