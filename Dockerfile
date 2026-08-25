# Railway (and anything else that builds containers) uses this in preference to
# nixpacks.toml. It exists so LibreOffice and poppler are definitely present:
# without them, uploaded PowerPoint decks are rebuilt from their text rather than
# rendered slide-for-slice, which does not look like the original deck.
FROM node:24-slim

# libreoffice-impress converts .pptx to PDF; poppler-utils splits it into images.
# The fonts are metric-compatible stand-ins for Arial, Times and Calibri, so text
# on a rendered slide keeps the spacing it had in PowerPoint.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-impress \
      poppler-utils \
      fonts-liberation \
      fonts-liberation2 \
      fonts-dejavu-core \
      fonts-crosextra-carlito \
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
