FROM --platform=linux/arm64 node:22-slim

# What the agent's bash tool can reach for:
#   ripgrep - fast search    git     - diffs and history in the workspace
#   curl    - fetch          python3 - scripting (httpx for HTTP)
# No gh: this agent has no GitHub credential and never opens PRs.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ripgrep curl ca-certificates git \
      python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Python deps for scripts the agent runs via bash. PEP 668 makes system pip
# refuse to install by default; the override is fine inside a container.
RUN pip install --no-cache-dir --break-system-packages \
      httpx==0.28.1

# tsx so we can run TypeScript directly - no compile step.
RUN npm install -g --no-fund --no-audit tsx@4

WORKDIR /app

# Reproducible installs: package-lock pins exact versions; npm ci enforces.
COPY package.json package-lock.json ./
RUN npm ci --no-fund --no-audit

# config*.json so an untracked config.local.json overrides in the image too.
COPY config*.json ./
COPY src/ ./src/

# Skills surfaced to the agent via the AgentSkills plugin. Each subdir
# under skills/ is one skill (must contain SKILL.md).
COPY skills/ ./skills/

RUN mkdir -p /workspace

ENV NODE_NO_WARNINGS=1
EXPOSE 8080

# Load AWS's OpenTelemetry distro before the app so Strands' spans and metrics
# land in the right places in AgentCore Observability. A no-op unless
# AGENT_OBSERVABILITY_ENABLED is set, which the stack does when tracing is on.
CMD ["node", "--import", "tsx", "--import", "@aws/aws-distro-opentelemetry-node-autoinstrumentation/register", "src/server.ts"]
