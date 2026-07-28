# Changelog

All notable changes to `@sorowill/sdk` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-07-27

### Added

- Hook system (`beforeInvoke` / `afterInvoke`) for intercepting contract calls via `HookManager`.
- WalletConnect adapter with session persistence (`MemoryWalletConnectSessionStore`, `LocalStorageWalletConnectSessionStore`).
- RPC endpoint failover via `RpcEndpointPool` with automatic retry for transient connection errors.
- Persistent event-driven read caching (`ReadCache`) with `IndexedDbCachePersistenceAdapter`, `LocalStorageCachePersistenceAdapter`, and `MemoryCachePersistenceAdapter`.
- `@sorowill/sdk/react` sub-package with data-fetching hooks: `useWill`, `useWillsByOwner`, `useWillsByBeneficiary`.
- Resilient RPC batching via `RequestQueue` with concurrency, rate-limit, and timeout controls.
- Fee preview via `SoroWillClient.previewFee()`.
- Client-side pagination for `getWillsByOwner` and `getWillsByBeneficiary`.
- Event subscriptions (`subscribeToEvents`) with WebSocket and polling transports.
- `SoroWillClient.fromEnv()` for environment-driven construction.
- `batch()` method for atomic multi-operation transactions.
- `buildSep7SigningUri()` for SEP-7 deep-link generation.
- Pre-sign XDR validation via `assertPreparedTransactionMatchesIntendedOperation`.
- Multi-signature transaction support via `MultisigCollector`, `buildMultisigTransactionXdr`, and `signWithSecretKey`.
- Fee-bump transaction support via `buildFeeBumpXdr`, `signFeeBumpXdr`, `submitFeeBump`, and `submitFeeBumpTransaction`.
- Pluggable wallet adapters: Freighter, Albedo, Ledger, Hana, HOT, Lobstr, and injected browser wallets.
- `WalletAdapter` interface for custom wallet integrations.
- Typed contract errors: `WillNotFoundError`, `NotOwnerError`, `WillNotActiveError`, `WillNotTriggeredError`, `GracePeriodNotExpiredError`, `GracePeriodExpiredError`, `InvalidPercentagesError`, `AlreadyVotedError`, `NotGuardianError`, `CheckinNotDueError`, `ZeroAmountError`, `TooManyBeneficiariesError`, `RequestTimeoutError`.
- Utility helpers: `formatUSDC`, `toStroops`, `calculateShares`, `formatDeadline`, `validateBeneficiaries`, `getTimeUntilCheckin`, `isCheckinDue`.
- SEP-7 helpers: `buildSep7TxUri`, `parseSep7Callback`.

### Changed

- Public methods on `SoroWillClient` now accept an optional `RequestOptions` parameter for per-call timeout overrides.
- Read methods (`getWill`, `getWillsByOwner`, `getWillsByBeneficiary`) support optional `PaginationOptions`.
- `SoroWillClient` constructor accepts an optional `wallet` adapter, defaulting to Freighter.

## [0.1.0] - 2026-06-01

### Added

- Initial release of `@sorowill/sdk`.
- `SoroWillClient` with core methods: `createWill`, `checkIn`, `triggerWill`, `emergencyCheckIn`, `releaseInheritance`, `cancelWill`, `updateBeneficiaries`, `topUp`, `guardianTrigger`, `getWill`, `getWillsByOwner`, `getWillsByBeneficiary`.
- Freighter wallet integration via `freighterAdapter`.
- `WalletAdapter` interface, `getPublicKey`, `signTransaction`, `connectWallet`, `isFreighterInstalled`.
- `WillStatus` enum and core types (`Will`, `Beneficiary`, `CreateWillParams`, `UpdateBeneficiariesParams`).
