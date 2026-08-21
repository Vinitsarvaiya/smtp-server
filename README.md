# Temporary Email Receiver

Simple temporary email web app built with Node.js, Express, Supabase, plain HTML, plain CSS, and vanilla JavaScript. The app creates disposable inboxes, accepts inbound email through an HTTP webhook, stores messages in Supabase, and shows the inbox in a lightweight browser UI.

## Project Structure

```text
temp-mail/
|-- server.js
|-- package.json
|-- .env.example
|-- .gitignore
|-- README.md
|-- supabase-schema.sql
|-- lib/
|   `-- supabase.js
|-- routes/
|   |-- inbox.js
|   |-- messages.js
|   `-- webhook.js
|-- utils/
|   |-- cleanup.js
|   |-- email.js
|   |-- generateEmail.js
|   `-- inboxes.js
`-- public/
    |-- index.html
    |-- style.css
    `-- app.js
```

## 1. Install

```bash
npm install
```

## 2. Create Supabase Project

Create a new Supabase project. In the Supabase dashboard:

- `Project Settings` -> `Data API` contains `SUPABASE_URL`
- `Project Settings` -> `API Keys` contains `service_role`, which is `SUPABASE_SERVICE_ROLE_KEY`

Keep the service-role key server-side only. Never put it in frontend code.

## 3. Run SQL

Open the Supabase SQL Editor and run the contents of [supabase-schema.sql](./supabase-schema.sql).

This creates:

- `inboxes`
- `messages`
- indexes for inbox lookup, received time, and cleanup
- a foreign key with `ON DELETE CASCADE`

## 4. Create `.env`

Copy `.env.example` to `.env` and fill in your values:

```env
PORT=3000
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=xxxxx
TEMP_MAIL_DOMAIN=fujitoratakoriko.publicvm.com
WEBHOOK_SECRET=choose-a-long-random-secret
RESEND_WEBHOOK_SECRET=whsec_xxxxx
EMAIL_EXPIRY_HOURS=24
```

## 5. Run Locally

```bash
npm run dev
```

Open:

- `http://localhost:3000`
- `http://localhost:3000/health`

## 6. Test Incoming Email Webhook

Use this example after the server is running:

```bash
curl -X POST http://localhost:3000/api/webhooks/incoming-email \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_WEBHOOK_SECRET" \
  -d '{
    "sender": "sender@gmail.com",
    "recipient": "test123@fujitoratakoriko.publicvm.com",
    "subject": "Test Email",
    "text": "Hello from webhook",
    "html": "<p>Hello from webhook</p>",
    "messageId": "test-001"
  }'
```

The backend normalizes common alternate fields too:

- `from`
- `to`
- `text_body`
- `html_body`
- `message_id`

The same endpoint also supports Resend `email.received` webhooks. For Resend:

- configure the webhook signing secret as `RESEND_WEBHOOK_SECRET`
- send the webhook to `/api/webhooks/incoming-email`
- the app verifies `svix-id`, `svix-timestamp`, and `svix-signature` using the raw request body

Resend `email.received` events only include metadata in the webhook payload. This app stores:

- `data.from`
- the first recipient in `data.to`
- `data.subject`
- `data.message_id` or `data.email_id`

The text and HTML body fields remain empty unless you later extend the app to fetch full content from Resend's Receiving API.

## 7. Deploy to Render

Create one Render Web Service.

- Build Command: `npm install`
- Start Command: `npm start`

Set these environment variables in Render:

- `PORT`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `TEMP_MAIL_DOMAIN`
- `WEBHOOK_SECRET`
- `RESEND_WEBHOOK_SECRET`
- `EMAIL_EXPIRY_HOURS`

The server listens on `0.0.0.0` and uses `process.env.PORT || 3000`.

## 8. Health Monitor

Use an external monitor to request:

```text
https://YOUR-RENDER-DOMAIN.onrender.com/health
```

about every 10 minutes. Do not add a self-ping loop inside the app.

## 9. Incoming Email Architecture

Render does not receive SMTP directly.

```text
Website/API DNS:
api.fujitoratakoriko.publicvm.com
  -> Render
```

```text
Email flow:
anything@fujitoratakoriko.publicvm.com
  -> DNSExit MX
  -> inbound email provider
  -> HTTP webhook
  -> Render
  -> Supabase
```

The MX records depend on whichever inbound provider you choose later.

## API Summary

- `GET /health`
- `GET /api/health`
- `POST /api/inbox/create`
- `GET /api/inbox/:address/messages`
- `DELETE /api/inbox/:address`
- `GET /api/messages/:id`
- `POST /api/webhooks/incoming-email`

## Security Notes

- Supabase service-role key is used only on the backend.
- Webhook supports `Authorization: Bearer <secret>` and `x-webhook-secret: <secret>`.
- Resend webhooks are verified with `RESEND_WEBHOOK_SECRET` and the Svix signature headers.
- Recipients are normalized to lowercase and validated against `TEMP_MAIL_DOMAIN`.
- Duplicate `messageId` deliveries are ignored.
- Request JSON body is limited to 5 MB.
- The viewer renders escaped text content rather than untrusted HTML.
- `.env` is ignored by git.
