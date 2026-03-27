# nibiru-rpc-listener

Monitors the Nibiru RPC node (``) for uptime, block height stalls, and response time. Logs to Neon and alerts via Telegram.

## What it does

- Polls `eth_blockNumber` every 30s
- Logs block height, response time, HTTP status, and health to Neon
- Detects block height stalls (stuck for 5+ consecutive checks)
- Sends Telegram alerts on: node down, block stall, recovery

## Setup

### 1. Neon

Already created: project `nibiru-rpc-listener` (`lively-salad-82750848`). The table is auto-created on first run.

### 2. Telegram Bot

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → get the token
2. Send a message to your bot, then hit `https://api.telegram.org/bot<TOKEN>/getUpdates` to get your chat ID
3. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`

### 3. Railway

```bash
railway login
railway init
railway up
```

Set env vars in Railway dashboard:
- `DATABASE_URL`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `RPC_URL` (optional, defaults to ``)

## Env vars

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | Neon Postgres connection string |
| `RPC_URL` | No | `` | Nibiru EVM RPC endpoint |
| `TELEGRAM_BOT_TOKEN` | No | — | Telegram bot token |
| `TELEGRAM_CHAT_ID` | No | — | Telegram chat ID for alerts |
| `POLL_INTERVAL_MS` | No | `30000` | Poll interval in ms |
| `STALL_THRESHOLD_CHECKS` | No | `5` | Consecutive stall checks before alert |

## Local dev

```bash
cp .env.example .env
# fill in values
npm start
```
