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

describe('parseSep7Callback', () => {
  it('parses callback with xdr parameter', () => {
    const result = parseSep7Callback('xdr=SIGNED_XDR');
    expect(result.transactionXdr).toBe('SIGNED_XDR');
    expect(result.signerAddress).toBeUndefined();
    expect(result.status).toBeUndefined();
    expect(result.message).toBeUndefined();
  });

  it('parses callback with signedTxXdr parameter', () => {
    const result = parseSep7Callback('signedTxXdr=SIGNED_XDR');
    expect(result.transactionXdr).toBe('SIGNED_XDR');
  });

  it('parses callback with signed_tx_xdr parameter', () => {
    const result = parseSep7Callback('signed_tx_xdr=SIGNED_XDR');
    expect(result.transactionXdr).toBe('SIGNED_XDR');
  });

  it('parses callback with tx parameter', () => {
    const result = parseSep7Callback('tx=SIGNED_XDR');
    expect(result.transactionXdr).toBe('SIGNED_XDR');
  });

  it('prioritizes xdr over other transaction parameter names', () => {
    const result = parseSep7Callback('xdr=XDR1&signedTxXdr=XDR2&signed_tx_xdr=XDR3&tx=XDR4');
    expect(result.transactionXdr).toBe('XDR1');
  });

  it('parses callback with pubkey parameter', () => {
    const result = parseSep7Callback('xdr=SIGNED_XDR&pubkey=GABC123');
    expect(result.transactionXdr).toBe('SIGNED_XDR');
    expect(result.signerAddress).toBe('GABC123');
  });

  it('parses callback with signer parameter', () => {
    const result = parseSep7Callback('xdr=SIGNED_XDR&signer=GABC123');
    expect(result.transactionXdr).toBe('SIGNED_XDR');
    expect(result.signerAddress).toBe('GABC123');
  });

  it('prioritizes pubkey over signer', () => {
    const result = parseSep7Callback('xdr=SIGNED_XDR&pubkey=GABC123&signer=GXYZ789');
    expect(result.signerAddress).toBe('GABC123');
  });

  it('parses callback with status parameter', () => {
    const result = parseSep7Callback('xdr=SIGNED_XDR&status=success');
    expect(result.status).toBe('success');
  });

  it('parses callback with message parameter', () => {
    const result = parseSep7Callback('xdr=SIGNED_XDR&message=Transaction+signed');
    expect(result.message).toBe('Transaction signed');
  });

  it('parses callback with msg parameter', () => {
    const result = parseSep7Callback('xdr=SIGNED_XDR&msg=Transaction+signed');
    expect(result.message).toBe('Transaction signed');
  });

  it('prioritizes message over msg', () => {
    const result = parseSep7Callback('xdr=SIGNED_XDR&message=msg1&msg=msg2');
    expect(result.message).toBe('msg1');
  });

  it('parses callback with all parameters', () => {
    const result = parseSep7Callback('xdr=SIGNED_XDR&pubkey=GABC123&status=success&message=Done');
    expect(result.transactionXdr).toBe('SIGNED_XDR');
    expect(result.signerAddress).toBe('GABC123');
    expect(result.status).toBe('success');
    expect(result.message).toBe('Done');
  });

  it('parses callback from URL object with query string', () => {
    const url = new URL('https://example.com/callback?xdr=SIGNED_XDR&pubkey=GABC123');
    const result = parseSep7Callback(url);
    expect(result.transactionXdr).toBe('SIGNED_XDR');
    expect(result.signerAddress).toBe('GABC123');
  });

  it('parses callback from URL object with hash fragment', () => {
    const url = new URL('https://example.com/callback#xdr=SIGNED_XDR&pubkey=GABC123');
    const result = parseSep7Callback(url);
    expect(result.transactionXdr).toBe('SIGNED_XDR');
    expect(result.signerAddress).toBe('GABC123');
  });

  it('parses callback from URLSearchParams object', () => {
    const params = new URLSearchParams('xdr=SIGNED_XDR&pubkey=GABC123');
    const result = parseSep7Callback(params);
    expect(result.transactionXdr).toBe('SIGNED_XDR');
    expect(result.signerAddress).toBe('GABC123');
  });

  it('parses callback from web+stellar URI', () => {
    const result = parseSep7Callback('web+stellar:tx?xdr=SIGNED_XDR&pubkey=GABC123');
    expect(result.transactionXdr).toBe('SIGNED_XDR');
    expect(result.signerAddress).toBe('GABC123');
  });

  it('throws error when no transaction XDR is provided', () => {
    expect(() => {
      parseSep7Callback('pubkey=GABC123');
    }).toThrow('SEP-7 callback did not include a signed transaction XDR');
  });

  it('throws error when transaction XDR parameters are empty strings', () => {
    expect(() => {
      parseSep7Callback('xdr=&signedTxXdr=&signed_tx_xdr=&tx=');
    }).toThrow('SEP-7 callback did not include a signed transaction XDR');
  });

  it('parses empty input as missing transaction XDR', () => {
    expect(() => {
      parseSep7Callback('');
    }).toThrow('SEP-7 callback did not include a signed transaction XDR');
  });

  it('parses whitespace-only input as missing transaction XDR', () => {
    expect(() => {
      parseSep7Callback('   ');
    }).toThrow('SEP-7 callback did not include a signed transaction XDR');
  });

  it('includes optional properties only when defined', () => {
    const result1: Sep7CallbackResult = parseSep7Callback('xdr=SIGNED_XDR');
    expect(Object.keys(result1).sort()).toEqual(['transactionXdr']);

    const result2 = parseSep7Callback('xdr=SIGNED_XDR&pubkey=GABC123');
    expect(Object.keys(result2).sort()).toEqual(['signerAddress', 'transactionXdr']);

    const result3 = parseSep7Callback('xdr=SIGNED_XDR&pubkey=GABC123&status=success&message=Done');
    expect(Object.keys(result3).sort()).toEqual(['message', 'signerAddress', 'status', 'transactionXdr']);
  });
});
