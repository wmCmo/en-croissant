// Relay between the offline puzzle app and the PC, for networks where the
// tailnet drops big packets. The phone posts attempts here; the PC's
// relay-sync.mjs pulls them into the log and pushes back the current pack and
// which of its puzzles are done. Every call needs the shared token.
//
// It also serves the app itself (static assets from site/, copied from public/
// by deploy.mjs) for when the tailnet can't deliver it; a device opened there
// pairs once: it shows a code, and `node relay-sync.mjs approve <code>` on the
// PC lets its key in.
//
// KV: "a:<puzzleId>" = attempt waiting for the PC, "state" = { packId, done, pack },
// "pair:<code>" = device key awaiting approval (1 h), "dev:<key>" = paired device

// The app's origin comes from the ALLOWED_ORIGIN secret, so it stays out of the repo.
let allowedOrigin = "";

function cors(req) {
  return {
    "access-control-allow-origin": allowedOrigin,
    "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

function json(req, status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...cors(req) },
  });
}

function sameString(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** "admin" (the PC, env.TOKEN), "device" (a paired app), or null. */
async function role(req, env) {
  const got = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  if (!got) return null;
  if (env.TOKEN && sameString(got, env.TOKEN)) return "admin";
  if (got.length >= 32 && (await env.KV.get(`dev:${got}`))) return "device";
  return null;
}

function validAttempt(a) {
  return (
    a &&
    a.v === 1 &&
    a.source === "offline" &&
    Number.isInteger(a.puzzleId) &&
    typeof a.solved === "boolean" &&
    typeof a.ts === "string"
  );
}

export default {
  async fetch(req, env) {
    allowedOrigin = env.ALLOWED_ORIGIN ?? "";
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
    const { pathname, origin } = new URL(req.url);

    // public: the app served from here reads its relay config and pack here
    if (req.method === "GET" && pathname === "/relay.json") return json(req, 200, { url: origin });
    if (req.method === "GET" && pathname === "/pack.json") {
      const state = await env.KV.get("state", "json");
      return state?.pack ? json(req, 200, state.pack) : json(req, 404, { error: "no pack yet" });
    }
    // public: a new device asks to be paired; the PC approves its code
    if (req.method === "POST" && pathname === "/pair") {
      const body = await req.json().catch(() => null);
      const key = typeof body?.key === "string" && body.key.length >= 32 && body.key.length <= 128 ? body.key : null;
      if (!key) return json(req, 400, { error: "bad key" });
      const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
      await env.KV.put(`pair:${code}`, key, { expirationTtl: 3600 });
      return json(req, 200, { code });
    }

    const who = await role(req, env);
    if (!who) return json(req, 401, { error: "unauthorised" });
    if (req.method === "GET" && pathname === "/whoami") return json(req, 200, { role: who });
    const deviceAllowed = (req.method === "POST" && pathname === "/attempts") || (req.method === "GET" && pathname === "/state");
    if (who !== "admin" && !deviceAllowed) return json(req, 403, { error: "forbidden" });

    // PC: approve a pairing code shown on a device
    if (req.method === "POST" && pathname === "/approve") {
      const body = await req.json().catch(() => null);
      const key = await env.KV.get(`pair:${body?.code}`);
      if (!key) return json(req, 404, { error: "unknown or expired code" });
      await env.KV.put(`dev:${key}`, new Date().toISOString());
      await env.KV.delete(`pair:${body.code}`);
      return json(req, 200, { ok: true });
    }

    // phone: hand over finished attempts
    if (req.method === "POST" && pathname === "/attempts") {
      const body = await req.json().catch(() => null);
      const attempts = Array.isArray(body?.attempts) ? body.attempts.slice(0, 200) : null;
      if (!attempts) return json(req, 400, { error: "attempts must be an array" });
      const accepted = [];
      for (const a of attempts) {
        if (!validAttempt(a)) continue;
        await env.KV.put(`a:${a.puzzleId}`, JSON.stringify(a));
        accepted.push(a.puzzleId);
      }
      return json(req, 200, { accepted });
    }

    // phone: current pack and which of its puzzles are done (as last pushed by the PC)
    if (req.method === "GET" && pathname === "/state") {
      const state = await env.KV.get("state", "json");
      return json(req, 200, state ?? { packId: null, done: {}, pack: null });
    }

    // PC: attempts waiting to be logged
    if (req.method === "GET" && pathname === "/pending") {
      const list = await env.KV.list({ prefix: "a:" });
      const attempts = [];
      for (const k of list.keys) {
        const a = await env.KV.get(k.name, "json");
        if (a) attempts.push(a);
      }
      return json(req, 200, { attempts });
    }

    // PC: these are in the log now
    if (req.method === "POST" && pathname === "/ack") {
      const body = await req.json().catch(() => null);
      const ids = Array.isArray(body?.ids) ? body.ids : [];
      for (const id of ids) if (Number.isInteger(id)) await env.KV.delete(`a:${id}`);
      return json(req, 200, { deleted: ids.length });
    }

    // PC: publish the current pack and done map
    if (req.method === "PUT" && pathname === "/state") {
      const body = await req.json().catch(() => null);
      if (!body || typeof body.packId !== "string") return json(req, 400, { error: "bad state" });
      await env.KV.put("state", JSON.stringify(body));
      return json(req, 200, { ok: true });
    }

    return json(req, 404, { error: "not found" });
  },
};
