# Quick Start

This guide walks through the full lifecycle of a SoroWill will on **testnet**:

**Create → Top up → Check in → Claim (trigger + release)**

Every snippet is copy-paste ready and shows all of its imports.

## Prerequisites

- Node.js 18+ and a browser bundler (Vite, Next.js, webpack, …). The default wallet adapter talks to the [Freighter](https://www.freighter.app/) extension, so the write calls must run in a browser.
- Freighter installed and switched to **Testnet**.
- A testnet account funded with XLM (use [Friendbot](https://laboratory.stellar.org/#account-creator?network=test)) and holding some testnet USDC.
- The address of a deployed SoroWill contract. The examples use the public testnet deployment.

```bash
npm install @sorowill/sdk
```

## 1. Set up the client

```ts
// sorowill.ts
import { SoroWillClient, connectWallet, isFreighterInstalled } from '@sorowill/sdk';

export const CONTRACT_ID = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';
export const USDC_TESTNET = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';

export const client = new SoroWillClient({
  network: 'testnet',
  contractId: CONTRACT_ID,
});

export async function connect(): Promise<string> {
  if (!(await isFreighterInstalled())) {
    throw new Error('Install the Freighter extension first: https://www.freighter.app/');
  }
  const { publicKey } = await connectWallet();
  return publicKey;
}
```

**What's happening:**

- `SoroWillClient` is the single entry point. `network` chooses the RPC endpoint and network passphrase; `contractId` is the SoroWill contract.
- With no `wallet` option the client signs with Freighter. To use another wallet, pass `wallet: createAlbedoAdapter()` or any other `WalletAdapter`.
- `connectWallet()` asks Freighter for permission and returns the connected account. You must call it before any state-changing method.

## 2. Create a will

```ts
// create.ts
import { toStroops, validateBeneficiaries, type Beneficiary } from '@sorowill/sdk';
import { client, connect, USDC_TESTNET } from './sorowill';

const owner = await connect();

const beneficiaries: Beneficiary[] = [
  { address: 'GBENEFICIARYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', percentage: 60 },
  { address: 'GBENEFICIARYBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', percentage: 40 },
];

if (!validateBeneficiaries(beneficiaries)) {
  throw new Error('Percentages must be positive integers that sum to 100');
}

const { willId, txHash } = await client.createWill({
  token: USDC_TESTNET,
  amount: toStroops('100').toString(), // 100 USDC in base units
  beneficiaries,
  checkinPeriodDays: 1,
  gracePeriodDays: 1,
  guardians: [],
});

console.log(`Owner ${owner} created will #${willId} (tx ${txHash})`);
```

**What's happening:**

- `toStroops('100')` converts a human amount into base units (7 decimals), returning a `bigint`. The SDK takes amounts as **decimal strings**, so call `.toString()`.
- `validateBeneficiaries` checks the same rule the contract enforces: integer percentages that add up to exactly 100. Checking first saves you a failed transaction (`InvalidPercentagesError`).
- `checkinPeriodDays` is how long the owner can go without checking in. `gracePeriodDays` is how long the owner then has to respond after the will is triggered. Short periods make testnet testing faster.
- `guardians` can hold up to 3 addresses. If 2 of them vote with `guardianTrigger`, the will is released early.
- Freighter asks you to sign once. The call resolves after the transaction is confirmed, and returns the new `willId` as a string.

## 3. Top up the will

```ts
// topup.ts
import { formatUSDC, toStroops } from '@sorowill/sdk';
import { client, connect } from './sorowill';

await connect();
const willId = '1'; // from step 2

const { txHash } = await client.topUp(willId, toStroops('25').toString());
console.log(`Topped up in tx ${txHash}`);

const will = await client.getWill(willId);
console.log(`Locked balance: ${formatUSDC(BigInt(will.balance))} USDC`);
```

**What's happening:**

- `topUp` moves more of the will's token from the owner into the contract. Only the owner can top up, and only while the will is `Active`.
- `getWill` is a read-only simulation and doesn't need a wallet. After a write, the SDK clears cached reads for that will, so this read returns the new balance.
- `will.balance` is a base-unit string. `formatUSDC` turns it back into `"125.00"`.

## 4. Check in

```ts
// checkin.ts
import { formatDeadline, getTimeUntilCheckin } from '@sorowill/sdk';
import { client, connect } from './sorowill';

await connect();
const willId = '1';

const will = await client.getWill(willId);
console.log(`Seconds until deadline: ${getTimeUntilCheckin(will)}`);

const { txHash, nextDeadline } = await client.checkIn(willId);
console.log(`Checked in (tx ${txHash}). Next deadline: ${formatDeadline(nextDeadline)}`);
```

**What's happening:**

- `checkIn` proves the owner is still active and resets the countdown. Your app should remind the owner to do this before every deadline.
- `nextDeadline` is calculated from the confirmed transaction time plus `checkinPeriodDays`.
- `getTimeUntilCheckin` and `isCheckinDue` are local helpers. They make no network calls.

## 5. Claim the inheritance

A claim takes two steps, because the contract has to give the owner a chance to respond:

1. **Trigger:** after the owner misses a check-in deadline, anyone can call `triggerWill`. The will becomes `Triggered` and the grace period starts.
2. **Release:** after the grace period ends, anyone can call `releaseInheritance`. The balance is split between the beneficiaries.

During the grace period the owner can cancel the trigger with `emergencyCheckIn(willId)`.

```ts
// claim.ts
import {
  CheckinNotDueError,
  GracePeriodNotExpiredError,
  WillStatus,
  calculateShares,
  formatUSDC,
  isCheckinDue,
} from '@sorowill/sdk';
import { client, connect } from './sorowill';

await connect(); // any funded account can submit, e.g. a beneficiary
const willId = '1';

let will = await client.getWill(willId);

// Step 1: trigger once the check-in deadline has passed.
if (will.status === WillStatus.Active) {
  if (!isCheckinDue(will)) {
    console.log('The owner is still within their check-in period.');
  } else {
    try {
      await client.triggerWill(willId);
      console.log('Will triggered. The grace period has started.');
    } catch (error) {
      if (error instanceof CheckinNotDueError) console.log('Deadline has not passed on-chain yet.');
      else throw error;
    }
  }
}

// Step 2: release once the grace period has expired.
will = await client.getWill(willId);
if (will.status === WillStatus.Triggered) {
  const shares = calculateShares(will.balance, will.beneficiaries);
  try {
    const { txHash } = await client.releaseInheritance(willId);
    console.log(`Released in tx ${txHash}`);
    for (const { address, share } of shares) {
      console.log(`  ${address}: ${formatUSDC(BigInt(share))} USDC`);
    }
  } catch (error) {
    if (error instanceof GracePeriodNotExpiredError) {
      console.log('The grace period is still running. Try again later.');
    } else {
      throw error;
    }
  }
}
```

**What's happening:**

- `triggerWill` and `releaseInheritance` don't need the owner's signature. A beneficiary, a guardian, or an automated keeper can submit them. The wallet that signs only pays the fee.
- `calculateShares` uses the same rounding as the contract (integer division, with any remainder going to the last beneficiary), so you can show exact payouts before releasing.
- Contract failures come back as typed errors, so you can handle "too early" separately from real failures. See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

## Full lifecycle in one file

```ts
// lifecycle.ts
import {
  SoroWillClient,
  WillStatus,
  connectWallet,
  formatDeadline,
  formatUSDC,
  toStroops,
} from '@sorowill/sdk';

const client = new SoroWillClient({
  network: 'testnet',
  contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
});

export async function runLifecycle(beneficiary: string): Promise<void> {
  await connectWallet();

  // Create
  const { willId } = await client.createWill({
    token: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    amount: toStroops('100').toString(),
    beneficiaries: [{ address: beneficiary, percentage: 100 }],
    checkinPeriodDays: 1,
    gracePeriodDays: 1,
    guardians: [],
  });

  // Top up
  await client.topUp(willId, toStroops('25').toString());

  // Check in
  const { nextDeadline } = await client.checkIn(willId);
  console.log(`Will #${willId}: next check-in by ${formatDeadline(nextDeadline)}`);

  // Claim: run this part later, from a scheduled job or the beneficiary's UI.
  const will = await client.getWill(willId);
  console.log(`Status ${will.status}, balance ${formatUSDC(BigInt(will.balance))} USDC`);
  if (will.status === WillStatus.Active && Date.now() > nextDeadline.getTime()) {
    await client.triggerWill(willId);
  }
  // ...after gracePeriodDays have passed:
  // await client.releaseInheritance(willId);
}
```

## Next steps

- [BEST_PRACTICES.md](./BEST_PRACTICES.md): rate limits, caching, and batching.
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md): common errors and how to fix them.
- [MIGRATION.md](./MIGRATION.md): upgrading from earlier releases.
