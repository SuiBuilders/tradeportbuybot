import {
  SuiClient,
  type BalanceChange,
  type SuiTransactionBlockResponse,
} from '@mysten/sui/client';
import TelegramBot from 'node-telegram-bot-api';
import { ChatConfig, getAllConfigs, getMeta, setMeta } from './configStore';
import {
  computeEmojiBar,
  formatAmount,
  formatAmountFixed,
  formatUsd,
  shortAddress,
} from './utils';

const QUERY_OPTIONS = {
  showBalanceChanges: true,
  showInput: false,
  showRawInput: false,
  showEvents: false,
  showEffects: true,
} as const;

const FALLBACK_QUERY_OPTIONS = {
  showBalanceChanges: false,
  showInput: false,
  showRawInput: false,
  showEvents: false,
  showEffects: true,
} as const;

export function startWatcher(
  bot: TelegramBot,
  rpcUrl: string,
  pollIntervalMs: number,
  getSuiUsdPrice: () => number | null,
) {
  const client = new SuiClient({ url: rpcUrl });
  let lastSeenDigest = getMeta('last_seen_digest');
  let isPolling = false;
  let effectErrorLogged = false;

  const seedLastSeen = async () => {
    if (lastSeenDigest) return;
    try {
      const resp = await queryTxBlocks(client, 50, () => {
        if (!effectErrorLogged) {
          console.warn('Falling back to effects-only seed due to missing balance changes.');
          effectErrorLogged = true;
        }
      });
      const newest = resp.data?.[0];
      if (newest?.digest) {
        lastSeenDigest = newest.digest;
        setMeta('last_seen_digest', newest.digest);
      }
    } catch (err) {
      console.error('Failed to seed last seen digest', err);
    }
  };

  const poll = async () => {
    if (isPolling) return;
    isPolling = true;
    try {
      await pollOnce(
        bot,
        client,
        () => lastSeenDigest,
        (digest) => {
          lastSeenDigest = digest;
          setMeta('last_seen_digest', digest);
        },
        getSuiUsdPrice,
      );
    } catch (err) {
      console.error('Watcher poll failed', err);
    } finally {
      isPolling = false;
    }
  };

  void seedLastSeen().then(poll);
  setInterval(poll, pollIntervalMs);
}

async function pollOnce(
  bot: TelegramBot,
  client: SuiClient,
  getLastSeen: () => string | null,
  saveLastSeen: (digest: string) => void,
  getSuiUsdPrice: () => number | null,
) {
  const resp = await queryTxBlocks(client, 100);

  const data = resp.data ?? [];
  if (data.length === 0) return;

  const newestDigest = data[0]?.digest;
  const lastSeenDigest = getLastSeen();

  console.log('Poll batch', {
    newest: newestDigest,
    lastSeen: lastSeenDigest,
    count: data.length,
  });

  const configs = getAllConfigs();
  const configsByToken = new Map<string, ChatConfig[]>();
  for (const cfg of configs) {
    if (!configsByToken.has(cfg.tokenType)) {
      configsByToken.set(cfg.tokenType, []);
    }
    configsByToken.get(cfg.tokenType)!.push(cfg);
  }

  for (const tx of data) {
    if (lastSeenDigest && tx.digest === lastSeenDigest) {
      console.log('Reached last_seen_digest, stopping batch', { digest: tx.digest });
      break;
    }
    await processTx(bot, client, tx, configsByToken, getSuiUsdPrice);
  }

  if (newestDigest) {
    saveLastSeen(newestDigest);
  }
}

async function queryTxBlocks(client: SuiClient, limit: number, onFallback?: () => void) {
  try {
    return await client.queryTransactionBlocks({
      limit,
      order: 'descending',
      options: QUERY_OPTIONS,
    });
  } catch (err: any) {
    const message = err?.message || '';
    if (message.includes('effect is empty')) {
      if (onFallback) onFallback();
      console.warn('Primary query failed (effect is empty). Retrying without balance changes.');
      return await client.queryTransactionBlocks({
        limit,
        order: 'descending',
        options: FALLBACK_QUERY_OPTIONS,
      });
    }
    throw err;
  }
}

function findSuiSpend(changes: BalanceChange[], buyer: string): string | null {
  for (const ch of changes) {
    if (
      ch.coinType === '0x2::sui::SUI' &&
      ch.owner &&
      typeof ch.owner === 'object' &&
      'AddressOwner' in ch.owner &&
      ch.owner.AddressOwner === buyer
    ) {
      const amt = BigInt(ch.amount);
      if (amt < 0n) {
        return (-amt).toString();
      }
    }
  }
  return null;
}

async function processTx(
  bot: TelegramBot,
  client: SuiClient,
  tx: SuiTransactionBlockResponse,
  configsByToken: Map<string, ChatConfig[]>,
  getSuiUsdPrice: () => number | null,
) {
  let balanceChanges = tx.balanceChanges as BalanceChange[] | undefined;

  // If missing balance changes (e.g., fallback query or RPC omitted), refetch the tx detail.
  if (!balanceChanges || balanceChanges.length === 0) {
    try {
      const full = await client.getTransactionBlock({
        digest: tx.digest,
        options: {
          showBalanceChanges: true,
          showEffects: true,
          showInput: false,
          showEvents: false,
          showRawInput: false,
        },
      });
      balanceChanges = (full.balanceChanges as BalanceChange[]) || [];
    } catch (err) {
      console.error('Failed to refetch tx for balance changes; skipping tx', {
        digest: tx.digest,
        err,
      });
      return;
    }
  }

  if (!balanceChanges || balanceChanges.length === 0) {
    console.log('No balance changes found, skipping tx', { digest: tx.digest });
    return;
  }

  let matched = false;

  for (const change of balanceChanges) {
    const configs = configsByToken.get(change.coinType);
    if (!configs || configs.length === 0) continue;

    const owner = change.owner;
    if (!owner || typeof owner !== 'object' || !('AddressOwner' in owner)) continue;
    const amount = BigInt(change.amount);
    if (amount <= 0n) continue;

    for (const cfg of configs) {
      if (amount < BigInt(cfg.minAlertAmountRaw)) {
        console.log('Skip below min alert', {
          digest: tx.digest,
          token: change.coinType,
          amount: change.amount,
          min: cfg.minAlertAmountRaw,
          chatId: cfg.chatId,
        });
        continue;
      }
      matched = true;
      console.log('Buy detected', {
        digest: tx.digest,
        token: change.coinType,
        amount: change.amount,
        chatId: cfg.chatId,
      });
      await sendBuyAlert(
        bot,
        cfg,
        tx.digest,
        change,
        balanceChanges as BalanceChange[],
        getSuiUsdPrice,
      );
    }
  }

  if (!matched) {
    console.log(
      'Processed tx with no matching configs',
      JSON.stringify(
        {
          digest: tx.digest,
          balanceChanges: balanceChanges.length,
          changes: balanceChanges.map((bc) => ({
            coinType: bc.coinType,
            amount: bc.amount,
            owner: bc.owner,
          })),
        },
        null,
        2,
      ),
    );
  }
}

async function sendBuyAlert(
  bot: TelegramBot,
  cfg: ChatConfig,
  digest: string,
  change: BalanceChange,
  allChanges: BalanceChange[],
  getSuiUsdPrice: () => number | null,
) {
  const amountRaw = change.amount;
  const prettyAmount = formatAmountFixed(amountRaw, cfg.tokenDecimals, 2, true);
  const buyerAddress = (change.owner as { AddressOwner: string }).AddressOwner;
  const suiSpend = findSuiSpend(allChanges, buyerAddress);
  const emojiBar = computeEmojiBar(suiSpend ?? '0', cfg);
  const suiPretty = suiSpend ? formatAmountFixed(suiSpend, 9, 2, true) : 'N/A';
  const suiUsdPrice = getSuiUsdPrice();
  const usdValue =
    suiSpend && suiUsdPrice && suiUsdPrice > 0
      ? formatUsd((Number(suiSpend) / 1e9) * suiUsdPrice)
      : null;

  const tradeportUrl =
    'https://www.tradeport.xyz/sui/coins/' +
    encodeURIComponent(cfg.tokenType) +
    '?bottomTab=transactions';

  const caption =
    `🚀 <b>$${cfg.tokenSymbol} Buy</b> 🚀\n` +
    `${emojiBar}\n\n` +
    `🪙 <b>${prettyAmount} $${cfg.tokenSymbol}</b>\n` +
    `💸 Spent: <b>${suiPretty} SUI${usdValue ? ` ($${usdValue})` : ''}</b>\n\n` +
    `🧑‍🚀 Buyer: <code>${shortAddress(buyerAddress)}</code>\n` +
    `🔗 <a href="${tradeportUrl}">Trade & Transactions</a>`;

  try {
    if (cfg.headerMediaFileId) {
      if (cfg.headerMediaType === 'animation') {
        await bot.sendAnimation(cfg.chatId, cfg.headerMediaFileId, {
          caption,
          parse_mode: 'HTML',
        });
      } else {
        await bot.sendPhoto(cfg.chatId, cfg.headerMediaFileId, {
          caption,
          parse_mode: 'HTML',
        });
      }
    } else {
      await bot.sendMessage(cfg.chatId, caption, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
    }
  } catch (err) {
    console.error('Failed to send alert', {
      chatId: cfg.chatId,
      digest,
      error: err,
    });
  }
}
