# Railway (and anything else that builds containers) uses this in preference to
# nixpacks.toml. It exists so LibreOffice and poppler are definitely present:
# without them, uploaded PowerPoint decks are rebuilt from their text rather than
# rendered slide-for-slice, which does not look like the original deck.
FROM node:24-slim

# libreoffice-impress converts .pptx to PDF; poppler-utils splits it into images.
#
# Fonts matter more than anything else here. A font PowerPoint used that is not
# installed gets swapped for one with different letter widths, the text reflows
# onto more lines than it was drawn for, and it spills over whatever was beside
# it — a slide comes out with its wording pushed into the pictures. These are
# the metric-compatible stand-ins, so substituted text occupies the same space:
#   Liberation  -> Arial, Times New Roman, Courier New
#   Carlito     -> Calibri        (default body font, Office 2007-2021)
#   Caladea     -> Cambria        (default heading font of the same era)
#   Noto/DejaVu -> a wide net for anything else, accents included
# A deck using a font with no stand-in (a brand face, or Microsoft's newer
# Aptos) can still reflow; exporting that deck to PDF from PowerPoint embeds
# its fonts and renders exactly, which the Induction decks page explains.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-impress \
      poppler-utils \
      fonts-liberation \
      fonts-liberation2 \
      fonts-dejavu-core \
      fonts-crosextra-carlito \
      fonts-crosextra-caladea \
      fonts-noto-core \
      fontconfig \
 && fc-cache -f \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server/index.js"]
