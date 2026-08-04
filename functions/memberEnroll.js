/**
 * Member enrollment: a gym owner (or admin) enrolls a member into their gym by
 * email. If the member already has an account, they're enrolled immediately. If
 * they haven't opened the app yet, the enrollment is held as "pending" and
 * attached automatically the moment they sign in with that email.
 *
 * On a brand-new enrollment we also queue a welcome + app-download email (via
 * the Firebase "Trigger Email from Firestore" extension watching `mail`).
 */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const functionsV1 = require("firebase-functions/v1");
const admin = require("firebase-admin");

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const REGION = "asia-southeast1";
const ADMIN_UIDS = ["U51HtMKGzMPObg48Ry2h4KzudBX2"];

// Public links (hosted on Firebase Hosting).
const TRACKER_URL = "https://protein-tracker-for-50s.web.app/protein-tracker";
const GUIDE_URL = "https://protein-tracker-for-50s.web.app/install";
const INSTALL_VIDEO_URL = "https://protein-tracker-for-50s.web.app/install-ios.mp4";
const INSTALL_POSTER_URL = "https://protein-tracker-for-50s.web.app/install-ios-poster.jpg";
const SUPPORT_EMAIL = "proteintracker50@gmail.com";

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Queue a welcome + app-download email to a newly enrolled member. Writes a doc
// to the `mail` collection, which the Firebase "Trigger Email from Firestore"
// extension picks up and sends. No SMTP credentials live in this code.
async function queueWelcomeEmail(email, gymName, memberName) {
  const subject = "Welcome to ProteinTracker - your gym has enrolled you";
  const greeting = memberName ? "Hi " + memberName + "," : "Hi,";
  const safeGreeting = escapeHtml(greeting);
  const safeGymName = escapeHtml(gymName);
  const safeEmail = escapeHtml(email);

  const text =
    greeting + "\n\n" +
    "Welcome to ProteinTracker!\n\n" +
    gymName + " has enrolled you in ProteinTracker to help you track your daily protein intake and support your training goals.\n\n" +
    "ProteinTracker works right in your phone's web browser - iPhone or Android. There's nothing to download from an app store.\n\n" +
    "OPEN PROTEINTRACKER:\n" +
    TRACKER_URL + "\n\n" +
    "ADD IT TO YOUR HOME SCREEN (recommended)\n\n" +
    "Adding it to your Home Screen makes ProteinTracker open like a normal app (full screen), and it's the best way to use the take-a-photo feature.\n\n" +
    "Watch the short setup video: " + INSTALL_VIDEO_URL + "\n\n" +
    "Steps:\n\n" +
    "1) Open the link above in Safari (on iPhone/iPad) or Chrome (on Android).\n\n" +
    "2) Tap the Share icon (iPhone) or the menu button with three dots (Android).\n\n" +
    "3) Choose \"Add to Home Screen\".\n\n" +
    "4) Tap the new ProteinTracker icon to open it.\n\n" +
    "5) Sign in using this email address: " + email + "\n\n" +
    "Tip: if you opened this email inside WhatsApp, Instagram or Facebook, first tap \"Open in browser\" (or \"Open in Chrome\") - those built-in browsers block Google sign-in.\n\n" +
    "Full setup guide (with pictures): " + GUIDE_URL + "\n\n" +
    "Once signed in, here's how to use ProteinTracker:\n\n" +
    "HOW TO USE PROTEINTRACKER\n\n" +
    "1) Set your goal. The first time you open the app, enter a few details (name, birth year, weight) and it works out your Daily Protein Goal. Keep it, or tap \"Set my own goal\".\n\n" +
    "2) Snap your food. On the home screen, take or upload a photo of your meal. The app looks at the photo and estimates the protein.\n\n" +
    "3) Check and save. It shows the food and an estimated protein amount. If it looks off, tap \"Improve result\" for a closer estimate, or adjust it yourself. Sharing a plate? Tell it how many people and it works out your portion. Then tap \"Save entry\".\n\n" +
    "4) Watch your day add up. The home screen shows your running total against your goal (for example, 48 g of 90 g) until you reach \"Goal reached for today\".\n\n" +
    "5) Make it faster. Save foods you eat often as favourites, or build a meal like \"Usual breakfast\" so you can log it in one tap next time.\n\n" +
    "Tip: try to log your meals across the day, most days - that's how you'll see your real protein habits and trends.\n\n" +
    "Need help? Contact us at " + SUPPORT_EMAIL + ".\n\n" +
    "Welcome aboard!\n\n" +
    "The ProteinTracker Team";

  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;max-width:620px;margin:0 auto;color:#17202a">' +
      '<h2 style="font-family:Arial,Helvetica,sans-serif;font-size:26px;line-height:1.25;color:#2a78d6;margin:0 0 20px">Welcome to ProteinTracker</h2>' +
      '<p style="margin:16px 0 14px">' + safeGreeting + '</p>' +
      '<p style="margin:0 0 14px"><b>Welcome to ProteinTracker!</b></p>' +
      '<p style="margin:0 0 14px"><b>' + safeGymName + '</b> has enrolled you in ProteinTracker to help you track your daily protein intake and support your training goals.</p>' +
      '<p style="margin:0 0 18px">ProteinTracker works right in your phone&rsquo;s <b>web browser</b> &mdash; <b>iPhone or Android</b>. There&rsquo;s nothing to download from an app store.</p>' +
      '<p style="margin:0 0 26px"><a href="' + TRACKER_URL + '" style="font-family:Arial,Helvetica,sans-serif;font-size:17px;background:#12b981;color:#fff;text-decoration:none;padding:15px 28px;border-radius:10px;font-weight:700;display:inline-block">Open ProteinTracker &rarr;</a></p>' +
      '<h3 style="font-family:Arial,Helvetica,sans-serif;margin:26px 0 8px;font-size:20px;line-height:1.3">&#128241; Add it to your Home Screen <span style="font-size:13px;font-weight:700;color:#0ca35a">&mdash; recommended</span></h3>' +
      '<p style="margin:0 0 16px">This makes ProteinTracker open like a normal app (full screen) and works best with the take-a-photo feature. The short video shows exactly how &mdash; tap it to play:</p>' +
      '<p style="margin:0 0 8px"><a href="' + INSTALL_VIDEO_URL + '" style="display:inline-block;text-decoration:none"><img src="cid:proteintracker-install-video" alt="Watch the ProteinTracker setup video" style="display:block;width:100%;max-width:230px;height:auto;border-radius:16px;border:1px solid #d8dee8"></a></p>' +
      '<p style="margin:0 0 20px"><a href="' + INSTALL_VIDEO_URL + '" style="color:#0a8f63;font-weight:700;text-decoration:none">&#9654; Watch the setup video</a></p>' +
      '<h3 style="font-family:Arial,Helvetica,sans-serif;margin:24px 0 12px;font-size:20px;line-height:1.3">Steps:</h3>' +
      '<ol style="font-size:16px;line-height:1.6;color:#39434f;padding-left:24px;margin:0 0 20px">' +
        '<li style="margin-bottom:12px">Open the link above in <b>Safari</b> (iPhone/iPad) or <b>Chrome</b> (Android).</li>' +
        '<li style="margin-bottom:12px">Tap the <b>Share</b> icon (iPhone) or the <b>menu</b> button &mdash; the three dots (Android).</li>' +
        '<li style="margin-bottom:12px">Choose <b>&ldquo;Add to Home Screen&rdquo;</b>.</li>' +
        '<li style="margin-bottom:12px">Tap the new <b>ProteinTracker</b> icon to open it.</li>' +
        '<li style="margin-bottom:12px">Sign in using this email address: <b>' + safeEmail + '</b></li>' +
      '</ol>' +
      '<p style="background:#fdf3e2;border:1px solid #f0d9a8;border-radius:10px;padding:13px 16px;color:#7a531a;margin:0 0 20px;line-height:1.6">&#9888;&#65039; <b>Opening this from WhatsApp, Instagram or Facebook?</b> First tap &ldquo;Open in browser&rdquo; (or &ldquo;Open in Chrome&rdquo;) &mdash; those built-in browsers block Google sign-in.</p>' +
      '<p style="margin:18px 0 22px"><a href="' + GUIDE_URL + '" style="display:inline-block;background:#eef7f2;border:1px solid #bfe6d4;color:#0a8f63;text-decoration:none;padding:11px 18px;border-radius:8px;font-weight:600">&#128241; See the full setup guide &rarr;</a></p>' +
      '<p style="margin:18px 0 8px">Once signed in, here&rsquo;s how to use ProteinTracker:</p>' +
      '<h3 style="font-family:Arial,Helvetica,sans-serif;margin:26px 0 12px;font-size:20px;line-height:1.3">How to use ProteinTracker</h3>' +
      '<ol style="font-size:16px;line-height:1.6;color:#39434f;padding-left:24px;margin:0 0 20px">' +
        '<li style="margin-bottom:12px"><b>Set your goal.</b> The first time you open the app, enter a few details (name, birth year, weight) and it works out your Daily Protein Goal. Keep it, or tap &ldquo;Set my own goal&rdquo;.</li>' +
        '<li style="margin-bottom:12px"><b>Snap your food.</b> On the home screen, take or upload a photo of your meal &mdash; the app estimates the protein for you.</li>' +
        '<li style="margin-bottom:12px"><b>Check &amp; save.</b> Review the food and protein amount. If it looks off, tap &ldquo;Improve result&rdquo; or adjust it yourself. Sharing a plate? Tell it how many people and it works out your portion. Then tap &ldquo;Save entry&rdquo;.</li>' +
        '<li style="margin-bottom:12px"><b>Watch your day add up.</b> The home screen shows your running total against your goal (e.g. 48 g of 90 g) until you hit &ldquo;Goal reached for today&rdquo;.</li>' +
        '<li style="margin-bottom:12px"><b>Make it faster.</b> Save foods you eat often as favourites, or build a meal like &ldquo;Usual breakfast&rdquo; to log it in one tap next time.</li>' +
      '</ol>' +
      '<p style="background:#f0f7ee;border:1px solid #cfe6c4;border-radius:10px;padding:12px 16px;color:#3c6b2e;margin:0 0 20px">&#128161; <b>Tip:</b> try to log your meals across the day, most days &mdash; that&rsquo;s how you&rsquo;ll see your real protein habits and trends.</p>' +
      '<p style="color:#5b6672;font-size:16px;line-height:1.6">Need help? Contact us at <a href="mailto:' + SUPPORT_EMAIL + '">' + SUPPORT_EMAIL + '</a>.</p>' +
      '<p style="margin:18px 0 4px">Welcome aboard!</p>' +
      '<p style="color:#5b6672;font-size:16px">The ProteinTracker Team</p>' +
    '</div>';

  const attachments = [
    {
      filename: "proteintracker-install-video.jpg",
      path: INSTALL_POSTER_URL,
      cid: "proteintracker-install-video",
      contentDisposition: "inline",
    },
  ];

  await db.collection("mail").add({
    to: [email],
    message: { subject, text, html, attachments },
  });
}

// Queue a welcome email to a member who signed themselves up on the website and
// was just granted a 30-day free trial (no gym involved). Same install video +
// Add-to-Home-Screen guidance as the gym welcome email, but trial-framed copy.
// Called by selfPay.startTrial the first time a trial is granted.
async function queueTrialWelcomeEmail(email, memberName) {
  if (!email) return;
  const subject = "Welcome to ProteinTracker - your 30-day free trial has started";
  const greeting = memberName ? "Hi " + memberName + "," : "Hi,";
  const safeGreeting = escapeHtml(greeting);
  const safeEmail = escapeHtml(email);

  const text =
    greeting + "\n\n" +
    "Welcome to ProteinTracker! Your 30-day free trial has started - you have full access to track your protein, meals, weight, water and more. No card needed.\n\n" +
    "ProteinTracker works right in your phone's web browser - iPhone or Android. There's nothing to download from an app store.\n\n" +
    "OPEN PROTEINTRACKER:\n" +
    TRACKER_URL + "\n\n" +
    "ADD IT TO YOUR HOME SCREEN (recommended)\n\n" +
    "Adding it to your Home Screen makes ProteinTracker open like a normal app (full screen), and it's the best way to use the take-a-photo feature.\n\n" +
    "Watch the short setup video: " + INSTALL_VIDEO_URL + "\n\n" +
    "Steps:\n\n" +
    "1) Open the link above in Safari (on iPhone/iPad) or Chrome (on Android).\n\n" +
    "2) Tap the Share icon (iPhone) or the menu button with three dots (Android).\n\n" +
    "3) Choose \"Add to Home Screen\".\n\n" +
    "4) Tap the new ProteinTracker icon to open it.\n\n" +
    "5) Sign in using this email address: " + email + "\n\n" +
    "Tip: if you opened this email inside WhatsApp, Instagram or Facebook, first tap \"Open in browser\" (or \"Open in Chrome\") - those built-in browsers block Google sign-in.\n\n" +
    "Full setup guide (with pictures): " + GUIDE_URL + "\n\n" +
    "Once signed in, here's how to use ProteinTracker:\n\n" +
    "HOW TO USE PROTEINTRACKER\n\n" +
    "1) Set your goal. The first time you open the app, enter a few details (name, birth year, weight) and it works out your Daily Protein Goal. Keep it, or tap \"Set my own goal\".\n\n" +
    "2) Snap your food. On the home screen, take or upload a photo of your meal. The app looks at the photo and estimates the protein.\n\n" +
    "3) Check and save. It shows the food and an estimated protein amount. If it looks off, tap \"Improve result\" for a closer estimate, or adjust it yourself. Then tap \"Save entry\".\n\n" +
    "4) Watch your day add up. The home screen shows your running total against your goal until you reach \"Goal reached for today\".\n\n" +
    "5) Make it faster. Save foods you eat often as favourites, or build a meal like \"Usual breakfast\" so you can log it in one tap next time.\n\n" +
    "Your trial runs for 30 days. Near the end we'll let you know how to keep going.\n\n" +
    "Need help? Contact us at " + SUPPORT_EMAIL + ".\n\n" +
    "Welcome aboard!\n\n" +
    "The ProteinTracker Team";

  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;max-width:620px;margin:0 auto;color:#17202a">' +
      '<h2 style="font-family:Arial,Helvetica,sans-serif;font-size:26px;line-height:1.25;color:#0a8f63;margin:0 0 20px">Welcome to ProteinTracker</h2>' +
      '<p style="margin:16px 0 14px">' + safeGreeting + '</p>' +
      '<p style="margin:0 0 14px"><b>Welcome to ProteinTracker!</b></p>' +
      '<p style="background:#e9f8f1;border:1px solid #bfe6d4;border-radius:10px;padding:13px 16px;color:#0a6f52;margin:0 0 16px;line-height:1.6">&#127881; <b>Your 30-day free trial has started</b> &mdash; full access to track your protein, meals, weight, water and more. No card needed.</p>' +
      '<p style="margin:0 0 18px">ProteinTracker works right in your phone&rsquo;s <b>web browser</b> &mdash; <b>iPhone or Android</b>. There&rsquo;s nothing to download from an app store.</p>' +
      '<p style="margin:0 0 26px"><a href="' + TRACKER_URL + '" style="font-family:Arial,Helvetica,sans-serif;font-size:17px;background:#12b981;color:#fff;text-decoration:none;padding:15px 28px;border-radius:10px;font-weight:700;display:inline-block">Open ProteinTracker &rarr;</a></p>' +
      '<h3 style="font-family:Arial,Helvetica,sans-serif;margin:26px 0 8px;font-size:20px;line-height:1.3">&#128241; Add it to your Home Screen <span style="font-size:13px;font-weight:700;color:#0ca35a">&mdash; recommended</span></h3>' +
      '<p style="margin:0 0 16px">This makes ProteinTracker open like a normal app (full screen) and works best with the take-a-photo feature. The short video shows exactly how &mdash; tap it to play:</p>' +
      '<p style="margin:0 0 8px"><a href="' + INSTALL_VIDEO_URL + '" style="display:inline-block;text-decoration:none"><img src="cid:proteintracker-install-video" alt="Watch the ProteinTracker setup video" style="display:block;width:100%;max-width:230px;height:auto;border-radius:16px;border:1px solid #d8dee8"></a></p>' +
      '<p style="margin:0 0 20px"><a href="' + INSTALL_VIDEO_URL + '" style="color:#0a8f63;font-weight:700;text-decoration:none">&#9654; Watch the setup video</a></p>' +
      '<h3 style="font-family:Arial,Helvetica,sans-serif;margin:24px 0 12px;font-size:20px;line-height:1.3">Steps:</h3>' +
      '<ol style="font-size:16px;line-height:1.6;color:#39434f;padding-left:24px;margin:0 0 20px">' +
        '<li style="margin-bottom:12px">Open the link above in <b>Safari</b> (iPhone/iPad) or <b>Chrome</b> (Android).</li>' +
        '<li style="margin-bottom:12px">Tap the <b>Share</b> icon (iPhone) or the <b>menu</b> button &mdash; the three dots (Android).</li>' +
        '<li style="margin-bottom:12px">Choose <b>&ldquo;Add to Home Screen&rdquo;</b>.</li>' +
        '<li style="margin-bottom:12px">Tap the new <b>ProteinTracker</b> icon to open it.</li>' +
        '<li style="margin-bottom:12px">Sign in using this email address: <b>' + safeEmail + '</b></li>' +
      '</ol>' +
      '<p style="background:#fdf3e2;border:1px solid #f0d9a8;border-radius:10px;padding:13px 16px;color:#7a531a;margin:0 0 20px;line-height:1.6">&#9888;&#65039; <b>Opening this from WhatsApp, Instagram or Facebook?</b> First tap &ldquo;Open in browser&rdquo; (or &ldquo;Open in Chrome&rdquo;) &mdash; those built-in browsers block Google sign-in.</p>' +
      '<p style="margin:18px 0 22px"><a href="' + GUIDE_URL + '" style="display:inline-block;background:#eef7f2;border:1px solid #bfe6d4;color:#0a8f63;text-decoration:none;padding:11px 18px;border-radius:8px;font-weight:600">&#128241; See the full setup guide &rarr;</a></p>' +
      '<p style="margin:18px 0 8px">Once signed in, here&rsquo;s how to use ProteinTracker:</p>' +
      '<h3 style="font-family:Arial,Helvetica,sans-serif;margin:26px 0 12px;font-size:20px;line-height:1.3">How to use ProteinTracker</h3>' +
      '<ol style="font-size:16px;line-height:1.6;color:#39434f;padding-left:24px;margin:0 0 20px">' +
        '<li style="margin-bottom:12px"><b>Set your goal.</b> The first time you open the app, enter a few details and it works out your Daily Protein Goal. Keep it, or set your own.</li>' +
        '<li style="margin-bottom:12px"><b>Snap your food.</b> On the home screen, take or upload a photo of your meal &mdash; the app estimates the protein for you.</li>' +
        '<li style="margin-bottom:12px"><b>Check &amp; save.</b> Review the food and protein amount, adjust if needed, then tap &ldquo;Save entry&rdquo;.</li>' +
        '<li style="margin-bottom:12px"><b>Watch your day add up.</b> The home screen shows your running total against your goal until you hit &ldquo;Goal reached for today&rdquo;.</li>' +
        '<li style="margin-bottom:12px"><b>Make it faster.</b> Save favourites, or build a meal to log it in one tap next time.</li>' +
      '</ol>' +
      '<p style="background:#f0f7ee;border:1px solid #cfe6c4;border-radius:10px;padding:12px 16px;color:#3c6b2e;margin:0 0 20px">&#128197; <b>Your trial runs for 30 days.</b> Near the end we&rsquo;ll let you know how to keep going.</p>' +
      '<p style="color:#5b6672;font-size:16px;line-height:1.6">Need help? Contact us at <a href="mailto:' + SUPPORT_EMAIL + '">' + SUPPORT_EMAIL + '</a>.</p>' +
      '<p style="margin:18px 0 4px">Welcome aboard!</p>' +
      '<p style="color:#5b6672;font-size:16px">The ProteinTracker Team</p>' +
    '</div>';

  const attachments = [
    {
      filename: "proteintracker-install-video.jpg",
      path: INSTALL_POSTER_URL,
      cid: "proteintracker-install-video",
      contentDisposition: "inline",
    },
  ];

  await db.collection("mail").add({
    to: [email],
    message: { subject, text, html, attachments },
  });
}

async function createEnrollment(uid, gymId, gymName, email, memberName, status, addedBy) {
  await db.doc(`users/${uid}/enrollments/${gymId}`).set(
    {
      gymId,
      gymName,
      memberEmail: email,
      memberName: memberName || null,
      status,
      addedBy,
      coachSince: admin.firestore.FieldValue.serverTimestamp(),
      coachEndedAt:
        status === "active" ? null : admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

// Gym owner (claim gymId) or admin (may pass gymId) enrolls a member by email.
exports.enrollMember = onCall({ region: REGION }, async (req) => {
  const email = ((req.data && req.data.email) || "").trim().toLowerCase();
  const memberName = ((req.data && req.data.memberName) || "").trim().replace(/\s+/g, " ").slice(0, 80);
  const status = (req.data && req.data.status) === "inactive" ? "inactive" : "active";
  if (!email) throw new HttpsError("invalid-argument", "Member email is required.");

  const isAdmin = req.auth && ADMIN_UIDS.includes(req.auth.uid);
  const claimGym = (req.auth && req.auth.token && req.auth.token.gymId) || null;
  const gymId = isAdmin ? ((req.data && req.data.gymId) || claimGym) : claimGym;

  if (!req.auth || (!isAdmin && !claimGym)) {
    throw new HttpsError("permission-denied", "Only a gym owner or admin can enroll members.");
  }
  if (!gymId) throw new HttpsError("invalid-argument", "No gym to enroll into.");

  const gymSnap = await db.doc(`gyms/${gymId}`).get();
  if (!gymSnap.exists) throw new HttpsError("not-found", 'Gym "' + gymId + '" not found.');
  const gymName = gymSnap.data().name || gymId;

  let uid = null;
  try {
    uid = (await admin.auth().getUserByEmail(email)).uid;
  } catch (e) {
    uid = null;
  }

  if (uid) {
    const enrRef = db.doc(`users/${uid}/enrollments/${gymId}`);
    const wasNew = !(await enrRef.get()).exists;
    await createEnrollment(uid, gymId, gymName, email, memberName, status, req.auth.uid);
    if (wasNew && status === "active") await queueWelcomeEmail(email, gymName, memberName);
    return { result: "enrolled", gymId: gymId, email: email, memberName: memberName, status: status };
  }

  // De-dupe: a gym re-toggling a not-yet-signed-up member shouldn't create a
  // second pending or re-send the welcome email. Query by email only (single
  // field - no composite index needed) and match the gym in code.
  const existingPending = await db
    .collection("pendingEnrollments")
    .where("email", "==", email)
    .get();
  const dup = existingPending.docs.find((d) => d.data().gymId === gymId);
  if (dup) {
    await dup.ref.set({ status, memberName: memberName || null, addedBy: req.auth.uid }, { merge: true });
  } else {
    await db.collection("pendingEnrollments").add({
      email,
      gymId,
      gymName,
      memberName: memberName || null,
      status,
      addedBy: req.auth.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    if (status === "active") await queueWelcomeEmail(email, gymName, memberName);
  }
  return { result: "pending", gymId: gymId, email: email, memberName: memberName, status: status };
});

// Re-send the welcome + app-download email to a member who is already enrolled
// (or pending) in this gym. Used when the original email was missed, or when a
// re-enroll didn't re-trigger it. Same auth as enrollMember: a gym owner (by
// claim) or an admin (may pass gymId). Guarded so it can only email addresses
// that are actually on this gym's roster — not arbitrary recipients.
exports.resendWelcomeEmail = onCall({ region: REGION }, async (req) => {
  const email = ((req.data && req.data.email) || "").trim().toLowerCase();
  if (!email) throw new HttpsError("invalid-argument", "Member email is required.");

  const isAdmin = req.auth && ADMIN_UIDS.includes(req.auth.uid);
  const claimGym = (req.auth && req.auth.token && req.auth.token.gymId) || null;
  const gymId = isAdmin ? ((req.data && req.data.gymId) || claimGym) : claimGym;

  if (!req.auth || (!isAdmin && !claimGym)) {
    throw new HttpsError("permission-denied", "Only a gym owner or admin can resend the welcome email.");
  }
  if (!gymId) throw new HttpsError("invalid-argument", "No gym context.");

  const gymSnap = await db.doc(`gyms/${gymId}`).get();
  if (!gymSnap.exists) throw new HttpsError("not-found", 'Gym "' + gymId + '" not found.');
  const gymName = gymSnap.data().name || gymId;

  // Confirm this email is actually on this gym's roster (enrolled or pending).
  let memberName = "";
  let found = false;
  try {
    const uid = (await admin.auth().getUserByEmail(email)).uid;
    const enr = await db.doc(`users/${uid}/enrollments/${gymId}`).get();
    if (enr.exists) { found = true; memberName = enr.data().memberName || ""; }
  } catch (e) { /* no app account yet — fall through to pending check */ }

  if (!found) {
    const pend = await db.collection("pendingEnrollments").where("email", "==", email).get();
    const dup = pend.docs.find((d) => d.data().gymId === gymId);
    if (dup) { found = true; memberName = dup.data().memberName || ""; }
  }

  if (!found) throw new HttpsError("not-found", email + " isn't enrolled in this gym.");

  await queueWelcomeEmail(email, gymName, memberName);
  return { ok: true, email };
});

// New member's first sign-in: attach any enrollments a gym pre-created by email.
exports.claimPendingEnrollments = functionsV1
  .region(REGION)
  .auth.user()
  .onCreate(async (user) => {
    const email = (user.email || "").toLowerCase();
    if (!email) return;
    const pending = await db
      .collection("pendingEnrollments")
      .where("email", "==", email)
      .get();
    for (const doc of pending.docs) {
      const d = doc.data();
      await createEnrollment(user.uid, d.gymId, d.gymName, email, d.memberName || "", d.status, d.addedBy || "pending");
      await doc.ref.delete();
    }
  });

// Internal helper (not a Cloud Function): used by selfPay.startTrial to email a
// self-signup member their setup guide when their free trial is first granted.
exports.queueTrialWelcomeEmail = queueTrialWelcomeEmail;
