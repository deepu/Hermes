# Dockerfile for Hermes Crypto15ML Strategy
# Optimized for Railway deployment and local testing
#
# Build: docker build -t hermes .
# Run:   docker run --env-file .env -v $(pwd)/data:/app/data hermes
#
# Or use docker-compose:
#   docker compose up --build

# Build stage
FROM node:22.12-alpine AS builder

WORKDIR /app

# Install pnpm (pinned version for reproducibility)
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY tsconfig.json ./

# Build TypeScript (including scripts)
RUN pnpm run build

# Production stage
FROM node:22.12-alpine AS production

WORKDIR /app

# Create non-root user for security
RUN addgroup -S app && adduser -S app -G app

# Install pnpm (pinned version for reproducibility)
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy built files from builder
COPY --from=builder /app/dist ./dist

# Copy models directory
COPY models/ ./models/

# Create data directory for persistence with correct ownership
# This directory will be mounted as a volume in production
RUN mkdir -p /app/data/crypto15ml && chown -R app:app /app/data

# Set environment
ENV NODE_ENV=production

# Switch to non-root user
USER app

# Run the strategy using compiled JavaScript
CMD ["node", "dist/scripts/crypto15ml/run-strategy.js"]
