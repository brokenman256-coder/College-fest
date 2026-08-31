# College Fest — campus board

Students share campus experience. Other students see a handle. The desk sees email, phone, and college ID so a record can be handed to authorities if there is a real case.

## What this is

- College email or phone + OTP login (`.edu` / `.ac.in` / `.edu.in`)
- Optional college ID on the account
- Sections: safety, courses, hostels, events, confessions, placements
- Search people by handle; desk search includes identity
- Unique-read tracking (one count per logged-in user or browser)
- Crypto payout requests after **25 followers** and **200 unique reads**
- Desk: ban, suspend, unsuspend, verify ID, hide posts, approve/reject/pay

## What this is not

- **No fake view bot.** Inflating reads so someone gets paid, or so the site looks bigger than it is, is fraud. Unique reads only increment when a real browser opens a post.
- **No fake student stories.** Reddit is listed as an attributed “sourced” feed with a link. It is never rewritten as an anonymous confession from this campus.
- **No Instagram scraping.** Staff paste a public event URL. A Meta Graph API connection can be added later with an official app.

If this is an awareness channel, the files have to stay real. Fake stories and fake views poison both the community and any evidence you might later share.

## Run locally

```bash
node server/index.js
```

- Student site: http://localhost:8787/
- Desk: http://localhost:8787/admin  
  Default desk login: `admin@campus.local` / `change-me-now`

Set `ADMIN_PASSWORD` and `SESSION_SECRET` before this is public. Demo OTP is returned in the login response while `ALLOW_ANY_EMAIL=true`.

Requires Node 22+ (`node:sqlite`).
