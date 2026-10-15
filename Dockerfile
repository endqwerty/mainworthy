# Mainworthy as one container: the server, the web UI, the CLI and the MCP endpoint in a single executable.
# The data (one SQLite file) lives on the volume at /data. Nothing else is needed: no database container.

# The exact Bun: the executable carries it, and THIRD-PARTY-NOTICES.md lists the libraries of this release
# (`licences/README.md`). `test/licences.test.ts` holds the version here, in CI and in the notices to one another.
FROM oven/bun:1.4.3 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json biome.json ./
COPY src ./src
COPY skill ./skill
# The documentation the server carries at /docs: its pages, diagrams and screenshots (src/surfaces/docs/content.ts).
COPY docs/guide ./docs/guide
COPY docs/diagrams ./docs/diagrams
COPY docs/ui/screenshots ./docs/ui/screenshots
# The licence files, which /docs serves too.
COPY LICENSE NOTICE THIRD-PARTY-NOTICES.md ./
RUN NODE_ENV=production bun build --compile --minify --sourcemap src/cli/main.ts src/server/read-worker.ts --outfile /out/mainworthy

FROM debian:bookworm-slim
RUN useradd --system --uid 10001 --home-dir /data mainworthy && mkdir -p /data && chown mainworthy:mainworthy /data
COPY --from=build /out/mainworthy /usr/local/bin/mainworthy
COPY --from=build /app/LICENSE /app/NOTICE /app/THIRD-PARTY-NOTICES.md /usr/share/doc/mainworthy/
# The commit /healthz reports, for a plain `docker build` or `docker compose build`: `--build-arg MAINWORTHY_COMMIT=$(git rev-parse HEAD)`.
# Here, after the compile stage, so a new commit does not invalidate the cached layers above. Empty means unknown;
# the server then tries SOURCE_COMMIT, which Coolify sets on the running container and does not pass to the build.
ARG MAINWORTHY_COMMIT=
ENV MAINWORTHY_COMMIT=$MAINWORTHY_COMMIT
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
