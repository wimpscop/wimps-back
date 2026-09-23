const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const User = require("../models/user");
const Transaction = require("../models/Transaction");
const AdminSetting = require("../models/AdminSetting");
const reseller = require("../services/resellerxpress");
const { placeProviderOrder, getPlans } = reseller;
const remadata = require("../services/remadata");
const datamart = require("../services/datamart");
const { sendCustomerEmail } = require("../services/resend");
const { readData, writeData } = require("../utils/fileDb");
const { isFallback, readUsers, writeUsers, readTransactions, writeTransactions } = require("../utils/localStore");

const router = express.Router();

function requireAdminToken(req, res, next) {
  const configuredToken = process.env.ADMIN_API_TOKEN;
  const suppliedToken = req.get("X-Admin-Token");

  if (!configuredToken) {
    return res.status(503).json({ msg: "Admin API token is not configured" });
  }

  if (!suppliedToken || suppliedToken.length !== configuredToken.length || !crypto.timingSafeEqual(Buffer.from(suppliedToken), Buffer.from(configuredToken))) {
    return res.status(401).json({ msg: "Admin authentication required" });
  }

  next();
}

function startOfDay() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

const PROVIDER_IDS = ["", "resellerxpress", "remadata", "datamart"];

const SETTING_SCHEMA = {
  handlingFees: {
    coerce: (value) => value && typeof value === "object" ? value : {},
    validate: (value) => Object.values(value).every((item) => Number.isFinite(Number(item)) && Number(item) >= 0)
  },
  referralReward: {
    coerce: (value) => Number(value),
    validate: (value) => Number.isFinite(value) && value >= 0
  },
  neverBelowCost: {
    coerce: (value) => Boolean(value),
    validate: () => true
  },
  autoProvider: {
    coerce: (value) => Boolean(value),
    validate: () => true
  },
  selectedProvider: {
    coerce: (value) => String(value || ""),
    validate: (value) => PROVIDER_IDS.includes(value)
  }
};

function buildFallbackOverview(fallbackUsers, fallbackTransactions, totalUsers, today) {
  const todayPurchases = fallbackTransactions.filter((tx) => tx.type === "purchase" && new Date(tx.date || Date.now()) >= today);
  const todaySales = todayPurchases.reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
  const todayProfit = todayPurchases.reduce((sum, tx) => sum + Number(tx.actualProfit ?? tx.expectedProfit ?? 0), 0);
  const todayRefunds = fallbackTransactions.filter((tx) => tx.status === "refunded").reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
  return {
    totalUsers: Number(totalUsers || 0) > 0 ? totalUsers : fallbackUsers.length,
    todaySales: Number(todaySales.toFixed(2)),
    todayProfit: Number(todayProfit.toFixed(2)),
    todayOrders: todayPurchases.length,
    successfulOrders: fallbackTransactions.filter((tx) => tx.type === "purchase" && ["completed", "success", "successful", "delivered"].includes(tx.status)).length,
    pendingOrders: fallbackTransactions.filter((tx) => tx.type === "purchase" && tx.status === "pending").length,
    failedOrders: fallbackTransactions.filter((tx) => tx.type === "purchase" && tx.status === "failed").length,
    todayRefunds
  };
}

async function fetchProviderBalance(id, providerService) {
  const extractAmount = (value) => Number(value.balance ?? value.data?.balance?.balance ?? value.data?.balance);
  try {
    const value = await providerService.getWalletBalance();
    return { id, amount: extractAmount(value) };
  } catch (error) {
    return { id, error: error.response?.data?.message || error.message };
  }
}

router.use(requireAdminToken);

router.get("/overview", async (req, res) => {
  const fallbackUsers = readData("users.json") || [];
  const fallbackTransactions = readData("transactions.json") || [];
  const today = startOfDay();
  let totalUsers = 0;

  const fallbackOnly = isFallback(req) && Boolean(fallbackUsers.length || fallbackTransactions.length);

  try {
    const [dbTotalUsers, todayTransactions, successfulOrders, pendingOrders, failedOrders] = await Promise.all([
      User.countDocuments(),
      Transaction.find({ date: { $gte: today } }).lean(),
      Transaction.countDocuments({ type: "purchase", status: { $in: ["completed", "success", "successful", "delivered"] } }),
      Transaction.countDocuments({ type: "purchase", status: "pending" }),
      Transaction.countDocuments({ type: "purchase", status: "failed" })
    ]);
    totalUsers = dbTotalUsers;

    if (isFallback(req) && Number(totalUsers || 0) <= 0 && fallbackUsers.length > 0) {
      return res.json(buildFallbackOverview(fallbackUsers, fallbackTransactions, totalUsers, today));
    }

    if (isFallback(req) && Array.isArray(todayTransactions) && todayTransactions.length === 0 && fallbackTransactions.length > 0) {
      return res.json(buildFallbackOverview(fallbackUsers, fallbackTransactions, totalUsers, today));
    }

    const todayPurchases = todayTransactions.filter((tx) => tx.type === "purchase");
    const todaySales = todayPurchases.reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
    const todayProfit = todayPurchases.reduce((sum, tx) => sum + Number(tx.actualProfit ?? tx.expectedProfit ?? 0), 0);
    const todayRefunds = todayTransactions.filter((tx) => tx.status === "refunded").reduce((sum, tx) => sum + Number(tx.amount || 0), 0);
    return res.json({ totalUsers, todaySales: Number(todaySales.toFixed(2)), todayProfit: Number(todayProfit.toFixed(2)), todayOrders: todayPurchases.length, successfulOrders, pendingOrders, failedOrders, todayRefunds });
  } catch (error) {
    if (!fallbackOnly) {
      return res.status(503).json({ msg: "Live dashboard data is temporarily unavailable" });
    }
    return res.json(buildFallbackOverview(fallbackUsers, fallbackTransactions, totalUsers, today));
  }
});

router.get("/orders", async (req, res) => {
  const fallbackTransactions = readData("transactions.json") || [];
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 100));
  try {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    const data = await Transaction.find(filter).sort({ date: -1 }).limit(limit).lean();
    if (!Array.isArray(data) || data.length === 0) return res.json({ data: fallbackTransactions.slice(0, limit) });
    return res.json({ data });
  } catch (error) {
    return res.json({ data: fallbackTransactions.slice(0, limit) });
  }
});

router.patch("/orders/:id/status", async (req, res) => {
  const status = String(req.body?.status || "").toLowerCase();
  if (!["pending", "completed", "failed", "refunded"].includes(status)) {
    return res.status(400).json({ msg: "Invalid order status" });
  }
  try {
    const order = await Transaction.findByIdAndUpdate(req.params.id,
      { $set: { status, ...(status === "completed" ? { deliveredAt: new Date() } : {}) } },
      { new: true }).lean();
    if (!order) return res.status(404).json({ msg: "Order not found" });
    return res.json({ data: order });
  } catch (error) {
    const transactions = readTransactions();
    const order = transactions.find((item) => String(item._id || item.id) === String(req.params.id));
    if (!order) return res.status(404).json({ msg: "Order not found" });
    order.status = status;
    if (status === "completed") order.deliveredAt = new Date().toISOString();
    writeTransactions(transactions);
    return res.json({ data: order });
  }
});

router.delete("/transactions", async (req, res) => {
  if (String(req.body?.confirmation || "") !== "DELETE TRANSACTION HISTORY") {
    return res.status(400).json({ msg: "Confirmation required" });
  }
  if (isFallback(req)) {
    const transactions = readTransactions();
    writeTransactions([]);
    return res.json({ deleted: transactions.length });
  }
  try {
    const result = await Transaction.deleteMany({});
    return res.json({ deleted: result.deletedCount || 0 });
  } catch (error) {
    const transactions = readTransactions();
    writeTransactions([]);
    return res.json({ deleted: transactions.length });
  }
});

router.get("/activity", async (req, res) => {
  const fallbackUsers = readData("users.json") || [];
  const fallbackTransactions = readData("transactions.json") || [];
  try {
    const [transactions, users] = await Promise.all([
      Transaction.find().sort({ date: -1 }).limit(100).lean(),
      User.find({}, { password: 0 }).sort({ createdAt: -1 }).limit(100).lean()
    ]);
    const activity = [
      ...transactions.map((item) => ({ ...item, activityType: item.type || "transaction", at: item.date })),
      ...users.map((item) => ({ email: item.email, fullname: item.fullname, activityType: "account_created", referralCode: item.referralCode, at: item.createdAt }))
    ].sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0)).slice(0, 100);
    return res.json({ data: activity });
  } catch (error) {
    const activity = [
      ...fallbackTransactions.map((item) => ({ ...item, activityType: item.type || "transaction", at: item.date })),
      ...fallbackUsers.map((item) => ({ email: item.email, fullname: item.fullname, activityType: "account_created", referralCode: item.referralCode, at: item.createdAt }))
    ].sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0)).slice(0, 100);
    return res.json({ data: activity });
  }
});

router.get("/payments", async (req, res) => {
  const fallbackTransactions = readData("transactions.json") || [];
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 100, 200));
  try {
    const data = await Transaction.find({ paymentMethod: { $exists: true, $ne: null } }).sort({ date: -1 }).limit(limit).lean();
    if (!Array.isArray(data) || data.length === 0) return res.json({ data: fallbackTransactions.slice(0, limit) });
    return res.json({ data });
  } catch (error) {
    return res.json({ data: fallbackTransactions.slice(0, limit) });
  }
});

router.get("/customers", async (req, res) => {
  const fallbackUsers = readData("users.json") || [];
  const limit = Math.max(1, Math.min(Number(req.query.limit) || 100, 200));
  try {
    const data = await User.find({}, { password: 0, resetPasswordTokenHash: 0, resetPasswordExpires: 0 }).sort({ createdAt: -1 }).limit(limit).lean();
    if (!Array.isArray(data) || data.length === 0) return res.json({ data: fallbackUsers.slice(0, limit) });
    return res.json({ data });
  } catch (error) {
    return res.json({ data: fallbackUsers.slice(0, limit) });
  }
});

router.delete("/customers/:email", async (req, res) => {
  const email = String(req.params.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) return res.status(400).json({ msg: "A valid customer email is required" });

  if (isFallback(req)) {
    const users = readUsers();
    const remainingUsers = users.filter((user) => String(user.email || "").toLowerCase() !== email);
    if (remainingUsers.length === users.length) return res.status(404).json({ msg: "Customer not found" });
    const existingTransactions = readTransactions();
    const transactions = existingTransactions.filter((transaction) => String(transaction.email || "").toLowerCase() !== email);
    writeUsers(remainingUsers);
    writeTransactions(transactions);
    return res.json({ msg: "Customer deleted", deletedTransactions: existingTransactions.length - transactions.length });
  }

  try {
    const userResult = await User.deleteOne({ email });
    if (!userResult.deletedCount) return res.status(404).json({ msg: "Customer not found" });
    const transactionResult = await Transaction.deleteMany({ email });
    return res.json({ msg: "Customer deleted", deletedTransactions: transactionResult.deletedCount || 0 });
  } catch (error) {
    return res.status(500).json({ msg: "Unable to delete customer" });
  }
});

router.post("/email", async (req, res) => {
  const subject = String(req.body?.subject || "").trim();
  const message = String(req.body?.message || "").trim();
  if (!subject || !message) return res.status(400).json({ msg: "Subject and message are required" });
  try {
    const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
    if (attachments.length > 5 || attachments.some((item) => !/^image\/(png|jpeg|gif|webp)$/.test(String(item.contentType || "")) || !String(item.content || "").match(/^[A-Za-z0-9+/]+=*$/) || Buffer.byteLength(String(item.content), "base64") > 5 * 1024 * 1024)) {
      return res.status(400).json({ msg: "Attachments must be up to five PNG, JPG, GIF, or WebP images under 5 MB each" });
    }
    let recipients = Array.isArray(req.body?.recipients) ? req.body.recipients : [];
    if (req.body?.allCustomers) {
      recipients = isFallback(req)
        ? readUsers().map((user) => user.email)
        : (await User.find({}, { email: 1 }).lean()).map((user) => user.email);
    }
    const result = await sendCustomerEmail({ recipients, subject, message, attachments });
    return res.json({ msg: `Email sent to ${result.sent} customer${result.sent === 1 ? "" : "s"}.`, ...result });
  } catch (error) {
    const message = error.message || "Unable to send customer email";
    const status = /verified recipient|Resend requires|testing email|verified domain/i.test(message) ? 400 : 502;
    return res.status(status).json({ msg: message });
  }
});

router.post("/bulk/purchase", async (req, res) => {
  const mode = String(req.body?.mode || "").toLowerCase();
  const network = String(req.body?.network || "").toLowerCase();
  const planId = String(req.body?.planId || "");
  const numbers = [...new Set((Array.isArray(req.body?.numbers) ? req.body.numbers : [])
    .map((value) => String(value).replace(/[\s-]/g, "")).filter((value) => /^0\d{9}$/.test(value)))];
  if (!["free", "paystack"].includes(mode) || !network || !planId || !numbers.length) {
    return res.status(400).json({ msg: "Choose a bundle, valid phone numbers, and a purchase method" });
  }

  try {
    const plans = await getPlans(network, { allProviders: true, ignoreProviderSelection: true });
    const plan = plans.find((item) => String(item.id) === planId);
    if (!plan || plan.available === false || plan.purchasable === false) {
      return res.status(409).json({ msg: "The selected bundle is no longer available" });
    }
    const total = Number((Number(plan.sellingPrice || 0) * numbers.length).toFixed(2));
    if (!total) return res.status(400).json({ msg: "The selected bundle has no valid price" });

    if (mode === "paystack") {
      const reference = String(req.body?.reference || "");
      if (!reference || !process.env.PAYSTACK_SECRET_KEY) return res.status(400).json({ msg: "Paystack payment reference is required" });
      const payment = await axios.get(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } });
      const data = payment.data?.data || {};
      if (payment.data?.status !== true || data.status !== "success" || Number(data.amount || 0) / 100 < total) {
        return res.status(400).json({ msg: "Paystack payment could not be verified for this bulk order" });
      }
    }

    const results = [];
    for (const phone of numbers) {
      const requestId = `WIMPS_BULK_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const result = await placeProviderOrder(plan.provider, {
        plan_id: plan.id, phone, network: plan.network, volumeGb: plan.volumeGb,
        operatorId: plan.operatorId, providerAmount: plan.price || plan.cost || plan.total,
        request_id: requestId, quantity: 1
      });
      const status = String(result?.data?.status || result?.data?.delivery_status || result?.status || "pending").toLowerCase();
      const transaction = {
        _id: crypto.randomUUID(), email: "admin@admin.admin", type: "purchase", bundle: plan.name || plan.volume,
        network: plan.network, provider: plan.provider, amount: Number(plan.sellingPrice || 0), providerCost: Number(plan.price || plan.cost || 0),
        expectedProfit: Number((Number(plan.sellingPrice || 0) - Number(plan.price || plan.cost || 0)).toFixed(2)), phone,
        paymentMethod: mode === "paystack" ? "paystack" : "admin_free", reference: req.body.reference || requestId,
        providerRequestId: result?.request_id || result?.data?.request_id || requestId,
        status: ["completed", "delivered", "success", "sent"].includes(status) ? "completed" : "pending", date: new Date()
      };
      if (isFallback(req)) {
        const transactions = readTransactions();
        transactions.push(transaction);
        writeTransactions(transactions);
      } else {
        await Transaction.create(transaction);
      }
      results.push({ phone, status: transaction.status });
    }
    return res.json({ msg: `${results.length} bulk bundle${results.length === 1 ? "" : "s"} submitted.`, total, results });
  } catch (error) {
    return res.status(502).json({ msg: error.response?.data?.message || error.message || "Bulk delivery failed" });
  }
});

router.get("/settings", async (req, res) => {
  try {
    const records = await AdminSetting.find().lean();
    const settings = Object.fromEntries(records.map((record) => [record.key, record.value]));
    return res.json({ settings: { handlingFees: { mtn: 1, telecel: 1, airteltigo: 1 }, referralReward: 0.1, autoProvider: true, ...settings } });
  } catch (error) {
    return res.status(500).json({ msg: "Unable to load admin settings" });
  }
});

router.put("/settings", async (req, res) => {
  try {
    const updates = {};
    for (const [key, schema] of Object.entries(SETTING_SCHEMA)) {
      if (req.body?.[key] === undefined) continue;
      const value = schema.coerce(req.body[key]);
      if (!schema.validate(value)) return res.status(400).json({ msg: `Invalid setting: ${key}` });
      await AdminSetting.findOneAndUpdate({ key }, { key, value, updatedAt: new Date() }, { upsert: true, new: true });
      if (key === "handlingFees") reseller.configurePricingRules({ handlingFees: value });
      updates[key] = value;
    }
    return res.json({ settings: updates });
  } catch (error) {
    return res.status(500).json({ msg: "Unable to save admin settings" });
  }
});

router.post("/bulk/validate", async (req, res) => {
  try {
    const numbers = Array.isArray(req.body?.numbers) ? req.body.numbers : [];
    const normalized = numbers.map((value) => String(value || "").trim()).filter(Boolean);
    const seen = new Set();
    const valid = [];
    const duplicates = [];
    const invalid = [];
    normalized.forEach((phone) => {
      const compact = phone.replace(/[\s-]/g, "");
      const canonical = compact.startsWith("+233") ? `0${compact.slice(4)}` : compact.startsWith("233") ? `0${compact.slice(3)}` : compact;
      if (seen.has(canonical)) return duplicates.push(phone);
      seen.add(canonical);
      if (!/^0\d{9}$/.test(canonical)) return invalid.push(phone);
      valid.push(canonical);
    });
    return res.json({ valid, duplicates, invalid, counts: { valid: valid.length, duplicates: duplicates.length, invalid: invalid.length } });
  } catch (error) {
    return res.status(400).json({ msg: "Unable to validate bulk numbers" });
  }
});

router.get("/providers", async (req, res) => {
  const providers = [
    { id: "resellerxpress", name: "Reseller", configured: reseller.isConfigured(), balance: null },
    { id: "remadata", name: "RemaData", configured: remadata.isConfigured(), balance: null },
    { id: "datamart", name: "DataMart GH", configured: datamart.isConfigured(), balance: null }
  ];
  const services = { resellerxpress: reseller, remadata: remadata, datamart };
  await Promise.all(providers.map(async (provider) => {
    if (!provider.configured) return;
    const result = await fetchProviderBalance(provider.id, services[provider.id]);
    if (result.amount !== undefined) provider.balance = result.amount;
    else provider.error = result.error;
  }));
  return res.json({ providers });
});

router.get("/checkers/products", async (req, res) => {
  try {
    const result = await datamart.getCheckerProducts();
    return res.json(result);
  } catch (error) {
    return res.status(503).json({ msg: error.message || "Unable to load DataMart checker products" });
  }
});

router.get("/datamart/withdrawals/limits", async (req, res) => {
  try {
    return res.json(await datamart.getWithdrawalLimits());
  } catch (error) {
    return res.status(503).json({ msg: error.message || "Unable to load DataMart withdrawal limits" });
  }
});

router.get("/datamart/withdrawals", async (req, res) => {
  try {
    return res.json(await datamart.listWithdrawals(req.query));
  } catch (error) {
    return res.status(503).json({ msg: error.message || "Unable to load DataMart withdrawals" });
  }
});

router.get("/datamart/withdrawals/:reference", async (req, res) => {
  try {
    return res.json(await datamart.getWithdrawal(req.params.reference));
  } catch (error) {
    return res.status(503).json({ msg: error.message || "Unable to load DataMart withdrawal" });
  }
});

router.post("/datamart/withdrawals", async (req, res) => {
  try {
    return res.json(await datamart.createWithdrawal({ ...req.body, idempotencyKey: req.get("X-Idempotency-Key") }));
  } catch (error) {
    return res.status(400).json({ msg: error.message || "Unable to create DataMart withdrawal" });
  }
});

router.get("/balances", async (req, res) => {
  const balances = { paystack: null, resellerxpress: null, remadata: null, datamart: null };
  if (process.env.PAYSTACK_SECRET_KEY) {
    try {
      const axios = require("axios");
      const result = await axios.get("https://api.paystack.co/balance", {
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
        timeout: 10000
      });
      const account = Array.isArray(result.data?.data) ? result.data.data[0] : null;
      balances.paystack = account ? { amount: Number(account.balance || 0) / 100, currency: account.currency || "GHS" } : null;
    } catch (error) {
      balances.paystack = { error: error.response?.data?.message || "Paystack balance unavailable" };
    }
  }
  const providerServices = [
    { id: "resellerxpress", service: reseller },
    { id: "remadata", service: remadata },
    { id: "datamart", service: datamart }
  ].filter((provider) => provider.service.isConfigured());
  const providerResults = await Promise.all(
    providerServices.map((provider) => fetchProviderBalance(provider.id, provider.service))
  );
  providerResults.forEach((provider) => { balances[provider.id] = provider; });
  return res.json({ balances });
});

router.post("/data-retention/purge", async (req, res) => {
  const confirmation = String(req.body?.confirmation || "").trim();
  if (confirmation !== "DELETE ALL DATA") {
    return res.status(400).json({ msg: "Type DELETE ALL DATA to confirm this action" });
  }

  const notice = "Account and transaction history were deleted. Run this cleanup weekly to keep the database small.";
  try {
    let deletedUsers = 0;
    let deletedTransactions = 0;

    if (isFallback(req)) {
      deletedUsers = readUsers().length;
      deletedTransactions = readTransactions().length;
      writeUsers([]);
      writeTransactions([]);
      writeData("admin-settings.json", [{ key: "lastDataPurge", value: { notice, at: new Date().toISOString() } }]);
    } else {
      const [usersResult, transactionsResult] = await Promise.all([
        User.deleteMany({}),
        Transaction.deleteMany({})
      ]);
      deletedUsers = usersResult.deletedCount || 0;
      deletedTransactions = transactionsResult.deletedCount || 0;
      await AdminSetting.findOneAndUpdate(
        { key: "lastDataPurge" },
        { key: "lastDataPurge", value: { notice, at: new Date() }, updatedAt: new Date() },
        { upsert: true }
      );
    }

    return res.json({ msg: notice, deletedUsers, deletedTransactions });
  } catch (error) {
    console.error("DATA PURGE ERROR:", error.message);
    return res.status(500).json({ msg: "Unable to delete account and transaction data" });
  }
});

router.get("/comparison", async (req, res) => {
  try {
    const data = await reseller.getPlans(req.query.network, { allProviders: true, ignoreProviderSelection: true });
    return res.json({
      data,
      configuredProviders: {
        resellerxpress: reseller.isConfigured(),
        remadata: remadata.isConfigured(),
        datamart: datamart.isConfigured()
      },
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    return res.status(500).json({
      msg: "Unable to load provider comparison",
      configuredProviders: {
        resellerxpress: reseller.isConfigured(),
        remadata: remadata.isConfigured(),
        datamart: datamart.isConfigured()
      }
    });
  }
});

module.exports = router;
