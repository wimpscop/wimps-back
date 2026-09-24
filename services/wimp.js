const crypto = require("crypto");
const mongoose = require("mongoose");
const WimpWallet = require("../models/WimpWallet");
const WimpLedger = require("../models/WimpLedger");
const WimpSetting = require("../models/WimpSetting");
const { isFallback } = require("../utils/localStore");
const { readWallets, writeWallets, readLedger, writeLedger, readSettings, writeSettings } = require("../utils/wimpStore");

const DEFAULT_SETTINGS = {
  enabled: true,
  rewardPerCompletedPurchaseUnits: 10,
  redemptionEnabled: true,
  maximumDiscountUnits: 1000,
  minimumOrderAmount: 0,
  autoCompleteEnabled: true,
  autoCompleteHours: 5
};

function toUnits(value) {
  const amount = typeof value === "string" ? Number(value.trim()) : Number(value);
  if (!Number.isFinite(amount)) return null;
  const units = Math.round(amount * 100);
  return units >= 0 ? units : null;
}

function publicWallet(wallet) {
  return {
    balanceUnits: Number(wallet.balanceUnits || 0),
    balance: Number(wallet.balanceUnits || 0) / 100,
    updatedAt: wallet.updatedAt
  };
}

function settingsFromRecords(records) {
  return { ...DEFAULT_SETTINGS, ...Object.fromEntries(records.map((item) => [item.key, item.value])) };
}

async function getSettings(req) {
  if (isFallback(req)) return settingsFromRecords(readSettings());
  const records = await WimpSetting.find().lean();
  return { ...DEFAULT_SETTINGS, ...Object.fromEntries(records.map((item) => [item.key, item.value])) };
}

async function ensureWallet(req, userId, session) {
  if (isFallback(req)) {
    const wallets = readWallets();
    let wallet = wallets.find((item) => String(item.userId) === String(userId));
    if (!wallet) {
      wallet = { id: crypto.randomUUID(), userId: String(userId), balanceUnits: 0, version: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      wallets.push(wallet);
      writeWallets(wallets);
    }
    return wallet;
  }
  return WimpWallet.findOneAndUpdate(
    { userId: String(userId) },
    { $setOnInsert: { userId: String(userId), balanceUnits: 0, version: 0, createdAt: new Date() }, $set: { updatedAt: new Date() } },
    { upsert: true, new: true, session }
  );
}

async function getWallet(req, userId) {
  return ensureWallet(req, userId);
}

async function awardCompletedPurchase(req, { userId, referenceId, description }) {
  const settings = await getSettings(req);
  const amountUnits = Math.max(0, Number(settings.rewardPerCompletedPurchaseUnits || 0));
  if (!settings.enabled || !amountUnits || !referenceId) return { awarded: false, reason: "disabled_or_zero" };
  const idempotencyKey = `purchase-reward:${referenceId}`;

  if (isFallback(req)) {
    const ledger = readLedger();
    if (ledger.some((item) => item.idempotencyKey === idempotencyKey)) return { awarded: false, reason: "already_awarded" };
    const wallets = readWallets();
    let wallet = wallets.find((item) => String(item.userId) === String(userId));
    if (!wallet) {
      wallet = { id: crypto.randomUUID(), userId: String(userId), balanceUnits: 0, version: 0, createdAt: new Date().toISOString() };
      wallets.push(wallet);
    }
    const before = Number(wallet.balanceUnits || 0);
    wallet.balanceUnits = before + amountUnits;
    wallet.version = Number(wallet.version || 0) + 1;
    wallet.updatedAt = new Date().toISOString();
    ledger.push({ id: crypto.randomUUID(), userId: String(userId), walletId: wallet.id, type: "earn", amountUnits, balanceBeforeUnits: before, balanceAfterUnits: wallet.balanceUnits, referenceId: String(referenceId), description, idempotencyKey, createdAt: new Date().toISOString() });
    writeWallets(wallets);
    writeLedger(ledger);
    return { awarded: true, amountUnits };
  }

  const session = await mongoose.startSession();
  try {
    let result = { awarded: false, reason: "already_awarded" };
    await session.withTransaction(async () => {
      const existing = await WimpLedger.findOne({ idempotencyKey }).session(session);
      if (existing) return;
      const wallet = await ensureWallet(req, userId, session);
      const before = Number(wallet.balanceUnits || 0);
      wallet.balanceUnits = before + amountUnits;
      wallet.version = Number(wallet.version || 0) + 1;
      wallet.updatedAt = new Date();
      await wallet.save({ session });
      await WimpLedger.create([{
        userId: String(userId), walletId: String(wallet._id), type: "earn", amountUnits,
        balanceBeforeUnits: before, balanceAfterUnits: wallet.balanceUnits,
        referenceId: String(referenceId), description, idempotencyKey
      }], { session });
      result = { awarded: true, amountUnits };
    });
    return result;
  } finally {
    await session.endSession();
  }
}

async function getLedger(req, userId, limit = 100) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 200));
  if (isFallback(req)) return readLedger().filter((item) => String(item.userId) === String(userId)).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, safeLimit);
  return WimpLedger.find({ userId: String(userId) }).sort({ createdAt: -1 }).limit(safeLimit).lean();
}

async function spendWallet(req, { userId, amountUnits, referenceId, description, idempotencyKey }) {
  if (!Number.isInteger(amountUnits) || amountUnits <= 0) throw new Error("Invalid WIMP amount");
  if (!idempotencyKey) throw new Error("Idempotency key is required");
  if (isFallback(req)) {
    const ledger = readLedger();
    const duplicate = ledger.find((item) => item.idempotencyKey === idempotencyKey);
    if (duplicate) return { duplicate: true, ledger: duplicate };
    const wallets = readWallets();
    const wallet = wallets.find((item) => String(item.userId) === String(userId));
    if (!wallet || Number(wallet.balanceUnits || 0) < amountUnits) throw new Error("Insufficient WIMP balance");
    const before = Number(wallet.balanceUnits);
    wallet.balanceUnits -= amountUnits;
    wallet.version = Number(wallet.version || 0) + 1;
    wallet.updatedAt = new Date().toISOString();
    const entry = { id: crypto.randomUUID(), userId: String(userId), walletId: wallet.id, type: "spend", amountUnits, balanceBeforeUnits: before, balanceAfterUnits: wallet.balanceUnits, referenceId: String(referenceId || ""), description, idempotencyKey, createdAt: new Date().toISOString() };
    ledger.push(entry);
    writeWallets(wallets);
    writeLedger(ledger);
    return { duplicate: false, ledger: entry };
  }

  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const duplicate = await WimpLedger.findOne({ idempotencyKey }).session(session);
      if (duplicate) {
        result = { duplicate: true, ledger: duplicate };
        return;
      }
      const wallet = await WimpWallet.findOneAndUpdate(
        { userId: String(userId), balanceUnits: { $gte: amountUnits } },
        { $inc: { balanceUnits: -amountUnits, version: 1 }, $set: { updatedAt: new Date() } },
        { new: true, session }
      );
      if (!wallet) throw new Error("Insufficient WIMP balance");
      const before = Number(wallet.balanceUnits) + amountUnits;
      const [entry] = await WimpLedger.create([{
        userId: String(userId), walletId: String(wallet._id), type: "spend", amountUnits,
        balanceBeforeUnits: before, balanceAfterUnits: Number(wallet.balanceUnits),
        referenceId: String(referenceId || ""), description, idempotencyKey
      }], { session });
      result = { duplicate: false, ledger: entry };
    });
    return result;
  } finally {
    await session.endSession();
  }
}

async function adjustWallet(req, { userId, amountUnits, type, referenceId, description, createdBy, idempotencyKey, debit = false }) {
  if (!Number.isInteger(amountUnits) || amountUnits <= 0) throw new Error("Invalid WIMP amount");
  if (!idempotencyKey) throw new Error("Idempotency key is required");
  if (!["earn", "refund", "expiry", "admin_adjustment"].includes(type)) throw new Error("Invalid WIMP transaction type");
  if (isFallback(req)) {
    const ledger = readLedger();
    if (ledger.some((item) => item.idempotencyKey === idempotencyKey)) return { duplicate: true };
    const wallets = readWallets();
    let wallet = wallets.find((item) => String(item.userId) === String(userId));
    if (!wallet) { wallet = { id: crypto.randomUUID(), userId: String(userId), balanceUnits: 0, version: 0 }; wallets.push(wallet); }
    const before = Number(wallet.balanceUnits || 0);
    if (debit && before < amountUnits) throw new Error("Insufficient WIMP balance");
    wallet.balanceUnits = before + (debit ? -amountUnits : amountUnits);
    wallet.version = Number(wallet.version || 0) + 1;
    const entry = { id: crypto.randomUUID(), userId: String(userId), walletId: wallet.id, type, amountUnits, balanceBeforeUnits: before, balanceAfterUnits: wallet.balanceUnits, referenceId: String(referenceId || ""), description, createdBy: String(createdBy || ""), idempotencyKey, createdAt: new Date().toISOString() };
    ledger.push(entry); writeWallets(wallets); writeLedger(ledger); return { duplicate: false, ledger: entry };
  }
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      if (await WimpLedger.exists({ idempotencyKey }).session(session)) { result = { duplicate: true }; return; }
      const wallet = await ensureWallet(req, userId, session);
      const before = Number(wallet.balanceUnits || 0);
      if (debit && before < amountUnits) throw new Error("Insufficient WIMP balance");
      wallet.balanceUnits = before + (debit ? -amountUnits : amountUnits);
      wallet.version = Number(wallet.version || 0) + 1;
      wallet.updatedAt = new Date();
      await wallet.save({ session });
      const [entry] = await WimpLedger.create([{ userId: String(userId), walletId: String(wallet._id), type, amountUnits, balanceBeforeUnits: before, balanceAfterUnits: wallet.balanceUnits, referenceId: String(referenceId || ""), description, createdBy: String(createdBy || ""), idempotencyKey }], { session });
      result = { duplicate: false, ledger: entry };
    });
    return result;
  } finally { await session.endSession(); }
}

async function saveSettings(req, values, updatedBy) {
  if (isFallback(req)) {
    const records = readSettings();
    for (const [key, value] of Object.entries(values)) {
      const existing = records.find((item) => item.key === key);
      if (existing) { existing.value = value; existing.updatedBy = String(updatedBy || ""); existing.updatedAt = new Date().toISOString(); }
      else records.push({ key, value, updatedBy: String(updatedBy || ""), updatedAt: new Date().toISOString() });
    }
    writeSettings(records); return settingsFromRecords(records);
  }
  for (const [key, value] of Object.entries(values)) await WimpSetting.findOneAndUpdate({ key }, { key, value, updatedBy: String(updatedBy || ""), updatedAt: new Date() }, { upsert: true });
  return getSettings(req);
}

async function reverseCompletedPurchaseReward(req, { userId, referenceId, description }) {
  const idempotencyKey = `purchase-refund:${referenceId}`;
  const rewardKey = `purchase-reward:${referenceId}`;
  const ledger = isFallback(req)
    ? readLedger().find((item) => item.idempotencyKey === rewardKey)
    : await WimpLedger.findOne({ idempotencyKey: rewardKey }).lean();
  if (!ledger) return { reversed: false, reason: "no_reward" };
  return adjustWallet(req, { userId, amountUnits: Number(ledger.amountUnits), type: "refund", referenceId, description, createdBy: "system", idempotencyKey, debit: true });
}

module.exports = { DEFAULT_SETTINGS, toUnits, publicWallet, getSettings, getLedger, ensureWallet, getWallet, awardCompletedPurchase, reverseCompletedPurchaseReward, spendWallet, adjustWallet, saveSettings };
