// submit-answer — server-side answer validation and round scoring (Session 9a).
//
// Request:  POST { room_id: uuid, round_num: int, guess: string }
// Response: 200 { ok, correct, won, points?, response_time_ms, streak? }
//
// Note what the request does NOT contain: no "correct" flag and no elapsed
// time. Correctness is decided by looking the word up server-side, and the
// response time is measured from rooms.round_started_at to this call's arrival
// on the server. Editing the client JS therefore cannot award points or fake a
// fast time — the two things server authority actually has to guarantee here.
//
// round_num is required so a delayed or replayed submission for an earlier
// round can be rejected rather than scored against the current one.

import { fail, handler, respond, rpc } from "../_shared/mod.ts";

Deno.serve(
  handler(async (body, callerId) => {
    const roomId = body.room_id;
    const roundNum = body.round_num;
    const guess = body.guess;

    if (typeof roomId !== "string" || !roomId) return fail("missing_room_id", 400);
    if (!Number.isInteger(roundNum)) return fail("missing_round_num", 400);
    if (typeof guess !== "string") return fail("missing_guess", 400);

    const result = await rpc("submit_answer_tx", {
      p_room_id: roomId,
      p_round_num: roundNum,
      p_player: callerId,
      p_guess: guess,
    });

    return respond(result);
  }),
);
