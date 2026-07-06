# Self-rolled migrator container spike.
# Proves: headed Chromium loading an MV3 extension under Xvfb in our OWN image
# (no OpenHands agent-server), plus the pi SDK importing/constructing in-container.
#
# Base = Playwright's image: Ubuntu 22.04 + Node + Chromium + all browser deps already
# solved. PLAYWRIGHT_BROWSERS_PATH=/ms-playwright is preset, so playwright@1.49.0 finds
# the bundled Chromium without a re-download.
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

# Display stack: Xvfb (headed Chrome is REQUIRED — MV3 extensions won't load headless),
# x11vnc+noVNC for live debugging, fluxbox WM for a sane VNC view, tini as PID 1 to reap
# the swarm of Chromium child processes.
# DEBIAN_FRONTEND + TZ are set so the tzdata dep (pulled transitively) never blocks the
# build on an interactive "Geographic area:" prompt.
ENV DEBIAN_FRONTEND=noninteractive TZ=UTC
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11vnc fluxbox novnc websockify x11-utils tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY entrypoint.sh ./
RUN chmod +x entrypoint.sh
COPY verify.mjs run-migration.mjs ./
COPY fixtures ./fixtures

ENV DISPLAY=:99
# tini forwards signals + reaps zombies; entrypoint brings up Xvfb (+optional VNC) then
# exec's whatever command is passed — so `docker run img node verify.mjs <dir>` runs headed.
ENTRYPOINT ["tini","--","/app/entrypoint.sh"]
CMD ["node","verify.mjs","fixtures/migrated-mv3"]
