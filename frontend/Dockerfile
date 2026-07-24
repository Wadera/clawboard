FROM node:20-alpine AS builder

WORKDIR /app

ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_LOGLEVEL=error

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --silent --no-fund --no-audit --loglevel=error

# Copy source code
COPY . .

# Build args for environment variables
ARG REACT_APP_API_URL
ARG REACT_APP_WS_URL

ENV VITE_API_URL=$REACT_APP_API_URL
ENV VITE_WS_URL=$REACT_APP_WS_URL

# Build app
RUN npm run build

# Production image with nginx
FROM nginx:alpine

# Copy built files from builder
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Immutable release provenance: baked into the image at build time so runtime
# verification never depends on mounted git metadata. Args are supplied by the
# exact-main deploy wrapper; defaults make ad-hoc builds self-identify as such.
ARG RELEASE_SHA=unknown
ARG RELEASE_DIRTY=unknown
ARG RELEASE_BUILD_CONTEXT=unknown
ARG RELEASE_BUILT_AT=unknown
LABEL org.opencontainers.image.revision=$RELEASE_SHA
LABEL org.opencontainers.image.source="https://github.com/Wadera/clawboard"
LABEL eu.skyday.clawboard.dirty=$RELEASE_DIRTY
LABEL eu.skyday.clawboard.build-context=$RELEASE_BUILD_CONTEXT
RUN printf '{"service":"clawboard-frontend","sha":"%s","dirty":"%s","buildContext":"%s","builtAt":"%s"}\n' \
    "$RELEASE_SHA" "$RELEASE_DIRTY" "$RELEASE_BUILD_CONTEXT" "$RELEASE_BUILT_AT" \
    | tee /release-manifest.json > /usr/share/nginx/html/release-manifest.json

# Expose port
EXPOSE 80

# Start nginx
CMD ["nginx", "-g", "daemon off;"]
