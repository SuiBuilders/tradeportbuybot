import { getDb } from './db';

export interface ChatConfig {
  chatId: number;
  tokenType: string;
  tokenSymbol: string;
  tokenDecimals: number;
  minAlertAmountRaw: string;
  emoji: string;
  emojiStepAmountRaw: string;
  maxEmojiRepeat: number;
  headerMediaFileId?: string;
  headerMediaType?: 'photo' | 'animation';
  createdByUserId: number;
  createdAt: number;
  updatedAt: number;
}

interface ChatConfigRow {
  chat_id: number;
  token_type: string;
  token_symbol: string;
  token_decimals: number;
  min_alert_amount_raw: string;
  emoji: string;
  emoji_step_amount_raw: string;
  max_emoji_repeat: number;
  header_media_file_id?: string | null;
  header_media_type?: 'photo' | 'animation' | null;
  created_by_user_id: number;
  created_at: number;
  updated_at: number;
}

const DEFAULT_CONFIG = {
  tokenType: '',
  tokenSymbol: 'TOKEN',
  tokenDecimals: 9,
  minAlertAmountRaw: '0',
  emoji: '🚀',
  emojiStepAmountRaw: '0',
  maxEmojiRepeat: 5,
} as const;

function rowToConfig(row: ChatConfigRow): ChatConfig {
  return {
    chatId: row.chat_id,
    tokenType: row.token_type,
    tokenSymbol: row.token_symbol,
    tokenDecimals: row.token_decimals,
    minAlertAmountRaw: row.min_alert_amount_raw,
    emoji: row.emoji,
    emojiStepAmountRaw: row.emoji_step_amount_raw,
    maxEmojiRepeat: row.max_emoji_repeat,
    headerMediaFileId: row.header_media_file_id ?? undefined,
    headerMediaType: row.header_media_type ?? undefined,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function configToParams(config: ChatConfig) {
  return {
    chat_id: config.chatId,
    token_type: config.tokenType,
    token_symbol: config.tokenSymbol,
    token_decimals: config.tokenDecimals,
    min_alert_amount_raw: config.minAlertAmountRaw,
    emoji: config.emoji,
    emoji_step_amount_raw: config.emojiStepAmountRaw,
    max_emoji_repeat: config.maxEmojiRepeat,
    header_media_file_id: config.headerMediaFileId ?? null,
    header_media_type: config.headerMediaType ?? null,
    created_by_user_id: config.createdByUserId,
    created_at: config.createdAt,
    updated_at: config.updatedAt,
  };
}

export function getAllConfigs(): ChatConfig[] {
  const rows = getDb()
    .prepare('SELECT * FROM chat_configs ORDER BY updated_at DESC')
    .all() as ChatConfigRow[];
  return rows.map(rowToConfig);
}

export function getConfigForChat(chatId: number): ChatConfig | null {
  const row = getDb()
    .prepare('SELECT * FROM chat_configs WHERE chat_id = ?')
    .get(chatId) as ChatConfigRow | undefined;
  return row ? rowToConfig(row) : null;
}

export function ensureConfig(chatId: number, createdByUserId: number): ChatConfig {
  const existing = getConfigForChat(chatId);
  if (existing) return existing;
  const now = Date.now();
  const cfg: ChatConfig = {
    chatId,
    tokenType: DEFAULT_CONFIG.tokenType,
    tokenSymbol: DEFAULT_CONFIG.tokenSymbol,
    tokenDecimals: DEFAULT_CONFIG.tokenDecimals,
    minAlertAmountRaw: DEFAULT_CONFIG.minAlertAmountRaw,
    emoji: DEFAULT_CONFIG.emoji,
    emojiStepAmountRaw: DEFAULT_CONFIG.emojiStepAmountRaw,
    maxEmojiRepeat: DEFAULT_CONFIG.maxEmojiRepeat,
    headerMediaFileId: undefined,
    headerMediaType: undefined,
    createdByUserId: createdByUserId,
    createdAt: now,
    updatedAt: now,
  };
  upsertConfig(cfg);
  return cfg;
}

export function upsertConfig(config: ChatConfig): void {
  const db = getDb();
  const existing = getConfigForChat(config.chatId);
  const now = Date.now();
  const prepared = db.prepare(`
    INSERT INTO chat_configs (
      chat_id,
      token_type,
      token_symbol,
      token_decimals,
      min_alert_amount_raw,
      emoji,
      emoji_step_amount_raw,
      max_emoji_repeat,
      header_media_file_id,
      header_media_type,
      created_by_user_id,
      created_at,
      updated_at
    ) VALUES (
      @chat_id,
      @token_type,
      @token_symbol,
      @token_decimals,
      @min_alert_amount_raw,
      @emoji,
      @emoji_step_amount_raw,
      @max_emoji_repeat,
      @header_media_file_id,
      @header_media_type,
      @created_by_user_id,
      @created_at,
      @updated_at
    )
    ON CONFLICT(chat_id) DO UPDATE SET
      token_type = excluded.token_type,
      token_symbol = excluded.token_symbol,
      token_decimals = excluded.token_decimals,
      min_alert_amount_raw = excluded.min_alert_amount_raw,
      emoji = excluded.emoji,
      emoji_step_amount_raw = excluded.emoji_step_amount_raw,
      max_emoji_repeat = excluded.max_emoji_repeat,
      header_media_file_id = excluded.header_media_file_id,
      header_media_type = excluded.header_media_type,
      updated_at = excluded.updated_at
  `);

  const params = configToParams({
    ...config,
    createdAt: existing?.createdAt ?? config.createdAt ?? now,
    createdByUserId: existing?.createdByUserId ?? config.createdByUserId,
    updatedAt: now,
  });

  prepared.run(params);
}

export function deleteConfig(chatId: number): void {
  getDb().prepare('DELETE FROM chat_configs WHERE chat_id = ?').run(chatId);
}

export function getMeta(key: string): string | null {
  const row = getDb()
    .prepare('SELECT value FROM meta WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  getDb()
    .prepare(
      `
        INSERT INTO meta (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `,
    )
    .run(key, value);
}
