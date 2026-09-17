FROM oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6 AS builder
WORKDIR /app
ENV SKIP_ENV_VALIDATION=1

COPY . .
RUN --mount=type=cache,target=/root/.bun/install/cache bun install

RUN bun run --cwd packages/db db:generate
ENV NODE_ENV=production
RUN cd apps/server && bun run build

FROM oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6 AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app /app

EXPOSE 3000

WORKDIR /app/apps/server
CMD ["bun", "dist/index.mjs"]
