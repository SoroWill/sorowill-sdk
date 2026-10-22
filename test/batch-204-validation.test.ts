/**
 * Tests for batch-204 validation improvements (#621-624)
 */

import { describe, it, expect } from 'vitest';
import {
  validateWillId,
  validateSequenceNumber,
  validateAccountAddress,
  validateRpcResponseEnvelope,
  validateSignatureCollectionOptions,
  type RpcResponseEnvelope,
} from '../src/validation';

describe('Batch-204: Validation improvements', () => {
  describe('#623: Will ID validation', () => {
    it('accepts valid will ID', () => {
      expect(() => validateWillId('will-123')).not.toThrow();
      expect(() => validateWillId('abc')).not.toThrow();
    });

    it('rejects empty string', () => {
      expect(() => validateWillId('')).toThrow(/Invalid will ID/);
      expect(() => validateWillId('   ')).toThrow(/Invalid will ID/);
    });

    it('rejects non-string types', () => {
      expect(() => validateWillId(null)).toThrow(/Invalid will ID/);
      expect(() => validateWillId(undefined)).toThrow(/Invalid will ID/);
      expect(() => validateWillId(123)).toThrow(/Invalid will ID/);
      expect(() => validateWillId({ id: 'will' })).toThrow(/Invalid will ID/);
    });
  });

  describe('#624: Sequence number validation', () => {
    it('accepts valid sequence numbers', () => {
      expect(() => validateSequenceNumber(0)).not.toThrow();
      expect(() => validateSequenceNumber(1)).not.toThrow();
      expect(() => validateSequenceNumber(999999)).not.toThrow();
    });

    it('rejects negative numbers', () => {
      expect(() => validateSequenceNumber(-1)).toThrow(/Invalid sequence number/);
      expect(() => validateSequenceNumber(-999)).toThrow(/Invalid sequence number/);
    });

    it('rejects non-integer numbers', () => {
      expect(() => validateSequenceNumber(1.5)).toThrow(/Invalid sequence number/);
      expect(() => validateSequenceNumber(Infinity)).toThrow(/Invalid sequence number/);
      expect(() => validateSequenceNumber(NaN)).toThrow(/Invalid sequence number/);
    });

    it('rejects non-numeric types', () => {
      expect(() => validateSequenceNumber('123')).toThrow(/Invalid sequence number/);
      expect(() => validateSequenceNumber(null)).toThrow(/Invalid sequence number/);
      expect(() => validateSequenceNumber(undefined)).toThrow(/Invalid sequence number/);
    });
  });

  describe('#622: RPC response envelope validation', () => {
    it('accepts valid success response', () => {
      const response: RpcResponseEnvelope = {
        jsonrpc: '2.0',
        id: '1',
        result: { status: 'SUCCESS' },
      };
      expect(() => validateRpcResponseEnvelope(response)).not.toThrow();
    });

    it('accepts valid error response', () => {
      const response: RpcResponseEnvelope = {
        jsonrpc: '2.0',
        id: '1',
        error: {
          code: -32600,
          message: 'Invalid Request',
        },
      };
      expect(() => validateRpcResponseEnvelope(response)).not.toThrow();
    });

    it('rejects non-object response', () => {
      expect(() => validateRpcResponseEnvelope('not an object')).toThrow(
        /Invalid RPC response envelope/,
      );
      expect(() => validateRpcResponseEnvelope(null)).toThrow(
        /Invalid RPC response envelope/,
      );
    });

    it('rejects missing jsonrpc field', () => {
      const response = { result: {} };
      expect(() => validateRpcResponseEnvelope(response)).toThrow(/jsonrpc/);
    });

    it('rejects invalid jsonrpc version', () => {
      const response = { jsonrpc: '1.0', result: {} };
      expect(() => validateRpcResponseEnvelope(response)).toThrow(/jsonrpc version/);
    });

    it('rejects response without result or error', () => {
      const response = { jsonrpc: '2.0' };
      expect(() => validateRpcResponseEnvelope(response)).toThrow(
        /must contain either 'result' or 'error'/,
      );
    });

    it('rejects response with both result and error', () => {
      const response = {
        jsonrpc: '2.0',
        result: {},
        error: { code: -1, message: 'error' },
      };
      expect(() => validateRpcResponseEnvelope(response)).toThrow(
        /must not contain both/,
      );
    });

    it('validates error structure', () => {
      const invalidError = {
        jsonrpc: '2.0',
        error: { code: 'not-a-number', message: 'error' },
      };
      expect(() => validateRpcResponseEnvelope(invalidError)).toThrow(/error.code/);

      const invalidMessage = {
        jsonrpc: '2.0',
        error: { code: -32600, message: 123 },
      };
      expect(() => validateRpcResponseEnvelope(invalidMessage)).toThrow(
        /error.message/,
      );
    });
  });

  describe('#621: Signature collection options validation', () => {
    it('accepts valid options', () => {
      const options = validateSignatureCollectionOptions({
        timeoutMs: 5000,
        minSignatures: 2,
        maxSignatures: 5,
      });
      expect(options.timeoutMs).toBe(5000);
      expect(options.minSignatures).toBe(2);
      expect(options.maxSignatures).toBe(5);
    });

    it('applies defaults', () => {
      const options = validateSignatureCollectionOptions();
      expect(options.timeoutMs).toBe(120_000);
      expect(options.minSignatures).toBe(1);
      expect(options.maxSignatures).toBe(Infinity);
    });

    it('rejects invalid timeout', () => {
      expect(() =>
        validateSignatureCollectionOptions({ timeoutMs: -100 }),
      ).toThrow(/timeoutMs/);

      expect(() =>
        validateSignatureCollectionOptions({ timeoutMs: 0 }),
      ).toThrow(/timeoutMs/);

      expect(() =>
        validateSignatureCollectionOptions({ timeoutMs: Infinity }),
      ).toThrow(/timeoutMs/);
    });

    it('rejects invalid minSignatures', () => {
      expect(() =>
        validateSignatureCollectionOptions({ minSignatures: 0 }),
      ).toThrow(/minSignatures/);

      expect(() =>
        validateSignatureCollectionOptions({ minSignatures: -1 }),
      ).toThrow(/minSignatures/);

      expect(() =>
        validateSignatureCollectionOptions({ minSignatures: 1.5 }),
      ).toThrow(/minSignatures/);
    });

    it('rejects when maxSignatures < minSignatures', () => {
      expect(() =>
        validateSignatureCollectionOptions({
          minSignatures: 5,
          maxSignatures: 2,
        }),
      ).toThrow(/maxSignatures/);
    });

    it('converts timeout to integer', () => {
      const options = validateSignatureCollectionOptions({ timeoutMs: 1234.567 });
      expect(options.timeoutMs).toBe(1234);
      expect(Number.isInteger(options.timeoutMs)).toBe(true);
    });
  });

  describe('#624: Account address validation', () => {
    it('accepts valid Stellar public key', () => {
      const validKey = 'GDZST3XVCDTUJ76ZAV2HA72KYCK5ZBDJDWM7GJ5G2MR5GTKWF3CXYC7';
      expect(() => validateAccountAddress(validKey)).not.toThrow();
    });

    it('rejects invalid Stellar key format', () => {
      expect(() => validateAccountAddress('INVALID')).toThrow(
        /Invalid account address/,
      );
      expect(() => validateAccountAddress('not-a-key')).toThrow(
        /Invalid account address/,
      );
    });

    it('rejects non-string types', () => {
      expect(() => validateAccountAddress(null)).toThrow(
        /Invalid account address/,
      );
      expect(() => validateAccountAddress(123)).toThrow(
        /Invalid account address/,
      );
    });
  });
});
