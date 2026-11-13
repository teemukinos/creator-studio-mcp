# Studio Craft engines: the storytold Craft CLIs, headless, behind an authenticated HTTP MCP gateway.
# Build:  docker buildx build --platform linux/arm64,linux/amd64 -t studio-craft:dev .
# Run:    docker run -e CRAFT_MCP_TOKEN=$(openssl rand -hex 32) -p 8080:8080 studio-craft:dev
# No GPU is assumed: every app renders on the CPU path.

ARG BASE=debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc

FROM ${BASE} AS fetch
ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
COPY image/craft.lock image/fetch-craft.sh /build/
# TARGETARCH is set by BuildKit; other builders may leave it empty.
RUN case "${TARGETARCH:-$(uname -m)}" in \
      arm64|aarch64) arch=aarch64 ;; \
      amd64|x86_64) arch=x86_64 ;; \
      *) echo "unsupported architecture ${TARGETARCH:-$(uname -m)}" >&2; exit 1 ;; \
    esac \
 && sh /build/fetch-craft.sh "$arch" /build/craft.lock /opt/craft

FROM ${BASE}
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=fetch /opt/craft /opt/craft
RUN for d in /opt/craft/*; do ln -s "$d/bin/$(basename "$d")-cli" /usr/local/bin/; done
COPY image/craft.lock /opt/craft/craft.lock
COPY image/craft-health /usr/local/bin/craft-health
COPY gateway/craft_mcp_gateway.py /opt/gateway/craft_mcp_gateway.py
# Per-app read-only cgroup view on hosts without a cgroup filesystem (see the script).
COPY image/cgroup-view /opt/gateway/cgroup-view

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin craft \
 && mkdir -p /work \
 && chown craft:craft /work
USER craft
WORKDIR /work
ENV HOME=/home/craft \
    CRAFT_WORK_ROOT=/work \
    CRAFT_MCP_PORT=8080 \
    PYTHONUNBUFFERED=1
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=30s --start-period=20s --retries=3 CMD ["craft-health"]
# The gateway is PID 1 on purpose: see the note at the top of craft_mcp_gateway.py.
CMD ["python3", "/opt/gateway/craft_mcp_gateway.py"]
