function getTempMailDomain() {
  return (process.env.TEMP_MAIL_DOMAIN || "").trim().toLowerCase();
}

function normalizeAddress(value) {
  return String(value || "").trim().toLowerCase();
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function normalizeRecipient(value) {
  if (Array.isArray(value)) {
    return normalizeAddress(value[0]);
  }

  return normalizeAddress(value);
}

function normalizeAttachments(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((attachment) => attachment && typeof attachment === "object")
    .map((attachment) => ({
      filename: firstNonEmptyString(attachment.filename, attachment.name),
      contentType: firstNonEmptyString(
        attachment.contentType,
        attachment.content_type,
        attachment.mimeType,
        attachment.mime_type
      ),
      contentDisposition: firstNonEmptyString(
        attachment.contentDisposition,
        attachment.content_disposition,
        attachment.disposition
      ),
      contentId: firstNonEmptyString(
        attachment.contentId,
        attachment.content_id,
        attachment.cid
      ),
      size: Number.isFinite(Number(attachment.size)) ? Number(attachment.size) : null,
      url: firstNonEmptyString(attachment.url),
      checksum: firstNonEmptyString(attachment.checksum, attachment.hash)
    }));
}

function extractBody(payload, kind) {
  const directValue = payload[kind];
  if (typeof directValue === "string" && directValue.trim()) {
    return directValue.trim();
  }

  const alternateKey = kind === "text" ? "text_body" : "html_body";
  const alternateValue = payload[alternateKey];
  if (typeof alternateValue === "string" && alternateValue.trim()) {
    return alternateValue.trim();
  }

  const nestedValue = payload.content && payload.content[kind];
  if (typeof nestedValue === "string" && nestedValue.trim()) {
    return nestedValue.trim();
  }

  return "";
}

function extractAttachments(payload) {
  return normalizeAttachments(
    payload.attachments ||
      (payload.content && payload.content.attachments) ||
      (payload.email && payload.email.attachments)
  );
}

function extractContentType(payload) {
  return firstNonEmptyString(
    payload.contentType,
    payload.content_type,
    payload.mimeType,
    payload.mime_type,
    payload.headers && payload.headers["content-type"]
  );
}

function isValidRecipientForDomain(recipient, domain) {
  if (!recipient || !domain) {
    return false;
  }

  const [localPart, recipientDomain] = recipient.split("@");
  if (!localPart || !recipientDomain) {
    return false;
  }

  return recipientDomain === domain;
}

function normalizeIncomingEmail(payload) {
  const sender = normalizeAddress(
    firstNonEmptyString(payload.sender, payload.from, payload.reply_to)
  );
  const recipient = normalizeRecipient(payload.recipient || payload.to);
  const subject = firstNonEmptyString(payload.subject);
  const text = extractBody(payload, "text");
  const html = extractBody(payload, "html");
  const attachments = extractAttachments(payload);
  const contentType = extractContentType(payload);
  const messageId = firstNonEmptyString(
    payload.messageId,
    payload.message_id,
    payload.email_id,
    payload.id,
    payload.headers && payload.headers["message-id"]
  );

  return {
    sender,
    recipient,
    subject,
    text,
    html,
    messageId,
    attachments,
    contentType
  };
}

module.exports = {
  getTempMailDomain,
  isValidRecipientForDomain,
  normalizeAddress,
  normalizeIncomingEmail
};
