import { describe, expect, it } from 'vitest';
import {
  ErrorCode,
  SoroWillError,
  UnknownContractErrorCodeError,
  WillNotFoundError,
  formatUserFriendlyError,
  mapContractError,
  sanitizeRpcError,
} from '../src/errors';

describe('Error sanitization and ErrorCode enum (#704)', () => {
  it('never exposes internal contract details such as byte offsets or HostError', () => {
    const rawError = new Error('contract state mismatch on offset 1024');
    const mapped = mapContractError(rawError);

    expect(mapped).toBeInstanceOf(SoroWillError);
    expect(mapped.message).not.toContain('offset 1024');
    expect(mapped.message).not.toContain('contract state mismatch');
    expect((mapped as SoroWillError).errorCode).toBe(ErrorCode.CONTRACT_STATE_ERROR);
    expect((mapped as SoroWillError).recoverySteps).toBeTruthy();
  });

  it('sanitizes HostError / wasm trap / ScVal / XDR errors', () => {
    const raw = new Error('HostError: Error(WasmVm, UnreachableCodeReached) at ScVal offset 42');
    const sanitized = sanitizeRpcError(raw);

    expect(sanitized.message).not.toContain('HostError');
    expect(sanitized.message).not.toContain('UnreachableCodeReached');
    expect(sanitized.message).not.toContain('ScVal');
    expect(sanitized.errorCode).toBeDefined();
    expect(sanitized.recoverySteps).toBeTruthy();
  });

  it('includes ErrorCode and recovery steps on typed contract errors', () => {
    const err = new WillNotFoundError();
    expect(err.errorCode).toBe(ErrorCode.WILL_NOT_FOUND);
    expect(err.recoverySteps).toBeTruthy();
    expect(err.message).toContain(err.recoverySteps!);
  });

  it('does not expose rawMessage in UnknownContractErrorCodeError.message', () => {
    const err = new UnknownContractErrorCodeError(999, 'internal wasm panic at C12345');
    expect(err.errorCode).toBe(ErrorCode.UNKNOWN_CONTRACT_ERROR);
    expect(err.message).not.toContain('internal wasm panic');
    expect(err.recoverySteps).toBeTruthy();
  });

  it('formats any error into a user-friendly info object with recovery steps', () => {
    const info = formatUserFriendlyError(new Error('contract state mismatch on offset 1024'));
    expect(info.errorCode).toBe(ErrorCode.CONTRACT_STATE_ERROR);
    expect(info.message).not.toContain('1024');
    expect(info.recoverySteps.length).toBeGreaterThan(0);
  });
});
