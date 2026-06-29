# nibiru-rpc-watcher

Monitors the Nibiru RPC node (``) for uptime, block height stalls, and response time. Logs to Neon and alerts via Telegram.

## What it does

- Polls `eth_blockNumber` every 30s
- Logs block height, response time, HTTP status, and health to local SQLite
- Detects block height stalls (stuck for 5+ consecutive checks)
- Sends Telegram alerts on: node down, block stall, recovery
- Once a day, verifies the USDC.e FunToken peg (see below)

## USDC.e peg check

Nibiru mirrors the bridged-USDC ERC-20 (`USDC.e`, `0x0829F361A05D993d5CEb035cA6DF3446b060970b`)
as a Cosmos bank denom (`erc20/0x0829…`). The EVM module account escrows the real ERC-20
and the bank module mints a 1:1 mirror. The invariant is **escrow ≥ mirror supply**: every
bank coin must be backed by an escrowed ERC-20. The "minted coins from module account"
log lines are just this conversion firing, not unbacked minting.

Once a day (and once at boot) the watcher reads:
- **escrow** = `USDC.e.balanceOf(EVM module account 0x603871c2…)` via `eth_call`
- **mirror** = bank supply of `erc20/0x0829…` via the Cosmos LCD

and alerts 🔴 if `escrow < mirror` (a real exploit signal). On demand, `/peg` runs the
check live. By default it posts the peg status once a day even when healthy (✅); set
`PEG_HEARTBEAT=false` to stay silent unless there's a breach.

## Setup

### 1. Neon

Already created: project `nibiru-rpc-watcher` (`lively-salad-82750848`). The table is auto-created on first run.

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
| `PEG_CHECK_INTERVAL_MS` | No | `86400000` | USDC.e peg check interval (24h) |
| `LCD_URL` | No | `https://lcd.nibiru.fi` | Cosmos LCD for bank-mirror supply |
| `PEG_RPC_URL` | No | `https://evm-rpc.nibiru.fi` | EVM RPC for escrow `balanceOf` (decoupled from `RPC_URL`) |
| `USDCE_ERC20` | No | `0x0829F361A05D993d5CEb035cA6DF3446b060970b` | USDC.e ERC-20 address |
| `EVM_MODULE_ADDR` | No | `0x603871c2ddd41c26ee77495e2e31e6de7f9957e0` | EVM module escrow account (hex) |
| `BANK_MIRROR_DENOM` | No | `erc20/<USDCE_ERC20>` | Cosmos bank mirror denom |
| `PEG_DECIMALS` | No | `6` | Token decimals |
| `PEG_TOLERANCE_MICRO` | No | `0` | Allowed escrow shortfall (micro) before alert |
| `PEG_HEARTBEAT` | No | `true` | Post the daily peg status even when healthy; set `false` to only alert on breach |

## Local dev

```bash
cp .env.example .env
# fill in values
npm start
```
