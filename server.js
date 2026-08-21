require("dotenv").config();

const express = require("express");
const path = require("path");
const { getSupabaseAdmin } = require("./lib/supabase");
const { createInboxRouter } = require("./routes/inbox");
const { createMessageRouter } = require("./routes/messages");
const { createWebhookRouter } = require("./routes/webhook");
const { cleanupExpiredInboxes } = require("./utils/cleanup");

const PORT = process.env.PORT || 3000;
const app = express();
const supabase = getSupabaseAdmin();

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

function sendHealth(res) {
  res.json({
    status: "ok",
    service: "temp-mail-api",
    timestamp: new Date().toISOString()
  });
}

app.get("/health", (req, res) => sendHealth(res));
app.get("/api/health", (req, res) => sendHealth(res));

app.use("/api/inbox", createInboxRouter(supabase));
app.use("/api/messages", createMessageRouter(supabase));
app.use("/api/webhooks", createWebhookRouter(supabase));

app.use((req, res) => {
  res.status(404).json({ success: false, error: "Not found" });
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ success: false, error: "Internal server error" });
});

async function runCleanup() {
  try {
    const deleted = await cleanupExpiredInboxes(supabase);
    if (deleted.length > 0) {
      console.log(`Cleaned up ${deleted.length} expired inboxes.`);
    }
  } catch (error) {
    console.error("Cleanup failed:", error.message);
  }
}

runCleanup();
setInterval(runCleanup, 60 * 60 * 1000);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Temp mail server listening on port ${PORT}`);
});
