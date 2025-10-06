// services/openai_service.js
import WebSocket from "ws";
import { log } from "../utils/logger.js";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const twilio = require("twilio");

/**
 * ConnectionManager: manages a Twilio WS (incoming from Twilio Media Stream)
 * and a paired OpenAI Realtime WS. It:
 *  - sends session.update with model=gpt-realtime
 *  - forwards Twilio media -> OpenAI (input_audio_buffer.append)
 *  - forwards OpenAI audio deltas -> Twilio media messages
 *  - handles speech_started interruptions and end_call tool
 */
export default class ConnectionManager {
  constructor(twilioWs, options = {}) {
    this.twilioWs = twilioWs;
    this.openaiWs = null;
    this.streamSid = null;
    this.callSid = null;
    this.metrics = { twilioChunks: 0, openaiChunks: 0 };
    this.renewTimer = null;
    this.pendingGoodbye = false;
    this.goodbyeAudioHeard = false;
    this.openaiModel = process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";
    this.systemInstructions = process.env.SYSTEM_INSTRUCTIONS || "You are a helpful assistant.";
    this.sessionRenewMs = Number(process.env.SESSION_RENEW_INTERVAL_MS || 3300000);
    this.twilioClient = (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) ?
      twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN) : null;

    this._initOpenAI();
    this._wireTwilio();
  }

  _makeSessionUpdate() {
    // Mirrors the Python session payload you provided: model 'gpt-realtime' + audio/pcmu
    return {
      type: "session.update",
      session: {
        type: "realtime",
        model: this.openaiModel,
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcmu" },
            turn_detection: { type: "server_vad" }
          },
          output: {
            format: { type: "audio/pcmu" }
          }
        },
        instructions: this.systemInstructions,
        tools: [
          {
            type: "function",
            name: "end_call",
            description: "Politely end the phone call when the caller says goodbye or requests to end the conversation.",
            parameters: {
              type: "object",
              properties: {
                reason: { type: "string", description: "Brief reason for ending." }
              },
              required: []
            }
          }
        ]
      }
    };
  }

  _initialConversationItem() {
    return {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Greet the user with 'Hello there! I am an AI voice assistant powered by Twilio and the OpenAI Realtime API. You can ask me for facts, jokes, or anything you can imagine. How can I help you?'"
          }
        ]
      }
    };
  }

  _createResponseTrigger() {
    return { type: "response.create" };
  }

  _initOpenAI() {
    const openaiUrl = `wss://api.openai.com/v1/realtime`;
    const headers = { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }; // GA: no OpenAI-Beta header
    try {
      this.openaiWs = new WebSocket(openaiUrl, { headers });
    } catch (e) {
      log.error("OpenAI WS create failed", e);
      this.closeAll();
      return;
    }

    this.openaiWs.on("open", async () => {
      log.info("[openai] connected — sending session.update");
      try {
        // send session.update (contains model=gpt-realtime per your Python example)
        this.openaiWs.send(JSON.stringify(this._makeSessionUpdate()));
        // send initial greeting item & response trigger (AI-first greeting)
        const item = this._initialConversationItem();
        this.openaiWs.send(JSON.stringify(item));
        this.openaiWs.send(JSON.stringify(this._createResponseTrigger()));
      } catch (e) {
        log.error("[openai] send failed", e);
      }

      // set a periodic renew to avoid stale sessions for long calls
      this.renewTimer = setInterval(() => {
        if (this.openaiWs && this.openaiWs.readyState === WebSocket.OPEN) {
          log.debug("[openai] renewing session");
          this.openaiWs.send(JSON.stringify(this._makeSessionUpdate()));
        }
      }, this.sessionRenewMs);
    });

    this.openaiWs.on("message", (raw) => this._handleOpenAIMessage(raw));
    this.openaiWs.on("error", (err) => {
      log.error("[openai] ws error:", err);
      this.closeAll();
    });
    this.openaiWs.on("close", (code, reason) => {
      log.info("[openai] ws closed", code, reason?.toString?.() ?? reason);
      this.closeAll();
    });
  }

  async _handleOpenAIMessage(raw) {
    // try JSON parse
    let ev;
    try { ev = typeof raw === "string" ? JSON.parse(raw) : JSON.parse(raw.toString()); }
    catch (e) {
      log.debug("[openai] non-json message (ignored)");
      return;
    }

    log.debug("[openai:event]", ev.type);

    // 1) speech_started -> try to cancel model TTS
    if (ev.type === "input_audio_buffer.speech_started") {
      log.info("[openai] user speech started -> sending response.cancel");
      try { this.openaiWs.send(JSON.stringify({ type: "response.cancel" })); }
      catch (e) { log.warn("[openai] response.cancel failed", e); }
    }

    // 2) audio delta extraction (various possible keys)
    const audioBase64 = this._extractAudioFromEvent(ev);
    if (audioBase64 && this.streamSid) {
      const mediaMsg = { event: "media", streamSid: this.streamSid, media: { payload: audioBase64 } };
      try {
        this.twilioWs.send(JSON.stringify(mediaMsg));
        this.metrics.openaiChunks++;
      } catch (e) {
        log.warn("[twilio] forward audio failed", e);
      }
    }

    // 3) tool/function call detection (end_call)
    const tool = this._extractToolCall(ev);
    if (tool && tool.name === "end_call") {
      log.info("[openai] end_call tool invoked:", tool.arguments || {});
      await this._handleEndCall(tool.arguments || {});
    }

    // 4) response completed events — hook to finalize goodbye if pending
    if (this.pendingGoodbye && (ev.type === "response.output_audio.done" || ev.type === "response.done")) {
      // finalize hangup sequence (small grace)
      await this._finalizeGoodbye();
    }
  }

  _extractAudioFromEvent(ev) {
    // flexible extraction: supports response.output_audio.delta / response.audio.delta / chunk / output_audio.data
    try {
      if ((ev.type === "response.output_audio.delta" || ev.type === "response.audio.delta") && ev.delta) {
        if (typeof ev.delta === "string") return ev.delta;
        if (ev.delta.audio) return ev.delta.audio;
      }
      if (ev.chunk) return ev.chunk;
      if (ev.output_audio && ev.output_audio.data) return ev.output_audio.data;
      if (ev.delta && typeof ev.delta === "string") return ev.delta;
    } catch (e) {
      log.debug("[openai] audio extraction error", e);
    }
    return null;
  }

  _extractToolCall(ev) {
    // accumulate streaming function_call args is more work — do a simple detection for end_call
    try {
      if (ev.type === "response.function_call.arguments.delta" || ev.type === "response.function_call.completed") {
        // handle streaming accumulation if needed (not implemented here)
        return null;
      }
      if (ev.type === "response.done") {
        const resp = ev.response || {};
        const out = resp.output || [];
        for (const item of out) {
          if (item?.type === "function_call" && item?.name === "end_call") {
            // arguments could be string or object
            const raw = item.arguments;
            let args = {};
            try { args = typeof raw === "string" ? JSON.parse(raw) : (raw || {}); } catch (e) { args = { _raw: raw }; }
            return { name: "end_call", arguments: args };
          }
        }
      }
    } catch (e) {
      log.debug("[openai] tool extraction error", e);
    }
    return null;
  }

  async _handleEndCall(args) {
    if (this.pendingGoodbye) {
      log.info("End call already pending — ignoring duplicate.");
      return;
    }
    this.pendingGoodbye = true;
    const reason = args?.reason || "";
    const goodbyeText = `Goodbye. ${reason || "Thank you for calling Finlumina."}`;

    // queue a final response.create with instructions/goodbye
    try {
      await this.sendToOpenAI({
        type: "response.create",
        response: { instructions: goodbyeText }
      });
    } catch (e) {
      log.warn("Failed to queue goodbye response.create", e);
    }

    // start a graceful finalize timer: the finalize will attempt Twilio REST hangup if creds exist
    setTimeout(async () => { await this._finalizeGoodbye(); }, 2000);
  }

  async _finalizeGoodbye() {
    // attempt Twilio REST hangup if we have callSid and REST creds
    try {
      if (this.twilioClient && this.callSid) {
        log.info("[twilio] completing call via REST", this.callSid);
        await this.twilioClient.calls(this.callSid).update({ status: "completed" });
      }
    } catch (e) {
      log.warn("[twilio] REST hangup failed", e);
    }
    // close websockets
    this.closeAll();
  }

  async sendToOpenAI(obj) {
    if (!this.openaiWs || this.openaiWs.readyState !== WebSocket.OPEN) {
      log.warn("[openai] not open - cannot send");
      return;
    }
    try { this.openaiWs.send(JSON.stringify(obj)); }
    catch (e) { log.warn("[openai] send failed", e); }
  }

  _wireTwilio() {
    this.twilioWs.on("message", (raw) => {
      let ev;
      try { ev = typeof raw === "string" ? JSON.parse(raw) : JSON.parse(raw.toString()); }
      catch (e) { log.debug("[twilio] non-json msg"); return; }

      // Save stream/call info
      if (ev.event === "start" && ev.start) {
        this.streamSid = ev.start.streamSid || ev.start.sid;
        this.callSid = ev.start.callSid || ev.start.call_sid || this.callSid;
        log.info(`[twilio] start streamSid=${this.streamSid} callSid=${this.callSid}`);
      }

      // inbound audio -> forward to OpenAI as input_audio_buffer.append
      if (ev.event === "media" && ev.media && ev.media.payload) {
        // Twilio payload is base64 µ-law @8k; the session.update we sent requested audio/pcmu,
        // so forward it directly as input_audio_buffer.append
        try {
          if (this.openaiWs && this.openaiWs.readyState === WebSocket.OPEN) {
            const msg = { type: "input_audio_buffer.append", audio: ev.media.payload };
            this.openaiWs.send(JSON.stringify(msg));
            this.metrics.twilioChunks++;
          } else {
            log.warn("[openai] not ready (drop audio chunk)");
          }
        } catch (e) { log.error("[openai] forward error", e); }
      }

      // twilio stop/disconnect -> commit + response.create
      if (ev.event === "stop" || ev.event === "disconnect") {
        log.info("[twilio] stream stopped");
        try {
          if (this.openaiWs && this.openaiWs.readyState === WebSocket.OPEN) {
            this.openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
            this.openaiWs.send(JSON.stringify({ type: "response.create" }));
          }
        } catch (e) { log.warn("[openai] commit/create failed", e); }
        // close
        this.closeAll();
      }
    });

    this.twilioWs.on("close", () => {
      log.info("[twilio] ws closed");
      this.closeAll();
    });
    this.twilioWs.on("error", (err) => {
      log.error("[twilio] ws err", err);
      this.closeAll();
    });
  }

  closeAll() {
    try { if (this.renewTimer) clearInterval(this.renewTimer); } catch {}
    try { if (this.openaiWs && this.openaiWs.readyState === WebSocket.OPEN) this.openaiWs.close(); } catch {}
    try { if (this.twilioWs && this.twilioWs.readyState === WebSocket.OPEN) this.twilioWs.close(); } catch {}
    log.info("[session] closed & cleaned up", { streamSid: this.streamSid, callSid: this.callSid, metrics: this.metrics });
  }
}