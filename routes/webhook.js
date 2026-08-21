const express = require("express");
const { Webhook } = require("svix");
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

function isResendWebhookRequest(req) {
  return Boolean(req.get("svix-id") && req.get("svix-timestamp") && req.get("svix-signature"));
}

function verifyResendWebhook(req) {
  const webhookSecret = (process.env.RESEND_WEBHOOK_SECRET || "").trim();
  if (!webhookSecret) {
    const error = new Error("RESEND_WEBHOOK_SECRET is not configured");
    error.statusCode = 401;
    throw error;
  }

  const rawPayload = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  const webhook = new Webhook(webhookSecret);

  return webhook.verify(rawPayload, {
    "svix-id": req.get("svix-id"),
    "svix-timestamp": req.get("svix-timestamp"),
    "svix-signature": req.get("svix-signature")
  });
}

function normalizeResendEmail(eventPayload) {
  if (!eventPayload || eventPayload.type !== "email.received" || !eventPayload.data) {
    return null;
  }

  const firstRecipient = Array.isArray(eventPayload.data.to) ? eventPayload.data.to[0] : eventPayload.data.to;

  return normalizeIncomingEmail({
    sender: eventPayload.data.from,
    recipient: firstRecipient,
    subject: eventPayload.data.subject,
    text: "",
    html: "",
    messageId: eventPayload.data.message_id || eventPayload.data.email_id
  });
}

function parseManualPayload(req) {
  if (Buffer.isBuffer(req.body)) {
    const rawPayload = req.body.toString("utf8");
    return rawPayload ? JSON.parse(rawPayload) : {};
  }

  return req.body || {};
}

async function storeIncomingMessage(supabase, normalized) {
  const domain = getTempMailDomain();

  if (!normalized.recipient) {
    return {
      status: 400,
      body: { success: false, error: "Recipient is required" }
    };
  }

  if (!isValidRecipientForDomain(normalized.recipient, domain)) {
    return {
      status: 400,
      body: { success: false, error: "Recipient domain is not allowed" }
    };
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
      return {
        status: 200,
        body: { success: true, duplicate: true }
      };
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

  return {
    status: 201,
    body: { success: true }
  };
}

function createWebhookRouter(supabase) {
  const router = express.Router();

  router.post("/incoming-email", async (req, res, next) => {
    try {
      let normalized;

      if (isResendWebhookRequest(req)) {
        let verifiedPayload;
        try {
          verifiedPayload = verifyResendWebhook(req);
        } catch (error) {
          error.statusCode = 401;
          throw error;
        }

        normalized = normalizeResendEmail(verifiedPayload);
        if (!normalized) {
          return res.status(200).json({ success: true, ignored: true });
        }
      } else {
        if (!hasValidWebhookSecret(req)) {
          return res.status(401).json({ success: false, error: "Unauthorized" });
        }

        const payload = parseManualPayload(req);
        normalized = normalizeIncomingEmail(payload);
      }

      const result = await storeIncomingMessage(supabase, normalized);
      return res.status(result.status).json(result.body);
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = { createWebhookRouter };
