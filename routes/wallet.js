const express = require("express");
const router = express.Router();
const axios = require("axios");

const User = require("../models/user");
const Transaction = require("../models/Transaction");
const { placeProviderOrder, getPlans, getFallbackPlans } = require("../services/resellerxpress");
const { createId, isFallback, readUsers, writeUsers, readTransactions, writeTransactions } = require("../utils/localStore");
const { requireUser } = require("../utils/auth");
const { normalizePhone, validatePhone } = require("../utils/phoneValidation");
const { sendSms } = require("../services/sendcomms");
const { awardCompletedPurchase, calculateDiscount, spendWallet, adjustWallet, toUnits } = require("../services/wimp");

router.use(requireUser);

async function verifyPaystackReference(reference) {
  if (!process.env.PAYSTACK_SECRET_KEY) {
    return { verified: false, msg: "PAYSTACK_SECRET_KEY is not configured" };
  }

  try {
    const verifyRes = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
        }
      }
    );

    const paymentData = verifyRes.data?.data || {};
    const isVerified = paymentData.status === "success" && verifyRes.data?.status === true;

    if (!isVerified) {
      return {
        verified: false,
        msg: paymentData.status || verifyRes.data?.message || "Payment not verified"
      };
    }

    return {
      verified: true,
      paymentData
    };
  } catch (err) {
    return {
      verified: false,
      msg: err.response?.data?.message || err.message || "Payment verification failed"
    };
  }
}

async function refundPaystackReference(reference) {
  if (!reference || !process.env.PAYSTACK_SECRET_KEY) return false;

  try {
    await axios.post(
      "https://api.paystack.co/refund",
      { transaction: reference },
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );
    return true;
  } catch (error) {
    console.error("PAYSTACK REFUND ERROR:", error.response?.data || error.message);
    return false;
  }
}

function validatePayment(paymentData, expectedAmount, maximumAmount = expectedAmount) {
  const expected = Number(expectedAmount);
  const maximum = Number(maximumAmount);
  const paidAmount = Number(paymentData?.amount || 0) / 100;
  const currency = String(paymentData?.currency || "").toUpperCase();

  if (!Number.isFinite(expected) || expected <= 0) return "Invalid expected payment amount";
  if (!Number.isFinite(paidAmount) || paidAmount <= 0) return "Invalid payment amount";
  if (currency && currency !== "GHS") return "Payment currency mismatch";

  const expectedCents = Math.round(expected * 100);
  const paidCents = Math.round(paidAmount * 100);
  const maximumCents = Math.round(maximum * 100);
  if (paidCents < expectedCents - 1 || paidCents > maximumCents + 1) return "Amount mismatch";
  return null;
}

function getVerifiedPaymentAmount(paymentData) {
  const paidAmount = Number(paymentData?.amount || 0) / 100;
  const currency = String(paymentData?.currency || "").toUpperCase();
  if (!Number.isFinite(paidAmount) || paidAmount <= 0) return { error: "Invalid payment amount" };
  if (currency && currency !== "GHS") return { error: "Payment currency mismatch" };
  return { amount: Number(paidAmount.toFixed(2)) };
}

function formatBundleLabel(plan) {
  const volumeGb = Number(plan?.volumeGb);
  if (!Number.isFinite(volumeGb) || volumeGb <= 0) return plan?.name || "Data bundle";
  const volume = volumeGb < 1 ? `${Math.round(volumeGb * 1024)}MB` : `${Number.isInteger(volumeGb) ? volumeGb : volumeGb.toFixed(2)}GB`;
  return `${volume} ${plan.network || ""}`.trim();
}

// ==========================
// GET WALLET BALANCE
// ==========================
router.get("/:email", async (req, res) => {
  try {
    if (req.params.email.toLowerCase() !== req.user.email.toLowerCase()) {
      return res.status(403).json({ msg: "You can only access your own wallet" });
    }

    if (isFallback(req)) {
      const user = readUsers().find((item) => item.email.toLowerCase() === req.params.email.toLowerCase());
      if (!user) return res.status(404).json({ msg: "User not found" });
      return res.json({ balance: user.balance || 0 });
    }

    const user = await User.findOne({ email: req.params.email });

    if (!user) {
      return res.status(404).json({ msg: "User not found" });
    }

    res.json({ balance: user.balance || 0 });

  } catch (err) {
    console.error("GET WALLET ERROR:", err.message);
    res.status(500).json({ msg: "Server error" });
  }
});


// ==========================
// PAYSTACK DEPOSIT (SECURE)
// ==========================
router.post("/deposit", async (req, res) => {
  try {
    const { amount, reference } = req.body;
    const email = req.user.email;

    console.log("DEPOSIT REQUEST:", req.body);

    if (!email || !amount || !reference) {
      return res.status(400).json({ msg: "Missing fields" });
    }

    const verification = await verifyPaystackReference(reference);

    console.log("PAYSTACK RESPONSE:", verification);

    if (!verification.verified) {
      return res.status(400).json({ msg: verification.msg || "Payment not verified" });
    }

    const paymentData = verification.paymentData;

    const paymentError = validatePayment(paymentData, amount);
    if (paymentError) return res.status(400).json({ msg: paymentError });

    if (isFallback(req)) {
      const users = readUsers();
      const user = users.find((item) => item.email.toLowerCase() === String(email).toLowerCase());
      if (!user) return res.status(404).json({ msg: "User not found" });

      const transactions = readTransactions();
      const existing = transactions.find((item) => item.reference === reference);
      if (existing) return res.json({ msg: "Deposit already processed", balance: user.balance || 0 });

      const paidAmount = Number(paymentData.amount) / 100;
      user.balance = Number(user.balance || 0) + paidAmount;
      transactions.push({
        _id: createId(), email, type: "deposit", amount: paidAmount,
        paymentMethod: "paystack", reference, status: "completed", date: new Date().toISOString(), deliveredAt: new Date().toISOString()
      });
      writeUsers(users);
      writeTransactions(transactions);
      return res.json({ msg: "Deposit successful", balance: user.balance });
    }

    // ✅ PREVENT DOUBLE CREDIT
    const existing = await Transaction.findOne({ reference });
    if (existing) {
      if (existing.email === email && existing.type === "deposit" && existing.status === "completed") {
        const currentUser = await User.findOne({ email });
        return res.json({ msg: "Deposit already processed", balance: currentUser?.balance || 0 });
      }
      return res.status(409).json({ msg: "Payment reference already used" });
    }

    // ✅ FIND USER
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ msg: "User not found" });
    }

    // ✅ CONVERT KOBO → GHS
    const paidAmount = Number(paymentData.amount) / 100;

    // ✅ CREDIT WALLET
    user.balance += paidAmount;
    await user.save();

    // ✅ SAVE TRANSACTION
    await Transaction.create({
      email,
      type: "deposit",
      amount: paidAmount,
      paymentMethod: "paystack",
      reference,
      status: "completed",
      date: new Date(),
      deliveredAt: new Date()
    });

    res.json({
      msg: "Deposit successful",
      balance: user.balance
    });

  } catch (err) {
    console.error("DEPOSIT ERROR:", err.response?.data || err.message);
    res.status(500).json({ msg: "Deposit failed" });
  }
});


// ==========================
// BUY / DEDUCT WALLET
// ==========================
router.post("/buy", async (req, res) => {
  try {
    const incoming = req.body || {};
    const { amount, bundle, phone, reference } = incoming;
    const email = req.user.email;

    const phoneError = validatePhone(phone, incoming.network || incoming.networkType);
    if (phoneError) return res.status(400).json({ msg: phoneError });
    incoming.phone = normalizePhone(phone);

    if (isFallback(req)) {
      const users = readUsers();
      const user = users.find((item) => item.email.toLowerCase() === String(email || "").toLowerCase());
      if (!user) return res.status(404).json({ msg: "User not found" });

      const plansResponse = isFallback(req)
        ? getFallbackPlans(incoming.network || incoming.networkType)
        : await getPlans(incoming.network || incoming.networkType);
      const plans = Array.isArray(plansResponse) ? plansResponse : (plansResponse?.data || []);
      const plan = plans.find((item) => String(item.id) === String(incoming.plan_id ?? incoming.planId));
      if (!plan) return res.status(409).json({ msg: "Selected bundle is no longer available" });

      const sellingPrice = Number(plan.sellingPrice || (Number(plan.cost || plan.total || 0) + 1));
      const quantity = Math.max(Number(incoming.quantity || 1), 1);
      const grossAmount = sellingPrice * quantity;
      const referralDiscount = Math.min(Number(user.referralCredits || 0), grossAmount);
      const requestedWimpUnits = Number.isInteger(Number(incoming.wimpUnits)) ? Number(incoming.wimpUnits) : toUnits(incoming.wimpAmount);
      const wimpDiscountUnits = await calculateDiscount(req, { userId: user.id, requestedUnits: requestedWimpUnits, maximumUnits: toUnits(Math.max(0, grossAmount - referralDiscount)) });
      const wimpDiscount = wimpDiscountUnits / 100;
      const requiredAmount = Number((grossAmount - referralDiscount - wimpDiscount).toFixed(2));
      if (!requiredAmount) return res.status(400).json({ msg: "Invalid bundle amount" });
      let chargedAmount = requiredAmount;
      let appliedReferralDiscount = referralDiscount;

      if (reference) {
        const verification = await verifyPaystackReference(reference);
        if (!verification.verified) return res.status(400).json({ msg: verification.msg || "Payment verification failed" });
        const paid = getVerifiedPaymentAmount(verification.paymentData);
        if (paid.error) return res.status(400).json({ msg: paid.error });
        chargedAmount = paid.amount;
        appliedReferralDiscount = referralDiscount;
        const duplicate = readTransactions().find((item) => item.reference === reference);
        if (duplicate) return res.json({ msg: "Payment already processed", balance: user.balance || 0, data: duplicate });
      } else {
        if (Number(user.balance || 0) < requiredAmount) return res.status(400).json({ msg: "Insufficient balance" });
        user.balance = Number(user.balance || 0) - requiredAmount;
      }

      const transaction = {
        _id: createId(), email, type: "purchase", network: plan.network, provider: plan.provider,
        amount: requiredAmount, paymentAmount: reference ? chargedAmount : undefined, referralDiscount: appliedReferralDiscount, wimpDiscount, bundle: bundle || formatBundleLabel(plan),
        phone, paymentMethod: reference ? "paystack" : "wallet",
        status: reference ? "pending" : "completed", reference: reference || createId(),
        date: new Date().toISOString()
      };
      const transactions = readTransactions();
      if (wimpDiscountUnits > 0) await spendWallet(req, { userId: user.id, amountUnits: wimpDiscountUnits, referenceId: transaction.reference, description: `WIMP discount for ${transaction.bundle}`, idempotencyKey: `wimp-spend:${transaction.reference}` });
      transactions.push(transaction);
      user.referralCredits = Number((Number(user.referralCredits || 0) - appliedReferralDiscount).toFixed(2));
      writeUsers(users);
      writeTransactions(transactions);
      return res.json({
        msg: reference ? "Payment verified; bundle processing" : "Bundle purchase successful",
        balance: user.balance || 0,
        data: transaction
      });
    }

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ msg: "User not found" });

    const hasResellerPayload = Boolean(
      incoming.plan_id !== undefined ||
      incoming.planId !== undefined ||
      incoming.request_id !== undefined ||
      incoming.requestId !== undefined ||
      incoming.quantity !== undefined
    );

    if (hasResellerPayload) {
      const planId = incoming.plan_id ?? incoming.planId;
      const phone = incoming.phone ?? incoming.phoneNumber;
      const requestId = incoming.request_id ?? incoming.requestId ?? `WIMPS_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const quantity = Number(incoming.quantity ?? 1);

      if (!planId || !phone) {
        return res.status(400).json({
          msg: "Invalid ResellerXpress payload. Required: plan_id and phone"
        });
      }

      const plansResponse = await getPlans(incoming.network || incoming.networkType || incoming.network_name || incoming.providerNetwork);
      const plans = Array.isArray(plansResponse) ? plansResponse : (plansResponse?.data || []);
      const plan = plans.find((item) => String(item.id) === String(planId));

      if (!plan) {
        return res.status(409).json({ msg: "Selected bundle is no longer available" });
      }

      if (plan.provider === "resellerxpress" && !/^\d+$/.test(String(plan.id))) {
        return res.status(503).json({
          msg: "Live bundle plans are temporarily unavailable. Please try again later."
        });
      }

      if (plan.purchasable === false) {
        return res.status(503).json({
          msg: "Live bundle plans are temporarily unavailable. Please try again later."
        });
      }

      const safeQuantity = Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
      const grossAmount = Number(plan.sellingPrice || 0) * safeQuantity;
      const providerCost = Number(plan.cost || plan.total || 0) * safeQuantity;
      const referralDiscount = Math.min(Number(user.referralCredits || 0), Math.max(0, grossAmount - providerCost));
      const requestedWimpUnits = Number.isInteger(Number(incoming.wimpUnits)) ? Number(incoming.wimpUnits) : toUnits(incoming.wimpAmount);
      const wimpDiscountUnits = await calculateDiscount(req, { userId: String(user._id), requestedUnits: requestedWimpUnits, maximumUnits: toUnits(Math.max(0, grossAmount - referralDiscount - providerCost)) });
      const wimpDiscount = wimpDiscountUnits / 100;
      const requiredAmount = Number((grossAmount - referralDiscount - wimpDiscount).toFixed(2));
      const providerFee = Number(plan.fee || 0) * safeQuantity;
      const smsFee = Number(plan.smsFee || 0) * safeQuantity;
      const expectedProfit = Number(plan.expectedProfit || 0) * safeQuantity;

      if (!requiredAmount || plan.available === false || requiredAmount < providerCost) {
        return res.status(400).json({
          msg: "No valid amount could be derived for this ResellerXpress plan"
        });
      }

      let chargedAmount = requiredAmount;
      let appliedReferralDiscount = referralDiscount;

      if (reference) {
        const verification = await verifyPaystackReference(reference);

        if (!verification.verified) {
          return res.status(400).json({ msg: verification.msg || "Payment verification failed" });
        }

        const paid = getVerifiedPaymentAmount(verification.paymentData);
        if (paid.error) return res.status(400).json({ msg: paid.error });
        chargedAmount = paid.amount;
        appliedReferralDiscount = referralDiscount;
        if (chargedAmount + 0.01 < requiredAmount) {
          const failedTransaction = await Transaction.create({
            email, type: "purchase", network: plan.network, provider: plan.provider,
            amount: requiredAmount, paymentAmount: chargedAmount, providerCost, referralDiscount: 0, providerFee, smsFee,
            expectedProfit: 0, bundle: bundle || formatBundleLabel(plan), phone,
            paymentMethod: "paystack", status: "failed", reference, providerRequestId: requestId
          });
          const refunded = await refundPaystackReference(reference);
          return res.status(502).json({
            msg: refunded ? "Payment was below the bundle price and has been refunded." : "Payment was below the bundle price; support must complete the refund.",
            data: failedTransaction
          });
        }

        const existing = await Transaction.findOne({ reference });
        if (existing) {
          if (existing.status === "completed") {
            return res.json({ msg: "Payment already processed", balance: user.balance || 0, data: existing });
          }
          return res.status(409).json({ msg: "Payment is already being processed" });
        }
      } else {
        if (user.balance < requiredAmount) {
          return res.status(400).json({ msg: "Insufficient balance" });
        }

        user.balance -= requiredAmount;
        await user.save();
      }

      const tx = await Transaction.create({
        email,
        type: "purchase",
        network: plan.network,
        provider: plan.provider,
        amount: requiredAmount,
        paymentAmount: reference ? chargedAmount : undefined,
        wimpDiscount,
        providerCost: Number(plan.price || providerCost),
        referralDiscount: appliedReferralDiscount,
        providerFee,
        smsFee,
        expectedProfit,
        bundle: bundle || formatBundleLabel(plan),
        phone,
        paymentMethod: reference ? "paystack" : "wallet",
        status: "pending",
        reference: reference || requestId,
        providerRequestId: requestId
      });

      try {
        if (wimpDiscountUnits > 0) await spendWallet(req, { userId: String(user._id), amountUnits: wimpDiscountUnits, referenceId: String(reference || requestId), description: `WIMP discount for ${bundle || formatBundleLabel(plan)}`, idempotencyKey: `wimp-spend:${reference || requestId}` });
        let providerPlan = plan;
        let result;
        try {
          result = await placeProviderOrder(providerPlan.provider, {
            plan_id: providerPlan.id,
            phone,
            network: providerPlan.network,
            volumeGb: providerPlan.volumeGb || providerPlan.volume,
            operatorId: providerPlan.operatorId,
            providerAmount: providerPlan.price || providerPlan.cost || providerPlan.total,
            request_id: requestId,
            quantity
          });
        } catch (firstProviderError) {
          const alternatives = await getPlans(providerPlan.network, { allProviders: true, ignoreProviderSelection: true });
          const targetVolume = Number(providerPlan.volumeGb);
          const alternative = alternatives.find((candidate) => candidate.provider !== providerPlan.provider
            && Math.abs(Number(candidate.volumeGb) - targetVolume) < 0.001
            && candidate.available !== false
            && candidate.purchasable !== false);

          if (!alternative) throw firstProviderError;

          providerPlan = alternative;
          result = await placeProviderOrder(providerPlan.provider, {
            plan_id: providerPlan.id,
            phone,
            network: providerPlan.network,
            volumeGb: providerPlan.volumeGb || providerPlan.volume,
            operatorId: providerPlan.operatorId,
            providerAmount: providerPlan.price || providerPlan.cost || providerPlan.total,
            request_id: requestId,
            quantity
          });
          tx.providerCost = Number(providerPlan.price || providerPlan.cost || providerPlan.total || providerCost);
          tx.providerFee = Number(providerPlan.fee || providerFee);
          tx.smsFee = Number(providerPlan.smsFee || smsFee);
          tx.expectedProfit = Number(providerPlan.expectedProfit || expectedProfit);
          tx.network = providerPlan.network;
          tx.provider = providerPlan.provider;
          tx.bundle = bundle || providerPlan.name || `${quantity} bundle(s)`;
        }

        const providerStatus = String(
          result?.data?.delivery_status || result?.data?.fulfillment_status ||
          result?.data?.deliveryStatus || result?.data?.order_status ||
          result?.data?.order?.status ||
          result?.delivery_status || result?.fulfillment_status ||
          result?.deliveryStatus || result?.order_status ||
          result?.data?.status || result?.status || result?.order?.status || "pending"
        ).toLowerCase();
        const confirmedDeliveryStatuses = ["completed", "delivered", "sent", "delivered_successfully"];
        tx.status = confirmedDeliveryStatuses.includes(providerStatus)
          ? "completed"
          : providerStatus === "failed" ? "failed" : "pending";
        tx.actualProfit = Number((requiredAmount - Number(tx.providerCost || providerCost) - Number(tx.providerFee || providerFee) - Number(tx.smsFee || smsFee)).toFixed(2));
        if (tx.status === "completed") tx.deliveredAt = new Date();
        // Keep the Paystack reference stable so a callback retry cannot deliver twice.
        if (!reference) tx.reference = result?.order?.request_id || requestId;
        tx.providerRequestId = result?.order?.request_id || result?.data?.request_id || result?.request_id || requestId;
        await tx.save();

        if (tx.status === "failed") {
          if (wimpDiscountUnits > 0) await adjustWallet(req, { userId: String(user._id), amountUnits: wimpDiscountUnits, type: "refund", referenceId: String(reference || requestId), description: `WIMP discount refund for failed purchase ${tx.bundle}`, createdBy: "system", idempotencyKey: `wimp-refund:${reference || requestId}` });
          const refunded = reference ? await refundPaystackReference(reference) : true;
          return res.status(502).json({
            msg: reference
              ? refunded
                ? "Bundle delivery failed. Your Paystack payment has been refunded."
                : "Bundle delivery failed. The refund could not be completed automatically; support will review it."
              : "Bundle delivery failed",
            data: tx
          });
        }

        if (tx.status === "completed") {
          try {
            await awardCompletedPurchase(req, {
              userId: req.user.sub,
              referenceId: String(tx._id || tx.reference),
              description: `Reward for completed purchase ${tx.bundle || tx.reference}`
            });
          } catch (rewardError) {
            console.error("WIMP REWARD ERROR:", rewardError.message);
          }
        }

        if (appliedReferralDiscount > 0 && tx.status !== "failed") {
          user.referralCredits = Number(Math.max(0, Number(user.referralCredits || 0) - appliedReferralDiscount).toFixed(2));
          await user.save();
        }

        let smsSent = false;
        if (tx.status === "completed") {
          try {
            const validityDays = Number(process.env.BUNDLE_VALIDITY_DAYS || 90);
            const volume = Number(providerPlan.volumeGb || providerPlan.volume || 0);
            const message = `WIMPS: Your account has been credited with ${volume ? `${volume}GB` : "your data bundle"} for ${phone}. It is valid for ${validityDays} days. Thank you.`;
            await sendSms({ phone, message });
            smsSent = true;
          } catch (smsError) {
            console.error("PURCHASE SMS ERROR:", smsError.response?.data || smsError.message);
          }
        }

        return res.json({
          msg: tx.status === "completed"
            ? "Bundle delivery confirmed by the provider"
            : tx.status === "failed"
              ? "The provider could not deliver this bundle"
              : "Payment accepted; your bundle is being delivered",
          balance: user.balance || 0,
          smsSent,
          data: result
        });
      } catch (apiErr) {
        console.error("RESELLERXPRESS ERROR:", apiErr.response?.data || apiErr.message);

        tx.status = reference ? "refunded" : "failed";
        tx.actualProfit = 0;
        if (wimpDiscountUnits > 0) {
          try { await adjustWallet(req, { userId: String(user._id), amountUnits: wimpDiscountUnits, type: "refund", referenceId: String(reference || requestId), description: `WIMP discount refund for failed purchase ${tx.bundle}`, createdBy: "system", idempotencyKey: `wimp-refund:${reference || requestId}` }); }
          catch (wimpError) { console.error("WIMP DISCOUNT REFUND ERROR:", wimpError.message); }
        }
        const refunded = reference ? await refundPaystackReference(reference) : true;
        await tx.save();

        if (!reference) {
          user.balance += requiredAmount;
          user.referralCredits = Number((Number(user.referralCredits || 0) - referralDiscount).toFixed(2));
          user.referralCredits = Number((Number(user.referralCredits || 0) + referralDiscount).toFixed(2));
          await user.save();
        }

        return res.status(502).json({
          msg: reference
            ? refunded
              ? "Bundle delivery failed. Your Paystack payment has been refunded."
              : "Bundle delivery failed. The refund could not be completed automatically; support will review it."
            : apiErr.response?.data?.message || apiErr.message || "Bundle delivery failed and your wallet was refunded"
        });
      }
    }

    return res.status(400).json({
      msg: "A provider plan is required. Use plan_id, phone, and network for bundle purchases."
    });

  } catch (err) {
    console.error("BUY ERROR:", err.message);
    res.status(500).json({ msg: "Server error" });
  }
});
module.exports = router;