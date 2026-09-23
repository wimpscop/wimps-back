# WIMPS backend

## WIMP Rewards

WIMP Rewards are promotional points provided by Wimps. They are not Ghanaian cedi, electronic money, cryptocurrency, or an investment. They cannot be exchanged for cash or transferred to other users. They can only be used for eligible Wimps products and discounts, subject to the Wimps Rewards Terms.

Balances are stored as integer hundredths (`balanceUnits`), where `100` units equals `1.00 WIMP`. Every earn, spend, refund, expiry, or admin adjustment creates an immutable ledger entry. Rewards are awarded only after verified payment and confirmed provider delivery, using an idempotency key per purchase.

## Setup and migration

1. Install dependencies: `npm install`.
2. Configure `MONGODB_URI`, `AUTH_TOKEN_SECRET`, `ADMIN_API_TOKEN`, and the existing payment/provider variables in `.env`.
3. Create zero-balance wallets for existing users: `npm run migrate:wimp`.
4. Roll back only before launch, if required: `npm run rollback:wimp`.
5. Run tests: `npm test`.

Production MongoDB transactions require a replica set, which MongoDB Atlas provides. The local JSON fallback is supported for development.

## API

Authenticated user endpoints require the existing `Authorization: Bearer <authToken>` header:

- `GET /api/wimp/wallet`
- `GET /api/wimp/transactions`
- `POST /api/wimp/redeem` with `planId`, `amount`, and a unique `Idempotency-Key`

Admin endpoints require the existing `X-Admin-Token` header:

- `GET /api/admin/wimp/settings`
- `PUT /api/admin/wimp/settings`
- `GET /api/admin/wimp/transactions`
- `POST /api/admin/wimp/adjust` with email, direction, amount, reason, and `Idempotency-Key`

The server recalculates product prices and redemption limits. It never trusts a frontend balance or discount amount. Admin adjustments always require a reason and are recorded with the administrator identifier.

## Files

WIMP persistence is implemented in `models/WimpWallet.js`, `models/WimpLedger.js`, and `models/WimpSetting.js`. Business logic is in `services/wimp.js`; user and admin APIs are in `routes/wimp.js` and `routes/adminWimp.js`; the migration is `scripts/migrate-wimp-rewards.js`.