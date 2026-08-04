/**
 * Direct (B2C) self-pay entitlement — the "member-of-one" model.
 *
 * A member who has no gym sponsorship can pay directly (via Stripe, or a manual
 * admin grant) and keep using the app. Stored at selfPay/{uid}; the access gate
 * treats an active, unexpired self-pay entitlement exactly like a sponsorship.
 *
 * ROSTER: self-pay members are also listed under the Public-01 "gym" so they
 * show in a roster. That enrollment is roster-only — accessGate skips Public-01,
 * so it never grants access; access is driven purely by selfPay/{uid}. We keep
 * the roster flag in lockstep here (active on grant, inactive on revoke/expire).
 */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const { computeAccess } = require("./accessGate");
const { queueTrialWelcomeEmail } = require("./memberEnroll");
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();
const REGION = "asia-southeast1";
// TODO: replace with the client's own Firebase Auth UID once their admin account exists.
const ADMIN_UIDS = ["PLACEHOLDER_ADMIN_UID"];
const PUBLIC_GYM_ID = "Public-01";
const PUBLIC_GYM_NAME = "Public-Self Paying Individual";
const TRIAL_DAYS = 30; // free trial granted on first sign-up (web/app), once per account

function requireAdmin(req) {
  if (!req.auth || !ADMIN_UIDS.includes(req.auth.uid)) {
    throw new HttpsError("permission-denied", "Admins only.");
  }
}

/** Roster-only Public-01 enrollment (never grants access; accessGate skips it). */
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

// Grant/extend a self-pay entitlement by email, for N months, at a price.
exports.grantSelfPay = onCall({ region: REGION }, async (req) => {
  requireAdmin(req);
  const email = ((req.data && req.data.email) || "").trim().toLowerCase();
  const months = Math.max(1, Math.floor(Number((req.data && req.data.months) || 1)));
  const price = Number((req.data && req.data.price) || 0);
  if (!email) throw new HttpsError("invalid-argument", "Member email is required.");
  let user;
  try { user = await admin.auth().getUserByEmail(email); }
  catch (e) { throw new HttpsError("not-found", `No app account found for ${email}. They must sign into the app once first.`); }
  const until = admin.firestore.Timestamp.fromMillis(Date.now() + months * 30 * 24 * 60 * 60 * 1000);
  await db.doc(`selfPay/${user.uid}`).set(
    {
      active: true,
      email,
      months,
      price,
      until,
      grantedBy: req.auth.uid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  await setPublicRoster(user.uid, true, email);
  await computeAccess(user.uid); // flip their tracker back on immediately
  return { ok: true, uid: user.uid, email, until: until.toMillis() };
});

// Called by the website (and optionally the app) right after sign-in. Grants a
// one-time 30-day free trial to a member who has NO access yet and has never had
// a trial or a paid sub. Modeled as a self-pay entitlement with an expiry, so the
// access gate, nightly expiry job, and admin self-pay list all handle it already.
//
// Returns { status }:
//   "active"        -> already has access (gym, self-pay, or an unexpired trial)
//   "trial-started" -> a fresh trial was just granted
//   "lapsed"        -> trial used and expired (or a sub lapsed); show subscribe
exports.startTrial = onCall({ region: REGION }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Please sign in first.");
  const uid = req.auth.uid;
  const email = (req.auth.token && req.auth.token.email) || null;
  const nowMs = Date.now();

  const spRef = db.doc(`selfPay/${uid}`);
  const spSnap = await spRef.get();
  const sp = spSnap.exists ? spSnap.data() : null;

  // Persistent "this account has already been given a trial" marker. It lives in
  // its OWN doc (trialUsage/{uid}) so that removing a member — deleteSelfPay,
  // which deletes the selfPay doc — does NOT wipe the memory. Without this, a
  // member who is still signed in has startTrial re-mint them a brand-new trial
  // on their next page load, re-adding them to the panel and re-sending the
  // welcome email in a loop.
  const trialRef = db.doc(`trialUsage/${uid}`);
  const trialUsed = (await trialRef.get()).exists;

  // Recompute true access (also refreshes memberAccess if a trial just expired).
  const active = await computeAccess(uid);
  if (active) {
    const untilMs = sp && sp.until && sp.until.toMillis ? sp.until.toMillis() : null;
    const isTrial = !!(sp && sp.source === "trial" && sp.active === true && untilMs && untilMs > nowMs);
    // Backfill the marker for anyone currently on a trial, so a later Remove sticks.
    if (isTrial && !trialUsed) {
      await trialRef.set({ email, trialStartedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    }
    return { status: "active", trial: isTrial, until: untilMs };
  }

  // No access. If they've EVER had a trial or a paid subscription — even if the
  // self-pay record was since deleted — don't re-grant; send them to subscribe.
  if (trialUsed || (sp && (sp.trialStartedAt || sp.source === "trial" || sp.source === "stripe"))) {
    return { status: "lapsed" };
  }

  // Grant a fresh trial (and record it in the persistent marker so it can't be
  // silently re-granted after a Remove).
  await trialRef.set(
    { email, trialStartedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
  const until = admin.firestore.Timestamp.fromMillis(nowMs + TRIAL_DAYS * 24 * 60 * 60 * 1000);
  await spRef.set(
    {
      active: true,
      email,
      source: "trial",
      price: 0,
      until,
      trialStartedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
  await setPublicRoster(uid, true, email);
  await computeAccess(uid);

  // First-time self-signup: email them the setup guide (Add-to-Home-Screen +
  // install video). Best-effort — never fail the trial if the email can't queue.
  try {
    const memberName = (req.auth.token && (req.auth.token.name || req.auth.token.given_name)) || null;
    await queueTrialWelcomeEmail(email, memberName);
  } catch (e) {
    console.error("trial welcome email failed for " + uid + ": " + (e && e.message));
  }

  return { status: "trial-started", until: until.toMillis(), days: TRIAL_DAYS };
});

// Turn a self-pay entitlement off (e.g. they stopped paying).
exports.revokeSelfPay = onCall({ region: REGION }, async (req) => {
  requireAdmin(req);
  const email = ((req.data && req.data.email) || "").trim().toLowerCase();
  if (!email) throw new HttpsError("invalid-argument", "Member email is required.");
  let user;
  try { user = await admin.auth().getUserByEmail(email); }
  catch (e) { throw new HttpsError("not-found", `No app account found for ${email}.`); }
  await db.doc(`selfPay/${user.uid}`).set(
    { active: false, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
  await setPublicRoster(user.uid, false);
  await computeAccess(user.uid);
  return { ok: true, uid: user.uid, email };
});

// Permanently delete a self-pay record (removes the row from the admin list).
// Clears the Public-01 roster enrollment and the selfPay/{uid} doc, then
// recomputes access (they lose self-pay access unless a gym still sponsors them).
// The member's app account and tracker data are NOT touched — they can be
// re-added later with grantSelfPay.
exports.deleteSelfPay = onCall({ region: REGION }, async (req) => {
  requireAdmin(req);
  let uid = ((req.data && req.data.uid) || "").trim();
  const email = ((req.data && req.data.email) || "").trim().toLowerCase();
  if (!uid && email) {
    try { uid = (await admin.auth().getUserByEmail(email)).uid; } catch (e) { /* account may be gone */ }
  }
  if (!uid) throw new HttpsError("invalid-argument", "A member uid or a resolvable email is required.");
  // Leave a persistent tombstone BEFORE deleting, so a member who is still signed
  // in can't have startTrial silently re-mint them a fresh trial (which would
  // re-add them to the panel and re-send the welcome email). A removed member
  // goes to the Subscribe screen instead. Re-grant a trial later via grantSelfPay
  // if you ever need to.
  await db.doc(`trialUsage/${uid}`).set(
    { removedAt: admin.firestore.FieldValue.serverTimestamp(), removedBy: req.auth.uid },
    { merge: true }
  );
  await db.doc(`users/${uid}/enrollments/${PUBLIC_GYM_ID}`).delete().catch(() => {});
  await db.doc(`selfPay/${uid}`).delete().catch(() => {});
  await computeAccess(uid);
  return { ok: true, uid };
});

// List all self-pay members for the admin console.
exports.listSelfPay = onCall({ region: REGION }, async (req) => {
  requireAdmin(req);
  const snap = await db.collection("selfPay").get();
  const now = Date.now();
  const rows = await Promise.all(snap.docs.map(async (d) => {
    const x = d.data();
    const untilMs = x.until && x.until.toMillis ? x.until.toMillis() : null;
    const selfPayActive = x.active === true && (untilMs === null || untilMs > now);
    // Combined app access — true if a gym sponsors them OR self-pay is active.
    // This is the flag the tracker actually gates on (memberAccess/{uid}).
    const accSnap = await db.doc(`memberAccess/${d.id}`).get();
    const hasAccess = accSnap.exists && accSnap.data().active === true;
    // Work out WHY they have access, so the admin knows which lever to pull:
    // an active self-pay entitlement and/or one or more active gym sponsors.
    const sources = [];
    if (selfPayActive) sources.push("self-pay");
    const enrSnap = await db.collection(`users/${d.id}/enrollments`).where("status", "==", "active").get();
    for (const e of enrSnap.docs) {
      const gid = e.data().gymId;
      if (!gid || gid === PUBLIC_GYM_ID) continue; // Public-01 is a roster bucket, not a sponsor
      const g = await db.doc(`gyms/${gid}`).get();
      if (g.exists && (g.data().status || "active") === "active") sources.push("gym: " + (g.data().name || gid));
    }
    return {
      uid: d.id,
      email: x.email || d.id,
      price: Number(x.price || 0),
      currency: (x.currency || "sgd"),
      until: untilMs,
      active: selfPayActive,
      hasAccess,
      accessSource: sources.join(", "),
    };
  }));
  return { rows };
});

// Nightly: expire self-pay entitlements whose paid period has ended.
exports.expireSelfPay = onSchedule(
  { schedule: "7 0 * * *", timeZone: "Asia/Singapore", region: REGION },
  async () => {
    const now = admin.firestore.Timestamp.now();
    const snap = await db
      .collection("selfPay")
      .where("active", "==", true)
      .where("until", "<=", now)
      .get();
    for (const d of snap.docs) {
      await d.ref.set(
        { active: false, expiredAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
      await setPublicRoster(d.id, false);
      await computeAccess(d.id);
    }
  }
);
