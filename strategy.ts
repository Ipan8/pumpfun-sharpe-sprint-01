// Steady Drip: a pump.fun bonding-curve replay bot (agent-fun/replay/v2).
//
// IDEA (dip-reversion scalper, built for HOURLY SHARPE, not moonshots):
// The ranking is the hourly Sharpe ratio over a 6-hour forward replay, and a
// prize needs net PnL > 0 after every fee. With only six hourly buckets, one
// wild hour (a bag held through a rug, or a single lucky 5x) wrecks the ratio:
// Sharpe = mean(hourly return) / std(hourly return) rewards small, steady,
// repeatable gains and punishes variance. So this bot trades like a dripping
// tap, not a sniper:
//
//  - MANY SMALL ROUND TRIPS: one fixed 0.03 SOL stake per coin, no pyramiding,
//    fast exits. Dozens of tiny outcomes per hour average out into a smooth
//    hourly return (law of large numbers), instead of a few big bets.
//  - BUY THE DIP, NEVER CHASE: enter only a coin that already proved itself
//    (price still above where its window started, net SOL inflow positive,
//    several distinct buyers) AND is currently pulling back a few percent from
//    its recent high. Chasing a +8% breakout pays the top; a pullback inside
//    an uptrend pays the reversion.
//  - TIGHT EXITS: take-profit +9%, stop-loss -4.5%, a stall exit for dead
//    money (still flat after ~120 slots), a flow-reversal exit (buyers left),
//    and a hard time exit (~360 slots). No trailing stop, no marrying bags.
//  - HOURLY PACING: at most 8 new entries per hour of block time, so trades
//    land in every hour instead of all bunching into hour one.
//  - WIND-DOWN: in the last 45 minutes of the window no new entries, exits
//    tighten (TP +5%, SL -3%, max hold 120 slots), so the harness's forced
//    flatten at the end of data cannot nuke the final hourly bucket.
//
// HOW IT DIFFERS FROM THE TEAM'S EARLIER "FIRST-WAVE FLIP" BOT: that bot
// chased breakouts (buy after +8% over 40 slots, near the window high, age
// 500-900 slots, inflow >= 3 SOL from >= 5 buyers) with TP +15% / SL -8%,
// a trailing stop and probe round trips that buy anything to hit the coin
// bar. This bot does the opposite on entry (dip inside an uptrend, wider age
// window 120-2400 slots, inflow bar far lower), exits sooner and smaller
// (TP +9% / SL -4.5%, stall exit, no trailing stop), paces entries per hour
// for Sharpe smoothness, winds down before the end, and never buys a coin
// just to hit the bar -- a behind-pace ladder only loosens the dip, never
// drops the trend/flow filters.
//
// MONEY FACTS (from this competition's fresh kit, competition.yaml):
// - Capital is 10 SOL; at most 5 open positions; orders decided on slot s
//   fill at slot s + latency_slots (2). Max 16 orders per batch.
// - Every order pays base (5,000) + priority (100,000) lamports tx fee
//   (~0.000105 SOL) plus 0.95% protocol + 0.30% creator curve fees per side,
//   so a round trip costs ~3.2% of a 0.03 SOL stake before any price move.
//   TP +9% / SL -4.5% breaks even near a ~55% win rate; the edge has to come
//   from the entry filter (uptrend + pullback + positive flow), not sizing.
// - A buy on one mint in one reply may spend at most max_order_bps_of_real_
//   reserve of that mint's real SOL reserve (100 bps = 1% here): a 0.03 SOL
//   stake needs real SOL >= 3, which the entry filter enforces.
// - A round trip only counts toward the 20-coin bar if the buy is >= 0.01
//   SOL; the 0.03 SOL stake clears that with room.
// - The harness closes a position itself when its curve completes, and
//   flattens everything left when the data ends (hence the wind-down).
//
// DETERMINISM: executed twice, action logs must match byte for byte. No
// clock, no environment, no Math.random. Every decision comes only from slot
// numbers, block times carried by the events, and the events themselves,
// iterated in insertion order.
//
// This file is PURE strategy: no kit imports, no I/O. main.ts adapts the
// harness BotState into the MarketView below.

/** Curve fee on a trade: 0.95% protocol + 0.30% creator, as a share. */
export const CURVE_FEE = 0.0125;

export interface SteadyDripParams {
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

export const DEFAULT_PARAMS: SteadyDripParams = {
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

/** Slots per hour, used only when no block_time has been seen yet. */
const SLOTS_PER_HOUR = 9000;

export interface CurveView {
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

export interface PositionView {
  mint: string;
  /** Tokens held, raw units, as a decimal string (opaque: passed to sells). */
  tokenAmount: string;
  /** SOL spent on the tokens still held (fees included). */
  costSol: number;
}

export type MarketEvent =
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

/** Everything the strategy needs for one batch, in plain numbers. */
export interface MarketView {
  slot: number;
  /** This batch's events, in chain order. */
  events: MarketEvent[];
  /** Latest known curve state per mint, in first-seen order. */
  curves: Map<string, CurveView>;
  /** Current positions, by mint. */
  positions: Map<string, PositionView>;
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

export type StrategyOrder =
  | { side: 'buy'; mint: string; quoteSol: number }
  | { side: 'sell'; mint: string; tokenAmount: string };

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: TapeTrade[];
  lastExit: number;
  entered: boolean;
}

interface Held {
  opened: number;
}

export function createSteadyDrip(p: SteadyDripParams = DEFAULT_PARAMS) {
  const tapes = new Map<string, Tape>();
  const held = new Map<string, Held>();
  /** Distinct mints this bot has ever bought (filled or not, harness closes excluded). */
  const myCoins = new Set<string>();
  let firstTime: number | null = null;
  let firstSlot: number | null = null;
  /** New entries per hour index, for the Sharpe pacing cap. */
  const entriesPerHour = new Map<number, number>();
  const keep = Math.max(p.window, p.fadeWindow) + 5;

  const tapeOf = (mint: string): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, trades: [], lastExit: -1e12, entered: false };
      tapes.set(mint, t);
    }
    return t;
  };

  let latestTime: number | null = null;

  /** Hour index of the current moment, for the per-hour entry cap. */
  const hourIndex = (view: MarketView): number | null => {
    if (firstTime !== null && latestTime !== null) {
      return Math.floor((latestTime - firstTime) / 3600);
    }
    if (firstSlot !== null) {
      return Math.floor((view.slot - firstSlot) / SLOTS_PER_HOUR);
    }
    return null;
  };

  const inWindDown = (view: MarketView): boolean => {
    if (firstTime !== null && latestTime !== null) {
      return latestTime - firstTime >= p.windDownSecs;
    }
    if (firstSlot !== null) {
      return view.slot - firstSlot >= (p.windDownSecs / 3600) * SLOTS_PER_HOUR;
    }
    return false;
  };

  /** Net SOL flow (buys minus sells) over the last `w` slots of a tape. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /**
   * Entry signal: an uptrend coin in a pullback. `dip` is the looseness
   * ladder step (0 = strict): each step relaxes dipMin / minTrendUp a notch
   * when the run is behind its coin pace, never the flow/age filters.
   */
  const entrySignal = (t: Tape, now: number, curve: CurveView, dip: number): boolean => {
    if (curve.realSol < p.minRqSol || curve.realSol > p.maxRqSol) return false;
    if (curve.complete || t.created === null) return false;
    const age = now - t.created;
    if (age < p.minAge || age > p.maxAge) return false;
    if (t.entered || now - t.lastExit < p.cooldown) return false;
    const from = now - p.window;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
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
    if (buys < p.minBuys || byUser.size < p.minBuyers) return false;
    if (buySol - sellSol < p.minNetSol) return false;
    const vol = buySol + sellSol;
    if (vol > 0 && sellSol / vol > p.maxSellShare) return false;
    if (startPrice <= 0 || last <= 0 || high <= 0) return false;
    // Trend: still above where the window started (an uptrend, not a corpse).
    const trendUp = last / startPrice - 1;
    if (trendUp < p.minTrendUp - dip * 0.01) return false;
    // Dip: below the window high, but not collapsed.
    const dipNow = 1 - last / high;
    if (dipNow < Math.max(0.01, p.dipMin - dip * 0.005)) return false;
    if (dipNow > p.dipMax) return false;
    return true;
  };

  /** SOL selling the whole position returns now, net of curve + tx fees. */
  const valueOf = (pos: PositionView, curve: CurveView, txFeeSol: number): number => {
    const tokens = Number(pos.tokenAmount);
    if (tokens <= 0 || curve.vtRaw <= 0) return 0;
    const gross = (tokens * curve.vqSol) / (curve.vtRaw + tokens);
    return gross * (1 - CURVE_FEE) - txFeeSol;
  };

  function onBatch(view: MarketView): StrategyOrder[] {
    const now = view.slot;
    const traded = new Set<string>();
    for (const e of view.events) {
      if (e.blockTime !== null) {
        if (firstTime === null) firstTime = e.blockTime;
        if (latestTime === null || e.blockTime > latestTime) latestTime = e.blockTime;
      }
      if (firstSlot === null) firstSlot = e.slot;
      if (e.kind === 'create') {
        tapeOf(e.mint).created = e.slot;
      } else if (e.kind === 'trade') {
        const t = tapeOf(e.mint);
        t.trades.push({ slot: e.slot, buy: e.buy, sol: e.sol, user: e.user, price: e.price });
        traded.add(e.mint);
      }
    }
    for (const mint of traded) {
      const t = tapes.get(mint)!;
      let cut = 0;
      while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
      if (cut > 0) t.trades.splice(0, cut);
    }

    const orders: StrategyOrder[] = [];
    const cap = view.maxOrders;
    const windDown = inWindDown(view);
    const tp = windDown ? p.windDownTp : p.takeProfit;
    const sl = windDown ? p.windDownSl : p.stopLoss;
    const hold = windDown ? p.windDownHold : p.maxHold;

    // Exits first: take-profit, stop-loss, stall, flow-reversal, time exit.
    for (const [mint, h] of held) {
      const pos = view.positions.get(mint);
      const curve = view.curves.get(mint);
      if (pos === undefined) {
        if (!view.pendingBuys.has(mint) && !view.pendingSells.has(mint)) {
          held.delete(mint);
          tapeOf(mint).lastExit = now;
        }
        continue;
      }
      if (curve === undefined || curve.complete) continue;
      const value = valueOf(pos, curve, view.txFeeSol);
      const cost = pos.costSol;
      if (cost <= 0) continue;
      const ratio = value / cost;
      let exit = false;
      if (ratio >= 1 + tp) exit = true; // reversion reached the target
      if (!exit && ratio <= 1 - sl) exit = true; // cut the loser fast
      if (!exit && now - h.opened > p.stallSlots && ratio > 1 - p.stallBand && ratio < 1 + p.stallBand) {
        exit = true; // dead money: free the slot for a fresh trade
      }
      if (!exit && flow(tapeOf(mint), now, p.fadeWindow) < -p.fadeNetSol) exit = true;
      if (!exit && now - h.opened > hold) exit = true;
      if (!exit) continue;
      if (view.pendingSells.has(mint)) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, tokenAmount: pos.tokenAmount });
    }

    // Entries: one fixed stake per coin, only on this batch's traded mints,
    // only while the hour still has entry budget and outside wind-down.
    const hour = hourIndex(view);
    const hourBudget =
      hour === null ? p.perHourCap : p.perHourCap - (entriesPerHour.get(hour) ?? 0);
    let free = view.freeCashSol;
    let slotsLeft = view.maxPositions - view.positions.size - view.pendingBuys.size;
    if (!windDown && hourBudget > 0 && slotsLeft > 0) {
      // Behind-pace ladder: loosen the dip step by step, never the filters.
      let pace = 1;
      if (firstTime !== null && latestTime !== null) {
        pace = Math.min(1, (latestTime - firstTime) / p.paceSecs);
      } else if (firstSlot !== null) {
        pace = Math.min(1, (now - firstSlot) / (p.paceSecs / 3600) / SLOTS_PER_HOUR);
      }
      const behind = myCoins.size < Math.ceil(p.targetCoins * pace);
      const maxDipStep = behind ? 3 : 0;
      let entries = 0;
      for (let dip = 0; dip <= maxDipStep && entries < hourBudget; dip++) {
        for (const mint of traded) {
          if (orders.length >= cap || entries >= hourBudget) break;
          if (slotsLeft <= 0) break;
          const curve = view.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (held.has(mint) || view.pendingBuys.has(mint) || view.pendingSells.has(mint)) continue;
          if (view.positions.has(mint)) continue;
          const t = tapes.get(mint)!;
          if (!entrySignal(t, now, curve, dip)) continue;
          let amount = Math.min(curve.maxBuySol, p.stakeSol);
          if (amount > free - view.txFeeSol) amount = free - view.txFeeSol;
          if (amount < p.minBuySol) continue;
          orders.push({ side: 'buy', mint, quoteSol: amount });
          free -= amount + view.txFeeSol;
          slotsLeft--;
          entries++;
          if (hour !== null) entriesPerHour.set(hour, (entriesPerHour.get(hour) ?? 0) + 1);
          t.entered = true;
          myCoins.add(mint);
          held.set(mint, { opened: now });
        }
      }
    }
    return orders;
  }

  return { onBatch, params: p };
}
