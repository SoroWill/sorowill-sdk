import { describe, expect, it, afterEach } from 'vitest';
import { SoroWillClient } from '../src/SoroWillClient';
import { ReadOnlyModeError } from '../src/errors';

/**
 * Issue #635 — SDK doesn't implement read-only mode for unsigned operations
 *
 * Acceptance criteria:
 * - Read-only mode without wallet (readOnly: true)
 * - Clear error on unsigned write attempts (ReadOnlyModeError)
 * - Test validates read-only operations
 */
describe('Issue #635 — read-only mode', () => {
  const clients: SoroWillClient[] = [];

  afterEach(() => {
    for (const client of clients.splice(0)) client.destroy();
  });

  it('constructs successfully without a wallet when readOnly: true', () => {
    expect(() => {
      const client = new SoroWillClient({
        network: 'testnet',
        contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
        readOnly: true,
      });
      clients.push(client);
    }).not.toThrow();
  });

  it('throws ReadOnlyModeError when checkIn is called in read-only mode', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      readOnly: true,
    });
    clients.push(client);

    await expect(client.checkIn('1')).rejects.toThrow(ReadOnlyModeError);
  });

  it('throws ReadOnlyModeError when createWill is called in read-only mode', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      readOnly: true,
    });
    clients.push(client);

    await expect(
      client.createWill({
        token: 'CTOKEN',
        amount: '1000',
        beneficiaries: [{ address: 'GBENE', percentage: 100 }],
        checkinPeriodDays: 90,
        gracePeriodDays: 7,
        guardians: [],
      }),
    ).rejects.toThrow(ReadOnlyModeError);
  });

  it('throws ReadOnlyModeError when batch is called in read-only mode', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      readOnly: true,
    });
    clients.push(client);

    await expect(
      client.batch([{ method: 'check_in', args: { will_id: 1n } }]),
    ).rejects.toThrow(ReadOnlyModeError);
  });

  it('throws ReadOnlyModeError when submitSignedTransaction is called in read-only mode', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      readOnly: true,
    });
    clients.push(client);

    await expect(
      client.submitSignedTransaction('fake-xdr'),
    ).rejects.toThrow(ReadOnlyModeError);
  });

  it('includes the method name in the ReadOnlyModeError message', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      readOnly: true,
    });
    clients.push(client);

    try {
      await client.checkIn('1');
      expect.fail('expected ReadOnlyModeError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ReadOnlyModeError);
      const e = err as ReadOnlyModeError;
      expect(e.method).toBe('check_in');
      expect(e.message).toContain('check_in');
      expect(e.message).toContain('read-only');
    }
  });

  it('does not require a wallet option when readOnly: true', () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      readOnly: true,
      // no wallet option
    });
    clients.push(client);
    expect(client.getNetwork()).toBe('testnet');
    expect(client.getContractId()).toBe('CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE');
  });
});
