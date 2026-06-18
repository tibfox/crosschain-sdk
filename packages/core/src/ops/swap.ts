import type { CustomJsonOperation, TransferOperation } from '@hiveio/dhive';
import { CoinAmount } from '../currency/CoinAmount.js';
import type { DestinationChain, MagiConfig, ReferralConfig, SwapAsset } from '../types/index.js';

/**
 * Altera's exchange-fee referral preset. Inert by default — both `MAINNET_CONFIG`
 * and `TESTNET_CONFIG` ship `referral: null`, mirroring altera-app's
 * `ALTERA_FEE_ACTIVE = false`. Hosts that want to charge the Altera fee can pass
 * this as `config.referral`. `bps: 25` = 0.25%; it only applies to non-HIVE/HBD
 * (i.e. BTC) outbound swaps with a destination chain set — see `referralQualifies`.
 * Mirrors `ALTERA_FEE_BENEFICIARY` / `ALTERA_FEE_BPS` / `ALTERA_FEE_USD_THRESHOLD`
 * in altera-app/src/lib/magiTransactions/hive/vscOperations/swap.ts.
 */
export const ALTERA_REFERRAL: ReferralConfig = {
	beneficiary: 'hive:altera.app',
	bps: 25,
	usdThreshold: 0
};

/**
 * Build the L1 → Magi deposit operation. Sends `amount` of HIVE or HBD from
 * the user's Hive L1 account to the Magi gateway account with a memo that
 * tells the gateway to credit `toDid` on Magi.
 *
 * Ported from altera-app/src/lib/magiTransactions/hive/vscOperations/deposit.ts.
 */
export function getHiveDepositOp(params: {
	from: string;
	toDid: string;
	amount: CoinAmount;
	config: MagiConfig;
	extraMemoParams?: URLSearchParams;
}): TransferOperation {
	const { from, toDid, amount, config, extraMemoParams } = params;
	if (amount.asset !== 'HIVE' && amount.asset !== 'HBD') {
		throw new Error(`getHiveDepositOp: asset must be HIVE or HBD, got ${amount.asset}`);
	}
	const chainUnit =
		amount.asset === 'HBD'
			? (config.hbdAssetName ?? 'HBD')
			: (config.hiveAssetName ?? 'HIVE');
	const defaultMemo = new URLSearchParams(`to=${toDid.split(':').at(-1) ?? ''}`);
	const memo = extraMemoParams
		? new URLSearchParams([...defaultMemo, ...extraMemoParams])
		: defaultMemo;
	return [
		'transfer',
		{
			from,
			to: config.gatewayAccount,
			amount: `${amount.toDecimalString()} ${chainUnit}`,
			memo: memo.toString()
		}
	];
}

/**
 * Grant the DEX router allowance to spend exactly `amount` BTC (in sats) on the
 * BTC-mapping contract, so a BTC-input swap op can pull it. Uses
 * `increaseAllowance` (additive per op, matched to the swap amount) rather than
 * approving an arbitrarily large number. Emit this BEFORE `getHiveSwapOp` in the
 * same tx when `assetIn` is BTC.
 *
 * `CoinAmount.raw` for BTC is already in sats (decimals = 8), so it's passed
 * through as the base-unit value the contract expects.
 *
 * Ported from altera-app/src/lib/magiTransactions/hive/vscOperations/swap.ts
 * (`getBtcApproveOp`).
 */
export function getBtcApproveOp(params: {
	username: string;
	amount: CoinAmount;
	config: MagiConfig;
	/** Override the op's `rc_limit` (default 1000, matching Altera). */
	rcLimit?: number;
}): CustomJsonOperation {
	const { username, amount, config, rcLimit } = params;
	if (amount.asset !== 'BTC') {
		throw new Error(`getBtcApproveOp: asset must be BTC, got ${amount.asset}`);
	}
	const caller = `hive:${username}`;
	const op = {
		net_id: config.network,
		caller,
		contract_id: config.btcMappingContractId,
		action: 'increaseAllowance',
		payload: JSON.stringify({
			spender: `contract:${config.dexRouterContractId}`,
			amount: amount.raw.toString()
		}),
		rc_limit: rcLimit ?? 1000,
		intents: [] as Array<{ type: string; args: Record<string, string> }>
	};
	return [
		'custom_json',
		{
			required_auths: [username],
			required_posting_auths: [],
			id: 'vsc.call',
			json: JSON.stringify(op)
		}
	];
}

/**
 * Build the DEX-router swap call as a Hive `custom_json` operation.
 *
 * For HIVE/HBD input, a `transfer.allow` intent is attached (native allowance).
 * For BTC input, the intent is empty — caller must separately emit
 * `getBtcApproveOp` before this op in the same tx.
 *
 * When `referral` is provided AND the swap qualifies (destination_chain is set
 * and output asset is not HIVE/HBD), the `beneficiary` + `ref_bps` fields are
 * added to the payload and `minAmountOut` is scaled down by `bps` to match
 * what the router will actually deliver after the referral fee skim.
 *
 * Ported from altera-app/src/lib/magiTransactions/hive/vscOperations/swap.ts
 * (commit 6ff1104 — "inject Altera referral fee on outbound mainnet swaps").
 */
export function getHiveSwapOp(params: {
	username: string;
	amountIn: CoinAmount;
	assetIn: SwapAsset;
	assetOut: SwapAsset;
	minAmountOut?: bigint;
	destinationChain?: DestinationChain;
	destinationRecipient?: string;
	config: MagiConfig;
	/** Override the referral config for this op. Defaults to `config.referral`. */
	referralOverride?: ReferralConfig | null;
	/**
	 * Independent decision — the caller supplies whether the swap
	 * qualifies for a referral fee. Computed externally because it
	 * requires a price lookup which is not this function's job.
	 */
	referralQualifies?: boolean;
	/**
	 * Override the op's `rc_limit`. When omitted, falls back to a hardcoded
	 * default (10000 for cross-chain, 2000 otherwise). Callers that run a
	 * simulation first should pass `computeBroadcastRcLimit(simRcLimit, rcUsed)`
	 * here so the broadcast rc_limit stays within the caller's available RC.
	 * See vsc-explorer's Contract.tsx (rcLimitInt) for the reference flow.
	 */
	rcLimit?: number;
}): CustomJsonOperation {
	const {
		username,
		amountIn,
		assetIn,
		assetOut,
		minAmountOut,
		destinationChain,
		destinationRecipient,
		config,
		referralQualifies,
		rcLimit
	} = params;

	const referral =
		params.referralOverride === undefined ? config.referral : params.referralOverride;

	const caller = `hive:${username}`;
	const isNative = assetIn === 'HIVE' || assetIn === 'HBD';

	const feeActive = !!(referral && referralQualifies);
	const finalMinAmountOut =
		feeActive && minAmountOut !== undefined
			? (minAmountOut * BigInt(10000 - referral!.bps)) / 10000n
			: minAmountOut;

	const payload: Record<string, string | number> = {
		type: 'swap',
		version: '1.0.0',
		asset_in: assetIn,
		asset_out: assetOut,
		amount_in: amountIn.raw.toString(),
		min_amount_out: finalMinAmountOut !== undefined ? finalMinAmountOut.toString() : '0',
		recipient: destinationRecipient ?? caller
	};
	if (destinationChain) payload.destination_chain = destinationChain;
	if (feeActive) {
		payload.beneficiary = referral!.beneficiary;
		payload.ref_bps = referral!.bps;
	}

	const op = {
		net_id: config.network,
		caller,
		contract_id: config.dexRouterContractId,
		action: 'execute',
		payload: JSON.stringify(payload),
		rc_limit: rcLimit ?? (destinationChain ? 10000 : 2000),
		intents: isNative
			? [
					{
						type: 'transfer.allow',
						args: {
							limit: amountIn.toDecimalString(),
							token: assetIn.toLowerCase()
						}
					}
				]
			: ([] as Array<{ type: string; args: Record<string, string> }>)
	};

	return [
		'custom_json',
		{
			required_auths: [username],
			required_posting_auths: [],
			id: 'vsc.call',
			json: JSON.stringify(op)
		}
	];
}

/**
 * Return a copy of an existing `custom_json` swap op with the inner
 * `rc_limit` replaced. Used to finalize the broadcast rc_limit after a
 * simulation without re-running the full `buildQuickSwap` pipeline (preview
 * lookups, referral quoting, etc.).
 *
 * Typed structurally so consumers don't need `@hiveio/dhive`; the return
 * type is the same shape as `CustomJsonOperation` and is assignable back
 * into the `build.ops` array.
 */
export function withSwapOpRcLimit(op: unknown, rcLimit: number): CustomJsonOperation {
	if (!Array.isArray(op) || op[0] !== 'custom_json') {
		throw new Error('withSwapOpRcLimit: expected a custom_json op');
	}
	const body = op[1] as { json?: unknown } & Record<string, unknown>;
	if (!body || typeof body.json !== 'string') {
		throw new Error('withSwapOpRcLimit: custom_json op missing `json` body');
	}
	const inner = JSON.parse(body.json) as Record<string, unknown>;
	const nextInner = { ...inner, rc_limit: rcLimit };
	const out: unknown = [
		'custom_json',
		{
			...body,
			json: JSON.stringify(nextInner)
		}
	];
	return out as CustomJsonOperation;
}

/** Convenience: decide whether a referral fee applies for this swap shape. */
export function referralQualifies(params: {
	assetOut: SwapAsset;
	destinationChain?: DestinationChain;
	inputUsd: number;
	referral: ReferralConfig | null | undefined;
}): boolean {
	const { assetOut, destinationChain, inputUsd, referral } = params;
	if (!referral) return false;
	if (!destinationChain) return false;
	if (assetOut === 'HIVE' || assetOut === 'HBD') return false;
	const threshold = referral.usdThreshold ?? 0;
	return Number.isFinite(inputUsd) && inputUsd >= threshold;
}
