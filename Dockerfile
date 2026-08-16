# AgenticMigrator-TS image: pi agent + headed-Chromium verify, self-rolled (no OpenHands).
# Same proven display stack as the spike. Expects `npm run build` (dist/) done on the host.
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

ENV DEBIAN_FRONTEND=noninteractive TZ=UTC
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11vnc fluxbox novnc websockify x11-utils tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh
COPY dist ./dist
COPY assets ./assets

ENV DISPLAY=:99
ENTRYPOINT ["tini","--","/app/entrypoint.sh"]
CMD ["node","dist/container/runMigration.js"]
