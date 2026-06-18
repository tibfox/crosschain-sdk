import type { PoolDepths, SwapCalcResult } from '../types/index.js';

/**
 * Hard cap on the pendulum stabilizer multiplier `m` in basis points.
 * 20000 bps = m = 2.0. Mirrors `DefaultStabilizerParamsBps.Cap` in
 * go-vsc-node `modules/incentive-pendulum/fees_int.go:59-66`. If that file's
 * `Cap` ever changes, change this constant in the same PR — otherwise the
 * worst-case floor below silently regresses and quotes over-promise output.
 */
export const STABILIZER_CAP_BPS = 20000n;
const BPS_SCALE = 10000n;

/**
 * Swap fee + output calculation using BigInt integer math.
 *
 * All amounts in smallest units (HIVE/HBD: 3 decimals, BTC: 8 decimals).
 *
 * Fees are denominated in the OUTPUT asset: the full `x` enters the pool,
 * the constant-product invariant produces a gross output, and fees are
 * carved off that.
 *
 *   grossOut         = Y − (X * Y) / (X + x)
 *   baseProtocolFee  = grossOut * 8 / 10000      (output units, floor 1)
 *   baseClpFee       = (x^2 * Y) / (x + X)^2     (output units, floor 1)
 *
 *   ─── STABILIZER WORST-CASE (m = 2.0 cap) ───
 *
 * The on-chain consensus code applies a pendulum stabilizer multiplier `m`
 * to BOTH fee legs at execution (`incentive-pendulum/wasm/applier.go`,
 * `fees_int.go`). `m` is bounded `m ∈ [1.0, 2.0]` where 2.0 is the hard cap
 * `DefaultStabilizerParamsBps.Cap`. The frontend can't know the live `m`
 * without re-implementing consensus geometry (the exact drift class this
 * codebase was bitten by), so we use the bound: compute `expectedOutput`
 * as if `m = 2.0` (the worst case).
 *
 *   chargedProtocol = baseProtocolFee * 20000 / 10000   (= base × 2)
 *   chargedClp      = baseClpFee      * 20000 / 10000
 *   totalFee        = chargedProtocol + chargedClp
 *   expectedOutput  = grossOut − totalFee
 *   minOut          = expectedOutput * (10000 − slippageBps) / 10000
 *
 * Guarantees: for any real on-chain m ∈ [1, 2], actualOutput ≥ expectedOutput,
 * so the contract's `actualOutput ≥ min_amount_out` gate always passes for the
 * stabilizer portion (slippage only has to absorb normal reserve drift between
 * sign and execute). The quote is pessimistic — invisible (~0.06%) on deep
 * HIVE/HBD pools, up to ~6.6% on the shallow BTC/HBD pool — but the user is
 * never under-delivered.
 *
 * The returned `baseFee` / `clpFee` / `totalFee` are the **charged** fees at
 * the stabilizer cap. UI that wants the unmultiplied base fees can recover
 * them as `totalFee / 2`. Ported from altera-app/src/lib/pools/swapCalc.ts
 * (incident "Altera Swap Quote ↔ On-Chain Pendulum Divergence", 2026-06-06).
 * Any change here must track the Altera formula.
 */
export function calculateSwap(
	x: bigint,
	X: bigint,
	Y: bigint,
	slippageBps: number
): SwapCalcResult {
	if (x <= 0n || X <= 0n || Y <= 0n) {
		return {
			baseFee: 0n,
			clpFee: 0n,
			totalFee: 0n,
			expectedOutput: 0n,
			minAmountOut: 0n,
			slippageBps
		};
	}

	// grossOut = Y - (X * Y) / (X + x)  — constant-product invariant, pre-fee
	const newX = X + x;
	const grossOut = Y - (X * Y) / newX;

	// Base fees, before stabilizer multiplier (mirror on-chain at m=1):
	let baseProtocolFee = (grossOut * 8n) / 10000n;
	if (baseProtocolFee === 0n) baseProtocolFee = 1n;

	let baseClpFee = (x * x * Y) / (newX * newX);
	if (baseClpFee === 0n) baseClpFee = 1n;

	// Apply the worst-case stabilizer multiplier (m = 2.0 at the cap) so the
	// resulting expectedOutput is a guaranteed FLOOR over any real m ∈ [1, 2].
	const baseFee = (baseProtocolFee * STABILIZER_CAP_BPS) / BPS_SCALE;
	const clpFee = (baseClpFee * STABILIZER_CAP_BPS) / BPS_SCALE;
	const totalFee = baseFee + clpFee;

	let expectedOutput = grossOut - totalFee;
	if (expectedOutput < 0n) expectedOutput = 0n;

	const slipBps = BigInt(Math.max(0, Math.min(slippageBps, 10000)));
	const minAmountOut = (expectedOutput * (10000n - slipBps)) / 10000n;

	return { baseFee, clpFee, totalFee, expectedOutput, minAmountOut, slippageBps };
}

/** Return `{ X, Y }` with X = reserve of `assetIn`, Y = reserve of the other asset. */
export function getOrderedDepthsFor(
	depths: PoolDepths,
	assetIn: string
): { X: bigint; Y: bigint } | null {
	const a = assetIn.toLowerCase();
	if (depths.asset0 === a) return { X: depths.reserve0, Y: depths.reserve1 };
	if (depths.asset1 === a) return { X: depths.reserve1, Y: depths.reserve0 };
	return null;
}

/**
 * Two-hop swap calc: input → hopAsset (via pool1) → output (via pool2).
 * Slippage applies only to the final output, matching router behavior.
 *
 * Fees are output-denominated at each hop: hop1 fees are in `hopAsset`,
 * hop2 fees are in `assetOut`. The top-level fee fields hold hop2 (in
 * `assetOut`); `hop1Fee` carries hop1's separately so callers can render
 * "<hop1Total> <hopAsset> and <hop2Total> <assetOut>".
 *
 * Ported from altera-app/src/lib/pools/swapCalc.ts:316-368.
 */
export function calculateTwoHopSwap(
	x: bigint,
	pool1: PoolDepths,
	pool2: PoolDepths,
	assetIn: string,
	hopAsset: string,
	_assetOut: string,
	slippageBps: number
): SwapCalcResult {
	const hop1Depths = getOrderedDepthsFor(pool1, assetIn);
	if (!hop1Depths) {
		return {
			baseFee: 0n,
			clpFee: 0n,
			totalFee: 0n,
			expectedOutput: 0n,
			minAmountOut: 0n,
			slippageBps
		};
	}
	const hop1 = calculateSwap(x, hop1Depths.X, hop1Depths.Y, 0);
	const hop1Fee = {
		asset: hopAsset,
		baseFee: hop1.baseFee,
		clpFee: hop1.clpFee,
		totalFee: hop1.totalFee
	};
	if (hop1.expectedOutput <= 0n) {
		return { ...hop1, slippageBps, hop1Fee };
	}

	const hop2Depths = getOrderedDepthsFor(pool2, hopAsset);
	if (!hop2Depths) {
		return {
			baseFee: 0n,
			clpFee: 0n,
			totalFee: 0n,
			expectedOutput: 0n,
			minAmountOut: 0n,
			slippageBps,
			hop1Fee
		};
	}
	const hop2 = calculateSwap(hop1.expectedOutput, hop2Depths.X, hop2Depths.Y, slippageBps);

	return {
		baseFee: hop2.baseFee,
		clpFee: hop2.clpFee,
		totalFee: hop2.totalFee,
		expectedOutput: hop2.expectedOutput,
		minAmountOut: hop2.minAmountOut,
		slippageBps,
		hop1Fee
	};
}

/** Ordered hop depths: X = reserve of the input side, Y = reserve of the
 *  output side. Produced by `getOrderedDepthsFor`. */
export interface OrderedDepths {
	X: bigint;
	Y: bigint;
}

/**
 * AMM price impact in percent (0–100) using the constant-product relation
 * `impact = x / (X + x)`. For a two-hop route the per-hop impacts compound:
 *
 *   combined = 1 − (1 − impact1) × (1 − impact2)
 *
 * `hop1`/`hop2` are ordered depths (X = input-side reserve). The intermediate
 * hop is sized from hop1's pre-fee gross output, matching `calculateSwap`'s
 * `grossOut` term. Floating-point division is safe — reserves are well below
 * `Number.MAX_SAFE_INTEGER`. Returns 0 when required depths are missing.
 *
 * Ported from altera-app/src/lib/pools/swapCalc.ts:392-434.
 */
export function calculatePriceImpact(
	x: bigint,
	hop1: OrderedDepths | null,
	hop2?: OrderedDepths | null
): number {
	if (x <= 0n || !hop1 || hop1.X <= 0n) return 0;
	const impact1 = Number(x) / Number(hop1.X + x);
	if (!hop2 || hop2.X <= 0n) return impact1 * 100;
	const hop1Out = (x * hop1.Y) / (hop1.X + x);
	if (hop1Out <= 0n) return impact1 * 100;
	const impact2 = Number(hop1Out) / Number(hop2.X + hop1Out);
	return (1 - (1 - impact1) * (1 - impact2)) * 100;
}

/**
 * True when input `x` would be rejected on-chain because it exceeds 50 % of
 * an input-side reserve. The contract hard-rejects any swap where the input
 * is greater than half the pool's input reserve (`x * 2 > X`). For two-hop
 * routes the intermediate output (net of fees) is also checked against the
 * second pool's input reserve.
 *
 * `hop1`/`hop2` are ordered depths (X = input-side reserve).
 *
 * Ported from altera-app/src/lib/pools/swapCalc.ts:446-486.
 */
export function checkExceedsPoolDepth(
	x: bigint,
	hop1: OrderedDepths | null,
	hop2?: OrderedDepths | null
): boolean {
	if (x <= 0n || !hop1) return false;
	if (hop1.X > 0n && x * 2n > hop1.X) return true;
	if (!hop2) return false;
	const hop1Out = calculateSwap(x, hop1.X, hop1.Y, 0).expectedOutput;
	return hop2.X > 0n && hop1Out * 2n > hop2.X;
}
