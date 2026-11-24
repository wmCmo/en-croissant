"use strict";
// Offline puzzle pack: solve on a physical board, enter your moves here,
// results queue in localStorage and sync to the PC when online.

const LS_PACK = "wsp-pack";
const LS_RES = "wsp-results";
// piece images come from pieces.css (En Croissant's Staunty set)
const ROLE = { k: "king", q: "queen", r: "rook", b: "bishop", n: "knight", p: "pawn" };
const COLOR = { w: "white", b: "black" };
const pieceEl = (c, t) => el("span", { class: `pc ${ROLE[t]} ${COLOR[c]}` });
const LETTER = { k: "K", q: "Q", r: "R", b: "B", n: "N", p: "" };
const ORDER = "kqrbnp";

function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.error("save failed", e);
  }
}

let pack = load(LS_PACK, null);
/** puzzleId -> { status: "open"|"solved"|"failed", openedAt, firstMoveAt, attempt, synced } */
let results = load(LS_RES, {});
let syncNote = "";
const LS_RELAY = "wsp-relay";
let relayCfg = load(LS_RELAY, null);
const LS_DEVKEY = "wsp-devkey";
const LS_PAIR = "wsp-pair";
let pairCode = null;
const LS_STATS = "wsp-stats";
let stats = load(LS_STATS, null);
let view = "list";

// ---- chess helpers (positions come from the puzzle, so no legality check) ----
const sqIdx = (s) => (s.charCodeAt(1) - 49) * 8 + (s.charCodeAt(0) - 97);
const sqName = (i) => String.fromCharCode(97 + (i % 8)) + (1 + Math.floor(i / 8));

function parseFen(fen) {
  const [placement, turn] = fen.split(" ");
  const b = new Array(64).fill(null);
  placement.split("/").forEach((row, ri) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) f += Number(ch);
      else {
        b[(7 - ri) * 8 + f] = { c: ch === ch.toUpperCase() ? "w" : "b", t: ch.toLowerCase() };
        f++;
      }
    }
  });
  return { b, turn };
}

function applyUci(pos, uci) {
  const b = pos.b.slice();
  const from = sqIdx(uci.slice(0, 2));
  const to = sqIdx(uci.slice(2, 4));
  const p = b[from];
  if (!p) return { b, turn: pos.turn === "w" ? "b" : "w" };
  if (p.t === "k" && Math.abs((to % 8) - (from % 8)) === 2) {
    const base = Math.floor(from / 8) * 8;
    if (to % 8 === 6) [b[base + 5], b[base + 7]] = [b[base + 7], null];
    else [b[base + 3], b[base]] = [b[base], null];
  }
  if (p.t === "p" && to % 8 !== from % 8 && !b[to]) b[Math.floor(from / 8) * 8 + (to % 8)] = null;
  b[to] = uci.length > 4 ? { c: p.c, t: uci[4] } : p;
  b[from] = null;
  return { b, turn: p.c === "w" ? "b" : "w" };
}

function describeMove(pos, uci) {
  const p = pos.b[sqIdx(uci.slice(0, 2))];
  const capture = pos.b[sqIdx(uci.slice(2, 4))] ? "x" : "-";
  return `${p ? LETTER[p.t] : ""}${uci.slice(0, 2)}${capture}${uci.slice(2, 4)}${uci[4] ? "=" + uci[4].toUpperCase() : ""}`;
}

function setupText(pos) {
  const lines = [];
  for (const c of ["w", "b"]) {
    const pieces = [];
    for (const t of ORDER) {
      const squares = [];
      pos.b.forEach((p, i) => p && p.c === c && p.t === t && squares.push(sqName(i)));
      if (squares.length) pieces.push(`${LETTER[t] || "P"} ${squares.join(" ")}`);
    }
    lines.push(`${c === "w" ? "White" : "Black"}: ${pieces.join(", ")}`);
  }
  return lines.join("\n");
}

// ---- state for the open puzzle ----
let cur = null; // { p, idx, pos, ply, me, sel, last, busy, hint, solPly }

const $main = document.getElementById("main");
const $title = document.getElementById("title");
const $back = document.getElementById("back");
const $net = document.getElementById("net");
const $promo = document.getElementById("promo");

$back.onclick = () => {
  cur = null;
  view = "list";
  render();
};
addEventListener("online", () => {
  updateNet();
  sync();
});
addEventListener("offline", updateNet);
function updateNet() {
  $net.textContent = navigator.onLine ? "online" : "offline";
}

function openPuzzle(idx) {
  const p = pack.puzzles[idx];
  const r = (results[p.id] ??= { status: "open", openedAt: Date.now(), synced: false });
  save(LS_RES, results);
  const start = applyUci(parseFen(p.fen), p.moves[0]);
  cur = {
    p,
    idx,
    pos: start,
    ply: 1,
    me: start.turn,
    sel: null,
    last: p.moves[0],
    busy: false,
    hint: null,
    solPly: null,
    start,
    firstMoveText: describeMove(parseFen(p.fen), p.moves[0]),
  };
  if (r.status !== "open") showFinished();
  render();
}

function showFinished() {
  // after finishing, show the final position of the solution
  let pos = cur.start;
  for (let i = 1; i < cur.p.moves.length; i++) pos = applyUci(pos, cur.p.moves[i]);
  cur.pos = pos;
  cur.last = cur.p.moves[cur.p.moves.length - 1];
  cur.ply = cur.p.moves.length;
}

function onTap(i) {
  if (!cur || cur.busy || results[cur.p.id].status !== "open") return;
  const pc = cur.pos.b[i];
  if (pc && pc.c === cur.me) cur.sel = i;
  else if (cur.sel !== null) {
    const from = cur.sel;
    cur.sel = null;
    const mover = cur.pos.b[from];
    const lastRank = Math.floor(i / 8) === (cur.me === "w" ? 7 : 0);
    if (mover.t === "p" && lastRank) return askPromotion((t) => submit(sqName(from) + sqName(i) + t));
    submit(sqName(from) + sqName(i));
  }
  render();
}

function askPromotion(done) {
  $promo.innerHTML = "";
  for (const t of "qrbn") {
    const b = document.createElement("button");
    b.append(pieceEl(cur.me, t));
    b.onclick = () => {
      $promo.classList.remove("show");
      done(t);
    };
    $promo.appendChild(b);
  }
  $promo.classList.add("show");
}

function submit(uci) {
  const r = results[cur.p.id];
  r.firstMoveAt ??= Date.now();
  const expected = cur.p.moves[cur.ply];
  if (cur.p.accept) {
    // blunder check: any move that keeps the position counts
    cur.pos = applyUci(cur.pos, uci);
    cur.last = uci;
    if (cur.p.accept.includes(uci)) return finish(true, { safeText: describeMove(cur.start, uci) });
    cur.hint = expected;
    return finish(false, {
      reason: "wrong_move",
      wrongMove: uci,
      expectedMove: expected,
      failedAtPly: cur.ply,
      wrongText: describeMove(cur.start, uci),
    });
  }
  if (uci === expected) {
    cur.pos = applyUci(cur.pos, uci);
    cur.last = uci;
    cur.ply++;
    if (cur.ply >= cur.p.moves.length) return finish(true);
    cur.busy = true;
    render();
    setTimeout(() => {
      const reply = cur.p.moves[cur.ply];
      cur.pos = applyUci(cur.pos, reply);
      cur.last = reply;
      cur.ply++;
      cur.busy = false;
      render();
    }, 450);
  } else {
    cur.hint = expected;
    finish(false, {
      reason: "wrong_move",
      wrongMove: uci,
      expectedMove: expected,
      failedAtPly: cur.ply,
      wrongText: describeMove(cur.pos, uci),
    });
  }
}

function finish(solved, detail = {}) {
  const r = results[cur.p.id];
  const now = Date.now();
  r.status = solved ? "solved" : "failed";
  r.detail = detail;
  r.attempt = {
    v: 1,
    ts: new Date(now).toISOString(),
    puzzleId: cur.p.id,
    db: pack.db,
    rating: cur.p.rating,
    themes: cur.p.themes,
    solved,
    failReason: solved ? null : (detail.reason ?? "solution"),
    wrongMove: detail.wrongMove ?? null,
    expectedMove: detail.expectedMove ?? null,
    failedAtPly: detail.failedAtPly ?? null,
    firstMoveMs: r.firstMoveAt ? r.firstMoveAt - r.openedAt : null,
    totalMs: now - r.openedAt,
    lichessId: cur.p.lichessId,
    gameUrl: cur.p.gameUrl,
    source: "offline",
  };
  r.synced = false;
  save(LS_RES, results);
  cur.solPly = cur.ply;
  render();
  sync();
}

function overrideMate() {
  // the solution's last move is mate; another mating move is also correct
  const r = results[cur.p.id];
  Object.assign(r.attempt, {
    solved: true,
    failReason: null,
    wrongMove: null,
    expectedMove: null,
    failedAtPly: null,
  });
  r.status = "solved";
  r.synced = false;
  save(LS_RES, results);
  render();
  sync();
}

function stepSolution() {
  if (cur.solPly >= cur.p.moves.length) return;
  const m = cur.p.moves[cur.solPly];
  cur.pos = applyUci(cur.pos, m);
  cur.last = m;
  cur.hint = null;
  cur.solPly++;
  render();
}

function replay() {
  cur.pos = cur.start;
  cur.last = cur.p.moves[0];
  cur.solPly = 1;
  cur.hint = null;
  render();
}

// ---- sync ----
let syncing = false;
async function sync() {
  const pending = Object.values(results).filter((r) => r.attempt && !r.synced);
  if (syncing || pending.length === 0) return render();
  syncing = true;
  try {
    // relay first: it works on networks where the tailnet hangs
    if (await syncViaRelay(pending)) return;
    const res = await fetch("api/attempts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attempts: pending.map((r) => r.attempt) }),
      // a link that passes pings but drops big packets hangs forever otherwise
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { added, skipped, packId } = await res.json();
    const done = new Set([...added, ...skipped]);
    for (const r of pending) if (done.has(r.attempt.puzzleId)) r.synced = true;
    save(LS_RES, results);
    syncNote = `Synced ${added.length} at ${new Date().toLocaleTimeString()}`;
    // the server builds a new pack once the current one is fully logged
    if (packId && packId !== pack.id) await loadPack();
    await pullDone();
  } catch {
    syncNote = `${pending.length} waiting to sync (no connection to PC)`;
  } finally {
    syncing = false;
    render();
  }
}

// ---- Cloudflare relay (config from relay.json, kept in localStorage) ----
// On the PC's own server relay.json carries the PC's token. When the app is
// opened from the relay itself, relay.json has no token: this device then uses
// its own key, which the PC approves once via a pairing code.
async function loadRelayConfig() {
  try {
    const res = await fetch("relay.json", { cache: "no-cache", signal: AbortSignal.timeout(6000) });
    if (!res.ok) return;
    const cfg = await res.json();
    if (!cfg?.url) return;
    if (!cfg.token) {
      cfg.token = deviceKey();
      cfg.device = true;
    }
    relayCfg = cfg;
    save(LS_RELAY, cfg);
  } catch {
    // unreachable: keep the stored config
  }
}

function deviceKey() {
  let k = load(LS_DEVKEY, null);
  if (!k) {
    k = (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "");
    save(LS_DEVKEY, k);
  }
  return k;
}

/** Sets pairCode while this device's key isn't approved yet. */
async function checkPairing() {
  if (!relayCfg?.device) return;
  try {
    const res = await relayFetch("/whoami");
    if (res.ok) return clearPairing();
    if (res.status !== 401) return;
    const saved = load(LS_PAIR, null);
    if (saved && Date.now() - saved.at < 50 * 60 * 1000) {
      pairCode = saved.code;
      return;
    }
    const r = await fetch(`${relayCfg.url}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: relayCfg.token }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return;
    pairCode = (await r.json()).code;
    save(LS_PAIR, { code: pairCode, at: Date.now() });
  } catch {
    // offline: try again next time
  }
}

function clearPairing() {
  if (!pairCode) return;
  pairCode = null;
  save(LS_PAIR, null);
}

async function recheckPairing() {
  await checkPairing();
  if (!pairCode) {
    await sync();
    await pullDone();
  }
  render();
}

function relayFetch(path, init = {}) {
  return fetch(`${relayCfg.url}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${relayCfg.token}`, ...(init.headers ?? {}) },
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
}

/** Hand pending attempts to the relay; the PC logs them within a minute. */
async function syncViaRelay(pending) {
  if (!relayCfg) return false;
  try {
    const res = await relayFetch("/attempts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attempts: pending.map((r) => r.attempt) }),
    });
    if (!res.ok) return false;
    clearPairing(); // the relay took our key, so we are paired
    const accepted = new Set((await res.json()).accepted);
    for (const r of pending) if (accepted.has(r.attempt.puzzleId)) r.synced = true;
    save(LS_RES, results);
    syncNote = `Sent ${accepted.size} at ${new Date().toLocaleTimeString()} (the PC logs them within a minute)`;
    return true;
  } catch {
    return false;
  }
}

function adoptPack(fresh) {
  if (!fresh?.id || (pack && fresh.id <= pack.id)) return;
  const done = pack ? pack.puzzles.filter((p) => results[p.id]?.attempt).length : 0;
  pack = fresh;
  save(LS_PACK, pack);
  if (done) syncNote += ` · new pack of ${pack.puzzles.length} loaded`;
}

function applyDone(packId, done) {
  if (!done || packId !== pack?.id) return;
  let changed = false;
  for (const p of pack.puzzles) {
    if (!(p.id in done)) continue;
    const r = results[p.id];
    if (r && r.status !== "open") continue;
    results[p.id] = { status: done[p.id] ? "solved" : "failed", synced: true, elsewhere: true };
    changed = true;
  }
  if (changed) save(LS_RES, results);
}

// Mark puzzles of this pack that another device already logged, so they
// aren't served again here (local finished results win), and pick up a new
// pack. Relay first, then the PC directly.
async function pullDone() {
  let state = null;
  if (relayCfg) {
    try {
      const res = await relayFetch("/state");
      if (res.ok) {
        clearPairing();
        state = await res.json();
      }
    } catch {}
  }
  if (!state?.packId) {
    try {
      const res = await fetch("api/done", { cache: "no-store", signal: AbortSignal.timeout(15000) });
      if (res.ok) state = await res.json();
    } catch {}
  }
  if (!state) return;
  if (state.stats) {
    stats = state.stats;
    save(LS_STATS, stats);
  }
  adoptPack(state.pack);
  applyDone(state.packId, state.done);
  if (!cur) render();
}

// ---- rendering ----
function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) e[k] = v;
    else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null) e.append(c);
  return e;
}

function render() {
  updateNet();
  $main.innerHTML = "";
  if (!pack) {
    $title.textContent = "Offline Puzzles";
    $main.append(el("p", {}, "No puzzle pack yet. Open this page once while connected to your PC."));
    return;
  }
  return cur ? renderPuzzle() : view === "progress" ? renderProgress() : renderList();
}

function renderList() {
  $title.textContent = "Offline Puzzles";
  $back.hidden = true;
  const list = pack.puzzles;
  const rs = list.map((p) => results[p.id]);
  const solved = rs.filter((r) => r?.status === "solved").length;
  const failed = rs.filter((r) => r?.status === "failed").length;
  const pending = Object.values(results).filter((r) => r.attempt && !r.synced).length;
  const next = list.findIndex((p) => !results[p.id] || results[p.id].status === "open");
  $main.append(
    el(
      "p",
      { class: "muted" },
      `Pack of ${list.length} · your rating ${pack.rating} when packed · `,
      el("span", { id: "offline-ready" }, "checking offline copy…"),
    ),
    el("div", { class: "status" }, `${solved + failed}/${list.length} done · ${solved} solved · ${failed} missed`),
    el(
      "div",
      { class: "row" },
      el("button", { class: "primary", disabled: next < 0, onclick: () => openPuzzle(next) }, next < 0 ? "All done" : `Next puzzle (#${next + 1})`),
      el("button", { disabled: pending === 0, onclick: sync }, `Sync now (${pending})`),
      el("button", { onclick: () => { view = "progress"; render(); } }, "Progress"),
    ),
    pairCode
      ? el(
          "div",
          { class: "setup" },
          el("p", {}, "Pair this device: send this code to Claude, then tap Check."),
          el("div", { class: "status" }, pairCode),
          el("div", { class: "row" }, el("button", { onclick: recheckPairing }, "Check")),
        )
      : null,
    el("p", { class: "muted", id: "sync-note" }, syncNote),
    el(
      "div",
      { class: "grid" },
      list.map((p, i) => {
        const r = results[p.id];
        return el(
          "button",
          { class: `tile ${r?.status ?? ""}`, onclick: () => openPuzzle(i) },
          el("div", { class: "n" }, `#${i + 1}${blockLabel(p)}`),
          el("div", { class: "muted" }, `${p.rating}${r?.status === "solved" ? " ✓" : r?.status === "failed" ? " ✗" : ""}${r?.attempt && !r.synced ? " ⇡" : ""}`),
        );
      }),
    ),
  );
  if ("caches" in window) {
    caches.match("pack.json").then((hit) => {
      const s = document.getElementById("offline-ready");
      if (s) s.textContent = hit ? "✓ saved for offline" : "not cached yet — reload once online";
    });
  }
}

function renderBoard() {
  const flip = cur.me === "b";
  const board = el("div", { class: "board", id: "board" });
  const lastSq = cur.last ? [cur.last.slice(0, 2), cur.last.slice(2, 4)] : [];
  const hintSq = cur.hint ? [cur.hint.slice(0, 2), cur.hint.slice(2, 4)] : [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const rank = flip ? row : 7 - row;
      const file = flip ? 7 - col : col;
      const i = rank * 8 + file;
      const name = sqName(i);
      const classes = ["sq", (rank + file) % 2 ? "l" : "d"];
      if (lastSq.includes(name)) classes.push("last");
      if (hintSq.includes(name)) classes.push("hint");
      if (cur.sel === i) classes.push("sel");
      const sq = el("div", { class: classes.join(" "), "data-sq": name, onclick: () => onTap(i) });
      const p = cur.pos.b[i];
      if (p) sq.append(pieceEl(p.c, p.t));
      if (row === 7) sq.append(el("span", { class: "coord f" }, "abcdefgh"[file]));
      if (col === 0) sq.append(el("span", { class: "coord r" }, String(rank + 1)));
      board.append(sq);
    }
  }
  return board;
}

// FEN of the position you solve from (after the opponent's first move), so a
// PGN can start there on Lichess. Castling rights drop when the king or rook
// has left its square; en passant only after a double pawn push.
function startFen(p) {
  const [, , castling = "-", , half = "0", full = "1"] = p.fen.split(" ");
  const before = parseFen(p.fen);
  const pos = applyUci(before, p.moves[0]);
  const rows = [];
  for (let r = 7; r >= 0; r--) {
    let row = "";
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const pc = pos.b[r * 8 + f];
      if (!pc) { empty++; continue; }
      if (empty) { row += empty; empty = 0; }
      row += pc.c === "w" ? pc.t.toUpperCase() : pc.t;
    }
    rows.push(row + (empty || ""));
  }
  const at = (sq, c, t) => { const pc = pos.b[sqIdx(sq)]; return pc && pc.c === c && pc.t === t; };
  const keep = { K: at("e1", "w", "k") && at("h1", "w", "r"), Q: at("e1", "w", "k") && at("a1", "w", "r"),
    k: at("e8", "b", "k") && at("h8", "b", "r"), q: at("e8", "b", "k") && at("a8", "b", "r") };
  const cr = [...castling].filter((ch) => keep[ch]).join("") || "-";
  const m = p.moves[0];
  const mover = before.b[sqIdx(m.slice(0, 2))];
  const dbl = mover?.t === "p" && Math.abs(m.charCodeAt(3) - m.charCodeAt(1)) === 2;
  const ep = dbl ? m[0] + (mover.c === "w" ? "3" : "6") : "-";
  const reset = mover?.t === "p" || before.b[sqIdx(m.slice(2, 4))];
  const fullmove = Number(full) + (before.turn === "b" ? 1 : 0);
  return `${rows.join("/")} ${pos.turn} ${cr} ${ep} ${reset ? 0 : Number(half) + 1} ${fullmove}`;
}

function puzzlePgn(p) {
  return [
    `[Event "Puzzle ${p.lichessId ?? p.id} (${p.rating})"]`,
    `[Site "${p.gameUrl ?? "https://lichess.org/training/" + (p.lichessId ?? p.id)}"]`,
    `[SetUp "1"]`,
    `[FEN "${startFen(p)}"]`,
    "",
    "*",
    "",
  ].join("\n");
}

async function copyPgn(btn) {
  const text = puzzlePgn(cur.p);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = el("textarea", {});
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  btn.textContent = "Copied - paste at lichess.org/paste";
}

function blockLabel(p) {
  return p.block === "focus" ? " · focus" : p.block === "game" ? " · yours" : p.block === "check" ? " · check" : "";
}

function renderPuzzle() {
  const { p, idx } = cur;
  const r = results[p.id];
  $title.textContent =
    p.block === "game" ? `#${idx + 1} · your game` : p.block === "check" ? `#${idx + 1} · blunder check` : `#${idx + 1} · ${p.rating}${blockLabel(p)}`;
  $back.hidden = false;
  const side = el("div", { class: "side" });
  const toMove = cur.me === "w" ? "White" : "Black";
  if (r.status === "open") {
    side.append(
      el("div", { class: "status" }, `${toMove} to move`),
      el("p", {}, `${cur.me === "w" ? "Black" : "White"} just played `, el("b", {}, cur.firstMoveText), "."),
      el(
        "div",
        {},
        p.block === "game" ? el("p", { class: "muted" }, "From one of your own games: you missed this one there.") : null,
        p.block === "check"
          ? el("p", {}, `From one of your own games. You were better here (${p.winBefore}% to win). `, el("b", {}, "Find a safe move"), ": any move that keeps your advantage counts. Check what your opponent is threatening first.")
          : null,
      ),
      el("p", { class: "muted" }, "Set it up on your board and calculate the whole line before entering a move. Tap a piece, then its square."),
      el("div", { class: "setup" }, setupText(cur.start)),
    );
  } else {
    const ok = r.status === "solved";
    side.append(el("div", { class: `status ${ok ? "ok" : "bad"}` }, ok ? "Solved" : "Missed"));
    if (r.elsewhere) side.append(el("p", { class: "muted" }, "Done on another device."));
    if (!ok && r.detail?.wrongText) {
      side.append(el("p", {}, "You played ", el("b", {}, r.detail.wrongText), "; the move was highlighted in green."));
    }
    if (p.block === "check") {
      if (r.detail?.safeText) side.append(el("p", {}, "Your move ", el("b", {}, r.detail.safeText), " keeps your advantage."));
      const line = [];
      let q = cur.start;
      for (const m of p.refute) {
        line.push(describeMove(q, m));
        q = applyUci(q, m);
      }
      side.append(
        el("p", {}, "In the game you played ", el("b", {}, line[0]), `, and it dropped from ${p.winBefore}% to ${p.winAfter}%: `, el("b", {}, line.slice(1).join(" ")), "."),
        el("p", { class: "muted" }, `${p.accept.length} safe moves; the engine's best is highlighted in green.`),
      );
    } else if (p.block === "game" && p.played) {
      side.append(el("p", {}, "In the game you played ", el("b", {}, describeMove(cur.start, p.played)), "."));
    }
    side.append(el("div", {}, p.themes.map((t) => el("span", { class: "badge" }, t))));
    const solving = !p.accept && cur.solPly != null && cur.solPly < p.moves.length;
    const lastMoveWasMate =
      !ok && r.detail?.failedAtPly === p.moves.length - 1 && p.themes.some((t) => t.startsWith("mate"));
    side.append(
      el(
        "div",
        { class: "row" },
        solving ? el("button", { class: "primary", onclick: stepSolution }, "Show next solution move") : null,
        el("button", { onclick: replay }, "Replay from start"),
        lastMoveWasMate ? el("button", { onclick: overrideMate }, "My move also mates") : null,
        idx + 1 < pack.puzzles.length ? el("button", { class: solving ? "" : "primary", onclick: () => openPuzzle(idx + 1) }, "Next puzzle") : null,
      ),
      el("div", { class: "row" }, el("button", { onclick: (e) => copyPgn(e.currentTarget) }, "Copy PGN (puzzle start)")),
      p.gameUrl && navigator.onLine ? el("p", {}, el("a", { href: p.gameUrl, target: "_blank" }, "Source game")) : null,
      el("p", { class: "muted" }, r.synced ? "Synced to PC" : "Waiting to sync"),
    );
  }
  $main.append(el("div", { class: "board-wrap" }, renderBoard(), side));
}

// ---- progress screen (numbers come from the PC: stats.mjs, via relay state) ----
const C = { now: "#3987e5", start: "#d95926", good: "#0ca30c", bad: "#d03b3b", grid: "#3a3b40", ink: "#e9ecef", dim: "#909296" };
const NS = "http://www.w3.org/2000/svg";
function sv(tag, attrs = {}, ...children) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  for (const c of children.flat()) if (c != null) e.append(typeof c === "string" ? document.createTextNode(c) : c);
  return e;
}
// chart width in CSS px, so 11-12px text stays that size on a phone
const chartW = () => Math.min(640, Math.max(320, ($main.clientWidth || 640) - 4));
const prettyTheme = (t) => t.replace(/([a-z])([A-Z0-9])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
const shortDate = (ts) => new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function tip(box, html, x, y) {
  let t = box.querySelector(".tip");
  if (!t) {
    t = el("div", { class: "tip" });
    box.append(t);
  }
  t.innerHTML = html;
  t.hidden = false;
  const w = box.clientWidth;
  t.style.left = `${Math.min(Math.max(x - 80, 0), w - 170)}px`;
  t.style.top = `${Math.max(y - 70, 0)}px`;
}

function ratingChart(s) {
  const W = chartW(), H = 260, L = 44, R = 12, T = 12, B = 28;
  const pts = s.series;
  const ys = pts.flatMap((p) => [p[1], p[2]]);
  const lo = Math.floor((Math.min(...ys) - 50) / 100) * 100;
  const hi = Math.ceil((Math.max(...ys) + 50) / 100) * 100;
  const x = (i) => L + (i / Math.max(pts.length - 1, 1)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const g = sv("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": `Puzzle rating over ${pts.length} puzzles, now ${s.rating}` });
  for (let v = lo; v <= hi; v += 100) {
    g.append(sv("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: C.grid, "stroke-width": 1 }));
    g.append(sv("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end", fill: C.dim, "font-size": 11 }, String(v)));
  }
  // day boundaries
  let lastDay = "";
  let lastX = -1e9;
  pts.forEach((p, i) => {
    const d = shortDate(p[0]);
    if (d !== lastDay && x(i) - lastX >= 56) {
      lastDay = d;
      lastX = x(i);
      g.append(sv("text", { x: x(i), y: H - 8, fill: C.dim, "font-size": 11, "text-anchor": !i ? "start" : x(i) > W - R - 30 ? "end" : "middle" }, d));
    }
  });
  // puzzle difficulty: filled = solved, ring = missed
  pts.forEach((p, i) =>
    g.append(
      p[3]
        ? sv("circle", { cx: x(i), cy: y(p[2]), r: 3.5, fill: C.good, stroke: "var(--bg)", "stroke-width": 1.5, opacity: 0.85 })
        : sv("circle", { cx: x(i), cy: y(p[2]), r: 3.5, fill: "none", stroke: C.bad, "stroke-width": 2 }),
    ),
  );
  g.append(sv("polyline", { points: pts.map((p, i) => `${x(i)},${y(p[1])}`).join(" "), fill: "none", stroke: C.now, "stroke-width": 2, "stroke-linejoin": "round" }));
  const last = pts.length - 1;
  g.append(sv("text", { x: x(last) - 4, y: y(pts[last][1]) - 8, "text-anchor": "end", fill: C.ink, "font-size": 12, "font-weight": 700 }, String(s.rating)));
  const cross = sv("line", { y1: T, y2: H - B, stroke: C.dim, "stroke-width": 1, visibility: "hidden" });
  g.append(cross);
  const box = el("div", { class: "chart-box" }, g);
  const move = (ev) => {
    const rect = g.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - L) / (W - L - R)) * last);
    if (i < 0 || i > last) return;
    const p = pts[i];
    cross.setAttribute("x1", x(i));
    cross.setAttribute("x2", x(i));
    cross.setAttribute("visibility", "visible");
    tip(box, `<b>${shortDate(p[0])}</b> · puzzle ${p[2]} · ${p[3] ? "solved" : "missed"}<br>your rating after: <b>${p[1]}</b>`, (x(i) / W) * rect.width, (y(p[1]) / H) * rect.height);
  };
  g.addEventListener("pointermove", move);
  g.addEventListener("pointerdown", move);
  g.addEventListener("pointerleave", () => {
    cross.setAttribute("visibility", "hidden");
    const t = box.querySelector(".tip");
    if (t) t.hidden = true;
  });
  return box;
}

function radarChart(s) {
  const W = 460, H = 300, cx = 230, cy = 150, rad = 100, MIN = 0.5, MAX = 1.5;
  const n = s.radar.length;
  const ang = (i) => -Math.PI / 2 + (i * 2 * Math.PI) / n;
  const rr = (v) => (Math.min(Math.max(v, MIN), MAX) - MIN) / (MAX - MIN) * rad;
  const at = (i, v) => [cx + Math.cos(ang(i)) * rr(v), cy + Math.sin(ang(i)) * rr(v)];
  const g = sv("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart radar", role: "img", "aria-label": "Skill groups, start vs now" });
  for (const v of [0.75, 1, 1.25, 1.5]) {
    g.append(sv("polygon", { points: s.radar.map((_, i) => at(i, v).join(",")).join(" "), fill: "none", stroke: C.grid, "stroke-width": v === 1 ? 1.5 : 1, "stroke-dasharray": v === 1 ? null : "2 3" }));
  }
  const [px, py] = at(0, 1);
  g.append(sv("text", { x: px + 4, y: py - 3, fill: C.dim, "font-size": 10 }, "par"));
  s.radar.forEach((gr, i) => {
    const [ex, ey] = at(i, MAX);
    g.append(sv("line", { x1: cx, y1: cy, x2: ex, y2: ey, stroke: C.grid, "stroke-width": 1 }));
    const [lx, ly] = [cx + Math.cos(ang(i)) * (rad + 16), cy + Math.sin(ang(i)) * (rad + 16)];
    const anchor = Math.abs(Math.cos(ang(i))) < 0.2 ? "middle" : Math.cos(ang(i)) > 0 ? "start" : "end";
    const words = gr.name.split(" & ");
    const label = sv("text", { x: lx, y: ly + (Math.sin(ang(i)) > 0.5 ? 8 : Math.sin(ang(i)) < -0.5 ? -10 : 0), "text-anchor": anchor, fill: C.ink, "font-size": 11 });
    words.forEach((w, k) => label.append(sv("tspan", { x: lx, dy: k ? 13 : 0 }, k ? `& ${w}` : w)));
    g.append(label);
  });
  for (const [key, color, dash] of [["start", C.start, "5 4"], ["now", C.now, null]]) {
    const pts = s.radar.map((gr, i) => at(i, gr[key].score));
    g.append(sv("polygon", { points: pts.map((p) => p.join(",")).join(" "), fill: color, "fill-opacity": 0.12, stroke: color, "stroke-width": 2, "stroke-dasharray": dash }));
    pts.forEach(([x0, y0], i) => {
      const gr = s.radar[i];
      const dot = sv("circle", { cx: x0, cy: y0, r: 4, fill: color, stroke: "var(--bg)", "stroke-width": 2 });
      dot.append(sv("title", {}, `${gr.name} (${key}): ${gr[key].score.toFixed(2)}× par over ${gr[key].n} puzzles`));
      g.append(dot);
    });
  }
  return el("div", { class: "chart-box" }, g);
}

const MIN_THEME_N = 4;
function themeBars(s) {
  const rows = s.themes.filter((t) => t.n >= MIN_THEME_N);
  const W = chartW(), narrow = W < 500;
  const rowH = 26, L = narrow ? 128 : 170, R = narrow ? 62 : 110, H = rows.length * rowH + 24;
  const max = Math.max(0.3, ...rows.map((t) => Math.abs(t.vsExpected)));
  const mid = L + (W - L - R) / 2;
  const sc = (v) => (v / max) * ((W - L - R) / 2);
  const g = sv("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": "Themes vs what your rating predicts" });
  g.append(sv("line", { x1: mid, x2: mid, y1: 0, y2: H - 20, stroke: C.dim, "stroke-width": 1 }));
  g.append(sv("text", { x: mid, y: H - 4, "text-anchor": "middle", fill: C.dim, "font-size": 11 }, "par for your rating"));
  g.append(sv("text", { x: L, y: H - 4, fill: C.dim, "font-size": 11 }, "← worse"));
  g.append(sv("text", { x: W - R, y: H - 4, "text-anchor": "end", fill: C.dim, "font-size": 11 }, "better →"));
  rows.forEach((t, i) => {
    const yy = i * rowH + 4;
    const w = sc(t.vsExpected);
    const color = t.vsExpected < 0 ? C.start : C.now;
    g.append(sv("text", { x: L - 8, y: yy + 15, "text-anchor": "end", fill: C.ink, "font-size": 12 }, prettyTheme(t.theme)));
    if (Math.abs(w) >= 1) {
      g.append(sv("rect", { x: w < 0 ? mid + w : mid, y: yy + 4, width: Math.abs(w), height: rowH - 10, rx: 3, fill: color }));
    }
    const arrow = t.trend == null ? "" : t.trend > 0.05 ? " ↑" : t.trend < -0.05 ? " ↓" : " →";
    g.append(sv("text", { x: W - R + 8, y: yy + 15, fill: C.dim, "font-size": 11 }, `${t.solved}/${t.n}${arrow}`));
  });
  return el("div", { class: "chart-box" }, g);
}

function missBar(m) {
  const total = Math.max(m.total, 1);
  const parts = [
    ["First move", m.firstMove, C.bad],
    ["Later in the line", m.later, C.start],
    ["Gave up", m.gaveUp, C.dim],
  ].filter((p) => p[1] > 0);
  const bar = el("div", { class: "seg" }, parts.map(([name, v, color]) => el("div", { style: `flex:${v};background:${color}`, title: `${name}: ${v}` })));
  const legend = el("div", { class: "legend" }, parts.map(([name, v, color]) => el("span", {}, el("i", { style: `background:${color}` }), `${name} ${v}`)));
  return el("div", {}, bar, legend);
}

function renderProgress() {
  $title.textContent = "Progress";
  $back.hidden = false;
  const s = stats;
  if (!s) {
    $main.append(el("p", {}, "No progress numbers yet. They arrive with the next sync."));
    return;
  }
  const firstSolve = s.series.filter((p) => p[3]).length;
  const startLen = s.series.findIndex((p) => p[0] > (s.split.start ?? ""));
  $main.append(
    el(
      "div",
      { class: "tiles" },
      el("div", { class: "kpi" }, el("div", { class: "muted" }, "Puzzle rating"), el("b", {}, String(s.rating))),
      el("div", { class: "kpi" }, el("div", { class: "muted" }, "Puzzles"), el("b", {}, String(s.attempts))),
      el("div", { class: "kpi" }, el("div", { class: "muted" }, "Solved"), el("b", {}, `${Math.round((firstSolve / s.attempts) * 100)}%`)),
    ),
    el("h2", {}, "Rating"),
    el("p", { class: "muted" }, "Line: your rating. Dots: each puzzle's difficulty, filled = solved, ring = missed. Tap for details."),
    ratingChart(s),
    el("h2", {}, "Skills"),
    el(
      "div",
      { class: "legend" },
      el("span", {}, el("i", { style: `background:${C.start}` }), `Start (first ${startLen < 0 ? s.attempts : startLen})`),
      el("span", {}, el("i", { style: `background:${C.now}` }), `Now (last ${s.attempts - (startLen < 0 ? 0 : startLen)})`),
    ),
    el("p", { class: "muted" }, "Solves vs what your current rating predicts for those puzzles. Outside the solid ring = better than par."),
    radarChart(s),
    el(
      "details",
      {},
      el("summary", {}, "Numbers"),
      el(
        "table",
        {},
        el("tr", {}, el("th", {}, "Skill"), el("th", {}, "Start"), el("th", {}, "Now")),
        s.radar.map((g) => el("tr", {}, el("td", {}, g.name), el("td", {}, `${g.start.score.toFixed(2)}× (${g.start.n})`), el("td", {}, `${g.now.score.toFixed(2)}× (${g.now.n})`))),
      ),
    ),
    el("h2", {}, "Themes"),
    el("p", { class: "muted" }, "Each theme vs what your rating predicts. Right: solved/attempts, arrow = trend (↑ improving, ↓ slipping)."),
    themeBars(s),
    el("p", { class: "muted" }, `${s.themes.filter((t) => t.n < MIN_THEME_N).length} themes with fewer than ${MIN_THEME_N} puzzles are left out until there's enough to judge.`),
    el("h2", {}, "Misses"),
    el("p", {}, `${s.misses.firstMove} of your ${s.misses.total} misses came on the first move.`),
    missBar(s.misses),
    el(
      "div",
      { class: "tiles" },
      el("div", { class: "kpi" }, el("div", { class: "muted" }, "Think time, solves"), el("b", {}, s.misses.thinkSolved != null ? `${s.misses.thinkSolved}s` : "–")),
      el("div", { class: "kpi" }, el("div", { class: "muted" }, "Think time, misses"), el("b", {}, s.misses.thinkMissed != null ? `${s.misses.thinkMissed}s` : "–")),
    ),
    el("p", { class: "muted" }, `Median time before your first move. Numbers as of ${new Date(s.at).toLocaleString()}.`),
  );
}

// ---- boot ----
async function loadPack() {
  try {
    const res = await fetch("pack.json", { cache: "no-cache" });
    if (!res.ok) return;
    const fresh = await res.json();
    if (!pack || fresh.id !== pack.id) {
      const done = pack ? pack.puzzles.filter((p) => results[p.id]?.attempt).length : 0;
      pack = fresh;
      save(LS_PACK, pack);
      if (done) syncNote += ` · new pack of ${pack.puzzles.length} loaded`;
    }
  } catch {
    // offline: keep the stored pack
  }
}

async function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(console.error);
  await loadPack();
  await loadRelayConfig();
  await checkPairing();
  render();
  await sync();
  pullDone();
}
boot();
