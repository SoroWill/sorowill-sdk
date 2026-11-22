# Add whitelist validation for supported networks

_Tracks [GitHub #737](https://github.com/SoroWill/sorowill-sdk/issues/737)._

## Description

The SDK accepts the `network` constructor option as a string but validates it
only implicitly: `NETWORK_CONFIG[options.network]` silently returns `undefined`
when an unknown string is passed, and `DEFAULT_CONTRACT_IDS[options.network]`
does the same. The resulting client is misconfigured — it carries no RPC URLs
and no network passphrase — yet it throws nothing at construction time, so the
failure surfaces only later, as a cryptic runtime error on the first RPC call.

Consumers who mistype a network name (e.g. `'Testnet'`, `'test-net'`,
`'mainnet-beta'`) currently get no early feedback.

## Evidence

- `SoroWillNetwork` is typed as `'testnet' | 'mainnet'` (defined at
  `src/SoroWillClient.ts`, exported as a TypeScript type). TypeScript catches
  the wrong value at compile time, but only when the caller is also written
  in TypeScript and has the type in scope. Callers using JavaScript, or passing
  a string cast through `as SoroWillNetwork`, receive no protection.
- `NETWORK_CONFIG` is a plain `Record<SoroWillNetwork, NetworkConfig>` keyed on
  `'testnet'` and `'mainnet'`. An unrecognized key returns `undefined` with no
  guard.
- `SoroWillClient.forNetwork()` reads `NETWORK_CONFIG[network]` directly (line
  ~1194 in `SoroWillClient.ts`). An invalid `network` argument produces a
  client whose internal `rpcUrls` and `networkPassphrase` are both `undefined`.
- No unit test currently covers the case where an unknown network string is
  passed to the constructor or to `forNetwork()`.

## Suggested acceptance criteria

- [ ] Add an explicit runtime guard in the `SoroWillClient` constructor and in
      `SoroWillClient.forNetwork()` that checks `options.network` against
      `Object.keys(NETWORK_CONFIG)` (i.e. `['testnet', 'mainnet']`) and throws
      a clear `SoroWillError` immediately when it is not in that set.
  - Suggested message: `"Unsupported network \"${options.network}\". Supported networks are: testnet, mainnet."`
- [ ] Export a `SUPPORTED_NETWORKS` constant (a `readonly string[]` or
      `ReadonlySet<string>`) from the public API so consumers can enumerate
      valid values without hard-coding them.
- [ ] Unit tests covering:
  - Passing an unrecognized string throws synchronously with a message that
    names the invalid value and lists the valid ones.
  - Both `new SoroWillClient({ network: 'badnet', ... })` and
    `SoroWillClient.forNetwork('badnet' as SoroWillNetwork)` are covered.
  - Known-good values (`'testnet'`, `'mainnet'`) do not throw.
- [ ] The guard should not break any existing test; `forNetwork.test.ts` and
      `edge-case-network-switch.test.ts` must continue to pass.

## Implementation notes

The guard can be as simple as:

```ts
const SUPPORTED_NETWORKS = Object.keys(NETWORK_CONFIG) as SoroWillNetwork[];

// In the constructor:
if (!SUPPORTED_NETWORKS.includes(options.network)) {
  throw new SoroWillError(
    `Unsupported network "${options.network}". Supported networks are: ${SUPPORTED_NETWORKS.join(', ')}.`,
  );
}
```

Place it at the top of the constructor and of `forNetwork()`, before any
`NETWORK_CONFIG` or `DEFAULT_CONTRACT_IDS` lookups, so the error is thrown
before any partial state is set up.

The same guard should protect `forNetwork()`:

```ts
static forNetwork(network: SoroWillNetwork, overrides?: ...) {
  if (!SUPPORTED_NETWORKS.includes(network)) {
    throw new SoroWillError(
      `Unsupported network "${network}". Supported networks are: ${SUPPORTED_NETWORKS.join(', ')}.`,
    );
  }
  // ...
}
```

Exporting `SUPPORTED_NETWORKS` from `src/index.ts` and from the public
`SoroWillClient` module lets consumers show a helpful dropdown of valid
networks in a UI without duplicating the list.
