import { Account, Networks, TransactionBuilder, Operation, BASE_FEE } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

/**
 * Tests for sequence number handling under concurrent SDK usage.
 * Documents the current behavior and validates correct handling under concurrent calls.
 */

describe('Replay/Nonce Handling - Sequence Number Management', () => {
  const networkPassphrase = Networks.TESTNET;
  const sourceKey = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

  describe('sequence number handling in TransactionBuilder', () => {
    it('increments sequence number for each transaction built from the same Account object', () => {
      const account = new Account(sourceKey, '100');

      const tx1 = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase,
      })
        .addOperation(Operation.manageData({ name: 'test1', value: 'value1' }))
        .setTimeout(300)
        .build();

      expect(tx1.sequence).toBe('101');

      const tx2 = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase,
      })
        .addOperation(Operation.manageData({ name: 'test2', value: 'value2' }))
        .setTimeout(300)
        .build();

      expect(tx2.sequence).toBe('102');
    });

    it('uses the account sequence number at the time of build, not at initialization', () => {
      const account = new Account(sourceKey, '50');

      const tx1 = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase,
      })
        .addOperation(Operation.manageData({ name: 'test', value: 'value' }))
        .setTimeout(300)
        .build();

      expect(tx1.sequence).toBe('51');

      // After building, the account sequence was incremented
      const tx2 = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase,
      })
        .addOperation(Operation.manageData({ name: 'test', value: 'value' }))
        .setTimeout(300)
        .build();

      expect(tx2.sequence).toBe('52');
    });

    it('correctly handles large sequence numbers', () => {
      const largeSeq = '9223372036854775806'; // Near MAX_INT64
      const account = new Account(sourceKey, largeSeq);

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase,
      })
        .addOperation(Operation.manageData({ name: 'test', value: 'value' }))
        .setTimeout(300)
        .build();

      expect(tx.sequence).toBe('9223372036854775807');
    });
  });

  describe('concurrent sequence number handling', () => {
    it('properly increments sequence when multiple transactions are built sequentially from same account', async () => {
      const account = new Account(sourceKey, '200');
      const sequences: string[] = [];

      for (let i = 0; i < 5; i++) {
        const tx = new TransactionBuilder(account, {
          fee: BASE_FEE,
          networkPassphrase,
        })
          .addOperation(Operation.manageData({ name: 'test', value: 'value' }))
          .setTimeout(300)
          .build();

        sequences.push(tx.sequence);
      }

      expect(sequences).toEqual(['201', '202', '203', '204', '205']);
    });

    it('detects race condition potential: using stale sequence numbers', () => {
      // This demonstrates the race condition:
      // If sequence is fetched once and reused across multiple concurrent calls
      const sourceSeq = '100';

      // Simulating concurrent calls fetching sequence once
      const staledAccounts = Array.from({ length: 3 }, () =>
        new Account(sourceKey, sourceSeq)
      );

      const txs = staledAccounts.map(account =>
        new TransactionBuilder(account, {
          fee: BASE_FEE,
          networkPassphrase,
        })
          .addOperation(Operation.manageData({ name: 'test', value: 'value' }))
          .setTimeout(300)
          .build()
      );

      // All transactions get the same sequence, which would cause a replay error
      expect(txs[0]?.sequence).toBe('101');
      expect(txs[1]?.sequence).toBe('101');
      expect(txs[2]?.sequence).toBe('101');
    });

    it('correctly handles re-fetching sequence for concurrent safety', async () => {
      // Best practice: fetch sequence immediately before building
      let currentSeq = 100;

      const getLatestSequence = async () => {
        // In real SDK, this would be an RPC call
        // Simulating: each call gets incremented value
        return currentSeq++;
      };

      const sequences: string[] = [];

      for (let i = 0; i < 5; i++) {
        const seq = await getLatestSequence();
        const account = new Account(sourceKey, seq.toString());

        const tx = new TransactionBuilder(account, {
          fee: BASE_FEE,
          networkPassphrase,
        })
          .addOperation(Operation.manageData({ name: 'test', value: 'value' }))
          .setTimeout(300)
          .build();

        sequences.push(tx.sequence);
      }

      // Each transaction has a unique sequence
      expect(sequences).toEqual(['101', '102', '103', '104', '105']);
      expect(new Set(sequences).size).toBe(5); // All unique
    });

    it('ensures sequence numbers do not repeat when account is refetched', async () => {
      let serverSequence = 500n;

      const fetchAccountSequence = async () => {
        // Simulates RPC call that increments each time
        const seq = serverSequence;
        serverSequence++;
        return seq.toString();
      };

      const txSequences: string[] = [];

      // Simulate 3 concurrent requests, each fetching sequence independently
      const promises = Array.from({ length: 3 }, async (_, index) => {
        // Simulate slight delay to show concurrency
        await new Promise(resolve => setTimeout(resolve, Math.random() * 10));

        const seq = await fetchAccountSequence();
        const account = new Account(sourceKey, seq);

        const tx = new TransactionBuilder(account, {
          fee: BASE_FEE,
          networkPassphrase,
        })
          .addOperation(Operation.manageData({ name: 'test', value: 'value' }))
          .setTimeout(300)
          .build();

        txSequences.push(tx.sequence);
        return tx.sequence;
      });

      const results = await Promise.all(promises);

      // All sequences should be unique
      expect(new Set(results).size).toBe(3);

      // Verify no duplicates even with concurrent execution
      expect(results.every((seq, i) => results.indexOf(seq) === i)).toBe(true);
    });
  });

  describe('edge cases for sequence number handling', () => {
    it('handles Account creation with string sequence correctly', () => {
      const account = new Account(sourceKey, '0');

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase,
      })
        .addOperation(Operation.manageData({ name: 'test', value: 'value' }))
        .setTimeout(300)
        .build();

      expect(tx.sequence).toBe('1');
    });

    it('maintains sequence integrity across multiple account instances', () => {
      // Each Account instance should manage its own sequence
      const account1 = new Account(sourceKey, '1000');
      const account2 = new Account(sourceKey, '2000');

      const tx1 = new TransactionBuilder(account1, {
        fee: BASE_FEE,
        networkPassphrase,
      })
        .addOperation(Operation.manageData({ name: 'test', value: 'value' }))
        .setTimeout(300)
        .build();

      const tx2 = new TransactionBuilder(account2, {
        fee: BASE_FEE,
        networkPassphrase,
      })
        .addOperation(Operation.manageData({ name: 'test', value: 'value' }))
        .setTimeout(300)
        .build();

      expect(tx1.sequence).toBe('1001');
      expect(tx2.sequence).toBe('2001');
    });
  });

  describe('documentation: Sequence number handling best practices', () => {
    it('documents that Account objects should not be shared across concurrent transaction builds', () => {
      // Anti-pattern: Sharing single account across concurrent calls
      const sharedAccount = new Account(sourceKey, '300');

      // This would cause race condition if done concurrently
      // Because each build increments the sequence after reading it
      const tx1 = new TransactionBuilder(sharedAccount, {
        fee: BASE_FEE,
        networkPassphrase,
      })
        .addOperation(Operation.manageData({ name: 'test', value: 'value' }))
        .setTimeout(300)
        .build();

      expect(tx1.sequence).toBe('301');

      const tx2 = new TransactionBuilder(sharedAccount, {
        fee: BASE_FEE,
        networkPassphrase,
      })
        .addOperation(Operation.manageData({ name: 'test', value: 'value' }))
        .setTimeout(300)
        .build();

      expect(tx2.sequence).toBe('302');
    });

    it('documents pattern: fetch fresh sequence before each build for concurrent safety', () => {
      // Best practice for concurrent calls:
      // 1. Fetch latest sequence from RPC immediately before build
      // 2. Create fresh Account instance for each transaction
      // 3. Build transaction right after Account creation

      let rpcSequence = 400;

      const buildTransactionSafely = () => {
        // Step 1: Fetch latest
        const seq = rpcSequence++;

        // Step 2 & 3: Create and build immediately
        const account = new Account(sourceKey, seq.toString());
        const tx = new TransactionBuilder(account, {
          fee: BASE_FEE,
          networkPassphrase,
        })
          .addOperation(Operation.manageData({ name: 'test', value: 'value' }))
          .setTimeout(300)
          .build();

        return tx;
      };

      const txs = [buildTransactionSafely(), buildTransactionSafely(), buildTransactionSafely()];

      expect(txs.map(t => t.sequence)).toEqual(['401', '402', '403']);
    });
  });
});
