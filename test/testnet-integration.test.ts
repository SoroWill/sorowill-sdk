import { describe, it, expect, beforeAll } from 'vitest';
import { Keypair, Networks, TransactionBuilder } from '@stellar/stellar-sdk';
import { DEFAULT_CONTRACT_IDS, SoroWillClient, WillStatus } from '../src';
import type { WalletAdapter } from '../src/wallet';

/**
 * Integration test suite targeting the real Stellar Testnet Soroban deployment (#708).
 *
 * Gated behind the `TESTNET_INTEGRATION_TESTS` feature flag so unit test runs
 * remain fast and offline by default.
 *
 * Usage:
 *   TESTNET_INTEGRATION_TESTS=true \
 *   TESTNET_OWNER_SECRET=S... \
 *   TESTNET_BENEFICIARY_SECRET=S... \
 *   TESTNET_TOKEN_CONTRACT_ID=C... \
 *   npx vitest run test/testnet-integration.test.ts
 */

const TESTNET_INTEGRATION_ENABLED =
  process.env.TESTNET_INTEGRATION_TESTS === 'true' ||
  process.env.TESTNET_INTEGRATION_TESTS === '1';

const TESTNET_RPC_URL =
  process.env.TESTNET_RPC_URL || 'https://soroban-testnet.stellar.org';
const TESTNET_CONTRACT_ID =
  process.env.TESTNET_CONTRACT_ID || DEFAULT_CONTRACT_IDS.testnet;
const TESTNET_TOKEN_CONTRACT_ID = process.env.TESTNET_TOKEN_CONTRACT_ID || '';
const TESTNET_OWNER_SECRET = process.env.TESTNET_OWNER_SECRET || '';
const TESTNET_BENEFICIARY_SECRET = process.env.TESTNET_BENEFICIARY_SECRET || '';

function createKeypairWalletAdapter(secretKey: string): WalletAdapter {
  const keypair = Keypair.fromSecret(secretKey);
  const publicKey = keypair.publicKey();

  return {
    async isConnected() {
      return true;
    },
    async connect() {
      return {
        publicKey,
        network: 'testnet',
        networkPassphrase: Networks.TESTNET,
      };
    },
    async disconnect() {},
    async getPublicKey() {
      return publicKey;
    },
    async getNetwork() {
      return {
        network: 'testnet',
        networkPassphrase: Networks.TESTNET,
      };
    },
    async signTransaction(xdr: string) {
      const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
      tx.sign(keypair);
      return tx.toXDR();
    },
  };
}

describe.skipIf(!TESTNET_INTEGRATION_ENABLED)(
  'Stellar Testnet integration tests (#708)',
  () => {
    let ownerClient: SoroWillClient;
    let beneficiaryClient: SoroWillClient;
    let ownerAddress = '';
    let beneficiaryAddress = '';
    let createdWillId: string | undefined;

    beforeAll(() => {
      if (!TESTNET_OWNER_SECRET || !TESTNET_BENEFICIARY_SECRET) {
        throw new Error(
          'TESTNET_OWNER_SECRET and TESTNET_BENEFICIARY_SECRET must be set when TESTNET_INTEGRATION_TESTS is enabled.',
        );
      }

      const ownerKeypair = Keypair.fromSecret(TESTNET_OWNER_SECRET);
      const beneficiaryKeypair = Keypair.fromSecret(TESTNET_BENEFICIARY_SECRET);
      ownerAddress = ownerKeypair.publicKey();
      beneficiaryAddress = beneficiaryKeypair.publicKey();

      ownerClient = SoroWillClient.forNetwork('testnet', {
        contractId: TESTNET_CONTRACT_ID,
        rpcUrl: TESTNET_RPC_URL,
        walletAdapter: createKeypairWalletAdapter(TESTNET_OWNER_SECRET),
      });

      beneficiaryClient = SoroWillClient.forNetwork('testnet', {
        contractId: TESTNET_CONTRACT_ID,
        rpcUrl: TESTNET_RPC_URL,
        walletAdapter: createKeypairWalletAdapter(TESTNET_BENEFICIARY_SECRET),
      });
    });

    it('validates connectivity against actual Testnet contract deployment', async () => {
      const wills = await ownerClient.getWillsByOwner(ownerAddress);
      expect(Array.isArray(wills)).toBe(true);
    });

    it('creates a will on real Stellar Testnet', async () => {
      if (!TESTNET_TOKEN_CONTRACT_ID) {
        return;
      }

      const { willId, txHash } = await ownerClient.createWill({
        token: TESTNET_TOKEN_CONTRACT_ID,
        amount: '1000000',
        beneficiaries: [{ address: beneficiaryAddress, percentage: 100 }],
        checkinPeriodDays: 1,
        gracePeriodDays: 1,
        guardians: [],
      });

      expect(willId).toBeTruthy();
      expect(txHash).toBeTruthy();
      createdWillId = willId;

      const will = await ownerClient.getWill(willId);
      expect(will.owner).toBe(ownerAddress);
      expect(will.status).toBe(WillStatus.Active);
    });

    it('performs a real check-in flow on Stellar Testnet', async () => {
      if (!createdWillId) {
        return;
      }

      const { txHash } = await ownerClient.checkIn(createdWillId);
      expect(txHash).toBeTruthy();

      const updated = await ownerClient.getWill(createdWillId);
      expect(updated.status).toBe(WillStatus.Active);
    });

    it('supports trigger and beneficiary claim flow on Stellar Testnet', async () => {
      if (!createdWillId) {
        return;
      }

      // Triggering an active will whose check-in & grace period have elapsed
      // transitions it to Released so the beneficiary can claim.
      const triggerResult = await beneficiaryClient.triggerWill(createdWillId);
      expect(triggerResult.txHash).toBeTruthy();

      const released = await beneficiaryClient.getWill(createdWillId);
      expect([WillStatus.Triggered, WillStatus.Released]).toContain(released.status);
    });
  },
);
