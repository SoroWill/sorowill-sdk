import { describe, expect, it } from 'vitest';

import { buildSep7TxUri, parseSep7Callback, type Sep7CallbackResult } from '../src/sep7';

describe('buildSep7TxUri', () => {
  it('builds URI with required fields only', () => {
    const result = buildSep7TxUri('AAAAAAAA', { callbackUrl: 'https://example.com/callback' });
    expect(result).toBe('web+stellar:tx?xdr=AAAAAAAA&callback=https%3A%2F%2Fexample.com%2Fcallback');
  });

  it('builds URI with optional message parameter', () => {
    const result = buildSep7TxUri('AAAAAAAA', {
      callbackUrl: 'https://example.com/callback',
      message: 'Sign this transaction',
    });
    expect(result).toContain('msg=Sign+this+transaction');
    expect(result).toContain('xdr=AAAAAAAA');
    expect(result).toContain('callback=https%3A%2F%2Fexample.com%2Fcallback');
  });

  it('builds URI with optional networkPassphrase parameter', () => {
    const result = buildSep7TxUri('AAAAAAAA', {
      callbackUrl: 'https://example.com/callback',
      networkPassphrase: 'Test SDF Network ; September 2015',
    });
    expect(result).toContain('network_passphrase=Test+SDF+Network+%3B+September+2015');
  });

  it('builds URI with optional originDomain parameter', () => {
    const result = buildSep7TxUri('AAAAAAAA', {
      callbackUrl: 'https://example.com/callback',
      originDomain: 'example.com',
    });
    expect(result).toContain('origin_domain=example.com');
  });

  it('builds URI with all optional parameters', () => {
    const result = buildSep7TxUri('AAAAAAAA', {
      callbackUrl: 'https://example.com/callback',
      message: 'Sign this transaction',
      networkPassphrase: 'Test SDF Network ; September 2015',
      originDomain: 'example.com',
    });
    expect(result).toContain('xdr=AAAAAAAA');
    expect(result).toContain('callback=https%3A%2F%2Fexample.com%2Fcallback');
    expect(result).toContain('msg=Sign+this+transaction');
    expect(result).toContain('network_passphrase=Test+SDF+Network+%3B+September+2015');
    expect(result).toContain('origin_domain=example.com');
  });

  it('throws error when transaction XDR is empty', () => {
    expect(() => {
      buildSep7TxUri('', { callbackUrl: 'https://example.com/callback' });
    }).toThrow('SEP-7 transaction XDR is required');
  });

  it('throws error when transaction XDR is only whitespace', () => {
    expect(() => {
      buildSep7TxUri('   ', { callbackUrl: 'https://example.com/callback' });
    }).toThrow('SEP-7 transaction XDR is required');
  });

  it('throws error when callback URL is empty', () => {
    expect(() => {
      buildSep7TxUri('AAAAAAAA', { callbackUrl: '' });
    }).toThrow('SEP-7 callback URL is required');
  });

  it('throws error when callback URL is only whitespace', () => {
    expect(() => {
      buildSep7TxUri('AAAAAAAA', { callbackUrl: '   ' });
    }).toThrow('SEP-7 callback URL is required');
  });
});
