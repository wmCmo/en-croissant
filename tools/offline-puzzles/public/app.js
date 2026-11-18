"use strict";
// Offline puzzle pack: solve on a physical board, enter your moves here,
// results queue in localStorage and sync to the PC when online.

const LS_PACK = "wsp-pack";
const LS_RES = "wsp-results";
const VS = "︎"; // force text (not emoji) glyphs
const GLYPH = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
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
    b.textContent = GLYPH[t] + VS;
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
    const res = await fetch("api/attempts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attempts: pending.map((r) => r.attempt) }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { added, skipped } = await res.json();
    const done = new Set([...added, ...skipped]);
    for (const r of pending) if (done.has(r.attempt.puzzleId)) r.synced = true;
    save(LS_RES, results);
    syncNote = `Synced ${added.length} at ${new Date().toLocaleTimeString()}`;
  } catch {
    syncNote = `${pending.length} waiting to sync (no connection to PC)`;
  } finally {
    syncing = false;
    render();
  }
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
  return cur ? renderPuzzle() : renderList();
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
    ),
    el("p", { class: "muted", id: "sync-note" }, syncNote),
    el(
      "div",
      { class: "grid" },
      list.map((p, i) => {
        const r = results[p.id];
        return el(
          "button",
          { class: `tile ${r?.status ?? ""}`, onclick: () => openPuzzle(i) },
          el("div", { class: "n" }, `#${i + 1}${p.block === "focus" ? " · focus" : ""}`),
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
      if (p) sq.append(el("span", { class: `pc ${p.c}` }, GLYPH[p.t] + VS));
      if (row === 7) sq.append(el("span", { class: "coord f" }, "abcdefgh"[file]));
      if (col === 0) sq.append(el("span", { class: "coord r" }, String(rank + 1)));
      board.append(sq);
    }
  }
  return board;
}

function renderPuzzle() {
  const { p, idx } = cur;
  const r = results[p.id];
  $title.textContent = `#${idx + 1} · ${p.rating}${p.block === "focus" ? " · focus" : ""}`;
  $back.hidden = false;
  const side = el("div", { class: "side" });
  const toMove = cur.me === "w" ? "White" : "Black";
  if (r.status === "open") {
    side.append(
      el("div", { class: "status" }, `${toMove} to move`),
      el("p", {}, `${cur.me === "w" ? "Black" : "White"} just played `, el("b", {}, cur.firstMoveText), "."),
      el("p", { class: "muted" }, "Set it up on your board and calculate the whole line before entering a move. Tap a piece, then its square."),
      el("div", { class: "setup" }, setupText(cur.start)),
      el("div", { class: "row" }, el("button", { onclick: () => finish(false, { reason: "solution" }) }, "Give up")),
    );
  } else {
    const ok = r.status === "solved";
    side.append(el("div", { class: `status ${ok ? "ok" : "bad"}` }, ok ? "Solved" : "Missed"));
    if (!ok && r.detail?.wrongText) {
      side.append(el("p", {}, "You played ", el("b", {}, r.detail.wrongText), "; the move was highlighted in green."));
    }
    side.append(el("div", {}, p.themes.map((t) => el("span", { class: "badge" }, t))));
    const solving = cur.solPly != null && cur.solPly < p.moves.length;
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
      p.gameUrl && navigator.onLine ? el("p", {}, el("a", { href: p.gameUrl, target: "_blank" }, "Source game")) : null,
      el("p", { class: "muted" }, r.synced ? "Synced to PC" : "Waiting to sync"),
    );
  }
  $main.append(el("div", { class: "board-wrap" }, renderBoard(), side));
}

// ---- boot ----
async function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(console.error);
  try {
    const res = await fetch("pack.json", { cache: "no-cache" });
    if (res.ok) {
      const fresh = await res.json();
      if (!pack || fresh.id !== pack.id) {
        pack = fresh;
        save(LS_PACK, pack);
      }
    }
  } catch {
    // offline: use the stored pack
  }
  render();
  sync();
}
boot();
