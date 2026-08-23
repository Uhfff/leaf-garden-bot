# Leaf Garden bot

The Telegram bot side of [Leaf Garden](https://uhfff.github.io/leaf-garden/) —
a Cloudflare Worker that answers `/start` and `/help` with a short intro and
a button that opens the game as a Telegram Mini App. Anything else it gets
falls back to the same button with a "don't know that one" note.

No server to keep running: Cloudflare Workers only spend compute on an
actual incoming request, so there's nothing idling and nothing to pay for
at this scale.

## How it's wired up

- Telegram calls this worker via a webhook (`setWebhook`) instead of the
  bot polling Telegram for updates.
- The webhook request must carry the `X-Telegram-Bot-Api-Secret-Token`
  header matching the `WEBHOOK_SECRET` secret, so a request to this public
  URL that doesn't come from Telegram gets a 403.
- `BOT_TOKEN` and `WEBHOOK_SECRET` are Worker secrets (`wrangler secret
  put`), never committed — `wrangler.toml` only has the non-secret config.

## Commands

- `/start`, `/help` — intro text + an inline "Open the garden" button
- anything else — fallback text + the same button

## Deploying

```bash
npm install
npx wrangler login          # or set CLOUDFLARE_API_TOKEN instead
npx wrangler secret put BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npx wrangler deploy
```

Then point Telegram at it:

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://<your-worker>.workers.dev", "secret_token": "<WEBHOOK_SECRET>"}'
```
