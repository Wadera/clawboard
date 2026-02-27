FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (needed for build)
RUN npm install

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Production image
FROM node:20-alpine

# Install su-exec for privilege dropping in entrypoint
RUN apk add --no-cache su-exec

WORKDIR /app

# Copy package files and install production dependencies only
COPY package*.json ./
RUN npm install --omit=dev

# Copy built files from builder
COPY --from=builder /app/dist ./dist
# Copy migrations (SQL files, not compiled)
COPY --from=builder /app/src/migrations ./dist/migrations

# Copy entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Default PUID/PGID — override in docker-compose to match host file owner
ENV PUID=1002
ENV PGID=1002

# Expose port
EXPOSE 3000

# Use entrypoint for PUID/PGID handling
ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/server.js"]
