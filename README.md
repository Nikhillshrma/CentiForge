# CertiForge — Automated Certificate Generator & Smart Bulk Mailer

Generate personalised certificates from an Excel/CSV dataset on an interactive HTML5 canvas, export them as PNG/ZIP, and bulk-email them through your own SMTP account — with smart handling of duplicate email addresses.

![stack](https://img.shields.io/badge/stack-HTML5%20%7C%20Tailwind%20%7C%20Vanilla%20JS%20%7C%20Node%20%7C%20Express%20%7C%20Nodemailer-8b5cf6)

---

## 🚀 Quick start

```bash
# 1. Install dependencies
npm install

# 2. (optional) copy env defaults
cp .env.example .env

# 3. Start the server
npm start
#   CertiForge is running  ->  http://localhost:3001
```

Open **http://localhost:3001** in your browser.
Open **http://localhost:3001/demo.html** (or `index.html?demo=1`) to auto-load a generated template, a sample dataset and pre-placed fields for a quick tour.

> `npm run dev` runs the server with `node --watch` for auto-restart during development.

---

## 📁 Project structure

| Path | Purpose |
|---|---|
| `package.json` | Dependencies: `express`, `nodemailer`, `cors`, `dotenv` |
| `server.js` | Express backend — static hosting + `/api/test-smtp` + `/api/send-emails` |
| `.env.example` | `PORT` (default 3001), `SMTP_STRICT_TLS` |
| `public/index.html` | Dark SaaS dashboard UI (Tailwind CDN, Google Fonts, Font Awesome) |
| `public/styles.css` | Custom component styles (cards, chips, canvas stage, modals, progress log) |
| `public/app.js` | All frontend logic (canvas engine, DnD, SheetJS parsing, grouping, QR, ZIP, API calls) |
| `public/demo.html` | Redirects to `index.html?demo=1` (demo mode) |

---

## ✨ Features

### A. Template & dataset import
- Drag-and-drop (or click) upload of a **PNG/JPG** certificate template → rendered on a zoomable canvas at native resolution.
- Upload **.xlsx / .xls / .csv** (SheetJS). First row = headers. A preview table shows all rows; duplicate-email rows get an amber marker.
- Column headers become **draggable variable chips** (`+ name`, `+ email`, `+ team` …). Headers are normalised to keys (`Full Name` → `full_name`).
- "Load sample dataset" button for instant testing (includes duplicate emails & long names).

### B. Interactive canvas & typography
- Drag chips onto the canvas; drag fields to reposition; arrow keys nudge (Shift = 10px); `Delete` removes.
- **Live row preview** via dropdown / Prev / Next buttons or clicking a table row.
- Per-field typography panel: font family (Great Vibes, Dancing Script, Playfair Display, Montserrat, Alex Brush, Sacramento + system fonts), size, colour (picker + hex), **Bold / Italic**, alignment (left/center/right anchor), text transform (`AA` / `aa` / `Ab`), letter spacing, **text shadow** (blur, offset X/Y, colour).
- **Per-row override**: toggle "Override for current row only" and any size/position change applies only to the previewed participant (ideal for very long names). Overrides are listed and can be cleared.
- Guides overlay (bounding boxes, anchor dot, field label, auto-fit indicator, max-width box) can be toggled off.

### C. Smart email grouping (Duplicate Email Handler)
Choose Name & Email columns, then a mode:
| Mode | Certificates | Emails |
|---|---|---|
| **Per-row** | one per row | one per row |
| **Consolidated single email** | one per row (per name) | **one per unique email** with all certificates attached; `{{all_names}}` → "Priya, Rahul and Aman" |
| **Combined names on one certificate** | **one per unique email**, name field becomes "Rahul Sharma, Aman Verma & Rohit Sen" with auto-fit scaling; differing columns are merged ("Team Beta / Team Gamma") | one per unique email |

A live summary shows rows, duplicate emails, certificates to render and emails to send.

### D. Power features
- **Auto-fit text scaling** — set a *Max width* per field; text is shrunk until it fits (never below 30 % of base size).
- **Smart fields**: `certificate_id` (deterministic unique hash, configurable prefix), `qr_code` (QR of the ID, optional verification URL prefix, custom colours/size), `date`.
- **Live progress** modal: progress bar `Sent X / Total`, per-recipient status (Pending / Sending / Success / Failed with error text), counters, and **Retry Failed Emails**.

### E. Export & SMTP mailer
- **Preview PNG** of the current row and **Download All as ZIP** (full template resolution, JSZip), file names from a pattern such as `{{roll}}_{{name}}_Certificate`.
- **SMTP modal**: host, port, username, password/app-password, from-name, SSL toggle, *Test Connection* (→ `POST /api/test-smtp`), optional "remember in this browser".
- **Email composer**: subject + rich-text body, clickable placeholder chips inserted at the cursor (`{{name}}`, `{{email}}`, `{{all_names}}`, `{{count}}`, `{{certificate_id}}`, any column), live preview for the first recipient, "send only to first recipient" test switch.
- Sending renders each certificate to PNG, base64-encodes it, and posts one request per recipient to `POST /api/send-emails` with a configurable **rate-limit delay** between messages.

---

## 🔌 Backend API

### `POST /api/test-smtp`
```json
{ "host": "smtp.gmail.com", "port": 465, "user": "you@gmail.com", "pass": "app-password", "secure": true }
```
→ `{ "ok": true, "message": "SMTP connection verified successfully." }` or `{ "ok": false, "message": "..." }`

### `POST /api/send-emails`
```json
{
  "smtp": { "host": "...", "port": 465, "user": "...", "pass": "...", "secure": true, "fromName": "Event Team" },
  "delayMs": 0,
  "emails": [
    {
      "id": "g2",
      "to": "leader@example.com",
      "subject": "Your Certificates",
      "html": "<p>Hi Rahul, Aman and Rohit, …</p>",
      "attachments": [
        { "filename": "CS102_Rahul_Verma_Certificate.png", "content": "<base64>", "contentType": "image/png" },
        { "filename": "CS103_Aman_Gupta_Certificate.png", "content": "<base64>", "contentType": "image/png" }
      ]
    }
  ]
}
```
→ `{ "ok": true, "sent": 1, "failed": 0, "results": [{ "id": "g2", "to": "...", "status": "success", "messageId": "..." }] }`

SMTP credentials are passed per request and are **never stored on the server**. The JSON body limit is 200 MB to accommodate high-resolution attachments.

---

## 📧 SMTP tips
| Provider | Host | Port | Notes |
|---|---|---|---|
| Gmail | `smtp.gmail.com` | 465 (SSL) / 587 (STARTTLS) | Use an **App Password** (2FA required) |
| Outlook / M365 | `smtp.office365.com` | 587 | Uncheck SSL (STARTTLS) |
| Zoho | `smtp.zoho.com` | 465 | |
| Brevo / Mailgun / SES | provider SMTP host | 587 | Use SMTP credentials, not login password |

Keep the delay at ≥ 1000 ms for consumer providers to avoid throttling.

---

## 🗄️ Data & storage
- All dataset parsing, grouping and rendering happens **client-side**; nothing is uploaded except the final email payloads.
- `localStorage` keys: `certiforge.smtp` (only if "remember" is checked), `certiforge.subject`, `certiforge.body`.

## 🛣️ Possible next steps
- Save/load layout presets (fields JSON) per template.
- Server-side verification page for `certificate_id` QR links.
- PDF export alongside PNG.
