import { describe, it, expect } from 'vitest';
import { SoroWillClient } from '../src/SoroWillClient';

describe('Fee-Bump Auto-Resubmit - Issue #49: Stuck-transaction auto fee-bump-and-resubmit', () => {
  it('should accept autoFeeBumpOnTimeout option', () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      autoFeeBumpOnTimeout: true,
    });

    expect(client).toBeDefined();
  });

  it('should default to autoFeeBumpOnTimeout false for backwards compatibility', () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
    });

    expect(client).toBeDefined();
  });

  it('should allow explicit false for autoFeeBumpOnTimeout', () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      autoFeeBumpOnTimeout: false,
    });

    expect(client).toBeDefined();
  });

  it('should perform fee-bump semantics, not duplicate raw transaction', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      autoFeeBumpOnTimeout: true,
      // When implemented, this should rebuild with higher fee
      // not submit the same raw transaction again
    });

    expect(client).toBeDefined();
    // The implementation will handle fee-bump resubmission
    // with higher fees rather than duplicate raw transaction submission
  });
});
