# Model Prism — Setup Guide

## Local Development

```bash
cd C:\Dev\Tools\model-prism
bun install
bun dev
```

Open http://localhost:3000, set your API keys, and start analyzing.

Local dev uses a file-based SQLite database (`local.db`) — no setup needed.

## API Keys

Both keys are stored in your browser's localStorage. Set them in the app UI or on the Settings page.

- **OpenRouter** — Get a key at https://openrouter.ai/keys
- **Anthropic** — Get a key at https://console.anthropic.com (needed for synthesis only)

## Deploy to Vercel

### 1. Create a Turso Database

```bash
# Install Turso CLI
curl -sSfL https://get.tur.so/install.sh | bash

# Sign up / login
turso auth signup   # or: turso auth login

# Create database
turso db create model-prism

# Get connection URL
turso db show model-prism --url

# Create auth token
turso db tokens create model-prism
```

### 2. Set Vercel Environment Variables

```bash
vercel env add TURSO_DATABASE_URL    # paste the URL from step 1
vercel env add TURSO_AUTH_TOKEN      # paste the token from step 1
```

Or set them in the Vercel dashboard under Project Settings > Environment Variables.

### 3. Deploy

```bash
vercel --prod
```

The database tables are auto-created on first request — no migration step needed.

## Tech Stack

- **Next.js 15** (App Router) + **Tailwind CSS** + **shadcn/ui**
- **OpenRouter** for multi-model fan-out
- **Anthropic API** via Vercel AI SDK for synthesis
- **Turso/LibSQL** for persistence (SQLite in dev, serverless in prod)
- **p-limit** for client-side request throttling
