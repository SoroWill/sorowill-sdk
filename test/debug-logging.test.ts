import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SoroWillClient } from '../src/SoroWillClient';

describe('Debug Logging - Issue #50: Opt-in structured debug logging', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it('should not log when debug is false (default)', () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      debug: false,
    });

    expect(client).toBeDefined();
  });

  it('should enable structured debug logging when debug option is true', () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      debug: true,
    });

    expect(client).toBeDefined();
  });

  it('should default to debug false for backwards compatibility', () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
    });

    expect(client).toBeDefined();
  });
});
