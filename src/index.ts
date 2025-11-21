import dotenv from 'dotenv';
import TelegramBot from 'node-telegram-bot-api';
import { initDb } from './db';
import { getAllConfigs } from './configStore';
import { startTelegramBot } from './telegramBot';
import { startWatcher } from './watcher';

dotenv.config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUI_RPC_URL = process.env.SUI_RPC_URL || 'https://fullnode.mainnet.sui.io:443';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || '3000');
const DB_PATH = process.env.DB_PATH || './data/buybot.sqlite';
const SUI_USD_PRICE =
  process.env.SUI_USD_PRICE && process.env.SUI_USD_PRICE.trim() !== ''
    ? Number.parseFloat(process.env.SUI_USD_PRICE)
    : null;
const SUI_PRICE_TTL_MS = Number(process.env.SUI_PRICE_TTL_MS || '300000'); // 5 minutes

if (!TELEGRAM_BOT_TOKEN) {
  throw new Error('Missing TELEGRAM_BOT_TOKEN in .env');
}

initDb(DB_PATH);

async function start() {
  const bot: TelegramBot = startTelegramBot(TELEGRAM_BOT_TOKEN as string);
  const getPrice = await createPriceProvider(SUI_USD_PRICE, SUI_PRICE_TTL_MS);
  const cfgs = getAllConfigs();
  console.log(`Loaded ${cfgs.length} chat config(s).`);
  if (cfgs.length > 0) {
    console.log('Chat IDs:', cfgs.map((c) => c.chatId).join(', '));
  }
  startWatcher(bot, SUI_RPC_URL, POLL_INTERVAL_MS, getPrice);
  console.log('TradePort buy bot started.');
}

start().catch((err) => {
  console.error('Failed to start bot', err);
  process.exit(1);
});

async function createPriceProvider(
  fixedPrice: number | null,
  ttlMs: number,
): Promise<() => number | null> {
  if (fixedPrice && Number.isFinite(fixedPrice)) {
    return () => fixedPrice;
  }

  let lastPrice: number | null = null;

  const fetchPrice = async () => {
    try {
      const res = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd',
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as any;
      const val = Number(json?.sui?.usd);
      if (!Number.isFinite(val)) throw new Error('Invalid price payload');
      lastPrice = val;
    } catch (err) {
      console.error('Failed to fetch SUI price', err);
    }
  };

  await fetchPrice();
  setInterval(fetchPrice, ttlMs);
  return () => lastPrice;
}
