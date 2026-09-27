const express = require("express");
const router = express.Router();
const { requireUser } = require("../utils/auth");
const { getPlans } = require("../services/resellerxpress");
const { getWallet, getLedger, getSettings, spendWallet, purchaseToken, spendTokenForOrder, getTokenBalance, toUnits } = require("../services/wimp");

router.use(requireUser);

router.get("/wallet", async (req, res) => {
  try {
    const wallet = await getWallet(req, req.user.sub);
    return res.json({ wallet: require("../services/wimp").publicWallet(wallet), rules: await getSettings(req) });
  } catch (error) { return res.status(500).json({ msg: "Unable to load WIMP wallet" }); }
});

router.get("/transactions", async (req, res) => {
  try { return res.json({ data: await getLedger(req, req.user.sub, req.query.limit) }); }
  catch (error) { return res.status(500).json({ msg: "Unable to load WIMP transactions" }); }
});

router.get("/token/balance", async (req, res) => {
  try {
    const balance = await getTokenBalance(req, req.user.sub);
    return res.json({ ok: true, balance: balance.balance, wallet: balance.wallet });
  } catch (error) {
    return res.status(500).json({ ok: false, msg: error.message || "Unable to load WIMP token balance" });
  }
});

router.post("/token/purchase", async (req, res) => {
  const amount = toUnits(req.body?.amount);
  const referenceId = String(req.body?.referenceId || req.body?.reference || "").trim();
  const source = String(req.body?.source || "app").trim();
  const idempotencyKey = String(req.get("Idempotency-Key") || req.body?.idempotencyKey || `${req.user.sub}:${source}:${Date.now()}`).trim();
  if (amount === null || amount <= 0) return res.status(400).json({ ok: false, msg: "A valid WIMP token amount is required" });
  try {
    const result = await purchaseToken(req, {
      userId: req.user.sub,
      amountUnits: amount,
      source,
      referenceId: referenceId || `token-buy:${idempotencyKey}`,
      description: `WIMP token purchase via ${source}`,
      idempotencyKey
    });
    const balance = await getTokenBalance(req, req.user.sub);
    return res.json({ ok: true, duplicate: result.duplicate, balance: balance.balance, wallet: balance.wallet, ledger: result.ledger });
  } catch (error) {
    return res.status(500).json({ ok: false, msg: error.message || "Unable to purchase WIMP token" });
  }
});

router.post("/token/spend", async (req, res) => {
  const amount = toUnits(req.body?.amount);
  const referenceId = String(req.body?.referenceId || req.body?.reference || "").trim();
  const description = String(req.body?.description || "WIMP token spend for app purchase").trim();
  const idempotencyKey = String(req.get("Idempotency-Key") || req.body?.idempotencyKey || `${req.user.sub}:token-spend:${Date.now()}`).trim();
  if (amount === null || amount <= 0) return res.status(400).json({ ok: false, msg: "A valid WIMP token spend amount is required" });
  try {
    const result = await spendTokenForOrder(req, {
      userId: req.user.sub,
      amountUnits: amount,
      referenceId: referenceId || `token-spend:${idempotencyKey}`,
      description,
      idempotencyKey
    });
    const balance = await getTokenBalance(req, req.user.sub);
    return res.json({ ok: true, duplicate: result.duplicate, balance: balance.balance, wallet: balance.wallet, ledger: result.ledger });
  } catch (error) {
    const status = /Insufficient WIMP/.test(error.message) ? 400 : 500;
    return res.status(status).json({ ok: false, msg: error.message || "Unable to spend WIMP token" });
  }
});

router.post("/redeem", async (req, res) => {
  const planId = String(req.body?.planId || req.body?.plan_id || "");
  const requestedUnits = toUnits(req.body?.amount);
  const idempotencyKey = String(req.get("Idempotency-Key") || req.body?.idempotencyKey || "").trim();
  if (!planId || requestedUnits === null || requestedUnits <= 0 || !idempotencyKey) return res.status(400).json({ msg: "A product, positive WIMP amount, and Idempotency-Key are required" });
  try {
    const settings = await getSettings(req);
    if (!settings.redemptionEnabled) return res.status(403).json({ msg: "WIMP redemption is currently disabled" });
    const plansResponse = await getPlans(req.body?.network || req.body?.networkType);
    const plans = Array.isArray(plansResponse) ? plansResponse : plansResponse?.data || [];
    const plan = plans.find((item) => String(item.id) === planId);
    if (!plan || plan.available === false || plan.purchasable === false) return res.status(409).json({ msg: "Selected product is unavailable" });
    const priceUnits = toUnits(plan.sellingPrice);
    const maximumUnits = Math.min(requestedUnits, Number(settings.maximumDiscountUnits || requestedUnits), priceUnits || requestedUnits);
    if (requestedUnits < Number(settings.minimumRedemptionUnits || 0)) return res.status(400).json({ msg: `The minimum WIMP redemption is ${(Number(settings.minimumRedemptionUnits || 0) / 100).toFixed(2)} WIMP` });
    if (!priceUnits || maximumUnits <= 0) return res.status(400).json({ msg: "This product has no valid redemption price" });
    const result = await spendWallet(req, { userId: req.user.sub, amountUnits: maximumUnits, referenceId: `redeem:${idempotencyKey}`, description: `WIMP discount for ${plan.name || planId}`, idempotencyKey });
    return res.json({ msg: result.duplicate ? "Redemption already processed" : "WIMP discount applied", discount: maximumUnits / 100, ledger: result.ledger });
  } catch (error) {
    const status = /Insufficient WIMP/.test(error.message) ? 400 : 500;
    return res.status(status).json({ msg: error.message || "Unable to redeem WIMP" });
  }
});

module.exports = router;
