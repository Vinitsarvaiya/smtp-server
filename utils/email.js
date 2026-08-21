function getTempMailDomain() {
  return (process.env.TEMP_MAIL_DOMAIN || "").trim().toLowerCase();
}

function normalizeAddress(value) {
  return String(value || "").trim().toLowerCase();
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
  const sender = normalizeAddress(payload.sender || payload.from);
  const recipient = normalizeAddress(payload.recipient || payload.to);
  const subject = String(payload.subject || "").trim();
  const text = String(payload.text || payload.text_body || "").trim();
  const html = String(payload.html || payload.html_body || "").trim();
  const messageId = String(payload.messageId || payload.message_id || "").trim();

  return {
    sender,
    recipient,
    subject,
    text,
    html,
    messageId
  };
}

module.exports = {
  getTempMailDomain,
  isValidRecipientForDomain,
  normalizeAddress,
  normalizeIncomingEmail
};
