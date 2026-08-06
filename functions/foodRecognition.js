/**
 * AI food recognition for Diet Tracker -- photo scan (recognizeFood) and typed
 * text lookup (searchFoodByName), ported from ProteinTrackerFor50s's functions.
 * Access is gated on Diet Tracker's own memberAccess/{uid}.active flag (see
 * accessGate.js) instead of ProteinTracker's gym/subscription/trial model,
 * since Diet Tracker doesn't have an individual-subscription or trial concept.
 *
 * Re-export from index.js:
 *   const foodRecognition = require("./foodRecognition");
 *   exports.recognizeFood = foodRecognition.recognizeFood;
 *   exports.searchFoodByName = foodRecognition.searchFoodByName;
 */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const OpenAI = require("openai");
const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const openaiApiKey = defineSecret("OPENAI_API_KEY");

const FREE_MONTHLY_RECOGNITION_LIMIT = 100;
const DAILY_SPEND_LIMIT_USD = 5;

// Developer/owner accounts: exempt from the per-user monthly free-scan limit
// so they can test freely. The global daily spend cap still applies to everyone.
const DEV_EMAILS = ["macmelvin.tan@gmail.com"];
function isDevRequest(request) {
  const e = request.auth && request.auth.token && request.auth.token.email;
  return !!(e && DEV_EMAILS.includes(e.toLowerCase()));
}

function requireAuth(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be signed in to use this feature.");
  }
  return request.auth.uid;
}

// Diet Tracker gates access via a precomputed memberAccess/{uid}.active flag
// (kept in sync by accessGate.js from gym enrollment / self-pay status) --
// unlike ProteinTracker, there's no individual trial/subscription path here.
async function assertHasAccess(uid) {
  const accessSnap = await db.doc(`memberAccess/${uid}`).get();
  const active = accessSnap.exists && accessSnap.data().active === true;
  if (!active) {
    throw new HttpsError(
      "permission-denied",
      "Your account doesn't currently have access to AI features. Check with your gym if you believe this is a mistake."
    );
  }
}

function currentMonthKey() {
  return new Date().toISOString().slice(0, 7);
}
async function checkAndIncrementUsage(uid, counterField, monthlyLimit) {
  const usageRef = db
    .collection("users")
    .doc(uid)
    .collection("usage")
    .doc(currentMonthKey());
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(usageRef);
    const currentCount = snapshot.exists ? snapshot.data()[counterField] || 0 : 0;
    if (currentCount >= monthlyLimit) {
      throw new HttpsError(
        "resource-exhausted",
        "You've reached this month's free limit for this feature. It resets next month."
      );
    }
    transaction.set(usageRef, { [counterField]: currentCount + 1 }, { merge: true });
  });
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}
async function assertUnderDailySpendCap() {
  const spendRef = db.collection("systemUsage").doc(todayKey());
  const snapshot = await spendRef.get();
  const spentSoFar = snapshot.exists ? snapshot.data().totalCostUsd || 0 : 0;
  if (spentSoFar >= DAILY_SPEND_LIMIT_USD) {
    console.error(`Daily OpenAI spend cap reached: $${spentSoFar.toFixed(4)} spent today`);
    throw new HttpsError(
      "resource-exhausted",
      "AI features are temporarily paused due to high demand today. Please try again tomorrow."
    );
  }
}
// NOTE: mirrors ProteinTracker's cost-rate table, which is keyed on "gpt-4o" /
// "gpt-4o-mini" -- but the models actually called below are named "gpt-5.6-*".
// That means spend gets recorded at the mini rate regardless of which model ran
// (same quirk exists on ProteinTracker's side; flagging it, not fixing it here).
const GPT_4O_MINI_INPUT_COST_PER_TOKEN = 0.15 / 1_000_000;
const GPT_4O_MINI_OUTPUT_COST_PER_TOKEN = 0.6 / 1_000_000;
const GPT_4O_INPUT_COST_PER_TOKEN = 2.5 / 1_000_000;
const GPT_4O_OUTPUT_COST_PER_TOKEN = 10 / 1_000_000;
async function recordOpenAiSpend(usage, model = "gpt-4o-mini") {
  if (!usage) return;
  const inputTokens = usage.prompt_tokens || 0;
  const outputTokens = usage.completion_tokens || 0;
  const isFull4o = model === "gpt-4o";
  const inputRate = isFull4o ? GPT_4O_INPUT_COST_PER_TOKEN : GPT_4O_MINI_INPUT_COST_PER_TOKEN;
  const outputRate = isFull4o ? GPT_4O_OUTPUT_COST_PER_TOKEN : GPT_4O_MINI_OUTPUT_COST_PER_TOKEN;
  const costUsd = inputTokens * inputRate + outputTokens * outputRate;
  const spendRef = db.collection("systemUsage").doc(todayKey());
  await spendRef.set(
    {
      totalCostUsd: admin.firestore.FieldValue.increment(costUsd),
      totalCalls: admin.firestore.FieldValue.increment(1),
    },
    { merge: true }
  );
}

function parseJsonResponse(raw) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new HttpsError("internal", "Failed to parse AI response as JSON");
  }
}

const RECOGNIZE_SYSTEM_PROMPT =
  "You are a careful nutrition assistant familiar with Singapore hawker, home-cooked, and local food. " +
  "Identify every visible meal component, including rice and side dishes. Prefer the most specific dish " +
  "name supported by visible ingredients instead of defaulting to a broad category. Do not assume every " +
  "clear pork-rib soup is bak kut teh; if lotus-root slices are visible, consider lotus-root pork-rib soup. " +
  "Recognise common local dishes by their usual names where applicable " +
  "(e.g. chicken rice, char kway teow, mee rebus, laksa, nasi lemak, bak chor mee, yong tau foo, " +
  "fish soup, roti prata, char siew rice, economical/mixed rice), then estimate its protein content " +
  "for a typical Singapore hawker portion. Respond ONLY with JSON in this exact shape: " +
  '{"foodName": string, "estimatedProteinGrams": number, "estimatedCalories": number, "estimatedCarbsGrams": number, "estimatedFatGrams": number, "estimatedSugarGrams": number, "confidence": "low"|"medium"|"high", "notes": string}. ' +
  "estimatedCalories (kcal), estimatedCarbsGrams, estimatedFatGrams and estimatedSugarGrams are best estimates for the whole visible portion; use whole numbers and never leave them blank. " +
  "For foodName, combine visible components concisely, for example 'Lotus-root pork-rib soup with rice'. " +
  "If identification is uncertain, choose the best-supported name, lower confidence, and mention one likely " +
  "alternative in notes. notes should be one brief sentence about uncertainty or portion-size assumptions.";

exports.recognizeFood = onCall({ secrets: [openaiApiKey] }, async (request) => {
  const uid = requireAuth(request);
  await assertHasAccess(uid);
  const imageBase64 = request.data?.imageBase64;
  const highDetail = request.data?.highDetail === true;
  if (typeof imageBase64 !== "string" || imageBase64.length === 0) {
    throw new HttpsError("invalid-argument", "imageBase64 (string) is required");
  }
  if (!isDevRequest(request)) {
    await checkAndIncrementUsage(uid, "recognitions", FREE_MONTHLY_RECOGNITION_LIMIT);
  }
  await assertUnderDailySpendCap();
  const client = new OpenAI({ apiKey: openaiApiKey.value() });
  const recognizeModel = highDetail ? "gpt-5.6-sol" : "gpt-5.6-sol";
  let response;
  try {
    response = await client.chat.completions.create({
      model: recognizeModel,
      messages: [
        { role: "system", content: RECOGNIZE_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: "Estimate the protein in this food photo." },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${imageBase64}`,
                detail: "high",
              },
            },
          ],
        },
      ],
      response_format: { type: "json_object" },
      max_completion_tokens: 800,
    });
  } catch (err) {
    console.error("recognizeFood: OpenAI call failed", err);
    throw new HttpsError("unavailable", "AI food recognition is temporarily unavailable");
  }
  try {
    await recordOpenAiSpend(response.usage, recognizeModel);
  } catch (err) {
    console.error("recognizeFood: failed to record spend", err);
  }
  const parsed = parseJsonResponse(response.choices[0]?.message?.content);
  return {
    foodName: typeof parsed.foodName === "string" ? parsed.foodName : "Unknown food",
    estimatedProteinGrams: Math.max(0, Math.round(Number(parsed.estimatedProteinGrams) || 0)),
    estimatedCalories: Math.max(0, Math.round(Number(parsed.estimatedCalories) || 0)),
    estimatedCarbsGrams: Math.max(0, Math.round(Number(parsed.estimatedCarbsGrams) || 0)),
    estimatedFatGrams: Math.max(0, Math.round(Number(parsed.estimatedFatGrams) || 0)),
    estimatedSugarGrams: Math.max(0, Math.round(Number(parsed.estimatedSugarGrams) || 0)),
    confidence: ["low", "medium", "high"].includes(parsed.confidence) ? parsed.confidence : "low",
    notes: typeof parsed.notes === "string" ? parsed.notes : "",
  };
});

const SEARCH_SYSTEM_PROMPT =
  "You are a careful nutrition assistant familiar with Singapore hawker, home-cooked, and local food. " +
  "The user has typed a short food description by hand -- often to correct a food a photo scan misread, " +
  "or to log something without taking a photo. Identify the most likely dish from the text alone, using " +
  "the most specific name supported by the description instead of defaulting to a broad category. " +
  "Recognise common local dishes by their usual names where applicable " +
  "(e.g. chicken rice, char kway teow, mee rebus, laksa, nasi lemak, bak chor mee, yong tau foo, " +
  "fish soup, roti prata, char siew rice, economical/mixed rice), then estimate its protein content " +
  "for a typical Singapore hawker portion (or one typical serving, if not a local dish). Respond ONLY " +
  "with JSON in this exact shape: " +
  '{"foodName": string, "estimatedProteinGrams": number, "estimatedCalories": number, "estimatedCarbsGrams": number, "estimatedFatGrams": number, "estimatedSugarGrams": number, "confidence": "low"|"medium"|"high", "notes": string}. ' +
  "estimatedCalories (kcal), estimatedCarbsGrams, estimatedFatGrams and estimatedSugarGrams are best estimates " +
  "for one typical portion; use whole numbers and never leave them blank. For foodName, return a clean, " +
  "concise version of what the user described. If the description is vague (e.g. just \"chicken\"), pick the " +
  "most common preparation, lower confidence, and mention the assumption in notes.";

exports.searchFoodByName = onCall({ secrets: [openaiApiKey] }, async (request) => {
  const uid = requireAuth(request);
  await assertHasAccess(uid);
  const foodDescription = request.data?.foodDescription;
  if (typeof foodDescription !== "string" || foodDescription.trim().length === 0) {
    throw new HttpsError("invalid-argument", "foodDescription (string) is required");
  }
  if (!isDevRequest(request)) {
    await checkAndIncrementUsage(uid, "recognitions", FREE_MONTHLY_RECOGNITION_LIMIT);
  }
  await assertUnderDailySpendCap();
  const client = new OpenAI({ apiKey: openaiApiKey.value() });
  const searchModel = "gpt-5.6-luna";
  let response;
  try {
    response = await client.chat.completions.create({
      model: searchModel,
      messages: [
        { role: "system", content: SEARCH_SYSTEM_PROMPT },
        { role: "user", content: `Food: ${foodDescription.trim()}` },
      ],
      response_format: { type: "json_object" },
      max_completion_tokens: 400,
    });
  } catch (err) {
    console.error("searchFoodByName: OpenAI call failed", err);
    throw new HttpsError("unavailable", "AI food search is temporarily unavailable");
  }
  try {
    await recordOpenAiSpend(response.usage, searchModel);
  } catch (err) {
    console.error("searchFoodByName: failed to record spend", err);
  }
  const parsed = parseJsonResponse(response.choices[0]?.message?.content);
  return {
    foodName: typeof parsed.foodName === "string" ? parsed.foodName : "Unknown food",
    estimatedProteinGrams: Math.max(0, Math.round(Number(parsed.estimatedProteinGrams) || 0)),
    estimatedCalories: Math.max(0, Math.round(Number(parsed.estimatedCalories) || 0)),
    estimatedCarbsGrams: Math.max(0, Math.round(Number(parsed.estimatedCarbsGrams) || 0)),
    estimatedFatGrams: Math.max(0, Math.round(Number(parsed.estimatedFatGrams) || 0)),
    estimatedSugarGrams: Math.max(0, Math.round(Number(parsed.estimatedSugarGrams) || 0)),
    confidence: ["low", "medium", "high"].includes(parsed.confidence) ? parsed.confidence : "low",
    notes: typeof parsed.notes === "string" ? parsed.notes : "",
  };
});
