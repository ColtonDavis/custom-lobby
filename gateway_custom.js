import express from "express";
import http from "http";
import { WebSocketServer } from "ws";   // fixed import
import net from "net";
import morgan from "morgan";

const PORT = process.env.PORT || 10000;
const TCP_PORT = process.env.TCP_PORT || 9000;

const app = express();
app.use(morgan("dev"));
app.get("/_status", (req, res) => res.json({ ok: true, ts: Date.now(), service: "gateway_custom" }));
app.get("/", (req, res) => res.send("🚀 gateway_custom running"));

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
    if (ws.readyState === WebSocket.OPEN && ws !== sender) {
      ws.send(msgString);
    }
  }
}

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.on("pong", () => ws.isAlive = true);

  // store metadata on socket
  ws.meta = { room: null, id: null };

  ws.on("message", (m) => {
    let msg;
    try { msg = JSON.parse(m.toString()); }
    catch (e) { console.warn("Invalid JSON from client:", m.toString().slice(0,200)); return; }

    // Basic message schema: { type: "join"|"move"|"shoot"|"leave"|"chat", room:"room1", id:"player1", payload:{} }
    const { type, room, id, payload } = msg;
    if (type === "join") {
      ws.meta.room = room;
      ws.meta.id = id;
      if (!rooms.has(room)) rooms.set(room, new Set());
      rooms.get(room).add(ws);
      console.log(`ws join: ${id} -> ${room} (${rooms.get(room).size} members)`);
      // ack & broadcast join
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
    if (type === "move" || type === "shoot" || type === "chat") {
      broadcastToRoom(room || ws.meta.room, ws, { type, room: room || ws.meta.room, id: id || ws.meta.id, payload });
      return;
    }
    // other messages (ping/pong)
    if (type === "ping") { ws.send(JSON.stringify({ type: "pong" })); }
  });

  ws.on("close", () => {
    const r = ws.meta.room;
    if (r && rooms.has(r)) {
      rooms.get(r).delete(ws);
      broadcastToRoom(r, ws, { type: "player_leave", room: r, id: ws.meta.id });
    }
  });
});

// upgrade handler for WebSocket
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/custom") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

// --- Minimal TCP server (POC) on port 9000
const tcpServer = net.createServer((s) => {
  console.log("tcp client connected:", s.remoteAddress, s.remotePort);
  s.setEncoding("utf8");
  s.write("HELLO_FROM_GATEWAY\n");

  s.on("data", (d) => {
    console.log("tcp recv:", d.toString().slice(0,200));
    s.write(`ECHO: ${d.toString().slice(0,200)}\n`);
  });

  s.on("end", () => console.log("tcp client disconnected"));

  // 🔑 catch socket errors (prevents crashes)
  s.on("error", (err) => {
    console.error("tcp socket error:", err.message);
  });
});

// 🔑 catch server-level errors too
tcpServer.on("error", (err) => {
  console.error("tcp server error:", err.message);
});

tcpServer.listen(TCP_PORT, () => console.log(`tcp server listening ${TCP_PORT}`));
