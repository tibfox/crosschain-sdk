import type { MagiConfig } from '@vsc.eco/crosschain-core';
import { gqlPost } from './gql.js';

/**
 * Fetch contract state values by key from the node's chain-state merkle tree
 * (`getStateByKeys` returns a `Map` scalar — key → string value). Pass
 * `encoding: 'hex'` (the default) to get raw big-endian bytes as a hex string,
 * which is what numeric blobs like pool reserves (`r0`/`r1`) and the BTC
 * supply blob (`s`) are stored as; pass `undefined` for UTF-8 string values.
 *
 * An empty / missing key serialises to `""` and means zero.
 */
export async function getStateByKeys(
	config: MagiConfig,
	contractId: string,
	keys: string[],
	encoding: 'hex' | undefined = 'hex'
): Promise<Record<string, string>> {
	const data = await gqlPost<{ getStateByKeys: Record<string, string> | null }>(config, {
		query:
			'query($contractId: String!, $keys: [String!]!, $encoding: String) { getStateByKeys(contractId: $contractId, keys: $keys, encoding: $encoding) }',
		variables: { contractId, keys, encoding }
	});
	return data.getStateByKeys ?? {};
}

/**
 * Decode a hex string returned by `getStateByKeys` back to bigint. Accepts
 * missing / empty / `"0x"`-prefixed inputs; empty or missing means zero.
 * Returns null only when the input is a non-hex string.
 */
export function hexToBigInt(hex: unknown): bigint | null {
	if (hex == null) return null;
	if (typeof hex !== 'string') return null;
	const h = hex.startsWith('0x') ? hex.slice(2) : hex;
	if (h === '') return 0n;
	if (!/^[0-9a-fA-F]+$/.test(h)) return null;
	return BigInt('0x' + h);
}

/** Decode a hex string into a fixed-length byte array, or null if malformed. */
export function hexToBytes(hex: unknown, expectedLen?: number): Uint8Array | null {
	if (typeof hex !== 'string') return null;
	const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
	if (clean.length % 2 !== 0) return null;
	if (!/^[0-9a-fA-F]*$/.test(clean)) return null;
	const bytes = new Uint8Array(clean.length / 2);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
	}
	if (expectedLen != null && bytes.length !== expectedLen) return null;
	return bytes;
}
