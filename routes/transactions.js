const express = require("express");
const router = express.Router();
const Transaction = require("../models/Transaction");
const { requireUser } = require("../utils/auth");
const { getOrderStatus } = require("../services/resellerxpress");

router.use(requireUser);

// ===== GET USER TRANSACTIONS =====
router.get("/:email", async (req, res) => {
  try {
    if (req.params.email.toLowerCase() !== req.user.email.toLowerCase()) {
      return res.status(403).json({ msg: "You can only access your own transactions" });
    }
    const txs = await Transaction.find({ email: req.params.email });
    await Promise.all(txs.filter((tx) => tx.type === "purchase" && tx.status === "pending" && tx.provider === "resellerxpress" && tx.providerRequestId).map(async (tx) => {
      try {
        const result = await getOrderStatus(tx.providerRequestId);
        const status = String(result?.data?.delivery_status || result?.data?.fulfillment_status || result?.data?.status || result?.status || result?.order?.status || "pending").toLowerCase();
        if (["completed", "delivered", "sent", "delivered_successfully", "success", "successful"].includes(status)) {
          tx.status = "completed";
          tx.deliveredAt = tx.deliveredAt || new Date();
          await tx.save();
        } else if (["failed", "cancelled", "canceled"].includes(status)) {
          tx.status = "failed";
          await tx.save();
        }
      } catch (error) {
        console.warn("TRANSACTION STATUS SYNC ERROR:", error.message);
      }
    }));
    txs.sort((a, b) => new Date(b.date || b.createdAt || 0) - new Date(a.date || a.createdAt || 0));

    res.json(txs);
  } catch (err) {
    console.error("GET TX ERROR:", err.message);
    res.status(500).json({ msg: "Failed to load transactions" });
  }
});

// ===== CREATE TRANSACTION =====
router.post("/", async (req, res) => {
  try {
    const tx = new Transaction(req.body);
    await tx.save();

    res.json({ msg: "Transaction saved", tx });
  } catch (err) {
    console.error("SAVE TX ERROR:", err.message);
    res.status(500).json({ msg: "Failed to save transaction" });
  }
});

module.exports = router;