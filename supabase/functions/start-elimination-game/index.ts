// start-elimination-game — host-only lobby -> active for an elimination room
// (Session 19).
//
// Request:  POST { room_id: uuid }
// Response: 200 { ok, round_num, word, turn_player_id, turn_started_at,
//                 round_seconds, lives, starting_players, tier }
//
// The elimination counterpart of start-game, and deliberately the same shape:
// identity comes from the bearer token, the body carries nothing but the room,
// and the single RPC call does all the deciding.
//
// EVERY precondition the brief lists — caller is the host, mode is
// 'elimination', status is 'lobby', and there are enough players — is checked
// inside start_elimination_game_tx, NOT here. That is not laziness, it is the
// only correct place for them: the check and the transition have to be one
// transaction or two hosts tapping Start at the same instant can both pass a
// check that was true when they read it. The SQL function takes `for update` on
// the room first and re-reads all four facts inside that lock. Re-checking any
// of them here would add a second, racy copy of a rule that is already enforced
// atomically, and would drift the moment the SQL changes.
//
// So the minimum player count is whatever the SQL layer says it is (>= 2), and
// this file does not name the number anywhere.
//
// `word` comes back for the same reason it does in start-game: the client has
// to pronounce it via the Web Speech API. The reveal happens only once the turn
// has started — see the WORD SECRECY note in 0006_round_engine.sql.

import { fail, handler, respond, rpc } from "../_shared/mod.ts";

Deno.serve(
  handler(async (body, callerId) => {
    const roomId = body.room_id;
    if (typeof roomId !== "string" || !roomId) {
      return fail("missing_room_id", 400);
    }

    const result = await rpc("start_elimination_game_tx", {
      p_room_id: roomId,
      p_caller: callerId,
    });

    return respond(result);
  }),
);
