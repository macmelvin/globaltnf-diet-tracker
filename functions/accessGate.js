/**
 * Access gate — maintains memberAccess/{uid}.active so the database itself can
 * decide whether a member may use the tracker. Works for the phone app without
 * any app change: the security rules refuse tracker data when active == false.
 *
 * The flag lives in its OWN collection (memberAccess), written only by this
 * function (Admin SDK). Members can't write it, so they can't self-unlock, and
 * your existing users/{uid} write rule is untouched.
 *
 *   active = TRUE if the member has ANY active gym enrollment
 *            OR their individualSubscriptionStatus == "active".
 *
 * Firebase Functions v2. Re-export from index.js:
 *   const gate = require("./accessGate");
 *   exports.onEnrollmentWrite  = gate.onEnrollmentWrite;
 *   exports.onUserWrite        = gate.onUserWrite;
 *   exports.recomputeAllAccess = gate.recomputeAllAccess;
 */

const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const logger = require("firebase-functions/logger");

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const REGION = "asia-southeast1";
const ADMIN_UIDS = ["U51HtMKGzMPObg48Ry2h4KzudBX2"]; // your admin uid
const PUBLIC_GYM_ID = "Public-01"; // self-pay roster bucket; never grants access on its own

// Developer / owner accounts: ALWAYS have full access, never gated by trial or
// subscription, never billed, never shown in the self-pay panel. Add any of your
// own test accounts here. Compared case-insensitively.
const DEV_EMAILS = ["macmelvin.tan@gmail.com"];

/** Recompute + persist memberAccess/{uid}.active for one member. Writes on change only. */
async function computeAccess(uid) {
  // A member's users/{uid} doc often does NOT exist as a standalone document —
  // the app only writes subcollections (profile, entries, weightLog, ...). So we
  // must NOT bail when it's missing; we still compute access from enrollments.
  // Access is ENROLLMENT-ONLY (Option B): a member is active only while an
  // active gym sponsors them. A paused gym (admin stopped its account) sponsors
  // nobody. The individual (B2C) subscription path is intentionally NOT honored
  // until real Google Play billing exists — so a leftover
  // individualSubscriptionStatus flag must NEVER grant access on its own.
  const activeEnrs = await db
    .collection(`users/${uid}/enrollments`)
    .where("status", "==", "active")
    .get();
  let sponsored = false;
  for (const e of activeEnrs.docs) {
    const gymId = e.data().gymId;
    if (!gymId) continue;
    if (gymId === PUBLIC_GYM_ID) continue; // Public-01 is a roster bucket, not a sponsor
    const gymSnap = await db.doc(`gyms/${gymId}`).get();
    if (gymSnap.exists && (gymSnap.data().status || "active") === "active") {
      sponsored = true;
      break;
    }
  }

  // Self-pay (direct B2C) entitlement — set by the backend when the member pays
  // YOU directly, outside the app store. Treated exactly like a sponsorship.
  let selfPayActive = false;
  const spSnap = await db.doc(`selfPay/${uid}`).get();
  if (spSnap.exists) {
    const sp = spSnap.data();
    const untilMs = sp.until && sp.until.toMillis ? sp.until.toMillis() : null;
    selfPayActive = sp.active === true && (untilMs === null || untilMs > Date.now());
  }

  let active = sponsored || selfPayActive;

  // Developer/owner accounts always have access — never subject to trial/subscribe.
  // Only look up the email when they'd otherwise be locked out (keeps this cheap
  // for the common case where the member already has access).
  if (!active && DEV_EMAILS.length) {
    try {
      const u = await admin.auth().getUser(uid);
      if (u.email && DEV_EMAILS.includes(u.email.toLowerCase())) active = true;
    } catch (e) { /* no auth account for this uid */ }
  }

  const accessRef = db.doc(`memberAccess/${uid}`);
  const cur = await accessRef.get();
  const prev = cur.exists ? cur.data().active : undefined;
  if (prev !== active) {
    await accessRef.set(
      { uid, active, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    logger.info(`memberAccess ${uid}: ${active} (sponsored=${sponsored}, selfPay=${selfPayActive})`);
  }
  return active;
}

// Enrollment added/toggled/removed -> recompute that member.
exports.onEnrollmentWrite = onDocumentWritten(
  { document: "users/{uid}/enrollments/{eid}", region: REGION },
  (event) => computeAccess(event.params.uid)
);

// individualSubscriptionStatus changed -> recompute. (Writing memberAccess does
// NOT retrigger this, so there's no loop.)
exports.onUserWrite = onDocumentWritten(
  { document: "users/{uid}", region: REGION },
  async (event) => {
    const before = event.data.before.exists ? event.data.before.data() : {};
    const after = event.data.after.exists ? event.data.after.data() : {};
    if (before.individualSubscriptionStatus !== after.individualSubscriptionStatus) {
      await computeAccess(event.params.uid);
    }
  }
);

// Gym paused / reactivated by the admin -> recompute every member enrolled in
// that gym, so a paused gym instantly drops its members (and reactivation
// restores anyone who's still enrolled active).
exports.onGymWrite = onDocumentWritten(
  { document: "gyms/{gymId}", region: REGION },
  async (event) => {
    const beforeExists = event.data.before.exists;
    const afterExists = event.data.after.exists;
    const beforeStatus = beforeExists ? (event.data.before.data().status || "active") : null;
    const afterStatus = afterExists ? (event.data.after.data().status || "active") : null;
    if (beforeStatus === afterStatus) return; // only status changes matter

    const gymId = event.params.gymId;
    const enrs = await db.collectionGroup("enrollments").where("gymId", "==", gymId).get();
    const uids = new Set();
    enrs.forEach((d) => {
      const uid = d.ref.parent.parent && d.ref.parent.parent.id;
      if (uid) uids.add(uid);
    });
    for (const uid of uids) await computeAccess(uid);
    logger.info(`onGymWrite ${gymId}: ${beforeStatus}->${afterStatus}, recomputed ${uids.size} member(s)`);
  }
);

// Self-pay entitlement changed -> recompute that member's access.
exports.onSelfPayWrite = onDocumentWritten(
  { document: "selfPay/{uid}", region: REGION },
  (event) => computeAccess(event.params.uid)
);

// Exposed so selfPay.js can recompute a member immediately after granting.
exports.computeAccess = computeAccess;
// Exposed so selfPay.startTrial can short-circuit developer accounts.
exports.DEV_EMAILS = DEV_EMAILS;

// One-time backfill — run BEFORE enabling the gating rules (and any time to
// re-sync). Stamps memberAccess for every member. Admin only.
exports.recomputeAllAccess = onCall({ region: REGION }, async (req) => {
  if (!req.auth || !ADMIN_UIDS.includes(req.auth.uid)) {
    throw new HttpsError("permission-denied", "Admins only.");
  }
  // Members are identified by their enrollments — a member's users/{uid} doc may
  // not exist as a standalone document (only subcollections), so we can't list
  // the users collection to find them.
  const enrs = await db.collectionGroup("enrollments").get();
  const uids = new Set();
  enrs.forEach((d) => {
    const uid = d.ref.parent.parent && d.ref.parent.parent.id;
    if (uid) uids.add(uid);
  });
  // Also include anyone who already has a memberAccess flag, so a STALE flag
  // gets corrected even if that member no longer has an active sponsorship.
  const existing = await db.collection("memberAccess").get();
  existing.forEach((d) => uids.add(d.id));

  let changed = 0;
  for (const uid of uids) {
    const before = (await db.doc(`memberAccess/${uid}`).get()).data();
    const now = await computeAccess(uid);
    if (!before || before.active !== now) changed++;
  }
  return { total: uids.size, changed };
});
