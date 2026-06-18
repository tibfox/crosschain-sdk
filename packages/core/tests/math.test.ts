import { describe, expect, it } from 'vitest';
import {
	calculateSwap,
	calculateTwoHopSwap,
	calculatePriceImpact,
	checkExceedsPoolDepth
} from '../src/math/swap.js';
import type { PoolDepths } from '../src/types/index.js';

/**
 * Math validation for the output-denominated fee model introduced in the
 * Go contract, now including the pendulum stabilizer worst-case (m = 2.0).
 * Pool state is taken from the pre-swap state of tx `9a6ad6c7...` (vaultec's
 * 100 HBD → BTC swap at block 105609427) so the inputs remain a realistic
 * fixture, but expected values are computed from the formula:
 *
 *   grossOut        = Y − (X*Y) / (X + x)
 *   baseProtocol    = grossOut * 8 / 10000                  (floor 1)
 *   baseClp         = (x^2 * Y) / (x + X)^2                 (floor 1)
 *   baseFee/clpFee  = base × STABILIZER_CAP_BPS / 10000     (= base × 2)
 *   amountOut       = grossOut − baseFee − clpFee
 *
 * BTC reserve: 661_105 sats, HBD reserve: 504_685 mHBD, input 100_000 mHBD.
 */
describe('calculateSwap — output-denominated fees + stabilizer cap', () => {
	it('produces amount_out at the worst-case stabilizer (m = 2.0)', () => {
		const x = 100_000n;
		const X = 504_685n; // HBD reserve (input side)
		const Y = 661_105n; // BTC reserve (output side)
		const result = calculateSwap(x, X, Y, 100);

		// grossOut = 661105 − floor(504685*661105 / 604685) = 661105 − 551774 = 109331
		// baseProtocol = floor(109331 * 8 / 10000) = 87 → charged 87*2 = 174
		// baseClp      = floor(100000^2 * 661105 / 604685^2) = 18080 → charged 36160
		// amountOut = 109331 − 174 − 36160 = 72997
		expect(result.baseFee).toBe(174n);
		expect(result.clpFee).toBe(36_160n);
		expect(result.expectedOutput).toBe(72_997n);
	});

	it('decomposes charged fees and exposes base via totalFee / 2', () => {
		const x = 100_000n;
		const X = 504_685n;
		const Y = 661_105n;
		const result = calculateSwap(x, X, Y, 0);

		expect(result.baseFee).toBe(174n);
		expect(result.clpFee).toBe(36_160n);
		expect(result.totalFee).toBe(36_334n);
		// Unmultiplied base fees recoverable as totalFee / 2.
		expect(result.totalFee / 2n).toBe(18_167n);
	});

	it('returns zeros for invalid inputs', () => {
		expect(calculateSwap(0n, 100n, 100n, 100).expectedOutput).toBe(0n);
		expect(calculateSwap(100n, 0n, 100n, 100).expectedOutput).toBe(0n);
		expect(calculateSwap(100n, 100n, 0n, 100).expectedOutput).toBe(0n);
	});

	it('applies slippage to minAmountOut correctly', () => {
		const x = 100_000n;
		const X = 504_685n;
		const Y = 661_105n;
		// 1% slippage — min = expected * 9900 / 10000
		const result = calculateSwap(x, X, Y, 100);
		const expectedMin = (72_997n * 9900n) / 10000n;
		expect(result.minAmountOut).toBe(expectedMin);
	});

	it('floors base fees at 1 pre-multiply (charged minimum is 2)', () => {
		// Tiny trade into a huge pool — both base fee components compute < 1
		// pre-floor, floor to 1, then the stabilizer cap doubles them to 2.
		const result = calculateSwap(1n, 10n ** 12n, 10n ** 12n, 0);
		expect(result.baseFee).toBe(2n);
		expect(result.clpFee).toBe(2n);
	});
});

describe('calculateTwoHopSwap — HIVE → HBD → BTC', () => {
	it('routes through HBD hop and produces a non-zero output for a plausible trade', () => {
		// Approx pool states on 2026-04-17 for HIVE/HBD and BTC/HBD
		const hiveHbd: PoolDepths = {
			contractId: 'dummy1',
			asset0: 'hbd',
			asset1: 'hive',
			reserve0: 502_180n,
			reserve1: 8_108_542n
		};
		const btcHbd: PoolDepths = {
			contractId: 'dummy2',
			asset0: 'btc',
			asset1: 'hbd',
			reserve0: 568_858n,
			reserve1: 600_145n
		};
		const result = calculateTwoHopSwap(
			30_000n, // 30 HIVE
			hiveHbd,
			btcHbd,
			'hive',
			'hbd',
			'btc',
			100
		);
		expect(result.expectedOutput).toBeGreaterThan(0n);
		// Two-hop should be less than single-hop at ideal rate — just sanity.
		expect(result.expectedOutput).toBeLessThan(10_000n);
	});
});

describe('calculatePriceImpact', () => {
	it('single-hop impact = x / (X + x)', () => {
		// 100 into a 900 input reserve → 100/1000 = 10%
		expect(calculatePriceImpact(100n, { X: 900n, Y: 5_000n })).toBeCloseTo(10, 6);
	});

	it('compounds across two hops as 1 − (1 − i1)(1 − i2)', () => {
		const hop1 = { X: 900n, Y: 900n }; // i1 = 100/1000 = 0.1, hop1Out = floor(100*900/1000)=90
		const hop2 = { X: 810n, Y: 5_000n }; // i2 = 90/900 = 0.1
		// combined = 1 − 0.9*0.9 = 0.19 → 19%
		expect(calculatePriceImpact(100n, hop1, hop2)).toBeCloseTo(19, 6);
	});

	it('returns 0 for missing depths or non-positive input', () => {
		expect(calculatePriceImpact(0n, { X: 100n, Y: 100n })).toBe(0);
		expect(calculatePriceImpact(100n, null)).toBe(0);
		expect(calculatePriceImpact(100n, { X: 0n, Y: 100n })).toBe(0);
	});
});

describe('checkExceedsPoolDepth', () => {
	it('rejects input over 50% of the single-hop input reserve', () => {
		expect(checkExceedsPoolDepth(501n, { X: 1_000n, Y: 1_000n })).toBe(true);
		expect(checkExceedsPoolDepth(500n, { X: 1_000n, Y: 1_000n })).toBe(false);
	});

	it('checks both hops on a two-hop route', () => {
		// hop1 input well under 50%, but the intermediate output blows past
		// the shallow second pool's input reserve.
		const hop1 = { X: 1_000_000n, Y: 1_000_000n };
		const hop2 = { X: 10n, Y: 1_000n };
		expect(checkExceedsPoolDepth(100n, hop1, hop2)).toBe(true);
	});

	it('returns false for non-positive input or missing hop1', () => {
		expect(checkExceedsPoolDepth(0n, { X: 1_000n, Y: 1_000n })).toBe(false);
		expect(checkExceedsPoolDepth(100n, null)).toBe(false);
	});
});
