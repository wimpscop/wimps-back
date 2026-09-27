const crypto = require('crypto');

const FEATURE_FLAGS = Object.freeze({
  WIMP_WALLET_CONNECTION: 'WIMP_WALLET_CONNECTION',
  WIMP_BALANCE_DISPLAY: 'WIMP_BALANCE_DISPLAY',
  WIMP_TRANSACTION_HISTORY: 'WIMP_TRANSACTION_HISTORY',
  WIMP_SEND: 'WIMP_SEND',
  WIMP_RECEIVE: 'WIMP_RECEIVE',
  WIMP_UTILITY_PAYMENTS: 'WIMP_UTILITY_PAYMENTS',
  WIMP_POINTS_CONVERSION: 'WIMP_POINTS_CONVERSION',
  WIMP_PRICE_DISPLAY: 'WIMP_PRICE_DISPLAY',
  WIMP_LIQUIDITY_DISPLAY: 'WIMP_LIQUIDITY_DISPLAY',
  WIMP_BUY: 'WIMP_BUY',
  WIMP_SELL: 'WIMP_SELL',
  WIMP_CASHOUT: 'WIMP_CASHOUT',
  WIMP_MAINNET: 'WIMP_MAINNET',
  WIMP_TESTNET: 'WIMP_TESTNET',
  WIMP_PUBLIC_TRADING: 'WIMP_PUBLIC_TRADING',
  WIMP_EMERGENCY_PAUSE: 'WIMP_EMERGENCY_PAUSE'
});

const SOLANA_DEFAULT_CONFIG = Object.freeze({
  cluster: 'devnet',
  network: 'solana-devnet',
  rpcUrl: 'https://api.devnet.solana.com',
  wsUrl: '',
  indexerUrl: '',
  explorerUrl: 'https://explorer.solana.com',
  mintAddress: 'UNAPPROVED',
  tokenProgram: 'spl-token',
  tokenSymbol: 'WIMP',
  tokenDecimals: 9,
  tokenMetadataUri: '',
  expectedTotalSupply: '0',
  mintAuthorityStatus: 'unknown',
  freezeAuthorityStatus: 'unknown',
  metadataMutability: 'mutable',
  approved: true,
  mainnetEnabled: false,
  testnetEnabled: true,
  publicTradingEnabled: false,
  emergencyPause: true,
  featureFlags: {
    [FEATURE_FLAGS.WIMP_WALLET_CONNECTION]: true,
    [FEATURE_FLAGS.WIMP_BALANCE_DISPLAY]: true,
    [FEATURE_FLAGS.WIMP_TRANSACTION_HISTORY]: true,
    [FEATURE_FLAGS.WIMP_SEND]: true,
    [FEATURE_FLAGS.WIMP_RECEIVE]: true,
    [FEATURE_FLAGS.WIMP_UTILITY_PAYMENTS]: false,
    [FEATURE_FLAGS.WIMP_POINTS_CONVERSION]: false,
    [FEATURE_FLAGS.WIMP_PRICE_DISPLAY]: true,
    [FEATURE_FLAGS.WIMP_LIQUIDITY_DISPLAY]: true,
    [FEATURE_FLAGS.WIMP_BUY]: false,
    [FEATURE_FLAGS.WIMP_SELL]: false,
    [FEATURE_FLAGS.WIMP_CASHOUT]: false,
    [FEATURE_FLAGS.WIMP_MAINNET]: false,
    [FEATURE_FLAGS.WIMP_TESTNET]: true,
    [FEATURE_FLAGS.WIMP_PUBLIC_TRADING]: false,
    [FEATURE_FLAGS.WIMP_EMERGENCY_PAUSE]: true
  }
});

function normalizeSolanaConfig(input = {}) {
  const merged = {
    ...SOLANA_DEFAULT_CONFIG,
    ...input,
    featureFlags: {
      ...SOLANA_DEFAULT_CONFIG.featureFlags,
      ...(input.featureFlags || {})
    }
  };

  if (!merged.cluster) merged.cluster = SOLANA_DEFAULT_CONFIG.cluster;
  if (!merged.network) merged.network = merged.cluster === 'mainnet' ? 'solana-mainnet' : 'solana-devnet';
  if (!merged.tokenProgram) merged.tokenProgram = 'spl-token';
  if (!merged.tokenSymbol) merged.tokenSymbol = 'WIMP';
  if (!merged.tokenDecimals && merged.tokenDecimals !== 0) merged.tokenDecimals = 9;
  if (!merged.mintAddress) merged.mintAddress = 'UNAPPROVED';

  return merged;
}

function isValidSolanaMintAddress(value) {
  if (!value || typeof value !== 'string') return false;
  const trimmed = value.trim();
  const standard = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  if (standard.test(trimmed)) return true;
  return trimmed === 'So11111111111111111111111111111111111111112';
}

function validateSolanaConfig(config) {
  const normalized = normalizeSolanaConfig(config);

  if (!normalized.cluster || !['devnet', 'testnet', 'mainnet'].includes(normalized.cluster)) {
    throw new Error('Invalid Solana cluster');
  }

  if (normalized.cluster === 'mainnet' && (!normalized.approved || normalized.mainnetEnabled !== true)) {
    throw new Error('The WIMP mint must be manually approved before mainnet activation');
  }

  if (!isValidSolanaMintAddress(normalized.mintAddress) || normalized.mintAddress === 'UNAPPROVED') {
    throw new Error('Invalid WIMP mint address');
  }

  if (normalized.tokenDecimals !== 9) {
    throw new Error('Token decimals do not match the approved WIMP configuration');
  }

  if (normalized.tokenProgram !== 'spl-token' && normalized.tokenProgram !== 'token-2022') {
    throw new Error('Unsupported Solana token program');
  }

  if (normalized.publicTradingEnabled && !normalized.approved) {
    throw new Error('Trading venue must be approved before activation');
  }

  if (normalized.emergencyPause) {
    normalized.featureFlags[FEATURE_FLAGS.WIMP_EMERGENCY_PAUSE] = true;
  }

  return normalized;
}

function createWalletNonce({ userId, ttlMs = 10 * 60 * 1000 } = {}) {
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + ttlMs);
  const nonceValue = `${expiresAt.getTime()}:${crypto.randomBytes(16).toString('hex')}`;
  return {
    userId: String(userId || 'anonymous'),
    nonce: nonceValue,
    createdAt,
    expiresAt
  };
}

function verifyWalletNonce({ userId, nonce, expectedNonce, now = new Date() } = {}) {
  if (!userId || !nonce || !expectedNonce) return false;
  if (String(nonce) !== String(expectedNonce)) return false;
  if (String(userId).length === 0) return false;

  const target = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(target.getTime())) return false;

  const expiresAtText = String(expectedNonce).split(':')[0];
  const expiresAtMs = Number(expiresAtText);
  if (!Number.isFinite(expiresAtMs)) return false;

  return target.getTime() < expiresAtMs;
}

function isFeatureEnabled(featureName, context = {}) {
  const flags = { ...SOLANA_DEFAULT_CONFIG.featureFlags, ...(context.featureFlags || {}) };
  const enabled = Boolean(flags[featureName]);

  if (!enabled) {
    return { enabled: false, reason: 'disabled', featureName, value: flags[featureName] || false };
  }

  return { enabled: true, reason: 'enabled', featureName, value: flags[featureName] };
}

module.exports = {
  FEATURE_FLAGS,
  SOLANA_DEFAULT_CONFIG,
  normalizeSolanaConfig,
  validateSolanaConfig,
  createWalletNonce,
  verifyWalletNonce,
  isFeatureEnabled
};
