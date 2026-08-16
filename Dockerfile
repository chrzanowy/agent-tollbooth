# Node 24 for the built-in node:sqlite (zero native deps). Chromium and its
# system libraries are installed via playwright so render.extract works out
# of the box; python3 covers execute.run (node and bash are already present).
FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force
RUN npx playwright install --with-deps chromium && rm -rf /var/lib/apt/lists/*

COPY tsconfig.json ./
COPY src ./src
RUN npm install --no-save typescript && npx tsc && npm uninstall --no-save typescript

# Ownership proof for the MCP Registry: must match `name` in server.json.
LABEL io.modelcontextprotocol.server.name="io.github.chrzanowy/agent-tollbooth"

ENV TOLLBOOTH_DATA_DIR=/data
ENV PORT=4402
VOLUME ["/data"]
EXPOSE 4402

CMD ["node", "dist/index.js"]
