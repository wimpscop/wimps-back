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
  minimumRedemptionUnits: 1,
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

function rewardLedgerEntries(entries) {
  return entries.filter((item) => String(item.scope || "reward") === "reward");
}

function tokenLedgerEntries(entries) {
  return entries.filter((item) => String(item.scope || "reward") === "token");
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
    const ledger = rewardLedgerEntries(readLedger().filter((item) => String(item.userId) === String(userId))).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    let wallet = wallets.find((item) => String(item.userId) === String(userId));
    if (!wallet) {
      wallet = { id: crypto.randomUUID(), userId: String(userId), balanceUnits: Number(ledger[0]?.balanceAfterUnits || 0), version: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      wallets.push(wallet);
      writeWallets(wallets);
    } else if (ledger[0] && Number(ledger[0].balanceAfterUnits || 0) > Number(wallet.balanceUnits || 0)) {
      wallet.balanceUnits = Number(ledger[0].balanceAfterUnits);
      wallet.updatedAt = new Date().toISOString();
      writeWallets(wallets);
    }
    return wallet;
  }
  const wallet = await WimpWallet.findOneAndUpdate(
    { userId: String(userId) },
    { $setOnInsert: { userId: String(userId), balanceUnits: 0, tokenBalanceUnits: 0, version: 0, createdAt: new Date() }, $set: { updatedAt: new Date() } },
    { upsert: true, new: true, session }
  );
  const latest = await WimpLedger.findOne({ userId: String(userId), scope: "reward" }).sort({ createdAt: -1 }).session(session).lean();
  if (latest && Number(latest.balanceAfterUnits || 0) > Number(wallet.balanceUnits || 0)) {
    wallet.balanceUnits = Number(latest.balanceAfterUnits);
    wallet.updatedAt = new Date();
    await wallet.save({ session });
  }
  return wallet;
}

async function ensureTokenWallet(req, userId, session) {
  if (isFallback(req)) {
    const wallets = readWallets();
    const ledger = tokenLedgerEntries(readLedger().filter((item) => String(item.userId) === String(userId))).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    let wallet = wallets.find((item) => String(item.userId) === String(userId));
    if (!wallet) {
      wallet = { id: crypto.randomUUID(), userId: String(userId), balanceUnits: 0, tokenBalanceUnits: Number(ledger[0]?.balanceAfterUnits || 0), version: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      wallets.push(wallet);
      writeWallets(wallets);
      return wallet;
    }
    if (!Object.prototype.hasOwnProperty.call(wallet, "tokenBalanceUnits") || Number(wallet.tokenBalanceUnits || 0) < Number(ledger[0]?.balanceAfterUnits || 0)) {
      wallet.tokenBalanceUnits = Number(ledger[0]?.balanceAfterUnits || Number(wallet.tokenBalanceUnits || 0));
      wallet.updatedAt = new Date().toISOString();
      writeWallets(wallets);
    }
    return wallet;
  }
  const wallet = await WimpWallet.findOneAndUpdate(
    { userId: String(userId) },
    { $setOnInsert: { userId: String(userId), balanceUnits: 0, tokenBalanceUnits: 0, version: 0, createdAt: new Date() }, $set: { updatedAt: new Date() } },
    { upsert: true, new: true, session }
  );
  const latest = await WimpLedger.findOne({ userId: String(userId), scope: "token" }).sort({ createdAt: -1 }).session(session).lean();
  if (latest && Number(latest.balanceAfterUnits || 0) > Number(wallet.tokenBalanceUnits || 0)) {
    wallet.tokenBalanceUnits = Number(latest.balanceAfterUnits);
    wallet.updatedAt = new Date();
    await wallet.save({ session });
  }
  return wallet;
}

async function getWallet(req, userId) {
  return ensureWallet(req, userId);
}

async function calculateDiscount(req, { userId, requestedUnits, maximumUnits }) {
  const settings = await getSettings(req);
  if (!settings.redemptionEnabled || !Number.isInteger(requestedUnits) || requestedUnits <= 0) return 0;
  if (requestedUnits < Number(settings.minimumRedemptionUnits || 0)) return -1;
  const wallet = await getWallet(req, userId);
  return Math.min(requestedUnits, Number(wallet.balanceUnits || 0), Number(settings.maximumDiscountUnits || requestedUnits), Math.max(0, Number(maximumUnits || 0)));
}

async function getTokenBalance(req, userId) {
  const wallet = await ensureTokenWallet(req, userId);
  return {
    balanceUnits: Number(wallet.tokenBalanceUnits || 0),
    balance: Number(wallet.tokenBalanceUnits || 0) / 100,
    wallet: { balanceUnits: Number(wallet.tokenBalanceUnits || 0), balance: Number(wallet.tokenBalanceUnits || 0) / 100, updatedAt: wallet.updatedAt }
  };
}

async function adjustTokenWallet(req, { userId, amountUnits, type, referenceId, description, createdBy, idempotencyKey, debit = false }) {
  if (!Number.isInteger(amountUnits) || amountUnits <= 0) throw new Error("Invalid WIMP token amount");
  if (!idempotencyKey) throw new Error("Idempotency key is required");
  if (!["purchase", "refund", "admin_adjustment", "spend"].includes(type)) throw new Error("Invalid WIMP token transaction type");
  if (isFallback(req)) {
    const ledger = readLedger();
    if (ledger.some((item) => item.idempotencyKey === idempotencyKey)) return { duplicate: true };
    const wallets = readWallets();
    let wallet = wallets.find((item) => String(item.userId) === String(userId));
    if (!wallet) {
      wallet = { id: crypto.randomUUID(), userId: String(userId), balanceUnits: 0, tokenBalanceUnits: 0, version: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      wallets.push(wallet);
    }
    const before = Number(wallet.tokenBalanceUnits || 0);
    if (debit && before < amountUnits) throw new Error("Insufficient WIMP token balance");
    wallet.tokenBalanceUnits = before + (debit ? -amountUnits : amountUnits);
    wallet.version = Number(wallet.version || 0) + 1;
    wallet.updatedAt = new Date().toISOString();
    const entry = { id: crypto.randomUUID(), userId: String(userId), walletId: wallet.id, scope: "token", type, amountUnits, balanceBeforeUnits: before, balanceAfterUnits: wallet.tokenBalanceUnits, referenceId: String(referenceId || ""), description, createdBy: String(createdBy || ""), idempotencyKey, createdAt: new Date().toISOString() };
    ledger.push(entry); writeWallets(wallets); writeLedger(ledger); return { duplicate: false, ledger: entry };
  }
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      if (await WimpLedger.exists({ idempotencyKey }).session(session)) { result = { duplicate: true }; return; }
      const wallet = await ensureTokenWallet(req, userId, session);
      const before = Number(wallet.tokenBalanceUnits || 0);
      if (debit && before < amountUnits) throw new Error("Insufficient WIMP token balance");
      wallet.tokenBalanceUnits = before + (debit ? -amountUnits : amountUnits);
      wallet.version = Number(wallet.version || 0) + 1;
      wallet.updatedAt = new Date();
      await wallet.save({ session });
      const [entry] = await WimpLedger.create([{ userId: String(userId), walletId: String(wallet._id), scope: "token", type, amountUnits, balanceBeforeUnits: before, balanceAfterUnits: wallet.tokenBalanceUnits, referenceId: String(referenceId || ""), description, createdBy: String(createdBy || ""), idempotencyKey }], { session });
      result = { duplicate: false, ledger: entry };
    });
    return result;
  } finally { await session.endSession(); }
}

async function spendTokenWallet(req, { userId, amountUnits, referenceId, description, idempotencyKey, createdBy = "system" }) {
  if (!Number.isInteger(amountUnits) || amountUnits <= 0) throw new Error("Invalid WIMP token amount");
  if (!idempotencyKey) throw new Error("Idempotency key is required");
  const key = String(idempotencyKey || referenceId || `${userId}:${Date.now()}`).trim();
  const result = await adjustTokenWallet(req, {
    userId,
    amountUnits,
    type: "spend",
    referenceId: String(referenceId || key),
    description: String(description || "WIMP token spend for order").trim() || "WIMP token spend for order",
    createdBy,
    idempotencyKey: key,
    debit: true
  });
  return result;
}

async function purchaseToken(req, { userId, amountUnits, source = "card", referenceId, description, idempotencyKey, createdBy = "system" }) {
  if (!Number.isInteger(amountUnits) || amountUnits <= 0) throw new Error("Invalid WIMP token amount");
  const key = String(idempotencyKey || referenceId || `${source}:${userId}:${Date.now()}`).trim();
  const descriptionText = String(description || `WIMP token purchase via ${source}`).trim() || `WIMP token purchase via ${source}`;
  const result = await adjustTokenWallet(req, {
    userId,
    amountUnits,
    type: "purchase",
    referenceId: String(referenceId || key),
    description: descriptionText,
    createdBy,
    idempotencyKey: key,
    debit: false
  });
  return { duplicate: Boolean(result?.duplicate), ledger: result?.ledger || null };
}

async function spendTokenForOrder(req, { userId, amountUnits, referenceId, description, idempotencyKey, createdBy = "system" }) {
  if (!Number.isInteger(amountUnits) || amountUnits <= 0) throw new Error("Invalid WIMP token spend amount");
  const key = String(idempotencyKey || referenceId || `${userId}:${Date.now()}`).trim();
  const descriptionText = String(description || "WIMP token spend for order").trim() || "WIMP token spend for order";
  const result = await spendTokenWallet(req, {
    userId,
    amountUnits,
    referenceId: String(referenceId || key),
    description: descriptionText,
    idempotencyKey: key,
    createdBy
  });
  return { duplicate: Boolean(result?.duplicate), ledger: result?.ledger || null };
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
    ledger.push({ id: crypto.randomUUID(), userId: String(userId), walletId: wallet.id, scope: "reward", type: "earn", amountUnits, balanceBeforeUnits: before, balanceAfterUnits: wallet.balanceUnits, referenceId: String(referenceId), description, idempotencyKey, createdAt: new Date().toISOString() });
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
        userId: String(userId), walletId: String(wallet._id), scope: "reward", type: "earn", amountUnits,
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

async function clearUserWimpData(req, userId) {
  if (isFallback(req)) {
    const ledger = readLedger();
    const remainingLedger = ledger.filter((entry) => String(entry.userId) !== String(userId));
    writeLedger(remainingLedger);
    return { entriesDeleted: ledger.length - remainingLedger.length };
  }
  const ledgerResult = await WimpLedger.deleteMany({ userId: String(userId) });
  return { entriesDeleted: ledgerResult.deletedCount || 0 };
}

async function clearAllWimpData(req) {
  if (isFallback(req)) {
    const ledger = readLedger();
    writeLedger([]);
    return { entriesDeleted: ledger.length };
  }
  const ledgerResult = await WimpLedger.deleteMany({});
  return { entriesDeleted: ledgerResult.deletedCount || 0 };
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
    const entry = { id: crypto.randomUUID(), userId: String(userId), walletId: wallet.id, scope: "reward", type: "spend", amountUnits, balanceBeforeUnits: before, balanceAfterUnits: wallet.balanceUnits, referenceId: String(referenceId || ""), description, idempotencyKey, createdAt: new Date().toISOString() };
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
        userId: String(userId), walletId: String(wallet._id), scope: "reward", type: "spend", amountUnits,
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
  if (!["earn", "refund", "expiry", "admin_adjustment", "purchase"].includes(type)) throw new Error("Invalid WIMP transaction type");
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
    const entry = { id: crypto.randomUUID(), userId: String(userId), walletId: wallet.id, scope: "reward", type, amountUnits, balanceBeforeUnits: before, balanceAfterUnits: wallet.balanceUnits, referenceId: String(referenceId || ""), description, createdBy: String(createdBy || ""), idempotencyKey, createdAt: new Date().toISOString() };
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
      const [entry] = await WimpLedger.create([{ userId: String(userId), walletId: String(wallet._id), scope: "reward", type, amountUnits, balanceBeforeUnits: before, balanceAfterUnits: wallet.balanceUnits, referenceId: String(referenceId || ""), description, createdBy: String(createdBy || ""), idempotencyKey }], { session });
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

module.exports = {
  DEFAULT_SETTINGS,
  toUnits,
  publicWallet,
  getSettings,
  getLedger,
  ensureWallet,
  getWallet,
  getTokenBalance,
  clearUserWimpData,
  clearAllWimpData,
  purchaseToken,
  spendTokenForOrder,
  calculateDiscount,
  awardCompletedPurchase,
  reverseCompletedPurchaseReward,
  spendWallet,
  ensureTokenWallet,
  adjustWallet,
  saveSettings
};
