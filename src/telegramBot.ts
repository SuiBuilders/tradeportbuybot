import TelegramBot, { CallbackQuery, Message } from 'node-telegram-bot-api';
import {
  ChatConfig,
  ensureConfig,
  getConfigForChat,
  upsertConfig,
} from './configStore';
import { decimalToRaw, formatAmount } from './utils';

type PendingAction =
  | { type: 'setToken' }
  | { type: 'setSymbolDecimals'; stage: 'symbol' | 'decimals'; symbol?: string }
  | { type: 'setMinAlert' }
  | { type: 'setEmoji'; stage: 'emoji' | 'step' | 'max'; emoji?: string; stepRaw?: string }
  | { type: 'setHeaderMedia' };

interface TargetGroupInfo {
  chatId: number;
  chatTitle?: string;
}

const adminTargets = new Map<number, TargetGroupInfo>();
const pendingActions = new Map<number, PendingAction>();

export function startTelegramBot(token: string): TelegramBot {
  const bot = new TelegramBot(token, { polling: true });

  const startCmd = /^\/starttpbuybot(?:@\w+)?/i;
  const chatIdCmd = /^\/chatid(?:@\w+)?/i;

  bot.on('message', async (msg) => {
    const rawText = msg.text || '';
    const commandEntity = msg.entities?.find((e) => e.type === 'bot_command');
    const commandText =
      commandEntity && rawText
        ? rawText.slice(commandEntity.offset, commandEntity.offset + commandEntity.length)
        : null;

    const matchesStart =
      (commandText && /^\/starttpbuybot(?:@\w+)?$/i.test(commandText.trim())) ||
      startCmd.test(rawText);

    if (matchesStart) {
      if (msg.chat.type === 'private') {
        await handlePrivateStart(bot, msg);
      } else {
        await handleGroupStart(bot, msg);
      }
      return; // do not process further
    }

    const matchesChatId =
      (commandText && /^\/chatid(?:@\w+)?$/i.test(commandText.trim())) ||
      chatIdCmd.test(rawText);
    if (matchesChatId) {
      await bot.sendMessage(
        msg.chat.id,
        `Chat id: <code>${msg.chat.id}</code>`,
        { parse_mode: 'HTML' },
      );
      return;
    }

    if (msg.chat.type === 'private') {
      await handlePrivateMessage(bot, msg);
    }
  });

  bot.on('callback_query', async (query) => {
    await handleCallback(bot, query);
  });

  bot.on('polling_error', (err) => {
    console.error('Telegram polling error:', err);
  });

  return bot;
}

async function handleGroupStart(bot: TelegramBot, msg: Message) {
  if (!msg.from) return;
  const userId = msg.from.id;

  const isAdmin = await verifyAdmin(bot, msg.chat.id, userId);
  if (!isAdmin) {
    await bot.sendMessage(msg.chat.id, 'Only group admins can configure this buy bot.');
    return;
  }

  console.log('Start command received in group', {
    chatId: msg.chat.id,
    chatTitle: msg.chat.title,
    fromId: userId,
    fromName: `${msg.from.first_name ?? ''} ${msg.from.last_name ?? ''}`.trim(),
  });

  adminTargets.set(userId, { chatId: msg.chat.id, chatTitle: msg.chat.title ?? undefined });
  pendingActions.delete(userId);
  ensureConfig(msg.chat.id, userId);

  await bot.sendMessage(
    msg.chat.id,
    'I’ll DM you to configure the buy bot for this chat. Please open our private chat.',
  );

  const title = msg.chat.title ?? `chat ${msg.chat.id}`;
  await bot.sendMessage(
    userId,
    `Hi! Let’s configure the buy bot for ${title}. Tap the buttons below to set things up.`,
    { reply_markup: mainMenuKeyboard(getConfigForChat(msg.chat.id) ?? undefined) },
  );
}

async function handlePrivateStart(bot: TelegramBot, msg: Message) {
  if (!msg.from) return;
  const userId = msg.from.id;
  const text = msg.text ?? '';

  // Allow manual linking by providing chat id: /starttpbuybot <chatId>. If none, bind to this DM.
  const parts = text.trim().split(/\s+/);
  const chatIdArg = parts.length > 1 ? Number(parts[1]) : null;

  if (chatIdArg && Number.isFinite(chatIdArg)) {
    const chatId = Number(chatIdArg);
    if (chatId > 0) {
      // Private chat binding: allow if it matches the requester or current DM chat.
      if (chatId !== userId && chatId !== msg.chat.id) {
        await bot.sendMessage(
          userId,
          'Positive IDs are private chats. To link this DM, just send /starttpbuybot without extra text. For groups, use a negative chat id (run /chatid in the group).',
        );
        return;
      }

      adminTargets.set(userId, { chatId, chatTitle: msg.chat.first_name });
      pendingActions.delete(userId);
      ensureConfig(chatId, userId);
      await bot.sendMessage(
        userId,
        'Linked to this private chat. Use the buttons to configure.',
        { reply_markup: mainMenuKeyboard(getConfigForChat(chatId) ?? undefined) },
      );
      return;
    }

    const isAdmin = await verifyAdmin(bot, chatId, userId);
    if (!isAdmin) {
      await bot.sendMessage(
        userId,
        `Could not verify you as an admin of chat ${chatId}. Make sure the bot is in that group and you are an admin.`,
      );
      return;
    }

    adminTargets.set(userId, { chatId, chatTitle: undefined });
    pendingActions.delete(userId);
    ensureConfig(chatId, userId);

    await bot.sendMessage(
      userId,
      `Linked to chat ${chatId}. Use the buttons to configure.`,
      { reply_markup: mainMenuKeyboard(getConfigForChat(chatId) ?? undefined) },
    );
    return;
  }

  // No arg: bind to this private chat directly.
  adminTargets.set(userId, { chatId: msg.chat.id, chatTitle: msg.chat.first_name });
  pendingActions.delete(userId);
  ensureConfig(msg.chat.id, userId);
  await bot.sendMessage(
    userId,
    'Linked to this private chat. Use the buttons to configure.',
    { reply_markup: mainMenuKeyboard(getConfigForChat(msg.chat.id) ?? undefined) },
  );
}

async function verifyAdmin(bot: TelegramBot, chatId: number, userId: number): Promise<boolean> {
  if (chatId > 0) return true; // private chat binding
  try {
    const member = await bot.getChatMember(chatId, userId);
    return member.status === 'administrator' || member.status === 'creator';
  } catch (err) {
    console.error('Failed to verify admin', {
      chatId,
      userId,
      error: err,
    });
    return false;
  }
}

function mainMenuKeyboard(cfg?: ChatConfig | null) {
  const tokenDone = !!cfg?.tokenType;
  const minDone = cfg ? cfg.minAlertAmountRaw !== undefined : false; // allow 0 as configured
  const emojiDone = cfg ? BigInt(cfg.emojiStepAmountRaw || '0') > 0n : false;
  const headerDone = !!cfg?.headerMediaFileId;
  const check = (done: boolean) => (done ? '✅' : '⚪️');

  return {
    inline_keyboard: [
      [{ text: `${check(tokenDone)} 🪙 Set token`, callback_data: 'menu_set_token' }],
      [
        { text: `${check(minDone)} 📏 Set min alert size`, callback_data: 'menu_set_min_alert' },
        { text: `${check(emojiDone)} 😊 Set emoji tiers`, callback_data: 'menu_set_emoji' },
      ],
      [
        { text: `${check(headerDone)} 🖼 Set header media`, callback_data: 'menu_set_header' },
        { text: '👀 View current config', callback_data: 'menu_view_config' },
      ],
      [{ text: '✅ Finish', callback_data: 'menu_finish' }],
    ],
  };
}

async function handleCallback(bot: TelegramBot, query: CallbackQuery) {
  const userId = query.from.id;
  const data = query.data;
  if (!data) return;

  if (query.message?.chat.type !== 'private') {
    await bot.answerCallbackQuery(query.id);
    return;
  }

  const target = adminTargets.get(userId);
  if (!target) {
    await bot.answerCallbackQuery(query.id);
    await bot.sendMessage(
      userId,
      'I need to know which group you want to configure. Run /startTPbuybot in that group first.',
    );
    return;
  }

  const stillAdmin = target.chatId > 0 ? true : await verifyAdmin(bot, target.chatId, userId);
  if (!stillAdmin) {
    adminTargets.delete(userId);
    pendingActions.delete(userId);
    await bot.answerCallbackQuery(query.id);
    await bot.sendMessage(
      userId,
      'You must be a group admin to configure this bot. Please regain admin rights and start again.',
    );
    return;
  }

  pendingActions.delete(userId);

  const cfg = getConfigForChat(target.chatId);

  switch (data) {
    case 'menu_set_token':
      pendingActions.set(userId, { type: 'setToken' });
      await bot.sendMessage(
        userId,
        'Paste the full Sui coin type for your token, e.g. 0x...::xp::XP',
      );
      break;
    case 'menu_set_min_alert':
      pendingActions.set(userId, { type: 'setMinAlert' });
      await bot.sendMessage(
        userId,
        'What minimum buy size (in tokens) should trigger an alert? (e.g. 1.5)',
      );
      break;
    case 'menu_set_emoji':
      pendingActions.set(userId, { type: 'setEmoji', stage: 'emoji' });
      await bot.sendMessage(
        userId,
        'Send the base emoji for buy alerts (e.g. 🩸 or 🚀).',
      );
      break;
    case 'menu_set_header':
      pendingActions.set(userId, { type: 'setHeaderMedia' });
      await bot.sendMessage(userId, 'Send me a photo or GIF to use as the header for buy alerts.');
      break;
    case 'menu_view_config':
      await sendConfigSummary(bot, userId, target);
      break;
    case 'menu_finish':
      await bot.sendMessage(
        userId,
        `Configuration saved. I’ll now send buy alerts to ${target.chatTitle ?? `chat ${target.chatId}`} whenever someone buys your token.`,
        { reply_markup: mainMenuKeyboard(cfg) },
      );
      break;
    default:
      await bot.sendMessage(userId, 'Choose an option from the menu.', {
        reply_markup: mainMenuKeyboard(cfg),
      });
  }

  await bot.answerCallbackQuery(query.id);
}

async function handlePrivateMessage(bot: TelegramBot, msg: Message) {
  if (msg.chat.type !== 'private' || !msg.from) return;

  const userId = msg.from.id;
  const target = adminTargets.get(userId);
  const pending = pendingActions.get(userId);

  if (!target) {
    if (msg.text) {
      await bot.sendMessage(
        userId,
        'No chat linked yet. Send /starttpbuybot here to configure this DM, or /starttpbuybot <chat_id> for a group (use /chatid in the group to fetch the id).',
      );
    }
    return;
  }

  const stillAdmin = target.chatId > 0 ? true : await verifyAdmin(bot, target.chatId, userId);
  const cfg = getConfigForChat(target.chatId);
  if (!stillAdmin) {
    adminTargets.delete(userId);
    pendingActions.delete(userId);
    await bot.sendMessage(
      userId,
      'You must be a group admin to configure this bot. Please regain admin rights and start again.',
    );
    return;
  }

  if (!pending) {
    if (msg.text && (/^\/starttpbuybot(?:@\w+)?\b/i.test(msg.text) || msg.text === '/start')) {
      await bot.sendMessage(
        userId,
        `Editing settings for ${target.chatTitle ?? `chat ${target.chatId}`}. Use the buttons to change values.`,
        { reply_markup: mainMenuKeyboard(cfg) },
      );
    }
    return;
  }

  switch (pending.type) {
    case 'setToken':
      await handleSetToken(bot, msg, target);
      break;
    case 'setSymbolDecimals':
      await handleSetSymbolDecimals(bot, msg, target, pending);
      break;
    case 'setMinAlert':
      await handleSetMinAlert(bot, msg, target);
      break;
    case 'setEmoji':
      await handleSetEmoji(bot, msg, target, pending);
      break;
    case 'setHeaderMedia':
      await handleSetHeader(bot, msg, target);
      break;
    default:
      pendingActions.delete(userId);
      await bot.sendMessage(userId, 'Use the menu buttons to configure settings.', {
        reply_markup: mainMenuKeyboard(cfg),
      });
  }
}

async function handleSetToken(bot: TelegramBot, msg: Message, target: TargetGroupInfo) {
  const userId = msg.from!.id;
  const text = msg.text?.trim();
  if (!text) {
    await bot.sendMessage(userId, 'Please send the full Sui coin type, like 0x...::module::Token');
    return;
  }

  const valid = /^0x[a-fA-F0-9]+::[A-Za-z0-9_]+::[A-Za-z0-9_]+$/.test(text);
  if (!valid) {
    await bot.sendMessage(
      userId,
      'That does not look like a valid coin type. Use the format 0x...::module::TokenName',
    );
    return;
  }

  const parts = text.split('::');
  const symbol = (parts[2] ?? 'TOKEN').toUpperCase();
  const cfg = ensureConfig(target.chatId, userId);
  upsertConfig({
    ...cfg,
    tokenType: text,
    tokenSymbol: symbol,
    tokenDecimals: 9,
    updatedAt: Date.now(),
  });
  const updatedCfg = getConfigForChat(target.chatId);
  pendingActions.delete(userId);
  await bot.sendMessage(
    userId,
    `Token type saved. Symbol set to ${symbol}, decimals fixed to 9.`,
    { reply_markup: mainMenuKeyboard(updatedCfg) },
  );
}

async function handleSetSymbolDecimals(
  bot: TelegramBot,
  msg: Message,
  target: TargetGroupInfo,
  pending: PendingAction & { type: 'setSymbolDecimals' },
) {
  const userId = msg.from!.id;
  if (pending.stage === 'symbol') {
    const symbol = msg.text?.trim();
    if (!symbol) {
      await bot.sendMessage(userId, 'Please send the token symbol (e.g. XP).');
      return;
    }
    pendingActions.set(userId, { type: 'setSymbolDecimals', stage: 'decimals', symbol });
    await bot.sendMessage(userId, 'Now send the token decimals (integer, default 9 if blank or /skip).');
    return;
  }

  const decimalsText = msg.text?.trim();
  let decimals = 9;
  if (decimalsText && decimalsText !== '/skip') {
    const parsed = Number.parseInt(decimalsText, 10);
    if (Number.isNaN(parsed) || parsed < 0 || parsed > 18) {
      await bot.sendMessage(userId, 'Decimals should be an integer between 0 and 18. Try again.');
      return;
    }
    decimals = parsed;
  }

  const symbol = pending.symbol?.toUpperCase() ?? 'TOKEN';
  const cfg = ensureConfig(target.chatId, userId);
  upsertConfig({
    ...cfg,
    tokenSymbol: symbol,
    tokenDecimals: decimals,
    updatedAt: Date.now(),
  });
  const updatedCfg = getConfigForChat(target.chatId);
  pendingActions.delete(userId);
  await bot.sendMessage(userId, `Symbol set to ${symbol} with ${decimals} decimals.`, {
    reply_markup: mainMenuKeyboard(updatedCfg),
  });
}

async function handleSetMinAlert(bot: TelegramBot, msg: Message, target: TargetGroupInfo) {
  const userId = msg.from!.id;
  const text = msg.text?.trim();
  if (!text) {
    await bot.sendMessage(userId, 'Please send a number (decimals allowed).');
    return;
  }

  const cfg = ensureConfig(target.chatId, userId);
  try {
    const raw = decimalToRaw(text, cfg.tokenDecimals);
    upsertConfig({
      ...cfg,
      minAlertAmountRaw: raw,
      updatedAt: Date.now(),
    });
    const updatedCfg = getConfigForChat(target.chatId);
    pendingActions.delete(userId);
    await bot.sendMessage(
      userId,
      `Min alert size set to ${formatAmount(raw, cfg.tokenDecimals, 6)} ${cfg.tokenSymbol}.`,
      { reply_markup: mainMenuKeyboard(updatedCfg) },
    );
  } catch (err) {
    await bot.sendMessage(userId, 'Could not parse that number. Please try again (e.g. 1.5).');
  }
}

async function handleSetEmoji(
  bot: TelegramBot,
  msg: Message,
  target: TargetGroupInfo,
  pending: PendingAction & { type: 'setEmoji' },
) {
  const userId = msg.from!.id;
  const text = msg.text?.trim();
  if (!text) {
    await bot.sendMessage(userId, 'Please send a value.');
    return;
  }

  const cfg = ensureConfig(target.chatId, userId);

  if (pending.stage === 'emoji') {
    pendingActions.set(userId, { type: 'setEmoji', stage: 'step', emoji: text });
    await bot.sendMessage(
      userId,
      'Every how many SUI spent should I add another emoji? Send a number (decimals allowed).',
    );
    return;
  }

  if (pending.stage === 'step') {
    try {
      const raw = decimalToRaw(text, 9); // SUI decimals fixed to 9
      upsertConfig({
        ...cfg,
        emoji: pending.emoji ?? cfg.emoji,
        emojiStepAmountRaw: raw,
        updatedAt: Date.now(),
      });
      const updatedCfg = getConfigForChat(target.chatId);
      pendingActions.delete(userId);
      await bot.sendMessage(
        userId,
        `Emoji tier set to ${pending.emoji ?? cfg.emoji} every ${formatAmount(raw, 9, 4)} SUI.`,
        { reply_markup: mainMenuKeyboard(updatedCfg) },
      );
      return;
    } catch (err) {
      await bot.sendMessage(userId, 'Could not parse that number. Try again (e.g. 5).');
      return;
    }
  }
}

async function handleSetHeader(bot: TelegramBot, msg: Message, target: TargetGroupInfo) {
  const userId = msg.from!.id;
  const cfg = ensureConfig(target.chatId, userId);

  if (msg.animation) {
    const fileId = msg.animation.file_id;
    upsertConfig({
      ...cfg,
      headerMediaFileId: fileId,
      headerMediaType: 'animation',
      updatedAt: Date.now(),
    });
    const updatedCfg = getConfigForChat(target.chatId);
    pendingActions.delete(userId);
    await bot.sendMessage(userId, 'Header media saved (GIF).', {
      reply_markup: mainMenuKeyboard(updatedCfg),
    });
    return;
  }

  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1];
    upsertConfig({
      ...cfg,
      headerMediaFileId: largest.file_id,
      headerMediaType: 'photo',
      updatedAt: Date.now(),
    });
    const updatedCfg = getConfigForChat(target.chatId);
    pendingActions.delete(userId);
    await bot.sendMessage(userId, 'Header media saved (photo).', {
      reply_markup: mainMenuKeyboard(updatedCfg),
    });
    return;
  }

  await bot.sendMessage(userId, 'Please send a photo or GIF to use as the header.');
}

async function sendConfigSummary(
  bot: TelegramBot,
  userId: number,
  target: TargetGroupInfo,
): Promise<void> {
  const cfg = getConfigForChat(target.chatId);
  if (!cfg) {
    await bot.sendMessage(userId, 'No config found yet for this chat. Set a token to get started.');
    return;
  }

  const summaryLines = [
    `Chat: ${target.chatTitle ?? target.chatId}`,
    `Token: ${cfg.tokenType || 'Not set'}`,
    `Symbol: ${cfg.tokenSymbol} (decimals: 9)`,
    `Min alert: ${formatAmount(cfg.minAlertAmountRaw, cfg.tokenDecimals, 6)} ${cfg.tokenSymbol}`,
    `Emoji: ${cfg.emoji}, step: ${formatAmount(cfg.emojiStepAmountRaw, 9, 6)} SUI`,
    `Header media: ${cfg.headerMediaFileId ? `set (${cfg.headerMediaType ?? 'photo'})` : 'not set'}`,
  ];

  await bot.sendMessage(userId, summaryLines.join('\n'), {
    reply_markup: mainMenuKeyboard(cfg),
  });
}
