/**
 * FRAME backend — holds the Anthropic API key so users never see it.
 * Zero dependencies: plain Node.js (>=20). Deploy free on Render/Railway.
 *
 * Env vars:
 *   ANTHROPIC_API_KEY  (required) — your key from console.anthropic.com
 *   APP_SECRET         (optional) — if set, requests must send x-app-secret header
 *   MODEL              (optional) — defaults to claude-sonnet-4-5
 *   PORT               (optional) — defaults to 3000; Render sets this automatically
 */
const http = require("http");

const API_KEY = process.env.ANTHROPIC_API_KEY;
const APP_SECRET = process.env.APP_SECRET || "";
const MODEL = process.env.MODEL || "claude-sonnet-4-5";
const PORT = process.env.PORT || 3000;

if (!API_KEY) {
  console.error("FATAL: ANTHROPIC_API_KEY env var is not set.");
  process.exit(1);
}

/* ---------- tiny per-IP rate limiter: 10 requests / minute ---------- */
const hits = new Map(); // ip -> [timestamps]
const RATE_MAX = 10;
const RATE_WINDOW = 60 * 1000;
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW);
  if (arr.length >= RATE_MAX) { hits.set(ip, arr); return true; }
  arr.push(now);
  hits.set(ip, arr);
  return false;
}
setInterval(() => { // prune stale IPs so memory stays flat
  const now = Date.now();
  for (const [ip, arr] of hits) {
    const live = arr.filter((t) => now - t < RATE_WINDOW);
    if (live.length) hits.set(ip, live); else hits.delete(ip);
  }
}, 5 * 60 * 1000).unref();

/* ---------- the coach persona (server-side: this is your IP) ---------- */
const COACH_SYSTEM = [
  "You are FRAME, an elite texting coach for men. Your philosophy: masculine frame, non-neediness, scarcity, playful confidence, decisive leadership, and outcome independence. The man is the prize as much as she is. He never chases, never over-invests, never gets defensive, never asks for permission.",
  "Your voice: direct, a little cocky, funny, zero fluff. Like an older brother who's good with women and tired of watching his guys fumble.",
  "Reply style rules you enforce:",
  "- Brevity. Replies are usually shorter than her message, almost never longer.",
  "- Mirror her investment, then lead it one step forward.",
  "- Tests get playful agreement or a tease — never defense or explanation.",
  "- Texting is for logistics and light flirting. Push toward a real date, not a pen-pal dynamic.",
  "- Sometimes the highest-value reply is NO reply. If he was left on read, if her investment is near zero, or if replying would be chasing, the correct coaching is silence — put the phone down and live. Never generate a double text to someone who hasn't answered the first one.",
  "- Punctuation is relaxed, emojis are rare (one max, usually zero), exclamation points are almost never used.",
  "- No 'lol' padding, no 'haha' unless it's doing real work, no hedging words like 'maybe', 'possibly', 'if you want'.",
  "Hard lines you never cross: nothing manipulative, degrading, dishonest, or disrespectful toward women. Confidence, not cruelty. If her message clearly signals genuine disinterest or a firm no, the high-value move is graceful exit — say so plainly instead of generating chase texts.",
  "Always respond with pure JSON only. No markdown fences, no commentary outside the JSON.",
].join("\n");

async function callClaude(userPrompt, imageBlocks) {
  const content = imageBlocks && imageBlocks.length
    ? [...imageBlocks, { type: "text", text: userPrompt }]
    : userPrompt;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      system: COACH_SYSTEM,
      messages: [{ role: "user", content }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Upstream API error ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = (data.content || []).map((b) => b.text || "").join("");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Model returned no JSON");
  return JSON.parse(text.slice(start, end + 1));
}

const clip = (s, n) => String(s || "").slice(0, n).trim();

const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_IMAGE_B64 = 4 * 1024 * 1024; // per image
const MAX_IMAGES = 6;

function buildGeneratePrompt({ her, stage, context, imageCount }) {
  return [
    imageCount
      ? `${imageCount} screenshot(s) of their text conversation are attached, in the order he added them (oldest part of the conversation first — but verify against any visible timestamps). Read them carefully: in most messaging apps HIS messages are the bubbles on the RIGHT (often blue/green) and HER messages are on the LEFT (often grey/white) — use timestamps, contact name, and context to confirm who is who. Reconstruct the full thread across all screenshots, pay attention to who is investing more, response gaps, and how the conversation has been flowing. Her most recent message is what he needs to respond to.` + (her ? ` He adds: "${her}"` : "")
      : her
      ? `Her message: "${her}"`
      : "Her message: (none — she has not replied. He is tempted to text again.)",
    `Stage of the interaction: ${stage || "unknown"}`,
    context ? `Extra context from him: ${context}` : "",
    "",
    "FIRST, decide whether he should respond at all. If he was left on read, if her investment is near zero, if replying now would be a double text or chasing — silence is the play. Be strict about this: most men text when they shouldn't.",
    "",
    "THEN generate exactly 5 reply options, each a different flavor drawn from: playful tease, confident direct, scarcity/brevity (short, almost dismissive), the date-setter (decisive concrete plan), and the curveball (unexpected, pattern-breaking, memorable). Adapt the five to what her message actually calls for. If her message is a test, at least one reply should pass it with playful agreement. If silence is recommended, the 5 replies become 'only if and when she reaches out again' options — never double texts. If her message signals genuine firm disinterest, the silence recommendation should be a permanent walk-away and you should say so.",
    "",
    "Return JSON exactly in this shape:",
    '{"reads_as": "one blunt sentence on what her text (or her silence) is really doing/testing", "silence": {"recommended": true or false, "why": "2-3 blunt sentences: why not texting (or texting) is the move, and what he should go do instead"}, "replies": [{"style": "2-4 word style label", "text": "the reply to send", "why": "1-2 punchy sentences on why this works and what it signals"}]}',
  ].join("\n");
}

function buildRatePrompt({ herLast, draft }) {
  return [
    herLast ? `Her last message: "${herLast}"` : "Her last message: (not provided)",
    `His draft reply: "${draft}"`,
    "",
    "Score this draft as his texting coach. Be honest — if it's needy, say so. If it's already strong, don't invent problems.",
    "",
    "Return JSON exactly in this shape:",
    '{"score": 0-100, "verdict": "short punchy headline verdict", "summary": "2-3 sentences of straight talk about the draft", "breakdown": {"Frame": 0-100, "Neediness check": 0-100, "Brevity": 0-100, "Playfulness": 0-100}, "improved": "the stronger version he should send instead", "improved_why": "1-2 sentences on what changed and why"}',
    "Note: higher is always better in every category. 'Neediness check' = 100 means zero neediness.",
  ].join("\n");
}

/* ---------- http server ---------- */
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, x-app-secret",
    "access-control-allow-methods": "POST, GET, OPTIONS",
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, {});
  const url = (req.url || "").split("?")[0];

  if (req.method === "GET" && url === "/health") return send(res, 200, { ok: true, model: MODEL });

  if (req.method === "POST" && (url === "/api/generate" || url === "/api/rate")) {
    const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
    if (rateLimited(ip)) return send(res, 429, { error: "Slow down. 10 requests a minute is plenty of game." });
    if (APP_SECRET && req.headers["x-app-secret"] !== APP_SECRET) return send(res, 401, { error: "Unauthorized." });

    let raw = "";
    let size = 0;
    const maxBody = url === "/api/generate" ? 8 * 1024 * 1024 : 32 * 1024; // screenshots allowed on generate
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBody) { req.destroy(); return; }
      raw += c;
    });
    req.on("end", async () => {
      let body = {};
      try { body = JSON.parse(raw || "{}"); } catch (e) { return send(res, 400, { error: "Bad JSON." }); }
      try {
        if (url === "/api/generate") {
          const her = clip(body.her, 2000);
          const stage = clip(body.stage, 200);
          const context = clip(body.context, 2000);

          // accept images: [...] (new) or image: {...} (legacy single)
          let rawImages = Array.isArray(body.images) ? body.images : body.image ? [body.image] : [];
          if (rawImages.length > MAX_IMAGES) return send(res, 400, { error: `Max ${MAX_IMAGES} screenshots per request.` });
          const imageBlocks = [];
          for (const im of rawImages) {
            if (!im || typeof im !== "object") continue;
            const mt = String(im.media_type || "");
            const data = String(im.data || "");
            if (!ALLOWED_IMAGE_TYPES.includes(mt)) return send(res, 400, { error: "Unsupported image type." });
            if (!data || data.length > MAX_IMAGE_B64) return send(res, 400, { error: "One of the screenshots is too large — try again." });
            if (!/^[A-Za-z0-9+/=]+$/.test(data)) return send(res, 400, { error: "Bad image data." });
            imageBlocks.push({ type: "image", source: { type: "base64", media_type: mt, data } });
          }

          if (!her && !imageBlocks.length && !stage.includes("left on read")) return send(res, 400, { error: "Missing her message." });
          return send(res, 200, await callClaude(buildGeneratePrompt({ her, stage, context, imageCount: imageBlocks.length }), imageBlocks));
        } else {
          const herLast = clip(body.herLast, 2000);
          const draft = clip(body.draft, 2000);
          if (!draft) return send(res, 400, { error: "Missing draft." });
          return send(res, 200, await callClaude(buildRatePrompt({ herLast, draft })));
        }
      } catch (e) {
        console.error(e.message);
        return send(res, 502, { error: "The coach is unavailable right now. Try again in a minute." });
      }
    });
    return;
  }

  send(res, 404, { error: "Not found." });
});

server.listen(PORT, () => console.log(`FRAME backend listening on :${PORT}`));
