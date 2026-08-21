const express = require("express");
const { ensureInboxExists } = require("../utils/inboxes");
const { getTempMailDomain, isValidRecipientForDomain, normalizeIncomingEmail } = require("../utils/email");

function hasValidWebhookSecret(req) {
  const configuredSecret = process.env.WEBHOOK_SECRET || "";
  if (!configuredSecret) {
    console.warn("WEBHOOK_SECRET is empty. Allowing webhook requests for local development.");
    return true;
  }

  const authHeader = req.get("authorization") || "";
  const bearerSecret = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const headerSecret = (req.get("x-webhook-secret") || "").trim();
  return bearerSecret === configuredSecret || headerSecret === configuredSecret;
}

function createWebhookRouter(supabase) {
  const router = express.Router();

  router.post("/incoming-email", async (req, res, next) => {
    try {
      if (!hasValidWebhookSecret(req)) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }

      const normalized = normalizeIncomingEmail(req.body || {});
      const domain = getTempMailDomain();

      if (!normalized.recipient) {
        return res.status(400).json({ success: false, error: "Recipient is required" });
      }

      if (!isValidRecipientForDomain(normalized.recipient, domain)) {
        return res.status(400).json({ success: false, error: "Recipient domain is not allowed" });
      }

      if (normalized.messageId) {
        const { data: existingMessage, error: duplicateLookupError } = await supabase
          .from("messages")
          .select("id")
          .eq("message_id", normalized.messageId)
          .maybeSingle();

        if (duplicateLookupError) {
          throw duplicateLookupError;
        }

        if (existingMessage) {
          return res.json({ success: true, duplicate: true });
        }
      }

      await ensureInboxExists(supabase, normalized.recipient);

      const { error } = await supabase
        .from("messages")
        .insert({
          inbox_address: normalized.recipient,
          sender: normalized.sender || null,
          recipient: normalized.recipient,
          subject: normalized.subject || null,
          text_body: normalized.text || null,
          html_body: normalized.html || null,
          message_id: normalized.messageId || null
        });

      if (error) {
        throw error;
      }

      return res.status(201).json({ success: true });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = { createWebhookRouter };
