import { describe, expect, it } from 'vitest';
import {
  AlreadyClaimedError,
  BeneficiaryNotFoundError,
  ConfirmationWindowExpiredError,
  DuplicateBeneficiaryError,
  DuplicateGuardianError,
  FixedAmountExceedsBalanceError,
  GuardianCooldownActiveError,
  InsufficientBalanceError,
  InvalidGuardianThresholdError,
  InvalidPercentageError,
  InvalidPeriodError,
  InvalidPreimageError,
  InvalidSplitError,
  InvalidTokenError,
  KeeperBountyExceedsMaxError,
  MergeWouldExceedLimitsError,
  NotSameOwnerError,
  OwnerCannotBeGuardianError,
  RequestTimeoutError,
  SameWillIdError,
  TooManyIdsError,
  TooManyWillsError,
  WillContractError,
  WillNotBothActiveError,
  WillNotConfirmedError,
  WillNotReleasedError,
  WillNotSettledError,
  mapContractError,
} from '../src/errors';
import { WillErrorCode } from '../src/types';

// === Representative sample of the codes added for the full 1-37 WillError enum

const SAMPLE: Array<[number, new (options?: ErrorOptions) => WillContractError, string]> = [
  [13, WillNotSettledError, 'WillNotSettledError'],
  [14, WillNotBothActiveError, 'WillNotBothActiveError'],
  [15, SameWillIdError, 'SameWillIdError'],
  [16, MergeWouldExceedLimitsError, 'MergeWouldExceedLimitsError'],
  [17, OwnerCannotBeGuardianError, 'OwnerCannotBeGuardianError'],
  [18, BeneficiaryNotFoundError, 'BeneficiaryNotFoundError'],
  [19, KeeperBountyExceedsMaxError, 'KeeperBountyExceedsMaxError'],
  [20, InvalidGuardianThresholdError, 'InvalidGuardianThresholdError'],
  [21, FixedAmountExceedsBalanceError, 'FixedAmountExceedsBalanceError'],
  [22, InvalidPercentageError, 'InvalidPercentageError'],
  [23, WillNotReleasedError, 'WillNotReleasedError'],
  [24, NotSameOwnerError, 'NotSameOwnerError'],
  [25, InvalidPeriodError, 'InvalidPeriodError'],
  [26, DuplicateGuardianError, 'DuplicateGuardianError'],
  [27, GuardianCooldownActiveError, 'GuardianCooldownActiveError'],
  [28, InvalidTokenError, 'InvalidTokenError'],
  [29, DuplicateBeneficiaryError, 'DuplicateBeneficiaryError'],
  [30, WillNotConfirmedError, 'WillNotConfirmedError'],
  [31, ConfirmationWindowExpiredError, 'ConfirmationWindowExpiredError'],
  [32, TooManyIdsError, 'TooManyIdsError'],
  [33, InsufficientBalanceError, 'InsufficientBalanceError'],
  [34, InvalidSplitError, 'InvalidSplitError'],
  [35, InvalidPreimageError, 'InvalidPreimageError'],
  [36, AlreadyClaimedError, 'AlreadyClaimedError'],
  [37, TooManyWillsError, 'TooManyWillsError'],
];

describe('mapContractError — contract error codes 13-37', () => {
  it.each(SAMPLE)('maps Error(Contract, #%i) to its typed class', (code, ErrorClass, name) => {
    const mapped = mapContractError(new Error(`Error(Contract, #${code})`));

    expect(mapped).toBeInstanceOf(ErrorClass);
    expect(mapped).toBeInstanceOf(WillContractError);
    expect((mapped as WillContractError).code).toBe(code);
    expect(mapped.name).toBe(name);
  });

  it('never falls through to a generic SoroWillError for any code in 13-37', () => {
    for (let code = 13; code <= 37; code += 1) {
      const mapped = mapContractError(new Error(`Error(Contract, #${code})`));
      expect(mapped).toBeInstanceOf(WillContractError);
      expect((mapped as WillContractError).code).toBe(code);
    }
  });

  it('keeps WillErrorCode enum values aligned with the mapped classes', () => {
    for (const [code, , name] of SAMPLE) {
      const member = name.replace(/Error$/, '');
      expect(WillErrorCode[member as keyof typeof WillErrorCode]).toBe(code);
    }
  });
});

describe('RequestTimeoutError — issue #560: request details in timeout error', () => {
  it('formats default timeout message when method is omitted', () => {
    const err = new RequestTimeoutError(5000);
    expect(err.timeoutMs).toBe(5000);
    expect(err.method).toBeUndefined();
    expect(err.message).toBe('SoroWill RPC request timed out after 5000ms');
  });

  it('includes the method name in the error message and property when provided', () => {
    const err = new RequestTimeoutError(3000, 'getWill');
    expect(err.timeoutMs).toBe(3000);
    expect(err.method).toBe('getWill');
    expect(err.message).toBe('SoroWill RPC request (getWill) timed out after 3000ms');
  });

  it('ignores blank or whitespace-only method names', () => {
    const err = new RequestTimeoutError(2500, '   ');
    expect(err.timeoutMs).toBe(2500);
    expect(err.method).toBeUndefined();
    expect(err.message).toBe('SoroWill RPC request timed out after 2500ms');
  });

  it('preserves ErrorOptions cause both with and without method name', () => {
    const cause = new Error('socket hang up');
    const withMethod = new RequestTimeoutError(4000, 'create_will', { cause });
    expect(withMethod.method).toBe('create_will');
    expect(withMethod.cause).toBe(cause);
    expect(withMethod.message).toContain('create_will');

    const withoutMethod = new RequestTimeoutError(4000, { cause });
    expect(withoutMethod.method).toBeUndefined();
    expect(withoutMethod.cause).toBe(cause);
    expect(withoutMethod.message).toBe('SoroWill RPC request timed out after 4000ms');
  });

  it('propagates the operation method name when a RequestQueue request times out', async () => {
    const { RequestQueue } = await import('../src/requestQueue');
    const queue = new RequestQueue();
    let caught: unknown;
    try {
      await queue.enqueue(() => new Promise<never>(() => undefined), 15, undefined, undefined, 'get_will');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RequestTimeoutError);
    expect((caught as RequestTimeoutError).method).toBe('get_will');
    expect((caught as RequestTimeoutError).message).toBe(
      'SoroWill RPC request (get_will) timed out after 15ms',
    );
  });
});

