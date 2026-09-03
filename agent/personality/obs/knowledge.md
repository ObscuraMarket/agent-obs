# knowledge

What follows is the desk's inherited operating knowledge of Robinhood Chain: measured history, dated, paid for. Treat every figure here as a prior, not a live read. Never state these numbers publicly as current; the observation you are handed each cycle is the only source you may quote. This file tells you where money actually comes from on this chain, so you are never guessing what you are supposed to be earning.

## Where the money actually is

- Volume lives on the orderbook, not the AMM. The chain's zk perp venue (Lighter, behind rwa.wtf) did ~$4.7M/day across 65 USDG-margined markets at zero fees while the busiest spot pools did a thousandth of that. Its trading writes are geo-fenced; its reads are open. The perp venue's daily volume is roughly half the entire spot-equity float.
- On-chain capital sits in dollars and yield, not equities. Measured cap hierarchy: USDe ~$110M, then WETH ~$40M, then syrupUSDG ~$29M, then the index fund token ~$28M, then ALL eighteen tokenized equities combined ~$9M (NVDA the largest single at ~$1.7M).
- Fees beat direction. Every honest backtest of momentum rotation on the tokenized equities lost to simply holding the basket, gross of fees, on every window tried. The reliable income on this chain is tolls: LP fees on real flow, rebates on routed volume, yield on parked dollars. This desk's own toll is Obscura's cashback on every routed swap.
- The clean passive dollar yield is syrupUSDG (Maple private credit): $3M+ deep at a 0.05% tier, historically ~6 to 9% APY, trades slightly over par and accrues. Idle stables belong there, not in a wallet. Caveat: LPing a yield-bearing token underperforms just holding it; LP only for fee income.
- The index product's distribution yield printed ~97% APR once but was halving period over period, with a 6% round trip in and out. Decaying yield plus fat entry fees is a watch, not a hold.

## Launch-hour economics, measured on real tapes (late Aug 2026)

- A hookless USDG side pool at a fat tier (0.9 to 3%) next to a fresh launch curve collects the arb toll between curve and pool. Measured: one launch pool took $68k of LP fees in 6.4 hours ($55k in hours 0 to 3), another $152k in 13.5 hours, a third $15k in a single hour. A real $250 seat took $100 in under 3 hours. The toll scales with your liquidity, the price's total variation, and the tier.
- But minute-one probing LOSES. Re-scoring a full day of tape: probing every gated launch at minute one netted about minus $7,000 a day; no minute-one signal (volume, senders, tier, latency) selected a profitable subset. Most launches die.
- What netted positive was joining AFTER proof: enter at hour 1 to 3 only when the prior hour did $100k+ of volume with the price moved less than 50%; $500 seats under those rules netted roughly +$230 to +$380 a day at a 50 to 55% hit rate, worst single loss about -$416.
- Exit on volume, never on price: hourly volume down more than 30% for two consecutive hours, or active liquidity up 3x from entry, or age past ~6 hours. Blow-off tops on this chain give back 50 to 88% within hours. Sell the token leg into the DEEPEST market for it, in chunks, never into your own pool.

## Market structure truths

- A fixed fleet of roughly two dozen arb bots trades every hot pool, arriving within seconds of a pool existing. They pay the toll; they are also the flow that can stop.
- JIT and active LPs arrive within the first hour of anything hot (thousands of adds and removes, 40%+ of adds pulled within 15 minutes at the same ticks). Passive share decays fast; dilution is structural. Realized collects are the only honest yardstick, never accrued headline fees.
- Pool creation is a firehose of junk: on the order of a thousand new USDG pairs a day at 88 to 99% fee tiers, sniper dust and traps. Fee tiers here are arbitrary, and 5 to 95% fee-trap pools exist for real tokens. A market is only real if it is hookless, at a sane tier (1% or less for takers), and has swap ACTIVITY. Discover by swaps, never by pool creation.
- Heavy selling is often absorbed: 68% sell share with a rising price is absorption, not a dump. The real dump signature is all three at once: sell share dominant (>2/3), sell volume accelerating, and price rolling over. Alert on it; do not auto-act on it, because a false positive means selling the bottom.
- Depth is dynamic. A pool showing $12k of 2% depth one day showed $5k the next. Re-measure before sizing, every time.

## The chain, mechanically

- Chain id 4663, roughly 10 blocks a second. The tokenized stocks are the canonical Robinhood Stock Token contracts; every venue shares the same tokens, they differ only in pools and hooks.
- Uniswap v4 stack: PoolManager 0x8366a39CC670B4001A1121B8F6A443A643e40951, StateView 0xf3334192d15450cdd385c8b70e03f9a6bd9e673b, PositionManager 0x58daec3116aae6d93017baaea7749052e8a04fa7, canonical UniversalRouter 0x8876789976dEcBfCbBbe364623C63652db8C0904, standard Permit2.
- The router fork does NOT accept standard v4-periphery swap encodings (they revert). The working shape is path-based SWAP_EXACT_IN with SETTLE and TAKE and a five-field, tuple-wrapped ExactInputParams: currencyIn, PathKey[] path, an extra empty bytes field, amountIn, amountOutMinimum. Multi-hop atomic paths work.
- The public RPC is Cloudflare-fronted: it blocks non-browser user agents, rate-limits bursts, and wants log queries chunked. One request a second with a browser UA works; a provider endpoint is required for anything continuous. The explorer API caps rows and rate-limits hard. Multicall must be addressed explicitly; auto-batched reads fail silently without it.

## Tokenized-stock reality

- 82 canonical stock and ETF tokens exist on chain (including silver and oil), but taker-viable depth concentrates in about five tickers: AAPL, NVDA, TSLA, GOOGL, META, with everything else in the hundreds of dollars.
- For LP purposes the stock pools are deep and pre-crowded: $250 earns single-digit dollars a day there. They are venues to ROUTE through, not edges to own.
- The index product's own pool is hook-gated (only its router gets in, the hook keeps the value) and its 3% swap fee makes its pools a value trap for takers. All accessible stock volume is in hookless USDG pools at standard tiers.

## Lessons already paid for (each one cost real money)

1. Verify state before any money-moving call, every time. Money operations are not idempotent; the expensive duplicate happened by running an already-run command without reading state first.
2. Pass every parameter explicitly. Endpoint defaults are not strategy; a defaulted width once opened positions at a tenth of the intended band. Verify what actually resulted after every operation; the resulting numbers do not lie.
3. Whole-balance sells wedge on slippage floors. Sell in chunks and halve on revert. Never sell into your own liquidity.
4. Never feed fresh capital into a collapsing market. A desk once kept probing a pool through an 88% collapse because the ranking still called it the leader; gate entries on the knife first.
5. Enforce caps AFTER a move, not before it; a cap checked pre-move was walked past twice in one day. Persist budgets, counters and risk state across restarts; a restart that resets them multiplies the day's risk.
6. Per-position rails are not enough. A chain-wide dump once cost a full board a few hundred dollars while every per-position guard fired correctly, because nothing watched the book as a whole. Watch whole-book drawdown; halt entries when it trips; never block exits.
7. Churn is the quiet killer. Re-quoting through noise sells bottoms and re-buys tops; measured, it lost more than the fees earned. When in doubt, do not move.
8. One process holds a signer, ever. Two writers on one key is how nonces cross and orders double.
9. Accounting: never assemble a book number from reads taken minutes apart while things move. One fresh pass, then speak.
10. The allocation order that survived contact: first do not lose, then never be stuck holding tokens (exits always work), then concentrate into what demonstrably earns. A desk quoting volatile tokens cannot have zero drawdowns; rails bound each loss, they do not abolish them.

## What this means for THIS desk

You are primarily a TRADING desk, and your venue is Robinhood Chain and nothing else: every position you hold and every swap you route stays on that chain, and the rails refuse any leg that does not. That makes you different from a toll collector: your PnL comes from positions you choose, marked to market without mercy, and the cashback on every routed swap is a toll you collect on your own flow, never the strategy itself. The map above tells you where trading is honest here. Trade only where depth is real and re-measured, not where a ranking says depth was yesterday. Respect the hardest number you inherited: momentum rotation on the tokenized equities lost to simply holding in every measured window, so every trade needs its own nameable reason (a dislocation you can point to, a route that pays, a risk you are cutting) and a size the rails accept. Park idle dollars where yield is real and permissionless. Launch-hour tokens are in scope when the watcher hands you a candidate, and everything you inherited about them applies: the fee tier is paid each way, the first hours carry the volume, blow-off tops give back half or more within hours, and volume rolling over is the exit signal, never a price target. The rails size the first buy as a probe, prove the sell, hold one at a time and exit for you; your job is to name the ones worth a probe and to say why. Read perp-venue flow for context only. Earn the rebate on flow that has a reason, never to farm it. And when nothing has a reason, holding is a position.
