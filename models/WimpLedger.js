const mongoose = require("mongoose");

const WimpLedgerSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  walletId: { type: String, required: true },
  type: {
    type: String,
    enum: ["earn", "spend", "refund", "expiry", "admin_adjustment"],
    required: true
  },
  amountUnits: { type: Number, required: true, min: 1 },
  balanceBeforeUnits: { type: Number, required: true, min: 0 },
  balanceAfterUnits: { type: Number, required: true, min: 0 },
  referenceId: { type: String, default: "", index: true },
  description: { type: String, required: true, maxlength: 500 },
  createdBy: { type: String, default: "" },
  idempotencyKey: { type: String, default: "", unique: true, sparse: true, index: true },
  createdAt: { type: Date, default: Date.now }
});

WimpLedgerSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("WimpLedger", WimpLedgerSchema);
