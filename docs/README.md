# The guides

Two PDFs, written for two different people:

- **Front Desk Guide** — for reception, clerks and anyone working the desk. The day-to-day:
  who is expected, who is on site, deliveries, drivers, the roll call, and what to do when
  somebody cannot sign themselves in.
- **Administrator Guide** — for whoever owns the installation. Deployment, configuration,
  notifications and the chat card designer, access levels, doors, backups, recovery and
  troubleshooting.

## Rebuilding them

```bash
npm run docs
```

The sources are the `.html` files here — body content only, no `<head>`. `build.js` wraps each
one in `guide.css` and prints it through Chromium, which is what gives real page breaks, a
running footer and page numbers. The PDFs are written back into this folder.

It needs Playwright:

```bash
npm install -D playwright && npx playwright install chromium
```

## Why HTML rather than a PDF library

The wording is the point, and wording gets edited by people who are not going to open a Python
file to change a sentence. HTML keeps the text readable in a diff, keeps the styling in one
stylesheet, and lets Chromium do the typesetting — which it is considerably better at than any
library that would fit in this repository.

The fonts are the ones installed on the machine, deliberately. Charter for reading and
Liberation Sans for headings are both present wherever LibreOffice is, which is already a
requirement for rendering induction decks. A guide that fetches a webfont at render time comes
out in a fallback face the first day the network is down, and nobody notices until it is
printed.

## Keeping them honest

These describe behaviour that is covered by the test suites. When a guide and the software
disagree, one of them is a bug — check `npm test` before assuming it is the guide.

## The screenshots

`img/` holds the shots the guides use. They are taken against a seeded demo
site — invented firms, invented people, invented jobs — for the obvious reason:
these end up in a PDF that gets sent to people, and a real site's dashboard is a
list of real visitors' names, companies and arrival times.

To retake them:

```bash
DATA_DIR=/tmp/demo PORT=3512 node server/index.js &
BASE_URL=http://localhost:3512 node docs/seed-demo.js    # builds the site
BASE_URL=http://localhost:3512 node docs/shoot.js        # takes the shots
npm run docs                                             # rebuilds the PDFs
```

`seed-demo.js` puts the demo site on a west-coast clock. That is not decoration:
the shots are taken whenever they are taken, and a wall clock reading half past
eleven at night above a list of people who arrived at seven in the morning is the
first thing a reader would notice.

The visitor photos are initials on a soft field rather than faces. A stock
photograph of a person in a visitor record teaches exactly the wrong lesson about
what this system holds.

`build.js` fails the build if any figure does not load, because a broken image in
a PDF has nowhere to report itself.
