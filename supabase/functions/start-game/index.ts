// start-game — host-only lobby -> active transition (Session 9a).
//
// This is what src/lib/rooms.ts's startGame() stub was waiting for. Clients
// cannot write rooms.status at all (no grant, no policy — migration 0002), so
// this function is the only way a game can begin.
//
// Request:  POST { room_id: uuid }
// Response: 200 { ok, round_num, word, round_started_at, round_seconds, tier }
//
// The caller's identity comes from their bearer token, never from the body, so
// "am I the host?" is decided by comparing the token's user against
// rooms.host_id inside the transaction.
//
// `word` is returned because the client must pronounce it via the Web Speech
// API. That reveal is deliberate and only happens once the round has started —
// see the WORD SECRECY note in 0006_round_engine.sql.

import { fail, handler, respond, rpc } from "../_shared/mod.ts";

Deno.serve(
  handler(async (body, callerId) => {
    const roomId = body.room_id;
    if (typeof roomId !== "string" || !roomId) {
      return fail("missing_room_id", 400);
    }

    const result = await rpc("start_game_tx", {
      p_room_id: roomId,
      p_caller: callerId,
    });

    return respond(result);
  }),
);
