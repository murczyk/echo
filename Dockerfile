ARG APP_NAME=echo
FROM ubuntu:22.04 AS build
ARG APP_NAME
WORKDIR /app

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y openssl libssl-dev build-essential libclang-dev libopencv-dev curl wget libsqlite3-dev clang libcurl4-openssl-dev;
RUN curl -O http://archive.ubuntu.com/ubuntu/pool/main/libz/libzstd/libzstd1_1.5.5+dfsg2-1ubuntu2_amd64.deb \
	&& curl -O http://archive.ubuntu.com/ubuntu/pool/main/libw/libwebp/libwebp7_1.2.4-0.3_amd64.deb \
	&& curl -O http://archive.ubuntu.com/ubuntu/pool/main/l/lerc/liblerc4_4.0.0+ds-2ubuntu2_amd64.deb \
	&& curl -O http://archive.ubuntu.com/ubuntu/pool/main/t/tiff/libtiff6_4.5.1+git230720-1ubuntu1_amd64.deb \
	&& curl -O http://archive.ubuntu.com/ubuntu/pool/universe/p/proj/proj-data_9.2.1-1_all.deb \
    && curl -O http://archive.ubuntu.com/ubuntu/pool/universe/p/proj/libproj-dev_9.2.1-1_amd64.deb \
    && curl -O http://archive.ubuntu.com/ubuntu/pool/universe/p/proj/libproj25_9.2.1-1_amd64.deb \
    && dpkg -i libzstd1_1.5.5+dfsg2-1ubuntu2_amd64.deb libwebp7_1.2.4-0.3_amd64.deb liblerc4_4.0.0+ds-2ubuntu2_amd64.deb libtiff6_4.5.1+git230720-1ubuntu1_amd64.deb proj-data_9.2.1-1_all.deb libproj25_9.2.1-1_amd64.deb libproj-dev_9.2.1-1_amd64.deb ;

ENV PATH="${PATH}:/root/.cargo/bin"
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- --default-toolchain nightly -y;

WORKDIR /repo
# Cache downloaded+built dependencies
COPY wdintel-rs/Cargo.toml wdintel-rs/Cargo.lock /repo/
RUN \
    mkdir /repo/src && \
    echo 'fn main() {}' > /repo/src/main.rs;
RUN --mount=type=bind,source=wdintel-rs/src,target=wdintel-rs/src \
    --mount=type=bind,source=wdintel-rs/Cargo.toml,target=wdintel-rs/Cargo.toml \
    --mount=type=bind,source=wdintel-rs/Cargo.lock,target=wdintel-rs/Cargo.lock \
    --mount=type=cache,target=/app/target/ \
    --mount=type=cache,target=/usr/local/cargo/registry/ \
    touch src/main.rs && \
    <<EOF
set -e
cd wdintel-rs && cargo build --locked --release
EOF

# Build our actual code
COPY wdintel-rs/src /repo/src
RUN --mount=type=bind,source=wdintel-rs/src,target=wdintel-rs/src \
    --mount=type=bind,source=wdintel-rs/Cargo.toml,target=wdintel-rs/Cargo.toml \
    --mount=type=bind,source=wdintel-rs/Cargo.lock,target=wdintel-rs/Cargo.lock \
    --mount=type=cache,target=/app/target/ \
    --mount=type=cache,target=/usr/local/cargo/registry/ \
    touch src/main.rs && \
    <<EOF
set -e
cd wdintel-rs && cargo build --locked --release
cd wdintel-rs && cp ./target/release/$APP_NAME /bin/server
EOF

# # Build the application.
# # Leverage a cache mount to /usr/local/cargo/registry/
# # for downloaded dependencies and a cache mount to /app/target/ for 
# # compiled dependencies which will speed up subsequent builds.
# # Leverage a bind mount to the src directory to avoid having to copy the
# # source code into the container. Once built, copy the executable to an
# # output directory before the cache mounted /app/target is unmounted.
# RUN --mount=type=bind,source=wdintel-rs/src,target=wdintel-rs/src \
#     --mount=type=bind,source=wdintel-rs/Cargo.toml,target=wdintel-rs/Cargo.toml \
#     --mount=type=bind,source=wdintel-rs/Cargo.lock,target=wdintel-rs/Cargo.lock \
#     --mount=type=cache,target=/app/target/ \
#     --mount=type=cache,target=/usr/local/cargo/registry/ \
#     <<EOF
# set -e
# cd wdintel-rs && cargo build --locked --release
# cd wdintel-rs && cp ./target/release/$APP_NAME /bin/server
# EOF
# ################################################################################
# # Create a new stage for running the application that contains the minimal
# # runtime dependencies for the application. This often uses a different base
# # image from the build stage where the necessary files are copied from the build
# # stage.
# FROM ubuntu:22.04 AS final

# # Create a non-privileged user that the app will run under.
# # See https://docs.docker.com/go/dockerfile-user-best-practices/
# ARG UID=10001
# RUN adduser \
#     --disabled-password \
#     --gecos "" \
#     --home "/nonexistent" \
#     --shell "/sbin/nologin" \
#     --no-create-home \
#     --uid "${UID}" \
#     appuser
# USER appuser

# # Copy the executable from the "build" stage.
# COPY --from=build /bin/server /bin/

# # Expose the port that the application listens on.
# EXPOSE 8081

# # What the container should run when it is started.
# CMD ["/bin/server"]
