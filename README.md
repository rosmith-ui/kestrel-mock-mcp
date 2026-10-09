# Kestrel mock MCP server

Hosted copy of the mock Cloudera `get-credit-decision` MCP server for the Kestrel Agentforce demo. Synthetic data only, no auth, no secrets, no dependencies (Node 18+). It will be replaced by the real Cloudera endpoint. The source of truth is `mock-mcp/` in the main demo repo; change it there and copy it here.

```
node server.js              # http://localhost:3333/mcp
PORT=4000 node server.js
```

- `POST /mcp`: MCP Streamable HTTP, protocol 2025-06-18, tools only, plain JSON responses.
- `GET /health`: what the mock knows. `POST /admin/reset`: answers the Salesforce DemoReset callout.
- Tool `get-credit-decision` (`tool.json`) answers for KCB-00417, KCB-00418 and KCB-00419 from `payloads/`; any other borrower returns an MCP tool error.

## Render

New > Web Service > this repo > Language: Docker > instance type of your choice > Health Check Path `/health`. No environment variables: Render sets `PORT` and the server reads it.

Take down: Render > the service > Settings > Delete Web Service, then delete this repo.
