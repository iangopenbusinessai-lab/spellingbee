// submit-turn — the turn holder answers, in elimination mode (Session 19).
//
// Request:  POST { room_id: uuid, round_num: int, guess: string }
// Response: 200 { ok, correct, outcome, points, lives, eliminated, table_streak,
//                 remaining_players, finished,
//                 winner_id? | next_round_num, next_turn_player_id, next_word,
//                 next_turn_started_at, next_round_seconds }
//
// The elimination counterpart of submit-answer, and it withholds exactly the
// same things: no "correct" flag and no elapsed time are accepted. Correctness
// is decided by looking the word up server-side; the response time is measured
// from round_results.turn_started_at to this call's arrival. Editing the client
// cannot award points, fake a fast answer, or save a life.
//
// round_num is required so a delayed or replayed submission for a turn that has
// already resolved is rejected rather than applied to whoever is on the hook now
// — which in this mode would cost an innocent player a life, not merely a point.
//
// WHAT THIS FUNCTION DOES NOT DECIDE (all of it lives in 0012):
// whether the guess was right, whether the caller is even the turn holder,
// whether a life is lost, whether that empties the last life, who is next in the
// rotation, whether the game is over, and how long the next turn lasts. This
// file validates three field types and forwards. There is no game rule in it.
//
// ON THE NEXT TURN'S DURATION: `next_round_seconds` is already part of what
// submit_turn_answer_tx returns, computed by decayed_round_seconds() from the
// survivor count and table streak that this very answer produced. It is passed
// straight through, unmodified and unrecomputed. That is the same discipline
// round_seconds() established in Session 9b — the server is the only thing that
// may say how long a turn is, and the client renders the countdown it is given.
// Deriving it here from the decay constants would be a second implementation of
// the three-trigger curve in a language that cannot see the room's state.

import { fail, handler, respond, rpc } from "../_shared/mod.ts";

Deno.serve(
  handler(async (body, callerId) => {
    const roomId = body.room_id;
    const roundNum = body.round_num;
    const guess = body.guess;

    if (typeof roomId !== "string" || !roomId) return fail("missing_room_id", 400);
    if (!Number.isInteger(roundNum)) return fail("missing_round_num", 400);
    if (typeof guess !== "string") return fail("missing_guess", 400);

    const result = await rpc("submit_turn_answer_tx", {
      p_room_id: roomId,
      p_round_num: roundNum,
      p_player: callerId,
      p_guess: guess,
    });

    return respond(result);
  }),
);
