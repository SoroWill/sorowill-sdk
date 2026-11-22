# Test RPC failure recovery and endpoint switching

_Tracks [GitHub #742](https://github.com/SoroWill/sorowill-sdk/issues/742)._

## Description

No end-to-end tests cover the RPC failover and endpoint-switching logic.
`RpcEndpointPool`'s parts are unit-tested separately (backoff, health
checks), but no test simulates a primary outage and checks that a real SDK
operation still completes.

## Evidence

- `RpcEndpointPool` (`src/rpc.ts:268`) provides:
  - `withFailover` (597): per-endpoint backoff, circuit breaker
    (`DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 3`, 60s cooldown), and timeout retry
    with exponential backoff (`runWithTimeoutRetry`, 523).
  - Primary retry after `failoverCooldownMs` (around line 373).
  - Health checks: `checkEndpointHealth` (682), `runHealthChecks` (702), which
    moves routing to the first healthy endpoint, and `startHealthMonitoring`
    (722).
- The client builds the pool from `rpcUrls`, or from `rpcUrl` plus the
  network defaults (`src/SoroWillClient.ts:1248`), and exposes
  `checkRpcHealth()` (2257).
- Existing coverage is unit-level only:
  - `test/issue-533-rpc-endpoint-backoff.test.ts` covers backoff windows.
  - `test/rpc-health-check.test.ts` covers `isHealthy()` on a single server.
  - `test/rpc-retry-classification.test.ts` and
    `test/issue-485-rpc-endpoint-timeout.test.ts` cover error classification
    and timeouts.
  - Nothing goes through `SoroWillClient` with several endpoints and a failing
    primary.

## Suggested acceptance criteria

New file: `test/rpc-failover-recovery.test.ts`, using fake timers and an
injected per-URL mock server factory.

- [ ] **Simulate primary RPC failure**: the primary throws a retryable
      connection error (for example `ECONNREFUSED` or `fetch failed`), and a
      separate case where it times out.
- [ ] **Verify failover to secondary**:
  - [ ] The call is served by endpoint 2.
  - [ ] Later calls stay on endpoint 2 during `failoverCooldownMs`.
  - [ ] Non-retryable application errors (simulation or contract errors) do
        **not** trigger failover.
- [ ] **Test health check recovery**:
  - [ ] `runHealthChecks()` with primary unhealthy moves routing to a healthy
        endpoint.
  - [ ] Once the primary reports `healthy` again on a later
        `startHealthMonitoring` tick (or after the cooldown), routing returns
        to it.
  - [ ] The circuit breaker opens after 3 failures and closes after its
        cooldown.
- [ ] **Verify operations complete**:
  - [ ] A read (`getWill`) and a write (`checkIn` through
        `submitSignedTransaction`/`waitForTransaction`) both return a correct
        result during a primary outage.
  - [ ] When every endpoint fails, the call throws one clear error (no hang and
        no unhandled rejection).
- [ ] Sanity check that a timed-out submission has not already landed
      (`isTransactionResolved`) before it is re-sent, so failover can't
      double-submit.
