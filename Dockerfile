# Kestrel mock MCP server. Synthetic data only, no auth, no secrets, no dependencies.
#   docker build -t kestrel-mock-mcp mock-mcp && docker run -p 3333:3333 kestrel-mock-mcp
FROM node:22-alpine
WORKDIR /app
COPY package.json server.js tool.json ./
COPY payloads ./payloads
ENV PORT=3333 NODE_ENV=production
EXPOSE 3333
USER node
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1
CMD ["node", "server.js"]
