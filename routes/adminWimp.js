const express = require("express");
const crypto = require("crypto");
const User = require("../models/user");
const { isFallback, readUsers } = require("../utils/localStore");
const { readLedger } = require("../utils/wimpStore");
const { getSettings, saveSettings, getLedger, adjustWallet, toUnits } = require("../services/wimp");

const router = express.Router();

function requireAdmin(req, res, next) {
  const expected = String(process.env.ADMIN_API_TOKEN || "");
  const supplied = String(req.get("X-Admin-Token") || "");
  if (!expected) return res.status(503).json({ msg: "Admin API token is not configured" });
  if (!supplied || supplied.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return res.status(401).json({ msg: "Admin authentication required" });
  req.adminId = crypto.createHash("sha256").update(supplied).digest("hex").slice(0, 16);
  next();
}

router.use(requireAdmin);

async function findUser(req, email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (isFallback(req)) return readUsers().find((item) => String(item.email || "").toLowerCase() === normalized);
  return User.findOne({ email: normalized });
}

router.get("/transactions", async (req, res) => {
  try {
    if (req.query.email) {
      const user = await findUser(req, req.query.email);
      if (!user) return res.status(404).json({ msg: "Customer not found" });
      return res.json({ data: await getLedger(req, String(user._id || user.id), req.query.limit) });
    }
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 200, 1000));
    const data = isFallback(req) ? readLedger().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, limit) : await require("../models/WimpLedger").find().sort({ createdAt: -1 }).limit(limit).lean();
    return res.json({ data });
  } catch (error) { return res.status(500).json({ msg: "Unable to load WIMP transactions" }); }
});

router.post("/adjust", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const amountUnits = toUnits(req.body?.amount);
  const reason = String(req.body?.reason || "").trim();
  const direction = String(req.body?.direction || "credit").toLowerCase();
  const idempotencyKey = String(req.get("Idempotency-Key") || req.body?.idempotencyKey || "").trim();
  if (!email || amountUnits === null || amountUnits <= 0 || !reason || !idempotencyKey || !["credit", "debit"].includes(direction)) return res.status(400).json({ msg: "Email, positive amount, direction, reason, and Idempotency-Key are required" });
  try {
    const user = await findUser(req, email);
    if (!user) return res.status(404).json({ msg: "Customer not found" });
    const result = await adjustWallet(req, { userId: String(user._id || user.id), amountUnits, type: "admin_adjustment", referenceId: `admin:${idempotencyKey}`, description: reason, createdBy: req.adminId, idempotencyKey, debit: direction === "debit" });
    return res.json({ msg: result.duplicate ? "Adjustment already processed" : "WIMP balance adjusted", data: result.ledger });
  } catch (error) { return res.status(/Insufficient WIMP/.test(error.message) ? 400 : 500).json({ msg: error.message || "Unable to adjust WIMP balance" }); }
});

router.put("/settings", async (req, res) => {
  const input = req.body || {};
  const values = {};
  if (input.enabled !== undefined) values.enabled = Boolean(input.enabled);
  if (input.redemptionEnabled !== undefined) values.redemptionEnabled = Boolean(input.redemptionEnabled);
  if (input.rewardPerCompletedPurchase !== undefined) {
    const units = toUnits(input.rewardPerCompletedPurchase);
    if (units === null) return res.status(400).json({ msg: "Invalid reward amount" });
    values.rewardPerCompletedPurchaseUnits = units;
  }
  if (input.maximumDiscount !== undefined) {
    const units = toUnits(input.maximumDiscount);
    if (units === null) return res.status(400).json({ msg: "Invalid maximum discount" });
    values.maximumDiscountUnits = units;
  }
  if (input.minimumRedemption !== undefined) {
    const units = toUnits(input.minimumRedemption);
    if (units === null) return res.status(400).json({ msg: "Invalid minimum redemption" });
    values.minimumRedemptionUnits = units;
  }
  if (input.tokenEnabled !== undefined) values.tokenEnabled = Boolean(input.tokenEnabled);
  if (input.tokenPurchaseEnabled !== undefined) values.tokenPurchaseEnabled = Boolean(input.tokenPurchaseEnabled);
  if (input.tokenSpendEnabled !== undefined) values.tokenSpendEnabled = Boolean(input.tokenSpendEnabled);
  if (input.tokenMinPurchase !== undefined) {
    const units = toUnits(input.tokenMinPurchase);
    if (units === null) return res.status(400).json({ msg: "Invalid minimum token purchase" });
    values.tokenMinPurchaseUnits = units;
  }
  if (input.tokenMaxPurchase !== undefined) {
    const units = toUnits(input.tokenMaxPurchase);
    if (units === null) return res.status(400).json({ msg: "Invalid maximum token purchase" });
    values.tokenMaxPurchaseUnits = units;
  }
  if (input.tokenMinSpend !== undefined) {
    const units = toUnits(input.tokenMinSpend);
    if (units === null) return res.status(400).json({ msg: "Invalid minimum token spend" });
    values.tokenMinSpendUnits = units;
  }
  if (input.tokenBuyFeePercent !== undefined) {
    const value = Number(input.tokenBuyFeePercent);
    if (!Number.isFinite(value) || value < 0 || value > 100) return res.status(400).json({ msg: "Buy fee must be between 0 and 100" });
    values.tokenBuyFeePercent = value;
  }
  if (input.tokenSellFeePercent !== undefined) {
    const value = Number(input.tokenSellFeePercent);
    if (!Number.isFinite(value) || value < 0 || value > 100) return res.status(400).json({ msg: "Sell fee must be between 0 and 100" });
    values.tokenSellFeePercent = value;
  }
  if (input.autoCompleteEnabled !== undefined) values.autoCompleteEnabled = Boolean(input.autoCompleteEnabled);
  if (input.autoCompleteHours !== undefined) {
    const hours = Number(input.autoCompleteHours);
    if (!Number.isFinite(hours) || hours < 1 || hours > 168) return res.status(400).json({ msg: "Auto-complete hours must be between 1 and 168" });
    values.autoCompleteHours = hours;
  }
  if (!Object.keys(values).length) return res.status(400).json({ msg: "No valid WIMP settings supplied" });
  try { return res.json({ settings: await saveSettings(req, values, req.adminId) }); }
  catch (error) { return res.status(500).json({ msg: "Unable to save WIMP settings" }); }
});

router.get("/settings", async (req, res) => {
  try { return res.json({ settings: await getSettings(req) }); }
  catch (error) { return res.status(500).json({ msg: "Unable to load WIMP settings" }); }
});

module.exports = router;
