# @vsc.eco/crosschain-core

Pure swap math and operation builders for the Magi (VSC) L2 DEX. Zero runtime dependencies, no network calls.

Ports the CLP swap formula from the Altera app and emits the exact L1 ops (`transfer` + `custom_json`) that the router expects, so callers can preview, build, and broadcast swaps without any framework.

## Install

```sh
pnpm add @vsc.eco/crosschain-core
```

## Usage

```ts
import {
  calculateSwap,
  getHiveDepositOp,
  getHiveSwapOp,
  CoinAmount,
  MAINNET_CONFIG
} from '@vsc.eco/crosschain-core';

const amount = CoinAmount.fromDecimal('10', 'HBD');

const { expectedOutput, minAmountOut } = calculateSwap(
  amount.raw,
  reserveIn,
  reserveOut,
  100 // 1% slippage, in bps
);

const depositOp = getHiveDepositOp({
  from: 'alice',
  toDid: 'hive:alice',
  amount,
  config: MAINNET_CONFIG
});
```

## Fees & quote semantics

`calculateSwap` mirrors the on-chain DEX, **including the pendulum stabilizer**.
The router multiplies both fee legs (protocol + CLP) by a stabilizer factor
`m ∈ [1.0, 2.0]` at execution. The frontend can't know the live `m` without
re-implementing consensus geometry, so the math uses the worst case
(`m = STABILIZER_CAP_BPS / 10000 = 2.0`):

- `baseFee` / `clpFee` / `totalFee` are the **charged** fees at the cap
  (= unmultiplied base × 2; recover the base as `totalFee / 2`).
- `expectedOutput = grossOut − totalFee` is a guaranteed **floor** — for any
  real on-chain `m`, the user receives at least this much, so the contract's
  `actualOutput ≥ min_amount_out` gate always passes for the stabilizer
  portion. Quotes are pessimistic, never over-promising.

⚠️ `STABILIZER_CAP_BPS` mirrors go-vsc-node
`incentive-pendulum/fees_int.go DefaultStabilizerParamsBps.Cap`. If that cap
changes, update the constant in the same release.

Route guards and the extra op builder:

```ts
import {
  calculatePriceImpact, // % (0–100); single- or two-hop (impacts compound)
  checkExceedsPoolDepth, // true when input > 50% of an input-side reserve
  getBtcApproveOp,       // increaseAllowance for BTC-input swaps
  ALTERA_REFERRAL        // inert exchange-fee preset (config.referral)
} from '@vsc.eco/crosschain-core';
```

## See also

- [`@vsc.eco/crosschain-sdk`](https://github.com/vsc-eco/crosschain-sdk/tree/main/packages/sdk) — higher-level client with pool/price/balance providers and `quickSwap()`.
- [`@vsc.eco/crosschain-widget`](https://github.com/vsc-eco/crosschain-sdk/tree/main/packages/widget) — drop-in React + web component UI.
- [Repository README](https://github.com/vsc-eco/crosschain-sdk#readme) — full architecture, routing rules, swap paths.
