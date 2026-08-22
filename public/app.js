const STORAGE_KEY = "temp-mail-address";
const POLL_INTERVAL_MS = 5000;

const addressEl = document.getElementById("address");
const expiryEl = document.getElementById("expiry");
const statusEl = document.getElementById("status");
const messagesEl = document.getElementById("messages");
const viewerEl = document.getElementById("viewer");
const messageCountEl = document.getElementById("messageCount");
const copyButton = document.getElementById("copyButton");
const newAddressButton = document.getElementById("newAddressButton");
const refreshButton = document.getElementById("refreshButton");
const deleteButton = document.getElementById("deleteButton");

let currentAddress = "";
let pollHandle = null;

function setStatus(message) {
  statusEl.textContent = message || "";
}

function setAddress(address, expiresAt) {
  currentAddress = address;
  addressEl.textContent = address || "No active address";
  expiryEl.textContent = expiresAt ? `Expires: ${new Date(expiresAt).toLocaleString()}` : "";

  if (address) {
    localStorage.setItem(STORAGE_KEY, address);
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}

function renderMessages(messages) {
  messageCountEl.textContent = `${messages.length} message${messages.length === 1 ? "" : "s"}`;
  messagesEl.innerHTML = "";

  if (!messages.length) {
    messagesEl.innerHTML = "<p class='meta'>No messages yet.</p>";
    return;
  }

  messages.forEach((message) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "message-card";
    button.innerHTML = `
      <span>
        <strong>${escapeHtml(message.sender || "Unknown sender")}</strong>
        <span>${escapeHtml(message.subject || "(No subject)")}</span>
      </span>
      <span>${new Date(message.received_at).toLocaleString()}</span>
    `;
    button.addEventListener("click", () => loadMessage(message.id));
    messagesEl.appendChild(button);
  });
}

function renderMessageBody(message) {
  viewerEl.classList.remove("empty");
  const receivedEmail = message.raw_payload && message.raw_payload.received_email
    ? message.raw_payload.received_email
    : null;
  const rawEmail = typeof message.raw_email === "string" && message.raw_email
    ? message.raw_email
    : message.raw_payload && typeof message.raw_payload.raw_email === "string"
      ? message.raw_payload.raw_email
    : "";
  const headers = message.headers && typeof message.headers === "object"
    ? message.headers
    : receivedEmail && receivedEmail.headers && typeof receivedEmail.headers === "object"
      ? receivedEmail.headers
      : null;
  const textBody = message.text_body || (receivedEmail && receivedEmail.text) || "";
  const htmlBody = message.html_body || (receivedEmail && receivedEmail.html) || "";
  const contentType = message.content_type || (receivedEmail && receivedEmail.headers && receivedEmail.headers["content-type"]) || "unknown";
  const hasText = Boolean(textBody);
  const hasHtml = Boolean(htmlBody);
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const content = hasText
    ? `<div>${escapeHtml(textBody).replace(/\n/g, "<br />")}</div>`
    : hasHtml
      ? `<iframe class="message-html-frame" title="HTML email preview" sandbox="" srcdoc="${escapeHtml(htmlBody)}"></iframe>`
      : rawEmail
        ? `<pre class="raw-message">${escapeHtml(rawEmail)}</pre>`
        : "<p>(No message body available)</p>";
  const attachmentMarkup = attachments.length
    ? `
      <hr />
      <strong>Attachments:</strong>
      <ul class="attachment-list">
        ${attachments
          .map((attachment) => {
            const parts = [
              escapeHtml(attachment.filename || "Unnamed file"),
              attachment.contentType ? escapeHtml(attachment.contentType) : "",
              attachment.size ? `${escapeHtml(String(attachment.size))} bytes` : ""
            ].filter(Boolean);
            return `<li>${parts.join(" - ")}</li>`;
          })
          .join("")}
      </ul>
    `
    : "";
  const headerMarkup = headers
    ? `
      <hr />
      <strong>Headers:</strong>
      <pre class="raw-message">${escapeHtml(JSON.stringify(headers, null, 2))}</pre>
    `
    : "";
  const rawMarkup = rawEmail
    ? `
      <hr />
      <strong>Raw Email:</strong>
      <pre class="raw-message">${escapeHtml(rawEmail)}</pre>
    `
    : "";

  viewerEl.innerHTML = `
    <strong>From:</strong> ${escapeHtml(message.sender || "")}<br />
    <strong>To:</strong> ${escapeHtml(message.recipient || "")}<br />
    <strong>Subject:</strong> ${escapeHtml(message.subject || "(No subject)")}<br />
    <strong>Content-Type:</strong> ${escapeHtml(contentType)}<br />
    <strong>Received:</strong> ${new Date(message.received_at).toLocaleString()}
    <hr />
    ${content}
    ${attachmentMarkup}
    ${headerMarkup}
    ${rawMarkup}
  `;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }

  return data;
}

async function createInbox() {
  const data = await fetchJson("/api/inbox/create", { method: "POST" });
  setAddress(data.address, data.expiresAt);
  viewerEl.className = "viewer empty";
  viewerEl.textContent = "Select a message to read it.";
  await refreshInbox();
}

async function ensureInbox(address) {
  const encoded = encodeURIComponent(address);
  const response = await fetch(`/api/inbox/${encoded}`);
  if (response.ok) {
    const data = await response.json();
    setAddress(data.inbox.address, data.inbox.expires_at);
    return true;
  }

  localStorage.removeItem(STORAGE_KEY);
  return false;
}

async function refreshInbox() {
  if (!currentAddress) {
    return;
  }

  const encoded = encodeURIComponent(currentAddress);
  const data = await fetchJson(`/api/inbox/${encoded}/messages`);
  setAddress(data.address, data.expiresAt);
  renderMessages(data.messages || []);
}

async function loadMessage(id) {
  const data = await fetchJson(`/api/messages/${id}`);
  renderMessageBody(data.message);
}

async function copyAddress() {
  if (!currentAddress) {
    return;
  }

  await navigator.clipboard.writeText(currentAddress);
  setStatus("Copied!");
  window.setTimeout(() => {
    if (statusEl.textContent === "Copied!") {
      setStatus("");
    }
  }, 1500);
}

async function deleteInbox() {
  if (!currentAddress) {
    return;
  }

  const encoded = encodeURIComponent(currentAddress);
  await fetchJson(`/api/inbox/${encoded}`, { method: "DELETE" });
  setAddress("", "");
  renderMessages([]);
  viewerEl.className = "viewer empty";
  viewerEl.textContent = "Inbox deleted. Creating a new address...";
  await createInbox();
}

function startPolling() {
  if (pollHandle) {
    window.clearInterval(pollHandle);
  }

  pollHandle = window.setInterval(() => {
    refreshInbox().catch((error) => setStatus(error.message));
  }, POLL_INTERVAL_MS);
}

async function init() {
  try {
    const storedAddress = localStorage.getItem(STORAGE_KEY);
    if (storedAddress) {
      const restored = await ensureInbox(storedAddress);
      if (restored) {
        await refreshInbox();
        startPolling();
        return;
      }
    }

    await createInbox();
    startPolling();
  } catch (error) {
    setStatus(error.message);
    addressEl.textContent = "Unable to create an inbox";
  }
}

copyButton.addEventListener("click", () => {
  copyAddress().catch((error) => setStatus(error.message));
});

newAddressButton.addEventListener("click", () => {
  createInbox().catch((error) => setStatus(error.message));
});

refreshButton.addEventListener("click", () => {
  refreshInbox().catch((error) => setStatus(error.message));
});

deleteButton.addEventListener("click", () => {
  deleteInbox().catch((error) => setStatus(error.message));
});

init();
