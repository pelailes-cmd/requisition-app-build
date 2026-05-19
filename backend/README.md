# Requisition App Backend

This backend sends one-time sign-up codes to the selected manager and stores accounts and requisitions in a database.

Local development uses SQLite automatically. Render deployment uses PostgreSQL when `DATABASE_URL` is set.

## Setup

1. Install dependencies:

   ```powershell
   cd backend
   npm install
   ```

2. Copy `.env.example` to `.env`.

3. Fill in the Google Apps Script mail relay values:

   ```text
   MAIL_RELAY_URL=https://script.google.com/macros/s/your-deployment-id/exec
   MAIL_RELAY_SECRET=use-a-long-random-secret-here
   ```

   The relay is recommended for Render free services when you do not have a verified sending domain. It uses HTTPS, so it avoids Render's blocked SMTP ports.

   Optional Resend fallback if you later verify a domain:

   ```text
   RESEND_API_KEY=re_xxxxxxxxx
   RESEND_FROM_EMAIL=Requisition App <noreply@yourdomain.com>
   ```

   Optional local SMTP fallback:

   ```text
   GMAIL_USER=your-gmail-address@gmail.com
   GMAIL_APP_PASSWORD=your-16-character-google-app-password
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=465
   SMTP_SECURE=true
   ```

4. Add paid Manager access values:

   ```text
   MANAGER_ACCESS_AMOUNT_PHP=3500
   CREATOR_APPROVAL_SECRET=use-a-long-random-secret-here
   PUBLIC_API_URL=https://requisition-app-api.onrender.com
   ```

   `CREATOR_APPROVAL_SECRET` protects the email approval link that generates temporary Manager credentials after you manually verify the Maya QR payment.

5. Start the backend:

   ```powershell
   npm start
   ```

The Expo app expects this backend at `https://requisition-app-api.onrender.com`.

The database is created automatically at `backend/data/requisition.sqlite`. If accounts are empty, the default manager account is seeded:

```text
username: pelailes
password: pel291999
role: Manager
```

If requisitions are empty, the demo requisitions are seeded once. New requests, edits, status changes, and deletes are stored in the same database so multiple devices using the backend see the same data.

## Google Apps Script Mail Relay

1. Open https://script.google.com and create a new project.
2. Paste the contents of `backend/google-apps-script-mail-relay.js`.
3. Set `MAIL_RELAY_SECRET` in the script to the same long random secret used in Render.
4. Deploy it as a Web app.
5. Set "Execute as" to your account.
6. Set "Who has access" to anyone.
7. Copy the Web app URL into Render as `MAIL_RELAY_URL`.

## Render + PostgreSQL

The repo root includes `render.yaml` for Render Blueprints. It creates:

- A Node web service from the `backend` folder.
- A Render PostgreSQL database.
- A `DATABASE_URL` environment variable wired from the database connection string.

After creating the Blueprint on Render, add these service environment variables in the Render dashboard:

```text
MAIL_RELAY_URL=https://script.google.com/macros/s/your-deployment-id/exec
MAIL_RELAY_SECRET=use-a-long-random-secret-here
MANAGER_ACCESS_AMOUNT_PHP=3500
CREATOR_APPROVAL_SECRET=use-a-long-random-secret-here
PUBLIC_API_URL=https://requisition-app-api.onrender.com
```

`MAIL_RELAY_SECRET` must be the same value you paste into `backend/google-apps-script-mail-relay.js` before deploying it in Google Apps Script.

Then update the Expo app to use the Render service URL:

```powershell
$env:EXPO_PUBLIC_API_URL="https://requisition-app-api.onrender.com"
npx.cmd expo start --clear
```

To show your Maya Business QR image inside Expo Go, also set this before starting Expo:

```powershell
$env:EXPO_PUBLIC_MAYA_QR_IMAGE_URL="https://your-public-image-url/maya-qr.png"
$env:EXPO_PUBLIC_MAYA_QR_DISPLAY_NAME="Your Maya Business Name"
npx.cmd expo start --clear
```

## Manual Maya QR Approval

The Manager access flow uses manual QR payment review:

1. User scans or uses your Maya Business QR and pays `MANAGER_ACCESS_AMOUNT_PHP`.
2. User submits their Maya sender name and payment reference in the app.
3. Backend emails the creator with the payment details and approval link.
4. Creator verifies the transaction in the Maya Business app.
5. Creator clicks the approval link, and the backend generates temporary Manager credentials and emails the requester.
