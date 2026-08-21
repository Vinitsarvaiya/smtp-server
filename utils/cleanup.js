async function cleanupExpiredInboxes(supabase) {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from("inboxes")
    .delete()
    .lt("expires_at", nowIso)
    .select("address");

  if (error) {
    throw error;
  }

  return data || [];
}

module.exports = { cleanupExpiredInboxes };
