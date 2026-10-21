import { hash } from '@stellar/stellar-sdk';

/**
 * Contract methods this SDK version invokes. If a deployed contract's spec is
 * missing any of them, the SDK and contract have drifted apart and calls to
 * the missing methods will fail.
 */
export const SDK_REQUIRED_CONTRACT_METHODS: readonly string[] = [
  'cancel_will',
  'check_in',
  'create_will',
  'emergency_checkin',
  'get_will',
  'get_wills_by_beneficiary',
  'get_wills_by_owner',
  'guardian_trigger',
  'release_inheritance',
  'top_up',
  'trigger_will',
  'update_beneficiaries',
];

/** Contract metadata keys checked, in order, for the contract's own version string. */
const CONTRACT_VERSION_META_KEYS = ['version', 'binver', 'contract_version'];

/**
 * Version information derived from the deployed contract's spec, exposed by
 * {@link SoroWillClient.contractSpecVersion}.
 */
export interface ContractSpecVersion {
  /**
   * Short SHA-256 fingerprint (16 hex chars) of the contract's spec entries.
   * Changes whenever the contract's interface changes. `null` when the spec
   * was supplied as an override that does not expose its entries.
   */
  fingerprint: string | null;
  /**
   * The contract's self-reported version from its `contractmetav0` WASM
   * section (key `version`, `binver` or `contract_version`), or `null` when
   * the contract does not embed one or the WASM was not available.
   */
  contractVersion: string | null;
  /** Function names exported by the contract spec, sorted. `null` when unknown. */
  methods: string[] | null;
  /** Methods this SDK invokes that the contract spec does not export. */
  missingMethods: string[];
  /** `false` when the contract spec is missing methods this SDK invokes. */
  compatible: boolean;
}

interface SpecWithEntries {
  entries?: Array<{ toXDR(): Buffer }>;
  funcs?(): Array<{ name(): string | Buffer }>;
}

/** Reads an unsigned LEB128 integer from `bytes` at `offset`. */
function readUleb128(bytes: Uint8Array, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= bytes.length) throw new Error('Unexpected end of WASM while reading LEB128');
    const byte = bytes[pos++]!;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, next: pos };
    shift += 7;
  }
}

/** Returns the payloads of every WASM custom section named `sectionName`. */
function readWasmCustomSections(wasm: Uint8Array, sectionName: string): Uint8Array[] {
  const sections: Uint8Array[] = [];
  const decoder = new TextDecoder();
  let pos = 8; // magic + version
  while (pos < wasm.length) {
    const id = wasm[pos++]!;
    const size = readUleb128(wasm, pos);
    const start = size.next;
    const end = start + size.value;
    if (end > wasm.length) break;
    if (id === 0) {
      const nameLen = readUleb128(wasm, start);
      const name = decoder.decode(wasm.subarray(nameLen.next, nameLen.next + nameLen.value));
      if (name === sectionName) sections.push(wasm.subarray(nameLen.next + nameLen.value, end));
    }
    pos = end;
  }
  return sections;
}

/**
 * Parses the `contractmetav0` custom section of a Soroban contract WASM into
 * a key/value map. The section is a stream of XDR `ScMetaEntry` values
 * (`SC_META_V0`: a key string followed by a value string).
 */
export function readContractMeta(wasm: Uint8Array): Record<string, string> {
  const meta: Record<string, string> = {};
  try {
    const decoder = new TextDecoder();
    for (const section of readWasmCustomSections(wasm, 'contractmetav0')) {
      const view = new DataView(section.buffer, section.byteOffset, section.byteLength);
      let pos = 0;
      const readString = (): string => {
        const len = view.getUint32(pos);
        pos += 4;
        const value = decoder.decode(section.subarray(pos, pos + len));
        pos += len + ((4 - (len % 4)) % 4);
        return value;
      };
      while (pos + 4 <= section.length) {
        const kind = view.getInt32(pos);
        pos += 4;
        if (kind !== 0) break;
        const key = readString();
        meta[key] = readString();
      }
    }
  } catch {
    // Malformed or truncated metadata — return whatever was parsed.
  }
  return meta;
}

/**
 * Derives {@link ContractSpecVersion} from a contract spec and, when
 * available, the contract's WASM bytes.
 */
export function computeContractSpecVersion(spec: unknown, wasm?: Uint8Array): ContractSpecVersion {
  const s = (spec ?? {}) as SpecWithEntries;

  let fingerprint: string | null = null;
  if (Array.isArray(s.entries) && s.entries.length > 0) {
    try {
      const bytes = Buffer.concat(s.entries.map((entry) => entry.toXDR()));
      fingerprint = hash(bytes).toString('hex').slice(0, 16);
    } catch {
      fingerprint = null;
    }
  }

  let methods: string[] | null = null;
  if (typeof s.funcs === 'function') {
    try {
      methods = s.funcs().map((fn) => fn.name().toString()).sort();
    } catch {
      methods = null;
    }
  }

  let contractVersion: string | null = null;
  if (wasm) {
    const meta = readContractMeta(wasm);
    const key = CONTRACT_VERSION_META_KEYS.find((k) => meta[k] !== undefined);
    if (key) contractVersion = meta[key]!;
  }

  const missingMethods =
    methods === null ? [] : SDK_REQUIRED_CONTRACT_METHODS.filter((m) => !methods.includes(m));

  return {
    fingerprint,
    contractVersion,
    methods,
    missingMethods,
    compatible: missingMethods.length === 0,
  };
}

/**
 * Returns a human-readable mismatch warning for `version`, or `null` when the
 * contract looks compatible with this SDK (and, if given, matches
 * `expectedContractVersion`).
 */
export function describeContractVersionMismatch(
  version: ContractSpecVersion,
  expectedContractVersion?: string,
): string | null {
  const problems: string[] = [];
  if (!version.compatible) {
    problems.push(
      `the contract spec is missing method(s) this SDK calls: ${version.missingMethods.join(', ')}`,
    );
  }
  if (
    expectedContractVersion !== undefined &&
    version.contractVersion !== null &&
    version.contractVersion !== expectedContractVersion
  ) {
    problems.push(
      `expected contract version "${expectedContractVersion}" but the deployed contract reports "${version.contractVersion}"`,
    );
  }
  if (problems.length === 0) return null;
  return (
    `[SoroWill] Contract/SDK version mismatch: ${problems.join('; ')}. ` +
    'The contract may have been upgraded — update @sorowill/sdk or point the client at a compatible contract.'
  );
}
