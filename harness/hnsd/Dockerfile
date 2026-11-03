# hnsd v2.0.0 built for regtest, for the local acceptance harness only.
# Run with --network host and seed it with the local hsd regtest node.
FROM debian:bookworm-slim AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential autoconf automake libtool \
    pkg-config libunbound-dev libuv1-dev git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ARG HNSD_COMMIT=a5c7c287e848f46d3e97f16b698e2027c8dc96c3
RUN git clone https://github.com/handshake-org/hnsd /src \
 && cd /src && git checkout "$HNSD_COMMIT" \
 && ./autogen.sh && ./configure --with-network=regtest && make -j"$(nproc)"

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends libunbound8 libuv1 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/hnsd /usr/local/bin/hnsd
ENTRYPOINT ["/usr/local/bin/hnsd"]
