import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadPluginFromPath } from "../../../src/extension/plugins/loading/PluginLoader.js";
import {
  createExtensionApiRecorder,
  type PilotDeckExtensionActions,
} from "../../../src/extension/plugins/runtime/ExtensionApi.js";
import { PluginRuntime } from "../../../src/extension/plugins/runtime/PluginRuntime.js";
import type { PilotDeckToolDefinition } from "../../../src/tool/protocol/types.js";

const HELLO_ENTRY = `
export default function (api) {
  api.registerTool({
    name: "hello_sessions",
    description: "List PilotDeck sessions via the extension API.",
    kind: "custom",
    inputSchema: { type: "object", properties: {} },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute() {
      const result = await api.listSessions();
      return { content: [{ type: "text", text: JSON.stringify(result.sessions) }] };
    },
  });
  api.registerCommand("ping", () => "pong");
  api.onHook("PostToolUse", () => {});
  api.emitStatus("demo/session", "doing", "hello plugin loaded");
}
`;

const FAKE_ACTIONS: PilotDeckExtensionActions = {
  async listSessions() {
    return {
      sessions: [
        { sessionId: "s1", summary: "demo session", lastModified: 1, sessionKey: "demo/s1" },
      ],
    };
  },
  submitTurn: () => {
    throw new Error("not used in this test");
  },
  async steerTurn() {
    return { ok: true } as never;
  },
};

async function writeHelloPlugin(pluginsDir: string, options?: { entry?: boolean }): Promise<string> {
  const pluginDir = join(pluginsDir, "hello");
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    join(pluginDir, "plugin.json"),
    JSON.stringify({
      name: "hello",
      version: "0.1.0",
      ...(options?.entry === false ? {} : { entry: "index.js" }),
    }),
    "utf8",
  );
  if (options?.entry !== false) {
    await writeFile(join(pluginDir, "index.js"), HELLO_ENTRY, "utf8");
  }
  return pluginDir;
}

async function makeRuntime(root: string): Promise<PluginRuntime> {
  const pilotHome = join(root, "pilot-home");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  return new PluginRuntime({
    projectRoot,
    pilotHome,
    getExtensionActions: () => FAKE_ACTIONS,
  });
}

test("code plugin (manifest entry) contributes tools, hooks, commands and status", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-code-plugin-"));
  try {
    const runtime = await makeRuntime(root);
    await writeHelloPlugin(join(root, "pilot-home", "plugins"));

    await runtime.refresh();
    const contributions = runtime.snapshotContributions();

    // Acceptance 1: the plugin's tool shows up in the contribution pipeline.
    const tool = contributions.tools.find((candidate) => candidate.name === "hello_sessions");
    assert.ok(tool, "hello_sessions should be contributed");

    // Acceptance 2: the tool can call api.listSessions() and get real data.
    const output = await (tool as PilotDeckToolDefinition).execute({}, {} as never);
    const text = output.content[0]?.type === "text" ? output.content[0].text : "";
    assert.match(text, /demo session/);

    // Hooks land in the existing settings + callback pipeline.
    const postToolUse = contributions.hooks.PostToolUse ?? [];
    assert.equal(postToolUse.length, 1);
    assert.equal(postToolUse[0]?.hooks[0]?.type, "callback");
    const callbackName = postToolUse[0]?.hooks[0]?.type === "callback" ? postToolUse[0].hooks[0].name : "";
    assert.ok(callbackName.startsWith("hello.PostToolUse."));
    assert.equal(typeof contributions.hookCallbacks[callbackName], "function");

    // Programmatic commands resolve through loadSkillPrompt.
    assert.equal(await runtime.loadSkillPrompt("hello:ping"), "pong");
    assert.equal(await runtime.loadSkillPrompt("ping"), "pong");

    // Self-reported status is tracked for the activity view.
    const statuses = runtime.pluginStatuses();
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0]?.status, "doing");
    assert.equal(statuses[0]?.sessionKey, "demo/session");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("declarative plugin without entry keeps legacy behaviour (regression)", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-declarative-plugin-"));
  try {
    const runtime = await makeRuntime(root);
    const pluginDir = await writeHelloPlugin(join(root, "pilot-home", "plugins"), { entry: false });
    await mkdir(join(pluginDir, "commands"), { recursive: true });
    await writeFile(join(pluginDir, "commands", "hi.md"), "---\ndescription: say hi\n---\n\nHello!\n", "utf8");

    await runtime.refresh();
    const contributions = runtime.snapshotContributions();

    assert.equal(contributions.tools.length, 0);
    assert.deepEqual(Object.keys(contributions.hookCallbacks), []);
    const command = contributions.commands.find((candidate) => candidate.name === "hello:hi");
    assert.ok(command, "declarative markdown command should still load");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("action methods throw while the plugin factory is still running", async () => {
  const recorder = createExtensionApiRecorder({
    pluginName: "hello",
    getActions: () => FAKE_ACTIONS,
  });
  await assert.rejects(() => recorder.api.listSessions(), /still loading/);
  recorder.finalize();
  const result = await recorder.api.listSessions();
  assert.equal(result.sessions.length, 1);
});

test("a plugin whose entry throws still loads its declarative contributions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-broken-plugin-"));
  try {
    const runtime = await makeRuntime(root);
    const pluginDir = join(root, "pilot-home", "plugins", "broken");
    await mkdir(join(pluginDir, "commands"), { recursive: true });
    await writeFile(
      join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "broken", entry: "index.js" }),
      "utf8",
    );
    await writeFile(join(pluginDir, "index.js"), "throw new Error('boom');\n", "utf8");
    await writeFile(join(pluginDir, "commands", "ok.md"), "still here\n", "utf8");

    await runtime.refresh();
    const contributions = runtime.snapshotContributions();
    assert.equal(contributions.tools.length, 0);
    assert.ok(contributions.commands.some((candidate) => candidate.name === "broken:ok"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadPluginFromPath without a host ignores the entry field", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-hostless-plugin-"));
  try {
    const pluginDir = await writeHelloPlugin(join(root, "plugins"));
    const loaded = await loadPluginFromPath(pluginDir, "global");
    assert.equal(loaded.name, "hello");
    assert.equal(loaded.tools, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
