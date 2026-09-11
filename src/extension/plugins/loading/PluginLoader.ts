import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseHooksConfig } from "../../hooks/config/parseHooksConfig.js";
import type { PilotDeckPluginManifest } from "../protocol/manifest.js";
import type { PilotDeckLoadedPlugin, PilotDeckPluginSourceKind } from "../protocol/plugin.js";
import { parsePluginManifest } from "../config/parsePluginManifest.js";
import {
  mergeHooksSettings,
  type ExtensionApiRecorder,
  type ProgrammaticPluginContribution,
} from "../runtime/ExtensionApi.js";
import { loadPluginCommands, loadStandaloneSkill } from "./PluginCommandLoader.js";

/**
 * Host-side hook that lets the runtime hand a fresh {@link PilotDeckExtensionAPI}
 * recorder to each code plugin being loaded. Provided by PluginRuntime so the
 * loader itself stays free of Gateway/run-time concerns.
 */
export type ProgrammaticPluginHost = {
  createRecorder(pluginName: string): ExtensionApiRecorder;
};

/**
 * Loads a standalone skill directory (containing SKILL.md) as a pseudo-plugin.
 * No plugin.json required — mirrors the legacy standalone skill directory layout.
 */
export async function loadSkillFromPath(
  skillDir: string,
  source: PilotDeckPluginSourceKind,
): Promise<PilotDeckLoadedPlugin> {
  const name = skillDir.split(/[\\/]/u).at(-1) ?? "skill";
  const skill = await loadStandaloneSkill({ name, skillDir });
  return {
    name,
    path: skillDir,
    source,
    manifest: { name, version: "0.0.0" },
    skills: [skill],
  };
}

export async function loadPluginFromPath(
  pluginPath: string,
  source: PilotDeckPluginSourceKind,
  host?: ProgrammaticPluginHost,
): Promise<PilotDeckLoadedPlugin> {
  const manifestPath = join(pluginPath, "plugin.json");
  const manifest = parsePluginManifest(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);
  const hooksConfig = await loadHooksConfig(pluginPath, manifest);
  const commands = await loadConfiguredMarkdown(pluginPath, manifest.commands, "commands");
  const skills = await loadConfiguredMarkdown(pluginPath, manifest.skills, "skills");
  const outputStyles = await loadConfiguredMarkdown(pluginPath, manifest.outputStyles, "output-styles");
  const programmatic = manifest.entry && host ? await loadProgrammaticEntry(pluginPath, manifest, host) : undefined;

  return {
    name: manifest.name,
    path: pluginPath,
    source,
    manifest,
    hooksConfig: mergeHooksSettings(hooksConfig, programmatic?.hooks ?? {}),
    commands,
    skills,
    outputStyles,
    mcpServers: manifest.mcpServers,
    lspServers: manifest.lspServers,
    tools: programmatic?.tools,
    hookCallbacks: programmatic?.hookCallbacks,
    promptContributions: programmatic?.promptContributions,
    commandHandlers: programmatic?.commandHandlers,
  };
}

/**
 * Imports the plugin's `entry` module and executes its default-exported
 * factory against a fresh extension-API recorder. A failing entry never
 * sinks the declarative contributions — the plugin loads without its
 * programmatic parts and a warning is printed.
 */
async function loadProgrammaticEntry(
  pluginPath: string,
  manifest: PilotDeckPluginManifest,
  host: ProgrammaticPluginHost,
): Promise<ProgrammaticPluginContribution | undefined> {
  const entry = manifest.entry;
  if (!entry) {
    return undefined;
  }
  try {
    // Cache-busting query keeps re-activation (regenerate + reload) from
    // serving a stale module; ESM caches by exact specifier.
    const entryUrl = `${pathToFileURL(join(pluginPath, entry)).href}?t=${Date.now()}`;
    const mod = (await import(entryUrl)) as { default?: unknown };
    const factory = mod.default;
    if (typeof factory !== "function") {
      throw new Error(`entry module must default-export a factory function`);
    }
    const recorder = host.createRecorder(manifest.name);
    await (factory as (api: unknown) => unknown)(recorder.api);
    return recorder.finalize();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(
      `[pilotdeck] Failed to load code entry for plugin "${manifest.name}":`,
      error instanceof Error ? error.message : String(error),
    );
    return undefined;
  }
}

async function loadHooksConfig(pluginPath: string, manifest: PilotDeckPluginManifest) {
  if (typeof manifest.hooks === "object" && manifest.hooks !== null) {
    return parseHooksConfig(manifest.hooks).settings;
  }
  const hookPath = typeof manifest.hooks === "string" ? manifest.hooks : "hooks/hooks.json";
  try {
    const raw = JSON.parse(await readFile(join(pluginPath, hookPath), "utf8")) as unknown;
    return parseHooksConfig(raw).settings;
  } catch {
    return undefined;
  }
}

async function loadConfiguredMarkdown(
  pluginPath: string,
  configured: string | string[] | undefined,
  fallbackDir: "commands" | "skills" | "output-styles",
) {
  const dirs = configured === undefined ? [fallbackDir] : Array.isArray(configured) ? configured : [configured];
  const loaded = await Promise.all(
    dirs.map((dir) => loadPluginCommands({ pluginName: "", baseDir: join(pluginPath, dir) }).catch(() => [])),
  );
  const pluginName = pluginPath.split(/[\\/]/u).at(-1) ?? "";
  return loaded.flat().map((command) => ({
    ...command,
    name: command.name.startsWith(":")
      ? `${pluginName}${command.name}`
      : command.name.replace(/^:/u, `${pluginName}:`),
  }));
}
