import { useCallback, useEffect, useMemo, useState } from 'react';
import {
	CoinAmount,
	createMagi,
	createPoolPriceProvider,
	MAINNET_CONFIG,
	type AiohaLike,
	type MagiClient,
	type MagiConfig,
	type PoolProvider,
	type PriceProvider,
	type SwapAsset
} from '@vsc.eco/crosschain-sdk';
import {
	calculateSwap,
	calculateTwoHopSwap,
	calculatePriceImpact,
	checkExceedsPoolDepth,
	getOrderedDepthsFor,
	withSwapOpRcLimit,
	type BtcFeeEstimate
} from '@vsc.eco/crosschain-sdk';
import { validate as validateBtcAddr, Network as BtcNetwork } from 'bitcoin-address-validation';
import magiIcon from './assets/magi.svg';
import { TokenSelect } from './TokenSelect.js';

const SLIPPAGE_PRESETS = [
	{ bps: 50, label: '0.5%' },
	{ bps: 100, label: '1%' },
	{ bps: 200, label: '2%' },
	{ bps: 300, label: '3%' }
];

export interface MagiQuickSwapProps {
	aioha?: AiohaLike;
	username?: string;
	config?: MagiConfig;
	pools?: PoolProvider;
	prices?: PriceProvider;
	keyType?: unknown;
	defaultAssetIn?: SwapAsset;
	defaultAssetOut?: SwapAsset;
	defaultSlippageBps?: number;
	availableBalance?: bigint;
	onSuccess?: (txId: string) => void;
	onError?: (err: Error) => void;
	className?: string;
	/**
	 * Optional broadcast hook that takes precedence over `aioha`. Lets hosts
	 * that don't use Aioha (Keychain-only apps, PeakD, custom signers) plug
	 * their own signing flow in without writing an AiohaLike adapter. When
	 * set, the widget calls `onBroadcast(ops, keyType)` with the already-
	 * tightened ops and expects a resolved `txId` string. Rejecting the
	 * promise (or throwing) surfaces as the widget's error state.
	 */
	onBroadcast?: (ops: unknown[], keyType: unknown) => Promise<{ txId: string }>;
}

export function MagiQuickSwap(props: MagiQuickSwapProps) {
	const {
		aioha, username, config = MAINNET_CONFIG, pools, prices,
		keyType, defaultAssetIn = 'HBD', defaultAssetOut = 'BTC',
		defaultSlippageBps = 100, availableBalance, onSuccess, onError, className,
		onBroadcast
	} = props;

	const hasSigner = !!onBroadcast || !!aioha;

	const poolProvider = useMemo(() => pools ?? undefined, [pools]);
	const magi = useMemo<MagiClient>(() => {
		const client = createMagi({ config, aioha, pools: poolProvider });
		const pricesProv = prices ?? createPoolPriceProvider(client.pools);
		return createMagi({ config, aioha, pools: client.pools, prices: pricesProv });
	}, [config, aioha, poolProvider, prices]);

	const [assetIn, setAssetIn] = useState<SwapAsset>(defaultAssetIn);
	const [assetOut, setAssetOut] = useState<SwapAsset>(defaultAssetOut);
	const [amountInStr, setAmountInStr] = useState('');
	const [recipient, setRecipient] = useState('');
	const [slippageBps, setSlippageBps] = useState(defaultSlippageBps);
	const [customSlippageOpen, setCustomSlippageOpen] = useState(false);
	const [customSlippageInput, setCustomSlippageInput] = useState('');

	const [preview, setPreview] = useState<{
		expectedOutput: bigint;
		minAmountOut: bigint;
		totalFee: bigint;
		hops: 1 | 2;
		priceImpactPct: number;
		exceedsPoolDepth: boolean;
		hop1Fee?: { asset: string; totalFee: bigint };
	} | null>(null);
	const [previewError, setPreviewError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [txId, setTxId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const [btcDepositAddress, setBtcDepositAddress] = useState<string | null>(null);
	const [btcDepositLoading, setBtcDepositLoading] = useState(false);
	const [btcDepositError, setBtcDepositError] = useState<string | null>(null);

	const [rcBlock, setRcBlock] = useState<{
		/** 'insufficient-rc' — sim ran, rc_used > rcAvailable.
		 *  'sim-failed' — sim itself returned success:false, typically because
		 *  the user has no HBD on Magi at all. Both cases resolve by
		 *  depositing HBD into Magi via Altera. */
		reason: 'insufficient-rc' | 'sim-failed';
		rcUsed: bigint;
		rcAvailable: bigint;
		/** Only set for the insufficient-rc case — for sim-failed we don't
		 *  know how much RC is needed. */
		hbdNeeded?: number;
		errMsg?: string;
	} | null>(null);

	const [usdIn, setUsdIn] = useState<number | null>(null);
	const [usdOut, setUsdOut] = useState<number | null>(null);
	const [usdHop1, setUsdHop1] = useState<{ asset: string; usd: number } | null>(null);
	useEffect(() => {
		const p = magi.prices;
		if (!p) return;
		p.getUsdPerUnit(assetIn).then(setUsdIn).catch(() => setUsdIn(null));
		p.getUsdPerUnit(assetOut).then(setUsdOut).catch(() => setUsdOut(null));
	}, [magi, assetIn, assetOut]);
	// Fetch USD/unit for the intermediate hop asset when two-hop, so the fee
	// row can sum hop1 + hop2 USD for display.
	useEffect(() => {
		const p = magi.prices;
		const hop1 = preview?.hop1Fee;
		if (!p || !hop1) { setUsdHop1(null); return; }
		const asset = hop1.asset.toUpperCase() as SwapAsset;
		let cancelled = false;
		p.getUsdPerUnit(asset).then((v: number | null) => {
			if (!cancelled && v != null) setUsdHop1({ asset: hop1.asset, usd: v });
		}).catch(() => { if (!cancelled) setUsdHop1(null); });
		return () => { cancelled = true; };
	}, [magi, preview?.hop1Fee]);

	const isBtcInput = assetIn === 'BTC';
	// Withdrawals that settle to a BTC mainnet address incur a Bitcoin network
	// fee the contract deducts when it builds the unmap tx. Fetch the
	// contract's current rate so we can show an approximate sat range.
	const isToBtcMainnet = assetOut === 'BTC';
	const [btcNetworkFee, setBtcNetworkFee] = useState<BtcFeeEstimate | null>(null);
	useEffect(() => {
		if (!isToBtcMainnet) { setBtcNetworkFee(null); return; }
		let cancelled = false;
		magi.estimateBtcUnmapFee()
			.then((f) => { if (!cancelled) setBtcNetworkFee(f); })
			.catch(() => { if (!cancelled) setBtcNetworkFee(null); });
		return () => { cancelled = true; };
	}, [isToBtcMainnet, magi]);

	// Auto-query balance from Hive L1 when username is known
	const [queriedBalance, setQueriedBalance] = useState<bigint | null>(null);
	useEffect(() => {
		if (!username || isBtcInput) { setQueriedBalance(null); return; }
		let cancelled = false;
		magi.getBalance(username, assetIn).then((b) => {
			if (!cancelled) setQueriedBalance(b);
		}).catch(() => { if (!cancelled) setQueriedBalance(null); });
		return () => { cancelled = true; };
	}, [username, assetIn, isBtcInput, magi]);

	const balanceAmt = useMemo(() => {
		const raw = availableBalance ?? queriedBalance;
		if (raw == null) return null;
		return new CoinAmount(raw, assetIn);
	}, [availableBalance, queriedBalance, assetIn]);

	useEffect(() => {
		if (!isBtcInput || recipient) return;
		if (username && (assetOut === 'HIVE' || assetOut === 'HBD')) setRecipient(username);
	}, [isBtcInput, username, assetOut, recipient]);

	// Live preview
	useEffect(() => {
		let cancelled = false;
		setPreviewError(null);
		if (!amountInStr || assetIn === assetOut) { setPreview(null); return; }
		let amount: CoinAmount;
		try { amount = CoinAmount.fromDecimal(amountInStr, assetIn); } catch { setPreview(null); setPreviewError('Invalid amount'); return; }
		if (amount.raw === 0n) { setPreview(null); return; }

		(async () => {
			try {
				if (isBtcInput) {
					if (assetOut === 'HBD') {
						const pool = await magi.pools.getPoolDepths('BTC', 'HBD');
						if (!pool) { if (!cancelled) setPreviewError('No BTC/HBD pool found'); return; }
						const d = getOrderedDepthsFor(pool, 'btc');
						if (!d) { if (!cancelled) setPreviewError('No BTC/HBD pool found'); return; }
						const r = calculateSwap(amount.raw, d.X, d.Y, slippageBps);
						if (!cancelled) setPreview({
							...r, hops: 1,
							priceImpactPct: calculatePriceImpact(amount.raw, d),
							exceedsPoolDepth: checkExceedsPoolDepth(amount.raw, d)
						});
					} else if (assetOut === 'HIVE') {
						const [p1, p2] = await Promise.all([magi.pools.getPoolDepths('BTC', 'HBD'), magi.pools.getPoolDepths('HBD', 'HIVE')]);
						if (!p1 || !p2) { if (!cancelled) setPreviewError('Missing pool for BTC→HIVE route'); return; }
						const r = calculateTwoHopSwap(amount.raw, p1, p2, 'btc', 'hbd', 'hive', slippageBps);
						const hop1 = getOrderedDepthsFor(p1, 'btc');
						const hop2 = getOrderedDepthsFor(p2, 'hbd');
						if (!cancelled) setPreview({
							...r, hops: 2,
							priceImpactPct: calculatePriceImpact(amount.raw, hop1, hop2),
							exceedsPoolDepth: checkExceedsPoolDepth(amount.raw, hop1, hop2)
						});
					}
				} else {
					const res = await magi.buildQuickSwap({
						username: username ?? 'preview',
						assetIn: assetIn as 'HIVE' | 'HBD',
						amountIn: amount, assetOut,
						recipient: assetOut === 'BTC' ? 'bc1qpreviewplaceholderpreviewplaceholderxxxxxx' : (recipient || 'preview'),
						slippageBps
					});
					if (!cancelled) setPreview({
						expectedOutput: res.preview.expectedOutput,
						minAmountOut: res.preview.minAmountOut,
						totalFee: res.preview.totalFee,
						hops: res.preview.hops,
						priceImpactPct: res.preview.priceImpactPct,
						exceedsPoolDepth: res.preview.exceedsPoolDepth,
						hop1Fee: res.preview.hop1Fee ? { asset: res.preview.hop1Fee.asset, totalFee: res.preview.hop1Fee.totalFee } : undefined
					});
				}
			} catch (err) {
				if (!cancelled) { setPreviewError(err instanceof Error ? err.message : String(err)); setPreview(null); }
			}
		})();
		return () => { cancelled = true; };
	}, [amountInStr, assetIn, assetOut, slippageBps, magi, username, isBtcInput, recipient]);

	const recipientValid = useMemo(() => {
		if (!recipient.trim()) return false;
		if (assetOut === 'BTC') return validateBtcAddr(recipient.trim(), config.network === 'vsc-testnet' ? BtcNetwork.testnet : BtcNetwork.mainnet);
		const bare = recipient.trim().replace(/^(@|hive:)/, '');
		return /^[a-z][a-z0-9\-.]{2,15}$/.test(bare);
	}, [recipient, assetOut, config.network]);

	const inputAmount = useMemo(() => {
		try { return amountInStr ? CoinAmount.fromDecimal(amountInStr, assetIn).raw : 0n; } catch { return 0n; }
	}, [amountInStr, assetIn]);

	const exceedsBalance = balanceAmt !== null && inputAmount > balanceAmt.raw;
	const sameAsset = assetIn === assetOut;
	const hasAmount = inputAmount > 0n;

	const exceedsPoolDepth = !!preview && preview.exceedsPoolDepth;
	const canSubmit = isBtcInput
		? hasAmount && !sameAsset && recipientValid && !!preview && preview.expectedOutput > 0n && !exceedsPoolDepth && !submitting
		: hasSigner && !!username && hasAmount && !sameAsset && recipientValid && !exceedsBalance && !!preview && preview.expectedOutput > 0n && !exceedsPoolDepth && !submitting;

	const handleBtcDeposit = useCallback(async () => {
		if (!canSubmit) return;
		setError(null); setBtcDepositAddress(null); setBtcDepositError(null); setBtcDepositLoading(true);
		try {
			const res = await magi.getBtcDepositAddress({ recipient: recipient.trim(), assetOut, destinationChain: assetOut === 'BTC' ? 'BTC' : 'HIVE' });
			setBtcDepositAddress(res.address);
		} catch (err) {
			const e = err instanceof Error ? err : new Error(String(err));
			setBtcDepositError(e.message); onError?.(e);
		} finally { setBtcDepositLoading(false); }
	}, [canSubmit, magi, recipient, assetOut, onError]);

	const handleSubmit = useCallback(async () => {
		if (isBtcInput) { handleBtcDeposit(); return; }
		if (!canSubmit || !username || !hasSigner) return;
		setError(null); setTxId(null); setRcBlock(null); setSubmitting(true);
		try {
			const build = await magi.buildQuickSwap({
				username,
				assetIn: assetIn as 'HIVE' | 'HBD',
				amountIn: CoinAmount.fromDecimal(amountInStr, assetIn),
				assetOut,
				recipient: recipient.trim(),
				slippageBps
			});
			const rc = await magi.checkSwapRc({ username, build });
			if (!rc.simOk || !rc.sufficient) {
				setRcBlock({
					reason: rc.simOk ? 'insufficient-rc' : 'sim-failed',
					rcUsed: rc.rcUsed,
					rcAvailable: rc.rcAvailable,
					hbdNeeded: rc.simOk ? Number(rc.rcShortfall) / 1000 : undefined,
					errMsg: rc.simOk ? undefined : (rc.errMsg ?? rc.err ?? undefined)
				});
				return;
			}
			// Replace the swap op's baked-in rc_limit with the sim-derived one so
			// the broadcast matches what the node just greenlit (see vsc-explorer's
			// Contract.tsx:308 `rcLimitInt`). Without this, the broadcast still
			// uses getHiveSwapOp's default (2000/10000) and can re-trigger the
			// HBD-exclusion path that the aligned sim just sidestepped.
			const swapOpIdx = build.ops.length - 1;
			const tightenedOps = [...build.ops];
			tightenedOps[swapOpIdx] = withSwapOpRcLimit(
				build.ops[swapOpIdx],
				rc.broadcastRcLimit
			);
			let finalTxId: string;
			if (onBroadcast) {
				// Host-provided signer (Keychain, PeakD, custom). Takes precedence
				// over `aioha` so integrators can drop in without writing an
				// AiohaLike adapter.
				const out = await onBroadcast(tightenedOps, keyType);
				if (!out || typeof out.txId !== 'string') {
					throw new Error('onBroadcast did not return a { txId } string');
				}
				finalTxId = out.txId;
			} else {
				const signed = await aioha!.signAndBroadcastTx(tightenedOps, keyType);
				if (!signed.success) {
					const err = 'error' in signed ? signed.error : 'unknown';
					throw new Error(`signAndBroadcastTx failed: ${err ?? 'unknown'}`);
				}
				if (!('result' in signed) || typeof signed.result !== 'string') {
					throw new Error('signAndBroadcastTx returned success but no tx id');
				}
				finalTxId = signed.result;
			}
			setTxId(finalTxId);
			onSuccess?.(finalTxId);
		} catch (err) {
			const e = err instanceof Error ? err : new Error(String(err));
			setError(e.message); onError?.(e);
		} finally { setSubmitting(false); }
	}, [isBtcInput, handleBtcDeposit, canSubmit, hasSigner, aioha, onBroadcast, magi, username, assetIn, amountInStr, assetOut, recipient, slippageBps, keyType, onSuccess, onError]);

	const copyToClipboard = useCallback((text: string) => { navigator.clipboard.writeText(text).catch(() => {}); }, []);

	const handleFlip = useCallback(() => {
		const nextAmountIn = preview && preview.expectedOutput > 0n
			? new CoinAmount(preview.expectedOutput, assetOut).toDecimalString()
			: '';
		const wasBtcOut = assetOut === 'BTC';
		const willBeBtcOut = assetIn === 'BTC';
		setAssetIn(assetOut);
		setAssetOut(assetIn);
		setAmountInStr(nextAmountIn);
		setBtcDepositAddress(null);
		setBtcDepositError(null);
		if (wasBtcOut !== willBeBtcOut) setRecipient('');
	}, [assetIn, assetOut, preview]);

	// USD values
	const inputUsd = useMemo(() => {
		if (usdIn == null || inputAmount === 0n) return null;
		return Number(new CoinAmount(inputAmount, assetIn).toDecimalString()) * usdIn;
	}, [usdIn, inputAmount, assetIn]);

	const outputUsd = useMemo(() => {
		if (usdOut == null || !preview || preview.expectedOutput === 0n) return null;
		return Number(new CoinAmount(preview.expectedOutput, assetOut).toDecimalString()) * usdOut;
	}, [usdOut, preview, assetOut]);

	function formatUsd(v: number | null): string {
		if (v == null) return '';
		return `≈ $${v < 0.01 && v > 0 ? v.toFixed(4) : v.toFixed(2)}`;
	}

	const rateLabel = useMemo(() => {
		if (!preview || preview.expectedOutput === 0n || inputAmount === 0n) return '—';
		const outDec = Number(new CoinAmount(preview.expectedOutput, assetOut).toDecimalString());
		const inDec = Number(new CoinAmount(inputAmount, assetIn).toDecimalString());
		if (!inDec) return '—';
		const rate = outDec / inDec;
		return `1 ${assetIn} ≈ ${rate.toFixed(assetOut === 'BTC' ? 8 : 6)} ${assetOut}`;
	}, [preview, inputAmount, assetIn, assetOut]);

	// Referral skim (denominated in assetOut), merged into the displayed Fee
	// so users see the full cost. Mirrors referralQualifies() gates:
	// referral must be configured, this must be the hive-signed path (not a
	// BTC deposit), assetOut must not be HIVE/HBD, and input must clear the
	// usdThreshold (defaults to 0). Ref skim = expectedOutput * bps / 10000.
	const referralFeeRaw = useMemo(() => {
		if (!config.referral || isBtcInput) return 0n;
		if (assetOut === 'HIVE' || assetOut === 'HBD') return 0n;
		if (!preview || preview.expectedOutput === 0n) return 0n;
		const threshold = config.referral.usdThreshold ?? 0;
		if (inputUsd == null || !Number.isFinite(inputUsd) || inputUsd < threshold) return 0n;
		return (preview.expectedOutput * BigInt(config.referral.bps)) / 10000n;
	}, [config.referral, isBtcInput, assetOut, preview, inputUsd]);

	const feeLabel = useMemo(() => {
		if (!preview) return '0.08% + CLP';
		const hop2TotalRaw = preview.totalFee + referralFeeRaw;
		const hop2Amt = new CoinAmount(hop2TotalRaw, assetOut);
		const main = `${hop2Amt.toDecimalString()} ${assetOut}`;
		const hop2Usd = usdOut != null ? Number(hop2Amt.toDecimalString()) * usdOut : null;
		if (!preview.hop1Fee) {
			return hop2Usd != null ? `${main} ${formatUsd(hop2Usd)}` : main;
		}
		const hopAsset = preview.hop1Fee.asset.toUpperCase() as SwapAsset;
		const hop1Amt = new CoinAmount(preview.hop1Fee.totalFee, hopAsset);
		const hop1Text = `${hop1Amt.toDecimalString()} ${hopAsset}`;
		const combined = `${hop1Text} and ${main}`;
		const hop1UsdVal =
			usdHop1 && usdHop1.asset === preview.hop1Fee.asset
				? Number(hop1Amt.toDecimalString()) * usdHop1.usd
				: null;
		if (hop2Usd != null && hop1UsdVal != null) {
			return `${combined} ${formatUsd(hop2Usd + hop1UsdVal)}`;
		}
		return combined;
	}, [preview, assetOut, usdOut, usdHop1, referralFeeRaw]);

	const minReceivedLabel = useMemo(() => {
		if (!preview || preview.minAmountOut === 0n) return '—';
		const amt = new CoinAmount(preview.minAmountOut, assetOut);
		const main = `${amt.toDecimalString()} ${assetOut}`;
		const usd = usdOut != null ? Number(amt.toDecimalString()) * usdOut : null;
		return usd != null ? `${main} ${formatUsd(usd)}` : main;
	}, [preview, assetOut, usdOut]);

	const routeLabel = useMemo(() => {
		if (assetIn === 'HBD' || assetOut === 'HBD') return `${assetIn} → ${assetOut}`;
		return `${assetIn} → HBD → ${assetOut}`;
	}, [assetIn, assetOut]);

	const submitLabel = submitting || btcDepositLoading
		? 'Processing…'
		: isBtcInput
			? sameAsset ? 'Pick a different To asset'
			: !recipientValid ? 'Enter Hive account first'
			: !hasAmount ? 'Enter amount'
			: !preview || preview.expectedOutput === 0n ? 'No route available'
			: exceedsPoolDepth ? 'Amount exceeds 50% of pool depth'
			: 'Get deposit address'
		: !hasSigner || !username ? 'Connect Hive wallet'
		: sameAsset ? 'Pick a different To asset'
		: !hasAmount ? 'Enter amount'
		: !recipientValid ? assetOut === 'BTC' ? 'Enter a valid BTC address' : 'Enter a valid Hive username'
		: exceedsBalance ? 'Insufficient balance'
		: !preview || preview.expectedOutput === 0n ? 'No route available'
		: exceedsPoolDepth ? 'Amount exceeds 50% of pool depth'
		: 'Swap';

	const priceImpactPct = preview && hasAmount && preview.expectedOutput > 0n ? preview.priceImpactPct : 0;
	const priceImpactClass = priceImpactPct < 2 ? 'good' : priceImpactPct < 10 ? 'medium' : 'bad';

	const btcNetworkFeeLabel = useMemo(() => {
		if (!isToBtcMainnet || !btcNetworkFee) return null;
		const min = new CoinAmount(BigInt(btcNetworkFee.minSats), 'BTC').toDecimalString();
		const max = new CoinAmount(BigInt(btcNetworkFee.maxSats), 'BTC').toDecimalString();
		return `~${min} – ${max} BTC`;
	}, [isToBtcMainnet, btcNetworkFee]);

	const toAmountLabel = preview ? new CoinAmount(preview.expectedOutput, assetOut).toDecimalString() : '0';
	const fromOptions: SwapAsset[] = ['HIVE', 'HBD', 'BTC'];
	const toOptions: SwapAsset[] = isBtcInput ? ['HIVE', 'HBD'] : ['HIVE', 'HBD', 'BTC'];

	return (
		<div className={`magi-quickswap ${className ?? ''}`}>
			<div className="magi-qs-header">
				<div className="magi-qs-badge"><span className="magi-qs-dot" /><span className="magi-qs-badge-text">MAGI CROSS-CHAIN</span></div>
				<p className="magi-qs-subtitle">Swap native assets across blockchains</p>
				<div className="magi-qs-powered"><span>Powered by</span><img src={magiIcon} alt="Magi" /></div>
			</div>

			{/* From */}
			<div className="magi-qs-field">
				<div className="magi-qs-field-top">
					<span className="magi-qs-field-label">From:</span>
					<span className="magi-qs-network-tag">mainnet</span>
					<TokenSelect value={assetIn} options={fromOptions} onChange={(v) => {
						const wasOut = assetOut;
						setAssetIn(v); setBtcDepositAddress(null); setBtcDepositError(null);
						if (v === 'BTC' && wasOut === 'BTC') setAssetOut('HBD');
						const newOut = (v === 'BTC' && wasOut === 'BTC') ? 'HBD' : wasOut;
						if ((newOut === 'BTC') !== (wasOut === 'BTC')) setRecipient('');
					}} disabled={submitting} />
				</div>
				<div className="magi-qs-input-wrap">
					<input type="text" inputMode="decimal" placeholder="0" value={amountInStr} onChange={(e) => { setAmountInStr(e.target.value); setBtcDepositAddress(null); }} disabled={submitting} />
				</div>
				{inputUsd != null && hasAmount && (
					<span className="magi-qs-field-usd">{formatUsd(inputUsd)}</span>
				)}
				{balanceAmt && (
					<div className="magi-qs-balance-row">
						<span className="magi-qs-balance-label">Balance: {balanceAmt.toDecimalString()} {assetIn}</span>
						<button type="button" className="magi-qs-max-btn" onClick={() => setAmountInStr(balanceAmt.toDecimalString())} disabled={submitting}>Max</button>
					</div>
				)}
			</div>

			<div className="magi-qs-arrow-wrap">
				<button type="button" className="magi-qs-flip-btn" onClick={handleFlip} disabled={submitting} aria-label="Flip From and To">
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="7" y1="3" x2="7" y2="21" /><polyline points="3 7 7 3 11 7" /><line x1="17" y1="3" x2="17" y2="21" /><polyline points="21 17 17 21 13 17" /></svg>
				</button>
			</div>

			{/* To */}
			<div className="magi-qs-field">
				<div className="magi-qs-field-top">
					<span className="magi-qs-field-label">To:</span>
					<span className="magi-qs-network-tag">mainnet</span>
					<TokenSelect value={assetOut} options={toOptions} disabledOptions={[assetIn]} onChange={(v) => {
						const wasBtcOut = assetOut === 'BTC'; const nowBtcOut = v === 'BTC';
						setAssetOut(v); setBtcDepositAddress(null); setBtcDepositError(null);
						if (wasBtcOut !== nowBtcOut) setRecipient('');
					}} disabled={submitting} />
				</div>
				<div className="magi-qs-input-wrap">
					<input type="text" value={toAmountLabel} readOnly disabled placeholder="0" />
				</div>
				{outputUsd != null && preview && preview.expectedOutput > 0n && (
					<span className="magi-qs-field-usd">{formatUsd(outputUsd)}</span>
				)}
			</div>

			{/* Receiver */}
			<div className="magi-qs-receiver">
				<label htmlFor="magi-qs-receiver" className="magi-qs-field-label">
					{assetOut === 'BTC' ? 'BTC address *' : isBtcInput ? 'Hive account to receive *' : 'Hive recipient *'}
				</label>
				{isBtcInput && !recipientValid && (
					<p className="magi-qs-receiver-hint">Enter the Hive account that will receive {assetOut}. The deposit address is generated from this.</p>
				)}
				<div className={`magi-qs-receiver-input-wrap ${!recipientValid && recipient ? 'error' : ''} ${isBtcInput && !recipientValid ? 'required-first' : ''}`}>
					<input id="magi-qs-receiver" type="text" value={recipient} onChange={(e) => { setRecipient(e.target.value); setBtcDepositAddress(null); }} placeholder={assetOut === 'BTC' ? 'bc1q…' : 'hive username'} autoComplete="off" spellCheck={false} disabled={submitting} />
				</div>
			</div>

			{/* Slippage */}
			<div className="magi-qs-slippage-row">
				<span className="magi-qs-field-label">Slippage</span>
				<div className="magi-qs-slippage-options">
					{SLIPPAGE_PRESETS.map(({ bps, label }) => (
						<button key={bps} type="button" className={!customSlippageOpen && slippageBps === bps ? 'active' : ''} onClick={() => { setSlippageBps(bps); setCustomSlippageOpen(false); }} disabled={submitting}>{label}</button>
					))}
					{customSlippageOpen ? (
						<div className="magi-qs-custom-slippage">
							<input type="text" inputMode="decimal" placeholder="e.g. 5" value={customSlippageInput} onChange={(e) => { const v = e.target.value.replace(',', '.'); setCustomSlippageInput(v); const p = parseFloat(v); if (Number.isFinite(p)) setSlippageBps(Math.round(Math.max(0.01, Math.min(99.99, p)) * 100)); }} disabled={submitting} />
							<span>%</span>
						</div>
					) : (
						<button type="button" className={!SLIPPAGE_PRESETS.some((p) => p.bps === slippageBps) ? 'active' : ''} onClick={() => { setCustomSlippageOpen(true); setCustomSlippageInput((slippageBps / 100).toFixed(1)); }} disabled={submitting}>
							{SLIPPAGE_PRESETS.some((p) => p.bps === slippageBps) ? 'Custom' : `${(slippageBps / 100).toFixed(1)}%`}
						</button>
					)}
				</div>
			</div>

			{/* Details */}
			<div className="magi-qs-details">
				<div className="magi-qs-detail-row"><span className="magi-qs-detail-label">Rate</span><span className="magi-qs-detail-value">{rateLabel}</span></div>
				<div className="magi-qs-detail-row"><span className="magi-qs-detail-label">Max fee</span><span className="magi-qs-detail-value">{feeLabel}</span></div>
				{btcNetworkFeeLabel && (
					<div className="magi-qs-detail-row"><span className="magi-qs-detail-label">BTC network fee</span><span className="magi-qs-detail-value">{btcNetworkFeeLabel}</span></div>
				)}
				{preview && hasAmount && preview.expectedOutput > 0n && (
					<div className="magi-qs-detail-row"><span className="magi-qs-detail-label">Price impact</span><span className={`magi-qs-detail-value impact ${priceImpactClass}`}>{priceImpactPct.toFixed(2)}%</span></div>
				)}
				<div className="magi-qs-detail-row"><span className="magi-qs-detail-label">Min received</span><span className="magi-qs-detail-value">{minReceivedLabel}</span></div>
				<div className="magi-qs-detail-row"><span className="magi-qs-detail-label">Route</span><span className="magi-qs-detail-value route">{routeLabel}</span></div>
			</div>

			{sameAsset && <p className="magi-qs-status error">From and To assets must be different.</p>}
			{exceedsBalance && <p className="magi-qs-status error">Amount exceeds your wallet balance.</p>}
			{exceedsPoolDepth && <p className="magi-qs-status error">Amount exceeds 50% of pool depth — reduce the amount to continue.</p>}
			{!exceedsPoolDepth && priceImpactPct >= 10 && (
				<p className={`magi-qs-status ${priceImpactPct >= 15 ? 'error' : 'warn'}`}>
					{priceImpactPct >= 15 ? 'Very high' : 'High'} price impact ({priceImpactPct.toFixed(2)}%) — you may receive significantly less than the market rate.
				</p>
			)}
			{previewError && <p className="magi-qs-status error">{previewError}</p>}
			{error && <p className="magi-qs-status error">{error}</p>}
			{btcDepositError && <p className="magi-qs-status error">{btcDepositError}</p>}

			{rcBlock && (
				<div className="magi-qs-rc-modal" role="dialog" aria-modal="true" aria-labelledby="magi-qs-rc-title">
					<div className="magi-qs-rc-modal-card">
						<h3 id="magi-qs-rc-title" className="magi-qs-rc-title">Deposit HBD into Magi</h3>
						{rcBlock.reason === 'insufficient-rc' ? (
							<p className="magi-qs-rc-body">
								This swap needs <strong>{(Number(rcBlock.rcUsed) / 1000).toFixed(3)} HBD</strong> of RC in your
								Magi account. You currently have <strong>{(Number(rcBlock.rcAvailable) / 1000).toFixed(3)} HBD</strong>.
								Deposit at least <strong>{(rcBlock.hbdNeeded ?? 0).toFixed(3)} HBD</strong> into Magi, then try again.
							</p>
						) : (
							<p className="magi-qs-rc-body">
								We couldn't simulate the swap — usually this means your Magi account doesn't hold enough HBD
								to cover it. Deposit HBD into Magi, then try again.
								{rcBlock.errMsg ? <> <span className="magi-qs-rc-err">({rcBlock.errMsg})</span></> : null}
							</p>
						)}
						<p className="magi-qs-rc-body">
							The easiest way to move HBD into Magi is through <strong>Altera</strong>.
						</p>
						<a
							className="magi-qs-submit"
							href="https://altera.magi.eco"
							target="_blank"
							rel="noopener noreferrer"
						>
							Open Altera
						</a>
						<button type="button" className="magi-qs-rc-dismiss" onClick={() => setRcBlock(null)}>
							Dismiss
						</button>
					</div>
				</div>
			)}

			{!btcDepositAddress && (
				<button type="button" className="magi-qs-submit" onClick={handleSubmit} disabled={!canSubmit || btcDepositLoading}>{submitLabel}</button>
			)}

			{btcDepositAddress && isBtcInput && (
				<div className="magi-qs-btc-deposit">
					<div className="magi-qs-btc-deposit-field"><span className="magi-qs-btc-deposit-label">Deposit address</span><div className="magi-qs-btc-deposit-addr"><code>{btcDepositAddress}</code><button type="button" className="magi-qs-copy-btn" onClick={() => copyToClipboard(btcDepositAddress)}>Copy</button></div></div>
					<div className="magi-qs-btc-deposit-field"><span className="magi-qs-btc-deposit-label">Amount</span><div className="magi-qs-btc-deposit-addr"><code>{amountInStr} BTC</code><button type="button" className="magi-qs-copy-btn" onClick={() => copyToClipboard(amountInStr)}>Copy</button></div></div>
					<p className="magi-qs-btc-deposit-note">You can send from any Bitcoin wallet. No wallet connection needed.</p>
					<button type="button" className="magi-qs-submit" onClick={() => setBtcDepositAddress(null)}>New swap</button>
				</div>
			)}

			{txId && (
				<div className="magi-qs-success">Broadcast: <a href={`https://vsc.techcoderx.com/tx/${txId}`} target="_blank" rel="noopener noreferrer"><code>{txId}</code></a></div>
			)}
		</div>
	);
}
