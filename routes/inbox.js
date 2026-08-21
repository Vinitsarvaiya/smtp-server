const express = require("express");
const { cleanupExpiredInboxes } = require("../utils/cleanup");
const { ensureInboxExists, findInbox, generateUniqueInbox } = require("../utils/inboxes");
const { getTempMailDomain, normalizeAddress } = require("../utils/email");

function createInboxRouter(supabase) {
  const router = express.Router();

  router.post("/create", async (req, res, next) => {
    try {
      await cleanupExpiredInboxes(supabase);
      const domain = getTempMailDomain();
      if (!domain) {
        return res.status(500).json({ success: false, error: "TEMP_MAIL_DOMAIN is not configured" });
      }

      const inbox = await generateUniqueInbox(supabase, domain);
      return res.status(201).json({
        success: true,
        address: inbox.address,
        expiresAt: inbox.expires_at
      });
    } catch (error) {
      return next(error);
    }
  });

  router.get("/:address/messages", async (req, res, next) => {
    try {
      await cleanupExpiredInboxes(supabase);
      const address = normalizeAddress(req.params.address);
      const inbox = await findInbox(supabase, address);

      if (!inbox) {
        return res.status(404).json({ success: false, error: "Inbox not found" });
      }

      const { data, error } = await supabase
        .from("messages")
        .select("id, sender, recipient, subject, text_body, html_body, received_at")
        .eq("inbox_address", address)
        .order("received_at", { ascending: false });

      if (error) {
        throw error;
      }

      return res.json({
        success: true,
        address,
        expiresAt: inbox.expires_at,
        messages: data || []
      });
    } catch (error) {
      return next(error);
    }
  });

  router.delete("/:address", async (req, res, next) => {
    try {
      const address = normalizeAddress(req.params.address);
      const inbox = await findInbox(supabase, address);

      if (!inbox) {
        return res.status(404).json({ success: false, error: "Inbox not found" });
      }

      const { error } = await supabase
        .from("inboxes")
        .delete()
        .eq("address", address);

      if (error) {
        throw error;
      }

      return res.json({ success: true });
    } catch (error) {
      return next(error);
    }
  });

  router.get("/:address", async (req, res, next) => {
    try {
      const address = normalizeAddress(req.params.address);
      const inbox = await findInbox(supabase, address);

      if (!inbox) {
        return res.status(404).json({ success: false, error: "Inbox not found" });
      }

      return res.json({ success: true, inbox });
    } catch (error) {
      return next(error);
    }
  });

  router.post("/:address/ensure", async (req, res, next) => {
    try {
      const address = normalizeAddress(req.params.address);
      if (!address.endsWith(`@${getTempMailDomain()}`)) {
        return res.status(400).json({ success: false, error: "Invalid inbox address" });
      }

      const inbox = await ensureInboxExists(supabase, address);
      return res.status(201).json({ success: true, address: inbox.address, expiresAt: inbox.expires_at });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = { createInboxRouter };
