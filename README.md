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
- Device check: <http://localhost:3000/check/> — open this on a tablet to see what that browser actually
  allows (camera, storage, printing). The quickest way to find out whether a kiosk app is blocking something.
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

**Kiosk apps and the camera.** A third-party kiosk browser must both hold iOS camera permission itself and
forward the page request; ones that skip the second part deny it silently, with no prompt. If no permission
prompt ever appears, that is the cause — Safari with Guided Access is the reliable alternative, and opening
`/check/` on the tablet will confirm it either way.

**Camera note.** The kiosk uses the iPad's front camera for the badge photo. Browsers only allow the
*live preview* over `https://` or on `localhost`, so over a plain LAN address the kiosk automatically
falls back to an **Open camera** button that launches the iPad's own camera app — the photo is
captured, cropped square and attached exactly the same way. Nobody hits a dead end.

To get the inline live preview over LAN, either put a reverse proxy with a certificate in front
(Caddy does this in two lines) or run the server on the device showing the kiosk and use
`http://localhost:3000/kiosk/`. On Railway it works out of the box, since Railway serves HTTPS.

Everything else — sign-in, induction, signatures, badges, deliveries — works over plain HTTP.

### When the connection drops

The kiosk rides out an outage — a cellular tablet in a dead spot, the site router rebooting — rather
than showing a browser error. The app, the configuration, the documents and the induction slides are
kept on the device (refreshed from the server whenever it is reachable, so nothing is ever stale while
the network is up). A full sign-in works offline: details, project, photo, documents and their
questions, signature, and the induction deck in either language. Completed sign-ins are saved on the
device and recorded automatically when the connection returns, carrying the moment they actually
happened and a reference that makes each one land exactly once however many times the retry runs. A
banner on the kiosk says the connection is down and how many sign-ins are waiting.

What genuinely needs the server waits for it: recognising returning visitors (offline arrivals use
"I'm new here"), badges (no number can be issued), sign-out (the open visit lives on the server — the
kiosk says to see reception), and notifications, which go out when the sign-in is recorded.

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

**Upload a PDF if a slide's layout matters.** PowerPoint shrinks text that overflows its box and stores
only the shrink factor; LibreOffice ignores it and draws the text at full size, so a slide whose text was
already tight comes out with its words running under the pictures. Nothing on the server can undo that —
the shrunk layout only exists inside PowerPoint. **File → Export → PDF** bakes it in, and the PDF is still
split into slides here, so nothing else about the deck changes. A `.pptx` usually renders fine; check it
with **Preview** after uploading.

**Fonts decide whether a rendered slide looks right.** A font PowerPoint used that the server does not
have is swapped for one with different letter widths; the text reflows onto more lines than the slide
had room for and spills over whatever was beside it, so the wording ends up pushed into the pictures.
The image installs metric-compatible stand-ins — Liberation for Arial/Times/Courier, Carlito for
Calibri, Caladea for Cambria, Noto and DejaVu for the rest — which covers the usual Office fonts. A
deck built on a brand font, or on Microsoft's newer **Aptos**, has no stand-in and can still reflow.
The certain fix in that case takes a minute: in PowerPoint choose **File → Export → PDF** and upload
the PDF instead. A PDF carries its fonts inside it, renders exactly, and is still split into slides.

The database is a single file, so keep **one** instance running — do not scale to multiple replicas.

---

## What is in the box

### Kiosk (`/kiosk/`)

Welcome screen → sign in / sign out / delivery → visit type → returning-visitor lookup → details →
photo → document signing → induction → badge + QR code.

The home screen is built from sections. The visitor cards — which exist, their wording in both
languages, their icon, and whether each is its own card, an option behind Sign in, both, or hidden —
are managed on the **Visitor types** tab, where new types (a Cleaner card, an Auditor card) can be
added and immediately gain their own form settings, documents, induction assignment and per-device
placement. The standard set:

- **Sign in** — the general card, offering whichever types are placed behind it.
- **Sign out** — matches appear from the first letter typed, by first name, last name or phone number, each with
  the photo taken at sign-in so people pick themselves out at a glance. Photos stay behind the admin login:
  the kiosk gets a short-lived signed link that only works for that visit, only while they are on site.
- **Contractor** — straight into a contractor sign-in with no card picker in between: name, company,
  phone, and the **project** they are on, picked from the list managed on the Projects tab. No vehicle
  is asked for. Their documents and the induction deck follow as usual.
- **Interview** — candidates arriving to meet the hiring team, recorded as an interview visit without
  them choosing a visit type.
- **Driver** — truck drivers at a warehouse. Asks for the haulier, vehicle registration, load or order
  reference and whether they are delivering or collecting, and does not ask who they are visiting.
- **Delivery** — courier drop-off. Switchable in **Settings → Kiosk sign-in flow → Sections**.
- **Request entry** — appears when kiosk door unlock is switched on.

The sections can sit straight on the home screen, or behind a "Touch to start" button
(**Settings → Kiosk sign-in flow**). Background photos show behind both.

### Spanish

Switch on **Settings → Kiosk sign-in flow → Language → Offer Spanish** and the choice is offered twice:
an **English / Español** bar on the welcome screen itself, for choosing before signing in or out, and a
small button in the bottom corner of every later screen for anyone who realises partway through. The
kiosk can also start in Spanish by default. The kiosk's own wording — buttons,
prompts, field labels, error messages — is translated in the app. Everything an admin types carries an
optional Spanish box beside it: the welcome lines in Branding, each document's title and body, every
question and its choices, custom field wording, project names, and the induction confirmation line.
A box left empty falls back to English, so a half-translated site reads oddly rather than blankly.

Switching language mid-flow keeps everything already typed, answered and signed. Each visit records the
language it was made in, and each signed document records the language that was on screen when it was
signed — so it is always known which wording of a safety document a signature belongs to. Answers to
yes/no and multiple-choice questions are stored in English regardless of the language on screen, so
reports read the same either way. The language goes back to the site default when the kiosk returns to
the welcome screen.

### Projects

**Projects** (its own tab) is the list of jobs a contractor can be on site for. Each has a name, an
optional Spanish name, and an optional short code. Contractors pick one at sign-in — the project is on
the visit record, the Visits CSV, and the Projects tab shows who is on each job right now. Close a
finished job by editing it and switching **Active** off: it disappears from the kiosk but keeps its
history. A project that has ever been signed in against cannot be deleted, only closed.

- Recognises returning visitors by phone number, email, or name — one box takes any of them. Typing a
  name offers the matches to pick from, showing only a name and company, never a phone number or email.
  Switchable off in **Settings → Kiosk sign-in flow**.
- A phone number several people share — a crew on the foreman's phone — never guesses. The kiosk asks
  which of them they are before anything is prefilled, and at sign-in a shared number only matches the
  record carrying the exact name typed; anyone new on that number gets their own record instead of
  quietly overwriting somebody else's.
- Signature capture on the glass for NDAs and site rules.
- The sign-out code and its QR go on the printed badge only, not on screen — a code seen for a few seconds is no use to anyone.
- The sign-out screen opens with the badge scanner already running, so a badge can simply be held up; the
  name search sits underneath for anyone without one (**Settings → Kiosk sign-in flow**).
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
| Projects | The jobs contractors sign in against, with Spanish names, codes, and who is on each right now |
| Visitor types | The kiosk cards themselves — add, reword (in both languages), re-icon, place or hide each type |
| Printers | The label printers on site: name, model, loaded roll, colour, how each is reached, and where it sits |
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

A deck is uploaded once per language: set **Language** in the deck's settings and upload the English
and Spanish PowerPoints as two decks assigned to the same visitor types. The kiosk plays the one
matching the language chosen on screen — switching language even at the last moment switches the
deck — and falls back to English where no Spanish deck exists. Watching either language counts as
having watched the induction, so nobody sits through the same content twice in translation; bumping a
deck's version still brings back everyone who watched that deck.

Set "minimum seconds per slide" (in each deck's settings) if you need proof that people actually read
it — Next shows a countdown and only unlocks once the time is up, on every slide. A slide already sat
through stays unlocked, so going back to re-read an earlier one costs nothing, and "Watch again" after
the deck is not re-timed. Completion is stored per person with the deck version and the number of
seconds they took, and appears on the visit record.

---

## Branding

**Settings → Branding** sets the organisation name, kiosk headline and sign-out message, the two
brand colours, time zone and date format.

The **time zone** is the site's own, and everything that names a day or a time uses it: the date on a
badge and the date inside its number, the "today" counts, the activity and busiest-hour charts, and
every arrival time shown on the dashboard. Times are stored as UTC, so moving a site to a different
zone re-reads the existing history in the new one rather than shifting it. Set this before opening a
site, and leave it alone afterwards unless the site itself moves.

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

## Field wording

Field wording is editable per type under **Settings → The “Your details” form → Wording**: rename a field —
a driver is asked for a haulier, not a company — and add a line of help underneath it. Questions can carry
help text the same way.

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

### Typed wording, or an uploaded file

A document is either wording typed into the dashboard or an **uploaded PDF or Word file** (also ODT,
RTF, plain text or an image). Save the document first, then reopen it and use **Upload PDF or Word**.
The file is rendered to page images, so it is read on the kiosk exactly as it was drafted — the layout
of a safety document is part of what is being agreed to — and where there are several pages the kiosk
says so, since only part of a long one is on screen at once. Where the server cannot render pages (no
poppler), a PDF is shown as a scrollable document instead, and a Word file is converted to one first.

An uploaded file replaces the typed wording on the kiosk; **Remove file** goes back to it, and the
typed text is kept meanwhile. Spanish works the same way: upload the Spanish copy inside the
**En español** panel, and a document with no Spanish file falls back to the English one, exactly as
its typed wording would. Uploading, replacing or removing a file bumps the document's version, so
copies already signed stay exactly as they were signed.

A document can also carry its own **questions**, asked on the kiosk just above the signature:

- **Yes / No** — a tap
- **Short answer** — free text
- **Choose one** — your own options

A document with questions and the signature switched off is a **questionnaire — leave the signature off**
and the visitor simply answers and carries on; the text body can be left empty too.

A question can also depend on an earlier answer — **Only ask this if** — so a No opens the follow-up and a
Yes opens a different one. A question nobody was shown is never required of them, and if they change the
answer above it, the branch they abandoned is cleared rather than being stored.

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
millimetres. Choose whether the badge prints vertically or horizontally on that label — the label keeps its
size, the badge is turned on it — and a text-size slider scales everything together.

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
The date is the site's, taken from the time zone in Branding rather than the server's clock, so a
badge printed at 8am in New York or half past midnight in London carries the day the visitor would
write on a form. The sequence carries on from the highest number already handed out that day, so
deleting a visit leaves a gap rather than letting the next arrival be given a number someone on site
is still wearing. Changing the prefix starts a fresh sequence under the new one. With "print automatically" on, the
badge prints as soon as sign-in completes; with it off, the visitor taps **Print badge**.

With badge printing disabled, no badge numbers are issued and nothing else changes — visitors still
get an on-screen QR code for sign-out.

### Printers

The **Printers** tab is the register of label printers: name, model, which roll is loaded (and its
colour — Brother's DK-2251 prints black and red), how the printer is reached, a static IP where one is
set, and which location it sits at. Each device records which printer sits beside it under **Devices**.

Printing itself runs over AirPrint, so how a printer is *reached* matters more than anything:

- **Network** — printer and tablet share the same Wi-Fi. The normal case.
- **Wireless Direct** — for a tablet on cellular data with no site Wi-Fi: the printer hosts its own
  Wi-Fi network and the tablet joins it, keeping internet over LTE. Switch it on in the printer's menu
  (on a Brother QL-820NWB: Menu → WLAN → Wireless Direct → On; the network name and password print on
  the info sheet, and the printer answers at 192.168.118.1). On the tablet, join that network once —
  iPadOS keeps cellular data flowing for everything else.
- **Bluetooth** — recorded for inventory only: iPads can print over Bluetooth solely from the maker's
  own app, never from a web kiosk, so a Bluetooth-only printer will not print badges.

---

## Deliveries

Couriers tap **Delivery** on the kiosk, enter their name and company, choose the recipient, add a
parcel count and tracking number, and photograph the parcel. The recipient is emailed and/or posted to
chat immediately.

Reception marks parcels collected in **Deliveries**, capturing the collector's name and signature.
Everything exports to CSV.

---

## Access control

Each door is one HTTP call. That covers smart relays directly — Shelly, Tasmota, ESPHome, Home Assistant —
and reaches a proper access control panel (Honeywell, Paxton, Net2) through one: Smart Lobby calls a network
relay, the relay closes a contact across the door's REX or auxiliary input, and the panel releases the door
as if somebody had pressed the exit button. The panel keeps its own schedules, interlocks, fire release and
log, and needs nothing added to its software.

A door can be set up before it is wired: add it, write the panel, door and terminals into its wiring notes,
and leave it disabled. It stays listed, is offered on no kiosk and is never called until you tick Enabled.

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

When an unlock fails, the result says which end to go and look at — whether the relay refused the
connection, could not be found, sat on a network this server cannot reach, never answered, or answered
and turned the request down (a 401 or 403 usually being a password or token in the headers).

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

**Settings → Notifications → What has been sent** lists the last 50 attempts on every channel, with the
address or webhook, the result, and the reason for any failure — including ones skipped because a channel is
switched off. Test messages go to the address in **Send test emails to** and nowhere else; a test can never
reach a staff member or a visitor.

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
  badges.js       badge numbering, shared by sign-in and reprinting
  localtime.js    the site's day, for everything that counts one
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
