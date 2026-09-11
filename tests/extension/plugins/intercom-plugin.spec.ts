import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PluginRuntime } from "../../../src/extension/plugins/runtime/PluginRuntime.js";
import type {
  GatewayEvent,
  GatewaySubmitTurnInput,
  ListSessionsInput,
} from "../../../src/gateway/protocol/types.js";
import type { PilotDeckExtensionActions } from "../../../src/extension/plugins/runtime/ExtensionApi.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const INTERCOM_SRC = join(REPO_ROOT, "hackathon", "plugins", "intercom");

type SubmitCall = { input: GatewaySubmitTurnInput };

function makeActions(handlers?: {
  onSubmit?: (input: GatewaySubmitTurnInput) => AsyncIterable<GatewayEvent>;
}) {
  const calls = { list: [] as ListSessionsInput[], submit: [] as SubmitCall[] };
  const actions: PilotDeckExtensionActions = {
    async listSessions(input) {
      calls.list.push(input);
      return {
        sessions: [
          { sessionId: "proj-s1", summary: "目标项目最近会话", lastModified: 1 },
        ],
      };
    },
    submitTurn(input) {
      calls.submit.push({ input });
      if (handlers?.onSubmit) {
        return handlers.onSubmit(input);
      }
      return (async function* (): AsyncIterable<GatewayEvent> {
        yield { type: "turn_started", runId: "run-1" };
        yield { type: "assistant_text_delta", text: "收到，" };
        yield { type: "assistant_text_delta", text: "已修复。" };
        yield { type: "turn_completed", usage: {}, finishReason: "stop" };
      })();
    },
    async steerTurn() {
      throw new Error("not used in this test");
    },
  };
  return { actions, calls };
}

async function setup(actions: PilotDeckExtensionActions) {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-intercom-"));
  const pilotHome = join(root, "pilot-home");
  const projectRoot = join(root, "project");
  await cp(INTERCOM_SRC, join(pilotHome, "plugins", "intercom"), { recursive: true });
  const runtime = new PluginRuntime({
    projectRoot,
    pilotHome,
    getExtensionActions: () => actions,
  });
  await runtime.refresh();
  return { root, pilotHome, projectRoot, runtime };
}

test("intercom tools are only available in the General session", async () => {
  const { actions } = makeActions();
  const { root, pilotHome, projectRoot, runtime } = await setup(actions);
  try {
    const tools = runtime.snapshotContributions().tools;
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      ["session_list", "session_send"],
    );
    for (const tool of tools) {
      const general = await tool.checkAvailability?.({ cwd: pilotHome });
      assert.deepEqual(general, { ok: true }, `${tool.name} should be available in General`);
      const project = await tool.checkAvailability?.({ cwd: projectRoot });
      assert.equal(project?.ok, false, `${tool.name} should be hidden from project sessions`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session_send closes the loop: dispatch → execute → receipt flows back", async () => {
  const { actions, calls } = makeActions();
  const { root, runtime } = await setup(actions);
  try {
    const tool = runtime.snapshotContributions().tools.find((candidate) => candidate.name === "session_send");
    assert.ok(tool);
    const output = await tool.execute(
      { projectKey: "/tmp/target-project", message: "把登录页的按钮改成蓝色" },
      {} as never,
    );

    // 定位：没给 sessionKey 时先查项目最近会话
    assert.deepEqual(calls.list, [{ projectKey: "/tmp/target-project", limit: 1 }]);
    // 转发：submitTurn 打到目标会话，headless（canPrompt=false）
    assert.equal(calls.submit.length, 1);
    const submitted = calls.submit[0]!.input;
    assert.equal(submitted.sessionKey, "proj-s1");
    assert.equal(submitted.projectKey, "/tmp/target-project");
    assert.equal(submitted.message, "把登录页的按钮改成蓝色");
    assert.equal(submitted.canPrompt, false);

    // 回执：回复文本拼回流 + 状态翻转 doing → done
    const text = output.content[0]?.type === "text" ? output.content[0].text : "";
    assert.match(text, /回执 ✅/);
    assert.match(text, /收到，已修复。/);
    const statuses = runtime.pluginStatuses().filter((event) => event.sessionKey === "proj-s1");
    assert.deepEqual(
      statuses.map((event) => event.status),
      ["done"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session_send uses the explicit sessionKey without listing first", async () => {
  const { actions, calls } = makeActions();
  const { root, runtime } = await setup(actions);
  try {
    const tool = runtime.snapshotContributions().tools.find((candidate) => candidate.name === "session_send");
    assert.ok(tool);
    const output = await tool.execute(
      { projectKey: "/tmp/p", sessionKey: "explicit-s", message: "hi" },
      {} as never,
    );
    assert.deepEqual(calls.list, []);
    assert.equal(calls.submit[0]?.input.sessionKey, "explicit-s");
    assert.equal((output.data as { ok: boolean }).ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session_send surfaces remote errors as needs_human receipts", async () => {
  const { actions } = makeActions({
    onSubmit: () =>
      (async function* (): AsyncIterable<GatewayEvent> {
        yield { type: "turn_started", runId: "run-1" };
        yield { type: "error", message: "model exploded", recoverable: true };
      })(),
  });
  const { root, runtime } = await setup(actions);
  try {
    const tool = runtime.snapshotContributions().tools.find((candidate) => candidate.name === "session_send");
    assert.ok(tool);
    const output = await tool.execute(
      { projectKey: "/tmp/p", sessionKey: "s-err", message: "hi" },
      {} as never,
    );
    const text = output.content[0]?.type === "text" ? output.content[0].text : "";
    assert.match(text, /回执 ❌/);
    assert.match(text, /model exploded/);
    assert.equal((output.data as { ok: boolean }).ok, false);
    const status = runtime.pluginStatuses().find((event) => event.sessionKey === "s-err");
    assert.equal(status?.status, "needs_human");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
