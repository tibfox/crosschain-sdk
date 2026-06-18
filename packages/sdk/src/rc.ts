import type { MagiConfig } from '@vsc.eco/crosschain-core';
import { gqlPost } from './gql.js';

export interface AccountRc {
	account: string;
	amount: bigint;
	maxRcs: bigint;
	blockHeight: bigint;
}

export interface SimulateResult {
	success: boolean;
	rcUsed: bigint;
	/** The `rc_limit` value actually used in the simulation. Matches what the
	 *  caller passed as `rcLimit`, or — when computed via the aligned path —
	 *  `accountRc.amount - hbdIntentReserve`. Useful to forward into
	 *  `computeBroadcastRcLimit` when building the real broadcast op. */
	simRcLimit: number;
	err?: string;
	errMsg?: string;
}

export interface RcCheckResult {
	simOk: boolean;
	rcUsed: bigint;
	rcAvailable: bigint;
	sufficient: boolean;
	/** `max(0, rcUsed - rcAvailable)`. RC units are 1 HBD = 1000 RC,
	 *  so divide by 1000 for user-facing HBD display. */
	rcShortfall: bigint;
	/** Aligned `rc_limit` passed to the simulation (= vsc-explorer's
	 *  `balance.rc.amount - ceil(intents.hbd * 1000)`). Low enough to keep the
	 *  node's HBD-exclusion-against-RC at or below the caller's actual HBD so
	 *  the sim's intent pull isn't spuriously rejected as "insufficient
	 *  balance". Forward this into `computeBroadcastRcLimit` to size the real
	 *  broadcast. */
	simRcLimit: number;
	/** Recommended `rc_limit` for the real broadcast, clamped to the caller's
	 *  available RC: `min(ceil(rcUsed * 1.25), simRcLimit)`. Mirrors
	 *  vsc-explorer's `rcLimitInt` formula. */
	broadcastRcLimit: number;
	err?: string;
	errMsg?: string;
}

/** Sim-ready contract call — shape mirrors `SimulateContractCallInput`. */
export interface SwapCallSpec {
	contract_id: string;
	action: string;
	payload: string;
	rc_limit: number;
	intents: Array<{ type: string; args: Record<string, string> }>;
}

export async function getAccountRc(
	config: MagiConfig,
	account: string
): Promise<AccountRc> {
	const data = await gqlPost<{
		getAccountRC: {
			account: string;
			amount: string | number;
			max_rcs: string | number;
			block_height: string | number;
		} | null;
	}>(config, {
		query:
			'query($account: String!) { getAccountRC(account: $account) { account amount max_rcs block_height } }',
		variables: { account }
	});
	const rec = data.getAccountRC;
	if (!rec) throw new Error(`No RC record for ${account}`);
	return {
		account: rec.account,
		amount: BigInt(rec.amount),
		maxRcs: BigInt(rec.max_rcs),
		blockHeight: BigInt(rec.block_height)
	};
}

/**
 * Sum HBD-denominated `transfer.allow` intent limits, in milli-HBD units. The
 * VSC runtime only applies RC-exclusion-against-balance to HBD pulls (see
 * execution-context.go `PullBalance`) so only HBD intents reduce the usable
 * rc_limit.
 */
function hbdIntentReserve(call: SwapCallSpec): bigint {
	let reserve = 0n;
	for (const intent of call.intents) {
		if (intent.type !== 'transfer.allow') continue;
		if ((intent.args.token ?? '').toLowerCase() !== 'hbd') continue;
		const limit = intent.args.limit;
		if (!limit) continue;
		const [whole = '0', frac = ''] = limit.split('.');
		const padded = (frac + '000').slice(0, 3);
		reserve += BigInt(whole || '0') * 1000n + BigInt(padded || '0');
	}
	return reserve;
}

/**
 * Compute the simulation `rc_limit` the way vsc-explorer's call form does:
 * `accountRc.amount - ceil(sum of HBD intent limits in milli-HBD)`. See
 * Contract.tsx:269 (`simRcLimit`) for the reference. Clamped to the node's
 * accepted range [1, 100000] (schema.resolvers.go:607).
 *
 * Why this exact formula: the runtime reserves `rc_limit - rcFreeRemaining`
 * HBD against RC consumption before the intent pull runs
 * (execution-context.go:422-430). Setting rc_limit = accountRc.amount -
 * hbdIntents makes the exclusion exactly equal to `HBD balance - hbdIntents`,
 * which leaves just enough HBD free to cover the intent pull.
 */
export function computeSimRcLimit(accountRcAmount: bigint, call: SwapCallSpec): number {
	const limit = accountRcAmount - hbdIntentReserve(call);
	if (limit < 1n) return 1;
	if (limit > 100_000n) return 100_000;
	return Number(limit);
}

/**
 * Choose the real broadcast's `rc_limit` from a successful sim, matching
 * vsc-explorer's `rcLimitInt` formula (Contract.tsx:308):
 * `min(ceil(rcUsed * 1.25), simRcLimit)`. The 25% headroom guards against
 * minor state drift between sim and broadcast; the clamp prevents re-triggering
 * the HBD-exclusion path that the aligned sim just sidestepped.
 */
export function computeBroadcastRcLimit(simRcLimit: number, rcUsed: bigint): number {
	const padded = Math.ceil(Number(rcUsed) * 1.25);
	const floored = padded < 1 ? 1 : padded;
	return Math.min(floored, simRcLimit);
}

/**
 * Run `simulateContractCalls` for a single contract call. The VSC node
 * executes the call in a read-only sandbox and returns `rc_used` regardless
 * of whether the call would have succeeded, so callers should inspect both
 * `success` and `rcUsed` — a failed sim still tells you how much RC the
 * node burned getting to the failure.
 *
 * Pass `rcLimit` to override `call.rc_limit` for this simulation. Callers
 * that haven't pre-fetched RC should use `checkSwapRc` instead — it handles
 * the RC fetch + alignment automatically.
 */
export async function simulateSwapCall(
	config: MagiConfig,
	params: {
		username: string;
		call: SwapCallSpec;
		txId?: string;
		/** Override `call.rc_limit` for this sim. Typically set to
		 *  `computeSimRcLimit(accountRc.amount, call)` to match vsc-explorer. */
		rcLimit?: number;
	}
): Promise<SimulateResult> {
	const txId =
		params.txId ?? `sim-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
	const simRcLimit = params.rcLimit ?? params.call.rc_limit;
	const data = await gqlPost<{
		simulateContractCalls: Array<{
			success: boolean;
			err: string | null;
			err_msg: string | null;
			rc_used: string | number;
		}>;
	}>(config, {
		query:
			'query($input: SimulateContractCallsInput!) { simulateContractCalls(input: $input) { success err err_msg rc_used } }',
		variables: {
			input: {
				tx_id: txId,
				required_auths: [`hive:${params.username}`],
				required_posting_auths: [],
				calls: [{ ...params.call, rc_limit: simRcLimit }]
			}
		}
	});
	const first = data.simulateContractCalls[0];
	if (!first) throw new Error('simulateContractCalls returned no results');
	return {
		success: first.success,
		rcUsed: BigInt(first.rc_used),
		simRcLimit,
		err: first.err ?? undefined,
		errMsg: first.err_msg ?? undefined
	};
}

/** Unwrap the sim-ready call spec from a `custom_json` swap op. */
export function simCallFromSwapOp(op: unknown): SwapCallSpec {
	if (!Array.isArray(op) || op[0] !== 'custom_json') {
		throw new Error('Expected a custom_json op');
	}
	const body = op[1] as { json?: string };
	if (typeof body?.json !== 'string') {
		throw new Error('custom_json op missing `json` field');
	}
	const inner = JSON.parse(body.json) as {
		contract_id: string;
		action: string;
		payload: string;
		rc_limit: number;
		intents?: SwapCallSpec['intents'];
	};
	return {
		contract_id: inner.contract_id,
		action: inner.action,
		payload: inner.payload,
		rc_limit: inner.rc_limit,
		intents: inner.intents ?? []
	};
}

/**
 * Fetch the caller's RC, then simulate with a vsc-explorer-aligned `rc_limit`
 * (`accountRc.amount - hbdIntentReserve`) so the node doesn't over-reserve
 * HBD against RC and reject the intent pull as "insufficient balance". Also
 * returns the `broadcastRcLimit` the caller should pass into
 * `getHiveSwapOp({ rcLimit })` when rebuilding the op for broadcast.
 *
 * Sequential, not parallel: the RC fetch must complete before the sim so
 * `rc_limit` can be derived from it.
 */
export async function checkSwapRc(
	config: MagiConfig,
	params: { username: string; call: SwapCallSpec; txId?: string }
): Promise<RcCheckResult> {
	const rc = await getAccountRc(config, `hive:${params.username}`);
	const simRcLimit = computeSimRcLimit(rc.amount, params.call);
	const sim = await simulateSwapCall(config, { ...params, rcLimit: simRcLimit });
	const shortfall = sim.rcUsed > rc.amount ? sim.rcUsed - rc.amount : 0n;
	return {
		simOk: sim.success,
		rcUsed: sim.rcUsed,
		rcAvailable: rc.amount,
		sufficient: sim.success && shortfall === 0n,
		rcShortfall: shortfall,
		simRcLimit,
		broadcastRcLimit: computeBroadcastRcLimit(simRcLimit, sim.rcUsed),
		err: sim.err,
		errMsg: sim.errMsg
	};
}
