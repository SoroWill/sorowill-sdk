export type {
  SignTransactionOptions,
  WalletAdapter,
  WalletConnection,
} from '../wallet';

/**
 * Canonical signature format shared by all TransactionSigner implementations.
 *
 * WalletConnect and Freighter historically returned signatures in different
 * encodings (hex vs base64) and attached them in different orders, which
 * caused cross-wallet transactions to fail contract verification. Adapters
 * MUST normalize signatures to this format before attaching them to a
 * transaction.
 */
export type CanonicalSignature = string;

/**
 * A signed endorsement attached to a transaction.
 *
 * `signer` identifies the account that produced the signature and `signature`
 * is the canonical (base64-encoded raw) signature. Endorsements are ordered
 * by `signer` so the contract receives signatures in a deterministic order
 * regardless of which adapter produced them.
 */
export interface Endorsement {
  signer: string;
  signature: CanonicalSignature;
}

/**
 * Normalizes a raw signature produced by a wallet adapter into the canonical
 * base64 encoding of the raw signature bytes.
 *
 * Accepts base64 (returned as-is) or hex (converted to base64) so that both
 * WalletConnect and Freighter adapters converge on the same format.
 */
export function toCanonicalSignature(raw: string): CanonicalSignature {
  const value = raw.trim();
  const isHex = value.length > 0 && value.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(value);
  if (!isHex) {
    return value;
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Orders endorsements deterministically by signer so that WalletConnect and
 * Freighter produce the same endorsement order for the same set of signers.
 */
export function orderEndorsements(endorsements: Endorsement[]): Endorsement[] {
  return [...endorsements].sort((a, b) => (a.signer < b.signer ? -1 : a.signer > b.signer ? 1 : 0));
}

/**
 * Normalizes and orders endorsements from any TransactionSigner
 * implementation before they are attached to a transaction.
 */
export function normalizeEndorsements(endorsements: Endorsement[]): Endorsement[] {
  return orderEndorsements(
    endorsements.map((endorsement) => ({
      signer: endorsement.signer,
      signature: toCanonicalSignature(endorsement.signature),
    })),
  );
}
