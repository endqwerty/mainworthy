# Casebook as one container: the server, the web UI, the CLI and the MCP endpoint in a single executable.
# The data (one SQLite file) lives on the volume at /data. Nothing else is needed: no database container.

FROM oven/bun:1.4 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json biome.json ./
COPY src ./src
COPY skill ./skill
RUN bun build --compile --minify --sourcemap src/cli/main.ts src/server/read-worker.ts --outfile /out/casebook

FROM debian:bookworm-slim
RUN useradd --system --uid 10001 --home-dir /data casebook && mkdir -p /data && chown casebook:casebook /data
COPY --from=build /out/casebook /usr/local/bin/casebook
USER casebook
ENV CASEBOOK_MODE=server \
    CASEBOOK_HOST=0.0.0.0 \
    CASEBOOK_PORT=7357 \
    CASEBOOK_DATA=/data
VOLUME /data
EXPOSE 7357
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD ["casebook", "health"]
ENTRYPOINT ["casebook"]
CMD ["serve"]
