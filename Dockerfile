# Mainworthy as one container: the server, the web UI, the CLI and the MCP endpoint in a single executable.
# The data (one SQLite file) lives on the volume at /data. Nothing else is needed: no database container.

FROM oven/bun:1.4 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json biome.json ./
COPY src ./src
COPY skill ./skill
RUN bun build --compile --minify --sourcemap src/cli/main.ts src/server/read-worker.ts --outfile /out/mainworthy

FROM debian:bookworm-slim
RUN useradd --system --uid 10001 --home-dir /data mainworthy && mkdir -p /data && chown mainworthy:mainworthy /data
COPY --from=build /out/mainworthy /usr/local/bin/mainworthy
USER mainworthy
ENV MAINWORTHY_MODE=server \
    MAINWORTHY_HOST=0.0.0.0 \
    MAINWORTHY_PORT=7357 \
    MAINWORTHY_DATA=/data
VOLUME /data
EXPOSE 7357
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD ["mainworthy", "health"]
ENTRYPOINT ["mainworthy"]
CMD ["serve"]
