/**
 * Phase 2 — admin function to create a gym-owner login.
 * ---------------------------------------------------------------------------
 * You (admin) call this once per gym. It:
 *   1. creates (or reuses) a Firebase Auth user for the gym's email,
 *   2. sets a custom claim { gymId } on that user  <-- the security rules key,
 *   3. records a gymOwners/{uid} mapping doc,
 *   4. returns a password-setup link the gym clicks to choose their password.
 *
 * Firebase Functions v2. Add to your functions/ folder and re-export from index.js:
 *   const gymAdmin = require("./gymAdmin");
 *   exports.createGymOwner = gymAdmin.createGymOwner;
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { isEngaged } = require("./engagement");

if (!admin.apps.length) admin.initializeApp();

const REGION = "asia-southeast1";

// Only these accounts may create gym logins.
// TODO: replace with the client's own Firebase Auth UID once their admin account exists.
const ADMIN_UIDS = ["EwPXERBcCOZqq7NlD6gbjQO7bQu1"];

exports.createGymOwner = onCall({ region: REGION }, async (req) => {
  if (!req.auth || !ADMIN_UIDS.includes(req.auth.uid)) {
    throw new HttpsError("permission-denied", "Admins only.");
  }
  const email = (req.data && req.data.email || "").trim().toLowerCase();
  const gymId = (req.data && req.data.gymId || "").trim();
  if (!email || !gymId) {
    throw new HttpsError("invalid-argument", "email and gymId are required.");
  }

  // gym must exist
  const gymSnap = await admin.firestore().doc(`gyms/${gymId}`).get();
  if (!gymSnap.exists) {
    throw new HttpsError("not-found", `Gym "${gymId}" was not found.`);
  }

  // create or reuse the auth user
  let user;
  try {
    user = await admin.auth().getUserByEmail(email);
  } catch (e) {
    user = await admin.auth().createUser({ email, emailVerified: false });
  }

  // the claim the security rules check
  await admin.auth().setCustomUserClaims(user.uid, { gymId });

  // mapping doc (handy for an admin "gyms & logins" view later)
  await admin.firestore().doc(`gymOwners/${user.uid}`).set(
    {
      email,
      gymId,
      gymName: gymSnap.data().name || gymId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  // link the gym clicks to set their own password (no password sent by you).
  // The continue URL makes the reset page show a "Continue" button back to the
  // gym portal login once they've set their password.
  const passwordSetupLink = await admin.auth().generatePasswordResetLink(email, {
    url: "https://global-tnf-diet-tracker.web.app/gym-portal.html",
    handleCodeInApp: false,
  });

  return { uid: user.uid, gymId, email, passwordSetupLink };
});


// ---------------------------------------------------------------------------
// Admin: fully delete one gym — the gym doc (+ billingSnapshots), its owner
// login (Auth user + mapping), all member enrollments in this gym, and its
// pending invites. Member app accounts and their tracker data are NOT touched.
// ---------------------------------------------------------------------------
async function _deleteRefs(db, refs) {
  for (let i = 0; i < refs.length; i += 400) {
    const batch = db.batch();
    refs.slice(i, i + 400).forEach((ref) => batch.delete(ref));
    await batch.commit();
  }
}

exports.deleteGym = onCall({ region: REGION }, async (req) => {
  if (!req.auth || !ADMIN_UIDS.includes(req.auth.uid)) {
    throw new HttpsError("permission-denied", "Admins only.");
  }
  const gymId = ((req.data && req.data.gymId) || "").trim();
  if (!gymId) throw new HttpsError("invalid-argument", "gymId is required.");

  const db = admin.firestore();
  const summary = { enrollments: 0, pendingEnrollments: 0, gymOwnerLogins: 0, gym: 0 };

  // member enrollments in this gym (collection-group on the gymId field)
  const enr = await db.collectionGroup("enrollments").where("gymId", "==", gymId).get();
  await _deleteRefs(db, enr.docs.map((d) => d.ref));
  summary.enrollments = enr.size;

  // pending invites for this gym
  const pend = await db.collection("pendingEnrollments").where("gymId", "==", gymId).get();
  await _deleteRefs(db, pend.docs.map((d) => d.ref));
  summary.pendingEnrollments = pend.size;

  // gym-owner logins tied to this gym (Auth user + mapping doc); never the admin
  const owners = await db.collection("gymOwners").where("gymId", "==", gymId).get();
  for (const doc of owners.docs) {
    if (ADMIN_UIDS.includes(doc.id)) continue;
    try { await admin.auth().deleteUser(doc.id); summary.gymOwnerLogins++; } catch (e) { /* already gone */ }
    await doc.ref.delete();
  }

  // the gym doc + its billingSnapshots subcollection
  await db.recursiveDelete(db.doc(`gyms/${gymId}`));
  summary.gym = 1;

  return { ok: true, gymId, summary };
});


// ---------------------------------------------------------------------------
// Admin: UN-bind a gym owner from their gym (the reverse of createGymOwner).
// Clears the account's gym tag (custom claim), deletes the gymOwners mapping,
// and removes that owner's OWN membership in this gym. The Firebase Auth account
// is KEPT (and admin-by-uid is unaffected, since it's not a claim). Other
// members of the gym are left alone.
// ---------------------------------------------------------------------------
exports.unbindGymOwner = onCall({ region: REGION }, async (req) => {
  if (!req.auth || !ADMIN_UIDS.includes(req.auth.uid)) {
    throw new HttpsError("permission-denied", "Admins only.");
  }
  const gymId = ((req.data && req.data.gymId) || "").trim();
  if (!gymId) throw new HttpsError("invalid-argument", "gymId is required.");

  const db = admin.firestore();
  const owners = await db.collection("gymOwners").where("gymId", "==", gymId).get();
  const summary = { logins: 0, enrollmentsRemoved: 0, emails: [] };

  for (const doc of owners.docs) {
    const uid = doc.id;
    const email = doc.data().email || uid;
    // Clear the gym tag. The account stays; admin status is uid-based, so an
    // admin account keeps its admin powers.
    try { await admin.auth().setCustomUserClaims(uid, {}); } catch (e) { /* ignore */ }
    // Remove this owner's own membership in this gym (deleting the enrollment
    // auto-recomputes their access via onEnrollmentWrite).
    const enrRef = db.doc(`users/${uid}/enrollments/${gymId}`);
    if ((await enrRef.get()).exists) { await enrRef.delete(); summary.enrollmentsRemoved++; }
    await doc.ref.delete();
    summary.logins++;
    summary.emails.push(email);
  }
  return { ok: true, gymId, summary };
});


// ---------------------------------------------------------------------------
// Admin: strip the gym tag (custom claim) from an account BY EMAIL. Use this to
// clean up an account that still carries a gymId claim after its gym was deleted
// or reset. Keeps the account, its data, and admin-by-uid status.
// ---------------------------------------------------------------------------
exports.clearGymTag = onCall({ region: REGION }, async (req) => {
  if (!req.auth || !ADMIN_UIDS.includes(req.auth.uid)) {
    throw new HttpsError("permission-denied", "Admins only.");
  }
  const email = ((req.data && req.data.email) || "").trim().toLowerCase();
  if (!email) throw new HttpsError("invalid-argument", "email is required.");

  let user;
  try { user = await admin.auth().getUserByEmail(email); }
  catch (e) { throw new HttpsError("not-found", `No account found for ${email}.`); }

  const hadTag = !!(user.customClaims && user.customClaims.gymId);
  await admin.auth().setCustomUserClaims(user.uid, {}); // clears all custom claims

  const db = admin.firestore();
  const ownerRef = db.doc(`gymOwners/${user.uid}`);
  const hadDoc = (await ownerRef.get()).exists;
  if (hadDoc) await ownerRef.delete();

  return { ok: true, email, uid: user.uid, hadTag, hadDoc, priorTag: (user.customClaims || {}).gymId || null };
});


// ---------------------------------------------------------------------------
// Admin: how many active members of each gym actually USED the app this month
// (logged >=1 entry). Backs usage-based pricing — "you only pay for members who
// use it". Read-only; may be a bit slow (one lookup per active member).
// ---------------------------------------------------------------------------
exports.engagementReport = onCall({ region: REGION }, async (req) => {
  if (!req.auth || !ADMIN_UIDS.includes(req.auth.uid)) {
    throw new HttpsError("permission-denied", "Admins only.");
  }
  const db = admin.firestore();
  const now = new Date();
  // "current" = this calendar month so far; "previous" = last complete month
  // (what you'd normally invoice on the 1st).
  const which = (req.data && req.data.period) === "previous" ? "previous" : "current";
  const mOff = which === "previous" ? -1 : 0;
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + mOff, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + mOff + 1, 1));

  const gyms = await db.collection("gyms").get();
  const rows = [];
  for (const gDoc of gyms.docs) {
    const gymId = gDoc.id;
    const gym = gDoc.data();
    const enr = await db
      .collectionGroup("enrollments")
      .where("gymId", "==", gymId)
      .where("status", "==", "active")
      .get();
    let engaged = 0;
    for (const e of enr.docs) {
      const uid = e.ref.parent.parent && e.ref.parent.parent.id;
      if (!uid) continue;
      if (await isEngaged(db, uid, start, end, { demo: gym.demoMode === true })) engaged++;
    }
    const rate = Number(gym.pricePerMemberUsd || 0);
    // Trial gyms (and paused gyms) are not billed.
    const billingActive = gym.billingActive !== false && (gym.status || "active") === "active";
    rows.push({
      gymId,
      name: gym.name || gymId,
      billingEmail: gym.billingEmail || "",
      currency: (gym.currency || "sgd"),
      active: enr.size,
      engaged,
      rate,
      billingActive,
      amount: billingActive ? Math.round(engaged * rate * 100) / 100 : 0,
      lastBilledPeriod: gym.lastBilledPeriod || null,
      demo: gym.demoMode === true,
    });
  }
  const period = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`;
  return { period, which, rows };
});


// ---------------------------------------------------------------------------
// Gym owner (or admin): how many of MY active members used the app this month.
// Returns only aggregate counts — never any individual member's private data.
// ---------------------------------------------------------------------------
exports.myGymEngagement = onCall({ region: REGION }, async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const isAdmin = ADMIN_UIDS.includes(req.auth.uid);
  const claimGym = req.auth.token && req.auth.token.gymId;
  const gymId = isAdmin ? ((req.data && req.data.gymId) || claimGym) : claimGym;
  if (!gymId) throw new HttpsError("permission-denied", "No gym for this account.");

  const db = admin.firestore();
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const gymDoc = await db.doc(`gyms/${gymId}`).get();
  const demo = gymDoc.exists && gymDoc.data().demoMode === true;

  const enr = await db
    .collectionGroup("enrollments")
    .where("gymId", "==", gymId)
    .where("status", "==", "active")
    .get();
  let engaged = 0;
  for (const e of enr.docs) {
    const uid = e.ref.parent.parent && e.ref.parent.parent.id;
    if (!uid) continue;
    if (await isEngaged(db, uid, start, end, { demo })) engaged++;
  }
  return { active: enr.size, engaged };
});

// ---------------------------------------------------------------------------
// Admin: one member's day-by-day activity — how many foods they logged each day
// over the last N days. Uses the SAME per-day (Singapore-time) buckets the
// billing engagement rule uses. "Foods logged" = saved entries (a photo scan, a
// manual add, or a favourite), read from users/{uid}/entries. No app change.
// ---------------------------------------------------------------------------
const SGT_OFFSET_MS = 8 * 60 * 60 * 1000; // Singapore, UTC+8, no DST

exports.memberDailyActivity = onCall({ region: REGION }, async (req) => {
  if (!req.auth || !ADMIN_UIDS.includes(req.auth.uid)) {
    throw new HttpsError("permission-denied", "Admins only.");
  }
  const db = admin.firestore();
  const email = ((req.data && req.data.email) || "").trim().toLowerCase();
  let uid = ((req.data && req.data.uid) || "").trim();
  if (!uid && email) {
    try { uid = (await admin.auth().getUserByEmail(email)).uid; }
    catch (e) { throw new HttpsError("not-found", `No app account found for ${email}. They must sign into the app once first.`); }
  }
  if (!uid) throw new HttpsError("invalid-argument", "A member email or uid is required.");

  const days = Math.min(90, Math.max(1, Math.floor(Number((req.data && req.data.days) || 30))));
  const nowMs = Date.now();
  const todayDay = Math.floor((nowMs + SGT_OFFSET_MS) / 86400000); // SGT calendar day index
  const startDay = todayDay - (days - 1);
  const startMs = startDay * 86400000 - SGT_OFFSET_MS;             // real UTC ms of SGT-midnight

  const snap = await db.collection(`users/${uid}/entries`)
    .where("timestamp", ">=", admin.firestore.Timestamp.fromMillis(startMs))
    .get();

  const perDay = {};
  snap.forEach((doc) => {
    const t = doc.get("timestamp");
    if (!t) return;
    const ms = t.toMillis ? t.toMillis() : new Date(t).getTime();
    const day = Math.floor((ms + SGT_OFFSET_MS) / 86400000);
    perDay[day] = (perDay[day] || 0) + 1;
  });

  const rows = [];
  for (let d = todayDay; d >= startDay; d--) {
    const dateStr = new Date(d * 86400000).toISOString().slice(0, 10); // SGT calendar date
    rows.push({ date: dateStr, count: perDay[d] || 0 });
  }
  const total = rows.reduce((s, r) => s + r.count, 0);
  const activeDays = rows.filter((r) => r.count > 0).length;
  return { uid, email: email || null, days, total, activeDays, rows };
});
