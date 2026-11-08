import { pathToFileURL } from "node:url";
import type { McpPlugin, PluginHostContext, ToolDefinition, McpToolResult } from "./plugin-types.js";

async function tryImport(moduleId: string): Promise<McpPlugin | null> {
  try {
    const mod = await import(moduleId);
    const plugin = (mod.default ?? mod.plugin) as McpPlugin | undefined;
    if (plugin && typeof plugin.init === "function") {
      return plugin;
    }
  } catch {
    // próximo candidato
  }
  return null;
}

async function loadPluginByName(name: string): Promise<McpPlugin | null> {
  // 1) pacote instalado com o próprio nome informado em MCP_PLUGINS
  const fromPackage = await tryImport(name);
  if (fromPackage) return fromPackage;

  // 2) caminho explícito: MCP_<NOME>_PLUGIN_PATH=/plugins/meu-plugin/dist/index.js
  const envPath = process.env[`MCP_${name.toUpperCase()}_PLUGIN_PATH`]?.trim();
  if (envPath) {
    const fromPath = await tryImport(pathToFileURL(envPath).href);
    if (fromPath) return fromPath;
  }

  console.error(`[plugin-loader] plugin '${name}' não encontrado (instale o pacote ou omita de MCP_PLUGINS).`);
  return null;
}

export async function loadPlugins(
  env: NodeJS.ProcessEnv,
  host?: PluginHostContext
): Promise<McpPlugin[]> {
  const raw = env.MCP_PLUGINS?.trim();
  if (!raw) return [];

  const names = raw.split(",").map(n => n.trim()).filter(Boolean);
  const active: McpPlugin[] = [];

  for (const name of names) {
    const plugin = await loadPluginByName(name);
    if (!plugin) continue;

    try {
      const ok = await plugin.init(env, host);
      if (ok) {
        active.push(plugin);
        console.error(`[plugin-loader] plugin '${plugin.name}' ativo.`);
      } else {
        console.error(`[plugin-loader] plugin '${plugin.name}' inativo (init retornou false).`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[plugin-loader] falha ao iniciar '${name}': ${msg}`);
    }
  }

  return active;
}

export function getAllPluginTools(plugins: McpPlugin[]): ToolDefinition[] {
  return plugins.flatMap(p => p.getTools());
}

export async function dispatchPluginTool(
  plugins: McpPlugin[],
  name: string,
  args: Record<string, unknown>
): Promise<McpToolResult | null> {
  for (const plugin of plugins) {
    const result = await plugin.handleTool(name, args);
    if (result) return result;
  }
  return null;
}
