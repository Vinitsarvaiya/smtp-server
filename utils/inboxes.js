const { buildAddress, generateLocalPart } = require("./generateEmail");

function getExpiryHours() {
  const parsed = Number.parseInt(process.env.EMAIL_EXPIRY_HOURS || "24", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 24;
}

function getExpiryDate() {
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + getExpiryHours());
  return expiresAt.toISOString();
}

async function findInbox(supabase, address) {
  const { data, error } = await supabase
    .from("inboxes")
    .select("id, address, created_at, expires_at")
    .eq("address", address)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

async function createInboxRecord(supabase, address) {
  const expiresAt = getExpiryDate();
  const { data, error } = await supabase
    .from("inboxes")
    .insert({ address, expires_at: expiresAt })
    .select("address, expires_at")
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function generateUniqueInbox(supabase, domain) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const address = buildAddress(generateLocalPart(), domain);
    const existing = await findInbox(supabase, address);
    if (!existing) {
      return createInboxRecord(supabase, address);
    }
  }

  throw new Error("Unable to generate a unique inbox");
}

async function ensureInboxExists(supabase, address) {
  const existing = await findInbox(supabase, address);
  if (existing) {
    return existing;
  }

  return createInboxRecord(supabase, address);
}

module.exports = {
  ensureInboxExists,
  findInbox,
  generateUniqueInbox
};
