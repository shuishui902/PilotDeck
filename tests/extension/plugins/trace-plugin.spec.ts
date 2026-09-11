import assert from "node:assert/strict";
import { once } from "node:events";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createExtensionApiRecorder } from "../../../src/extension/plugins/runtime/ExtensionApi.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const TRACE_ENTRY = join(REPO_ROOT, "hackathon", "plugins", "trace", "index.js");

const STORE_KEY = "__pilotdeck_trace_store__";
const SERVER_KEY = "__pilotdeck_trace_server__";

async function loadTracePlugin() {
  // cache-busting 模拟运行时的真实加载路径（每次 refresh 都是新模块实例）
  const mod = (await import(`${pathToFileURL(TRACE_ENTRY).href}?t=${Date.now()}`)) as {
    default: (api: unknown) => void;
  };
  const recorder = createExtensionApiRecorder({
    pluginName: "trace",
    getActions: () => undefined,
    generalRoot: "/general",
  });
  mod.default(recorder.api);
  return recorder.finalize();
}

async function fireHook(
  contribution: Awaited<ReturnType<typeof loadTracePlugin>>,
  event: string,
  input: Record<string, unknown>,
) {
  const matcher = contribution.hooks[event as keyof typeof contribution.hooks]?.[0];
  const command = matcher?.hooks[0];
  assert.equal(command?.type, "callback");
  const name = command.type === "callback" ? command.name : "";
  const handler = contribution.hookCallbacks[name];
  assert.ok(handler, `hook callback ${name} should be registered`);
  await handler({ hookInput: input as never });
}

test("trace aggregates hooks into per-session stats and serves a live panel", async (t) => {
  delete (globalThis as Record<string, unknown>)[STORE_KEY];
  delete (globalThis as Record<string, unknown>)[SERVER_KEY];
  process.env.PILOTDECK_TRACE_PORT = "0"; // 随机端口，避免与本机真实面板冲突

  const contribution = await loadTracePlugin();
  const store = (globalThis as unknown as Record<string, unknown>)[STORE_KEY] as {
    sessions: Map<string, { toolCalls: number; turns: number; ended: boolean }>;
  };

  // 模拟一个会话的执行过程：一轮提问 + 两次工具调用（一次失败）+ 结束
  await fireHook(contribution, "SessionStart", { sessionId: "s1", cwd: "/p" });
  await fireHook(contribution, "UserPromptSubmit", { sessionId: "s1", cwd: "/p" });
  await fireHook(contribution, "PreToolUse", { sessionId: "s1", cwd: "/p", toolName: "read_file" });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
  await fireHook(contribution, "PostToolUse", { sessionId: "s1", cwd: "/p", toolName: "read_file" });
  await fireHook(contribution, "PreToolUse", { sessionId: "s1", cwd: "/p", toolName: "write_file" });
  await fireHook(contribution, "PostToolUseFailure", { sessionId: "s1", cwd: "/p", toolName: "write_file" });
  await fireHook(contribution, "Stop", { sessionId: "s1", cwd: "/p" });
  await fireHook(contribution, "SessionEnd", { sessionId: "s1", cwd: "/p" });

  const agg = store.sessions.get("s1");
  assert.equal(agg?.turns, 1);
  assert.equal(agg?.toolCalls, 2);
  assert.equal(agg?.ended, true);

  // 面板：/api/snapshot 返回聚合结果
  const server = (globalThis as unknown as Record<string, unknown>)[SERVER_KEY] as import("node:http").Server;
  if (!server.listening) {
    await once(server, "listening");
  }
  const { port } = server.address() as { port: number };
  t.after(() => server.close());

  const snap = (await fetch(`http://127.0.0.1:${port}/api/snapshot`).then((res) => res.json())) as {
    sessions: Array<{ sessionId: string; turns: number; toolCalls: number; toolFailures: number; avgToolMs: number }>;
    events: Array<{ type: string; ms?: number }>;
  };
  const row = snap.sessions.find((session) => session.sessionId === "s1");
  assert.equal(row?.turns, 1);
  assert.equal(row?.toolCalls, 2);
  assert.equal(row?.toolFailures, 1);
  assert.ok((row?.avgToolMs ?? 0) >= 10, "tool duration should be measured");
  assert.ok(snap.events.some((event) => event.type === "tool_end"));

  const html = await fetch(`http://127.0.0.1:${port}/`).then((res) => res.text());
  assert.match(html, /PilotDeck Trace/);
});

test("multiple plugin instances share one store and one server (cross-runtime blackboard)", async () => {
  const first = (globalThis as unknown as Record<string, unknown>)[SERVER_KEY];
  const second = await loadTracePlugin(); // 另一个 project runtime 的加载
  assert.ok(second.hookCallbacks);
  assert.equal((globalThis as unknown as Record<string, unknown>)[SERVER_KEY], first, "server must not be started twice");
});
