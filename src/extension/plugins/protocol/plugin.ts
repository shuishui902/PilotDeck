import type { PilotDeckHooksSettings } from "../../hooks/protocol/settings.js";
import type { CallbackHookHandler } from "../../hooks/execution/CallbackHookExecutor.js";
import type { PromptContribution } from "../../contributions/PromptContribution.js";
import type { RouterContribution } from "../../contributions/RouterContribution.js";
import type { PilotDeckToolDefinition } from "../../../tool/protocol/types.js";
import type { LoadedPluginCommand } from "../loading/PluginCommandLoader.js";
import type { PilotDeckExtensionCommandHandler } from "../runtime/ExtensionApi.js";
import type { PilotDeckPluginManifest } from "./manifest.js";

export type PilotDeckPluginSourceKind = "builtin" | "global" | "project";

export type PilotDeckLoadedPlugin = {
  name: string;
  path: string;
  source: PilotDeckPluginSourceKind;
  manifest: PilotDeckPluginManifest;
  hooksConfig?: PilotDeckHooksSettings;
  commands?: LoadedPluginCommand[];
  skills?: LoadedPluginCommand[];
  outputStyles?: LoadedPluginCommand[];
  mcpServers?: Record<string, unknown>;
  lspServers?: Record<string, unknown>;
  /** Prompt/router contributions (builtin, test-injected, or code plugins). */
  promptContributions?: PromptContribution[];
  routerContributions?: RouterContribution[];
  /**
   * Programmatic contributions from a code plugin (manifest `entry`).
   * Collected by executing the plugin's factory function against a
   * {@link PilotDeckExtensionAPI}; `hookCallbacks` backs the `callback`
   * hook entries merged into `hooksConfig`.
   */
  tools?: PilotDeckToolDefinition[];
  hookCallbacks?: Record<string, CallbackHookHandler>;
  commandHandlers?: Record<string, PilotDeckExtensionCommandHandler>;
};
