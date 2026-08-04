/**
 * Diet Tracker — Stripe billing.
 * ---------------------------------------------------------------------------
 * TWO things live here, sharing one Stripe account + one webhook:
 *
 *  1. GYM INVOICING (B2B): reads the billingSnapshots your app already writes
 *     and turns each into a real SGD invoice emailed to the gym. Usage-based —
 *     only members who actually used the app that month are billable.
 *
 *  2. SELF-PAY SUBSCRIPTIONS (B2C): a member whose gym package ended can pay
 *     S$2.99/month directly via Stripe Checkout. On payment, the webhook writes
 *     selfPay/{uid} active and calls computeAccess to switch their tracker on.
 *
 * PUBLIC GYM (Public-01): a roster-only "gym" that groups individual self-pay
 * members so you can see them. It is NEVER invoiced by the active×rate logic
 * (their money comes per-member via Stripe), and its enrollment never grants
 * access on its own (accessGate skips it) — access is purely selfPay-driven.
 */
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const Stripe = require("stripe");
const { isEngaged } = require("./engagement");
const { computeAccess } = require("./accessGate");
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();
const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET");
// ---- Currency handling (any ISO-4217 currency; default SGD) ---------------
// Gyms and self-pay members can be billed in any Stripe-supported currency.
// A gym's currency is set when it's created; self-pay currency is chosen by the
// member from the admin-maintained price list.
const DEFAULT_CURRENCY = "sgd";
// Symbols for currencies we show nicely; anything else falls back to its
// uppercase code (e.g. "MYR 12.00").
const CURRENCY_SYMBOL = {
  sgd: "S$", usd: "US$", myr: "RM", eur: "€", gbp: "£", aud: "A$", nzd: "NZ$",
  hkd: "HK$", cny: "¥", jpy: "¥", inr: "₹", idr: "Rp", thb: "฿", php: "₱",
  krw: "₩", twd: "NT$", cad: "C$", chf: "CHF ", aed: "AED ", vnd: "₫",
};
// Stripe zero-decimal currencies (amount is already the smallest unit).
const ZERO_DECIMAL = new Set(["bif","clp","djf","gnf","jpy","kmf","krw","mga","pyg","rwf","ugx","vnd","vuv","xaf","xof","xpf"]);
// Stripe three-decimal currencies (charge amount must be a multiple of 10).
const THREE_DECIMAL = new Set(["bhd","jod","kwd","omr","tnd"]);
function normCurrency(c) {
  const v = String(c || DEFAULT_CURRENCY).trim().toLowerCase();
  return /^[a-z]{3}$/.test(v) ? v : DEFAULT_CURRENCY;
}
function currencyDecimals(c) {
  const k = String(c || "").toLowerCase();
  if (ZERO_DECIMAL.has(k)) return 0;
  if (THREE_DECIMAL.has(k)) return 3;
  return 2;
}
// Convert a human amount (e.g. 2.99) into Stripe's smallest unit for a currency.
function toMinorUnits(amount, currency) {
  const k = String(currency || "").toLowerCase();
  if (ZERO_DECIMAL.has(k)) return Math.round(Number(amount));
  if (THREE_DECIMAL.has(k)) return Math.round(Number(amount) * 100) * 10; // multiple of 10
  return Math.round(Number(amount) * 100);
}
function currencyLabel(c) {
  const k = String(c || DEFAULT_CURRENCY).toLowerCase();
  return CURRENCY_SYMBOL[k] || (k.toUpperCase() + " ");
}
function fmtMoney(amount, currency) {
  return currencyLabel(currency) + Number(amount || 0).toFixed(currencyDecimals(currency));
}
const REGION = "asia-southeast1";
const INVOICE_DUE_DAYS = 7;
// TODO: replace with the client's own Firebase Auth UID once their admin account exists.
const ADMIN_UIDS = ["PLACEHOLDER_ADMIN_UID"];

const SELFPAY_PRICE_ID = "price_1Tt3APHDsXq2ou3cZ8EIEsvh"; // SGD S$2.99/mo recurring price
const SELFPAY_PRICE_SGD = 2.99;
const SELFPAY_SUCCESS_URL = "https://global-tnf-diet-tracker.web.app/subscribed.html";
const SELFPAY_CANCEL_URL = "https://global-tnf-diet-tracker.web.app/subscribed.html?canceled=1";

// Self-pay monthly prices per currency, editable by admin at config/selfPay.
// Until an admin saves a list, this seeded default applies. SGD-only for now
// (Singapore audience); add USD or other currencies via the admin portal's
// "Self-pay app prices" panel when expanding overseas.
const SELFPAY_DEFAULT_PRICES = { sgd: SELFPAY_PRICE_SGD };
async function loadSelfPayPrices() {
  const snap = await db.doc("config/selfPay").get();
  const stored = (snap.exists && snap.data() && snap.data().prices) || null;
  if (!stored || !Object.keys(stored).length) return { ...SELFPAY_DEFAULT_PRICES };
  const out = {};
  for (const [k, v] of Object.entries(stored)) {
    const c = String(k).toLowerCase();
    if (/^[a-z]{3}$/.test(c) && Number(v) > 0) out[c] = Number(v);
  }
  if (out.sgd == null) out.sgd = SELFPAY_PRICE_SGD; // always keep a base currency
  return out;
}

const PUBLIC_GYM_ID = "Public-01";
const PUBLIC_GYM_NAME = "Public-Self Paying Individual";

function stripe() {
  return new Stripe(STRIPE_SECRET_KEY.value(), { apiVersion: "2024-06-20" });
}
function previousPeriodId(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
async function ensureCustomer(sk, gymId, gym) {
  if (gym.stripeCustomerId) return gym.stripeCustomerId;
  const customer = await sk.customers.create(
    { name: gym.name || gymId, email: gym.billingEmail, metadata: { gymId } },
    { idempotencyKey: `cust_${gymId}` }
  );
  await db.doc(`gyms/${gymId}`).set({ stripeCustomerId: customer.id }, { merge: true });
  return customer.id;
}
function periodBounds(periodId) {
  const [y, m] = periodId.split("-").map(Number);
  return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) };
}
async function countEngaged(gymId, start, end, demo = false) {
  const enr = await db
    .collectionGroup("enrollments")
    .where("gymId", "==", gymId)
    .where("status", "==", "active")
    .get();
  let engaged = 0;
  for (const doc of enr.docs) {
    const uid = doc.ref.parent.parent && doc.ref.parent.parent.id;
    if (!uid) continue;
    if (await isEngaged(db, uid, start, end, { demo })) engaged++;
  }
  return engaged;
}
async function invoiceGymForPeriod(sk, gymId, period) {
  if (gymId === PUBLIC_GYM_ID) return "public-selfpay-skip";
  const gymRef = db.doc(`gyms/${gymId}`);
  const gymSnap = await gymRef.get();
  if (!gymSnap.exists) return "gym-missing";
  const gym = gymSnap.data();
  if (gym.status !== "active") return "gym-inactive";
  if (gym.billingActive === false) return "not-billing-trial";
  if (!gym.billingEmail) return "no-billing-email";
  const snapRef = gymRef.collection("billingSnapshots").doc(period);
  const snapDoc = await snapRef.get();
  if (!snapDoc.exists) return "no-snapshot";
  const snap = snapDoc.data();
  if (snap.stripeInvoiceId) return "already-invoiced";
  const price = Number(gym.pricePerMemberUsd ?? snap.pricePerMemberUsd ?? 0);
  const currency = normCurrency(gym.currency);
  const dec = currencyDecimals(currency);
  const { start: periodStart, end: periodEnd } = periodBounds(period);
  const activeCount = await countEngaged(gymId, periodStart, periodEnd, gym.demoMode === true);
  if (activeCount <= 0 || price <= 0) return "nothing-to-bill";
  const total = Number((activeCount * price).toFixed(dec));
  const amountCents = toMinorUnits(total, currency);
  const customerId = await ensureCustomer(sk, gymId, gym);
  const idem = `inv_${gymId}_${period}`;
  // Create the DRAFT invoice first, then attach the line item to it by id.
  // Creating a pending invoice item and relying on invoices.create to sweep it
  // in is unreliable — it can leave the item unattached and finalize a $0
  // invoice (which then auto-marks paid). Passing `invoice: invoice.id` binds
  // the charge to this exact invoice.
  const invoice = await sk.invoices.create(
    {
      customer: customerId,
      collection_method: "send_invoice",
      days_until_due: INVOICE_DUE_DAYS,
      auto_advance: true,
      metadata: { gymId, period },
      description: `Gym sponsorship — ${gym.name || gymId} — ${period}`,
    },
    { idempotencyKey: `${idem}_invoice` }
  );
  await sk.invoiceItems.create(
    {
      customer: customerId,
      invoice: invoice.id,
      currency,
      amount: amountCents,
      description: `Diet Tracker — ${period}: ${activeCount} member${activeCount > 1 ? "s" : ""} who used the app × ${fmtMoney(price, currency)}`,
      metadata: { gymId, period },
    },
    { idempotencyKey: `${idem}_item` }
  );
  await sk.invoices.finalizeInvoice(invoice.id, { idempotencyKey: `${idem}_finalize` });
  await sk.invoices.sendInvoice(invoice.id, { idempotencyKey: `${idem}_send` });
  await snapRef.set(
    {
      stripeInvoiceId: invoice.id,
      invoiceStatus: "sent",
      invoicedAt: admin.firestore.FieldValue.serverTimestamp(),
      billedActiveCount: activeCount,
      billedCurrency: currency,
      billedTotal: total,
      // Legacy field kept for older billing-history rows; only meaningful for SGD.
      billedTotalSgd: currency === "sgd" ? total : null,
    },
    { merge: true }
  );
  logger.info(`Invoiced ${gymId} for ${period}: ${fmtMoney(total, currency)} (${invoice.id})`);
  return "invoiced";
}
exports.invoiceGymsMonthly = onSchedule(
  { schedule: "3 9 1 * *", timeZone: "Asia/Singapore", region: REGION, secrets: [STRIPE_SECRET_KEY] },
  async () => {
    const sk = stripe();
    const period = previousPeriodId(new Date());
    const gyms = await db.collection("gyms").where("status", "==", "active").get();
    const results = {};
    for (const g of gyms.docs) {
      if (g.id === PUBLIC_GYM_ID) { results[g.id] = "public-selfpay-skip"; continue; }
      try { results[g.id] = await invoiceGymForPeriod(sk, g.id, period); }
      catch (e) { results[g.id] = `error: ${e.message}`; logger.error(`Invoice failed for ${g.id} ${period}`, e); }
    }
    logger.info(`Monthly invoicing for ${period} complete`, results);
  }
);
exports.invoiceGymNow = onCall(
  { region: REGION, secrets: [STRIPE_SECRET_KEY] },
  async (req) => {
    if (!req.auth || !ADMIN_UIDS.includes(req.auth.uid)) throw new HttpsError("permission-denied", "Admins only.");
    const { gymId, period } = req.data || {};
    if (!gymId) throw new HttpsError("invalid-argument", "gymId is required");
    const sk = stripe();
    const p = period || previousPeriodId(new Date());
    const result = await invoiceGymForPeriod(sk, gymId, p);
    return { gymId, period: p, result };
  }
);

async function setPublicRoster(uid, active, email) {
  await db.doc(`users/${uid}/enrollments/${PUBLIC_GYM_ID}`).set(
    {
      gymId: PUBLIC_GYM_ID,
      gymName: PUBLIC_GYM_NAME,
      status: active ? "active" : "inactive",
      memberEmail: email || null,
      source: "selfpay",
      coachSince: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}
async function grantSelfPayFromStripe(uid, { email, until, customerId, subscriptionId, currency, price }) {
  await db.doc(`selfPay/${uid}`).set(
    {
      active: true,
      email: email || null,
      price: price != null ? Number(price) : SELFPAY_PRICE_SGD,
      currency: String(currency || "sgd").toLowerCase(),
      until,
      source: "stripe",
      stripeCustomerId: customerId || null,
      stripeSubscriptionId: subscriptionId || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  await setPublicRoster(uid, true, email);
  await computeAccess(uid);
}
async function revokeSelfPayFromStripe(uid) {
  await db.doc(`selfPay/${uid}`).set(
    { active: false, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
  await setPublicRoster(uid, false);
  await computeAccess(uid);
}
// The currencies + prices a member may choose for self-pay. Signed-in members
// call this to build their currency picker; admins call it to prefill the editor.
exports.getSelfPayOptions = onCall({ region: REGION }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Please sign in first.");
  const prices = await loadSelfPayPrices();
  const options = Object.keys(prices).sort().map((c) => ({
    currency: c,
    amount: prices[c],
    label: fmtMoney(prices[c], c),
  }));
  return { options };
});

// Admin: replace the self-pay price list. Body: { prices: { sgd: 2.99, usd: 2.99, myr: 9.9, ... } }.
exports.setSelfPayPrices = onCall({ region: REGION }, async (req) => {
  if (!req.auth || !ADMIN_UIDS.includes(req.auth.uid)) throw new HttpsError("permission-denied", "Admins only.");
  const input = (req.data && req.data.prices) || {};
  const prices = {};
  for (const [k, v] of Object.entries(input)) {
    const c = String(k).trim().toLowerCase();
    const amt = Number(v);
    if (/^[a-z]{3}$/.test(c) && amt > 0) prices[c] = Math.round(amt * 1000) / 1000;
  }
  if (!prices.sgd) prices.sgd = SELFPAY_PRICE_SGD; // never drop the base currency
  // Overwrite the whole doc (NO merge). merge:true would deep-merge the nested
  // `prices` map and keep currencies the admin just removed.
  await db.doc("config/selfPay").set(
    { prices, updatedAt: admin.firestore.FieldValue.serverTimestamp() }
  );
  return { ok: true, prices };
});

exports.createSelfPayCheckout = onCall(
  { region: REGION, secrets: [STRIPE_SECRET_KEY] },
  async (req) => {
    if (!req.auth) throw new HttpsError("unauthenticated", "Please sign in first.");
    const uid = req.auth.uid;
    const email = (req.auth.token && req.auth.token.email) || (req.data && req.data.email) || undefined;
    const currency = normCurrency(req.data && req.data.currency);
    const prices = await loadSelfPayPrices();
    const amount = Number(prices[currency]);
    if (!(amount > 0)) {
      throw new HttpsError("failed-precondition", `No self-pay price is set for ${currency.toUpperCase()}.`);
    }
    const sk = stripe();
    // SGD at the standard price keeps the pre-made Stripe price (clean
    // reporting); any other currency (or a changed SGD price) is billed via an
    // inline recurring price, so no dashboard price needs to be created.
    const lineItem = (currency === "sgd" && amount === SELFPAY_PRICE_SGD)
      ? { price: SELFPAY_PRICE_ID, quantity: 1 }
      : { quantity: 1, price_data: {
          currency,
          unit_amount: toMinorUnits(amount, currency),
          recurring: { interval: "month" },
          product_data: { name: "Diet Tracker — self-pay membership" },
        } };
    const meta = { uid, email: email || "", currency, price: String(amount) };
    const session = await sk.checkout.sessions.create({
      mode: "subscription",
      line_items: [lineItem],
      customer_email: email,
      client_reference_id: uid,
      subscription_data: { metadata: meta },
      metadata: { ...meta, kind: "selfpay" },
      success_url: SELFPAY_SUCCESS_URL,
      cancel_url: SELFPAY_CANCEL_URL,
      allow_promotion_codes: true,
    });
    return { url: session.url };
  }
);
exports.stripeWebhook = onRequest(
  { region: REGION, secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET] },
  async (request, response) => {
    const sk = stripe();
    let event;
    try {
      event = sk.webhooks.constructEvent(
        request.rawBody,
        request.headers["stripe-signature"],
        STRIPE_WEBHOOK_SECRET.value()
      );
    } catch (err) {
      logger.error("Webhook signature verification failed", err);
      return response.status(400).send(`Webhook Error: ${err.message}`);
    }
    try {
      if (event.type === "checkout.session.completed") {
        const s = event.data.object;
        if (s.mode === "subscription" && s.metadata && s.metadata.uid && s.subscription) {
          const sub = await sk.subscriptions.retrieve(s.subscription);
          await grantSelfPayFromStripe(s.metadata.uid, {
            email: s.metadata.email || (s.customer_details && s.customer_details.email) || null,
            until: admin.firestore.Timestamp.fromMillis(sub.current_period_end * 1000),
            customerId: s.customer,
            subscriptionId: s.subscription,
            currency: s.metadata.currency || (sub.metadata && sub.metadata.currency) || "sgd",
            price: s.metadata.price || (sub.metadata && sub.metadata.price),
          });
          logger.info(`Self-pay activated for ${s.metadata.uid} via checkout ${s.id}`);
        }
      } else if (event.type === "customer.subscription.deleted") {
        const sub = event.data.object;
        const uid = sub.metadata && sub.metadata.uid;
        if (uid) { await revokeSelfPayFromStripe(uid); logger.info(`Self-pay canceled for ${uid}`); }
      } else if (
        event.type === "invoice.paid" &&
        event.data.object.subscription &&
        !(event.data.object.metadata && event.data.object.metadata.gymId)
      ) {
        const inv = event.data.object;
        const sub = await sk.subscriptions.retrieve(inv.subscription);
        const uid = sub.metadata && sub.metadata.uid;
        if (uid) {
          await grantSelfPayFromStripe(uid, {
            email: (sub.metadata && sub.metadata.email) || null,
            until: admin.firestore.Timestamp.fromMillis(sub.current_period_end * 1000),
            customerId: inv.customer,
            subscriptionId: inv.subscription,
            currency: (sub.metadata && sub.metadata.currency) || "sgd",
            price: (sub.metadata && sub.metadata.price),
          });
          logger.info(`Self-pay renewed for ${uid} (invoice ${inv.id})`);
        }
      }
      const gymStatusMap = {
        "invoice.paid": "paid",
        "invoice.payment_failed": "failed",
        "invoice.marked_uncollectible": "uncollectible",
        "invoice.voided": "voided",
      };
      const status = gymStatusMap[event.type];
      if (status) {
        const inv = event.data.object;
        const md = inv.metadata || {};
        if (md.gymId && md.period) {
          await db.doc(`gyms/${md.gymId}/billingSnapshots/${md.period}`).set(
            {
              invoiceStatus: status,
              invoiceStatusAt: admin.firestore.FieldValue.serverTimestamp(),
              invoiceHostedUrl: inv.hosted_invoice_url || null,
            },
            { merge: true }
          );
          if (status === "failed" && inv.next_payment_attempt === null) {
            await db.doc(`gyms/${md.gymId}`).set({ billingState: "past_due" }, { merge: true });
          }
          logger.info(`Snapshot ${md.gymId}/${md.period} -> ${status}`);
        }
      }
    } catch (err) {
      logger.error("Webhook handler error", err);
    }
    response.json({ received: true });
  }
);
