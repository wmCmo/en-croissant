// Relay between the offline puzzle app and the PC, for networks where the
// tailnet drops big packets. The phone posts attempts here; the PC's
// relay-sync.mjs pulls them into the log and pushes back the current pack and
// which of its puzzles are done. Every call needs the shared token.
//
// KV: "a:<puzzleId>" = attempt waiting for the PC, "state" = { packId, done, pack }

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

function authorised(req, env) {
  const got = req.headers.get("authorization") ?? "";
  const want = `Bearer ${env.TOKEN}`;
  if (!env.TOKEN || got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
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
    if (!authorised(req, env)) return json(req, 401, { error: "unauthorised" });
    const { pathname } = new URL(req.url);

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
