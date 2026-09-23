const mongoose = require("mongoose");

const TransactionSchema = new mongoose.Schema({
  email: String,
  type: String, // deposit | purchase
  bundle: String,
  network: String,
  provider: String,
  amount: Number,
  paymentAmount: Number,
  referralDiscount: Number,
  providerCost: Number,
  providerFee: Number,
  smsFee: Number,
  paymentFee: Number,
  expectedProfit: Number,
  actualProfit: Number,
  phone: String,
  status: {
    type: String,
    default: "completed"
  },
  paymentMethod: String, // wallet | paystack
  reference: String,
  providerRequestId: String,
  date: {
    type: Date,
    default: Date.now
  },
  deliveredAt: {
    type: Date,
    default: null
  }
});

module.exports = mongoose.model("Transaction", TransactionSchema);