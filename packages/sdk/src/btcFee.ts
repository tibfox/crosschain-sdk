import type { MagiConfig } from '@vsc.eco/crosschain-core';
import { getStateByKeys, hexToBytes } from './chainState.js';

/**
 * Mirror of the VSC BTC-mapping contract's own fee math (constants.go /
 * utils.go). The contract stores a 32-byte "supply" blob at state key "s"
 * holding four big-endian int64s; `BaseFeeRate` (sat/vbyte) lives at offset
 * 24-31. At use time the contract clamps the rate to [1, MaxBaseFeeRate]. We
 * replicate the clamp + vSize math so a UI can show an approximate
 * network-fee range before the contract actually picks UTXOs.
 *
 * Ported from altera-app/src/lib/magiTransactions/bitcoin/btcFeeEstimate.ts.
 */
const SUPPLY_STATE_KEY = 's';
const MAX_BASE_FEE_RATE = 1000;

function clampedFeeRate(rate: number): number {
	if (rate > MAX_BASE_FEE_RATE) return MAX_BASE_FEE_RATE;
	if (rate < 1) return 1;
	return rate;
}

function estimateVSize(nonWitnessSize: number, witnessDataSize: number): number {
	const totalSize = nonWitnessSize + witnessDataSize;
	return Math.floor((nonWitnessSize * 3 + totalSize + 3) / 4) + 2;
}

/**
 * Base-case fee (single destination output, no contract change outputs). The
 * contract may add P2WSH change outputs we can't predict here, so the result
 * is a lower bound matching the minimum the contract would ever charge.
 */
function estimateBaseFeeSats(numInputs: number, feeRate: number): number {
	const baseSize = 10;
	const inputSize = numInputs * 41;
	const outputSize = 43;
	const nonWitnessSize = baseSize + inputSize + outputSize;
	// Per input: sig(72) + 112-byte deposit-tag witness script (conservative
	// upper bound used by the contract) + 5 bytes of length prefixes.
	const witnessDataSize = numInputs * (72 + 112 + 5);
	const vSize = estimateVSize(nonWitnessSize, witnessDataSize);
	return vSize * clampedFeeRate(feeRate);
}

export interface BtcFeeEstimate {
	/** Clamped sat/vbyte rate the contract would use. */
	feeRate: number;
	/** Fee for a 1-input unmap (sats). */
	minSats: number;
	/** Fee for a 3-input unmap (sats). */
	maxSats: number;
}

/** Read the contract's current `BaseFeeRate` (sat/vbyte), or null on failure. */
export async function fetchBtcBaseFeeRate(config: MagiConfig): Promise<number | null> {
	try {
		const state = await getStateByKeys(config, config.btcMappingContractId, [
			SUPPLY_STATE_KEY
		]);
		const bytes = hexToBytes(state[SUPPLY_STATE_KEY], 32);
		if (!bytes) return null;
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		// Offsets: 0 ActiveSupply, 8 UserSupply, 16 FeeSupply, 24 BaseFeeRate.
		const baseFeeRate = view.getBigInt64(24, false);
		return Number(baseFeeRate);
	} catch {
		return null;
	}
}

/**
 * Estimate the BTC network fee range for an unmap (withdrawal to a BTC
 * mainnet address), as a [1-input, 3-input] sat range. Returns null when the
 * fee rate can't be read.
 */
export async function estimateBtcUnmapFee(config: MagiConfig): Promise<BtcFeeEstimate | null> {
	const feeRate = await fetchBtcBaseFeeRate(config);
	if (feeRate == null) return null;
	const clamped = clampedFeeRate(feeRate);
	return {
		feeRate: clamped,
		minSats: estimateBaseFeeSats(1, clamped),
		maxSats: estimateBaseFeeSats(3, clamped)
	};
}
