const mongoose = require('mongoose');

const SolanaWalletConnectionSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  publicKey: { type: String, required: true },
  cluster: { type: String, default: 'devnet' },
  network: { type: String, default: 'solana-devnet' },
  status: { type: String, enum: ['pending', 'verified', 'revoked'], default: 'pending' },
  nonce: { type: String, default: '' },
  verifiedAt: { type: Date, default: null },
  revokedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

SolanaWalletConnectionSchema.index({ userId: 1, publicKey: 1 }, { unique: true });

module.exports = mongoose.model('SolanaWalletConnection', SolanaWalletConnectionSchema);
