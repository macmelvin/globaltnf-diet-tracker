/**
 * ProteinTracker — Cloud Functions entry point (all functions).
 *
 * If you already have a functions/index.js, copy the three module files
 * (accessGate.js, gymAdmin.js, billing.js) into your functions/ folder and add
 * the require/exports lines below to your existing index.js.
 */

// --- Access gate (Phase 2): keeps memberAccess/{uid}.active in sync ---
const gate = require("./accessGate");
exports.onEnrollmentWrite  = gate.onEnrollmentWrite;
exports.onUserWrite        = gate.onUserWrite;
exports.recomputeAllAccess = gate.recomputeAllAccess;   // admin backfill (callable)
exports.onGymWrite         = gate.onGymWrite;            // gym pause/resume -> recompute members
exports.onSelfPayWrite     = gate.onSelfPayWrite;        // self-pay change -> recompute member

// --- Gym logins (Phase 2): admin creates a gym-owner account ---
const gymAdmin = require("./gymAdmin");
exports.createGymOwner = gymAdmin.createGymOwner;         // admin callable
exports.deleteGym      = gymAdmin.deleteGym;             // admin callable (delete one gym)
exports.unbindGymOwner = gymAdmin.unbindGymOwner;        // admin callable (un-bind a gym login)
exports.clearGymTag    = gymAdmin.clearGymTag;           // admin callable (strip gym tag by email)
exports.engagementReport = gymAdmin.engagementReport;    // admin callable (app-usage this month)
exports.memberDailyActivity = gymAdmin.memberDailyActivity; // admin callable (one member's foods-logged-per-day)
exports.myGymEngagement = gymAdmin.myGymEngagement;      // gym-owner callable (my gym usage)

// --- Billing (Phase 1): Stripe invoicing. Needs STRIPE secrets set first. ---
// Safe to deploy now; the scheduled job simply finds nothing to bill until you
// set the STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET secrets and have snapshots.
const billing = require("./billing");
exports.invoiceGymsMonthly = billing.invoiceGymsMonthly; // scheduled monthly
exports.invoiceGymNow      = billing.invoiceGymNow;       // admin callable (testing)
exports.stripeWebhook      = billing.stripeWebhook;       // Stripe -> paid/failed

// --- Member enrollment: gym enrolls its own members by email ---
const selfPay = require("./selfPay");
exports.grantSelfPay  = selfPay.grantSelfPay;   // admin: grant direct self-pay access
exports.revokeSelfPay = selfPay.revokeSelfPay;  // admin: revoke self-pay access
exports.deleteSelfPay = selfPay.deleteSelfPay;  // admin: permanently remove a self-pay record
exports.startTrial    = selfPay.startTrial;     // member: grant one-time 14-day free trial
exports.listSelfPay   = selfPay.listSelfPay;    // admin: list self-pay members
exports.expireSelfPay = selfPay.expireSelfPay;  // nightly: expire lapsed self-pay

const memberEnroll = require("./memberEnroll");
exports.enrollMember = memberEnroll.enrollMember;                        // gym/admin callable
exports.resendWelcomeEmail = memberEnroll.resendWelcomeEmail;           // gym/admin callable (re-send download email)
exports.claimPendingEnrollments = memberEnroll.claimPendingEnrollments; // auth onCreate trigger

// --- Account & data deletion (PDPA / Play / App Store): member erases self ---
const deleteAccount = require("./deleteAccount");
exports.deleteMyAccount = deleteAccount.deleteMyAccount;  // member callable (self-delete + data wipe)

// --- Testing helper: wipe gyms/logins/enrollments back to a clean slate ---
const resetTools = require("./resetTestData");
exports.resetTestData = resetTools.resetTestData;         // admin callable (confirm:"RESET")
exports.createSelfPayCheckout = billing.createSelfPayCheckout;
exports.getSelfPayOptions     = billing.getSelfPayOptions;   // member: currencies + prices to choose from
exports.setSelfPayPrices      = billing.setSelfPayPrices;    // admin: edit the self-pay price list
