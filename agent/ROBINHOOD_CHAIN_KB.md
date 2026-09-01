# Robinhood Chain and Robinhood Crypto: what OBS knows

Background knowledge so OBS can speak to the whole Robinhood Chain and Robinhood Crypto world, where Obscura settles its tokenized-stock cashback and where $OBS lives. Facts only, each with the date it was read. The machine-readable half (addresses, pool ids, the snapshot measured when they were verified) is agent/obs-chain.json, and src/obscura/pools.ts refreshes the numbers that move every cycle. No em dashes.

## The chain
Robinhood Chain is Robinhood's own layer 2 (an Arbitrum Nitro rollup, chain id 4663), built specifically for tokenized real-world assets. The entire point of it is that assets trade 24/7 on-chain, unlike traditional markets that close at 4pm. It produces about ten blocks a second (roughly 855,000 a day), so block ranges are large and log queries must be chunked. The explorer is robinhoodchain.blockscout.com; the official contract list is docs.robinhood.com/chain/contracts.

## Robinhood Crypto's tokenized stocks
Robinhood issues real tokenized equities on the chain, each named "[Company] Robinhood Token." There are 18 listed on the main DEX: NVDA, TSLA, AAPL, MSFT, GOOGL, META, AMZN, AMD, COIN, PLTR, ORCL, INTC, MU, CRWV (CoreWeave), USAR (USA Rare Earth), BE (Bloom Energy), SNDK (SanDisk), and SPCX (SpaceX). These are the official article, verified on-chain, not third-party wrappers. Their contracts are in obs-chain.json (tokens.stocks), taken from the official list and matched byte for byte on chain.

A census of every pool on the chain in July 2026 found 82 canonical Robinhood Token contracts with at least one live pool, far beyond the listed 18: megacaps (MSFT, AMZN, NFLX, LLY, COST, AVGO), retail names (GME, MSTR, RDDT, RIVN, SOFI), quantum and space (IONQ, QBTS, RGTI, ASTS, RKLB), China ADRs (BABA, FUTU, NU), and ETFs including SLV (silver) and USO (oil). Only about eleven had a plain pool with real depth, and the deep five were AAPL, NVDA, TSLA, GOOGL and META; most of the rest were a few hundred dollars deep or less. Depth is dynamic. Re-measure before sizing anything.

## The unlock most people miss
The most interesting tokens are the assets you cannot buy on any exchange. SpaceX (SPCX) is a private company, so the only price it has anywhere is the one forming on-chain. That makes Robinhood Chain a price-discovery venue for private markets, not just a mirror of the Nasdaq. USA Rare Earth and CoreWeave sit in the same interesting bucket, harder to access, more reason to tokenize. In July 2026 the SPCX/USDG pool was the busiest stock pool on the chain, ahead of NVDA.

## The ecosystem around it
- The Index (theindex.finance): the DEX where the tokenized stocks are listed, Uniswap v4 pools quoted in USDG. Its own pools sit behind a fee hook (3% on $INDEX, 5% per leg on the stocks) and only its router gets in. The same stock tokens also trade in plain, hookless Uniswap v4 pools at standard tiers (AAPL/USDG 0.05%, NVDA/USDG 0.3%, TSLA/USDG 0.3%, META/USDG 0.3%, GOOGL/USDG 1%) in the same shared PoolManager, and that is where the accessible stock volume is.
- Uniswap v4 is the AMM layer of the chain: one PoolManager holds every pool. Anyone can initialize a pool at any fee tier, including 50%, 85% and 99% tiers built to farm fees from the unwary, and sniper bots initialize around a thousand USDG pools a day at those tiers. A pool is only a market if it is hookless, its tier is 1% or less, and its in-range liquidity is real. Discover pools by swap activity, never by initialization.
- Ramses V3: a concentrated-liquidity DEX (v3-style pools on their own addresses, with an NFT position manager) deployed on the chain. $OBS's real market is a Ramses V3 pool; see below.
- Launch markets: PONS v2 and Doppler launch tokens on bonding curves behind hooks, and a hookless USDG side pool at a fat tier usually appears beside a hot launch within its first hours. That side pool is where the arb between the curve and the open market pays its toll, and the whole thing lives and dies in hours. The same few dozen bot addresses trade every hot pool.
- Lighter (rwa.wtf): a zero-fee zk orderbook for RWA perpetuals on the chain, around 65 markets and several million dollars a day, which is more than all the spot stock pools combined. Reads are open; trading writes are geo-blocked from restricted jurisdictions, and there is no honest way around that. Geo-restricted in some regions.
- Arcus (arcus.xyz): a dYdX-built spot DEX for 95+ tokenized stocks at zero fees, but an off-chain matching engine with its own API keys, and it excludes the US, Canada and the UK.
- USDG (Global Dollar, issued by Paxos): the stablecoin the whole system is priced in. Two yield-bearing dollars have institutional depth: syrupUSDG (Maple credit, millions deep at a 0.05% tier, trades slightly above par, and its NAV is not a single on-chain read) and USDe (Ethena, over a hundred million of on-chain float, a plain stable here since the staked form is not on this chain).

## Where things actually trade, measured 2026-09-01
| Pair | Venue | Tier | Price at the read | Dollars that move the price 2% |
|---|---|---|---|---|
| ETH/USDG | Uniswap v4, hookless | 0.01% | $2,446 | about $24,400 |
| NVDA/USDG | Uniswap v4, hookless | 0.3% | $216.58 | about $44,500 |
| OBS/USDG | Ramses V3 | 2% | $0.000481 | about $200 |

Depth is what is in range at that moment; the live read replaces these every cycle and the prompt only ever carries the fresh number.

## $OBS on chain, the honest state (read 2026-09-01)
Contract 0xfe242d1da8fd04f6a1f80b6d3d807b02e062ad4e: Obscura, OBS, 18 decimals, 1,000,000,000 supply, 3,275 holders and 127,909 transfers on the explorer. The largest holders are contracts: a launch locker (verified source, V2LaunchLocker) holds 8.16% of supply, the Uniswap v4 PoolManager 6.66%, and the Ramses V3 pool 2.53%. No wallet holds more than 3%.

The market is one Ramses V3 pool, USDG against OBS at a 2% fee tier (tick spacing 200). At the read it held 8,715 USDG and 26.5 million OBS, priced OBS at $0.000481, and about $200 of buying at the current tick would move the price 2%. The explorer's own rate ($0.00044, a $440,000 market cap, $262,000 of 24-hour volume) lags the pool. This is a thin market for a small token, and OBS says so rather than quoting it as if it were deep.

Ten Uniswap v4 USDG pools also exist for OBS, at tiers from 0.25% to 66%. All are hookless and initialized; all are dust. The deepest takes under one dollar before a 2% move, six are empty, and their in-range prices disagree by a factor of six. They are the sniper-dust pattern above, not a market, and OBS never quotes them.

## The contracts, verified on chain
Uniswap v4: PoolManager 0x8366a39CC670B4001A1121B8F6A443A643e40951, StateView 0xf3334192d15450cdd385c8b70e03f9a6bd9e673b (read slot0 and liquidity by pool id), PositionManager 0x58daec3116aae6d93017baaea7749052e8a04fa7 (standard v4-periphery), the canonical UniversalRouter 0x8876789976dEcBfCbBbe364623C63652db8C0904, Quoter 0x8dc178efb8111bb0973dd9d722ebeff267c98f94, Permit2 0x000000000022D473030F116dDEE9F6B43aC78BA3. The router on this chain is a fork: the standard v4-periphery swap encodings revert on it, and a working swap needs the path-based action with a five-field, tuple-wrapped input. OBS does not swap on it (his swaps go through Obscura), so this is knowledge, not a code path.

Ramses V3: factory 0xe0c4ceb92d08ca985bb70fe0a22feb121a9854a8, pool deployer 0x4b37359BF291AbE8453692DB58d515a8b013Dca9, the OBS/USDG pool 0x97B11f4138F602325e081B555eC6120459Af9C7c.

Also deployed: Multicall3 at the standard 0xca11bde05977b3631167028862be2a173976ca11, Safe 1.4.1 (singleton 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762, proxy factory 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67), and the ERC-4337 EntryPoint at v0.6 and v0.7, so audited account-abstraction pieces exist here without anyone deploying their own.

Tokens: USDG 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 (6 decimals), WETH 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73 (every v4 pool quotes native ETH, so WETH only appears when someone wraps), syrupUSDG 0x40858070814a57FdF33a613ae84fE0a8b4a874f7, USDe 0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34, NVDA 0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec, AAPL 0xaf3d76f1834a1d425780943c99ea8a608f8a93f9; the other stocks are in obs-chain.json.

## Reading the chain without getting blocked
- The public RPC (rpc.mainnet.chain.robinhood.com) sits behind Cloudflare. It rejects default User-Agents outright, answers a bot challenge (HTTP 403) or 429 after a burst, and returns one error object instead of an array for an oversized JSON-RPC batch, which breaks clients that index batch replies by position. Send a browser User-Agent, one call at a time, and back off for minutes on a refusal. Multicall3 is deployed, so many reads can be one call.
- eth_getLogs works in chunks of 20,000 blocks or less. A whole-history query filtered by an indexed pool id returns in seconds; the same query filtered by a token address times out.
- Blockscout's v1 API answers a browser UA but caps at 1,000 rows oldest-first and rate-limits hard; its v2 endpoints are fine for one-off token, holder and contract lookups and useless for scans.
- A provider endpoint (Alchemy serves the chain) is the real fix for anything that reads every cycle; ROBINHOOD_RPC_URL takes it.

## The 24/7 mechanic
Wall Street trades 9:30 to 4, weekdays only. These tokens trade around the clock. So on nights and weekends the on-chain price floats on its own, and it converges back toward the real market price when trading reopens. That gap is the basis, and it is real and watchable.

## The honest state of it
Real, official, and early. The tokenized-stock float is still small (in July 2026 all eighteen listed equities together held under ten million dollars of on-chain float, NVDA the largest at under two million), the pools are shallow, the chain's volume lives on the perp orderbook rather than the AMM, and most of the market has not noticed yet. That is the whole opportunity: being early to real infrastructure while it is still quiet.
