const mongoose = require('mongoose');

const SolanaAuditLogSchema = new mongoose.Schema({
  adminId: { type: String, required: true, index: true },
  action: { type: String, required: true },
  targetObject: { type: String, default: 'solana' },
  previousValue: { type: mongoose.Schema.Types.Mixed, default: null },
  newValue: { type: mongoose.Schema.Types.Mixed, default: null },
  reason: { type: String, default: '' },
  requestId: { type: String, default: '' },
  result: { type: String, default: 'success' },
  errorDetails: { type: String, default: '' },
  ipAddress: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.models.SolanaAuditLog || mongoose.model('SolanaAuditLog', SolanaAuditLogSchema);
