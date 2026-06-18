import {
	MAINNET_CONFIG,
	TESTNET_CONFIG,
	withSwapOpRcLimit,
	type MagiConfig,
	type SwapAsset
} from '@vsc.eco/crosschain-core';
import { buildQuickSwap, type QuickSwapInput, type QuickSwapBuildResult } from './quickSwap.js';
import { createDefaultPoolProvider, type PoolProvider } from './poolProvider.js';
import type { PriceProvider } from './priceProvider.js';
import {
	requestBtcDepositAddress,
	type BtcDepositRequest,
	type BtcDepositResult
} from './mappingBot.js';
import { createHiveBalanceProvider, type BalanceProvider } from './balanceProvider.js';
import { estimateBtcUnmapFee, type BtcFeeEstimate } from './btcFee.js';
import {
	checkSwapRc,
	computeBroadcastRcLimit,
	computeSimRcLimit,
	getAccountRc,
	simCallFromSwapOp,
	simulateSwapCall,
	type AccountRc,
	type RcCheckResult,
	type SimulateResult,
	type SwapCallSpec
} from './rc.js';

export { MAINNET_CONFIG, TESTNET_CONFIG } from '@vsc.eco/crosschain-core';
export type {
	MagiConfig,
	SwapAsset,
	ReferralConfig,
	SwapCalcResult,
	OrderedDepths
} from '@vsc.eco/crosschain-core';
export { CoinAmount } from '@vsc.eco/crosschain-core';
// Re-export the pure swap math + op builders + presets so widget/host code can
// import everything from the SDK entry point.
export {
	calculateSwap,
	calculateTwoHopSwap,
	calculatePriceImpact,
	checkExceedsPoolDepth,
	getOrderedDepthsFor,
	STABILIZER_CAP_BPS,
	getHiveDepositOp,
	getHiveSwapOp,
	getBtcApproveOp,
	referralQualifies,
	withSwapOpRcLimit,
	ALTERA_REFERRAL
} from '@vsc.eco/crosschain-core';
export { createDefaultPoolProvider } from './poolProvider.js';
export { createPoolPriceProvider } from './priceProvider.js';
export { createHiveBalanceProvider } from './balanceProvider.js';
export { getStateByKeys, hexToBigInt, hexToBytes } from './chainState.js';
export { estimateBtcUnmapFee, fetchBtcBaseFeeRate } from './btcFee.js';
export type { PoolProvider } from './poolProvider.js';
export type { PriceProvider } from './priceProvider.js';
export type { BalanceProvider } from './balanceProvider.js';
export type { QuickSwapInput, QuickSwapBuildResult, SwapPreview } from './quickSwap.js';
export type { BtcDepositRequest, BtcDepositResult } from './mappingBot.js';
export type { BtcFeeEstimate } from './btcFee.js';
export {
	checkSwapRc,
	computeBroadcastRcLimit,
	computeSimRcLimit,
	getAccountRc,
	simCallFromSwapOp,
	simulateSwapCall
} from './rc.js';
export type { AccountRc, RcCheckResult, SimulateResult, SwapCallSpec } from './rc.js';

export interface AiohaLike {
	signAndBroadcastTx(
		operations: unknown[],
		keyType: unknown
	): Promise<
		{ success: boolean; result?: string; error?: string } | { success: true; result: string }
	>;
}

export interface CreateMagiOptions {
	config?: MagiConfig;
	aioha?: AiohaLike;
	pools?: PoolProvider;
	prices?: PriceProvider;
	balances?: BalanceProvider;
}

export interface MagiClient {
	config: MagiConfig;
	pools: PoolProvider;
	prices?: PriceProvider;
	balances: BalanceProvider;
	buildQuickSwap: (input: QuickSwapInput) => Promise<QuickSwapBuildResult>;
	quickSwap: (input: QuickSwapInput, keyType?: unknown) => Promise<QuickSwapResult>;
	getBtcDepositAddress: (req: BtcDepositRequest) => Promise<BtcDepositResult>;
	getBalance: (username: string, asset: SwapAsset) => Promise<bigint | null>;
	getAccountRc: (account: string) => Promise<AccountRc>;
	simulateSwap: (params: {
		username: string;
		build: QuickSwapBuildResult;
	}) => Promise<SimulateResult>;
	checkSwapRc: (params: {
		username: string;
		build: QuickSwapBuildResult;
	}) => Promise<RcCheckResult>;
	/** Approximate BTC network-fee range (sats) for a withdrawal to a BTC
	 *  mainnet address. Null when the contract fee rate can't be read. */
	estimateBtcUnmapFee: () => Promise<BtcFeeEstimate | null>;
}

export interface QuickSwapResult {
	/** The build returned by `buildQuickSwap`, with the swap op's `rc_limit`
	 *  replaced by the sim-derived `broadcastRcLimit` before broadcast. */
	build: QuickSwapBuildResult;
	/** RC check that gated the broadcast. `simRcLimit` and `broadcastRcLimit`
	 *  are the values actually used. */
	rcCheck: RcCheckResult;
	txId: string;
}

export function createMagi(opts: CreateMagiOptions = {}): MagiClient {
	const config = opts.config ?? MAINNET_CONFIG;
	const pools = opts.pools ?? createDefaultPoolProvider(config);
	const prices = opts.prices;
	const balances = opts.balances ?? createHiveBalanceProvider();
	const aioha = opts.aioha;

	return {
		config,
		pools,
		prices,
		balances,
		async buildQuickSwap(input) {
			return buildQuickSwap(input, { config, pools, prices });
		},
		async quickSwap(input, keyType) {
			if (!aioha) {
				throw new Error(
					'createMagi was called without `aioha`; pass an Aioha instance to sign, or use buildQuickSwap() and broadcast yourself.'
				);
			}
			const build = await buildQuickSwap(input, { config, pools, prices });
			const swapOpIndex = build.ops.length - 1;
			const call = simCallFromSwapOp(build.ops[swapOpIndex]);
			const rcCheck = await checkSwapRc(config, { username: input.username, call });
			if (!rcCheck.simOk) {
				throw new Error(
					`quickSwap simulation failed: ${rcCheck.errMsg ?? rcCheck.err ?? 'unknown'}`
				);
			}
			const tightenedOps = [...build.ops];
			tightenedOps[swapOpIndex] = withSwapOpRcLimit(
				build.ops[swapOpIndex],
				rcCheck.broadcastRcLimit
			);
			const finalBuild: QuickSwapBuildResult = { ...build, ops: tightenedOps };
			const res = await aioha.signAndBroadcastTx(tightenedOps, keyType);
			if (!res.success) {
				const err = 'error' in res ? res.error : 'unknown';
				throw new Error(`signAndBroadcastTx failed: ${err ?? 'unknown'}`);
			}
			if (!('result' in res) || typeof res.result !== 'string') {
				throw new Error('signAndBroadcastTx returned success but no tx id');
			}
			return { build: finalBuild, rcCheck, txId: res.result };
		},
		async getBtcDepositAddress(req) {
			return requestBtcDepositAddress(req, config);
		},
		async getBalance(username, asset) {
			return balances.getBalance(username, asset);
		},
		async getAccountRc(account) {
			return getAccountRc(config, account);
		},
		async simulateSwap({ username, build }) {
			const call = simCallFromSwapOp(build.ops[build.ops.length - 1]);
			const rc = await getAccountRc(config, `hive:${username}`);
			const rcLimit = computeSimRcLimit(rc.amount, call);
			return simulateSwapCall(config, { username, call, rcLimit });
		},
		async checkSwapRc({ username, build }) {
			const call = simCallFromSwapOp(build.ops[build.ops.length - 1]);
			return checkSwapRc(config, { username, call });
		},
		async estimateBtcUnmapFee() {
			return estimateBtcUnmapFee(config);
		}
	};
}
