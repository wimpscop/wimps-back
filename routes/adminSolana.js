const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const SolanaConfig = require('../models/SolanaConfig');
const SolanaAuditLog = require('../models/SolanaAuditLog');
const { normalizeSolanaConfig, validateSolanaConfig, FEATURE_FLAGS } = require('../services/solana');

const router = express.Router();

function requireAdmin(req, res, next) {
  const expected = String(process.env.ADMIN_API_TOKEN || '');
  const supplied = String(req.get('X-Admin-Token') || '');
  if (!expected) return res.status(503).json({ msg: 'Admin API token is not configured' });
  if (!supplied || supplied.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    return res.status(401).json({ msg: 'Admin authentication required' });
  }
  req.adminId = crypto.createHash('sha256').update(supplied).digest('hex').slice(0, 16);
  next();
}

router.use(requireAdmin);

function safeConfig() {
  return normalizeSolanaConfig({
    cluster: process.env.SOLANA_CLUSTER || 'devnet',
    network: process.env.SOLANA_NETWORK || 'solana-devnet',
    rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
    wsUrl: process.env.SOLANA_WS_URL || '',
    indexerUrl: process.env.SOLANA_INDEXER_URL || '',
    explorerUrl: process.env.SOLANA_EXPLORER_URL || 'https://explorer.solana.com',
    mintAddress: process.env.SOLANA_WIMP_MINT_ADDRESS || 'UNAPPROVED',
    tokenProgram: process.env.SOLANA_WIMP_TOKEN_PROGRAM || 'spl-token',
    tokenSymbol: process.env.SOLANA_WIMP_SYMBOL || 'WIMP',
    tokenDecimals: Number(process.env.SOLANA_WIMP_DECIMALS || 9),
    tokenMetadataUri: process.env.SOLANA_WIMP_METADATA_URI || '',
    approved: String(process.env.SOLANA_WIMP_APPROVED || 'true').toLowerCase() === 'true',
    mainnetEnabled: String(process.env.SOLANA_WIMP_MAINNET || 'false').toLowerCase() === 'true',
    publicTradingEnabled: String(process.env.SOLANA_WIMP_PUBLIC_TRADING || 'false').toLowerCase() === 'true',
    emergencyPause: String(process.env.SOLANA_WIMP_EMERGENCY_PAUSE || 'true').toLowerCase() !== 'false',
    featureFlags: {
      WIMP_WALLET_CONNECTION: String(process.env.WIMP_WALLET_CONNECTION || 'true').toLowerCase() === 'true',
      WIMP_BALANCE_DISPLAY: String(process.env.WIMP_BALANCE_DISPLAY || 'true').toLowerCase() === 'true',
      WIMP_TRANSACTION_HISTORY: String(process.env.WIMP_TRANSACTION_HISTORY || 'true').toLowerCase() === 'true',
      WIMP_SEND: String(process.env.WIMP_SEND || 'true').toLowerCase() === 'true',
      WIMP_RECEIVE: String(process.env.WIMP_RECEIVE || 'true').toLowerCase() === 'true',
      WIMP_UTILITY_PAYMENTS: String(process.env.WIMP_UTILITY_PAYMENTS || 'false').toLowerCase() === 'true',
      WIMP_POINTS_CONVERSION: String(process.env.WIMP_POINTS_CONVERSION || 'false').toLowerCase() === 'true',
      WIMP_PRICE_DISPLAY: String(process.env.WIMP_PRICE_DISPLAY || 'true').toLowerCase() === 'true',
      WIMP_LIQUIDITY_DISPLAY: String(process.env.WIMP_LIQUIDITY_DISPLAY || 'true').toLowerCase() === 'true',
      WIMP_BUY: String(process.env.WIMP_BUY || 'false').toLowerCase() === 'true',
      WIMP_SELL: String(process.env.WIMP_SELL || 'false').toLowerCase() === 'true',
      WIMP_CASHOUT: String(process.env.WIMP_CASHOUT || 'false').toLowerCase() === 'true',
      WIMP_MAINNET: String(process.env.WIMP_MAINNET || 'false').toLowerCase() === 'true',
      WIMP_TESTNET: String(process.env.WIMP_TESTNET || 'true').toLowerCase() !== 'false',
      WIMP_PUBLIC_TRADING: String(process.env.WIMP_PUBLIC_TRADING || 'false').toLowerCase() === 'true',
      WIMP_EMERGENCY_PAUSE: String(process.env.WIMP_EMERGENCY_PAUSE || 'true').toLowerCase() !== 'false'
    }
  });
}

router.get('/config', async (req, res) => {
  try {
    const config = safeConfig();
    return res.json({ ok: true, config: normalizeSolanaConfig(config) });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message || 'Invalid Solana configuration' });
  }
});

router.put('/config', async (req, res) => {
  try {
    const incoming = req.body || {};
    const merged = safeConfig();
    const previous = { ...merged };
    const next = validationSafe({ ...merged, ...incoming });
    if (mongoose.connection.readyState === 1) {
      await SolanaConfig.findOneAndUpdate({ key: 'solana-config' }, { key: 'solana-config', value: next, updatedBy: req.adminId, updatedAt: new Date() }, { upsert: true, new: true });
    }
    await recordAudit({
      adminId: req.adminId,
      action: 'update-config',
      targetObject: 'solana-config',
      previousValue: previous,
      newValue: next,
      reason: String(incoming.reason || 'admin configuration update'),
      requestId: String(incoming.requestId || crypto.randomUUID()),
      result: 'success'
    });
    return res.json({ ok: true, config: next });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message || 'Unable to save Solana configuration' });
  }
});

router.put('/feature-flags', async (req, res) => {
  try {
    const incoming = req.body || {};
    const current = safeConfig();
    const nextFlags = { ...current.featureFlags };
    const desired = incoming.flags || incoming;
    for (const [key, value] of Object.entries(desired)) {
      if (key === 'reason' || key === 'requestId') continue;
      if (!(key in FEATURE_FLAGS) && !Object.values(FEATURE_FLAGS).includes(key)) {
        throw new Error(`Unsupported feature flag: ${key}`);
      }
      nextFlags[key] = Boolean(value);
    }
    const updated = validationSafe({ ...current, featureFlags: nextFlags });
    if (mongoose.connection.readyState === 1) {
      await SolanaConfig.findOneAndUpdate({ key: 'solana-config' }, { key: 'solana-config', value: updated, updatedBy: req.adminId, updatedAt: new Date() }, { upsert: true, new: true });
    }
    const audit = await recordAudit({
      adminId: req.adminId,
      action: 'update-feature-flags',
      targetObject: 'solana-feature-flags',
      previousValue: current.featureFlags,
      newValue: updated.featureFlags,
      reason: String(incoming.reason || 'admin feature flag update'),
      requestId: String(incoming.requestId || crypto.randomUUID()),
      result: 'success'
    });
    return res.json({ ok: true, flags: updated.featureFlags, audit: audit ? [audit] : [] });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message || 'Unable to update Solana feature flags' });
  }
});

router.get('/audit', async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.json({ ok: true, audit: [] });
    }
    const logs = await SolanaAuditLog.find().sort({ createdAt: -1 }).limit(50).lean();
    return res.json({ ok: true, audit: logs });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Unable to load Solana admin audit log' });
  }
});

async function recordAudit({ adminId, action, targetObject, previousValue, newValue, reason, requestId, result, errorDetails = '' }) {
  if (mongoose.connection.readyState !== 1) {
    return { adminId, action, targetObject, previousValue, newValue, reason, requestId, result, errorDetails, createdAt: new Date().toISOString() };
  }
  return SolanaAuditLog.create({
    adminId,
    action,
    targetObject,
    previousValue,
    newValue,
    reason,
    requestId,
    result,
    errorDetails,
    createdAt: new Date()
  });
}

function validationSafe(input) {
  const normalized = normalizeSolanaConfig(input);
  const preApprovalState = normalized.mintAddress === 'UNAPPROVED' || !normalized.approved || normalized.cluster !== 'mainnet';
  if (preApprovalState && normalized.cluster !== 'mainnet') {
    return normalized;
  }
  return validateSolanaConfig(normalized);
}

module.exports = router;
