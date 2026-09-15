# AgenticMigrator-TS image: pi agent + headed-Chromium verify, self-rolled (no OpenHands).
# Same proven display stack as the spike. Expects `npm run build` (dist/) done on the host.
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

ENV DEBIAN_FRONTEND=noninteractive TZ=UTC
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11vnc fluxbox novnc websockify x11-utils tini curl unzip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Copy the lockfile and use `npm ci`, NOT `npm install` on package.json alone. The base image
# ships one exact browser build (chromium-1234 for v1.62.1); resolving "playwright": "^1.61.1"
# at build time floats to whatever is newest, and a newer Playwright looks for a browser
# revision the image does not contain ("Executable doesn't exist at .../chromium-1243/...").
# That makes every verify fail, and the failure is reported to the agent as if the EXTENSION
# were broken. Keep the playwright dependency pinned in step with the FROM tag above.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# An MV2-capable Chrome for the behavioural BASELINE.
#
# The bundled chromium is current, and current Chrome has removed MV2 support outright — an MV2
# extension simply never loads in it, so every baseline failed every check and every instance in a
# run was labelled INVALID_INSTANCE. Chrome for Testing 116 is the last build that still loads MV2,
# which is what makes the before/after comparison possible at all. ~150MB, fetched once per image.
ARG MV2_CHROME_VERSION=116.0.5845.96
RUN curl -fsSL -o /tmp/chrome-mv2.zip \
      "https://storage.googleapis.com/chrome-for-testing-public/${MV2_CHROME_VERSION}/linux64/chrome-linux64.zip" \
    && unzip -q /tmp/chrome-mv2.zip -d /opt \
    && mv /opt/chrome-linux64 /opt/chrome-mv2 \
    && rm /tmp/chrome-mv2.zip
ENV CHROME_OLD=/opt/chrome-mv2/chrome

COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh
COPY dist ./dist
COPY assets ./assets

ENV DISPLAY=:99
ENTRYPOINT ["tini","--","/app/entrypoint.sh"]
CMD ["node","dist/container/runMigration.js"]
