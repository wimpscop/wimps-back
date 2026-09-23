const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('shop pages should not render wallet balance, user, or deposit card blocks', () => {
  const pageFiles = [
    'wimps/mtn.html',
    'wimps/atgo.html',
    'wimps/telecel.html'
  ];

  for (const page of pageFiles) {
    const filePath = path.join(__dirname, '..', '..', page);
    const html = fs.readFileSync(filePath, 'utf8');
    assert.equal(html.includes('id="wallet-balance"'), false, `${page} must not render wallet balance in the shop hero summary`);
    assert.equal(html.includes('id="user-name"'), false, `${page} must not render the user summary card`);
    assert.equal(html.includes('id="deposit-amount"'), false, `${page} must not render a deposit form card`);
  }
});

test('home page dashboard state must guard accountStats for anonymous users', () => {
  const helperFile = path.join(__dirname, '..', '..', 'wimps', 'home-page.js');
  const source = fs.readFileSync(helperFile, 'utf8');

  assert.ok(source.includes("localStorage.removeItem('accountStats')"), 'anonymous users must clear stale accountStats from localStorage');
  assert.ok(source.includes("if (!user || !user.email)"), 'dashboard load must confirm a user before rendering account stats');
});

test('shared page scripts must avoid top-level duplicate globals', () => {
  const files = ['wimps/mtn.js', 'wimps/atgo.js', 'wimps/login-page.js'];

  for (const file of files) {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
    assert.ok(source.includes('(() => {') || source.includes('window.WIMPS'), `${file} must scope top-level script state to avoid duplicate global declarations`);
  }
});

test('admin routes should degrade to file-backed data when MongoDB is unavailable', () => {
  const adminRouteSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin.js'), 'utf8');

  assert.ok(adminRouteSource.includes('readData("users.json")'), 'customers route should offer a file-backed fallback for the admin customer view');
  assert.ok(adminRouteSource.includes('readData("transactions.json")'), 'orders and overview route should offer a file-backed fallback for the admin view');
});

test('deleted accounts cannot keep using old sessions or legacy demo logins', () => {
  const authSource = fs.readFileSync(path.join(__dirname, '..', 'utils', 'auth.js'), 'utf8');
  const loginSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');
  assert.ok(authSource.includes('Your account no longer exists'), 'authenticated requests must reject deleted accounts');
  assert.equal(loginSource.includes('DEMO_ACCOUNTS'), false, 'deleted demo accounts must not be recreated');
});

test('Google sign-in supports the fallback user store', () => {
  const authSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');
  assert.ok(authSource.includes('if (isFallback(req))'), 'Google sign-in must work when fallback storage is active');
  assert.ok(authSource.includes('writeUsers(users)'), 'Google sign-in must persist fallback users');
});

test('completed purchases include SMS notification and delivery fee wiring', () => {
  const walletSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'wallet.js'), 'utf8');
  const smsSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'sendcomms.js'), 'utf8');
  const pricingSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'resellerxpress.js'), 'utf8');
  assert.ok(walletSource.includes('if (tx.status === "completed")'), 'SMS must only send after confirmed delivery');
  assert.ok(walletSource.includes('sendSms({ phone, message })'), 'completed purchases must send a confirmation SMS');
  assert.ok(smsSource.includes('/sms/pricing'), 'SendComms pricing endpoint must be supported');
  assert.ok(pricingSource.includes('getConfiguredSmsFee'), 'SMS delivery fee must be included in plan pricing');
});

test('bundle handling fee is fixed per network', () => {
  const { calculateSellingPrice } = require('../services/resellerxpress');
  const oneGb = calculateSellingPrice(4, 1);
  const hundredGb = calculateSellingPrice(400, 100);
  assert.equal(oneGb.expectedProfit, 1, 'one GB should target one cedi profit');
  assert.equal(hundredGb.expectedProfit, 1, 'handling fee should not scale with bundle size');
  assert.equal(hundredGb.sellingPrice, 401, 'bundle amount should remain the provider price plus handling fee');
});

test('resellerxpress plans should return a visible fallback list when upstream plans are empty', async () => {
  const { getPlans } = require('../services/resellerxpress');
  const plans = await getPlans('mtn');

  assert.ok(Array.isArray(plans), 'fallback plans should be returned as an array');
  assert.ok(plans.length > 0, 'fallback plan list must be non-empty when remote provider payloads are empty');
});
