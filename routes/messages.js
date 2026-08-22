const express = require("express");

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

function createMessageRouter(supabase) {
  const router = express.Router();

  router.get("/:id", async (req, res, next) => {
    try {
      let query = supabase
        .from("messages")
        .select("id, inbox_address, sender, recipient, subject, text_body, html_body, message_id, content_type, attachments, headers, raw_email, raw_payload, received_at, created_at")
        .eq("id", req.params.id);

      let { data, error } = await query.maybeSingle();

      if (
        isMissingSchemaFieldError(error, "content_type") ||
        isMissingSchemaFieldError(error, "attachments") ||
        isMissingSchemaFieldError(error, "headers") ||
        isMissingSchemaFieldError(error, "raw_email") ||
        isMissingSchemaFieldError(error, "raw_payload")
      ) {
        ({ data, error } = await supabase
          .from("messages")
          .select("id, inbox_address, sender, recipient, subject, text_body, html_body, message_id, received_at, created_at")
          .eq("id", req.params.id)
          .maybeSingle());
      }

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
