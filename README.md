# Strava MCP Server


It exposes a remote MCP endpoint, protects it with OAuth, stores Strava tokens server-side, and keeps the production URL behind your own domain or tunnel.

## ChatGPT Custom App Setup

1. Copy `.env.example` to `.env` and fill in the required values.
2. Install and build:

```bash
npm install
npm run build
```

3. Start the server:

```bash
npm start
```

4. In ChatGPT, add a custom app and point it at:

```text
https://your-random-subdomain.example.com/mcp
```

5. Complete the OAuth flow once using the allowlisted email.

## Required Environment Variables

- `NODE_ENV=production`
- `PUBLIC_BASE_URL=https://your-random-subdomain.example.com`
- `MCP_SECRET_PATH=/var/lib/strava-coach/secrets.enc.json`
- `SESSION_SECRET=<long-random-session-secret>`
- `TOKEN_ENCRYPTION_KEY=<long-random-encryption-key>`
- `ALLOWED_USER_EMAIL=<your-email>`
- `STRAVA_CLIENT_ID=<strava-client-id>`
- `STRAVA_CLIENT_SECRET=<strava-client-secret>`

`STRAVA_ACCESS_TOKEN` and `STRAVA_REFRESH_TOKEN` are optional bootstrap values. If present, they are stored encrypted at startup.

## Commands

- Install: `npm install`
- Build: `npm run build`
- Run dev: `npm run dev`
- Run production: `npm start`
- Security check: `npm run security-check`
- Test MCP endpoint: `npm run test:mcp`

## Endpoints

- `/health`
- `/mcp`

## Deployment Notes

- Run the server on your on-prem host.
- Put Cloudflare Tunnel or another reverse proxy in front of the app.
- Keep `PUBLIC_BASE_URL` pointed at the buried subdomain so it does not share the main marketing site route tree.
- Keep `MCP_SECRET_PATH` outside the repository on persistent storage.
- Do not expose the MCP endpoint without OAuth in front of it.
- Run `npm run security-check` before connecting ChatGPT to the live URL.

## Security Checklist

See [SECURITY_CHECK.md](./SECURITY_CHECK.md) for the preflight checks before connecting real Strava data.
