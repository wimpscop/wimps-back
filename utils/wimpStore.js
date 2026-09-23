const { readData, writeData } = require("./fileDb");

function readWallets() {
  return readData("wimp-wallets.json") || [];
}

function writeWallets(wallets) {
  writeData("wimp-wallets.json", wallets);
}

function readLedger() {
  return readData("wimp-ledger.json") || [];
}

function writeLedger(ledger) {
  writeData("wimp-ledger.json", ledger);
}

function readSettings() {
  return readData("wimp-settings.json") || [];
}

function writeSettings(settings) {
  writeData("wimp-settings.json", settings);
}

module.exports = { readWallets, writeWallets, readLedger, writeLedger, readSettings, writeSettings };
