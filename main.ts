// Steady Drip — entrypoint (agent-fun/replay/v2, Node 22).
//
// This file is only a bridge. It turns the harness BotState into the pure
// engine's EngineView, hands the view to the drip strategy, and turns the
// strategy's orders back into harness orders. No decision lives here: every
// choice about what to buy or sell sits in strategy.ts, which imports
// nothing from the kit and touches no I/O, so it can be driven on its own.
//
// The grader runs `node /bot/main.ts`. vendor/makefun-bot.ts is the kit's
// SDK shim, copied from the FRESH kit downloaded after this competition
// opened — the kit's own instructions say to copy that one file into
// vendor/. It never came from an older competition's kit directory.
//
// How the wire protocol works, per the fresh kit's sdk/ts/makefun-bot.ts:
// - hello comes once, then one batch per slot. The bot answers every batch
//   with exactly one reply that echoes the batch seq and carries at most
//   caps.max_orders_per_batch orders (16 here). An order decided on slot s
//   fills on slot s + 2.
// - Events arrive as ChainEvent records — CreateEvent, TradeEvent, and
//   CompleteEvent. A trade's reserves are POST-trade, and on SOL curves the
//   *_quote_* reserves are the ones that price the trade.
// - The shim hands out client ids (o1, o2, ...) when an order omits one,
//   keeps BotState (cash, positions, curves, pending) up to date, and throws
//   OrderError on a protocol violation instead of letting the run die
//   quietly at grading time.

import { pathToFileURL } from 'node:url';
import {
  runBot,
  type Batch,
  type Bot,
  type BotState,
  type ChainEvent,
  type Curve,
  type OrderInput,
} from './vendor/makefun-bot.ts';
import {
  createDrip,
  DEFAULT_CONFIG,
  type CurveSnapshot,
  type EngineView,
} from './strategy.ts';

const LAMPORTS = 1e9;

/** Spot price (SOL per raw token) from virtual reserves. */
function priceOf(vq: bigint, vt: bigint): number {
  return vt === 0n ? 0 : Number(vq) / Number(vt);
}

function toTapeEvent(e: ChainEvent): import('./strategy.ts').TapeEvent {
  if (e.event === 'CreateEvent') {
    return { kind: 'create', mint: e.mint, slot: e.slot, blockTime: e.block_time };
  }
  if (e.event === 'TradeEvent') {
    return {
      kind: 'trade',
      mint: e.mint,
      slot: e.slot,
      blockTime: e.block_time,
      buy: e.is_buy,
      sol: Number(e.sol_amount) / LAMPORTS,
      user: e.user,
      price: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
    };
  }
  return { kind: 'complete', mint: e.mint, slot: e.slot };
}

function toCurveSnapshot(c: Curve, state: BotState): CurveSnapshot {
  return {
    mint: c.mint,
    createdSlot: c.created_slot,
    price: priceOf(c.virtual_quote_reserves, c.virtual_token_reserves),
    realSol: Number(c.real_quote_reserves) / LAMPORTS,
    vqSol: Number(c.virtual_quote_reserves) / LAMPORTS,
    vtRaw: Number(c.virtual_token_reserves),
    complete: c.complete,
    // Per-reply buy cap for this mint, from hello.caps (100 bps of the
    // mint's real SOL reserve here); the strategy never asks for more.
    maxBuySol: Number(state.maxBuyLamports(c.mint)) / LAMPORTS,
  };
}

function createBot(): Bot {
  const drip = createDrip(DEFAULT_CONFIG);
  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const curves = new Map<string, CurveSnapshot>();
      for (const c of state.curves.values()) curves.set(c.mint, toCurveSnapshot(c, state));
      // Positions: token_amount is raw units as a bigint, so the engine
      // keeps it as an opaque decimal string and hands it straight back
      // to sells. cost_lamports is what the harness reports as spent on
      // the tokens still held, fees included, so value over cost is the
      // true return on the position.
      const positions = new Map<string, import('./strategy.ts').HoldingView>();
      for (const [mint, pos] of state.positions) {
        positions.set(mint, {
          mint,
          tokenAmount: pos.token_amount.toString(),
          costSol: Number(pos.cost_lamports) / LAMPORTS,
        });
      }
      const pendingBuys = new Set<string>();
      const pendingSells = new Set<string>();
      for (const po of state.pending.values()) {
        if (po.order.side === 'buy') pendingBuys.add(po.order.mint);
        else pendingSells.add(po.order.mint);
      }
      const view: EngineView = {
        slot: batch.slot,
        events: batch.events.map(toTapeEvent),
        curves,
        positions,
        pendingBuys,
        pendingSells,
        cashSol: Number(state.cash) / LAMPORTS,
        freeCashSol: Number(state.freeCashLamports()) / LAMPORTS,
        maxPositions: state.hello.caps.max_open_positions,
        maxOrders: state.hello.caps.max_orders_per_batch,
        txFeeSol: Number(state.txFeeLamports()) / LAMPORTS,
      };
      const decided = drip.onBatch(view);
      // client_id is deliberately omitted from every order below: the shim
      // assigns o1, o2, ... in send order, which also keeps the reply small
      // (the harness caps a reply at 64 KiB).
      const orders: OrderInput[] = [];
      for (const o of decided) {
        if (o.side === 'buy') {
          orders.push({
            side: 'buy',
            mint: o.mint,
            quote_lamports: BigInt(Math.floor(o.quoteSol * LAMPORTS)),
            max_slippage_bps: DEFAULT_CONFIG.buySlipBps,
          });
        } else {
          // Sells go out at 10000 bps: exit speed beats price on a 0.03 SOL
          // position; a rejected-for-slippage sell would strand the bag.
          orders.push({
            side: 'sell',
            mint: o.mint,
            token_amount: o.tokenAmount,
            max_slippage_bps: 10_000,
          });
        }
      }
      // Defense in depth: the engine already caps at view.maxOrders, but
      // the bridge is the last line before the reply goes on the wire.
      if (orders.length > view.maxOrders) orders.length = view.maxOrders;
      return orders;
    },
  };
}

// The grader runs `node /bot/main.ts`; when imported (e.g. by a local
// backtest) the factory above is all that runs.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await runBot(createBot());
}
