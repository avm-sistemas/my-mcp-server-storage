# my-mcp-server-storage

Persistent-memory (SQLite) MCP server, derived from `my-local-storage-mcp`.
Features the same tools (`remember_fact`, `recall_facts`, `recall_by_topic`), the same consolidation logic, and the same plugin system.

Key changes: it uses **Streamable HTTP** instead of stdio, requires a **token**, and stores the database in a **Docker volume**.

## How to use

```bash
cp .env.example .env
# edit .env e put a token: openssl rand -hex 32
docker compose up -d --build
curl http://localhost:2461/health      # {"status":"ok"}
```

The database is located in the `mcp-storage-data` volume (`/data/storage.db` inside the container).
To use a host directory instead of a named volume, replace the volume line with `./data:/data`
(use a local disk; SQLite with WAL is not compatible with NFS/SMB).

## Backup

```bash
docker run --rm -v my-mcp-server-storage_mcp-storage-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/storage-$(date +%F).tgz -C /data .
```

(The volume name includes the project folder prefix; check it using `docker volume ls`.)

## Environment

| Variable | Default value | Description |
|---|---|---|
| `MCP_AUTH_TOKEN` | — (required) | Token Bearer. Without it, the server won't start up.. |
| `MCP_PORT` | `2461` | HTTP Port. |
| `MCP_HOST` | `0.0.0.0` | Listening interface. |
| `MCP_DB_PATH` | `/data/storage.db` | SQLite path. |
| `MCP_ALLOWED_ORIGINS` | vazio | Allowed browser origins (comma-separated). |
| `MCP_PRIMARY_*`, `MCP_FALLBACK_*` | — | AI providers for consolidation (as in the original project). |
| `MCP_PLUGINS` | — | Plugins to load (as in the original project). |

## Endpoints

- `POST /mcp` — MCP protocol (require `Authorization: Bearer <token>`).
- `GET /health` — healthcheck, with authentication.

Stateless mode: no sessions, one server instance per request, shared database.

## Client configuration

Replace `192.168.0.10` with the (static) IP of the machine running Docker, and export `MCP_TOKEN` with the same value as in the `.env` file.

**Claude Code**
```bash
claude mcp add --transport http storage http://192.168.0.10:2461/mcp \
  --header "Authorization: Bearer $MCP_TOKEN"
```

**Cursor** (`~/.cursor/mcp.json`)
```json
{ "mcpServers": { "storage": {
  "url": "http://192.168.0.10:2461/mcp",
  "headers": { "Authorization": "Bearer ${env:MCP_TOKEN}" } } } }
```

**Codex** (`~/.codex/config.toml`)
```toml
[mcp_servers.storage]
url = "http://192.168.0.10:2461/mcp"
bearer_token_env_var = "MCP_TOKEN"
```

**Gemini CLI** (`~/.gemini/settings.json`)
```json
{ "mcpServers": { "storage": {
  "httpUrl": "http://192.168.0.10:2461/mcp",
  "headers": { "Authorization": "Bearer ${MCP_TOKEN}" } } } }
```

**Claude Desktop** (via ponte `mcp-remote`)
```json
{ "mcpServers": { "storage": {
  "command": "npx",
  "args": ["-y", "mcp-remote", "http://192.168.0.10:2461/mcp", "--allow-http",
           "--header", "Authorization:Bearer ${MCP_TOKEN}"],
  "env": { "MCP_TOKEN": "seu-token" } } } }
```

## Network: what to check if it "won't connect"

1. Does `docker compose ps` show `healthy`?
2. From the machine itself: `curl http://localhost:2461/health`.
3. From another machine: `curl http://IP:2461/health`. If it only fails here, it’s likely a firewall issue on the host
(use `ufw allow from 192.168.0.0/24 to any port 2461`) or Windows Defender.
4. `401` = incorrect token. `403` = `Origin` header not allowed.

## Migrating data from my-local-storage-mcp

The table schema is the same. Copy `~/.local_mcp_learning.db` into the volume:

```bash
docker compose down
docker run --rm -v my-mcp-server-storage_mcp-storage-data:/data -v "$HOME":/src alpine \
  cp /src/.local_mcp_learning.db /data/storage.db
docker compose up -d
```
<details>
<summary><strong>Changelog</strong></summary>

**v1.0.0** — my-local-storage-mcp v1.5.4 migrated

</details>

---

ISC License — see [LICENSE](LICENSE).
