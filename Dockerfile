# The worker for a Vercel deployment, on any machine with Docker:
#   docker compose up -d --build
# It installs Terraform and cf-terraforming itself on first start (kept in the data volume).
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

ENV NODE_ENV=production CONSOLE_ROLE=worker PORT=4400 CONSOLE_DATA_DIR=/data
VOLUME /data
# The worker only connects out (Supabase, Cloudflare, R2 / S3): no port needs to be published.
CMD ["node", "scripts/worker.mjs"]
