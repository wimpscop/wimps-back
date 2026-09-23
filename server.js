const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { MongoMemoryServer } = require("mongodb-memory-server");
const AdminSetting = require("./models/AdminSetting");
const { readData } = require("./utils/fileDb");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5000;
const MONGO_DATA_DIR = path.join(__dirname, ".mongo-data");

function resolveMongoMemorySystemBinary() {
  const directPath = process.env.MONGOMS_SYSTEM_BINARY || process.env.SYSTEM_BINARY;

  if (directPath && fs.existsSync(directPath)) {
    return directPath;
  }

  const candidatePath = path.join(process.env.HOME || "", ".cache", "mongodb-binaries", "mongod-x64-unknown-8.2.6");

  if (fs.existsSync(candidatePath)) {
    return candidatePath;
  }

  return null;
}

// ===== MIDDLEWARE =====
const allowedOrigins = String(process.env.ALLOWED_ORIGINS || process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : "*"
}));
app.use(express.json({ limit: "40mb" }));

// ===== DATABASE =====
async function startDatabase() {
  const configuredUri = process.env.MONGODB_URI;

  if (configuredUri) {
    try {
      await mongoose.connect(configuredUri);
      app.locals.dbReady = true;
      console.log("MongoDB connected to configured URI");
      return;
    } catch (err) {
      console.warn("Configured MongoDB URI failed. Falling back to in-memory MongoDB.", err.message);
    }
  } else {
    console.log("No MONGODB_URI configured. Using in-memory MongoDB for this deployment.");
  }

  const systemBinary = resolveMongoMemorySystemBinary();

  fs.mkdirSync(MONGO_DATA_DIR, { recursive: true });

  const memoryServer = await MongoMemoryServer.create(
    systemBinary
      ? {
          binary: {
            systemBinary,
            version: "8.2.6"
          },
          instance: {
            dbPath: MONGO_DATA_DIR,
            storageEngine: "wiredTiger"
          }
        }
      : {
          instance: {
            dbPath: MONGO_DATA_DIR,
            storageEngine: "wiredTiger"
          }
        }
  );
  const memoryUri = memoryServer.getUri();

  await mongoose.connect(memoryUri);
  app.locals.dbReady = false;
  console.log("MongoDB connected to in-memory server");
}

// ===== ROUTES =====
app.use("/api/auth", require("./routes/auth"));
app.use("/api/wallet", require("./routes/wallet"));
app.use("/api/transactions", require("./routes/transactions"));
app.use("/api/resellerxpress", require("./routes/resellerxpress"));
app.use("/api/datamart", require("./routes/datamart"));
app.use("/api/remadata", require("./routes/remadata"));
app.use("/api/sendcomms", require("./routes/sendcomms"));
app.use("/api/support", require("./routes/support"));
app.use("/api/admin", require("./routes/admin"));

app.get("/api/config/version", async (req, res) => {
  try {
    if (app.locals.dbReady === false) {
      const settings = readData("admin-settings.json") || [];
      const latest = settings.reduce((value, item) => Math.max(value, new Date(item.updatedAt || 0).getTime()), 0);
      return res.json({ version: latest || 0 });
    }
    const latest = await AdminSetting.findOne().sort({ updatedAt: -1 }).select("updatedAt").lean();
    return res.json({ version: latest?.updatedAt ? new Date(latest.updatedAt).getTime() : 0 });
  } catch (error) {
    return res.json({ version: 0 });
  }
});

// ===== TEST ROUTE =====
app.get("/", (req, res) => {
  res.send("API running...");
});

// ===== SERVER =====
async function startServer() {
  try {
    await startDatabase();
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

startServer();