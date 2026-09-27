const fs = require("fs");
const path = require("path");

function readData(file) {
  const filePath = path.join(__dirname, "../data", file);
  if (!fs.existsSync(filePath)) return [];

  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return [];

  try {
    return JSON.parse(raw);
  } catch (error) {
    return [];
  }
}

function writeData(file, data) {
  const filePath = path.join(__dirname, "../data", file);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

module.exports = { readData, writeData };