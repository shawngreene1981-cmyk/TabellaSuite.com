// Shopper points (the promise on the pricing page): 1 point per $1 of item price on online orders,
// and 200 points take $5 off an order of $10 or more (one $5 off per order).
//
// Tabella pays for the $5, never the dealer or the mall: their shares are figured on the full item price.
// Points are earned when an order is paid and taken back if it's fully refunded; points spent on an order
// that is never paid, or is refunded, go back to the shopper.
//
// Stored on the shopper's record (buyer:<id>, see offers.js): points, and pointsLog (the last 30 changes).
// A shopper who checks out without signing in still earns: their points wait on their email until they sign in.

import { buyerSession } from './offers.js';
import { rand, err } from './app.js';

export const REWARD_POINTS = 200, REWARD_CENTS = 500, REWARD_MIN_CENTS = 1000;

async function buyerByEmail(env, email, create) {
  email = String(email || '').trim().toLowerCase();
  if (!email) return null;
  let id = await env.TABELLA.get('buyeremail:' + email), b = id ? JSON.parse(await env.TABELLA.get('buyer:' + id) || 'null') : null;
  if (!b && create) { id = 'b' + rand(10); b = { id, email, saved: [], created: Date.now() }; await env.TABELLA.put('buyer:' + id, JSON.stringify(b)); await env.TABELLA.put('buyeremail:' + email, id); }
  return b;
}
async function change(env, id, n, why, ref) {
  const b = JSON.parse(await env.TABELLA.get('buyer:' + id) || 'null');
  if (!b) return null;
  b.points = Math.max(0, (b.points || 0) + n);
  b.pointsLog = [{ at: Date.now(), n, why, ref }].concat(b.pointsLog || []).slice(0, 30);
  await env.TABELLA.put('buyer:' + id, JSON.stringify(b));
  return b;
}

// Checkout: the signed-in shopper asks to use 200 points. Takes them now; they come back if the order isn't paid.
export async function usePoints(env, request, itemsCents, ref, check) {
  const s = await buyerSession(env, request);
  if (!s) throw err(401, 'Sign in on the Swipe page to use your points.');
  if (itemsCents < REWARD_MIN_CENTS) throw err(400, 'Points take $5 off orders of $10 or more.');
  if ((s.buyer.points || 0) < REWARD_POINTS) throw err(400, 'You need 200 points for $5 off. You have ' + (s.buyer.points || 0) + '.');
  if (!check) await change(env, s.buyer.id, -REWARD_POINTS, 'Used for $5 off', ref);
  return { buyer: s.buyer.id, points: REWARD_POINTS, cents: REWARD_CENTS };
}
export async function returnPoints(env, o, why) {
  if (!o.pointsUsed || o.pointsUsed.returned) return;
  await change(env, o.pointsUsed.buyer, o.pointsUsed.points, why, o.ref);
  o.pointsUsed.returned = Date.now();
}
// Paid: 1 point per whole dollar of item price (not shipping, tax or card processing).
export async function earnPoints(env, o) {
  if (o.pointsEarned || !o.email) return;
  const n = Math.floor(o.items.reduce((t, i) => t + Number(i.price || 0), 0));
  if (n <= 0) return;
  const b = await buyerByEmail(env, o.email, true);
  if (!b) return;
  await change(env, b.id, n, 'Earned on an order', o.ref);
  o.pointsEarned = { buyer: b.id, points: n };
}
export async function refundPoints(env, o) {
  if (o.pointsEarned && !o.pointsEarned.reversed) { await change(env, o.pointsEarned.buyer, -o.pointsEarned.points, 'Order refunded', o.ref); o.pointsEarned.reversed = Date.now(); }
  await returnPoints(env, o, 'Points back: order refunded');
}
