import { describe, expect, it } from 'vitest';
import { btcUnmapFeeForRate } from '../src/btcFee.js';

/**
 * Exact integer fee math mirrored from the BTC-mapping contract. Expected
 * values are hand-derived from the vSize formula so a drift in the byte
 * constants or the witness-discount rounding fails the test:
 *
 *   1 input:  nonWitness = 10 + 41 + 43 = 94,  witness = 72+112+5 = 189
 *             vSize = floor((94*3 + (94+189) + 3)/4) + 2 = floor(568/4)+2 = 144
 *   3 inputs: nonWitness = 10 + 123 + 43 = 176, witness = 3*189 = 567
 *             vSize = floor((176*3 + (176+567) + 3)/4) + 2 = floor(1274/4)+2 = 320
 */
describe('btcUnmapFeeForRate', () => {
	it('computes the 1-input / 3-input sat range at rate 1', () => {
		expect(btcUnmapFeeForRate(1)).toEqual({ feeRate: 1, minSats: 144, maxSats: 320 });
	});

	it('scales linearly with the fee rate', () => {
		expect(btcUnmapFeeForRate(10)).toEqual({ feeRate: 10, minSats: 1440, maxSats: 3200 });
	});

	it('clamps a sub-1 rate up to 1', () => {
		expect(btcUnmapFeeForRate(0)).toEqual({ feeRate: 1, minSats: 144, maxSats: 320 });
		expect(btcUnmapFeeForRate(-5)).toEqual({ feeRate: 1, minSats: 144, maxSats: 320 });
	});

	it('clamps a rate above the 1000 sat/vbyte ceiling', () => {
		expect(btcUnmapFeeForRate(5000)).toEqual({
			feeRate: 1000,
			minSats: 144_000,
			maxSats: 320_000
		});
	});

	it('keeps minSats < maxSats (1 input is cheaper than 3)', () => {
		const f = btcUnmapFeeForRate(7);
		expect(f.minSats).toBeLessThan(f.maxSats);
	});
});
