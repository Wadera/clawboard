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

WORKDIR /app

# Copy package files and install production dependencies only
COPY package*.json ./
RUN npm install --omit=dev

# Copy built files from builder
COPY --from=builder /app/dist ./dist
# Copy migrations (SQL files, not compiled)
COPY --from=builder /app/src/migrations ./dist/migrations

# Create non-root user (UID 1002 to match host clawd user)
RUN addgroup -g 1002 -S nodejs && \
    adduser -S nodejs -u 1002

USER nodejs

# Expose port
EXPOSE 3000

# Start server
CMD ["node", "dist/server.js"]
