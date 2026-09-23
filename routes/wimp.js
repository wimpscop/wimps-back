const express = require("express");
const router = express.Router();
const { requireUser } = require("../utils/auth");
const { getPlans } = require("../services/resellerxpress");
const { getWallet, getLedger, getSettings, spendWallet, toUnits } = require("../services/wimp");

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
    if (!priceUnits || maximumUnits <= 0) return res.status(400).json({ msg: "This product has no valid redemption price" });
    const result = await spendWallet(req, { userId: req.user.sub, amountUnits: maximumUnits, referenceId: `redeem:${idempotencyKey}`, description: `WIMP discount for ${plan.name || planId}`, idempotencyKey });
    return res.json({ msg: result.duplicate ? "Redemption already processed" : "WIMP discount applied", discount: maximumUnits / 100, ledger: result.ledger });
  } catch (error) {
    const status = /Insufficient WIMP/.test(error.message) ? 400 : 500;
    return res.status(status).json({ msg: error.message || "Unable to redeem WIMP" });
  }
});

module.exports = router;
