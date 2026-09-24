const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const wimpRouter = require('../routes/wimp');
const adminWimpRouter = require('../routes/adminWimp');
const { ensureWallet, getWallet, awardCompletedPurchase, getLedger, spendWallet, adjustWallet } = require('../services/wimp');
const { readWallets, writeWallets, readLedger, writeLedger, readSettings, writeSettings } = require('../utils/wimpStore');
const { runAutoCompleteSweep } = require('../services/autoComplete');
const { readUsers, writeUsers, readTransactions, writeTransactions } = require('../utils/localStore');

const dataDir = path.join(__dirname, '..', 'data');
const files = ['wimp-wallets.json', 'wimp-ledger.json', 'wimp-settings.json', 'users.json'];
const originals = Object.fromEntries(files.map((name) => {
  const file = path.join(dataDir, name);
  return [name, fs.existsSync(file) ? fs.readFileSync(file) : null];
}));

function fallbackRequest() {
  return { app: { locals: { dbReady: false } } };
}

function restoreFiles() {
  fs.mkdirSync(dataDir, { recursive: true });
  for (const name of files) {
    const file = path.join(dataDir, name);
    if (originals[name] === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, originals[name]);
  }
}

test.afterEach(restoreFiles);

test('creates a zero-balance wallet and awards a completed purchase once', async () => {
  const req = fallbackRequest();
  const userId = `wimp-test-${Date.now()}`;
  const wallet = await ensureWallet(req, userId);
  assert.equal(wallet.balanceUnits, 0);
  const first = await awardCompletedPurchase(req, { userId, referenceId: 'purchase-1', description: 'Completed test purchase' });
  const duplicate = await awardCompletedPurchase(req, { userId, referenceId: 'purchase-1', description: 'Repeated callback' });
  assert.equal(first.awarded, true);
  assert.equal(duplicate.awarded, false);
  assert.equal((await getWallet(req, userId)).balanceUnits, 10);
  assert.equal((await getLedger(req, userId)).length, 1);
});

test('repairs a missing wallet from the latest ledger balance', async () => {
  const req = fallbackRequest();
  const userId = `wimp-repair-${Date.now()}`;
  writeLedger([{ id: 'ledger-repair-1', userId, walletId: 'wallet-repair-1', type: 'earn', amountUnits: 450, balanceBeforeUnits: 0, balanceAfterUnits: 450, referenceId: 'purchase-repair-1', description: 'Repair test', createdAt: new Date().toISOString() }]);
  assert.equal((await getWallet(req, userId)).balanceUnits, 450);
});

test('spending is idempotent and cannot make the wallet negative', async () => {
  const req = fallbackRequest();
  const userId = `wimp-spend-${Date.now()}`;
  await awardCompletedPurchase(req, { userId, referenceId: 'purchase-2', description: 'Completed test purchase' });
  const first = await spendWallet(req, { userId, amountUnits: 5, referenceId: 'redeem-1', description: 'Test discount', idempotencyKey: 'redeem-key-1' });
  const duplicate = await spendWallet(req, { userId, amountUnits: 5, referenceId: 'redeem-1', description: 'Repeated redemption', idempotencyKey: 'redeem-key-1' });
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  await assert.rejects(() => spendWallet(req, { userId, amountUnits: 6, referenceId: 'redeem-2', description: 'Too large', idempotencyKey: 'redeem-key-2' }), /Insufficient WIMP/);
  assert.equal((await getWallet(req, userId)).balanceUnits, 5);
});

test('debit adjustments reject negative balances', async () => {
  const req = fallbackRequest();
  const userId = `wimp-adjust-${Date.now()}`;
  await assert.rejects(() => adjustWallet(req, { userId, amountUnits: 1, type: 'admin_adjustment', description: 'Invalid debit', createdBy: 'admin', idempotencyKey: 'adjust-1', debit: true }), /Insufficient WIMP/);
});

test('user WIMP route rejects missing authentication', async () => {
  const app = express();
  app.locals.dbReady = false;
  app.use(express.json());
  app.use('/api/wimp', wimpRouter);
  const server = await new Promise((resolve) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/wimp/wallet`);
    assert.equal(response.status, 401);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('admin WIMP route rejects missing admin authentication', async () => {
  const previous = process.env.ADMIN_API_TOKEN;
  process.env.ADMIN_API_TOKEN = 'wimp-admin-test-token-0123456789';
  const app = express();
  app.locals.dbReady = false;
  app.use(express.json());
  app.use('/api/admin/wimp', adminWimpRouter);
  const server = await new Promise((resolve) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/wimp/settings`);
    assert.equal(response.status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.ADMIN_API_TOKEN;
    else process.env.ADMIN_API_TOKEN = previous;
  }
});

test('admin completion awards WIMP exactly once', async () => {
  const userId = `wimp-complete-${Date.now()}`;
  writeUsers([{ id: userId, email: 'complete@example.com', fullname: 'Complete Test' }]);
  writeTransactions([{ _id: 'purchase-complete-1', email: 'complete@example.com', type: 'purchase', status: 'pending', bundle: '1GB test', reference: 'purchase-complete-1' }]);
  const previous = process.env.ADMIN_API_TOKEN;
  process.env.ADMIN_API_TOKEN = 'wimp-admin-test-token-0123456789';
  const app = express();
  app.locals.dbReady = false;
  app.use(express.json());
  app.use('/api/admin', require('../routes/admin'));
  const server = await new Promise((resolve) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/admin/orders/purchase-complete-1/status`;
    const headers = { 'X-Admin-Token': process.env.ADMIN_API_TOKEN, 'Content-Type': 'application/json' };
    assert.equal((await fetch(url, { method: 'PATCH', headers, body: JSON.stringify({ status: 'completed' }) })).status, 200);
    assert.equal((await fetch(url, { method: 'PATCH', headers, body: JSON.stringify({ status: 'completed' }) })).status, 200);
    assert.equal(readLedger().filter((entry) => entry.type === 'earn' && entry.referenceId === 'purchase-complete-1').length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.ADMIN_API_TOKEN;
    else process.env.ADMIN_API_TOKEN = previous;
  }
});

test('auto-complete sweep completes old pending purchases and awards once', async () => {
  const userId = `wimp-auto-${Date.now()}`;
  writeUsers([{ id: userId, email: 'auto@example.com', fullname: 'Auto Test' }]);
  writeTransactions([{ _id: 'purchase-auto-1', email: 'auto@example.com', type: 'purchase', status: 'pending', bundle: '1GB test', reference: 'purchase-auto-1', date: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString() }]);
  writeSettings([{ key: 'autoCompleteEnabled', value: true }, { key: 'autoCompleteHours', value: 5 }]);
  const result = await runAutoCompleteSweep({ locals: { dbReady: false } });
  assert.equal(result.completed, 1);
  assert.equal(readTransactions()[0].status, 'completed');
  assert.equal(readLedger().filter((entry) => entry.type === 'earn').length, 1);
});
