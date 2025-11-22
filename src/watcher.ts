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

const PAGE_LIMIT = 50;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 300;

export function startWatcher(
  bot: TelegramBot,
  rpcUrl: string,
  pollIntervalMs: number,
  getSuiUsdPrice: () => number | null,
  backupRpcUrl?: string | null,
) {
  const client = new SuiClient({ url: rpcUrl });
  const backupClient = backupRpcUrl ? new SuiClient({ url: backupRpcUrl }) : null;
  let lastSeenDigest = getMeta('last_seen_digest');
  let isPolling = false;
  let effectErrorLogged = false;

  const seedLastSeen = async () => {
    if (lastSeenDigest) return;
    try {
      const resp = await client.queryTransactionBlocks({
        limit: 1,
        order: 'descending',
        options: QUERY_OPTIONS,
      });
      const newest = resp.data?.[0];
      if (newest?.digest) {
        lastSeenDigest = newest.digest;
        setMeta('last_seen_digest', newest.digest);
        console.log('Seeded last_seen_digest to latest tip', newest.digest);
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
        backupClient,
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
  backupClient?: SuiClient | null,
) {
  let cursor = getLastSeen();
  const configs = getAllConfigs();
  const configsByToken = new Map<string, ChatConfig[]>();
  for (const cfg of configs) {
    if (!configsByToken.has(cfg.tokenType)) {
      configsByToken.set(cfg.tokenType, []);
    }
    configsByToken.get(cfg.tokenType)!.push(cfg);
  }

  while (true) {
    const resp = await queryTxBlocks(client, PAGE_LIMIT, cursor, 'ascending');
    const data = resp.data ?? [];
    if (data.length === 0) break;

    console.log('Poll batch', {
      newest: data[0]?.digest,
      lastSeen: cursor,
      count: data.length,
    });

    for (const tx of data) {
      try {
        const processed = await processTx(
          bot,
          client,
          backupClient,
          tx,
          configsByToken,
          getSuiUsdPrice,
        );
        if (processed) {
          cursor = tx.digest;
          saveLastSeen(cursor);
        } else {
          console.warn('Did not process tx; will retry next poll', { digest: tx.digest });
          return;
        }
      } catch (err) {
        console.error('Failed to process tx; will retry next poll', { digest: tx.digest, err });
        return;
      }
    }

    if (!resp.hasNextPage) break;
  }
}

async function queryTxBlocks(
  client: SuiClient,
  limit: number,
  cursor?: string | null,
  order: 'ascending' | 'descending' = 'descending',
  onFallback?: () => void,
) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await client.queryTransactionBlocks({
        limit,
        order,
        cursor: cursor ?? undefined,
        options: QUERY_OPTIONS,
      });
    } catch (err: any) {
      const message = err?.message || '';
      const status = err?.status ?? err?.code;
      if (message.includes('effect is empty')) {
        if (onFallback) onFallback();
        console.warn('Primary query failed (effect is empty). Retrying without balance changes.');
        return await client.queryTransactionBlocks({
          limit,
          order,
          cursor: cursor ?? undefined,
          options: FALLBACK_QUERY_OPTIONS,
        });
      }
      if (status === 429 && attempt < MAX_RETRIES - 1) {
        await sleep(RETRY_DELAY_MS * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Failed to queryTransactionBlocks after retries');
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchTxWithRetries(
  client: SuiClient,
  digest: string,
  maxRetries = 3,
  delayMs = 300,
): Promise<SuiTransactionBlockResponse | null> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await client.getTransactionBlock({
        digest,
        options: {
          showBalanceChanges: true,
          showEffects: true,
          showInput: false,
          showEvents: false,
          showRawInput: false,
        },
      });
    } catch (err: any) {
      const status = err?.status ?? err?.code;
      if (status === 429 && attempt < maxRetries - 1) {
        await sleep(delayMs * (attempt + 1));
        continue;
      }
      console.error('Failed to fetch tx details', { digest, err });
      return null;
    }
  }
  return null;
}

async function processTx(
  bot: TelegramBot,
  client: SuiClient,
  backupClient: SuiClient | null | undefined,
  tx: SuiTransactionBlockResponse,
  configsByToken: Map<string, ChatConfig[]>,
  getSuiUsdPrice: () => number | null,
): Promise<boolean> {
  // Prefer in-page balanceChanges; refetch only if needed.
  let balanceChanges = (tx.balanceChanges as BalanceChange[]) || [];
  let hasTrackedToken = balanceChanges.some((bc) => configsByToken.has(bc.coinType));

  if (!hasTrackedToken || balanceChanges.length === 0) {
    const full = await fetchTxWithRetries(client, tx.digest);
    balanceChanges = (full?.balanceChanges as BalanceChange[]) || [];
    hasTrackedToken = balanceChanges.some((bc) => configsByToken.has(bc.coinType));
  }

  if ((!hasTrackedToken || balanceChanges.length === 0) && backupClient) {
    const fullBackup = await fetchTxWithRetries(backupClient, tx.digest);
    balanceChanges = (fullBackup?.balanceChanges as BalanceChange[]) || [];
    hasTrackedToken = balanceChanges.some((bc) => configsByToken.has(bc.coinType));
  }

  if (!balanceChanges || balanceChanges.length === 0) {
    console.log('No balance changes found, skipping tx', { digest: tx.digest });
    return false;
  }

  let matched = false;
  let hadTokenMatch = balanceChanges.some((bc) => configsByToken.has(bc.coinType));

  // If no tracked token in primary changes, try backup once.
  if (!hadTokenMatch && backupClient) {
    try {
      const full = await backupClient.getTransactionBlock({
        digest: tx.digest,
        options: {
          showBalanceChanges: true,
          showEffects: true,
          showInput: false,
          showEvents: false,
          showRawInput: false,
        },
      });
      const bc2 = (full.balanceChanges as BalanceChange[]) || [];
      if (bc2.length > 0) {
        balanceChanges = bc2;
        hadTokenMatch = bc2.some((bc) => configsByToken.has(bc.coinType));
      }
    } catch (err) {
      console.error('Backup refetch failed while searching for token match', {
        digest: tx.digest,
        err,
      });
    }
  }

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

  return true;
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
