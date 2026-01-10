# Dockerfile for Hermes Crypto15ML Strategy
# Optimized for Railway deployment
#
# Build: docker build -t hermes .
# Run:   docker run --env-file .env hermes

# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY src/ ./src/
COPY tsconfig.json ./

# Build TypeScript
RUN pnpm run build

# Production stage
FROM node:22-alpine AS production

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy built files from builder
COPY --from=builder /app/dist ./dist

# Copy scripts and models directories
COPY scripts/ ./scripts/
COPY models/ ./models/

# Set environment
ENV NODE_ENV=production

# Health check endpoint (optional - strategy logs are primary health indicator)
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "console.log('healthy')" || exit 1

# Run the strategy
# Note: tsx is used for running TypeScript directly in scripts
CMD ["npx", "tsx", "scripts/crypto15ml/run-strategy.ts"]
