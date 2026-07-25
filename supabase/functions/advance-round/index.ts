// advance-round — the single path from "round over" to "next word" (Session 9a).
//
// Request:  POST { room_id: uuid, round_num: int }   (round_num = the round the
//                                                     caller believes is ending)
// Response: 200 { ok, advanced, finished, round_num?, word?, round_started_at?, ... }
//
// Callable by ANY member, which is safe because the caller's belief that the
// round is over is never trusted. The server re-derives it: either the round
// has a winner and the feedback window has elapsed, or the tier's time limit
// has genuinely passed according to rooms.round_started_at. A player who is
// losing cannot skip the round by calling this early — they get a 409.
//
// This is also where the game ends: when the round budget is spent or the tier
// runs out of unused words, the same transaction sets rooms.status='finished'.
// Game-over is deliberately NOT a separately callable endpoint — "the game is
// over" is a conclusion the server draws, not an instruction a client can send.
//
// Rationale for one advancement path covering both a won and a timed-out round
// is documented at length above advance_round_tx in 0006_round_engine.sql.

import { fail, handler, respond, rpc } from "../_shared/mod.ts";

Deno.serve(
  handler(async (body, callerId) => {
    const roomId = body.room_id;
    const roundNum = body.round_num;

    if (typeof roomId !== "string" || !roomId) return fail("missing_room_id", 400);
    if (!Number.isInteger(roundNum)) return fail("missing_round_num", 400);

    const result = await rpc("advance_round_tx", {
      p_room_id: roomId,
      p_player: callerId,
      p_expected_round: roundNum,
    });

    return respond(result);
  }),
);
