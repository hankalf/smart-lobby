# Smart Lobby

A self-hosted visitor management and digital reception system. Covers what SmartLobby.co does —
kiosk sign-in, staff notifications, NDA/site-rule signing, QR sign-out, optional badge printing,
multi-site, roll call, analytics — plus three additions:

- **Induction slideshow** — upload a PowerPoint/PDF; first-time visitors watch it before they finish
  signing in, and anyone who has already seen the current version skips it automatically.
- **Deliveries** — couriers log parcels at the kiosk with a photo, the recipient is notified, and
  collection is signed for at reception.
- **Access control** — doors, barriers and gates unlocked from the kiosk, the dashboard, or
  automatically on sign-in.

No SaaS account, no per-seat pricing, no data leaving your building. One Node process, one SQLite file.

---

## Running it

```bash
npm install
npm start
```

- Kiosk: <http://localhost:3000/kiosk/>
- Admin: <http://localhost:3000/admin/>

The first time you open the admin URL it asks you to create the owner account. That is the whole
installation.

To use a different port: `PORT=3010 npm start`.

### Where the data lives

Everything is under `data/`:

```
data/smartlobby.db          SQLite database
data/uploads/public/        logo, induction slides   (served without login)
data/uploads/private/       visitor photos, signatures, parcel photos (login required)
```

Back up that folder and you have backed up the entire system. Copy it to another machine and the
system moves with it.

---

## The two deployment shapes you asked about

### 1. On an iPad (or any single device on your own network)

The iPad runs the kiosk in Safari; the server runs on a small always-on machine on the same network —
a Mac mini, a NUC, an old laptop or a Raspberry Pi. iPadOS cannot host the Node server itself.

1. On the host machine: `npm install && npm start`.
2. Find its LAN address (`ipconfig` on Windows, `ifconfig` on macOS/Linux) — e.g. `192.168.1.40`.
3. On the iPad, open `http://192.168.1.40:3000/kiosk/`, then Share → **Add to Home Screen**. Launched
   from the home screen it runs full screen with no browser chrome.
4. Turn on **Guided Access** (Settings → Accessibility) so visitors cannot leave the app.

**Camera note.** The kiosk uses the iPad's front camera for the badge photo. Browsers only allow the
*live preview* over `https://` or on `localhost`, so over a plain LAN address the kiosk automatically
falls back to an **Open camera** button that launches the iPad's own camera app — the photo is
captured, cropped square and attached exactly the same way. Nobody hits a dead end.

To get the inline live preview over LAN, either put a reverse proxy with a certificate in front
(Caddy does this in two lines) or run the server on the device showing the kiosk and use
`http://localhost:3000/kiosk/`. On Railway it works out of the box, since Railway serves HTTPS.

Everything else — sign-in, induction, signatures, badges, deliveries — works over plain HTTP.

### 2. On Railway

1. Push this folder to a Git repository and create a Railway project from it.
2. Add a **Volume** and mount it at `/data`. **This is not optional** — without it the database and
   every uploaded photo and slide is erased on each deploy. The app detects the volume automatically,
   and refuses to stay quiet if it is missing: a banner appears in the dashboard, the login screen
   says so, `/api/health` reports `"storage":"ephemeral"`, and the deploy log prints a warning.
3. Set variables:
   - `DATA_DIR=/data` (optional — a Railway volume is picked up automatically)
   - `NODE_ENV=production`
   - `PUBLIC_URL=https://your-app.up.railway.app` (used for photo links inside notification emails)
4. Deploy. Railway provides HTTPS, so the kiosk camera works out of the box.

The included `Dockerfile` installs LibreOffice, poppler and metric-compatible fonts, so uploaded
PowerPoint decks render exactly as they look in PowerPoint. Railway uses a Dockerfile in preference to
any other builder, so nothing needs configuring — but it does make the image around a gigabyte and the
first build slow. If you would rather have small, fast builds and are happy with decks being rebuilt
from their text, delete the Dockerfile and upload PDF exports instead.

Check which you have at any time: `/api/health` reports `slide_rendering`, and the **Induction decks**
page says plainly whether it can render properly.

The database is a single file, so keep **one** instance running — do not scale to multiple replicas.

---

## What is in the box

### Kiosk (`/kiosk/`)

Welcome screen → sign in / sign out / delivery → visit type → returning-visitor lookup → details →
photo → document signing → induction → badge + QR code.

The home screen is built from sections:

- **Sign in** — visitors and contractors.
- **Sign out** — matches appear from the first letter typed, by first name, last name or phone number, each with
  the photo taken at sign-in so people pick themselves out at a glance. Photos stay behind the admin login:
  the kiosk gets a short-lived signed link that only works for that visit, only while they are on site.
- **Interview** — candidates arriving to meet the hiring team, recorded as an interview visit without
  them choosing a visit type.
- **Driver** — truck drivers at a warehouse. Asks for the haulier, vehicle registration, load or order
  reference and whether they are delivering or collecting, and does not ask who they are visiting.
- **Delivery** — courier drop-off. Switchable in **Settings → Kiosk sign-in flow → Sections**.
- **Request entry** — appears when kiosk door unlock is switched on.

The sections can sit straight on the home screen, or behind a "Touch to start" button
(**Settings → Kiosk sign-in flow**). Background photos show behind both.

- Recognises returning visitors by phone number, email, or name — one box takes any of them. Typing a
  name offers the matches to pick from, showing only a name and company, never a phone number or email.
  Switchable off in **Settings → Kiosk sign-in flow**.
- Signature capture on the glass for NDAs and site rules.
- The sign-out code and its QR go on the printed badge only, not on screen — a code seen for a few seconds is no use to anyone.
- Visitors with a printed badge can scan it at the kiosk to sign out (**Settings → Kiosk sign-in flow**).
  Browsers with a native barcode reader use it; iPad Safari and WKWebView kiosk apps get a bundled
  decoder, fetched only when the scanner is opened, so it works offline.
- An abandoned sign-in is wiped when the kiosk returns to the welcome screen: every field, the captured
  photo and any answers given, so nothing of one visitor is left on screen for the next.
- Times out back to the welcome screen after 90 seconds of nobody touching it (12 on the thank-you
  screen), both configurable; signs out anyone left on site at a time you set (23:59 by default),
  in the site time zone, and only during that minute so a late arrival is not signed straight back out.

### Admin (`/admin/`)

| Section | What it does |
| --- | --- |
| Dashboard | Who is on site right now, today's numbers, 14-day trend, emergency roll call, sign-out-everyone |
| Visits | Every sign-in, filterable, CSV export, per-visit detail with photo, signature and notification log |
| Visitor registry | Everyone on file, induction status per person, block a visitor, reset their induction |
| Drivers | Truck drivers on site with an editable door number, and the full driver log, searchable by driver, haulier, vehicle or reference, with turnaround times and CSV export |
| Deliveries | Parcels awaiting collection, collect with signature, re-notify, CSV export |
| Induction decks | Upload/replace decks, reorder and delete slides, preview, per-visit-type targeting |
| Badges | Badge design, label size, live preview, test print and reprinting |
| Documents | NDAs, site rules and declarations — assigned to categories, each with its own questions, versioned |
| Staff | People visitors ask for, each with their own email, mobile and chat webhook. Bulk import from Excel or CSV |
| Access & doors | HTTP-controlled doors, test unlock, unlock audit trail |
| Locations | Areas within a site — reception, yard gate, workshop entrance — with device and on-site counts |
| Devices | Every tablet: name, location, default camera, operational mode, per-device badge printing, which cards it shows and in what order, online status |
| Reports | Visits per day, busiest hosts, top companies, arrival times, average time on site |
| Settings | Branding (logo, kiosk background photo, colours, time zone), kiosk flow, badges, induction, deliveries, access, notifications, retention, users |

---

## Induction slideshows

Create a deck in **Induction decks**, then drop a `.pptx`, `.pdf` or image onto it.

How the file is turned into slides, best first:

1. **LibreOffice + poppler installed** → each slide is rendered to a PNG. Pixel perfect.
2. **PowerPoint, no LibreOffice** → the `.pptx` is unpacked and each slide rebuilt from its text and
   images. Layout is approximate; content is all there.
3. **PDF, no poppler** → shown as one scrollable embedded document.
4. **Images** → one slide each, appended in upload order.

Uploading a new file **replaces** the slides and bumps the deck version, which is deliberate: everyone
sees the new induction once, including people who had watched the old one.

Who has to watch it:

- First-time visitors — always.
- Returning visitors — only if the deck version changed since they last watched, or if you set
  "repeat after N days", or if you tick "show it every visit".
- Reset one person from **Visitor registry → Open → Reset induction**.

Set "minimum seconds per slide" if you need proof that people actually read it — the Next button
stays disabled until the timer runs out. Completion is stored per person with the deck version and
the number of seconds they took, and appears on the visit record.

---

## Branding

**Settings → Branding** sets the organisation name, kiosk headline and sign-out message, the two
brand colours, time zone and date format.

- **Logo** — appears on the kiosk welcome screen, on printed badges, in the dashboard sidebar and on
  the admin sign-in page. PNG or SVG with a transparent background works best.
- **Welcome text position** — place the headline, sub-heading and button left, centre or right, and
  top, middle or bottom, so they sit clear of whatever is in the background photo. A live preview in
  Settings mirrors the kiosk.
- **Welcome footer** — the time and organisation name along the bottom of the welcome screen, off by
  default.
- **Kiosk background** — one photo behind the welcome screen, or several that crossfade on a timer
  (8 seconds to 5 minutes, up to 20 photos, selectable in one go). A slider controls how much they are
  darkened so the welcome text stays readable, with a live preview beside it. Landscape, 1600px wide
  or more. Leave it empty for the plain gradient. Rotation pauses while somebody is signing in.

Uploads are checked by their actual bytes rather than their file extension, so a mislabelled file is
rejected instead of becoming a broken image on the kiosk. Replacing an image deletes the old file.

---

## Changes reaching the kiosks

Every change saved in the dashboard bumps a configuration revision. Kiosks check in every 20 seconds and
reload their settings when that number moves, so branding, sections, form fields, documents and
inductions all reach the tablets by themselves.

A kiosk part-way through a sign-in waits: it applies the change once the visitor has finished and the
screen is back at the welcome page, so nobody has a form rearranged under them mid-typing.

---

## The order things are asked

**Settings → The order things are asked.** Each visitor type has its own order for the four sign-in
steps — their details, photo, documents and questions, induction deck — reorderable with the arrows.
A contractor can watch the induction before signing anything, while visitors keep the usual order.

Finding the visitor always comes first, because it decides whether the induction is needed at all. A
step that does not apply is skipped wherever it sits.

---

## Documents and questions

Each document in **Documents** is assigned to the categories that must sign it, matching the kiosk
home-screen cards:

| Category | Card |
| --- | --- |
| Visitors, Contractors | Sign in / Sign out |
| Interviews | Interview |
| Drivers | Driver |

Deliveries sign nothing.

A document can also carry its own **questions**, asked on the kiosk just above the signature:

- **Yes / No** — a tap
- **Short answer** — free text
- **Choose one** — your own options

A document with questions and the signature switched off is a **questionnaire — leave the signature off**
and the visitor simply answers and carries on; the text body can be left empty too.

Mark a question as required and the visitor cannot continue until it is answered. Answers are stored
against that visit alongside the signature, and shown on the visit record with the wording used at
the time — so a later edit to a question never changes what a past answer appears to mean.

Where more than one document applies to a category, they are signed one after another, titled
"Site rules (1 of 2)" and so on, each with its own questions and signature.

---

## Staff

The people visitors ask for. Each can have an email address, a mobile number for SMS and their own
chat webhook, so alerts reach them directly.

**Add several at once from a spreadsheet** — upload an `.xlsx` or `.csv`. The first row should be
headings — first and last name in separate columns, or a single full-name column; only the name is required, and headings are matched loosely, so "Full name", "Phone",
"Mobile", "Team" and similar all work. Someone already on the list is updated rather than
duplicated — matched on email, or on name where there is no email — so a corrected sheet can simply
be uploaded again. A template is downloadable from that panel.

---

## Changes reaching the kiosks

Every change saved in the dashboard bumps a configuration revision. Kiosks check in every 20 seconds and
reload their settings when that number moves, so branding, sections, form fields, documents and
inductions all reach the tablets by themselves.

A kiosk part-way through a sign-in waits: it applies the change once the visitor has finished and the
screen is back at the welcome page, so nobody has a form rearranged under them mid-typing.

---

## The order things are asked

**Settings → The order things are asked.** Each visitor type has its own order for the four sign-in
steps — their details, photo, documents and questions, induction deck — reorderable with the arrows.
A contractor can watch the induction before signing anything, while visitors keep the usual order.

Finding the visitor always comes first, because it decides whether the induction is needed at all. A
step that does not apply is skipped wherever it sits.

---

## Documents and questions

Each document in **Documents** is assigned to the categories that must sign it, matching the kiosk
home-screen cards:

| Category | Card |
| --- | --- |
| Visitors, Contractors | Sign in / Sign out |
| Interviews | Interview |
| Drivers | Driver |

Deliveries sign nothing.

A document can also carry its own **questions**, asked on the kiosk just above the signature:

- **Yes / No** — a tap
- **Short answer** — free text
- **Choose one** — your own options

A document with questions and the signature switched off is a **questionnaire — leave the signature off**
and the visitor simply answers and carries on; the text body can be left empty too.

Mark a question as required and the visitor cannot continue until it is answered. Answers are stored
against that visit alongside the signature, and shown on the visit record with the wording used at
the time — so a later edit to a question never changes what a past answer appears to mean.

Where more than one document applies to a category, they are signed one after another, titled
"Site rules (1 of 2)" and so on, each with its own questions and signature.

---

## Staff

The people visitors ask for. Each can have an email address, a mobile number for SMS and their own
chat webhook, so alerts reach them directly.

**Add several at once from a spreadsheet** — upload an `.xlsx` or `.csv`. The first row should be
headings — first and last name in separate columns, or a single full-name column; only the name is required, and headings are matched loosely, so "Full name", "Phone",
"Mobile", "Team" and similar all work. Someone already on the list is updated rather than
duplicated — matched on email, or on name where there is no email — so a corrected sheet can simply
be uploaded again. A template is downloadable from that panel.

---

## Badges (optional)

Off by default. The **Badges** tab holds the lot: whether badges print at all, the label stock, what the
badge shows, a live preview at the real size, a test print, and reprinting.

**Label size** — pick your stock from a list of common Brother and Dymo rolls, or set width and height in
millimetres. A text-size slider scales everything on the badge together.

**Reprinting** — badges from the last week are listed, searchable by name, company or badge number, with a
Reprint button; the same is on the dashboard beside anyone on site. A visit that never had a number
(badges were off at the time) is issued one at that point rather than printing a blank.

Setup:

1. Connect the label printer to the device showing the kiosk (USB, or a network/AirPrint printer).
2. Make it the default printer on that device.
3. Set the label size in **Settings** to match your stock — 62 × 100 mm is a common Brother size.
4. In Chrome/Edge print settings: margins **None**, headers and footers **off**, background graphics
   **on**. On iPad, AirPrint remembers the printer you pick.
5. Print a test badge and adjust width/height/font scale until it lines up.

You choose what appears: logo, photo, company, host, date, time, badge number, sign-out QR code,
header and footer text. Badge numbers look like `NTB260825-004` (prefix, date, sequence for the day).
With "print automatically" on, the badge prints as soon as sign-in completes; with it off, the visitor
taps **Print badge**.

With badge printing disabled, no badge numbers are issued and nothing else changes — visitors still
get an on-screen QR code for sign-out.

---

## Deliveries

Couriers tap **Delivery** on the kiosk, enter their name and company, choose the recipient, add a
parcel count and tracking number, and photograph the parcel. The recipient is emailed and/or posted to
chat immediately.

Reception marks parcels collected in **Deliveries**, capturing the collector's name and signature.
Everything exports to CSV.

---

## Access control

Each door is one HTTP call, which covers most smart relays and controllers — Shelly, Tasmota,
ESPHome, Home Assistant, Ubiquiti Access, Paxton Net2's web API, or any webhook.

Add a door in **Access & doors** with a URL, method, optional headers and body. These placeholders are
filled in at unlock time: `{{seconds}}`, `{{door}}`, `{{actor}}`, `{{visit_id}}`, `{{timestamp}}`.

Examples:

```
Shelly relay      GET   http://192.168.1.50/relay/0?turn=on&timer={{seconds}}
Home Assistant    POST  http://192.168.1.10:8123/api/services/lock/unlock
                  Headers: {"Authorization":"Bearer YOUR_TOKEN"}
                  Body:    {"entity_id":"lock.front_door"}
```

Doors can fire automatically on sign-in, on sign-out, from a **Request entry** button on the kiosk, or
from **Test unlock** in the dashboard. Every attempt is logged with who, when, why and the result.

---

## Notifications

**Settings → Notifications.** Four channels, each independently switchable, with a test button:

| Channel | Setup | Notes |
| --- | --- | --- |
| **Email** | SMTP host, port, user, password | Any provider — Google Workspace, Microsoft 365, Fastmail, Postmark, SES. Includes the visitor's photo. |
| **Slack** | Incoming webhook URL | Posts the arrival with the visitor's photo as a thumbnail. |
| **Microsoft Teams** | Workflows URL | Posts to a channel, or as a DM to one person. Sent as an Adaptive Card, which is what Workflows requires — the old MessageCard format is refused with a 400. See the guide in **Staff**. |
| **Google Chat** | Incoming webhook URL | Same webhook field, pick the format. |
| **Generic JSON** | Any URL | `{event, details[], photo_url, timestamp}` — use it to drive anything else. |
| **SMS** | Twilio Account SID, Auth Token, from-number | Texts the staff member's mobile. Numbers are converted to E.164, so `07700 900123` works. |

Chat notifications go to two places at once: a **company channel** that sees every arrival, and each
person's **own webhook** for their own visitors. Switch the channel off being always-on and it becomes a
fallback for people who have no webhook of their own.

Each staff member can have their own email address, mobile number and chat webhook, so alerts land with the
right person rather than a shared inbox. Set them in **Staff**, which carries step-by-step setup
instructions for Slack, Teams and Google Chat.

The payload format is detected from the webhook URL, so one host can be on Slack and another on
Teams. The format dropdown in Settings only applies to URLs that are not recognised.

You control which events fire on each channel: arrival, sign-out, and delivery are separate toggles,
and SMS has its own arrival/delivery toggles so you can keep texts for arrivals only.

Nothing is sent until you configure it — until then arrivals are logged and shown on the dashboard,
and the notification log records `skipped_disabled`. A channel failing never blocks a sign-in: the
visitor completes, and the reason is recorded against the visit (visible in **Visits → View**).

Secrets (SMTP password, Twilio token) are write-only in the API — they come back masked and the mask
is never written back over the real value.

---

## Privacy and retention

Visitor photos and signatures sit behind the admin login; only the logo and induction slides are
public. **Settings → Data retention** deletes photos after N days and visit records after N days,
which runs daily. Blocked visitors are stopped at the kiosk with a neutral "please see reception"
message.

---

## Project layout

```
server/
  index.js        express app, static hosting, QR endpoint, retention + auto-sign-out jobs
  db.js           SQLite schema and query helpers (node:sqlite — no native modules)
  settings.js     typed defaults, deep-merged over stored overrides
  auth.js         cookie sessions, bcrypt passwords
  notify.js       SMTP and Slack/Teams webhooks
  access.js       door triggering and unlock audit
  slides.js       PowerPoint/PDF/image → slides
  unzip.js        minimal ZIP reader so .pptx needs no dependency
  routes/
    kiosk.js      public kiosk API
    admin.js      authenticated dashboard API
public/
  kiosk/          the reception app
  admin/          the dashboard
  shared/theme.css
```

Dependencies: express, multer, nodemailer, bcryptjs, qrcode, dotenv. SQLite comes from Node itself,
so there is no compiler step and nothing to rebuild when Node updates.
