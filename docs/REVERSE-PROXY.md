# Reverse Proxy Setup

MorrisCode works behind a reverse proxy. The WebSocket connection uses `wss://` (WebSocket over TLS), so the proxy just needs to forward traffic with proper upgrade headers. Unlike plain `ws://`, browsers **do** send the `Authorization` header on `wss://` upgrades, so basic auth works transparently.

The frontend auto-detects the page protocol: `https://` → `wss://`, `http://` → `ws://`.

For plain LAN access — other devices on your network, built-in self-signed HTTPS, no proxy — see
[NETWORK-ACCESS.md](NETWORK-ACCESS.md).

## Nginx

```nginx
server {
    listen 443 ssl;
    server_name yourdomain.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    # Basic auth (optional)
    auth_basic           "MorrisCode";
    auth_basic_user_file /path/to/.htpasswd;

    location / {
        proxy_pass         http://127.0.0.1:10369;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade      $http_upgrade;
        proxy_set_header   Connection   "upgrade";
        proxy_set_header   Host         $host;
        proxy_set_header   X-Real-IP    $remote_addr;
        proxy_set_header   X-Forwarded-For  $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
```

## HAProxy

```
backend morriscode
    bind *:443 ssl crt /path/to/cert.pem
    http-auth realm MorrisCode
    http-auth userfile /path/to/haproxy.htpasswd

    server morriscode 127.0.0.1:10369
    http-request set-header X-Forwarded-Proto https
    http-request set-header X-Forwarded-For %[src]
    http-request set-header Host %[req.hdr(Host)]
    timeout client 30d
    timeout server 30d
```

## Traefik

```yaml
http:
  routers:
    morriscode:
      rule: 'Host(`yourdomain.com`)'
      service: morriscode
      tls: {}
      middlewares:
        - basicAuth:
            users:
              - 'user:$hash'

  services:
    morriscode:
      loadBalancer:
        servers:
          - url: 'http://127.0.0.1:10369'
        passHostHeader: true
```

## Key Points

- **Use `npm start` (not `npm run dev`) behind a proxy** — `npm run dev` uses Vite, which enforces `localhost` by
  default. MorrisCode disables that check for its own dev server (LAN addresses and hostnames both
  work); it still applies to the standalone `npm run dev:web` server.
- **Set `server.host: "127.0.0.1"`** in your MorrisCode config so the backend only listens locally
- The WebSocket endpoint is `/ws` — the frontend always connects to the same origin as the page (e.g. `wss://yourdomain.com/ws`)
- For local dev without a proxy, `ws://localhost:10469/ws` is still the default

## Local Dev Behind a Proxy

If you need to run `npm run dev` while accessing via a domain (instead of `localhost`), create a local vite config:

```bash
cp web/vite.config.local.ts.example web/vite.config.local.ts
```

Edit `vite.config.local.ts` and add your domain to `allowedHosts`:

```ts
export default {
  server: {
    allowedHosts: ['yourdomain.com'],
  },
}
```

This file is gitignored — it won't be committed.
