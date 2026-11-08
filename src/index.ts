import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import sqlite3 from "sqlite3";
import { open, Database } from "sqlite";
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { executeRecall, executeRecallWithIds, initRecall, touchGraphHits } from "./recall.js";
import { dispatchPluginTool, getAllPluginTools, loadPlugins } from "./plugin-loader.js";
import type { McpPlugin, RecallFormat, RememberContext } from "./plugin-types.js";
import { parseContextList, recallScopeFromArgs, resolveRememberFields, normalizeAnalystId } from "./contexts.js";

// ---------------------------------------------------------------------------
// Configuração via variáveis de ambiente
// ---------------------------------------------------------------------------
const dbPath      = process.env.MCP_DB_PATH ?? "/data/storage.db";
const HOST        = process.env.MCP_HOST ?? "0.0.0.0";
const PORT        = parseInt(process.env.MCP_PORT ?? "2461");
const AUTH_TOKEN  = process.env.MCP_AUTH_TOKEN?.trim() ?? "";
const MAX_BODY    = 1_000_000; // 1 MB por requisição
// Origens de navegador permitidas (vazio = nenhuma). Clientes CLI/IDE não enviam Origin.
const ALLOWED_ORIGINS = (process.env.MCP_ALLOWED_ORIGINS ?? "")
  .split(",").map(o => o.trim()).filter(Boolean);

interface AiProvider {
  host:     string;
  model:    string;
  provider: "ollama" | "openai";
  label:    string;
}

// Monta a lista de providers na ordem de preferência: primário → fallback
// Se uma variável não estiver definida, o provider é ignorado silenciosamente
function buildProviders(): AiProvider[] {
  const providers: AiProvider[] = [];

  if (process.env.MCP_PRIMARY_HOST) {
    providers.push({
      host:     process.env.MCP_PRIMARY_HOST,
      model:    process.env.MCP_PRIMARY_MODEL    ?? "qwen2.5-1.5b",
      provider: (process.env.MCP_PRIMARY_PROVIDER ?? "openai") as "ollama" | "openai",
      label:    "primário"
    });
  }

  if (process.env.MCP_FALLBACK_HOST) {
    providers.push({
      host:     process.env.MCP_FALLBACK_HOST,
      model:    process.env.MCP_FALLBACK_MODEL    ?? "qwen2.5:3b",
      provider: (process.env.MCP_FALLBACK_PROVIDER ?? "ollama") as "ollama" | "openai",
      label:    "fallback"
    });
  }

  return providers;
}

const AI_PROVIDERS            = buildProviders();
const INTERVAL_MS             = (parseInt(process.env.MCP_CONSOLIDATION_INTERVAL_MINUTES ?? "60")) * 60_000;
const JACCARD_THRESHOLD       = parseFloat(process.env.MCP_CONSOLIDATION_THRESHOLD ?? "0.25");
const MAX_PENDING_CYCLES      = parseInt(process.env.MCP_CONSOLIDATION_MAX_PENDING_CYCLES ?? "3");
const MAX_MERGE_CHARS         = parseInt(process.env.MCP_AI_MAX_MERGE_CHARS ?? "2000");
const DEFAULT_RECALL_MAX_CHARS = parseInt(process.env.MCP_RECALL_DEFAULT_MAX_CHARS ?? "400");

// ---------------------------------------------------------------------------
// Banco de dados
// ---------------------------------------------------------------------------
let db: Database;

async function initDb() {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  db = await open({ filename: dbPath, driver: sqlite3.Database });

  // Vários clientes em rede escrevendo ao mesmo tempo: WAL permite leitura durante escrita,
  // busy_timeout faz o SQLite esperar em vez de falhar com SQLITE_BUSY.
  await db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;`);

  // PASSO 1: garante que a tabela base existe (colunas originais apenas)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS local_learning (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      topic      TEXT    NOT NULL,
      keywords   TEXT    NOT NULL,
      fact       TEXT    NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // PASSO 2: migração segura — adiciona colunas novas em bases existentes
  // Precisa rodar ANTES de criar índices que dependem dessas colunas
  const cols     = await db.all(`PRAGMA table_info(local_learning)`);
  const colNames = cols.map((c: any) => c.name);
  if (!colNames.includes("fact_hash"))            await db.run(`ALTER TABLE local_learning ADD COLUMN fact_hash            TEXT`);
  if (!colNames.includes("record_type"))          await db.run(`ALTER TABLE local_learning ADD COLUMN record_type          TEXT NOT NULL DEFAULT 'detail'`);
  if (!colNames.includes("priority"))             await db.run(`ALTER TABLE local_learning ADD COLUMN priority             TEXT NOT NULL DEFAULT 'high'`);
  if (!colNames.includes("consolidation_status")) await db.run(`ALTER TABLE local_learning ADD COLUMN consolidation_status TEXT NOT NULL DEFAULT 'ok'`);
  if (!colNames.includes("pending_cycles"))       await db.run(`ALTER TABLE local_learning ADD COLUMN pending_cycles       INTEGER NOT NULL DEFAULT 0`);
  if (!colNames.includes("access_count"))         await db.run(`ALTER TABLE local_learning ADD COLUMN access_count         INTEGER NOT NULL DEFAULT 0`);
  if (!colNames.includes("last_accessed"))        await db.run(`ALTER TABLE local_learning ADD COLUMN last_accessed        TIMESTAMP`);
  if (!colNames.includes("context"))              await db.run(`ALTER TABLE local_learning ADD COLUMN context              TEXT NOT NULL DEFAULT 'default'`);
  if (!colNames.includes("visibility"))           await db.run(`ALTER TABLE local_learning ADD COLUMN visibility           TEXT NOT NULL DEFAULT 'personal'`);
  if (!colNames.includes("author"))               await db.run(`ALTER TABLE local_learning ADD COLUMN author               TEXT`);
  if (!colNames.includes("analyst_id"))           await db.run(`ALTER TABLE local_learning ADD COLUMN analyst_id           TEXT`);
  if (!colNames.includes("graph_node_id"))        await db.run(`ALTER TABLE local_learning ADD COLUMN graph_node_id        TEXT`);
  if (!colNames.includes("graph_hit_count"))      await db.run(`ALTER TABLE local_learning ADD COLUMN graph_hit_count      INTEGER NOT NULL DEFAULT 0`);

  await backfillAnalystIdFromAuthor();

  // PASSO 3: índices ? agora todas as colunas já existem com certeza
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_learning_lookup
      ON local_learning(topic, keywords);

    CREATE INDEX IF NOT EXISTS idx_learning_context
      ON local_learning(context, visibility, topic);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_fact_hash
      ON local_learning(fact_hash)
      WHERE fact_hash IS NOT NULL;
  `);

  await backfillFactHashes();
}

async function backfillAnalystIdFromAuthor(): Promise<void> {
  const rows: { id: number; author: string | null }[] = await db.all(
    `SELECT id, author FROM local_learning WHERE analyst_id IS NULL AND author IS NOT NULL`
  );
  for (const row of rows) {
    const analystId = normalizeAnalystId(row.author ?? "");
    if (analystId) {
      await db.run(`UPDATE local_learning SET analyst_id = ? WHERE id = ?`, [analystId, row.id]);
    }
  }
}

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------

function factHash(fact: string): string {
  const normalized = fact.toLowerCase().trim().replace(/\s+/g, " ");
  return createHash("md5").update(normalized).digest("hex");
}

async function backfillFactHashes(): Promise<void> {
  const usedRows: { fact_hash: string }[] = await db.all(
    `SELECT fact_hash FROM local_learning WHERE fact_hash IS NOT NULL`
  );
  const usedHashes = new Set(usedRows.map(r => r.fact_hash));

  const pending: { id: number; fact: string }[] = await db.all(
    `SELECT id, fact FROM local_learning
     WHERE (fact_hash IS NULL OR fact_hash = '')
       AND consolidation_status != 'merged'
     ORDER BY id ASC`
  );

  if (pending.length === 0) return;

  let filled   = 0;
  let absorbed = 0;

  for (const row of pending) {
    const hash = factHash(row.fact);

    if (!usedHashes.has(hash)) {
      await db.run(
        `UPDATE local_learning SET fact_hash = ? WHERE id = ?`,
        [hash, row.id]
      );
      usedHashes.add(hash);
      filled++;
      continue;
    }

    await db.run(
      `UPDATE local_learning SET consolidation_status = 'merged' WHERE id = ?`,
      [row.id]
    );
    absorbed++;
  }

  if (filled > 0 || absorbed > 0) {
    console.error(`[Backfill] fact_hash: ${filled} preenchido(s), ${absorbed} duplicata(s) absorvida(s).`);
  }
}

function keywordSet(keywords: string): Set<string> {
  return new Set(
    keywords.toLowerCase().split(",")
      .map(k => k.trim())
      .filter(Boolean)
  );
}

function jaccardScore(a: Set<string>, b: Set<string>): number {
  const intersection = new Set([...a].filter(x => b.has(x)));
  const union        = new Set([...a, ...b]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

// ---------------------------------------------------------------------------
// AI: health check e merge com fallback automático
// ---------------------------------------------------------------------------

async function isProviderAvailable(p: AiProvider): Promise<boolean> {
  const endpoint = p.provider === "openai"
    ? `${p.host}/v1/models`   // LocalAI e compatíveis OpenAI
    : `${p.host}/api/tags`;   // Ollama nativo
  try {
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function mergeWithProvider(p: AiProvider, facts: string[]): Promise<string | null> {
  const totalChars = facts.reduce((sum, f) => sum + f.length, 0);
  if (totalChars > MAX_MERGE_CHARS) {
    // Conteúdo muito grande para o modelo — cai para concatenação no chamador
    console.error(`[Consolidador][${p.label}] Grupo grande demais (${totalChars} chars > ${MAX_MERGE_CHARS}). Usando concatenação.`);
    return null;
  }

  const numbered   = facts.map((f, i) => `REGISTRO ${i + 1}:\n${f}`).join("\n\n");
  const systemText = [
    "Você é um assistente técnico consolidando uma base de conhecimento de software.",
    "Regras: não perca informação técnica, elimine apenas repetições literais,",
    "mantenha nomes de classes, tabelas, arquivos e FKs exatos.",
    "Responda APENAS com o texto consolidado, sem preâmbulo."
  ].join(" ");

  try {
    let endpoint: string;
    let body: object;

    if (p.provider === "openai") {
      endpoint = `${p.host}/v1/chat/completions`;
      body = {
        model:    p.model,
        messages: [
          { role: "system", content: systemText },
          { role: "user",   content: numbered }
        ],
        stream: false
      };
    } else {
      endpoint = `${p.host}/api/generate`;
      body = {
        model:  p.model,
        prompt: `${systemText}\n\n${numbered}`,
        stream: false
      };
    }

    const res = await fetch(endpoint, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(60_000)
    });

    if (!res.ok) return null;
    const data: any = await res.json();

    return p.provider === "openai"
      ? data.choices?.[0]?.message?.content?.trim() ?? null
      : data.response?.trim() ?? null;

  } catch {
    return null;
  }
}

// Tenta cada provider na ordem. Retorna o resultado do primeiro que responder
// e o label do provider usado (para log). Retorna null se todos falharem.
async function aiMerge(facts: string[]): Promise<{ result: string; label: string } | null> {
  for (const provider of AI_PROVIDERS) {
    const available = await isProviderAvailable(provider);
    if (!available) {
      console.error(`[Consolidador] Provider ${provider.label} (${provider.host}) indisponível. Tentando próximo.`);
      continue;
    }

    const result = await mergeWithProvider(provider, facts);
    if (result) {
      return { result, label: provider.label };
    }

    console.error(`[Consolidador] Provider ${provider.label} disponível mas merge falhou. Tentando próximo.`);
  }

  return null; // todos os providers falharam
}

// ---------------------------------------------------------------------------
// Consolidador — roda no idle do event loop
// ---------------------------------------------------------------------------

async function runConsolidation(): Promise<void> {
  try {
    const rows: any[] = await db.all(
      `SELECT id, topic, keywords, fact, pending_cycles, consolidation_status, context, visibility, analyst_id, author
       FROM local_learning
       WHERE consolidation_status != 'merged'
       ORDER BY context, visibility, topic, created_at`
    );

    if (rows.length < 2) return;

    // --- FASE 1: Detecção de grupos por Jaccard ---
    const groups:  number[][] = [];
    const assigned            = new Set<number>();

    for (let i = 0; i < rows.length; i++) {
      if (assigned.has(rows[i].id)) continue;

      const group = [rows[i].id];
      const kwI   = keywordSet(rows[i].keywords);

      for (let j = i + 1; j < rows.length; j++) {
        if (assigned.has(rows[j].id))              continue;
        if (rows[j].topic !== rows[i].topic)       continue;
        if (rows[j].context !== rows[i].context)   continue;
        if (rows[j].visibility !== rows[i].visibility) continue;

        const score = jaccardScore(kwI, keywordSet(rows[j].keywords));
        if (score >= JACCARD_THRESHOLD) {
          group.push(rows[j].id);
          assigned.add(rows[j].id);
        }
      }

      if (group.length > 1) {
        assigned.add(rows[i].id);
        groups.push(group);
      }
    }

    if (groups.length === 0) return;

    console.error(`[Consolidador] ${groups.length} grupo(s) detectado(s) para consolidação.`);

    // --- FASE 2: Merge por grupo ---
    for (const group of groups) {
      const members: any[] = rows.filter(r => group.includes(r.id));
      const maxPending     = Math.max(...members.map(r => r.pending_cycles));
      const forceFallback  = maxPending >= MAX_PENDING_CYCLES;

      let mergedFact: string | null  = null;
      let mergeLabel: string         = "concatenação";

      if (!forceFallback && AI_PROVIDERS.length > 0) {
        // Tenta merge semântico — primário primeiro, depois fallback
        const merged = await aiMerge(members.map(r => r.fact));
        if (merged) {
          mergedFact = merged.result;
          mergeLabel = `semântico via ${merged.label}`;
        }
      }

      if (!mergedFact && forceFallback) {
        // Todos os providers falharam por MAX_PENDING_CYCLES ciclos consecutivos
        // Concatenação estruturada como último recurso — nunca perde informação
        mergedFact = members.map((r, i) => `[Fonte ${i + 1}] ${r.fact}`).join("\n\n");
        mergeLabel = "concatenação (fallback forçado)";
      }

      if (!mergedFact) {
        // Ainda há esperança de um provider voltar — marca pendente e aguarda
        const ids = members.map(r => r.id);
        await db.run(
          `UPDATE local_learning
           SET consolidation_status = 'pending_merge',
               pending_cycles       = pending_cycles + 1
           WHERE id IN (${ids.map(() => "?").join(",")})`,
          ids
        );
        console.error(`[Consolidador] Grupo [${ids.join(",")}] marcado como pending_merge (ciclo ${maxPending + 1}/${MAX_PENDING_CYCLES}).`);
        continue;
      }

      // --- FASE 3: Gravação atômica ---
      const anchor = members[0];
      const allKw  = [...new Set(
        members.flatMap(r => r.keywords.split(",").map((k: string) => k.trim()))
      )].join(", ");
      const hash   = factHash(mergedFact);

      await db.run("BEGIN TRANSACTION");
      try {
        await db.run(
          `INSERT INTO local_learning
             (topic, keywords, fact, fact_hash, record_type, priority, consolidation_status, context, visibility, analyst_id)
           VALUES (?, ?, ?, ?, 'anchor', 'high', 'ok', ?, ?, ?)`,
          [anchor.topic, allKw, mergedFact, hash, anchor.context, anchor.visibility, anchor.analyst_id ?? anchor.author ?? null]
        );

        const ids = members.map(r => r.id);
        await db.run(
          `UPDATE local_learning
           SET consolidation_status = 'merged'
           WHERE id IN (${ids.map(() => "?").join(",")})`,
          ids
        );

        await db.run("COMMIT");
        console.error(`[Consolidador] Grupo [${ids.join(",")}] consolidado (${mergeLabel}).`);
      } catch (err) {
        await db.run("ROLLBACK");
        throw err;
      }
    }
  } catch (err: any) {
    console.error("[Consolidador] Erro no ciclo:", err.message);
  }
}

function scheduleConsolidation() {
  setTimeout(async () => {
    await runConsolidation();
    scheduleConsolidation();
  }, INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

let activePlugins: McpPlugin[] = [];

async function enrichRecallText(
  query: string,
  text: string,
  format: RecallFormat
): Promise<string> {
  let result = text;
  for (const plugin of activePlugins) {
    const extra = await plugin.afterRecall?.({ query, recallText: text, format });
    if (extra) result += `\n\n--- [${plugin.name}] ---\n${extra}`;
  }
  return result;
}

async function notifyAfterRemember(ctx: RememberContext): Promise<void> {
  for (const plugin of activePlugins) {
    try {
      await plugin.afterRemember?.(ctx);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[plugin-loader] afterRemember '${plugin.name}' falhou: ${msg}`);
    }
  }
}

function createMcpServer(): Server {
  const server = new Server(
    { name: "my-mcp-server-storage", version: "2.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const coreTools = [
        {
          name: "remember_fact",
          description: "Armazena um aprendizado, insight, decisão arquitetural ou preferência técnica de forma persistente. Evita duplicatas automaticamente. Use apenas quando o usuário confirmar explicitamente que a nuance deve ser persistida (checkpoint de aprendizado) — não grave durante exploração.",
          inputSchema: {
            type: "object",
            properties: {
              topic: {
                type: "string",
                description: "Domínio técnico macro (ex: 'dotnet', 'infraestrutura', 'hibernate'). Independente do projeto (lab/logone/mcp)."
              },
              keywords: {
                type: "string",
                description: "Palavras-chave relevantes para indexação, separadas por vírgula (ex: 'dapper, performance, mpc, garbage-collector')"
              },
              fact: {
                type: "string",
                description: "O fato objetivo, código, regra ou decisão que precisa ser memorizada."
              },
              record_type: {
                type: "string",
                enum: ["anchor", "detail"],
                description: "Use 'anchor' para conceitos fundamentais, fluxos de negócio, índices de arquitetura e diagramas — registros que sobem primeiro em qualquer busca. Use 'detail' (padrão) para hbm.xml específicos, campos, FKs e análises pontuais."
              },
              priority: {
                type: "string",
                enum: ["high", "low"],
                description: "Use 'high' (padrão) para decisões duráveis. Use 'low' para contexto temporário de sessão."
              },
              context: {
                type: "string",
                description: "Projeto ou fronteira organizacional deste fato (ex: 'lab', 'mcp', 'logone'). Inferir do workspace e do assunto a cada gravação ? não é fixo por máquina. Omitir só se realmente transversal."
              },
              visibility: {
                type: "string",
                enum: ["personal", "team"],
                description: "Escopo de compartilhamento inferido por registro: 'personal' (padrão) ou 'team'. Add-ons podem impor regras extras quando 'team'."
              },
              analyst_id: {
                type: "string",
                description: "Identificador opcional do autor (UUID). Omitir se não aplicável."
              }
            },
            required: ["topic", "keywords", "fact"]
          }
        },
        {
          name: "recall_facts",
          description: "Busca na memória local por termo livre (topic, keywords ou fact). Retorna no máximo 10 registros, priorizando âncoras e alta prioridade. Use format='compact' para economizar tokens. Registros já consolidados não aparecem.",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "O termo, palavra-chave ou conceito que deseja resgatar da memória."
              },
              type_filter: {
                type: "string",
                enum: ["all", "anchor", "detail"],
                description: "Filtra por tipo. Use 'anchor' no início de uma sessão para carregar só o contexto de alto nível (economiza tokens). Padrão: 'all'."
              },
              format: {
                type: "string",
                enum: ["full", "compact"],
                description: "Formato de saída. 'compact' retorna uma linha por registro (recomendado). Padrão: 'full'."
              },
              max_chars: {
                type: "number",
                description: "Trunca facts do tipo 'detail' acima deste limite. âncoras nunca são truncadas. Em format='compact', padrão 400 se omitido."
              },
              limit: {
                type: "number",
                description: "Máximo de registros retornados. Padrão: 10."
              },
              context: {
                type: "string",
                description: "Opcional: restringe a um projeto (ex: 'logone'). Omitido = todos os projetos."
              },
              contexts: {
                type: "string",
                description: "Opcional: vários projetos separados por vírgula (ex: 'logone,lab') quando a sessão cruza spike e produto."
              },
              visibility: {
                type: "string",
                enum: ["personal", "team", "all"],
                description: "Opcional: filtra personal, team ou all (padrão all)."
              }
            },
            required: ["query"]
          }
        },
        {
          name: "recall_by_topic",
          description: "Busca fatos por tópico exato (estruturado). Menos ruído que recall_facts. Retorna no máximo 10 registros. Use format='compact' para economizar tokens.",
          inputSchema: {
            type: "object",
            properties: {
              topic: {
                type: "string",
                description: "Tópico exato (ex: 'java-legacy', 'infraestrutura'). Case-insensitive."
              },
              keyword: {
                type: "string",
                description: "Filtro opcional dentro do tópico (busca em keywords e fact)."
              },
              type_filter: {
                type: "string",
                enum: ["all", "anchor", "detail"],
                description: "Filtra por tipo. Padrão: 'all'."
              },
              format: {
                type: "string",
                enum: ["full", "compact"],
                description: "Formato de saída. 'compact' retorna uma linha por registro (recomendado). Padrão: 'full'."
              },
              max_chars: {
                type: "number",
                description: "Trunca facts do tipo 'detail' acima deste limite. âncoras nunca são truncadas. Em format='compact', padrão 400 se omitido."
              },
              limit: {
                type: "number",
                description: "Máximo de registros retornados. Padrão: 10."
              },
              context: {
                type: "string",
                description: "Opcional: restringe a um projeto (ex: 'logone'). Omitido = todos os projetos."
              },
              contexts: {
                type: "string",
                description: "Opcional: vários projetos separados por vírgula (ex: 'logone,lab')."
              },
              visibility: {
                type: "string",
                enum: ["personal", "team", "all"],
                description: "Opcional: filtra personal, team ou all (padrão all)."
              }
            },
            required: ["topic"]
          }
        }
    ];

    return {
      tools: [...coreTools, ...getAllPluginTools(activePlugins)]
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      if (name === "remember_fact") {
        const {
          topic,
          keywords,
          fact,
          record_type = "detail",
          priority    = "high",
          context:    contextArg,
          visibility: visibilityArg,
          analyst_id: analystIdArg
        } = args as {
          topic: string;
          keywords: string;
          fact: string;
          record_type?: string;
          priority?: string;
          context?: string;
          visibility?: string;
          analyst_id?: string;
          /** @deprecated use analyst_id */
          author?: string;
        };

        const sanitizedTopic    = topic.toLowerCase().trim();
        const sanitizedKeywords = keywords.toLowerCase().trim();
        const hash              = factHash(fact);
        const resolved          = resolveRememberFields(
          { context: contextArg, visibility: visibilityArg, analyst_id: analystIdArg, author: (args as { author?: string }).author }
        );

        if (resolved.invalidAnalystId) {
          return {
            isError: true,
            content: [{
              type: "text",
              text: `[Memória Local]: analyst_id inválido ? esperado UUID. Recebido: ${resolved.invalidAnalystId.slice(0, 36)}`
            }]
          };
        }

        const scope = resolved.fields;

        for (const plugin of activePlugins) {
          if (!plugin.validateRemember) continue;
          const blocked = await plugin.validateRemember(scope, process.env);
          if (blocked) {
            return blocked.isError
              ? { isError: true, content: blocked.content }
              : { content: blocked.content };
          }
        }

        const existing = await db.get(
          "SELECT id FROM local_learning WHERE fact_hash = ? AND context = ?",
          [hash, scope.context]
        );

        if (existing) {
          await db.run(
            "UPDATE local_learning SET created_at = CURRENT_TIMESTAMP WHERE id = ?",
            [existing.id]
          );
          return {
            content: [{ type: "text", text: `[Memória Local]: Fato já registrado (ID ${existing.id}). Relevância atualizada.` }]
          };
        }

        const insertResult = await db.run(
          `INSERT INTO local_learning
             (topic, keywords, fact, fact_hash, record_type, priority, context, visibility, analyst_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [sanitizedTopic, sanitizedKeywords, fact, hash, record_type, priority, scope.context, scope.visibility, scope.analystId]
        );

        void notifyAfterRemember({
          topic: sanitizedTopic,
          keywords: sanitizedKeywords,
          fact,
          record_type,
          priority,
          fact_hash: hash,
          context: scope.context,
          visibility: scope.visibility,
          analystId: scope.analystId,
          id: insertResult.lastID
        });

        return {
          content: [{ type: "text", text: `[Memória Local]: Fato indexado sob '${sanitizedTopic}' [${scope.context}/${scope.visibility}, ${record_type}/${priority}].` }]
        };
      }

      if (name === "recall_facts") {
        const {
          query,
          type_filter = "all",
          format      = "full",
          max_chars,
          limit,
          context,
          contexts,
          visibility
        } = args as {
          query:       string;
          type_filter?: string;
          format?:      RecallFormat;
          max_chars?:   number;
          limit?:       number;
          context?:     string;
          contexts?:    string;
          visibility?:  string;
        };

        const searchPattern = `%${query.toLowerCase().trim()}%`;
        const scope = recallScopeFromArgs({ context, contexts, visibility });
        let text = await executeRecall(
          "(topic LIKE ? OR keywords LIKE ? OR fact LIKE ?)",
          [searchPattern, searchPattern, searchPattern],
          { type_filter, format, max_chars, limit: limit ?? 10, ...scope }
        );
        text = await enrichRecallText(query, text, format);

        return { content: [{ type: "text", text }] };
      }

      if (name === "recall_by_topic") {
        const {
          topic,
          keyword,
          type_filter = "all",
          format      = "full",
          max_chars,
          limit,
          context,
          contexts,
          visibility
        } = args as {
          topic:        string;
          keyword?:     string;
          type_filter?: string;
          format?:      RecallFormat;
          max_chars?:   number;
          limit?:       number;
          context?:     string;
          contexts?:    string;
          visibility?:  string;
        };

        const sanitizedTopic = topic.toLowerCase().trim();
        let whereClause      = "topic = ?";
        const params: unknown[] = [sanitizedTopic];

        if (keyword?.trim()) {
          const kwPattern = `%${keyword.toLowerCase().trim()}%`;
          whereClause += " AND (keywords LIKE ? OR fact LIKE ?)";
          params.push(kwPattern, kwPattern);
        }

        const scope = recallScopeFromArgs({ context, contexts, visibility });
        let text = await executeRecall(
          whereClause,
          params,
          { type_filter, format, max_chars, limit: limit ?? 10, ...scope }
        );
        text = await enrichRecallText(topic, text, format);

        return { content: [{ type: "text", text }] };
      }

      const pluginResult = await dispatchPluginTool(activePlugins, name, args as Record<string, unknown>);
      if (pluginResult) {
        return pluginResult.isError
          ? { isError: true, content: pluginResult.content }
          : { content: pluginResult.content };
      }

      throw new Error(`Tool interna '${name}' não implementada.`);

    } catch (error: any) {
      return {
        isError: true,
        content: [{ type: "text", text: `Erro interno no servidor MCP: ${error.message}` }]
      };
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// Inicialização
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? "";
  const match  = /^Bearer (.+)$/i.exec(header);
  if (!match) return false;
  const given    = Buffer.from(match[1]);
  const expected = Buffer.from(AUTH_TOKEN);
  // timingSafeEqual exige o mesmo tamanho; o tamanho do token não é segredo relevante aqui
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("PAYLOAD_TOO_LARGE"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8"))); }
      catch { reject(new Error("INVALID_JSON")); }
    });
    req.on("error", reject);
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  // Healthcheck do Docker: sem auth, sem dados.
  if (url.pathname === "/health") {
    return sendJson(res, 200, { status: "ok" });
  }

  if (url.pathname !== "/mcp") {
    return sendJson(res, 404, { error: "not_found" });
  }

  // Proteção contra DNS rebinding / páginas web maliciosas chamando o servidor da LAN.
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    return sendJson(res, 403, { error: "origin_not_allowed" });
  }

  if (!isAuthorized(req)) {
    return sendJson(res, 401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
  }

  // Modo stateless: sem sessões, só POST. GET (stream SSE) e DELETE (fim de sessão) não se aplicam.
  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "method_not_allowed" }, { Allow: "POST" });
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err: unknown) {
    const tooBig = err instanceof Error && err.message === "PAYLOAD_TOO_LARGE";
    return sendJson(res, tooBig ? 413 : 400, { error: tooBig ? "payload_too_large" : "invalid_json" });
  }

  // Uma instância de Server + transport por requisição. O banco (db) é compartilhado.
  const mcp       = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });
  res.on("close", () => {
    void transport.close();
    void mcp.close();
  });

  await mcp.connect(transport);
  await transport.handleRequest(req, res, body);
}

async function main() {
  if (!AUTH_TOKEN) {
    console.error("MCP_AUTH_TOKEN não definido. Gere um com: openssl rand -hex 32");
    process.exit(1);
  }

  await initDb();
  initRecall(db, DEFAULT_RECALL_MAX_CHARS);
  activePlugins = await loadPlugins(process.env, { executeRecall, executeRecallWithIds, touchGraphHits });

  const httpServer = createHttpServer((req, res) => {
    handleRequest(req, res).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[HTTP] erro não tratado: ${msg}`);
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
      else res.end();
    });
  });

  httpServer.listen(PORT, HOST, () => {
    console.error(`[HTTP] MCP em http://${HOST}:${PORT}/mcp | banco: ${dbPath}`);
  });

  // docker stop envia SIGTERM: fecha conexões e o banco limpo (checkpoint do WAL).
  const shutdown = (signal: string) => {
    console.error(`[HTTP] ${signal} recebido, encerrando.`);
    httpServer.close(async () => {
      await db.close().catch(() => undefined);
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));

  console.error("[Contextos] Escopo por registro (IA): project=context + visibility; recall sem filtro fixo de ambiente.");

  if (AI_PROVIDERS.length > 0) {
    const summary = AI_PROVIDERS.map(p => `${p.label}: ${p.host} (${p.model}/${p.provider})`).join(" | ");
    console.error(`[Consolidador] Providers configurados → ${summary}`);
    console.error(`[Consolidador] Intervalo: ${INTERVAL_MS / 60_000} min | Threshold Jaccard: ${JACCARD_THRESHOLD} | Max pending: ${MAX_PENDING_CYCLES}`);
    scheduleConsolidation();
  } else {
    console.error("[Consolidador] Nenhum provider AI configurado. Merge semântico desabilitado.");
  }
}

main().catch((err) => {
  console.error("Falha crítica ao iniciar o servidor MCP:", err);
  process.exit(1);
});
