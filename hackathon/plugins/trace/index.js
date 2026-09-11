import http from "node:http";

/**
 * trace — 执行过程实时投影插件（Hackathon 阶段二）。
 *
 * 结构照搬 pi-trace：hooks 订阅 → 聚合 store → Web 面板。
 * 每个 project runtime 各自加载本插件（模块实例因 cache-busting 互不共享），
 * 所以聚合 store 和 HTTP server 都挂在 globalThis 上，保证同进程全局唯一：
 * 任意会话的 hook 事件汇进同一块黑板，面板只起一份。
 */

const STORE_KEY = "__pilotdeck_trace_store__";
const SERVER_KEY = "__pilotdeck_trace_server__";
const MAX_EVENTS = 500;
const PORT = Number(process.env.PILOTDECK_TRACE_PORT ?? 4789);

function getStore() {
  if (!globalThis[STORE_KEY]) {
    globalThis[STORE_KEY] = {
      startedAt: Date.now(),
      events: [], // ring buffer，最新在末尾
      sessions: new Map(), // sessionId -> aggregate
    };
  }
  return globalThis[STORE_KEY];
}

function sessionAgg(store, sessionId, cwd) {
  let agg = store.sessions.get(sessionId);
  if (!agg) {
    agg = {
      sessionId,
      cwd,
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      turns: 0,
      toolCalls: 0,
      toolFailures: 0,
      totalToolMs: 0,
      activeTools: [], // LIFO 栈，PreToolUse 配对 PostToolUse 算耗时
      lastTool: undefined,
      ended: false,
    };
    store.sessions.set(sessionId, agg);
  }
  return agg;
}

function pushEvent(store, event) {
  store.events.push(event);
  if (store.events.length > MAX_EVENTS) {
    store.events.splice(0, store.events.length - MAX_EVENTS);
  }
}

function toolName(input) {
  return input.toolName ?? input.tool_name ?? "unknown";
}

function recordHook(store, type, input) {
  const now = Date.now();
  const agg = sessionAgg(store, input.sessionId ?? "unknown", input.cwd ?? "");
  agg.lastSeen = now;

  const event = { ts: now, type, session: agg.sessionId, cwd: agg.cwd };
  if (type === "turn_start") {
    agg.turns += 1;
  } else if (type === "tool_start") {
    agg.activeTools.push({ name: toolName(input), startedAt: now });
    event.tool = toolName(input);
  } else if (type === "tool_end" || type === "tool_fail") {
    const started = agg.activeTools.pop();
    const ms = started ? now - started.startedAt : undefined;
    agg.toolCalls += 1;
    agg.lastTool = started?.name ?? toolName(input);
    if (ms !== undefined) agg.totalToolMs += ms;
    if (type === "tool_fail") agg.toolFailures += 1;
    event.tool = agg.lastTool;
    event.ms = ms;
  } else if (type === "session_end") {
    agg.ended = true;
  }
  pushEvent(store, event);
}

function snapshot(store) {
  return {
    startedAt: store.startedAt,
    sessions: [...store.sessions.values()]
      .map((agg) => ({
        sessionId: agg.sessionId,
        cwd: agg.cwd,
        turns: agg.turns,
        toolCalls: agg.toolCalls,
        toolFailures: agg.toolFailures,
        avgToolMs: agg.toolCalls > 0 ? Math.round(agg.totalToolMs / agg.toolCalls) : 0,
        lastTool: agg.lastTool,
        activeMs: agg.lastSeen - agg.firstSeen,
        ended: agg.ended,
      }))
      .sort((a, b) => b.activeMs - a.activeMs),
    events: store.events.slice(-80),
  };
}

const PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>PilotDeck Trace</title>
<style>
  body { font-family: ui-monospace, Menlo, monospace; background: #0d1117; color: #c9d1d9; margin: 24px; }
  h1 { font-size: 18px; } h2 { font-size: 14px; color: #8b949e; margin-top: 28px; }
  table { border-collapse: collapse; width: 100%; } td, th { border: 1px solid #30363d; padding: 6px 10px; font-size: 12px; text-align: left; }
  th { background: #161b22; }
  .fail { color: #f85149; } .ok { color: #3fb950; } .dim { color: #8b949e; }
  #events { font-size: 12px; white-space: pre-wrap; }
</style></head><body>
<h1>🛰 PilotDeck Trace <span class="dim" id="meta"></span></h1>
<h2>Sessions（轮次 / 工具调用 / 耗时）</h2>
<table><thead><tr><th>session</th><th>cwd</th><th>轮次</th><th>工具调用</th><th>失败</th><th>均耗时 ms</th><th>活跃时长 s</th><th>状态</th></tr></thead><tbody id="rows"></tbody></table>
<h2>实时事件流</h2><div id="events"></div>
<script>
async function refresh() {
  const snap = await fetch('/api/snapshot').then(r => r.json());
  document.getElementById('meta').textContent = 'since ' + new Date(snap.startedAt).toLocaleTimeString();
  document.getElementById('rows').innerHTML = snap.sessions.map(s =>
    '<tr><td>' + s.sessionId.slice(0, 32) + '</td><td class="dim">' + (s.cwd || '') + '</td><td>' + s.turns +
    '</td><td>' + s.toolCalls + '</td><td class="' + (s.toolFailures ? 'fail' : '') + '">' + s.toolFailures +
    '</td><td>' + s.avgToolMs + '</td><td>' + Math.round(s.activeMs / 1000) +
    '</td><td class="' + (s.ended ? 'dim' : 'ok') + '">' + (s.ended ? 'ended' : 'live') + '</td></tr>').join('');
  document.getElementById('events').innerHTML = snap.events.map(e =>
    '<div><span class="dim">' + new Date(e.ts).toLocaleTimeString() + '</span> ' + e.type +
    (e.tool ? ' <b>' + e.tool + '</b>' : '') + (e.ms !== undefined ? ' <span class="dim">' + e.ms + 'ms</span>' : '') +
    ' <span class="dim">' + String(e.session).slice(0, 24) + '</span></div>').reverse().join('');
}
refresh(); setInterval(refresh, 1000);
</script></body></html>`;

function ensureServer(store) {
  if (globalThis[SERVER_KEY]) {
    return globalThis[SERVER_KEY];
  }
  const server = http.createServer((req, res) => {
    if (req.url === "/api/snapshot") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(snapshot(store)));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  server.on("error", () => {
    // 端口被占（已有实例在服务）——直接复用，不当作错误。
  });
  server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.warn(`[pilotdeck] trace panel: http://localhost:${PORT}`);
  });
  globalThis[SERVER_KEY] = server;
  return server;
}

export default function trace(api) {
  const store = getStore();
  api.onHook("SessionStart", (input) => recordHook(store, "session_start", input));
  api.onHook("UserPromptSubmit", (input) => recordHook(store, "turn_start", input));
  api.onHook("PreToolUse", (input) => recordHook(store, "tool_start", input));
  api.onHook("PostToolUse", (input) => recordHook(store, "tool_end", input));
  api.onHook("PostToolUseFailure", (input) => recordHook(store, "tool_fail", input));
  api.onHook("Stop", (input) => recordHook(store, "turn_end", input));
  api.onHook("SessionEnd", (input) => recordHook(store, "session_end", input));
  ensureServer(store);
}
