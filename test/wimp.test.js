const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const axios = require('axios');
const User = require('../models/user');
const Transaction = require('../models/Transaction');
const WimpSetting = require('../models/WimpSetting');
const resellerXpress = require('../services/resellerxpress');
const walletRouter = require('../routes/wallet');
const { createAuthToken } = require('../utils/auth');
const resendService = require('../services/resend');
const resetEmails = [];
const originalResetEmailSender = resendService.sendPasswordResetEmail;
resendService.sendPasswordResetEmail = async (message) => resetEmails.push(message);
const authRouter = require('../routes/auth');
resendService.sendPasswordResetEmail = originalResetEmailSender;
const wimpRouter = require('../routes/wimp');
const adminWimpRouter = require('../routes/adminWimp');
const { ensureWallet, getWallet, awardCompletedPurchase, getLedger, spendWallet, adjustWallet } = require('../services/wimp');
const { readWallets, writeWallets, readLedger, writeLedger, readSettings, writeSettings } = require('../utils/wimpStore');
const { runAutoCompleteSweep } = require('../services/autoComplete');
const { readUsers, writeUsers, readTransactions, writeTransactions } = require('../utils/localStore');
const { writeData } = require('../utils/fileDb');

const dataDir = path.join(__dirname, '..', 'data');
const files = ['wimp-wallets.json', 'wimp-ledger.json', 'wimp-settings.json', 'users.json', 'transactions.json', 'admin-settings.json'];
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

test('wallet deposit credits the requested amount and records Paystack fees', async () => {
  const email = 'deposit-owner@example.test';
  const userId = `deposit-owner-${Date.now()}`;
  const user = { _id: userId, email, balance: 0, save: async () => {} };
  const createdTransactions = [];
  const previousAuthSecret = process.env.AUTH_TOKEN_SECRET;
  const previousPaystackSecret = process.env.PAYSTACK_SECRET_KEY;
  const originalUserExists = User.exists;
  const originalUserFindOne = User.findOne;
  const originalTransactionFindOne = Transaction.findOne;
  const originalTransactionCreate = Transaction.create;
  const originalAxiosGet = axios.get;
  process.env.AUTH_TOKEN_SECRET = 'wimp-deposit-test-secret-with-more-than-32-characters';
  process.env.PAYSTACK_SECRET_KEY = 'test-paystack-secret';
  let payerEmail = email;

  User.exists = async () => true;
  User.findOne = async () => user;
  Transaction.findOne = async ({ reference }) => createdTransactions.find((item) => item.reference === reference) || null;
  Transaction.create = async (entry) => {
    const transaction = { ...entry, _id: `deposit-${createdTransactions.length + 1}` };
    createdTransactions.push(transaction);
    return transaction;
  };
  axios.get = async () => ({ data: { status: true, data: { status: 'success', amount: 1020, fees: 20, currency: 'GHS', customer: { email: payerEmail } } } });

  const app = express();
  app.locals.dbReady = true;
  app.use(express.json());
  app.use('/api/wallet', walletRouter);
  const server = await new Promise((resolve) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  try {
    const token = createAuthToken({ _id: userId, email });
    const url = `http://127.0.0.1:${server.address().port}/api/wallet/deposit`;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ amount: 10, reference: 'deposit-rounding-reference' }) });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.creditedAmount, 10);
    assert.equal(payload.balance, 10);
    assert.equal(createdTransactions.length, 1);
    assert.equal(createdTransactions[0].amount, 10);
    assert.equal(createdTransactions[0].paymentFee, 0.2);

    const duplicate = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ amount: 10, reference: 'deposit-rounding-reference' }) });
    const duplicatePayload = await duplicate.json();
    assert.equal(duplicate.status, 200);
    assert.equal(duplicatePayload.balance, 10);
    assert.equal(createdTransactions.length, 1);

    payerEmail = 'somebody-else@example.test';
    const otherPayer = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ amount: 10, reference: 'other-payer-reference' }) });
    assert.equal(otherPayer.status, 403);
    assert.equal(user.balance, 10);
    assert.equal(createdTransactions.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    User.exists = originalUserExists;
    User.findOne = originalUserFindOne;
    Transaction.findOne = originalTransactionFindOne;
    Transaction.create = originalTransactionCreate;
    axios.get = originalAxiosGet;
    if (previousAuthSecret === undefined) delete process.env.AUTH_TOKEN_SECRET;
    else process.env.AUTH_TOKEN_SECRET = previousAuthSecret;
    if (previousPaystackSecret === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = previousPaystackSecret;
  }
});

test('uncertain provider timeout keeps a verified Paystack purchase pending without refund or retry', async () => {
  const previousAuthSecret = process.env.AUTH_TOKEN_SECRET;
  const previousPaystackSecret = process.env.PAYSTACK_SECRET_KEY;
  const originalUserExists = User.exists;
  const originalUserFindOne = User.findOne;
  const originalTransactionFindOne = Transaction.findOne;
  const originalTransactionCreate = Transaction.create;
  const originalWimpSettingFind = WimpSetting.find;
  const originalAxiosGet = axios.get;
  const originalAxiosPost = axios.post;
  const originalGetPlans = resellerXpress.getPlans;
  const originalPlaceProviderOrder = resellerXpress.placeProviderOrder;
  process.env.AUTH_TOKEN_SECRET = 'wimp-payment-test-secret-with-more-than-32-characters';
  process.env.PAYSTACK_SECRET_KEY = 'test-paystack-secret';

  const email = 'pending-provider@example.test';
  const userId = `pending-provider-${Date.now()}`;
  const user = { _id: userId, email, balance: 0, referralCredits: 0, save: async () => {} };
  let providerAttempts = 0;
  let alternativePlanLookups = 0;
  let refundAttempts = 0;
  let createdTransaction;

  User.exists = async () => true;
  User.findOne = async () => user;
  Transaction.findOne = async () => null;
  Transaction.create = async (entry) => {
    createdTransaction = { ...entry, _id: `transaction-${userId}`, save: async () => {} };
    return createdTransaction;
  };
  WimpSetting.find = () => ({ lean: async () => [] });
  axios.get = async () => ({ data: { status: true, data: { status: 'success', amount: 3500, currency: 'GHS' } } });
  axios.post = async () => { refundAttempts += 1; return { data: { status: true } }; };
  resellerXpress.getPlans = async (_network, options = {}) => {
    if (options.allProviders) alternativePlanLookups += 1;
    return [{ id: '12345', provider: 'resellerxpress', network: 'mtn', volumeGb: 5, price: 30, cost: 30, sellingPrice: 35, fee: 5, available: true, purchasable: true }];
  };
  resellerXpress.placeProviderOrder = async () => {
    providerAttempts += 1;
    const error = new Error('socket timed out after provider accepted request');
    error.code = 'ECONNABORTED';
    throw error;
  };

  const routePath = require.resolve('../routes/wallet');
  delete require.cache[routePath];
  const walletRouter = require('../routes/wallet');
  const app = express();
  app.locals.dbReady = true;
  app.use(express.json());
  app.use('/api/wallet', walletRouter);
  const server = await new Promise((resolve) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });

  try {
    const token = createAuthToken({ _id: userId, email });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/wallet/buy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, phone: '0241234567', network: 'mtn', plan_id: '12345', quantity: 1, amount: 35, wimpUnits: 0, reference: 'T-UNCERTAIN-PROVIDER' })
    });
    const payload = await response.json();
    assert.equal(response.status, 202);
    assert.equal(payload.data.status, 'pending');
    assert.match(payload.msg, /do not pay again/i);
    assert.equal(createdTransaction.status, 'pending');
    assert.equal(providerAttempts, 1);
    assert.equal(alternativePlanLookups, 0);
    assert.equal(refundAttempts, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    delete require.cache[routePath];
    User.exists = originalUserExists;
    User.findOne = originalUserFindOne;
    Transaction.findOne = originalTransactionFindOne;
    Transaction.create = originalTransactionCreate;
    WimpSetting.find = originalWimpSettingFind;
    axios.get = originalAxiosGet;
    axios.post = originalAxiosPost;
    resellerXpress.getPlans = originalGetPlans;
    resellerXpress.placeProviderOrder = originalPlaceProviderOrder;
    if (previousAuthSecret === undefined) delete process.env.AUTH_TOKEN_SECRET;
    else process.env.AUTH_TOKEN_SECRET = previousAuthSecret;
    if (previousPaystackSecret === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = previousPaystackSecret;
  }
});

test('registration with a referral code credits the referrer once', async () => {
  const referrerId = `referrer-${Date.now()}`;
  writeUsers([{ id: referrerId, email: 'referrer@example.test', password: 'old-password', balance: 0, referralCode: 'WIMPS-REFERRER', referralCount: 0, referralCredits: 0 }]);
  writeData('admin-settings.json', [{ key: 'referralReward', value: 0.25 }]);
  const previousAuthSecret = process.env.AUTH_TOKEN_SECRET;
  process.env.AUTH_TOKEN_SECRET = 'wimp-auth-test-secret-with-more-than-32-characters';
  const app = express();
  app.locals.dbReady = false;
  app.use(express.json());
  app.use('/api/auth', authRouter);
  const server = await new Promise((resolve) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullname: 'Referred Customer', email: 'new-customer@example.test', password: 'new-password', referralCode: 'wimps-referrer' })
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.ok(payload.user.authToken);
    const users = readUsers();
    const referrer = users.find((user) => user.id === referrerId);
    const referred = users.find((user) => user.email === 'new-customer@example.test');
    assert.equal(referrer.referralCount, 1);
    assert.equal(referrer.referralCredits, 0.25);
    assert.equal(referrer.balance, 0.25);
    assert.equal(referred.referredBy, 'WIMPS-REFERRER');
    assert.equal(referred.referralCredits, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previousAuthSecret === undefined) delete process.env.AUTH_TOKEN_SECRET;
    else process.env.AUTH_TOKEN_SECRET = previousAuthSecret;
  }
});

test('password reset emails a usable one-time token and accepts the new password', async () => {
  const email = 'password-reset@example.test';
  writeUsers([{ id: `password-reset-${Date.now()}`, email, password: 'old-password', balance: 0, referralCode: 'WIMPS-RESET' }]);
  resetEmails.length = 0;
  const previousFrontendUrl = process.env.FRONTEND_URL;
  const previousAuthSecret = process.env.AUTH_TOKEN_SECRET;
  process.env.FRONTEND_URL = 'https://wimps.store';
  process.env.AUTH_TOKEN_SECRET = 'wimp-auth-test-secret-with-more-than-32-characters';
  const app = express();
  app.locals.dbReady = false;
  app.use(express.json());
  app.use('/api/auth', authRouter);
  const server = await new Promise((resolve) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}/api/auth`;
    const forgotResponse = await fetch(`${baseUrl}/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    assert.equal(forgotResponse.status, 200);
    assert.equal(resetEmails.length, 1);
    const resetUrl = new URL(resetEmails[0].resetUrl);
    assert.equal(resetUrl.origin, 'https://wimps.store');
    assert.equal(resetUrl.searchParams.get('email'), email);
    const token = resetUrl.searchParams.get('reset');
    assert.ok(token);

    const resetResponse = await fetch(`${baseUrl}/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, token, password: 'replacement-password' })
    });
    assert.equal(resetResponse.status, 200);

    const loginResponse = await fetch(`${baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'replacement-password' })
    });
    assert.equal(loginResponse.status, 200);
    assert.ok((await loginResponse.json()).user.authToken);

    const replayResponse = await fetch(`${baseUrl}/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, token, password: 'another-password' })
    });
    assert.equal(replayResponse.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previousFrontendUrl === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = previousFrontendUrl;
    if (previousAuthSecret === undefined) delete process.env.AUTH_TOKEN_SECRET;
    else process.env.AUTH_TOKEN_SECRET = previousAuthSecret;
  }
});

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

test('platform token purchase and spend flow updates the app balance without exposing wallet details', async () => {
  const req = fallbackRequest();
  const userId = `wimp-platform-${Date.now()}`;
  const { purchaseToken, spendTokenForOrder, getTokenBalance } = require('../services/wimp');

  const purchase = await purchaseToken(req, {
    userId,
    amountUnits: 5000,
    source: 'card',
    referenceId: 'platform-buy-1',
    description: 'Top-up WIMP balance',
    idempotencyKey: 'platform-buy-1'
  });

  assert.equal(purchase.duplicate, false);
  assert.equal((await getTokenBalance(req, userId)).balanceUnits, 5000);

  const spend = await spendTokenForOrder(req, {
    userId,
    amountUnits: 1250,
    referenceId: 'bundle-order-1',
    description: 'Bundle purchase',
    idempotencyKey: 'bundle-order-1'
  });

  assert.equal(spend.duplicate, false);
  assert.equal((await getTokenBalance(req, userId)).balanceUnits, 3750);
  assert.equal((await getLedger(req, userId)).length, 2);
});

test('reward points and app token balance are tracked separately', async () => {
  const req = fallbackRequest();
  const userId = `wimp-separated-${Date.now()}`;
  const { purchaseToken, spendTokenForOrder, getTokenBalance, awardCompletedPurchase, getWallet } = require('../services/wimp');

  await awardCompletedPurchase(req, { userId, referenceId: 'reward-separate-1', description: 'Completed reward purchase' });
  await purchaseToken(req, {
    userId,
    amountUnits: 5000,
    source: 'card',
    referenceId: 'token-buy-separated-1',
    description: 'Token top-up',
    idempotencyKey: 'token-buy-separated-1'
  });

  const rewardBalance = await getWallet(req, userId);
  const tokenBalance = await getTokenBalance(req, userId);
  assert.equal(rewardBalance.balanceUnits, 10);
  assert.equal(tokenBalance.balanceUnits, 5000);

  await spendTokenForOrder(req, {
    userId,
    amountUnits: 1250,
    referenceId: 'token-spend-separated-1',
    description: 'Use token for app purchase',
    idempotencyKey: 'token-spend-separated-1'
  });

  assert.equal((await getTokenBalance(req, userId)).balanceUnits, 3750);
  assert.equal((await getWallet(req, userId)).balanceUnits, 10);
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

test('admin can clear one user WIMP activity without changing balances or orders', async () => {
  const userId = `wimp-clear-one-${Date.now()}`;
  const otherUserId = `wimp-clear-other-${Date.now()}`;
  writeUsers([{ id: userId, email: 'clear-one@example.com' }, { id: otherUserId, email: 'keep@example.com' }]);
  writeTransactions([{ _id: 'order-clear-one', email: 'clear-one@example.com', status: 'completed' }]);
  writeWallets([{ id: 'wallet-clear-one', userId, balanceUnits: 100, tokenBalanceUnits: 500 }, { id: 'wallet-clear-other', userId: otherUserId, balanceUnits: 200, tokenBalanceUnits: 800 }]);
  writeLedger([
    { id: 'ledger-clear-one', userId, type: 'earn', amountUnits: 100, balanceAfterUnits: 100 },
    { id: 'ledger-clear-other', userId: otherUserId, type: 'earn', amountUnits: 200, balanceAfterUnits: 200 }
  ]);
  const previous = process.env.ADMIN_API_TOKEN;
  process.env.ADMIN_API_TOKEN = 'wimp-admin-test-token-0123456789';
  const app = express();
  app.locals.dbReady = false;
  app.use(express.json());
  app.use('/api/admin/wimp', adminWimpRouter);
  const server = await new Promise((resolve) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/wimp/users/clear-one%40example.com`, {
      method: 'DELETE',
      headers: { 'X-Admin-Token': process.env.ADMIN_API_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: 'DELETE USER WIMP ACTIVITY' })
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(payload.data, { entriesDeleted: 1 });
    assert.deepEqual(readWallets(), [
      { id: 'wallet-clear-one', userId, balanceUnits: 100, tokenBalanceUnits: 500 },
      { id: 'wallet-clear-other', userId: otherUserId, balanceUnits: 200, tokenBalanceUnits: 800 }
    ]);
    assert.deepEqual(readLedger().map((entry) => entry.userId), [otherUserId]);
    assert.equal(readUsers().length, 2);
    assert.equal(readTransactions().length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.ADMIN_API_TOKEN;
    else process.env.ADMIN_API_TOKEN = previous;
  }
});

test('admin can clear all WIMP activity only with the required confirmation', async () => {
  const userId = `wimp-clear-all-${Date.now()}`;
  writeUsers([{ id: userId, email: 'clear-all@example.com' }]);
  writeTransactions([{ _id: 'order-clear-all', email: 'clear-all@example.com', status: 'completed' }]);
  writeWallets([{ id: 'wallet-clear-all', userId, balanceUnits: 100, tokenBalanceUnits: 500 }]);
  writeLedger([{ id: 'ledger-clear-all', userId, type: 'earn', amountUnits: 100, balanceAfterUnits: 100 }]);
  const previous = process.env.ADMIN_API_TOKEN;
  process.env.ADMIN_API_TOKEN = 'wimp-admin-test-token-0123456789';
  const app = express();
  app.locals.dbReady = false;
  app.use(express.json());
  app.use('/api/admin/wimp', adminWimpRouter);
  const server = await new Promise((resolve) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/admin/wimp/activity`;
    const headers = { 'X-Admin-Token': process.env.ADMIN_API_TOKEN, 'Content-Type': 'application/json' };
    assert.equal((await fetch(url, { method: 'DELETE', headers, body: JSON.stringify({ confirmation: 'DELETE ALL' }) })).status, 400);
    assert.equal(readWallets().length, 1);
    const response = await fetch(url, { method: 'DELETE', headers, body: JSON.stringify({ confirmation: 'DELETE ALL WIMP ACTIVITY' }) });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(payload.data, { entriesDeleted: 1 });
    assert.deepEqual(readWallets(), [{ id: 'wallet-clear-all', userId, balanceUnits: 100, tokenBalanceUnits: 500 }]);
    assert.equal(readLedger().length, 0);
    assert.equal(readUsers().length, 1);
    assert.equal(readTransactions().length, 1);
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
