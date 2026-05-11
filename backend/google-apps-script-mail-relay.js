const MAIL_RELAY_SECRET = "replace-this-with-the-same-secret-you-set-in-render";

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents || "{}");

    if (payload.secret !== MAIL_RELAY_SECRET) {
      return jsonResponse({ ok: false, error: "Unauthorized" }, 403);
    }

    if (!payload.to || !payload.subject || !payload.text) {
      return jsonResponse({ ok: false, error: "Missing email fields" }, 400);
    }

    MailApp.sendEmail({
      to: payload.to,
      subject: payload.subject,
      body: payload.text,
      name: "Requisition App"
    });

    return jsonResponse({ ok: true }, 200);
  } catch (error) {
    return jsonResponse({ ok: false, error: String(error) }, 500);
  }
}

function jsonResponse(body, statusCode) {
  return ContentService
    .createTextOutput(JSON.stringify({ ...body, statusCode }))
    .setMimeType(ContentService.MimeType.JSON);
}
