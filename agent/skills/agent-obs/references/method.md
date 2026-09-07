# The method: how Agent OBS reads a token on Robinhood Chain

Everything here was read from the chain and measured on it. Where a number
is a threshold the desk uses, it is named as one; where it is a measurement,
its date is given. Use the reads as they are, then tune the thresholds on
your own tapes, never the other way round.

## The chain

- Robinhood Chain, chain id 4663, ETH for gas, Arbitrum stack, a block about
  every 100 ms, transactions ordered by arrival with no gas auction. Public
  RPC `https://rpc.mainnet.chain.robinhood.com` (throttles bursts and caps a
  log query at 10,000 logs). Alchemy serves the chain for production.
- Uniswap v4 PoolManager `0x8366a39cc670b4001a1121b8f6a443a643e40951`,
  UniversalRouter `0x8876789976decbfcbbbe364623c63652db8c0904`,
  Permit2 `0x000000000022d473030f116ddee9f6b43ac78ba3`,
  Multicall3 `0xca11bde05977b3631167028862be2a173976ca11`.
- USDG `0x5fc5360d0400a0fd4f2af552add042d716f1d168` (6 decimals). The book's
  base is ETH; USDG is a hop, never a place to park.
- pons v2, the launchpad most launches use: factory
  `0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e`, hook
  `0xe5e702641ea86f4ae6cc3cdaed2b886f976be044`, launch router
  `0xe33e9e479df8802cb0866d5d05258bec4cf62948`, fee escrow
  `0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e`. Every launch opens behind a
  99% tax that decays to zero in three seconds. A launch's v4 pool key is
  `(pair, token, fee 0, tickSpacing 200, hook)` in currency order, and the
  pool keeps that id after graduation. Phases from the factory record: 0 on
  its curve, 1 swept (nothing trades), 2 in its pool, 3 rescued. Measured
  on 2026-09-03: about 24,000 launches a day, 559 graduate (one in
  forty-four).

## 1. The tape (a pool's own swaps)

`Swap` events on the PoolManager, filtered by the indexed pool id, read in
chunks of 20,000 blocks and kept per pool. The amounts are the swapper's
deltas: a positive token delta means the user received the token, so
`side = tokenDelta > 0 ? buy : sell`. Reading them the v3 way (pool deltas)
inverts every side; the desk made that mistake once and the Transfer events
proved it. From the rows: buys and sells in quote terms, buy pressure,
first, last, peak and trough prices, five-minute volume buckets, and a
trend (`rising`, `holding`, `rolling over`, `thin`). Block times are
interpolated at ten blocks a second.

## 2. The entry read (volume puts a token on watch, price action gives the entry)

Over a 30-minute window with at least 6 swaps:

- Volume pickup: the last 10 minutes run at least 2x the earlier 20. Without
  it the state is `quiet` (for a token whose volume is already established
  by its hourly figures, the pickup is not required).
- `spike`: ran at least 15% and sits within 3% of its peak. Never bought.
- `pullback`: 8 to 35% off the peak, a higher low held, turned up at least
  2% off the trough, buy pressure at least 50% over the last 10 minutes.
  Entry allowed.
- `base`: a range of at most 6% for at least 10 minutes with buyers still
  present. Entry allowed.
- `breakdown`: back below where the window started. `waiting`: volume is up
  but the price action has given nothing yet.

Measured on 17 hours of the desk's own tapes on 2026-09-05 (39 signals, 10
tokens): pullback entries lose overall under the desk's exits; the only slice
that paid was tokens under 15 minutes old at the signal (3 winners of 8).
Entries at 15 to 45 minutes were the worst. Treat this as a hint from a small
sample, and measure again on your own tapes before trusting it.

## 3. The stability read (survivors)

From the hourly trail: at least 6 active hours (volume of at least $1,000 an
hour) out of the hours known, no more than 50% below the 12-hour peak, a
range of at most 40% over the recent hours, the recent hours at least half
the median hour, at least 20 senders, and no more than 2 hours since the
last active one. A stable token is a swing candidate, graded B, timed by
the entry read like anything else.

## 4. The holders read (who holds it)

`Transfer` events of the token, from launch. Set aside the pool manager,
the router, the position manager, the hooks, the burn address and the
busiest sender (the pool or the curve). Then: wallets holding, the largest
wallet's share, the top ten's share, the first buyers inside the first 30
seconds (how many share a block, how many bought identical sizes: a
bundle), and how many of the top ten are fresh (transaction count at or
under 3). Gate: at least 30 wallets, the largest at most 25%, the top ten
at most 60%, at most 50% of the first buyers bundled, at most 7 of the top
ten fresh.

## 5. The launch read (the launch itself)

From the factory's `getLaunchedToken(token)`: the deployer, the curve, the
creator fee recipient, the creator tax, the pair, the phase. From the
token's `getTokenInfo()`: links (X, website, telegram) and the description.
From the launch transaction, found by the factory's `TokenLaunched` event:
`launchAndBuy` calldata gives the quote spent and the wallets declared
exempt from the opening tax (the declared bundle); the curve's `CurveBuy`
events in the receipt give the tokens the launcher received, as a share of
the 1B supply (the dev buy). From the curve's first 600 blocks: buys,
distinct recipients, and buys that paid the opening tax (topic
`0x3bc39a5562b28f5fe8f36cecabfbaa12bb969acf05717994709225fc412a9934`). From
the factory again: the deployer's launches in the prior 400,000 blocks
(about 11 hours) and how many of those emitted `PoolGraduated`.

Score, starting at 50 (after the open sniper terminal bodkin, MIT, measured
2026-09-03): dev buy 1 to 6% +15, over 10% -25, none -10; creator tax 0 +5,
up to 2% +10, over 5% -25; fees to a third party +5; X link +8, website +8,
telegram +3, no links -15, a real description +4; no exempt wallets +5, 1 to
3 exempt -5, 4 or more -20; fresh deployer +5, deployer graduated 30% or
more of recent launches +15, serial deployer (5 or more, none graduated)
-25; 10 or more distinct first-minute buyers +10, every first-minute buy
taxed -10. Gate: phase swept or rescued, dev buy over 8%, creator tax over
3%, more than 2 exempt wallets, no links, a serial deployer, or a score
under 60 refuses the buy. On 2026-09-05 this refused COFF (dev buy 27% of
supply; it fell 95% inside fifteen minutes), VAULTS (10 exempt wallets) and
UMI (dev buy 19.7%, a deployer with five launches and no graduation).

## 6. Wallet records (across tokens)

Each token's Transfer events joined to its tape by transaction hash price
every wallet's buys and sells. Reduced per wallet across tokens: what it
put in, what it took out, how many tokens it won and lost. A token whose
top wallets are repeat winners reads differently from one held by repeat
losers or wallets with no record. This is the slowest read to become a
signal; it needs days.

## 7. The rails (code the model cannot override)

Robinhood Chain only; $25 a swap; one open position; a gas
reserve of 0.002 ETH; a cost floor against the pool mark (the tier plus
slippage, wider on a curve); entries spaced 2 hours apart, never counted
by the day; a whole-book daily loss brake (entries halt after a $50 or 5%
drawdown from the day's opening mark; exits never halt). A launch token's
first buy is a $5 probe; its sell must be proven before any size; one
launch position at a time. A swap must be argued for: a thesis, three
evidence lines each quoting a figure from the observation, an
invalidation, conviction of at least 3.

## 8. Exits (on the data)

Once a trade has paid at least 15%, scale out 60% the moment the tape shows
buyers thinning (buy pressure under 45% or five-minute volume rolling over)
and trail the rest. Behind that: a floor at 40% below cost, half off at
+40%, a 20% trail off the peak once up 20%, volume rolling over two hours
running, and a time stop at 8 hours. On the curve, note the swept gap:
between the curve closing and the pool being created nothing trades.

## What was measured about pumps (2026-09-05, one day of tapes)

The five minutes before a doubling look like any other five minutes:
volume at 0.6x the prior pace, buy pressure 46%, price drifting down, 76%
below the peak. Wallet identity (new wallets, repeat winners) did not
separate them either. The one predictable pump is mechanical: the first
minutes of a launch's pool after graduation ran +129% to +571% from the
graduation price and sat 85% to 96% below it thirty minutes later. Its
precursor is the curve filling toward the 4.2 ETH threshold, on the curve
contract, not in the pool's swaps.
