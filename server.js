// server.js
import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import routerVoice from "./routes/voice.js";
import ConnectionManager from "./services/openai_service.js";
import { log } from "./utils/logger.js";

dotenv.config();

const PORT = process.env.PORT || 5050;
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/", routerVoice);

app.get("/ping", (_req, res) => res.status(200).send("OK"));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const MAX_CALLS = Number(process.env.MAX_CONCURRENT_CALLS || 10);
let active = 0;

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/media") {
    if (active >= MAX_CALLS) {
      log.warn("Max concurrent reached — rejecting upgrade");
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (twilioWs, req) => {
  active++;
  log.info("New Twilio media connection; active:", active);
  const mgr = new ConnectionManager(twilioWs);
  twilioWs.on("close", () => {
    active = Math.max(0, active - 1);
    log.info("Twilio connection closed; active:", active);
  });
});

server.listen(PORT, () => {
  log.info(`Server listening on ${PORT}`);
});