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

Offline attempts are tagged `source: "offline"`: they count for your rating
and theme stats, but their times (which include setting up the board) are
not used for speed.
Pieces: Staunty by sadsnake1, CC BY-NC-SA 4.0 (via lichess / En Croissant).
