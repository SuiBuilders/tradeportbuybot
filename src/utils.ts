import { ChatConfig } from './configStore';

export function formatAmount(raw: string, decimals: number, maxFrac = 4): string {
  const bi = BigInt(raw);
  const base = BigInt(10) ** BigInt(decimals);
  const whole = bi / base;
  const frac = bi % base;
  if (frac === 0n) return whole.toString();

  const fracStr = frac.toString().padStart(Number(decimals), '0').slice(0, maxFrac);
  return `${whole.toString()}.${fracStr}`.replace(/\.$/, '');
}

export function decimalToRaw(input: string, decimals: number): string {
  const trimmed = input.trim();
  const match = trimmed.match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) {
    throw new Error('Invalid number format');
  }

  const whole = match[1];
  const frac = match[2] ?? '';
  const paddedFrac = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const raw = BigInt(whole + paddedFrac);
  return raw.toString();
}

export function shortAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function computeEmojiBar(rawAmount: string, cfg: ChatConfig): string {
  const amount = BigInt(rawAmount);
  const step = BigInt(cfg.emojiStepAmountRaw);
  if (step <= 0n) return cfg.emoji;
  const repeats = Number(amount / step) + 1; // no max cap per user request
  return cfg.emoji.repeat(Math.max(1, repeats));
}

export function formatAmountFixed(
  raw: string,
  decimals: number,
  fractionDigits = 2,
  useGrouping = true,
): string {
  const bi = BigInt(raw);
  const base = BigInt(10) ** BigInt(decimals);
  const whole = bi / base;
  const frac = bi % base;
  const fracStr = frac.toString().padStart(decimals, '0').slice(0, fractionDigits);
  const wholeStr = useGrouping ? withGrouping(whole.toString()) : whole.toString();
  return `${wholeStr}.${fracStr.padEnd(fractionDigits, '0')}`;
}

export function formatUsd(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function withGrouping(numStr: string): string {
  const neg = numStr.startsWith('-');
  const s = neg ? numStr.slice(1) : numStr;
  const grouped = s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return neg ? `-${grouped}` : grouped;
}
