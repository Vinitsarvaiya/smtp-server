const express = require("express");
const { Webhook } = require("svix");
const { ensureInboxExists } = require("../utils/inboxes");
const { getTempMailDomain, isValidRecipientForDomain, normalizeIncomingEmail } = require("../utils/email");

const RESEND_API_BASE_URL = "https://api.resend.com";
const ENABLE_WEBHOOK_DEBUG = String(process.env.DEBUG_WEBHOOKS || "").trim() === "1";

function isMissingColumnError(error, columnName) {
  return error && error.code === "42703" && String(error.message || "").includes(columnName);
}

function isMissingSchemaFieldError(error, fieldName) {
  return (
    error &&
    (error.code === "42703" || error.code === "PGRST204") &&
    String(error.message || "").includes(fieldName)
  );
}

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

function logWebhookDebug(label, value) {
  if (!ENABLE_WEBHOOK_DEBUG) {
    return;
  }

  try {
    console.log(`[webhook] ${label}: ${JSON.stringify(value, null, 2)}`);
  } catch (error) {
    console.log(`[webhook] ${label}:`, value);
  }
}

function logDbStoreSummary(label, value) {
  if (!ENABLE_WEBHOOK_DEBUG) {
    return;
  }

  console.log("==================================================");
  console.log(`[db] ${label}`);

  try {
    console.log(JSON.stringify(value, null, 2));
  } catch (error) {
    console.log(value);
  }

  console.log("==================================================");
}

function logFlowStep(label, value) {
  if (!ENABLE_WEBHOOK_DEBUG) {
    return;
  }

  console.log("--------------------------------------------------");
  console.log(`[flow] ${label}`);

  if (typeof value !== "undefined") {
    try {
      console.log(JSON.stringify(value, null, 2));
    } catch (error) {
      console.log(value);
    }
  }

  console.log("--------------------------------------------------");
}

async function fetchResendReceivedEmail(emailId) {
  logFlowStep("fetchResendReceivedEmail:start", { emailId });
  const apiKey = (process.env.RESEND_API_KEY || "").trim();
  if (!apiKey || !emailId) {
    logFlowStep("fetchResendReceivedEmail:skipped", {
      hasApiKey: Boolean(apiKey),
      hasEmailId: Boolean(emailId)
    });
    return null;
  }

  const response = await fetch(`${RESEND_API_BASE_URL}/emails/receiving/${encodeURIComponent(emailId)}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  });

  if (!response.ok) {
    const error = new Error(`Failed to fetch Resend received email ${emailId}: ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }

  const data = await response.json();
  logWebhookDebug("resend.received_email_response", data);
  logFlowStep("fetchResendReceivedEmail:success", {
    emailId,
    hasText: Boolean(data && data.text),
    hasHtml: Boolean(data && data.html),
    hasHeaders: Boolean(data && data.headers),
    hasRaw: Boolean(data && data.raw && data.raw.download_url)
  });
  return data;
}

async function fetchResendRawEmail(rawDownloadUrl) {
  logFlowStep("fetchResendRawEmail:start", {
    hasUrl: Boolean(rawDownloadUrl)
  });
  if (!rawDownloadUrl) {
    logFlowStep("fetchResendRawEmail:skipped");
    return null;
  }

  const response = await fetch(rawDownloadUrl, {
    method: "GET"
  });

  if (!response.ok) {
    const error = new Error(`Failed to download raw email: ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }

  const rawEmail = await response.text();
  logWebhookDebug("resend.raw_email_preview", {
    length: rawEmail.length,
    preview: rawEmail.slice(0, 1000)
  });
  logFlowStep("fetchResendRawEmail:success", {
    rawEmailLength: rawEmail.length
  });
  return rawEmail;
}

function normalizeResendEmail(eventPayload) {
  logFlowStep("normalizeResendEmail:start", {
    type: eventPayload && eventPayload.type,
    hasData: Boolean(eventPayload && eventPayload.data)
  });
  if (!eventPayload || eventPayload.type !== "email.received" || !eventPayload.data) {
    logFlowStep("normalizeResendEmail:ignored");
    return null;
  }

  const normalized = normalizeIncomingEmail({
    sender: eventPayload.data.from,
    recipient: eventPayload.data.to,
    subject: eventPayload.data.subject,
    text: eventPayload.data.text,
    html: eventPayload.data.html,
    text_body: eventPayload.data.text_body,
    html_body: eventPayload.data.html_body,
    content: eventPayload.data.content,
    attachments: eventPayload.data.attachments,
    contentType: eventPayload.data.content_type || eventPayload.data.mime_type,
    headers: eventPayload.data.headers,
    messageId: eventPayload.data.message_id || eventPayload.data.email_id
  });

  normalized.rawPayload = eventPayload.data;
  logWebhookDebug("resend.webhook_payload", eventPayload);
  logWebhookDebug("resend.normalized_from_webhook", normalized);
  logFlowStep("normalizeResendEmail:success", {
    recipient: normalized.recipient,
    messageId: normalized.messageId,
    hasText: Boolean(normalized.text),
    hasHtml: Boolean(normalized.html)
  });
  return normalized;
}

async function enrichResendEmail(normalized, eventPayload) {
  logFlowStep("enrichResendEmail:start", {
    messageId: normalized && normalized.messageId
  });
  const emailId = eventPayload && eventPayload.data && eventPayload.data.email_id;
  if (!emailId) {
    logFlowStep("enrichResendEmail:skipped", {
      reason: "missing email_id"
    });
    return normalized;
  }

  const receivedEmailResponse = await fetchResendReceivedEmail(emailId);
  const receivedEmail = receivedEmailResponse && receivedEmailResponse.data
    ? receivedEmailResponse.data
    : receivedEmailResponse;

  if (!receivedEmail) {
    logFlowStep("enrichResendEmail:noReceivedEmail", { emailId });
    return normalized;
  }

  const rawEmail = receivedEmail.raw && receivedEmail.raw.download_url
    ? await fetchResendRawEmail(receivedEmail.raw.download_url)
    : null;

  const enriched = normalizeIncomingEmail({
    sender: receivedEmail.from,
    recipient: receivedEmail.to,
    subject: receivedEmail.subject,
    text: receivedEmail.text,
    html: receivedEmail.html,
    attachments: receivedEmail.attachments,
    contentType: receivedEmail.headers && receivedEmail.headers["content-type"],
    headers: receivedEmail.headers,
    messageId: receivedEmail.message_id || emailId
  });

  enriched.rawPayload = {
    webhook: eventPayload.data,
    received_email: receivedEmail,
    raw_email: rawEmail
  };
  enriched.rawEmail = rawEmail;
  enriched.headers = receivedEmail.headers || null;

  logWebhookDebug("resend.enriched_message", {
    sender: enriched.sender,
    recipient: enriched.recipient,
    subject: enriched.subject,
    hasText: Boolean(enriched.text),
    hasHtml: Boolean(enriched.html),
    attachmentCount: Array.isArray(enriched.attachments) ? enriched.attachments.length : 0,
    hasRawEmail: Boolean(rawEmail)
  });
  logFlowStep("enrichResendEmail:success", {
    emailId,
    hasText: Boolean(enriched.text),
    hasHtml: Boolean(enriched.html),
    hasHeaders: Boolean(enriched.headers),
    hasRawEmail: Boolean(enriched.rawEmail)
  });

  return {
    ...normalized,
    ...enriched,
    text: enriched.text || normalized.text,
    html: enriched.html || normalized.html,
    attachments: enriched.attachments && enriched.attachments.length ? enriched.attachments : normalized.attachments,
    contentType: enriched.contentType || normalized.contentType,
    headers: enriched.headers || normalized.headers || null,
    rawEmail: enriched.rawEmail || normalized.rawEmail || null,
    rawPayload: enriched.rawPayload
  };
}

function parseManualPayload(req) {
  logFlowStep("parseManualPayload:start", {
    isBuffer: Buffer.isBuffer(req.body)
  });
  if (Buffer.isBuffer(req.body)) {
    const rawPayload = req.body.toString("utf8");
    logFlowStep("parseManualPayload:buffer", {
      rawPayloadLength: rawPayload.length
    });
    return rawPayload ? JSON.parse(rawPayload) : {};
  }

  logFlowStep("parseManualPayload:object", {
    bodyKeys: req.body && typeof req.body === "object" ? Object.keys(req.body) : []
  });
  return req.body || {};
}

async function storeIncomingMessage(supabase, normalized) {
  logFlowStep("storeIncomingMessage:start", {
    recipient: normalized && normalized.recipient,
    messageId: normalized && normalized.messageId
  });
  const domain = getTempMailDomain();

  if (!normalized.recipient) {
    logFlowStep("storeIncomingMessage:missingRecipient");
    return {
      status: 400,
      body: { success: false, error: "Recipient is required" }
    };
  }

  if (!isValidRecipientForDomain(normalized.recipient, domain)) {
    logFlowStep("storeIncomingMessage:invalidDomain", {
      recipient: normalized.recipient,
      allowedDomain: domain
    });
    return {
      status: 400,
      body: { success: false, error: "Recipient domain is not allowed" }
    };
  }

  if (normalized.messageId) {
    logFlowStep("storeIncomingMessage:duplicateLookup:start", {
      messageId: normalized.messageId
    });
    const { data: existingMessage, error: duplicateLookupError } = await supabase
      .from("messages")
      .select("id, text_body, html_body, content_type, attachments, headers, raw_email, raw_payload")
      .eq("message_id", normalized.messageId)
      .maybeSingle();

    if (duplicateLookupError) {
      logFlowStep("storeIncomingMessage:duplicateLookup:error", {
        code: duplicateLookupError.code,
        message: duplicateLookupError.message
      });
      throw duplicateLookupError;
    }

    if (existingMessage) {
      const updatePayload = {
        sender: normalized.sender || null,
        recipient: normalized.recipient,
        subject: normalized.subject || null,
        text_body: normalized.text || existingMessage.text_body || null,
        html_body: normalized.html || existingMessage.html_body || null,
        content_type: normalized.contentType || existingMessage.content_type || null,
        attachments: normalized.attachments && normalized.attachments.length
          ? normalized.attachments
          : Array.isArray(existingMessage.attachments)
            ? existingMessage.attachments
            : [],
        headers: normalized.headers || existingMessage.headers || null,
        raw_email: normalized.rawEmail || existingMessage.raw_email || null,
        raw_payload: normalized.rawPayload || existingMessage.raw_payload || null
      };

      logDbStoreSummary("duplicate found", {
        messageId: normalized.messageId,
        existingRowId: existingMessage.id,
        willUpdateExistingRow: true,
        hasIncomingText: Boolean(normalized.text),
        hasIncomingHtml: Boolean(normalized.html),
        hasIncomingHeaders: Boolean(normalized.headers),
        hasIncomingRawEmail: Boolean(normalized.rawEmail),
        hasIncomingRawPayload: Boolean(normalized.rawPayload)
      });

      let { error: updateError } = await supabase
        .from("messages")
        .update(updatePayload)
        .eq("id", existingMessage.id);

      if (
        isMissingSchemaFieldError(updateError, "content_type") ||
        isMissingSchemaFieldError(updateError, "attachments") ||
        isMissingSchemaFieldError(updateError, "headers") ||
        isMissingSchemaFieldError(updateError, "raw_email") ||
        isMissingSchemaFieldError(updateError, "raw_payload")
      ) {
        logDbStoreSummary("duplicate update fallback triggered", {
          reason: updateError.message,
          code: updateError.code
        });

        ({ error: updateError } = await supabase
          .from("messages")
          .update({
            sender: normalized.sender || null,
            recipient: normalized.recipient,
            subject: normalized.subject || null,
            text_body: normalized.text || existingMessage.text_body || null,
            html_body: normalized.html || existingMessage.html_body || null
          })
          .eq("id", existingMessage.id));
      }

      if (updateError) {
        logDbStoreSummary("duplicate update failed", {
          code: updateError.code,
          message: updateError.message,
          details: updateError.details,
          hint: updateError.hint
        });
        throw updateError;
      }

      logDbStoreSummary("duplicate updated", {
        messageId: normalized.messageId,
        existingRowId: existingMessage.id,
        hasStoredText: Boolean(updatePayload.text_body),
        hasStoredHtml: Boolean(updatePayload.html_body),
        hasStoredHeaders: Boolean(updatePayload.headers),
        hasStoredRawEmail: Boolean(updatePayload.raw_email),
        hasStoredRawPayload: Boolean(updatePayload.raw_payload)
      });

      logFlowStep("storeIncomingMessage:duplicateUpdated", {
        messageId: normalized.messageId,
        existingRowId: existingMessage.id
      });
      return {
        status: 200,
        body: { success: true, duplicate: true, updated: true }
      };
    }
  }

  logFlowStep("storeIncomingMessage:ensureInboxExists:start", {
    recipient: normalized.recipient
  });
  await ensureInboxExists(supabase, normalized.recipient);
  logFlowStep("storeIncomingMessage:ensureInboxExists:success", {
    recipient: normalized.recipient
  });

  const payload = {
    inbox_address: normalized.recipient,
    sender: normalized.sender || null,
    recipient: normalized.recipient,
    subject: normalized.subject || null,
    text_body: normalized.text || null,
    html_body: normalized.html || null,
    message_id: normalized.messageId || null,
    content_type: normalized.contentType || null,
    attachments: normalized.attachments || [],
    headers: normalized.headers || null,
    raw_email: normalized.rawEmail || null,
    raw_payload: normalized.rawPayload || null
  };

  logWebhookDebug("message.insert_payload", {
    inbox_address: payload.inbox_address,
    sender: payload.sender,
    recipient: payload.recipient,
    subject: payload.subject,
    hasText: Boolean(payload.text_body),
    hasHtml: Boolean(payload.html_body),
    content_type: payload.content_type,
    attachmentCount: Array.isArray(payload.attachments) ? payload.attachments.length : 0,
    hasHeaders: Boolean(payload.headers),
    hasRawEmail: Boolean(payload.raw_email),
    hasRawPayload: Boolean(payload.raw_payload),
    rawPayloadKeys: payload.raw_payload && typeof payload.raw_payload === "object" ? Object.keys(payload.raw_payload) : []
  });

  logDbStoreSummary("insert attempt", {
    messageId: payload.message_id,
    inbox_address: payload.inbox_address,
    sender: payload.sender,
    recipient: payload.recipient,
    subject: payload.subject,
    hasText: Boolean(payload.text_body),
    textLength: payload.text_body ? payload.text_body.length : 0,
    hasHtml: Boolean(payload.html_body),
    htmlLength: payload.html_body ? payload.html_body.length : 0,
    content_type: payload.content_type,
    attachmentCount: Array.isArray(payload.attachments) ? payload.attachments.length : 0,
    hasHeaders: Boolean(payload.headers),
    headerKeys: payload.headers && typeof payload.headers === "object" ? Object.keys(payload.headers) : [],
    hasRawEmail: Boolean(payload.raw_email),
    rawEmailLength: payload.raw_email ? payload.raw_email.length : 0,
    hasRawPayload: Boolean(payload.raw_payload),
    rawPayloadKeys: payload.raw_payload && typeof payload.raw_payload === "object" ? Object.keys(payload.raw_payload) : []
  });

  let { error } = await supabase
    .from("messages")
    .insert(payload);

  if (!error) {
    logDbStoreSummary("insert success", {
      messageId: payload.message_id,
      storedWithExtendedFields: true
    });
  }

  if (
    isMissingSchemaFieldError(error, "content_type") ||
    isMissingSchemaFieldError(error, "attachments") ||
    isMissingSchemaFieldError(error, "headers") ||
    isMissingSchemaFieldError(error, "raw_email") ||
    isMissingSchemaFieldError(error, "raw_payload")
  ) {
    logDbStoreSummary("insert fallback triggered", {
      reason: error.message,
      code: error.code
    });

    ({ error } = await supabase
      .from("messages")
      .insert({
        inbox_address: normalized.recipient,
        sender: normalized.sender || null,
        recipient: normalized.recipient,
        subject: normalized.subject || null,
        text_body: normalized.text || null,
        html_body: normalized.html || null,
        message_id: normalized.messageId || null
      }));

    if (!error) {
      logDbStoreSummary("fallback insert success", {
        messageId: normalized.messageId || null,
        storedFields: [
          "inbox_address",
          "sender",
          "recipient",
          "subject",
          "text_body",
          "html_body",
          "message_id"
        ]
      });
    }
  }

  if (error) {
    logDbStoreSummary("insert failed", {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint
    });
    throw error;
  }

  try {
    const { data: storedRow, error: lookupError } = await supabase
      .from("messages")
      .select("id, message_id, text_body, html_body, content_type, attachments, headers, raw_email, raw_payload, created_at")
      .eq("message_id", normalized.messageId || "")
      .maybeSingle();

    if (lookupError) {
      logDbStoreSummary("post-insert lookup failed", {
        code: lookupError.code,
        message: lookupError.message,
        details: lookupError.details,
        hint: lookupError.hint
      });
    } else {
      logDbStoreSummary("stored row", {
        id: storedRow && storedRow.id,
        message_id: storedRow && storedRow.message_id,
        hasText: Boolean(storedRow && storedRow.text_body),
        textLength: storedRow && storedRow.text_body ? storedRow.text_body.length : 0,
        hasHtml: Boolean(storedRow && storedRow.html_body),
        content_type: storedRow && storedRow.content_type,
        attachmentCount: storedRow && Array.isArray(storedRow.attachments) ? storedRow.attachments.length : 0,
        hasHeaders: Boolean(storedRow && storedRow.headers),
        hasRawEmail: Boolean(storedRow && storedRow.raw_email),
        rawEmailLength: storedRow && storedRow.raw_email ? storedRow.raw_email.length : 0,
        hasRawPayload: Boolean(storedRow && storedRow.raw_payload),
        rawPayloadKeys: storedRow && storedRow.raw_payload && typeof storedRow.raw_payload === "object"
          ? Object.keys(storedRow.raw_payload)
          : []
      });
    }
  } catch (lookupError) {
    logDbStoreSummary("post-insert lookup exception", {
      message: lookupError.message
    });
  }

  return {
    status: 201,
    body: { success: true }
  };
}

function createWebhookRouter(supabase) {
  const router = express.Router();

  router.post("/incoming-email", async (req, res, next) => {
    logFlowStep("incoming-email:request-start", {
      method: req.method,
      url: req.originalUrl
    });
    try {
      let normalized;

      if (isResendWebhookRequest(req)) {
        logFlowStep("incoming-email:resend-branch");
        logWebhookDebug("request.headers", {
          "svix-id": req.get("svix-id"),
          "svix-timestamp": req.get("svix-timestamp"),
          "svix-signature": req.get("svix-signature"),
          "content-type": req.get("content-type")
        });
        let verifiedPayload;
        try {
          logFlowStep("incoming-email:verifyResend:start");
          verifiedPayload = verifyResendWebhook(req);
          logFlowStep("incoming-email:verifyResend:success", {
            type: verifiedPayload && verifiedPayload.type
          });
        } catch (error) {
          logFlowStep("incoming-email:verifyResend:error", {
            message: error.message
          });
          error.statusCode = 401;
          throw error;
        }

        normalized = normalizeResendEmail(verifiedPayload);
        if (!normalized) {
          logFlowStep("incoming-email:normalized-empty");
          return res.status(200).json({ success: true, ignored: true });
        }

        try {
          normalized = await enrichResendEmail(normalized, verifiedPayload);
        } catch (error) {
          logFlowStep("incoming-email:enrich:error", {
            message: error.message
          });
          console.error("Failed to enrich Resend received email:", error.message);
        }
      } else {
        logFlowStep("incoming-email:manual-branch");
        if (!hasValidWebhookSecret(req)) {
          logFlowStep("incoming-email:manual-auth-failed");
          return res.status(401).json({ success: false, error: "Unauthorized" });
        }

        const payload = parseManualPayload(req);
        logWebhookDebug("manual.webhook_payload", payload);
        normalized = normalizeIncomingEmail(payload);
        normalized.headers = normalized.headers || (payload.headers && typeof payload.headers === "object" ? payload.headers : null);
        normalized.rawEmail = typeof payload.raw === "string" ? payload.raw : null;
        normalized.rawPayload = payload;
        logFlowStep("incoming-email:manual-normalized", {
          recipient: normalized.recipient,
          messageId: normalized.messageId
        });
      }

      logFlowStep("incoming-email:before-store", {
        recipient: normalized && normalized.recipient,
        messageId: normalized && normalized.messageId,
        hasText: Boolean(normalized && normalized.text),
        hasHtml: Boolean(normalized && normalized.html),
        hasHeaders: Boolean(normalized && normalized.headers),
        hasRawEmail: Boolean(normalized && normalized.rawEmail),
        hasRawPayload: Boolean(normalized && normalized.rawPayload)
      });
      const result = await storeIncomingMessage(supabase, normalized);
      logFlowStep("incoming-email:store-result", result);
      return res.status(result.status).json(result.body);
    } catch (error) {
      logFlowStep("incoming-email:handler-error", {
        message: error.message,
        code: error.code,
        statusCode: error.statusCode
      });
      return next(error);
    }
  });

  return router;
}

module.exports = { createWebhookRouter };
