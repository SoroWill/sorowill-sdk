/**
 * Issue #4: Verify that a consumer can tell apart the two specific,
 * user-facing guardian_trigger failures:
 *
 *  - WillError::NotGuardian  — the caller is not one of the will's guardians
 *  - WillError::AlreadyVoted — the caller already voted in this cycle
 *
 * Both errors used to surface only as an opaque simulation-failure string.
 * This test asserts that the SDK maps each one to a distinct, typed error
 * class so that a guardian-voting UI can present the right message.
 */

import { Account, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import { SoroWillClient, type SoroWillRpcServer } from '../src/SoroWillClient';
import {
  AlreadyVotedError,
  NotGuardianError,
  WillContractError,
  mapContractError,
} from '../src/errors';
import { WillErrorCode } from '../src/types';

const TEST_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const VOID_SCVAL = xdr.ScVal.scvVoid();

/**
 * Returns an RPC server whose `prepareTransaction` (simulation) throws an
 * error string that embeds the given Soroban contract error code. This is the
 * canonical format `mapContractError` uses to identify typed SDK errors.
 */
function createFailingRpcServer(contractErrorCode: number): SoroWillRpcServer {
  return {
    async getContractWasmByContractId(): Promise<Uint8Array> {
      return new Uint8Array();
    },
    async simulateTransaction() {
      return { result: { retval: VOID_SCVAL } } as never;
    },
    async getAccount(address: string) {
      return new Account(address, '1');
    },
    async prepareTransaction() {
      // Simulate the contract panicking with the given error code.
      // The format mirrors what Soroban RPC returns for contract-level failures.
      throw new Error(
        `HostError: Value(Status(ContractError(${contractErrorCode}))) ` +
          `Error(Contract, #${contractErrorCode})`,
      );
    },
    async sendTransaction() {
      return { status: 'PENDING', hash: 'tx' } as never;
    },
    async pollTransaction() {
      return { status: 'SUCCESS', createdAt: 1_700_000_000, returnValue: VOID_SCVAL } as never;
    },
  };
}

function makeWalletAdapter() {
  return {
    async getPublicKey(): Promise<string> {
      return TEST_ACCOUNT;
    },
    async signTransaction(txXdr: string): Promise<string> {
      return txXdr;
    },
  };
}

function makeClient(rpcServer: SoroWillRpcServer) {
  return new SoroWillClient({
    network: 'testnet',
    contractId: 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR',
    wallet: makeWalletAdapter(),
    readCache: false,
    spec: {
      funcArgsToScVals: () => [],
      funcResToNative: (_m: string, v: unknown) => v,
    },
    rpcServer,
  });
}

// ---------------------------------------------------------------------------
// mapContractError unit tests — verifies the mapping layer directly
// ---------------------------------------------------------------------------
describe('mapContractError — NotGuardian vs AlreadyVoted', () => {
  it('maps error code 9 (NotGuardian) to NotGuardianError', () => {
    const raw = new Error('HostError: Error(Contract, #9)');
    const mapped = mapContractError(raw);
    expect(mapped).toBeInstanceOf(NotGuardianError);
  });

  it('maps error code 8 (AlreadyVoted) to AlreadyVotedError', () => {
    const raw = new Error('HostError: Error(Contract, #8)');
    const mapped = mapContractError(raw);
    expect(mapped).toBeInstanceOf(AlreadyVotedError);
  });

  it('NotGuardianError and AlreadyVotedError are distinct types', () => {
    const notGuardian = mapContractError(new Error('Error(Contract, #9)'));
    const alreadyVoted = mapContractError(new Error('Error(Contract, #8)'));
    expect(notGuardian).not.toBeInstanceOf(AlreadyVotedError);
    expect(alreadyVoted).not.toBeInstanceOf(NotGuardianError);
  });

  it('both are subclasses of WillContractError', () => {
    const notGuardian = mapContractError(new Error('Error(Contract, #9)'));
    const alreadyVoted = mapContractError(new Error('Error(Contract, #8)'));
    expect(notGuardian).toBeInstanceOf(WillContractError);
    expect(alreadyVoted).toBeInstanceOf(WillContractError);
  });

  it('NotGuardianError carries code WillErrorCode.NotGuardian (9)', () => {
    const err = mapContractError(new Error('Error(Contract, #9)')) as WillContractError;
    expect(err.code).toBe(WillErrorCode.NotGuardian);
    expect(err.code).toBe(9);
  });

  it('AlreadyVotedError carries code WillErrorCode.AlreadyVoted (8)', () => {
    const err = mapContractError(new Error('Error(Contract, #8)')) as WillContractError;
    expect(err.code).toBe(WillErrorCode.AlreadyVoted);
    expect(err.code).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// Integration-style tests: guardianTrigger throws the right typed errors
// ---------------------------------------------------------------------------
describe('guardianTrigger error distinction', () => {
  it('throws NotGuardianError when the caller is not a guardian of the will', async () => {
    const client = makeClient(
      createFailingRpcServer(WillErrorCode.NotGuardian),
    );

    const error = await client.guardianTrigger('1').catch((e) => e);

    expect(error).toBeInstanceOf(NotGuardianError);
    expect(error).not.toBeInstanceOf(AlreadyVotedError);
  });

  it('throws AlreadyVotedError when the guardian has already voted this cycle', async () => {
    const client = makeClient(
      createFailingRpcServer(WillErrorCode.AlreadyVoted),
    );

    const error = await client.guardianTrigger('1').catch((e) => e);

    expect(error).toBeInstanceOf(AlreadyVotedError);
    expect(error).not.toBeInstanceOf(NotGuardianError);
  });

  it('NotGuardianError and AlreadyVotedError from guardianTrigger are distinguishable by instanceof', async () => {
    const notGuardianClient = makeClient(createFailingRpcServer(WillErrorCode.NotGuardian));
    const alreadyVotedClient = makeClient(createFailingRpcServer(WillErrorCode.AlreadyVoted));

    const notGuardianError = await notGuardianClient.guardianTrigger('1').catch((e) => e);
    const alreadyVotedError = await alreadyVotedClient.guardianTrigger('1').catch((e) => e);

    // A UI can branch on the concrete error type:
    function getGuardianErrorMessage(err: unknown): string {
      if (err instanceof NotGuardianError) {
        return 'You are not a guardian of this will.';
      }
      if (err instanceof AlreadyVotedError) {
        return 'You have already voted in this cycle.';
      }
      return 'Unknown error';
    }

    expect(getGuardianErrorMessage(notGuardianError)).toBe('You are not a guardian of this will.');
    expect(getGuardianErrorMessage(alreadyVotedError)).toBe('You have already voted in this cycle.');
  });

  it('NotGuardianError and AlreadyVotedError are distinguishable by WillContractError.code', async () => {
    const notGuardianClient = makeClient(createFailingRpcServer(WillErrorCode.NotGuardian));
    const alreadyVotedClient = makeClient(createFailingRpcServer(WillErrorCode.AlreadyVoted));

    const notGuardianError = await notGuardianClient.guardianTrigger('1').catch((e) => e);
    const alreadyVotedError = await alreadyVotedClient.guardianTrigger('1').catch((e) => e);

    expect((notGuardianError as WillContractError).code).toBe(WillErrorCode.NotGuardian);
    expect((alreadyVotedError as WillContractError).code).toBe(WillErrorCode.AlreadyVoted);
    expect((notGuardianError as WillContractError).code).not.toBe(
      (alreadyVotedError as WillContractError).code,
    );
  });

  it('both errors are still WillContractError instances', async () => {
    const notGuardianClient = makeClient(createFailingRpcServer(WillErrorCode.NotGuardian));
    const alreadyVotedClient = makeClient(createFailingRpcServer(WillErrorCode.AlreadyVoted));

    const notGuardianError = await notGuardianClient.guardianTrigger('1').catch((e) => e);
    const alreadyVotedError = await alreadyVotedClient.guardianTrigger('1').catch((e) => e);

    expect(notGuardianError).toBeInstanceOf(WillContractError);
    expect(alreadyVotedError).toBeInstanceOf(WillContractError);
  });
});
