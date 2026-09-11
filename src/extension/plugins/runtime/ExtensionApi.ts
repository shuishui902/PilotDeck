import type { PromptContribution } from "../../contributions/PromptContribution.js";
import type { CallbackHookHandler } from "../../hooks/execution/CallbackHookExecutor.js";
import type { PilotDeckHookEvent } from "../../hooks/protocol/events.js";
import type { PilotDeckHookInput } from "../../hooks/protocol/input.js";
import type { PilotDeckHookOutput } from "../../hooks/protocol/output.js";
import type { PilotDeckHooksSettings } from "../../hooks/protocol/settings.js";
import type {
  Gateway,
  GatewayEvent,
  GatewaySteerTurnInput,
  GatewaySteerTurnResult,
  GatewaySubmitTurnInput,
  ListSessionsInput,
  ListSessionsResult,
} from "../../../gateway/protocol/types.js";
import type { PilotDeckToolDefinition } from "../../../tool/protocol/types.js";

/**
 * Programmatic plugin layer — a disk plugin with an `entry` field in its
 * plugin.json exports a factory function receiving this API. Everything the
 * factory registers is collected into a {@link ProgrammaticPluginContribution}
 * that flows through the existing contribution pipelines (tool registry,
 * hooks settings + callback executor, prompt contributions).
 *
 * Design constraints (hackathon roadmap 阶段一):
 * 1. Narrow surface — action methods only proxy the Gateway; plugins never
 *    touch kernel internals.
 * 2. Load-time vs run-time separation — registration methods may be called
 *    any time; action methods throw until the factory has returned and a
 *    Gateway is bound (Pi-style `notInitialized`).
 * 3. No sandbox — generation and activation are separated at the UI level.
 */
export type PilotDeckExtensionAPI = {
  /** Absolute path of the General workspace root (pilot home). A session is a
   *  "General" session when its cwd resolves here — compare against the
   *  `checkAvailability` context cwd to gate General-only tools. */
  readonly generalRoot: string;

  // —— Registration (call during load) ——
  registerTool(def: PilotDeckToolDefinition): void;
  registerCommand(name: string, handler: PilotDeckExtensionCommandHandler): void;
  onHook(event: PilotDeckHookEvent, handler: PilotDeckExtensionHookHandler, options?: { matcher?: string }): void;

  // —— Actions (call at run time; all proxy the Gateway) ——
  listSessions(filter?: ListSessionsInput): Promise<ListSessionsResult>;
  submitTurn(input: GatewaySubmitTurnInput): AsyncIterable<GatewayEvent>;
  steerTurn(input: GatewaySteerTurnInput): Promise<GatewaySteerTurnResult>;

  // —— Self-reported status for the activity view ——
  emitStatus(sessionKey: string, status: PilotDeckPluginSessionStatus, note?: string): void;
};

export type PilotDeckPluginSessionStatus = "doing" | "needs_human" | "done";

export type PilotDeckExtensionCommandHandler = (args: string) => string | Promise<string>;

export type PilotDeckExtensionHookHandler = (
  input: PilotDeckHookInput,
) => Promise<PilotDeckHookOutput | string | void> | PilotDeckHookOutput | string | void;

/** Run-time capabilities handed to plugins; a narrow projection of {@link Gateway}. */
export type PilotDeckExtensionActions = {
  listSessions(input: ListSessionsInput): Promise<ListSessionsResult>;
  submitTurn(input: GatewaySubmitTurnInput): AsyncIterable<GatewayEvent>;
  steerTurn(input: GatewaySteerTurnInput): Promise<GatewaySteerTurnResult>;
};

/** Adapt a full Gateway into the narrow action surface exposed to plugins. */
export function gatewayExtensionActions(gateway: Gateway): PilotDeckExtensionActions {
  return {
    listSessions: (input) => gateway.listSessions(input),
    submitTurn: (input) => gateway.submitTurn(input),
    steerTurn: (input) => gateway.steerTurn(input),
  };
}

export type PluginStatusEvent = {
  pluginName: string;
  sessionKey: string;
  status: PilotDeckPluginSessionStatus;
  note?: string;
  updatedAt: number;
};

/** Everything one code plugin registered through its factory call. */
export type ProgrammaticPluginContribution = {
  tools: PilotDeckToolDefinition[];
  hooks: PilotDeckHooksSettings;
  hookCallbacks: Record<string, CallbackHookHandler>;
  promptContributions: PromptContribution[];
  commandHandlers: Record<string, PilotDeckExtensionCommandHandler>;
};

export type ExtensionApiRecorder = {
  api: PilotDeckExtensionAPI;
  /** Marks the factory call as complete; action methods become callable. */
  finalize(): ProgrammaticPluginContribution;
};

export type ExtensionApiRecorderDeps = {
  pluginName: string;
  /** Lazily bound — the Gateway typically exists only after plugin loading starts. */
  getActions: () => PilotDeckExtensionActions | undefined;
  /** General workspace root (pilot home); exposed as `api.generalRoot`. */
  generalRoot?: string;
  emitStatus?: (event: PluginStatusEvent) => void;
};

export function createExtensionApiRecorder(deps: ExtensionApiRecorderDeps): ExtensionApiRecorder {
  const contribution: ProgrammaticPluginContribution = {
    tools: [],
    hooks: {},
    hookCallbacks: {},
    promptContributions: [],
    commandHandlers: {},
  };
  let hookSeq = 0;
  let loaded = false;

  const actions = (): PilotDeckExtensionActions => {
    if (!loaded) {
      throw new Error(
        `Plugin "${deps.pluginName}": extension API actions are not available while the plugin is still loading.`,
      );
    }
    const bound = deps.getActions();
    if (!bound) {
      throw new Error(`Plugin "${deps.pluginName}": gateway actions are not available in this context.`);
    }
    return bound;
  };

  const api: PilotDeckExtensionAPI = {
    generalRoot: deps.generalRoot ?? "",
    registerTool(def) {
      contribution.tools.push(def);
    },
    registerCommand(name, handler) {
      const qualified = name.includes(":") ? name : `${deps.pluginName}:${name}`;
      contribution.commandHandlers[qualified] = handler;
    },
    onHook(event, handler, options) {
      const callbackName = `${deps.pluginName}.${event}.${++hookSeq}`;
      contribution.hookCallbacks[callbackName] = async ({ hookInput }) => handler(hookInput);
      contribution.hooks[event] = [
        ...(contribution.hooks[event] ?? []),
        {
          ...(options?.matcher ? { matcher: options.matcher } : {}),
          hooks: [{ type: "callback", name: callbackName }],
        },
      ];
    },
    listSessions: async (filter) => actions().listSessions(filter ?? {}),
    submitTurn: (input) => actions().submitTurn(input),
    steerTurn: async (input) => actions().steerTurn(input),
    emitStatus(sessionKey, status, note) {
      deps.emitStatus?.({
        pluginName: deps.pluginName,
        sessionKey,
        status,
        note,
        updatedAt: Date.now(),
      });
    },
  };

  return {
    api,
    finalize() {
      loaded = true;
      return contribution;
    },
  };
}

/** Merge programmatic hook settings into manifest-declared ones. */
export function mergeHooksSettings(
  base: PilotDeckHooksSettings | undefined,
  extra: PilotDeckHooksSettings,
): PilotDeckHooksSettings | undefined {
  if (!base) {
    return Object.keys(extra).length > 0 ? extra : undefined;
  }
  const merged: PilotDeckHooksSettings = { ...base };
  for (const [event, matchers] of Object.entries(extra) as Array<
    [keyof PilotDeckHooksSettings, NonNullable<PilotDeckHooksSettings[keyof PilotDeckHooksSettings]>]
  >) {
    merged[event] = [...(merged[event] ?? []), ...matchers];
  }
  return merged;
}
