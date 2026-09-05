import { describe, expect, it } from 'vitest';
import {
  Account,
  Contract,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { assertPreparedTransactionMatchesIntendedOperation } from '../src/txValidation';

describe('assertPreparedTransactionMatchesIntendedOperation', () => {
  function buildManageDataTx(name: string) {
    const account = new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '1');
    return new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.manageData({ name, value: 'payload' }))
      .setTimeout(30)
      .build();
  }

  describe('manageData operations', () => {
    it('accepts a prepared transaction when the decoded operation matches', () => {
      const tx = buildManageDataTx('sorowill');

      expect(() =>
        assertPreparedTransactionMatchesIntendedOperation({
          intendedTransactionXdr: tx.toXDR(),
          preparedTransactionXdr: tx.toXDR(),
          networkPassphrase: Networks.TESTNET,
          context: 'manage_data',
        }),
      ).not.toThrow();
    });

    it('throws when the decoded operation does not match the intended one', () => {
      const intendedTx = buildManageDataTx('sorowill');
      const mismatchedTx = buildManageDataTx('tampered');

      expect(() =>
        assertPreparedTransactionMatchesIntendedOperation({
          intendedTransactionXdr: intendedTx.toXDR(),
          preparedTransactionXdr: mismatchedTx.toXDR(),
          networkPassphrase: Networks.TESTNET,
          context: 'manage_data',
        }),
      ).toThrow('did not match the intended operation');
    });
  });

  describe('InvokeHostFunctionOp operations', () => {
    it('accepts InvokeHostFunctionOp when host function arguments match', () => {
      const account = new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '1');
      const contractId = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';
      const contract = new Contract(contractId);

      const intendedTx = new TransactionBuilder(account, {
        fee: '1000',
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(contract.call('get_will', xdr.ScVal.scvString('test')))
        .setTimeout(30)
        .build();

      expect(() =>
        assertPreparedTransactionMatchesIntendedOperation({
          intendedTransactionXdr: intendedTx.toXDR(),
          preparedTransactionXdr: intendedTx.toXDR(),
          networkPassphrase: Networks.TESTNET,
          context: 'invoke_contract',
        }),
      ).not.toThrow();
    });

    it('throws when operation type changes', () => {
      const account = new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '1');

      const intendedTx = new TransactionBuilder(account, {
        fee: '1000',
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(Operation.manageData({ name: 'test', value: 'data' }))
        .setTimeout(30)
        .build();

      const differentOp = new TransactionBuilder(account, {
        fee: '1000',
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(Operation.manageData({ name: 'test', value: 'different' }))
        .setTimeout(30)
        .build();

      expect(() =>
        assertPreparedTransactionMatchesIntendedOperation({
          intendedTransactionXdr: intendedTx.toXDR(),
          preparedTransactionXdr: differentOp.toXDR(),
          networkPassphrase: Networks.TESTNET,
          context: 'invoke_contract',
        }),
      ).toThrow('did not match the intended operation');
    });
  });
});
