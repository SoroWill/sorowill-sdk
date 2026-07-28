import type { Beneficiary, Will } from './types';
import { WillStatus } from './types';

/** USDC (and most Soroban SEP-41 tokens) use 7 decimal places, matching classic Stellar asset precision. */
const USDC_DECIMALS = 7;
const USDC_BASE: bigint = 10n ** BigInt(USDC_DECIMALS);

/**
 * Approximate Soroban ledger close time, in milliseconds. Matches the
 * default `defaultPollIntervalMs` used internally by `SoroWillClient` for
 * event subscriptions, so consumers polling `getWill` or transaction status
 * themselves don't each have to hardcode this magic number independently.
 */
export const SOROBAN_LEDGER_CLOSE_TIME_MS = 5_000;

/**
 * Formats a base-unit token amount (e.g. contract-side `i128` stroops) as a
 * human-readable decimal string with thousands separators, e.g.
 * `formatUSDC(12345000000n) === "1,234.50"`.
 */
export function formatUSDC(stroops: bigint): string {
  const negative = stroops < 0n;
  const absolute = negative ? -stroops : stroops;
  const whole = absolute / USDC_BASE;
  const fraction = absolute % USDC_BASE;
  const cents = fraction / 10n ** BigInt(USDC_DECIMALS - 2);

  const wholeFormatted = whole.toLocaleString('en-US');
  const centsFormatted = cents.toString().padStart(2, '0');

  return `${negative ? '-' : ''}${wholeFormatted}.${centsFormatted}`;
}

/**
 * Parses a human-readable decimal USDC string (e.g. `"1234.50"` or
 * `"1,234.5"`) into base units (stroops), as a `bigint`.
 */
export function toStroops(usdc: string): bigint {
  const cleaned = usdc.replace(/,/g, '').trim();
  if (cleaned === '' || !/^-?\d*\.?\d*$/.test(cleaned) || cleaned === '-' || cleaned === '.') {
    throw new Error(`Invalid USDC amount: "${usdc}"`);
  }

  const negative = cleaned.startsWith('-');
  const unsigned = negative ? cleaned.slice(1) : cleaned;
  const [wholePart = '', fractionPart = ''] = unsigned.split('.');
  const paddedFraction = (fractionPart + '0'.repeat(USDC_DECIMALS)).slice(0, USDC_DECIMALS);

  const whole = BigInt(wholePart === '' ? '0' : wholePart);
  const fraction = BigInt(paddedFraction === '' ? '0' : paddedFraction);
  const total = whole * USDC_BASE + fraction;

  return negative ? -total : total;
}

/**
 * Returns the number of seconds until `will`'s next check-in deadline.
 * Negative values mean the deadline has already passed.
 */
export function getTimeUntilCheckin(will: Will): number {
  const deadlineMs = will.lastCheckin.getTime() + will.checkinPeriodDays * 86_400 * 1000;
  return Math.floor((deadlineMs - Date.now()) / 1000);
}

/** Returns whether `will`'s check-in deadline has already passed. */
export function isCheckinDue(will: Will): boolean {
  return getTimeUntilCheckin(will) <= 0;
}

/**
 * Splits `balance` (base units, as a decimal string) across `beneficiaries`
 * proportionally to their percentages, mirroring the on-chain distribution
 * logic exactly: integer division per beneficiary, with any rounding
 * remainder paid to the final beneficiary so the shares always sum to the
 * full balance.
 */
export function calculateShares(
  balance: string,
  beneficiaries: Beneficiary[],
): Array<{ address: string; share: string }> {
  const total = BigInt(balance);
  let remaining = total;

  return beneficiaries.map((beneficiary, index) => {
    const isLast = index === beneficiaries.length - 1;
    const share = isLast
      ? remaining
      : (total * BigInt(beneficiary.percentage)) / 100n;
    remaining -= share;
    return { address: beneficiary.address, share: share.toString() };
  });
}

/** Formats a `Date` as a human-readable string, e.g. `"Jan 5, 2027, 3:45 PM"`. */
export function formatDeadline(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

/**
 * Validates that a beneficiary list is well-formed: non-empty, every
 * percentage is positive, and percentages sum to exactly 100.
 */
export function validateBeneficiaries(beneficiaries: Beneficiary[]): boolean {
  if (beneficiaries.length === 0) {
    return false;
  }
  if (!beneficiaries.every((b) => Number.isInteger(b.percentage) && b.percentage > 0)) {
    return false;
  }
  const sum = beneficiaries.reduce((acc, b) => acc + b.percentage, 0);
  return sum === 100;
}

/**
 * Produces a compact, single-line summary of `will`, e.g.
 * `"Will #1 · Active · 1,234.50 · 2 beneficiaries · check-in due Jan 5, 2027, 3:45 PM"`.
 * Useful for debug logging, CLI output, or a list-view row.
 */
export function summarizeWill(will: Will): string {
  const parts = [
    `Will #${will.id}`,
    will.status,
    formatUSDC(BigInt(will.balance)),
    `${will.beneficiaries.length} beneficiar${will.beneficiaries.length === 1 ? 'y' : 'ies'}`,
  ];

  if (will.status === WillStatus.Active) {
    const deadlineMs = will.lastCheckin.getTime() + will.checkinPeriodDays * 86_400 * 1000;
    parts.push(`check-in due ${formatDeadline(new Date(deadlineMs))}`);
  } else if (will.triggerTime) {
    parts.push(`triggered ${formatDeadline(will.triggerTime)}`);
  }

  return parts.join(' · ');
}
