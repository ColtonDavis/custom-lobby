import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import morgan from "morgan";

const PORT = process.env.PORT || 10000;

const app = express();
app.use(morgan("dev"));

app.get("/_status", (req, res) => {
  res.json({ ok: true, ts: Date.now(), service: "gateway_custom" });
});

app.get("/", (req, res) => {
  res.send("🚀 gateway_custom running");
});

const server = http.createServer(app);

// --- WebSocket server for /custom (upgrade handler)
const wss = new WebSocketServer({ noServer: true });

/**
 * Simple room manager (in-memory)
 * Rooms: { roomId: Set<ws> }
 */
const rooms = new Map();

function broadcastToRoom(roomId, sender, messageObj) {
  const room = rooms.get(roomId);
  if (!room) return;
  const msgString = JSON.stringify(messageObj);
  for (const ws of room) {
    if (ws.readyState === ws.OPEN && ws !== sender) {
      ws.send(msgString);
    }
  }
}

wss.on("connection", (ws, req) => {
  ws.meta = { room: null, id: null };

  ws.on("message", (m) => {
    let msg;
    try {
      msg = JSON.parse(m.toString());
    } catch {
      console.warn("Invalid JSON:", m.toString().slice(0, 200));
      return;
    }

    const { type, room, id, payload } = msg;

    if (type === "join") {
      ws.meta.room = room;
      ws.meta.id = id;
      if (!rooms.has(room)) rooms.set(room, new Set());
      rooms.get(room).add(ws);
      console.log(`ws join: ${id} -> ${room} (${rooms.get(room).size} members)`);
      ws.send(JSON.stringify({ type: "joined", room, id }));
      broadcastToRoom(room, ws, { type: "player_join", room, id });
      return;
    }

    if (type === "leave") {
      const r = ws.meta.room || room;
      if (r && rooms.has(r)) {
        rooms.get(r).delete(ws);
        broadcastToRoom(r, ws, { type: "player_leave", room: r, id: ws.meta.id || id });
        ws.meta.room = null;
      }
      return;
    }

    if (["move", "shoot", "chat"].includes(type)) {
      broadcastToRoom(room || ws.meta.room, ws, {
        type,
        room: room || ws.meta.room,
        id: id || ws.meta.id,
        payload,
      });
    }
  });

  ws.on("close", () => {
    const r = ws.meta.room;
    if (r && rooms.has(r)) {
      rooms.get(r).delete(ws);
      broadcastToRoom(r, ws, { type: "player_leave", room: r, id: ws.meta.id });
    }
  });

  ws.on("error", (err) => {
    console.error("ws error:", err.message);
  });
});

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/custom") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`http/ws listening on ${PORT}`);
});
