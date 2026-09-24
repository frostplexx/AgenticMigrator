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
#
# The extlens packages are host-only (src/extlens, the CLI) and declared as `file:../extlens/...`
# devDependencies. Those directories are outside the build context, so `npm ci` cannot resolve
# the spec and refuses the lockfile as out of sync. The container never imports them, so drop
# the entries before installing; the lockfile still satisfies everything that remains.
COPY package.json package-lock.json ./
RUN npm pkg delete 'devDependencies.@extlens/analyzer' 'devDependencies.@extlens/protocol' 'devDependencies.extlens-sdk' \
    && npm ci --omit=dev

# An MV2-capable Chrome for the behavioural BASELINE.
#
# The bundled chromium is current, and current Chrome refuses MV2 outright: measured in this image,
# an MV2 extension reports installed=false under 151 and installed=true under 116, 130 and 140. So
# the baseline never loaded, every check failed, and every instance in a run was labelled
# INVALID_INSTANCE — the corpus was ungradeable for a reason that had nothing to do with the
# extensions.
#
# 130 rather than the oldest that works: the closer the baseline browser is to the MV3 one, the
# less of the before/after difference is an artefact of a two-year gap in Chrome itself. 140 also
# loads MV2 and is closer still, but it sits deep in the removal timeline where MV2 survives only
# behind a flag — 130 predates that. Override with --build-arg when that judgement changes.
ARG MV2_CHROME_VERSION=130.0.6723.116
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
