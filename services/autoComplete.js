const Transaction = require("../models/Transaction");
const { isFallback, readUsers, readTransactions, writeTransactions } = require("../utils/localStore");
const { getSettings, awardCompletedPurchase } = require("./wimp");

async function runAutoCompleteSweep(app) {
  const req = { app };
  const settings = await getSettings(req);
  if (settings.autoCompleteEnabled === false) return { enabled: false, completed: 0 };
  const hours = Math.max(1, Number(settings.autoCompleteHours) || 5);
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  let completed = 0;

  if (isFallback(req)) {
    const transactions = readTransactions();
    const users = readUsers();
    for (const transaction of transactions) {
      if (transaction.type !== "purchase" || transaction.status !== "pending" || new Date(transaction.date || 0).getTime() > cutoff) continue;
      transaction.status = "completed";
      transaction.deliveredAt = new Date().toISOString();
      const user = users.find((item) => String(item.email || "").toLowerCase() === String(transaction.email || "").toLowerCase());
      if (user) await awardCompletedPurchase(req, { userId: String(user.id), referenceId: String(transaction._id || transaction.reference), description: `Automatic reward for completed purchase ${transaction.bundle || transaction.reference}` });
      completed += 1;
    }
    if (completed) writeTransactions(transactions);
    return { enabled: true, completed };
  }

  const pending = await Transaction.find({ type: "purchase", status: "pending", date: { $lte: new Date(cutoff) } }).limit(200).lean();
  for (const transaction of pending) {
    const claimed = await Transaction.findOneAndUpdate(
      { _id: transaction._id, status: "pending" },
      { $set: { status: "completed", deliveredAt: new Date() } },
      { new: true }
    ).lean();
    if (!claimed) continue;
    const user = await require("../models/user").findOne({ email: claimed.email }).lean();
    if (user) await awardCompletedPurchase(req, { userId: String(user._id), referenceId: String(claimed._id || claimed.reference), description: `Automatic reward for completed purchase ${claimed.bundle || claimed.reference}` });
    completed += 1;
  }
  return { enabled: true, completed };
}

function startAutoCompleteJob(app) {
  const run = () => runAutoCompleteSweep(app).catch((error) => console.error("AUTO COMPLETE ERROR:", error.message));
  run();
  return setInterval(run, 5 * 60 * 1000);
}

module.exports = { runAutoCompleteSweep, startAutoCompleteJob };