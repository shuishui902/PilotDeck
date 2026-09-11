import type { PilotDeckHooksSettings } from "../../hooks/protocol/settings.js";

export type PilotDeckPluginManifest = {
  name: string;
  version?: string;
  description?: string;
  commands?: string | string[];
  agents?: string | string[];
  skills?: string | string[];
  hooks?: string | PilotDeckHooksSettings;
  mcpServers?: Record<string, unknown>;
  lspServers?: Record<string, unknown>;
  outputStyles?: string | string[];
  marketplace?: PilotDeckMarketplaceReference;
  mcpb?: string;
  settings?: Record<string, unknown>;
  /**
   * Optional code entry point (compiled JS, ESM). When present the plugin is
   * loaded as a *code plugin*: the module is imported and its default-exported
   * factory is invoked with a {@link PilotDeckExtensionAPI}. When absent the
   * plugin stays purely declarative (hooks/commands/skills JSON + Markdown).
   */
  entry?: string;
};

export type PilotDeckMarketplaceReference = {
  name: string;
  plugin: string;
  version?: string;
  source?: "marketplace" | "git" | "zip" | "mcpb";
  url?: string;
};
