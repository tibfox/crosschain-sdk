import type { MagiConfig } from '@vsc.eco/crosschain-core';

/**
 * Resolve the ordered list of node GraphQL endpoints from config. Prefers
 * `gqlUrls` (failover list), falls back to the single `gqlUrl`, then to the
 * public default. Each base gets `/api/v1/graphql` appended.
 */
export function gqlEndpoints(config: MagiConfig): string[] {
	const bases =
		config.gqlUrls && config.gqlUrls.length > 0
			? config.gqlUrls
			: config.gqlUrl
				? [config.gqlUrl]
				: ['https://api.vsc.eco'];
	return bases.map((base) => `${base.replace(/\/+$/, '')}/api/v1/graphql`);
}

async function gqlPostOnce<T>(
	url: string,
	body: { query: string; variables?: Record<string, unknown> }
): Promise<T> {
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});
	if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
	const parsed = (await res.json()) as {
		data?: T;
		errors?: Array<{ message: string }>;
	};
	if (parsed.errors?.length) {
		throw new Error(parsed.errors.map((e) => e.message).join('; '));
	}
	if (!parsed.data) throw new Error(`${url} → no data in response`);
	return parsed.data;
}

/**
 * Try each endpoint in order; return the first successful result. The function
 * surfaces the last error only if every node fails — any single failure (HTTP,
 * transport, GraphQL error, missing data) is enough to trigger the next
 * fallback.
 */
export async function gqlPost<T>(
	config: MagiConfig,
	body: { query: string; variables?: Record<string, unknown> }
): Promise<T> {
	const urls = gqlEndpoints(config);
	const errors: string[] = [];
	for (const url of urls) {
		try {
			return await gqlPostOnce<T>(url, body);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			errors.push(`${url}: ${msg}`);
		}
	}
	throw new Error(`All GraphQL endpoints failed — ${errors.join(' | ')}`);
}
