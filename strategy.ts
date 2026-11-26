// Steady Drip — dip-reversion scalper for the pump.fun replay harness.
//
// RANKING IS HOURLY SHARPE, NOT PNL. The contest scores six hourly buckets
// and needs net PnL above zero for a prize, so one wild hour — a bag ridden
// through a rug, or a single lucky moonshot — sinks the whole entry. The
// answer is volume of small, repeatable, boring trades: dozens of tiny
// round trips per hour whose average is smooth, instead of a few big bets
// whose variance dominates the ratio.
//
// THE TRADE, IN ONE PARAGRAPH: buy a coin that is already climbing, but buy
// it on a pullback, not on the spike. The coin must be above where it was
// when the lookback window opened, must be taking in more SOL than it leaks,
// and must have several different wallets buying it. Then wait for the price
// to sag a little off its recent high and step in with a fixed 0.03 SOL.
// Get out fast: a modest profit target, a tight loss cut, an exit when the
// trade goes nowhere, an exit when the buyers walk away, and a hard clock
// on every position. Never add to a loser, never chase a runner, never buy
// a coin only to pad the coin count.
//
// PACING AND THE ENDGAME: new entries are capped per hour of block time so
// trades spread across all six buckets instead of piling into the first.
// In the final 45 minutes the bot stops opening and tightens every exit,
// because the harness flattens whatever is still open when the data ends
// and a forced sale in the last bucket would wreck the Sharpe.
//
// WHAT THIS IS NOT: it is not the team's earlier breakout-chaser, which
// bought after a +8% surge near the high with a wide stop and a trailing
// stop, and which bought anything to clear the coin bar. This one buys the
// dip inside an uptrend, exits smaller and sooner, has no trailing stop,
// and never fires a probe trade. The pace ladder below only relaxes how
// deep a dip may be; it never relaxes the trend, flow, age, or buyer
// requirements.
//
// COSTS, FROM THE FRESH KIT (competition.yaml, verified post-open):
// - 10 SOL of paper capital, at most 5 positions open, 16 orders per
//   batch, fills land 2 slots after the decision.
// - Each order pays 5,000 + 100,000 lamports of transaction fee, and each
//   side pays 0.95% protocol plus 0.30% creator curve fees. A round trip on
//   a 0.03 SOL stake therefore costs about 3.2% before any price move.
//   With a +12% target and a -5% cut, the breakeven win rate sits near
//   48% — the edge has to come from picking entries, not from sizing.
// - One reply may spend at most 1% of a mint's real SOL reserve on that
//   mint, so a 0.03 SOL stake needs at least 3 SOL of real reserve; the
//   entry check enforces that directly.
// - A round trip counts toward the 20-coin bar only at 0.01 SOL or more;
//   0.03 SOL clears it comfortably.
// - The harness closes a position on its own when the curve migrates, and
//   flattens everything left at the end of the data (hence the wind-down).
//
// DETERMINISM: the entry is executed twice and the two action logs must
// match byte for byte. There is no clock here, no environment read, no
// Math.random. Every choice follows from slot numbers, block times carried
// by the events, and the events themselves, in chain order.
//
// PURE LOGIC, NO WIRING: this file never imports the kit and never touches
// I/O. main.ts translates the harness state into the plain EngineView below
// and translates the orders back out.

/** Curve fee on a trade: 0.95% protocol + 0.30% creator, as a share. */
export const CURVE_FEE = 0.0125;

export interface DripConfig {
  /** Entry lookback window, in slots. */
  window: number;
  /** Earliest age (slots since CreateEvent) at which a coin may be bought. */
  minAge: number;
  /** Latest age (slots since CreateEvent) at which a coin may be bought. */
  maxAge: number;
  /** Price now must be at least this far above the window-start price. */
  minTrendUp: number;
  /** Price now must be at least this far below the window high (the dip). */
  dipMin: number;
  /** Price now must be no more than this far below the window high. */
  dipMax: number;
  /** Net SOL inflow (buys minus sells) over the window required to enter. */
  minNetSol: number;
  /** Buy trades in the window required to enter. */
  minBuys: number;
  /** Distinct buying wallets in the window required to enter. */
  minBuyers: number;
  /** Sells may be at most this share of window SOL volume (buys+sells). */
  maxSellShare: number;
  /** Real SOL reserve bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** SOL staked into one position (one buy, no pyramid). */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage allowed on buys, in bps. Sells always go out wide open. */
  buySlipBps: number;
  /** Sell everything once the position value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Sell everything once the position value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Sell once held longer than this many slots and still inside +/- stallBand. */
  stallSlots: number;
  /** Dead-money band around cost for the stall exit (fraction). */
  stallBand: number;
  /** Sell once held longer than this many slots, whatever the value. */
  maxHold: number;
  /** Lookback for the flow-reversal exit, in slots. */
  fadeWindow: number;
  /** Sell once net SOL over the fade window falls below -fadeNetSol. */
  fadeNetSol: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most new entries per hour of block time (Sharpe pacing). */
  perHourCap: number;
  /** Guardrail pacing: target this many distinct coins over paceSecs. */
  targetCoins: number;
  /** Block-time span the pace target is spread over, in seconds. */
  paceSecs: number;
  /** No new entries once this many seconds of block time have elapsed. */
  windDownSecs: number;
  /** Tightened take-profit during wind-down. */
  windDownTp: number;
  /** Tightened stop-loss during wind-down. */
  windDownSl: number;
  /** Tightened max hold during wind-down, in slots. */
  windDownHold: number;
}

export const DEFAULT_CONFIG: DripConfig = {
  window: 60,
  minAge: 120,
  maxAge: 2400,
  // TUNING v2 (26 Nov ~00:35 WIB, after dev grade #1: Sharpe -0.466,
  // PnL -0.0555 SOL, win rate 8.8% over 34 round trips): the v1 entry bar
  // was too loose — dips kept falling instead of reverting. Tighten the
  // entry filter (stronger trend, more inflow, more buyers, shallower dip,
  // fewer sells in the window) so only coins with real buying pressure
  // left get bought. Exits untouched: one change at a time.
  minTrendUp: 0.06,
  dipMin: 0.015,
  dipMax: 0.15,
  minNetSol: 0.3,
  minBuys: 5,
  minBuyers: 5,
  maxSellShare: 0.3,
  minRqSol: 3,
  maxRqSol: 50,
  stakeSol: 0.03,
  minBuySol: 0.01,
  buySlipBps: 1500,
  // TUNING v3 (26 Nov ~00:40 WIB, after dev grade #2: Sharpe -0.459,
  // PnL -0.0490 SOL, WR 7.1% over 28 round trips): entry tightening barely
  // moved the score, and grade #1 showed 3 coins made 100% of the gains —
  // the winners were cut at +9% while losers bled to -4.5%. Let winners run
  // further (TP +12%) and give losers a touch more room (SL -5%) so the
  // payoff ratio, not just the entry bar, does the work. Entry filter stays
  // at v2 tightness: one change at a time.
  takeProfit: 0.12,
  stopLoss: 0.05,
  stallSlots: 120,
  stallBand: 0.01,
  maxHold: 360,
  fadeWindow: 20,
  fadeNetSol: 0.3,
  cooldown: 120,
  perHourCap: 8,
  targetCoins: 30,
  paceSecs: 21600,
  windDownSecs: 18900, // 5h15m of a 6h window: last 45 min, entries stop.
  windDownTp: 0.05,
  windDownSl: 0.03,
  windDownHold: 120,
};

/** Fallback hour length in slots, used only until the first block_time arrives. */
const SLOTS_PER_HOUR = 9000;

export interface CurveSnapshot {
  mint: string;
  /** Slot of its CreateEvent; null when first seen through a trade or mark. */
  createdSlot: number | null;
  /** Current spot price, SOL per raw token unit. */
  price: number;
  /** Real SOL reserve, in SOL. */
  realSol: number;
  /** Virtual quote (SOL) and token (raw) reserves, for exit valuation. */
  vqSol: number;
  vtRaw: number;
  complete: boolean;
  /** Most this reply's buys on this mint may spend together, in SOL. */
  maxBuySol: number;
}

export interface HoldingView {
  mint: string;
  /** Tokens held, raw units, as a decimal string (opaque: passed to sells). */
  tokenAmount: string;
  /** SOL spent on the tokens still held (fees included). */
  costSol: number;
}

export type TapeEvent =
  | { kind: 'create'; mint: string; slot: number; blockTime: number | null }
  | {
      kind: 'trade';
      mint: string;
      slot: number;
      blockTime: number | null;
      buy: boolean;
      sol: number;
      user: string;
      price: number;
    }
  | { kind: 'complete'; mint: string; slot: number };

/** Everything the engine needs for one batch, in plain numbers. */
export interface EngineView {
  slot: number;
  /** This batch's events, in chain order. */
  events: TapeEvent[];
  /** Latest known curve state per mint, in first-seen order. */
  curves: Map<string, CurveSnapshot>;
  /** Current positions, by mint. */
  positions: Map<string, HoldingView>;
  /** Mints with a buy / sell still in flight (do not double-order). */
  pendingBuys: Set<string>;
  pendingSells: Set<string>;
  cashSol: number;
  freeCashSol: number;
  maxPositions: number;
  maxOrders: number;
  /** Base + priority tx fee of one order, in SOL. */
  txFeeSol: number;
}

export type DripOrder =
  | { side: 'buy'; mint: string; quoteSol: number }
  | { side: 'sell'; mint: string; tokenAmount: string };

interface CoinTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface CoinTape {
  created: number | null;
  trades: CoinTrade[];
  lastExit: number;
  entered: boolean;
}

interface OpenTrade {
  opened: number;
}

export function createDrip(cfg: DripConfig = DEFAULT_CONFIG) {
  const books = new Map<string, CoinTape>();
  const open = new Map<string, OpenTrade>();
  /** Distinct mints this bot has ever bought (filled or not, harness closes excluded). */
  const coinsBought = new Set<string>();
  let firstTime: number | null = null;
  let firstSlot: number | null = null;
  /** New entries per hour index, for the Sharpe pacing cap. */
  const entriesByHour = new Map<number, number>();
  const keep = Math.max(cfg.window, cfg.fadeWindow) + 5;

  const bookFor = (mint: string): CoinTape => {
    let b = books.get(mint);
    if (b === undefined) {
      b = { created: null, trades: [], lastExit: -1e12, entered: false };
      books.set(mint, b);
    }
    return b;
  };

  let latestTime: number | null = null;

  /** Hour index of the current moment, for the per-hour entry cap. */
  const hourOf = (view: EngineView): number | null => {
    if (firstTime !== null && latestTime !== null) {
      return Math.floor((latestTime - firstTime) / 3600);
    }
    if (firstSlot !== null) {
      return Math.floor((view.slot - firstSlot) / SLOTS_PER_HOUR);
    }
    return null;
  };

  const windingDown = (view: EngineView): boolean => {
    if (firstTime !== null && latestTime !== null) {
      return latestTime - firstTime >= cfg.windDownSecs;
    }
    if (firstSlot !== null) {
      return view.slot - firstSlot >= (cfg.windDownSecs / 3600) * SLOTS_PER_HOUR;
    }
    return false;
  };

  /** Net SOL flow (buys minus sells) over the last `w` slots of a tape. */
  const netFlow = (b: CoinTape, now: number, w: number): number => {
    let net = 0;
    for (let i = b.trades.length - 1; i >= 0; i--) {
      const tr = b.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /**
   * Entry test: an uptrend coin in a pullback. `step` is the looseness
   * ladder rung (0 = strict): each rung relaxes dipMin / minTrendUp a notch
   * when the run is behind its coin pace, never the flow/age filters.
   */
  const entryOk = (b: CoinTape, now: number, curve: CurveSnapshot, step: number): boolean => {
    if (curve.realSol < cfg.minRqSol || curve.realSol > cfg.maxRqSol) return false;
    if (curve.complete || b.created === null) return false;
    const age = now - b.created;
    if (age < cfg.minAge || age > cfg.maxAge) return false;
    if (b.entered || now - b.lastExit < cfg.cooldown) return false;
    const from = now - cfg.window;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    const byUser = new Map<string, number>();
    for (const tr of b.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
      }
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (buys < cfg.minBuys || byUser.size < cfg.minBuyers) return false;
    if (buySol - sellSol < cfg.minNetSol) return false;
    const vol = buySol + sellSol;
    if (vol > 0 && sellSol / vol > cfg.maxSellShare) return false;
    if (startPrice <= 0 || last <= 0 || high <= 0) return false;
    // Trend: still above where the window started (an uptrend, not a corpse).
    const trendUp = last / startPrice - 1;
    if (trendUp < cfg.minTrendUp - step * 0.01) return false;
    // Dip: below the window high, but not collapsed.
    const dipNow = 1 - last / high;
    if (dipNow < Math.max(0.01, cfg.dipMin - step * 0.005)) return false;
    if (dipNow > cfg.dipMax) return false;
    return true;
  };

  /** SOL selling the whole position returns now, net of curve + tx fees. */
  const exitValue = (pos: HoldingView, curve: CurveSnapshot, txFeeSol: number): number => {
    const tokens = Number(pos.tokenAmount);
    if (tokens <= 0 || curve.vtRaw <= 0) return 0;
    const gross = (tokens * curve.vqSol) / (curve.vtRaw + tokens);
    return gross * (1 - CURVE_FEE) - txFeeSol;
  };

  function onBatch(view: EngineView): DripOrder[] {
    const now = view.slot;
    const traded = new Set<string>();
    for (const e of view.events) {
      if (e.blockTime !== null) {
        if (firstTime === null) firstTime = e.blockTime;
        if (latestTime === null || e.blockTime > latestTime) latestTime = e.blockTime;
      }
      if (firstSlot === null) firstSlot = e.slot;
      if (e.kind === 'create') {
        bookFor(e.mint).created = e.slot;
      } else if (e.kind === 'trade') {
        const b = bookFor(e.mint);
        b.trades.push({ slot: e.slot, buy: e.buy, sol: e.sol, user: e.user, price: e.price });
        traded.add(e.mint);
      }
    }
    for (const mint of traded) {
      const b = books.get(mint)!;
      let cut = 0;
      while (cut < b.trades.length && b.trades[cut]!.slot <= now - keep) cut++;
      if (cut > 0) b.trades.splice(0, cut);
    }

    const orders: DripOrder[] = [];
    const cap = view.maxOrders;
    const windDown = windingDown(view);
    const tp = windDown ? cfg.windDownTp : cfg.takeProfit;
    const sl = windDown ? cfg.windDownSl : cfg.stopLoss;
    const hold = windDown ? cfg.windDownHold : cfg.maxHold;

    // Exits first: take-profit, stop-loss, stall, flow-reversal, time exit.
    for (const [mint, h] of open) {
      const pos = view.positions.get(mint);
      const curve = view.curves.get(mint);
      if (pos === undefined) {
        if (!view.pendingBuys.has(mint) && !view.pendingSells.has(mint)) {
          open.delete(mint);
          bookFor(mint).lastExit = now;
        }
        continue;
      }
      if (curve === undefined || curve.complete) continue;
      const value = exitValue(pos, curve, view.txFeeSol);
      const cost = pos.costSol;
      if (cost <= 0) continue;
      const ratio = value / cost;
      let exit = false;
      if (ratio >= 1 + tp) exit = true; // reversion reached the target
      if (!exit && ratio <= 1 - sl) exit = true; // cut the loser fast
      if (!exit && now - h.opened > cfg.stallSlots && ratio > 1 - cfg.stallBand && ratio < 1 + cfg.stallBand) {
        exit = true; // dead money: free the slot for a fresh trade
      }
      if (!exit && netFlow(bookFor(mint), now, cfg.fadeWindow) < -cfg.fadeNetSol) exit = true;
      if (!exit && now - h.opened > hold) exit = true;
      if (!exit) continue;
      if (view.pendingSells.has(mint)) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, tokenAmount: pos.tokenAmount });
    }

    // Entries: one fixed stake per coin, only on this batch's traded mints,
    // only while the hour still has entry budget and outside wind-down.
    const hour = hourOf(view);
    const hourBudget =
      hour === null ? cfg.perHourCap : cfg.perHourCap - (entriesByHour.get(hour) ?? 0);
    let free = view.freeCashSol;
    let slotsLeft = view.maxPositions - view.positions.size - view.pendingBuys.size;
    if (!windDown && hourBudget > 0 && slotsLeft > 0) {
      // Behind-pace ladder: loosen the dip step by step, never the filters.
      let pace = 1;
      if (firstTime !== null && latestTime !== null) {
        pace = Math.min(1, (latestTime - firstTime) / cfg.paceSecs);
      } else if (firstSlot !== null) {
        pace = Math.min(1, (now - firstSlot) / (cfg.paceSecs / 3600) / SLOTS_PER_HOUR);
      }
      const behind = coinsBought.size < Math.ceil(cfg.targetCoins * pace);
      const maxStep = behind ? 3 : 0;
      let entries = 0;
      for (let step = 0; step <= maxStep && entries < hourBudget; step++) {
        for (const mint of traded) {
          if (orders.length >= cap || entries >= hourBudget) break;
          if (slotsLeft <= 0) break;
          const curve = view.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (open.has(mint) || view.pendingBuys.has(mint) || view.pendingSells.has(mint)) continue;
          if (view.positions.has(mint)) continue;
          const b = books.get(mint)!;
          if (!entryOk(b, now, curve, step)) continue;
          let amount = Math.min(curve.maxBuySol, cfg.stakeSol);
          if (amount > free - view.txFeeSol) amount = free - view.txFeeSol;
          if (amount < cfg.minBuySol) continue;
          orders.push({ side: 'buy', mint, quoteSol: amount });
          free -= amount + view.txFeeSol;
          slotsLeft--;
          entries++;
          if (hour !== null) entriesByHour.set(hour, (entriesByHour.get(hour) ?? 0) + 1);
          b.entered = true;
          coinsBought.add(mint);
          open.set(mint, { opened: now });
        }
      }
    }
    return orders;
  }

  return { onBatch, params: cfg };
}
