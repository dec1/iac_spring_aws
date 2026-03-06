# --- Stage 1: Download Alloy binary (from official image)
FROM grafana/alloy:latest AS alloy-bin

# --- Stage 2: Build runtime image with debug tools
FROM debian:bookworm-slim

WORKDIR /app

# ----- Zscaler CERT SETUP -----
# Copy Zscaler cert and install script into build context (build stage only)
COPY zscaler/zscaler.pem /tmp/zscaler.pem
COPY zscaler/install-cert.sh /tmp/install-cert.sh
RUN chmod +x /tmp/install-cert.sh && /tmp/install-cert.sh
# -----

# Install debug/network tools
# RUN apt-get update && \
#     apt-get install -y --no-install-recommends \
#         curl wget iproute2 net-tools iputils-ping dnsutils netcat-openbsd ca-certificates && \
#     rm -rf /var/lib/apt/lists/*

RUN apt-get update && apt-get install -y --no-install-recommends curl wget iproute2 net-tools iputils-ping dnsutils netcat-openbsd ca-certificates procps && rm -rf /var/lib/apt/lists/*



# Copy Alloy binary from official image
COPY --from=alloy-bin /usr/bin/alloy /usr/bin/alloy

# Copy entrypoint script (optional, if you want your own shellCommandToRunAlloy)
# COPY entrypoint.sh /entrypoint.sh
# RUN chmod +x /entrypoint.sh

# Entrypoint can be your command, or just shell
ENTRYPOINT ["/bin/bash"]
# Or, to run Alloy by default:
# ENTRYPOINT ["/usr/bin/alloy", "run", "/etc/agent/agent.river"]
