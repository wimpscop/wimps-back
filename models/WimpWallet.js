const mongoose = require("mongoose");

const WimpWalletSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true, index: true },
  balanceUnits: { type: Number, required: true, min: 0, default: 0 },
  version: { type: Number, required: true, min: 0, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("WimpWallet", WimpWalletSchema);
