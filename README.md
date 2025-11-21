# TradePort Token Buy Bot (Sui)

Telegram bot that watches Sui mainnet for token buys and sends alerts to configured groups. Each group can track its own token, with admin-only configuration stored in SQLite so settings survive restarts.

## Setup

1) Install deps:
```bash
npm install
```

2) Copy `.env.example` to `.env` and fill in:
- `TELEGRAM_BOT_TOKEN`
- Optional: `SUI_RPC_URL`, `POLL_INTERVAL_MS`, `DB_PATH`, `SUI_USD_PRICE` (manual override), `SUI_PRICE_TTL_MS` (cache time for auto price fetch, default 300000 ms)

USD display
-----------
- If `SUI_USD_PRICE` is set, that fixed value is used.
- Otherwise, the bot auto-fetches SUI/USD from CoinGecko every `SUI_PRICE_TTL_MS` ms (default 5 minutes).

3) Run the bot:
```bash
npm start
```

The default DB lives at `./data/buybot.sqlite` (mount `./data` as a volume in Docker to persist).

## Usage

- Add the bot to a Telegram group and run `/startTPbuybot` as an admin.
- The bot DMs you a start-menu style wizard with buttons to configure:
  - Token type
  - Symbol & decimals
  - Min alert size
  - Emoji tiers
  - Header media (photo or GIF)
  - View config / Finish
- Configuration is tied to the group where you ran the command but completed in private chat.

## Files

- `src/index.ts` – loads env, initializes DB, starts Telegram bot + Sui watcher.
- `src/db.ts` – SQLite bootstrap (better-sqlite3) and migrations.
- `src/configStore.ts` – CRUD helpers for chat configs and meta values.
- `src/telegramBot.ts` – Telegram bot, admin-only wizard UI, and validation.
- `src/watcher.ts` – Sui polling loop, buy detection, alert sending.
- `src/utils.ts` – formatting helpers for amounts, emojis, and addresses.
