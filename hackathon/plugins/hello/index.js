export default function (api) {
  api.registerTool({
    name: "hello_sessions",
    description: "List PilotDeck sessions via the extension API (阶段一验收).",
    kind: "custom",
    inputSchema: { type: "object", properties: {} },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute() {
      const result = await api.listSessions();
      return { content: [{ type: "text", text: JSON.stringify(result.sessions, null, 2) }] };
    },
  });
  api.registerCommand("ping", () => "pong from hello plugin");
  api.onHook("PostToolUse", () => {});
  api.emitStatus("demo/session", "doing", "hello plugin loaded");
}
