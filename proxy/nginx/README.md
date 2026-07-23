# Nginx Reverse Proxy Setup

This directory contains an nginx configuration as an alternative to Traefik for users who prefer nginx.

## Quick Setup

### 1. Install nginx and Certbot

```bash
sudo apt update
sudo apt install nginx certbot python3-certbot-nginx
```

### 2. Get SSL Certificate

```bash
# Create webroot directory for ACME challenge
sudo mkdir -p /var/www/certbot

# Get certificate
sudo certbot certonly --webroot \
  -w /var/www/certbot \
  -d your-domain.com \
  --email your-email@example.com \
  --agree-tos
```

### 3. Configure nginx

```bash
# Copy config file
sudo cp nginx.conf /etc/nginx/sites-available/clawboard

# Edit and update your domain
sudo nano /etc/nginx/sites-available/clawboard

# Enable site
sudo ln -s /etc/nginx/sites-available/clawboard /etc/nginx/sites-enabled/

# Test configuration
sudo nginx -t

# Reload nginx
sudo systemctl reload nginx
```

### 4. Auto-renewal

Certbot installs a cron job automatically. Test it:

```bash
sudo certbot renew --dry-run
```

## Features

- ✅ Automatic HTTP → HTTPS redirect
- ✅ SSL/TLS with Let's Encrypt
- ✅ WebSocket support for real-time updates
- ✅ Security headers (HSTS, X-Frame-Options, etc.)
- ✅ Rate limiting (100 req/sec per IP)
- ✅ Static asset caching
- ✅ Modern TLS configuration (Mozilla Intermediate)

## Comparison: Traefik vs nginx

| Feature | Traefik | nginx |
|---------|---------|-------|
| Auto-discovery | ✅ Docker labels | ❌ Manual config |
| SSL automation | ✅ Built-in ACME | ⚠️ Via Certbot |
| Configuration | YAML files | nginx.conf |
| Dashboard | ✅ Built-in | ❌ N/A |
| Reload | 🔄 Auto | 🔄 Manual |
| Performance | ⚡ Good | ⚡⚡ Excellent |
| Learning curve | 📚 Medium | 📚📚 Steeper |

Choose Traefik for automation and dynamic discovery. Choose nginx for maximum performance and fine-grained control.

## Troubleshooting

### Port conflicts

If port 80/443 is already in use:

```bash
sudo netstat -tulpn | grep :80
sudo netstat -tulpn | grep :443
```

### Certificate issues

Check certificate validity:

```bash
sudo certbot certificates
```

Renew manually:

```bash
sudo certbot renew --force-renewal
```

### nginx logs

```bash
sudo tail -f /var/log/nginx/clawboard-error.log
sudo tail -f /var/log/nginx/clawboard-access.log
```
