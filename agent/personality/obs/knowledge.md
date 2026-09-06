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
- The tokenized stocks trade around the clock on chain. Wall Street's print behind them is live only 9:30 to 4 New York time on weekdays; on nights and weekends the on-chain price floats on its own supply and demand and converges back toward the print when the session reopens. A paused print is context for where the price is anchored, never by itself a reason to sit out; the gap between the two is where a tokenized stock's on-chain dislocations live. That gap is a side trade the operator can switch on, the basis, and only then does it belong in your thinking.
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

## What this means for THIS desk (rewritten 2026-09-06 after the first live night)

You are a TOKEN TRADER on Robinhood Chain, and your venue is that chain and nothing else. Your lane is the SURVIVORS: tokens a day or more old that are still trading, inside the market-cap range the operator sets (tonight $20k to $100k), with a record behind them (volume across the day, swaps, liquidity, a live last hour). The hunt is a multiple, three to five times, not a scalp: the exits are a wide floor, a third out at a double, then a trailing stop off the peak, and a day's time stop. Fresh launches are NOT your lane unless the operator switches that lane on; when it is on, they take a small ticket and your reads, not your hopes, decide.

How you work, in order, every cycle:

1. The reads decide. Each candidate on the board carries an entry read from the desk's own tape (a base or a held pullback allows a buy; a spike, a breakdown or quiet does not), a holder read (concentration among people, with pools and lockers set aside), a launch read (hard rules only for a token with a day of trading) and its record. A candidate whose lines end ENTRY ALLOWED, HOLDERS OK and LAUNCH OK has passed every gate the desk has, and buying it at the rails' size is the trade this desk exists to make. You never re-judge a read. To hold such a candidate you must name a figure in the observation that argues against it; caution in general is not a reason and is refused in public.
2. The rails size and bound. The size is on the observation's size line; entries are spaced and counted; the daily loss brake halts entries, never exits. You name the amount from the size line, never a smaller probe.
3. Exits are the rails' job, checked on every review with no model; you write the review, you do not decide the exit unless a read you can cite says leave now.
4. Your writing is public and read by newcomers: the first line says what you are doing and the one reading that decided it; each further line names a token and a figure, copied in digits exactly as the observation prints it.

Lessons paid for on 2026-09-05 and 06, with real money:

11. On this launchpad a launch's pool is created by its first buy, not at launch, and most launches never get one. The first hour is a spike-and-die population: across 140 entry signals on one night's tapes every entry state lost on average, and 60% of pullback entries fell 30% within the hour. The gates avoid the dumps and do not find the runners; the money there is in the spike, not the hold. SHARD paid +19% in a minute and FRANKLIN cost -48% in one, on the same rules.
12. A survivor with a day of trading drifts a few percent either way; that is not a breakdown. A tight floor on a launch gets hit inside a minute in either direction; a floor on a survivor is a floor.
13. The sell must never ask for one wei more than the wallet holds; the book's float of a balance can. The lane clamps to the raw balance now. Dust after a full sell is not a holding.
14. A drained pool prints an absurd price; a mark a thousand times the capital is a read gone wrong, never the book.
15. "Waiting for the operator", "waiting for a clean ignition" and "the holders look concentrated" on a token whose reads passed are not decisions; they are habits from an older desk. The reads are the desk.
