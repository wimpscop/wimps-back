const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const auth = require('../utils/auth');

const {
  validateSolanaConfig,
  SOLANA_DEFAULT_CONFIG,
  normalizeSolanaConfig,
  createWalletNonce,
  verifyWalletNonce,
  isFeatureEnabled,
  FEATURE_FLAGS
} = require('../services/solana');

test('validates approved Solana config and keeps mainnet disabled by default', () => {
  const valid = normalizeSolanaConfig({
    cluster: 'devnet',
    network: 'solana-devnet',
    rpcUrl: 'https://api.devnet.solana.com',
    mintAddress: 'So11111111111111111111111111111111111111112',
    tokenSymbol: 'WIMP',
    tokenDecimals: 9,
    tokenProgram: 'spl-token',
    approved: true,
    mainnetEnabled: false,
    publicTradingEnabled: false,
    emergencyPause: false
  });

  assert.doesNotThrow(() => validateSolanaConfig(valid));
  assert.equal(valid.mintAddress, 'So11111111111111111111111111111111111111112');
  assert.equal(valid.mainnetEnabled, false);

  const invalid = { ...valid, mintAddress: 'not-a-valid-address' };
  assert.throws(() => validateSolanaConfig(invalid), /mint address/i);

  const mainnetWithoutApproval = { ...valid, cluster: 'mainnet', network: 'solana-mainnet', approved: false, mainnetEnabled: true };
  assert.throws(() => validateSolanaConfig(mainnetWithoutApproval), /approved/i);
});

test('wallet nonce creation, verification, and expiry checks work as expected', () => {
  const nonce = createWalletNonce({ userId: 'user-1' });
  assert.ok(nonce.nonce);
  assert.ok(nonce.expiresAt);
  assert.equal(typeof nonce.userId, 'string');

  const verified = verifyWalletNonce({
    userId: 'user-1',
    nonce: nonce.nonce,
    expectedNonce: nonce.nonce,
    now: new Date(Date.now() + 1000)
  });
  assert.equal(verified, true);

  const expired = verifyWalletNonce({
    userId: 'user-1',
    nonce: nonce.nonce,
    expectedNonce: nonce.nonce,
    now: new Date(nonce.expiresAt.getTime() + 1000)
  });
  assert.equal(expired, false);
});

test('feature flags separate rewards points from blockchain functionality', () => {
  const featureState = isFeatureEnabled(FEATURE_FLAGS.WIMP_WALLET_CONNECTION, {
    userRole: 'customer',
    country: 'GH',
    pointsEnabled: true,
    tokenEnabled: false
  });

  assert.equal(featureState.enabled, false);
  assert.equal(featureState.reason, 'disabled');

  assert.equal(SOLANA_DEFAULT_CONFIG.mintAddress, 'UNAPPROVED');
  assert.equal(SOLANA_DEFAULT_CONFIG.featureFlags.WIMP_MAINNET, false);
  assert.equal(SOLANA_DEFAULT_CONFIG.featureFlags.WIMP_POINTS_CONVERSION, false);
});

test('Solana wallet connection endpoints remain gated until the wallet feature flag is enabled', async () => {
  const previousFlag = process.env.WIMP_WALLET_CONNECTION;
  process.env.WIMP_WALLET_CONNECTION = 'false';

  const previousRequireUser = auth.requireUser;
  auth.requireUser = (req, res, next) => {
    req.user = { sub: 'wallet-user-1', email: 'wallet@example.com' };
    next();
  };

  delete require.cache[require.resolve('../routes/solana')];
  const solanaRouter = require('../routes/solana');

  const app = express();
  app.locals.dbReady = false;
  app.use(express.json());
  app.use('/api/solana', solanaRouter);
  let server;
  server = await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve(server));
  });

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/solana/wallet/connect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ publicKey: '3kA5A3xL4Hc2pJ6kqC1mA2zT7Yx9nQk4X8pN5Q2rHfB', cluster: 'devnet', network: 'solana-devnet' })
    });

    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.match(body.error || body.msg || '', /disabled|feature/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    auth.requireUser = previousRequireUser;
    if (previousFlag === undefined) delete process.env.WIMP_WALLET_CONNECTION;
    else process.env.WIMP_WALLET_CONNECTION = previousFlag;
    delete require.cache[require.resolve('../routes/solana')];
  }
});
