# Deploy guide — College Fest board

## Recommended: Railway (runs the Node server + MongoDB Atlas)

1. Push this folder to a GitHub repo.
2. On https://railway.app → **New Project → Deploy from GitHub repo**.
3. In the service → **Variables**, add (copy from your `.env`, never commit it):

   ```
   MONGO_URI=mongodb+srv://USER:PASSWORD@cluster0.xxx.mongodb.net/?appName=Cluster0
   MONGO_DB=collegefest
   ADMIN_EMAIL=your-admin@example.com
   ADMIN_PASSWORD=a-long-random-password
   SESSION_SECRET=a-long-random-string
   ALLOW_ANY_EMAIL=false
   CLOUDINARY_CLOUD_NAME=...
   CLOUDINARY_API_KEY=...
   CLOUDINARY_API_SECRET=...
   RESEND_API_KEY=re_xxxxxxxx        # real OTP emails (empty = demo mode shows OTP on screen)
   EMAIL_FROM=College Fest <onboarding@resend.dev>
   TWILIO_ACCOUNT_SID=ACxxxxxxxx    # optional: OTP by SMS
   TWILIO_AUTH_TOKEN=xxxxxxxx
   TWILIO_FROM_NUMBER=+1xxxxxxxxxx
   ```

4. Railway injects `PORT` automatically — the server already uses it.
5. Deploy. Health check hits `/api/health`. Then **Settings → Networking → Generate Domain** for a public URL.
6. In MongoDB Atlas → Network Access, allow `0.0.0.0/0` (or Railway egress IPs) so the server can connect.

## Why not Netlify for the app?

Netlify hosts static files / serverless functions — it cannot run this
long-lived `http.createServer` process. You can host just the `public/`
folder on Netlify, but the API must live on Railway (or Render/Fly/Render).
Simplest path: deploy everything on Railway.

## Local development

```bash
npm install
npm run dev        # http://localhost:8787  (admin desk at /admin)
```

## Notes

- `chats`, `users`, `posts`, etc. live in MongoDB Atlas (db: `collegefest`).
- Without Cloudinary keys, chat photos are saved to `public/uploads/`
  (fine locally; on Railway use Cloudinary since the filesystem is ephemeral).
- Blog bot publishes labeled research briefs hourly; toggle in the admin desk.