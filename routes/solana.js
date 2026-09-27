const express = require('express');
const { requireUser } = require('../utils/auth');
const SolanaWalletConnection = require('../models/SolanaWalletConnection');
const {
  FEATURE_FLAGS,
  SOLANA_DEFAULT_CONFIG,
  normalizeSolanaConfig,
  validateSolanaConfig,
  createWalletNonce,
  verifyWalletNonce,
  isFeatureEnabled
} = require('../services/solana');

const router = express.Router();

function getRuntimeConfig() {
  const resolved = {
    ...SOLANA_DEFAULT_CONFIG,
    cluster: process.env.SOLANA_CLUSTER || SOLANA_DEFAULT_CONFIG.cluster,
    network: process.env.SOLANA_NETWORK || SOLANA_DEFAULT_CONFIG.network,
    rpcUrl: process.env.SOLANA_RPC_URL || SOLANA_DEFAULT_CONFIG.rpcUrl,
    wsUrl: process.env.SOLANA_WS_URL || SOLANA_DEFAULT_CONFIG.wsUrl,
    indexerUrl: process.env.SOLANA_INDEXER_URL || SOLANA_DEFAULT_CONFIG.indexerUrl,
    explorerUrl: process.env.SOLANA_EXPLORER_URL || SOLANA_DEFAULT_CONFIG.explorerUrl,
    mintAddress: process.env.SOLANA_WIMP_MINT_ADDRESS || SOLANA_DEFAULT_CONFIG.mintAddress,
    tokenProgram: process.env.SOLANA_WIMP_TOKEN_PROGRAM || SOLANA_DEFAULT_CONFIG.tokenProgram,
    tokenSymbol: process.env.SOLANA_WIMP_SYMBOL || SOLANA_DEFAULT_CONFIG.tokenSymbol,
    tokenDecimals: Number(process.env.SOLANA_WIMP_DECIMALS || SOLANA_DEFAULT_CONFIG.tokenDecimals),
    tokenMetadataUri: process.env.SOLANA_WIMP_METADATA_URI || SOLANA_DEFAULT_CONFIG.tokenMetadataUri,
    approved: String(process.env.SOLANA_WIMP_APPROVED || '').toLowerCase() === 'true',
    mainnetEnabled: String(process.env.SOLANA_WIMP_MAINNET || '').toLowerCase() === 'true',
    testnetEnabled: String(process.env.SOLANA_WIMP_TESTNET || 'true').toLowerCase() !== 'false',
    publicTradingEnabled: String(process.env.SOLANA_WIMP_PUBLIC_TRADING || '').toLowerCase() === 'true',
    emergencyPause: String(process.env.SOLANA_WIMP_EMERGENCY_PAUSE || 'true').toLowerCase() !== 'false',
    featureFlags: {
      [FEATURE_FLAGS.WIMP_WALLET_CONNECTION]: String(process.env.WIMP_WALLET_CONNECTION || 'false').toLowerCase() === 'true',
      [FEATURE_FLAGS.WIMP_BALANCE_DISPLAY]: String(process.env.WIMP_BALANCE_DISPLAY || 'false').toLowerCase() === 'true',
      [FEATURE_FLAGS.WIMP_TRANSACTION_HISTORY]: String(process.env.WIMP_TRANSACTION_HISTORY || 'false').toLowerCase() === 'true',
      [FEATURE_FLAGS.WIMP_SEND]: String(process.env.WIMP_SEND || 'false').toLowerCase() === 'true',
      [FEATURE_FLAGS.WIMP_RECEIVE]: String(process.env.WIMP_RECEIVE || 'false').toLowerCase() === 'true',
      [FEATURE_FLAGS.WIMP_UTILITY_PAYMENTS]: String(process.env.WIMP_UTILITY_PAYMENTS || 'false').toLowerCase() === 'true',
      [FEATURE_FLAGS.WIMP_POINTS_CONVERSION]: String(process.env.WIMP_POINTS_CONVERSION || 'false').toLowerCase() === 'true',
      [FEATURE_FLAGS.WIMP_PRICE_DISPLAY]: String(process.env.WIMP_PRICE_DISPLAY || 'false').toLowerCase() === 'true',
      [FEATURE_FLAGS.WIMP_LIQUIDITY_DISPLAY]: String(process.env.WIMP_LIQUIDITY_DISPLAY || 'false').toLowerCase() === 'true',
      [FEATURE_FLAGS.WIMP_BUY]: String(process.env.WIMP_BUY || 'false').toLowerCase() === 'true',
      [FEATURE_FLAGS.WIMP_SELL]: String(process.env.WIMP_SELL || 'false').toLowerCase() === 'true',
      [FEATURE_FLAGS.WIMP_CASHOUT]: String(process.env.WIMP_CASHOUT || 'false').toLowerCase() === 'true',
      [FEATURE_FLAGS.WIMP_MAINNET]: String(process.env.WIMP_MAINNET || 'false').toLowerCase() === 'true',
      [FEATURE_FLAGS.WIMP_TESTNET]: String(process.env.WIMP_TESTNET || 'true').toLowerCase() !== 'false',
      [FEATURE_FLAGS.WIMP_PUBLIC_TRADING]: String(process.env.WIMP_PUBLIC_TRADING || 'false').toLowerCase() === 'true',
      [FEATURE_FLAGS.WIMP_EMERGENCY_PAUSE]: String(process.env.WIMP_EMERGENCY_PAUSE || 'true').toLowerCase() !== 'false'
    }
  };
  return normalizeSolanaConfig(resolved);
}

router.get('/config', (req, res) => {
  try {
    const config = getRuntimeConfig();
    return res.json({ ok: true, config: validateSolanaConfig(config) });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message || 'Invalid Solana configuration' });
  }
});

router.use(requireUser);

router.post('/wallet/nonce', (req, res) => {
  try {
    const data = createWalletNonce({ userId: req.user.sub });
    return res.json({ ok: true, data });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'Unable to create nonce' });
  }
});

router.post('/wallet/connect', async (req, res) => {
  try {
    const featureState = isFeatureEnabled(FEATURE_FLAGS.WIMP_WALLET_CONNECTION, { featureFlags: getRuntimeConfig().featureFlags });
    if (!featureState.enabled) {
      return res.status(403).json({ ok: false, error: 'Solana wallet connection is disabled by feature flag' });
    }

    const { publicKey, cluster, network } = req.body || {};
    if (typeof publicKey !== 'string' || publicKey.length < 20) {
      return res.status(400).json({ ok: false, error: 'A valid Solana publicKey is required' });
    }

    const config = getRuntimeConfig();
    const record = await SolanaWalletConnection.findOneAndUpdate(
      { userId: req.user.sub },
      {
        userId: req.user.sub,
        publicKey: publicKey.trim(),
        cluster: cluster || config.cluster || 'devnet',
        network: network || config.network || 'solana-devnet',
        status: 'verified',
        nonce: '',
        verifiedAt: new Date(),
        updatedAt: new Date()
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.json({
      ok: true,
      connected: true,
      wallet: {
        publicKey: record.publicKey,
        cluster: record.cluster,
        network: record.network,
        status: record.status,
        connectedAt: record.createdAt,
        verifiedAt: record.verifiedAt
      }
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'Unable to connect wallet' });
  }
});

router.post('/wallet/verify', async (req, res) => {
  try {
    const featureState = isFeatureEnabled(FEATURE_FLAGS.WIMP_WALLET_CONNECTION, { featureFlags: getRuntimeConfig().featureFlags });
    if (!featureState.enabled) {
      return res.status(403).json({ ok: false, error: 'Solana wallet connection is disabled by feature flag' });
    }

    const { nonce, publicKey, signature } = req.body || {};
    if (!nonce || !publicKey || !signature) {
      return res.status(400).json({ ok: false, error: 'Nonce, publicKey, and signature are required' });
    }

    const validNonce = verifyWalletNonce({
      userId: req.user.sub,
      nonce,
      expectedNonce: nonce,
      now: new Date()
    });

    if (!validNonce || typeof publicKey !== 'string' || publicKey.length < 20 || typeof signature !== 'string' || signature.length < 20) {
      return res.status(400).json({ ok: false, error: 'Wallet verification failed' });
    }

    const config = getRuntimeConfig();
    const record = await SolanaWalletConnection.findOneAndUpdate(
      { userId: req.user.sub },
      {
        userId: req.user.sub,
        publicKey: publicKey.trim(),
        cluster: config.cluster || 'devnet',
        network: config.network || 'solana-devnet',
        status: 'verified',
        nonce: String(nonce),
        verifiedAt: new Date(),
        updatedAt: new Date()
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.json({
      ok: true,
      validNonce: true,
      publicKey: record.publicKey,
      signature: signature.slice(0, 12),
      wallet: {
        publicKey: record.publicKey,
        cluster: record.cluster,
        network: record.network,
        status: record.status,
        verifiedAt: record.verifiedAt
      }
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'Unable to verify wallet' });
  }
});

router.post('/wallet/disconnect', async (req, res) => {
  try {
    const featureState = isFeatureEnabled(FEATURE_FLAGS.WIMP_WALLET_CONNECTION, { featureFlags: getRuntimeConfig().featureFlags });
    if (!featureState.enabled) {
      return res.status(403).json({ ok: false, error: 'Solana wallet connection is disabled by feature flag' });
    }

    const record = await SolanaWalletConnection.findOneAndUpdate(
      { userId: req.user.sub },
      { status: 'revoked', revokedAt: new Date(), updatedAt: new Date() },
      { new: true }
    );

    return res.json({
      ok: true,
      disconnected: true,
      wallet: record ? {
        publicKey: record.publicKey,
        status: record.status,
        revokedAt: record.revokedAt
      } : null
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'Unable to disconnect wallet' });
  }
});

router.get('/feature-flags', (req, res) => {
  const config = getRuntimeConfig();
  const flags = Object.fromEntries(Object.keys(config.featureFlags).map((name) => [name, Boolean(config.featureFlags[name])]));
  return res.json({ ok: true, flags });
});

router.get('/wallet/status', async (req, res) => {
  try {
    const record = await SolanaWalletConnection.findOne({ userId: req.user.sub }).sort({ createdAt: -1 }).lean();
    const connected = Boolean(record && record.publicKey && record.status === 'verified');
    return res.json({
      ok: true,
      connected,
      wallet: record && connected ? {
        publicKey: record.publicKey,
        cluster: record.cluster,
        network: record.network,
        status: record.status,
        connectedAt: record.createdAt,
        verifiedAt: record.verifiedAt
      } : null,
      featureFlags: Object.fromEntries(Object.keys(getRuntimeConfig().featureFlags).map((name) => [name, Boolean(getRuntimeConfig().featureFlags[name])]))
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Unable to load wallet status' });
  }
});

module.exports = router;
