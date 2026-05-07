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

3. Fill in one email provider:

   ```text
   RESEND_API_KEY=re_xxxxxxxxx
   RESEND_FROM_EMAIL=Requisition App <noreply@yourdomain.com>
   ```

   Resend is the recommended provider for Render free services because it uses HTTPS instead of SMTP ports.

   Optional local SMTP fallback:

   ```text
   GMAIL_USER=your-gmail-address@gmail.com
   GMAIL_APP_PASSWORD=your-16-character-google-app-password
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=465
   SMTP_SECURE=true
   ```

4. Start the backend:

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

## Render + PostgreSQL

The repo root includes `render.yaml` for Render Blueprints. It creates:

- A Node web service from the `backend` folder.
- A Render PostgreSQL database.
- A `DATABASE_URL` environment variable wired from the database connection string.

After creating the Blueprint on Render, add these service environment variables in the Render dashboard:

```text
RESEND_API_KEY=re_xxxxxxxxx
RESEND_FROM_EMAIL=Requisition App <noreply@yourdomain.com>
```

`RESEND_FROM_EMAIL` must use a domain you verified in Resend. The default `resend.dev` domain is only for limited testing to your own email address.

Then update the Expo app to use the Render service URL:

```powershell
$env:EXPO_PUBLIC_API_URL="https://requisition-app-api.onrender.com"
npx.cmd expo start --clear
```
