import { describe, expect, it } from 'vitest';
import { hexToBigInt, hexToBytes } from '../src/chainState.js';

describe('hexToBigInt', () => {
	it('decodes big-endian hex (with and without 0x)', () => {
		expect(hexToBigInt('ff')).toBe(255n);
		expect(hexToBigInt('0x0100')).toBe(256n);
	});

	it('treats empty / missing as zero', () => {
		expect(hexToBigInt('')).toBe(0n);
		expect(hexToBigInt(null)).toBe(null);
		expect(hexToBigInt(undefined)).toBe(null);
	});

	it('returns null for non-hex strings', () => {
		expect(hexToBigInt('nothex')).toBe(null);
		expect(hexToBigInt(123)).toBe(null);
	});
});

describe('hexToBytes', () => {
	it('decodes a byte array and enforces expected length', () => {
		const b = hexToBytes('00ff10', 3);
		expect(b).toEqual(new Uint8Array([0, 255, 16]));
		expect(hexToBytes('00ff10', 4)).toBe(null);
	});

	it('reads a big-endian int64 at a byte offset (BTC supply blob shape)', () => {
		// 32-byte blob, BaseFeeRate = 7 at offset 24.
		const hex = '00'.repeat(24) + '0000000000000007';
		const bytes = hexToBytes(hex, 32)!;
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		expect(Number(view.getBigInt64(24, false))).toBe(7);
	});

	it('returns null for malformed input', () => {
		expect(hexToBytes('abc')).toBe(null); // odd length
		expect(hexToBytes('zz')).toBe(null); // non-hex
		expect(hexToBytes(42)).toBe(null);
	});
});
