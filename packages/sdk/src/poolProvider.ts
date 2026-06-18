import type { MagiConfig, PoolDepths } from '@vsc.eco/crosschain-core';
import { getStateByKeys, hexToBigInt } from './chainState.js';

export interface PoolProvider {
	getPoolDepths(assetA: string, assetB: string): Promise<PoolDepths | null>;
}

const HASURA_PATH = '/v1/graphql';

/** Pool contract reserve keys — big-endian `big.Int.Bytes()` under short keys. */
const KEY_RESERVE_0 = 'r0';
const KEY_RESERVE_1 = 'r1';

/**
 * Default pool provider. The asset pairing + contract IDs come from the
 * indexer registry (cached), but reserves are read **chain-state first**
 * (`getStateByKeys` r0/r1) and only fall back to the indexer's
 * `dex_pool_liquidity` snapshot when chain state is unavailable — the snapshot
 * can lag, and some pools aren't exposed via the observer API, so we need both.
 * Mirrors altera-app `fetchTypedPoolDepths`.
 */
export function createDefaultPoolProvider(config: MagiConfig): PoolProvider {
	const indexerUrl = config.indexerUrl;
	let cache: { entries: PoolDepths[]; ts: number } | null = null;
	const CACHE_TTL = 5_000;

	async function indexerEntries(): Promise<PoolDepths[]> {
		const now = Date.now();
		if (!cache || now - cache.ts > CACHE_TTL) {
			const entries = indexerUrl ? await fetchPoolsFromIndexer(indexerUrl) : [];
			if (entries.length > 0) cache = { entries, ts: now };
		}
		return cache?.entries ?? [];
	}

	return {
		async getPoolDepths(assetA, assetB) {
			const entries = await indexerEntries();
			if (entries.length === 0) return null;

			const a = assetA.toLowerCase();
			const b = assetB.toLowerCase();
			const entry = entries.find(
				(p) => (p.asset0 === a && p.asset1 === b) || (p.asset0 === b && p.asset1 === a)
			);
			if (!entry) return null;

			// Chain-state first: r0/r1 are positional, aligned with asset0/asset1.
			try {
				const state = await getStateByKeys(config, entry.contractId, [
					KEY_RESERVE_0,
					KEY_RESERVE_1
				]);
				const r0 = hexToBigInt(state[KEY_RESERVE_0]);
				const r1 = hexToBigInt(state[KEY_RESERVE_1]);
				if (r0 != null && r1 != null && (r0 > 0n || r1 > 0n)) {
					return { ...entry, reserve0: r0, reserve1: r1 };
				}
			} catch {
				// fall through to the indexer snapshot reserves already on `entry`
			}
			return entry;
		}
	};
}

async function fetchPoolsFromIndexer(indexerUrl: string): Promise<PoolDepths[]> {
	const url = indexerUrl.replace(/\/+$/, '') + HASURA_PATH;
	const query = `{
		dex_pool_registry { pool_contract asset0 asset1 }
		dex_pool_liquidity { pool_contract reserve0 reserve1 }
	}`;
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ query })
	});
	if (!res.ok) return [];
	const body = await res.json();
	const registry = body?.data?.dex_pool_registry ?? [];
	const liquidity = body?.data?.dex_pool_liquidity ?? [];

	const liqMap = new Map<string, { reserve0: number; reserve1: number }>();
	for (const l of liquidity) {
		if (l.pool_contract && l.reserve0 != null && l.reserve1 != null) {
			liqMap.set(l.pool_contract, { reserve0: l.reserve0, reserve1: l.reserve1 });
		}
	}

	const results: PoolDepths[] = [];
	for (const r of registry) {
		const liq = liqMap.get(r.pool_contract);
		if (!liq) continue;
		results.push({
			contractId: r.pool_contract,
			asset0: String(r.asset0).toLowerCase(),
			asset1: String(r.asset1).toLowerCase(),
			reserve0: BigInt(Math.floor(liq.reserve0)),
			reserve1: BigInt(Math.floor(liq.reserve1))
		});
	}
	return results;
}
