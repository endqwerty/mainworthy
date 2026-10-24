# Mainworthy as one container: the server, the web UI, the CLI and the MCP endpoint in a single executable.
# The data (one SQLite file) lives on the volume at /data. Nothing else is needed: no database container.

# The exact Bun: the executable carries it, and THIRD-PARTY-NOTICES.md lists the libraries of this release
# (`licences/README.md`). `test/licences.test.ts` holds the version here, in CI and in the notices to one another.
FROM oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598 AS build
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
# The licence files, which /docs serves too, and Archify's, which each diagram page carries.
COPY LICENSE NOTICE THIRD-PARTY-NOTICES.md ./
COPY licences/archify ./licences/archify
RUN NODE_ENV=production bun build --compile --minify --sourcemap --banner '/*! Mainworthy, Apache-2.0. Software from others is in this file; its licences and notices: /docs/licence */' src/cli/main.ts src/server/ops/read-worker.ts src/server/kernel/checkpoint-worker.ts src/app/start-worker.ts --outfile /out/mainworthy

FROM debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
# Freeze packages and their dependencies together; updating these pins is documented in docs/deploy.md.
# HTTPS uses trust roots from the digest-pinned build image to prevent network-only metadata rollback.
# check-valid-until=no permits expired snapshot metadata; apt still verifies Debian's archive signatures.
RUN printf '%s\n' \
    'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20261022T000000Z/ bookworm main' \
    'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20261022T000000Z/ bookworm-updates main' \
    'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/20261022T000000Z/ bookworm-security main' \
    > /etc/apt/sources.list \
    && rm /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends nftables util-linux \
    && rm -rf /var/lib/apt/lists/*
COPY scripts/container/entrypoint.sh /usr/local/bin/mainworthy-entrypoint
COPY scripts/container/lockdown.nft /usr/local/share/mainworthy/lockdown.nft
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
# Liveness includes the upgrading listener. Readiness requires /healthz ok:true and the expected commit.
# A failed upgrade closes the listener; a worker with no observable progress fails after 30 minutes.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD ["/usr/local/bin/mainworthy-entrypoint", "health"]
ENTRYPOINT ["/usr/local/bin/mainworthy-entrypoint"]
CMD ["serve"]
