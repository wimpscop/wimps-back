const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const adminRouter = require('../routes/admin');

const ADMIN_TOKEN = 'test-admin-token-0123456789abcdef';

function createApp() {
  const app = express();
  // dbReady === false puts isFallback(req) into the local-file data path,
  // so these tests never touch MongoDB.
  app.locals.dbReady = false;
  app.use(express.json());
  app.use('/api/admin', adminRouter);
  return app;
}

function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function withAdminServer(run) {
  const previousToken = process.env.ADMIN_API_TOKEN;
  process.env.ADMIN_API_TOKEN = ADMIN_TOKEN;
  const app = createApp();
  const server = await startServer(app);
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/admin`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previousToken === undefined) delete process.env.ADMIN_API_TOKEN;
    else process.env.ADMIN_API_TOKEN = previousToken;
  }
}

test('admin routes reject requests without an admin token', async () => {
  await withAdminServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/overview`);
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.match(body.msg, /authentication required/i);
  });
});

test('admin routes reject requests with a wrong admin token', async () => {
  await withAdminServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/overview`, {
      headers: { 'X-Admin-Token': 'wrong-token' }
    });
    assert.equal(response.status, 401);
  });
});

test('admin routes return 503 when no admin token is configured', async () => {
  const previousToken = process.env.ADMIN_API_TOKEN;
  delete process.env.ADMIN_API_TOKEN;
  const app = createApp();
  const server = await startServer(app);
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/admin`;
  try {
    const response = await fetch(`${baseUrl}/overview`, {
      headers: { 'X-Admin-Token': ADMIN_TOKEN }
    });
    assert.equal(response.status, 503);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previousToken !== undefined) process.env.ADMIN_API_TOKEN = previousToken;
  }
});

test('overview serves the local fallback summary when the database is unavailable', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dataDir = path.join(__dirname, '..', 'data');
  const usersFile = path.join(dataDir, 'users.json');
  const transactionsFile = path.join(dataDir, 'transactions.json');
  fs.mkdirSync(dataDir, { recursive: true });

  const previousUsers = fs.existsSync(usersFile) ? fs.readFileSync(usersFile) : null;
  const previousTransactions = fs.existsSync(transactionsFile) ? fs.readFileSync(transactionsFile) : null;

  const today = new Date().toISOString();
  fs.writeFileSync(usersFile, JSON.stringify([
    { id: 'u1', email: 'fallback@example.com', fullname: 'Fallback User', createdAt: today }
  ]));
  fs.writeFileSync(transactionsFile, JSON.stringify([
    { id: 't1', type: 'purchase', status: 'completed', amount: 10, actualProfit: 2, date: today },
    { id: 't2', type: 'purchase', status: 'pending', amount: 5, expectedProfit: 1, date: today },
    { id: 't3', type: 'refund', status: 'refunded', amount: 3, date: today }
  ]));

  try {
    await withAdminServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/overview`, {
        headers: { 'X-Admin-Token': ADMIN_TOKEN }
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.totalUsers, 1);
      assert.equal(body.todayOrders, 2);
      assert.equal(body.todaySales, 15);
      assert.equal(body.todayProfit, 3);
      assert.equal(body.todayRefunds, 3);
      assert.equal(body.successfulOrders, 1);
      assert.equal(body.pendingOrders, 1);
      assert.equal(body.failedOrders, 0);
    });
  } finally {
    if (previousUsers === null) {
      if (fs.existsSync(usersFile)) fs.unlinkSync(usersFile);
    } else {
      fs.writeFileSync(usersFile, previousUsers);
    }
    if (previousTransactions === null) {
      if (fs.existsSync(transactionsFile)) fs.unlinkSync(transactionsFile);
    } else {
      fs.writeFileSync(transactionsFile, previousTransactions);
    }
  }
});

test('settings validation rejects a negative numeric setting', async () => {
  await withAdminServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/settings`, {
      method: 'PUT',
      headers: { 'X-Admin-Token': ADMIN_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ handlingFees: { mtn: -1 } })
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.msg, /handlingFees/);
  });
});

test('admin email endpoint rejects unverified Resend recipients with a clear message', async () => {
  const axios = require('axios');
  const previousKey = process.env.RESEND_API_KEY;
  const previousFrom = process.env.RESEND_FROM_EMAIL;
  process.env.RESEND_API_KEY = 'test-resend-key';
  process.env.RESEND_FROM_EMAIL = 'onboarding@resend.dev';

  const originalPost = axios.post;
  axios.post = async () => {
    const error = new Error('Request failed');
    error.response = {
      status: 422,
      data: { message: 'Invalid `to` field. Please use our testing email address instead of domains like `example.com`.' }
    };
    throw error;
  };

  try {
    await withAdminServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/email`, {
        method: 'POST',
        headers: { 'X-Admin-Token': ADMIN_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipients: ['customer@example.com'],
          subject: 'Hello',
          message: 'Test email'
        })
      });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.match(body.msg, /verified|testing email|Resend/i);
    });
  } finally {
    axios.post = originalPost;
    if (previousKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousKey;
    if (previousFrom === undefined) delete process.env.RESEND_FROM_EMAIL;
    else process.env.RESEND_FROM_EMAIL = previousFrom;
  }
});

test('settings validation rejects an unsupported selectedProvider', async () => {
  await withAdminServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/settings`, {
      method: 'PUT',
      headers: { 'X-Admin-Token': ADMIN_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectedProvider: 'not-a-provider' })
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.msg, /selectedProvider/);
  });
});
