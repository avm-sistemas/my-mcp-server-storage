# my-mcp-server-storage

Servidor MCP de memória persistente (SQLite), derivado do `my-local-storage-mcp`.
Mesmas tools (`remember_fact`, `recall_facts`, `recall_by_topic`), mesma consolidação, mesmo sistema de plugins.
O que mudou: fala **Streamable HTTP** em vez de stdio, exige **token** e guarda o banco em um **volume Docker**.

## Subir

```bash
cp .env.example .env
# edite .env e coloque um token: openssl rand -hex 32
docker compose up -d --build
curl http://localhost:2461/health      # {"status":"ok"}
```

O banco fica no volume `mcp-storage-data` (`/data/storage.db` dentro do container).
Para usar uma pasta do host em vez de volume nomeado, troque a linha do volume por `./data:/data`
(use disco local; SQLite com WAL não combina com NFS/SMB).

## Backup

```bash
docker run --rm -v my-mcp-server-storage_mcp-storage-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/storage-$(date +%F).tgz -C /data .
```

(O nome do volume leva o prefixo da pasta do projeto; confira com `docker volume ls`.)

## Variáveis de ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `MCP_AUTH_TOKEN` | — (obrigatória) | Token Bearer. Sem ele o servidor não sobe. |
| `MCP_PORT` | `2461` | Porta HTTP. |
| `MCP_HOST` | `0.0.0.0` | Interface de escuta. |
| `MCP_DB_PATH` | `/data/storage.db` | Caminho do SQLite. |
| `MCP_ALLOWED_ORIGINS` | vazio | Origens de navegador permitidas (separadas por vírgula). |
| `MCP_PRIMARY_*`, `MCP_FALLBACK_*` | — | Providers de IA para consolidação (como no projeto original). |
| `MCP_PLUGINS` | — | Plugins a carregar (como no projeto original). |

## Endpoints

- `POST /mcp` — protocolo MCP (exige `Authorization: Bearer <token>`).
- `GET /health` — healthcheck, sem autenticação.

Modo stateless: sem sessões, uma instância de servidor por requisição, banco compartilhado.

## Configuração dos clientes

Troque `192.168.0.10` pelo IP (fixo) da máquina que roda o Docker e exporte `MCP_TOKEN` com o mesmo valor do `.env`.

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

## Rede: o que conferir se "não conecta"

1. `docker compose ps` mostra `healthy`?
2. Da própria máquina: `curl http://localhost:2461/health`.
3. De outra máquina: `curl http://IP:2461/health`. Se falhar só aqui, é firewall do host
   (`ufw allow from 192.168.0.0/24 to any port 2461`) ou do Windows Defender.
4. `401` = token errado. `403` = header `Origin` não permitido.

## Migrar dados do my-local-storage-mcp

O esquema da tabela é o mesmo. Copie `~/.local_mcp_learning.db` para dentro do volume:

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
