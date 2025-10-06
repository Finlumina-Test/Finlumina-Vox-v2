// routes/voice.js
import { Router } from "express";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const twilio = require("twilio");
const { twiml: TwilioTwiml } = twilio;

const router = Router();

const PUBLIC_HOST = process.env.PUBLIC_HOST || "finlumina-vox-v2.onrender.com";

router.post("/incoming-call", (req, res) => {
  const vr = new TwilioTwiml.VoiceResponse();
  // nicer Google NN voice for greeting
  vr.say({ voice: "Google.en-US-Neural2-C" }, "Please wait while we connect your call to the AI voice assistant powered by Twilio and the OpenAI Realtime API.");
  const con = vr.connect();
  // bidirectional Connect Stream to our /media upgrade endpoint
  con.stream({ url: `wss://${PUBLIC_HOST}/media` });
  res.type("text/xml").send(vr.toString());
});

export default router;