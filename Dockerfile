# AgenticMigrator-TS image: pi agent + headed-Chromium verify, self-rolled (no OpenHands).
# Same proven display stack as the spike. Expects `npm run build` (dist/) done on the host.
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

ENV DEBIAN_FRONTEND=noninteractive TZ=UTC
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11vnc fluxbox novnc websockify x11-utils tini \
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

COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh
COPY dist ./dist
COPY assets ./assets

ENV DISPLAY=:99
ENTRYPOINT ["tini","--","/app/entrypoint.sh"]
CMD ["node","dist/container/runMigration.js"]
