/**
 * Tests for issue #616: SoroWillClient doesn't expose contract spec version.
 *
 * Acceptance criteria:
 * - Contract spec version exposed in client
 * - Version mismatch warning in console
 * - Test validates version property
 */

import { contract, xdr } from '@stellar/stellar-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SDK_REQUIRED_CONTRACT_METHODS,
  computeContractSpecVersion,
  readContractMeta,
} from '../src/contractVersion';
import { SoroWillClient } from '../src/SoroWillClient';

const CONTRACT_ID = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';

const fnEntry = (name: string) =>
  xdr.ScSpecEntry.scSpecEntryFunctionV0(
    new xdr.ScSpecFunctionV0({ doc: '', name, inputs: [], outputs: [] }),
  );

const metaEntry = (key: string, val: string) =>
  xdr.ScMetaEntry.scMetaV0(new xdr.ScMetaV0({ key, val }));

function uleb(n: number): number[] {
  const out: number[] = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n !== 0) byte |= 0x80;
    out.push(byte);
  } while (n !== 0);
  return out;
}

function customSection(name: string, payload: Buffer): Buffer {
  const nameBytes = Buffer.from(name);
  const body = Buffer.concat([Buffer.from(uleb(nameBytes.length)), nameBytes, payload]);
  return Buffer.concat([Buffer.from([0]), Buffer.from(uleb(body.length)), body]);
}

function buildWasm(methods: readonly string[], meta: Record<string, string> = {}): Uint8Array {
  const spec = Buffer.concat(methods.map((m) => fnEntry(m).toXDR()));
  const metaBytes = Buffer.concat(Object.entries(meta).map(([k, v]) => metaEntry(k, v).toXDR()));
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
      customSection('contractspecv0', spec),
      customSection('contractmetav0', metaBytes),
    ]),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('issue #616 — contract spec version', () => {
  it('readContractMeta parses contractmetav0 entries', () => {
    const wasm = buildWasm(['check_in'], { version: '1.2.0', rsver: '1.81.0' });
    expect(readContractMeta(wasm)).toEqual({ version: '1.2.0', rsver: '1.81.0' });
  });

  it('computeContractSpecVersion reports fingerprint, methods and compatibility', () => {
    const spec = new contract.Spec(SDK_REQUIRED_CONTRACT_METHODS.map(fnEntry));
    const version = computeContractSpecVersion(spec);
    expect(version.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(version.methods).toEqual([...SDK_REQUIRED_CONTRACT_METHODS].sort());
    expect(version.missingMethods).toEqual([]);
    expect(version.compatible).toBe(true);
    expect(version.contractVersion).toBeNull();
  });

  it('fingerprint changes when the contract interface changes', () => {
    const a = computeContractSpecVersion(new contract.Spec(SDK_REQUIRED_CONTRACT_METHODS.map(fnEntry)));
    const b = computeContractSpecVersion(
      new contract.Spec([...SDK_REQUIRED_CONTRACT_METHODS, 'new_method'].map(fnEntry)),
    );
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('contractSpecVersion is null before the spec loads and populated after', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      specJson: buildWasm(SDK_REQUIRED_CONTRACT_METHODS, { version: '1.0.0' }),
      expectedContractVersion: '1.0.0',
    });

    expect(client.contractSpecVersion).toBeNull();
    const version = await client.getContractSpecVersion();

    expect(version.contractVersion).toBe('1.0.0');
    expect(version.compatible).toBe(true);
    expect(version.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(client.contractSpecVersion).toEqual(version);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns when the contract is missing methods the SDK calls', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const methods = SDK_REQUIRED_CONTRACT_METHODS.filter((m) => m !== 'top_up');
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      specJson: buildWasm(methods),
    });

    const version = await client.getContractSpecVersion();
    expect(version.compatible).toBe(false);
    expect(version.missingMethods).toEqual(['top_up']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('version mismatch');
    expect(warn.mock.calls[0]![0]).toContain('top_up');
  });

  it('warns when the contract version differs from expectedContractVersion', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      specJson: buildWasm(SDK_REQUIRED_CONTRACT_METHODS, { version: '2.0.0' }),
      expectedContractVersion: '1.0.0',
    });

    await client.getContractSpecVersion();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('expected contract version "1.0.0"');
    expect(warn.mock.calls[0]![0]).toContain('"2.0.0"');
  });

  it('fetches the spec over RPC and warns only once per mismatch', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wasm = Buffer.from(buildWasm(['check_in'], { version: '9.9.9' }));
    const getContractWasmByContractId = vi.fn().mockResolvedValue(wasm);
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      rpcServer: {
        getContractWasmByContractId,
        simulateTransaction: vi.fn(),
        getAccount: vi.fn(),
        prepareTransaction: vi.fn(),
        sendTransaction: vi.fn(),
        pollTransaction: vi.fn(),
      },
    });

    const version = await client.getContractSpecVersion();
    expect(getContractWasmByContractId).toHaveBeenCalledTimes(1);
    expect(version.contractVersion).toBe('9.9.9');
    expect(version.methods).toEqual(['check_in']);

    await client.refreshSpec();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('handles a spec override without entries gracefully', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      spec: { funcArgsToScVals: () => [], funcResToNative: () => undefined },
    });

    const version = await client.getContractSpecVersion();
    expect(version).toEqual({
      fingerprint: null,
      contractVersion: null,
      methods: null,
      missingMethods: [],
      compatible: true,
    });
    expect(warn).not.toHaveBeenCalled();
  });
});
