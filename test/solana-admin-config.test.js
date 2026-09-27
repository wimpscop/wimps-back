const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const adminSolanaRouter = require('../routes/adminSolana');

const ADMIN_TOKEN = 'solana-admin-token-1234567890';

function createApp() {
  const app = express();
  app.locals.dbReady = true;
  app.use(express.json());
  app.use('/api/admin/solana', adminSolanaRouter);
  return app;
}

async function withAdminServer(run) {
  const previousToken = process.env.ADMIN_API_TOKEN;
  process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;
  const app = createApp();
  let server;
  server = await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/admin/solana`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previousToken === undefined) delete process.env.ADMIN_API_TOKEN;
    else process.env.ADMIN_API_TOKEN = previousToken;
  }
}

test('admin Solana config route returns a disabled default configuration', async () => {
  await withAdminServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/config`, {
      headers: { 'X-Admin-Token': ADMIN_TOKEN }
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.config.approved, true);
    assert.equal(body.config.mainnetEnabled, false);
    assert.equal(body.config.emergencyPause, true);
  });
});

test('admin Solana feature-flag updates are captured as a guarded approval flow', async () => {
  await withAdminServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/feature-flags`, {
      method: 'PUT',
      headers: { 'X-Admin-Token': ADMIN_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        WIMP_WALLET_CONNECTION: true,
        WIMP_BALANCE_DISPLAY: true,
        reason: 'approved-wallet-display-test'
      })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.flags.WIMP_WALLET_CONNECTION, true);
    assert.equal(body.flags.WIMP_BALANCE_DISPLAY, true);
    assert.equal(body.audit.length >= 1, true);
  });
});
