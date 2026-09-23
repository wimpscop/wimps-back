require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../models/user");
const WimpWallet = require("../models/WimpWallet");
const { readUsers } = require("../utils/localStore");
const { readWallets, writeWallets } = require("../utils/wimpStore");

async function run() {
  const rollback = process.argv.includes("--rollback");
  if (process.env.MONGODB_URI) {
    await mongoose.connect(process.env.MONGODB_URI);
    if (rollback) {
      const result = await WimpWallet.deleteMany({});
      console.log(`Removed ${result.deletedCount || 0} WIMP wallets.`);
    } else {
      const users = await User.find({}, { _id: 1 }).lean();
      const operations = users.map((user) => ({ updateOne: { filter: { userId: String(user._id) }, update: { $setOnInsert: { userId: String(user._id), balanceUnits: 0, version: 0, createdAt: new Date() }, $set: { updatedAt: new Date() } }, upsert: true } }));
      if (operations.length) await WimpWallet.bulkWrite(operations, { ordered: false });
      console.log(`Ensured ${users.length} WIMP wallets.`);
    }
    await mongoose.disconnect();
    return;
  }

  const wallets = readWallets();
  if (rollback) {
    writeWallets([]);
    console.log(`Removed ${wallets.length} fallback WIMP wallets.`);
    return;
  }
  const existing = new Set(wallets.map((wallet) => String(wallet.userId)));
  for (const user of readUsers()) {
    if (existing.has(String(user.id))) continue;
    wallets.push({ id: require("crypto").randomUUID(), userId: String(user.id), balanceUnits: 0, version: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  }
  writeWallets(wallets);
  console.log(`Ensured ${wallets.length} fallback WIMP wallets.`);
}

run().catch((error) => { console.error(error.message); process.exitCode = 1; });
