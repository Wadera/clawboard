# Traefik Reverse Proxy Setup

This directory contains Traefik v3 configuration for automatic SSL and routing.

## Features

- ✅ Automatic SSL certificates via Let's Encrypt
- ✅ Docker auto-discovery (labels-based routing)
- ✅ HTTP → HTTPS redirect
- ✅ Security headers (HSTS, CSP, etc.)
- ✅ Rate limiting
- ✅ Dashboard with authentication
- ✅ Modern TLS configuration

## Quick Start

### 1. Configure Traefik

Edit `traefik.yml` and update:

```yaml
certificatesResolvers:
  letsencrypt:
    acme:
      email: your-email@example.com  # CHANGE THIS
```

### 2. Secure the Dashboard

Edit `dynamic.yml` and update the dashboard authentication:

```bash
# Generate password hash
echo $(htpasswd -nb admin YourPassword) | sed -e s/\\$/\\$\\$/g

# Update dynamic.yml:
dashboard-auth:
  basicAuth:
    users:
      - "admin:$$apr1$$..." # Paste generated hash
```

### 3. Create Traefik Network

```bash
# Create the network that ClawBoard will join
docker network create clawboard_network
```

### 4. Start Traefik

```bash
docker compose -f docker-compose.traefik.yml up -d
```

### 5. Enable Traefik in ClawBoard

Edit `docker-compose.yml` and uncomment the Traefik labels:

```yaml
services:
  clawboard-frontend:
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.clawboard.rule=Host(`${DOMAIN}`)"
      - "traefik.http.routers.clawboard.entrypoints=websecure"
      - "traefik.http.routers.clawboard.tls.certresolver=letsencrypt"
      - "traefik.http.services.clawboard.loadbalancer.server.port=80"

  clawboard-backend:
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.clawboard-api.rule=Host(`${DOMAIN}`) && PathPrefix(`/api`)"
      - "traefik.http.routers.clawboard-api.entrypoints=websecure"
      - "traefik.http.routers.clawboard-api.tls.certresolver=letsencrypt"
      - "traefik.http.services.clawboard-api.loadbalancer.server.port=${PORT:-3001}"
```

### 6. Update Environment Variables

In your `.env` file:

```bash
# Set your domain
DOMAIN=clawboard.example.com

# API and WebSocket URLs should use your domain
VITE_API_URL=https://clawboard.example.com/api
VITE_WS_URL=wss://clawboard.example.com/api
CORS_ORIGIN=https://clawboard.example.com
```

### 7. Start ClawBoard

```bash
docker compose up -d
```

### 8. Verify

Check Traefik dashboard (if enabled):

```
https://traefik.yourdomain.com
```

Access ClawBoard:

```
https://clawboard.example.com
```

## File Structure

```
proxy/traefik/
├── README.md                        # This file
├── traefik.yml                      # Static configuration
├── dynamic.yml                      # Dynamic configuration
└── docker-compose.traefik.yml       # Traefik deployment
```

## Configuration Details

### traefik.yml (Static Configuration)

- Entry points: HTTP (80) and HTTPS (443)
- Let's Encrypt ACME configuration
- Docker provider settings
- Logging configuration

### dynamic.yml (Dynamic Configuration)

- Middlewares (security headers, rate limiting, auth)
- TLS options
- Dashboard router (optional)

### docker-compose.traefik.yml

- Traefik container deployment
- Volume mounts for config and certificates
- Network configuration

## Testing with Staging Certificates

For testing, use Let's Encrypt staging server to avoid rate limits:

In `traefik.yml`:

```yaml
certificatesResolvers:
  letsencrypt:
    acme:
      caServer: https://acme-staging-v02.api.letsencrypt.org/directory
```

**Important:** Remove this line for production!

## Troubleshooting

### Certificate Issues

Check Traefik logs:

```bash
docker compose -f docker-compose.traefik.yml logs -f traefik
```

Verify ACME storage:

```bash
docker exec traefik ls -la /letsencrypt/
docker exec traefik cat /letsencrypt/acme.json
```

### Port Conflicts

If ports 80/443 are already in use:

```bash
# Check what's using the ports
sudo netstat -tulpn | grep :80
sudo netstat -tulpn | grep :443

# Stop conflicting services
sudo systemctl stop nginx  # or apache2
```

### DNS Not Pointing to Server

Traefik needs your domain to point to the server:

```bash
# Check DNS resolution
dig +short clawboard.example.com

# Should return your server's IP
```

### ClawBoard Not Appearing

Check Traefik can see the container:

```bash
docker exec traefik wget -qO- http://localhost:8080/api/http/routers
```

Ensure ClawBoard is on the same network:

```bash
docker network inspect clawboard_network
```

## Security Best Practices

1. **Use strong passwords** for the Traefik dashboard
2. **Keep Traefik updated** regularly
3. **Enable access logs** for auditing (optional, disabled by default for privacy)
4. **Use rate limiting** to prevent abuse
5. **Restrict dashboard access** (firewall, VPN, or disable entirely)
6. **Monitor certificate expiry** (Traefik auto-renews, but verify)

## Advanced Configuration

### Custom Middleware

Add to `dynamic.yml`:

```yaml
http:
  middlewares:
    my-middleware:
      headers:
        customResponseHeaders:
          X-Custom-Header: "value"
```

### Multiple Domains

```yaml
labels:
  - "traefik.http.routers.clawboard.rule=Host(`clawboard.example.com`) || Host(`dashboard.example.com`)"
```

### IP Whitelist

```yaml
http:
  middlewares:
    whitelist:
      ipWhiteList:
        sourceRange:
          - "192.168.1.0/24"
          - "10.0.0.0/8"
```

## Resources

- [Traefik Documentation](https://doc.traefik.io/traefik/)
- [Let's Encrypt Rate Limits](https://letsencrypt.org/docs/rate-limits/)
- [Docker Provider](https://doc.traefik.io/traefik/providers/docker/)
- [Middlewares](https://doc.traefik.io/traefik/middlewares/overview/)
