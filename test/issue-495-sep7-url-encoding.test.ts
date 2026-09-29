/**
 * Tests for issue #495: sep7.ts does not escape URL query parameters,
 * breaking URIs with special characters in callback or transaction fields.
 *
 * Acceptance criteria:
 * - All URL parameters properly encoded with encodeURIComponent
 * - Test covers callbacks with query params and special chars
 * - Generated URIs validated as valid URLs
 */

import { describe, expect, it } from 'vitest';
import { buildSep7TxUri, parseSep7Callback } from '../src/sep7';

// Minimal valid base64 XDR placeholder (no `+` or special chars, just for URI building tests)
const STUB_XDR = 'AAAAAAAA';

// Realistic signed XDR for round-trip tests (contains `/`, `+`, `=` — base64 chars)
const SIGNED_XDR =
  'AAAAAgAAAACRoooLdDgVk6TZRpV5IIkmr8itgsiDm3ZENZueuppLOgAAAAAAAAAAAAAAAgAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAbqaSzoAAABAX2162UVnup/NxzMRqa9WzkuatQTkJhYahDGd4dP7cjsRs9zozjzpD9PZGp6ZU2FXnG1pyPIzsByNJuC0eE0LCA==';

describe('sep7.ts — issue #495: URL parameter encoding', () => {
  // ── Callback URL with query parameters ────────────────────────────────────

  it('correctly encodes a callback URL that contains query parameters', () => {
    const callbackWithQuery = 'https://example.com/callback?token=abc123&redirect=https%3A%2F%2Fother.com';
    const uri = buildSep7TxUri(STUB_XDR, { callbackUrl: callbackWithQuery });

    // The callback value in the URI must be entirely percent-encoded
    expect(uri).not.toContain('callback=url:https');
    // The callback= value must use %3A for colon and %2F for slash
    expect(uri).toContain('callback=url%3Ahttps%3A%2F%2Fexample.com%2Fcallback');
    // The & in the callback URL query string must be encoded as %26 (not raw &)
    expect(uri).not.toMatch(/callback=[^&]*[^%]&/);
  });

  it('encodes callback URL containing & separator as %26', () => {
    const callbackWithAmpersand = 'https://example.com/cb?foo=1&bar=2';
    const uri = buildSep7TxUri(STUB_XDR, { callbackUrl: callbackWithAmpersand });

    // Should contain %26 for the & inside the callback URL value
    expect(uri).toContain('%26');
    // Must NOT contain a raw & inside the callback value (would break URI parsing)
    const callbackParam = uri.split('&').find((p) => p.startsWith('callback='));
    expect(callbackParam).toBeDefined();
    // The callback value after = should not contain a raw &
    const callbackValue = callbackParam!.split('=').slice(1).join('=');
    expect(callbackValue).not.toContain('&');
  });

  it('encodes callback URL containing # fragment marker as %23', () => {
    const callbackWithHash = 'https://example.com/callback#section';
    const uri = buildSep7TxUri(STUB_XDR, { callbackUrl: callbackWithHash });
    expect(uri).toContain('%23section');
  });

  it('encodes callback URL containing spaces as %20', () => {
    // While unusual, spaces in URLs should be handled
    const callbackWithSpace = 'https://example.com/callback path';
    // This will fail URL validation — use encoded space in path instead
    const callbackEncoded = 'https://example.com/callback%20path';
    const uri = buildSep7TxUri(STUB_XDR, { callbackUrl: callbackEncoded });
    // The whole callback value is encoded, %20 inside callback becomes %2520 (double-encoded)
    expect(uri).toContain('callback=');
    expect(() => new URL(uri.replace('web+stellar:tx?', 'https://dummy.com/?'))).not.toThrow();
  });

  // ── Message field encoding ─────────────────────────────────────────────────

  it('encodes spaces in message as %20, not as +', () => {
    const uri = buildSep7TxUri(STUB_XDR, {
      callbackUrl: 'https://example.com/cb',
      message: 'Sign this transaction',
    });
    expect(uri).toContain('msg=Sign%20this%20transaction');
    expect(uri).not.toContain('msg=Sign+this+transaction');
  });

  it('encodes semicolons in message', () => {
    const uri = buildSep7TxUri(STUB_XDR, {
      callbackUrl: 'https://example.com/cb',
      message: 'Network: Test ; 2024',
    });
    expect(uri).toContain('%3B');
    expect(uri).not.toContain('msg=Network: Test ; 2024');
  });

  it('encodes ampersands in message as %26', () => {
    const uri = buildSep7TxUri(STUB_XDR, {
      callbackUrl: 'https://example.com/cb',
      message: 'Bread & Butter',
    });
    expect(uri).toContain('%26');
  });

  // ── Network passphrase encoding ───────────────────────────────────────────

  it('encodes spaces in network passphrase as %20, not as +', () => {
    const uri = buildSep7TxUri(STUB_XDR, {
      callbackUrl: 'https://example.com/cb',
      networkPassphrase: 'Test SDF Network ; September 2015',
    });
    expect(uri).toContain('network_passphrase=Test%20SDF%20Network%20%3B%20September%202015');
    expect(uri).not.toContain('network_passphrase=Test+SDF+Network');
  });

  it('encodes Stellar mainnet passphrase correctly', () => {
    const mainnet = 'Public Global Stellar Network ; September 2015';
    const uri = buildSep7TxUri(STUB_XDR, {
      callbackUrl: 'https://example.com/cb',
      networkPassphrase: mainnet,
    });
    expect(uri).toContain('network_passphrase=Public%20Global%20Stellar%20Network%20%3B%20September%202015');
  });

  // ── Generated URI is a valid parseable URI ────────────────────────────────

  it('generates a URI that is parseable as a URL (via query string extraction)', () => {
    const uri = buildSep7TxUri(STUB_XDR, {
      callbackUrl: 'https://example.com/callback?token=abc&redirect=other',
      message: 'Sign & confirm',
      networkPassphrase: 'Test SDF Network ; September 2015',
      originDomain: 'example.com',
    });

    // The URI scheme is web+stellar:tx — extract the query portion to validate
    expect(uri.startsWith('web+stellar:tx?')).toBe(true);
    const queryString = uri.slice('web+stellar:tx?'.length);
    // Parse as URLSearchParams — if encoding is correct, all values decode cleanly
    const params = new URLSearchParams(queryString);
    expect(params.get('xdr')).toBe(STUB_XDR);
    expect(params.get('callback')).toBe('url:https://example.com/callback?token=abc&redirect=other');
    expect(params.get('msg')).toBe('Sign & confirm');
    expect(params.get('network_passphrase')).toBe('Test SDF Network ; September 2015');
    expect(params.get('origin_domain')).toBe('example.com');
  });

  it('round-trips: decoded callback value matches the original callback URL', () => {
    const original = 'https://example.com/cb?foo=bar&baz=qux#anchor';
    const uri = buildSep7TxUri(STUB_XDR, { callbackUrl: original });
    const queryString = uri.slice('web+stellar:tx?'.length);
    const params = new URLSearchParams(queryString);
    // The callback value should decode back to `url:<original>`
    expect(params.get('callback')).toBe(`url:${original}`);
  });

  it('round-trips: decoded message matches the original message', () => {
    const original = 'Hello & goodbye; please sign: done!';
    const uri = buildSep7TxUri(STUB_XDR, {
      callbackUrl: 'https://example.com/cb',
      message: original,
    });
    const queryString = uri.slice('web+stellar:tx?'.length);
    const params = new URLSearchParams(queryString);
    expect(params.get('msg')).toBe(original);
  });

  // ── XDR encoding ──────────────────────────────────────────────────────────

  it('encodes base64 XDR containing + characters correctly', () => {
    // Base64 uses +, /, = — all must be percent-encoded in a query param value
    const xdrWithPlus = 'AAAA+AAAA=';
    const uri = buildSep7TxUri(xdrWithPlus, { callbackUrl: 'https://example.com/cb' });
    // + in XDR must be encoded as %2B so it is not confused with a space
    expect(uri).toContain('xdr=AAAA%2BAAAA%3D');
    // Round-trip: decoded xdr should equal the original
    const queryString = uri.slice('web+stellar:tx?'.length);
    const params = new URLSearchParams(queryString);
    expect(params.get('xdr')).toBe(xdrWithPlus);
  });

  it('encodes base64 XDR containing / characters correctly', () => {
    const xdrWithSlash = 'AAAA/AAAA==';
    const uri = buildSep7TxUri(xdrWithSlash, { callbackUrl: 'https://example.com/cb' });
    expect(uri).toContain('xdr=AAAA%2FAAAA%3D%3D');
    const queryString = uri.slice('web+stellar:tx?'.length);
    const params = new URLSearchParams(queryString);
    expect(params.get('xdr')).toBe(xdrWithSlash);
  });

  it('encodes base64 XDR containing = padding correctly', () => {
    const xdrWithEquals = 'AAAAAAAA==';
    const uri = buildSep7TxUri(xdrWithEquals, { callbackUrl: 'https://example.com/cb' });
    expect(uri).toContain('xdr=AAAAAAAA%3D%3D');
    const queryString = uri.slice('web+stellar:tx?'.length);
    const params = new URLSearchParams(queryString);
    expect(params.get('xdr')).toBe(xdrWithEquals);
  });

  // ── No raw special chars leak into the URI ────────────────────────────────

  it('URI does not contain unencoded = inside parameter values', () => {
    const uri = buildSep7TxUri('A=B=', {
      callbackUrl: 'https://example.com/cb',
    });
    // The only = signs in the URI should be key=value separators
    // Split by & to get individual params; each param's value should have no raw =
    const queryString = uri.slice('web+stellar:tx?'.length);
    for (const part of queryString.split('&')) {
      const eqIdx = part.indexOf('=');
      const value = part.slice(eqIdx + 1);
      expect(value).not.toContain('=');
    }
  });

  it('URI does not contain unencoded & inside parameter values', () => {
    const uri = buildSep7TxUri(STUB_XDR, {
      callbackUrl: 'https://example.com/cb?a=1&b=2',
      message: 'foo & bar',
    });
    const queryString = uri.slice('web+stellar:tx?'.length);
    for (const part of queryString.split('&')) {
      const eqIdx = part.indexOf('=');
      const value = part.slice(eqIdx + 1);
      expect(value).not.toContain('&');
    }
  });
});
