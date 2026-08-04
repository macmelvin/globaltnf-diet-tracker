/**
 * Member self-service account & data deletion (PDPA + Google Play + App Store).
 *
 * A signed-in member can permanently erase their own account and every piece of
 * data tied to it. Callable from the app (Settings) or the hosted
 * /delete-account page. The caller can only ever delete THEMSELVES
 * (uid = req.auth.uid) — there is no way to pass someone else's id.
 *
 * What it removes:
 *   users/{uid}            + ALL subcollections (profile, usage, enrollments,
 *                            entries, weightLog, water, measurements, meals,
 *                            favorites — the rules wildcard covers them all)
 *   memberAccess/{uid}     access-gate flag
 *   selfPay/{uid}          self-pay entitlement flag
 *   pendingEnrollments     any not-yet-claimed invites for this email
 *   Stripe subscription    cancelled if the member was self-paying
 *   Firebase Auth account   deleted last
 *
 * Deleting the enrollment docs also removes the member from every gym roster
 * automatically (rosters are a collection-group query over enrollments).
 */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const Stripe = require("stripe");
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();
const REGION = "asia-southeast1";
const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");

exports.deleteMyAccount = onCall(
  { region: REGION, secrets: [STRIPE_SECRET_KEY] },
  async (req) => {
    if (!req.auth) throw new HttpsError("unauthenticated", "Please sign in first.");
    // Require an explicit confirmation so this can never fire by accident.
    if (!req.data || req.data.confirm !== true) {
      throw new HttpsError("failed-precondition", "Deletion must be explicitly confirmed.");
    }

    const uid = req.auth.uid;
    const email = ((req.auth.token && req.auth.token.email) || "").toLowerCase() || null;
    const removed = [];

    // 1) Cancel any active Stripe self-pay subscription (best effort — a Stripe
    //    hiccup must not block the person's deletion request).
    try {
      const sp = await db.doc(`selfPay/${uid}`).get();
      const subId = sp.exists ? sp.data().stripeSubscriptionId : null;
      if (subId) {
        const sk = new Stripe(STRIPE_SECRET_KEY.value(), { apiVersion: "2024-06-20" });
        await sk.subscriptions.cancel(subId);
        removed.push("stripe subscription");
      }
    } catch (e) {
      logger.warn(`deleteMyAccount: Stripe cancel failed for ${uid}: ${e.message}`);
    }

    // 2) Delete the entire user tree in one shot (doc + every subcollection).
    await db.recursiveDelete(db.doc(`users/${uid}`));
    removed.push("users/" + uid + " (+ all subcollections)");

    // 3) Delete the backend-owned flags.
    for (const path of [`memberAccess/${uid}`, `selfPay/${uid}`]) {
      try { await db.doc(path).delete(); removed.push(path); } catch (e) { /* already gone */ }
    }

    // 4) Remove any invites that were created by email but never claimed.
    if (email) {
      const pend = await db.collection("pendingEnrollments").where("email", "==", email).get();
      for (const d of pend.docs) { await d.ref.delete(); removed.push("pendingEnrollments/" + d.id); }
    }

    // 5) Finally, delete the Firebase Auth account itself.
    await admin.auth().deleteUser(uid);
    removed.push("auth account");

    logger.info(`deleteMyAccount: erased ${uid}`, { removed });
    return { ok: true, uid, removed };
  }
);
