const express = require("express");

function createMessageRouter(supabase) {
  const router = express.Router();

  router.get("/:id", async (req, res, next) => {
    try {
      const { data, error } = await supabase
        .from("messages")
        .select("id, inbox_address, sender, recipient, subject, text_body, html_body, message_id, received_at, created_at")
        .eq("id", req.params.id)
        .maybeSingle();

      if (error) {
        throw error;
      }

      if (!data) {
        return res.status(404).json({ success: false, error: "Message not found" });
      }

      return res.json({ success: true, message: data });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = { createMessageRouter };
