# Offline puzzles

Solve a pack of weakspot-picked puzzles on a tablet with no connection
(e.g. on a flight, with a physical board); results sync into the
En Croissant attempt log when the tablet can reach the PC again.

1. Build a pack (near your rating, weak themes, then a focus block; skips
   puzzles already in the log):
   `node tools/offline-puzzles/make-pack.mts --count 40 --focus 10`
2. Run the server (127.0.0.1:8771; `WEAKSPOT_LOG` overrides the log path):
   `node tools/offline-puzzles/server.mjs`
3. Expose it on the tailnet once:
   `tailscale serve --bg --https=8446 http://127.0.0.1:8771`
4. On the tablet, open `https://<pc>.<tailnet>.ts.net:8446` once while
   online and install it (Add to Home screen). The list shows
   "saved for offline" when the pack is cached.

When a sync leaves every puzzle of the current pack logged, the server
builds a fresh pack (same picker, current rating and weak spots; env
`PACK_COUNT` / `PACK_FOCUS`), and the tablet switches to it right after that
sync or the next time it opens online. `OFFLINE_PACK` overrides the pack
path (for testing).

Offline attempts are tagged `source: "offline"`: they count for your rating
and theme stats, but their times (which include setting up the board) are
not used for speed.
Pieces: Staunty by sadsnake1, CC BY-NC-SA 4.0 (via lichess / En Croissant).

## Cloudflare relay (for networks where the tailnet hangs)

Some Wi-Fi networks drop Tailscale packets above ~1,200 bytes, so syncs hang.
The app then syncs through a small Worker instead (`relay/`): it posts
attempts there, and `relay-sync.mjs` on the PC pulls them through the local
server every minute and pushes back the current pack and done map.

- Config: `public/relay.json` `{ "url": "<worker url>", "token": "<secret>" }` (gitignored).
- Worker secrets: `TOKEN` (same value) and `ALLOWED_ORIGIN` (the app's https origin).
- Deploy: `node relay/deploy.mjs` (copies the app shell into `relay/site/`). Run on the PC: `node relay-sync.mjs`.
- The Worker also serves the app, for when the tailnet can't deliver even the app. A device opened there shows a pairing code; approve it on the PC with `node relay-sync.mjs approve <code>`.

## Puzzles from your own games

`from-games.mjs` downloads new Chess.com games (user `wmcmo`, override with
`CHESSCOM_USER`) and has Stockfish (1M nodes, top two moves) look at every
position where it was your move. A position becomes a puzzle when exactly one
move was good (winning chances beat the second best by 0.4 on a -1..1 scale),
it reaches at least about equal, and you didn't play it. The line continues
while each of your moves is still the only good one. Puzzles queue in
`game-puzzles.json` (gitignored; its `since` starts at the first run's day),
and the next pack puts up to 10 unlogged ones first ("yours"). `relay-sync.mjs`
runs it hourly. Test on old games without saving:
`node from-games.mjs --dry --archive <monthly archive url> --limit 2`.

It also makes **blunder-check** cards (block "check"): positions where you were at
least about equal, several moves kept that, and your move dropped your winning
chances by 0.4+. Every move within 0.2 of the best (all legal moves analysed)
is accepted, and afterwards the card shows your game move and its refutation.
