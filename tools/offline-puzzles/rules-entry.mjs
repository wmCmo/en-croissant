// Chess rules for the tablet app, from chessops (the library En Croissant
// uses). Bundled into public/rules.js by build-rules.mjs.
import { parseUci } from "chessops";
import { Chess } from "chessops/chess";
import { parseFen } from "chessops/fen";

window.ChessRules = {
  /** Is `uci` legal after playing `moves` from `fen`? Also whether the side to move is in check. */
  check(fen, moves, uci) {
    const pos = Chess.fromSetup(parseFen(fen).unwrap()).unwrap();
    for (const m of moves) if (m) pos.play(parseUci(m));
    const mv = parseUci(uci);
    return { legal: !!mv && pos.isLegal(mv), inCheck: pos.isCheck() };
  },
};
