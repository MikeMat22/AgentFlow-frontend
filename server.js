const express = require("express");
const { WebSocket } = require("ws");
const { v4: uuidv4 } = require("uuid");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const OPENCLAW_WS    = process.env.OPENCLAW_WS    || "ws://127.0.0.1:18789";
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN || "ollama";
const PORT           = process.env.PORT           || 3000;

const sessions = new Map();

function getOrCreateSession(sessionId) {
  if (sessions.has(sessionId)) return sessions.get(sessionId);

  const ws = new WebSocket(`${OPENCLAW_WS}?token=${OPENCLAW_TOKEN}`, {
    headers: { "Origin": `http://localhost:${PORT}` }
  });
  const ctx = { ws, queue: [], ready: false };

  ws.on("open", () => {
    console.log(`[${sessionId.slice(0,8)}] connected`);
  });

  ws.on("close", (code, reason) => {
    console.log(`[${sessionId.slice(0,8)}] closed ${code} "${reason}"`);
    sessions.delete(sessionId);
  });

  ws.on("error", (err) => {
    console.error(`[${sessionId.slice(0,8)}] error:`, err.message);
    for (const item of ctx.queue) item.reject?.(err);
    ctx.queue = [];
    sessions.delete(sessionId);
  });

  ws.on("message", (raw) => {
    const str = raw.toString();
    console.log(`[${sessionId.slice(0,8)}] <`, str.slice(0, 300));

    let msg;
    try { msg = JSON.parse(str); } catch { msg = null; }

    // Challenge → connect req bez device podpisu
    if (msg && msg.event === "connect.challenge") {
      const nonce = msg.payload?.nonce;
      const req = {
        type: "req",
        id: uuidv4(),
        method: "connect",
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            id: "openclaw-control-ui",
            version: "1.0.0",
            platform: "macos",
            mode: "webchat"
          },
          role: "operator",
          scopes: ["operator.read", "operator.write", "operator.admin"],
          caps: [],
          commands: [],
          permissions: {},
          auth: { token: OPENCLAW_TOKEN },
          locale: "en-US",
          userAgent: "openclaw-control-ui/1.0.0",
        }
      };
      console.log(`[${sessionId.slice(0,8)}] > connect (nonce=${nonce.slice(0,8)}...)`);
      ws.send(JSON.stringify(req));
      return;
    }

    // Auth OK
    if (msg && msg.type === "res" && msg.ok === true && msg.payload?.type === "hello-ok") {
      console.log('METHODS:', JSON.stringify(msg.payload?.features?.methods));
    }
    if (msg && (
      msg.type === "res" && msg.ok === true ||
      msg.event === "connect.ok" ||
      msg.event === "hello.ok" ||
      msg.event === "ready"
    )) {
      console.log(`[${sessionId.slice(0,8)}] ✓ ready`);
      ctx.ready = true;
      return;
    }

    // Error response
    if (msg && msg.type === "res" && msg.ok === false) {
      console.error(`[${sessionId.slice(0,8)}] error:`, msg.error?.message);
      return;
    }

    if (!ctx.ready) {
      ctx.ready = true;
      console.log(`[${sessionId.slice(0,8)}] ✓ ready (implicit)`);
    }

    if (!ctx.queue.length) return;
    handleIncoming(ctx, msg, str);
  });

  sessions.set(sessionId, ctx);
  return ctx;
}

function handleIncoming(ctx, msg, raw) {
  const cur = ctx.queue[0];
  if (!cur) return;
  if (!msg) { cur.onChunk?.(raw); return; }

  // Ignore res ok from chat.send (just "started")
  if (msg.type === "res" && msg.payload?.status === "started") return;
  if (msg.type === "res" && msg.ok === false) return;

  // Agent stream events - this is where content comes
  if (msg.type === "event" && msg.event === "agent") {
    const stream = msg.payload?.stream;
    const d = msg.payload?.data;
    if (stream === "assistant" && d) {
      const text = d.delta || d.text || d.content || "";
      if (text) cur.onChunk?.(text);
      return;
    }
    if (stream === "lifecycle" && d?.phase === "end") {
      cur.onDone?.(); ctx.queue.shift(); return;
    }
    return;
  }

  // Fallback streaming
  const t = msg.type || msg.event || "";
  if (["content","delta","chunk","text"].includes(t)) {
    const text = msg.content || msg.delta || msg.text || "";
    if (text) cur.onChunk?.(text); return;
  }
  if (["end","done","complete","stop"].includes(t)) {
    cur.onDone?.(); ctx.queue.shift(); return;
  }
}

function waitReady(ctx) {
  return new Promise((resolve, reject) => {
    if (ctx.ready) return resolve();
    const deadline = setTimeout(() => reject(new Error("Handshake timeout")), 10000);
    const iv = setInterval(() => {
      if (ctx.ready) { clearInterval(iv); clearTimeout(deadline); resolve(); }
      if (ctx.ws.readyState === WebSocket.CLOSED) {
        clearInterval(iv); clearTimeout(deadline);
        reject(new Error("WS closed during handshake"));
      }
    }, 50);
  });
}

app.post("/api/chat", async (req, res) => {
  const { message, sessionId = uuidv4() } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: "message required" });

  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.setHeader("X-Session-Id",  sessionId);
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    const ctx = getOrCreateSession(sessionId);
    await waitReady(ctx);

    await new Promise((resolve, reject) => {
      ctx.queue.push({
        onChunk: (text) => send("chunk", { text }),
        onDone:  ()     => { send("done", {}); resolve(); },
        reject,
      });

      const payload = JSON.stringify({
        type: "req",
        id: uuidv4(),
        method: "chat.send",
        params: { message, sessionKey: sessionId, idempotencyKey: require("crypto").randomUUID() }
      });
      console.log(`[${sessionId.slice(0,8)}] > chat: ${message.slice(0,60)}`);
      ctx.ws.send(payload);
    });

  } catch (err) {
    console.error("Chat error:", err.message);
    send("error", { message: err.message });
  }

  res.end();
});

app.get("/api/status", (req, res) => {
  const ws = new WebSocket(`${OPENCLAW_WS}?token=${OPENCLAW_TOKEN}`, {
    headers: { "Origin": `http://localhost:${PORT}` }
  });
  const t = setTimeout(() => { ws.terminate(); res.json({ ok: false, error: "timeout" }); }, 3000);
  ws.on("open",  () => { clearTimeout(t); ws.close(); res.json({ ok: true, gateway: OPENCLAW_WS }); });
  ws.on("error", (e) => { clearTimeout(t); res.json({ ok: false, error: e.message }); });
});

app.listen(PORT, () => {
  console.log(`\n  🤖 OpenClaw Wrapper → http://localhost:${PORT}`);
  console.log(`  🔗 Gateway: ${OPENCLAW_WS}\n`);
});
