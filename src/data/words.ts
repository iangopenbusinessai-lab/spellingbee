import type { WordEntry } from "../types";

// Word bank sourced roughly by grade level / usage frequency per tier.
// Keep the shape the same: id/word/tier/definition/partOfSpeech?.
export const WORD_BANK: WordEntry[] = [
  { id: "e1", word: "garden", tier: "easy", definition: "A plot of land for growing plants" },
  { id: "e2", word: "pencil", tier: "easy", definition: "A tool used for writing or drawing" },
  { id: "e3", word: "yellow", tier: "easy", definition: "The color of a lemon" },
  { id: "e4", word: "castle", tier: "easy", definition: "A large fortified building" },
  { id: "e5", word: "bridge", tier: "easy", definition: "A structure that crosses a river or gap" },
  { id: "e6", word: "apple", tier: "easy", definition: "A round fruit that is often red or green" },
  { id: "e7", word: "basket", tier: "easy", definition: "A woven container used to carry or hold things" },
  { id: "e8", word: "candle", tier: "easy", definition: "A wax stick with a wick that burns to give light" },
  { id: "e9", word: "dolphin", tier: "easy", definition: "A smart sea animal that swims in groups and breathes air" },
  { id: "e10", word: "elephant", tier: "easy", definition: "A very large gray animal with a long trunk" },
  { id: "e11", word: "feather", tier: "easy", definition: "A light, soft part that covers a bird's body" },
  { id: "e12", word: "giraffe", tier: "easy", definition: "A tall African animal with a very long neck" },
  { id: "e13", word: "hammer", tier: "easy", definition: "A tool used to pound nails into wood" },
  { id: "e14", word: "island", tier: "easy", definition: "A piece of land surrounded on all sides by water" },
  { id: "e15", word: "jacket", tier: "easy", definition: "A short coat worn over other clothing" },
  { id: "e16", word: "kitchen", tier: "easy", definition: "The room in a house where meals are cooked" },
  { id: "e17", word: "ladder", tier: "easy", definition: "A set of rungs used to climb up or down" },
  { id: "e18", word: "magnet", tier: "easy", definition: "An object that pulls certain metals toward it" },
  { id: "e19", word: "notebook", tier: "easy", definition: "A book of blank pages used for writing notes" },
  { id: "e20", word: "ocean", tier: "easy", definition: "A huge body of salt water covering much of the earth" },
  { id: "e21", word: "pillow", tier: "easy", definition: "A soft cushion used to rest your head on" },
  { id: "e22", word: "question", tier: "easy", definition: "A sentence asked in order to get information" },
  { id: "e23", word: "rainbow", tier: "easy", definition: "An arc of colors that appears in the sky after rain" },
  { id: "e24", word: "sandwich", tier: "easy", definition: "Food made by placing filling between two slices of bread" },
  { id: "e25", word: "teacher", tier: "easy", definition: "A person whose job is to help students learn" },
  { id: "e26", word: "umbrella", tier: "easy", definition: "A folding device used to stay dry in the rain" },
  { id: "e27", word: "village", tier: "easy", definition: "A small group of houses in the countryside" },
  { id: "e28", word: "window", tier: "easy", definition: "An opening in a wall that lets in light and air" },
  { id: "e29", word: "zebra", tier: "easy", definition: "An African animal known for its black and white stripes" },
  { id: "e30", word: "anchor", tier: "easy", definition: "A heavy object dropped from a boat to keep it in place" },

  { id: "m1", word: "rhythm", tier: "medium", definition: "A strong, regular repeated pattern of sound" },
  { id: "m2", word: "narrate", tier: "medium", definition: "To give a spoken account of something" },
  { id: "m3", word: "occasion", tier: "medium", definition: "A particular time or event" },
  { id: "m4", word: "vacuum", tier: "medium", definition: "A space entirely devoid of matter" },
  { id: "m5", word: "privilege", tier: "medium", definition: "A special right granted to a person or group" },
  { id: "m6", word: "absence", tier: "medium", definition: "The state of being away from a place where you're expected" },
  { id: "m7", word: "achieve", tier: "medium", definition: "To succeed in finishing something through effort" },
  { id: "m8", word: "benefit", tier: "medium", definition: "An advantage or helpful result gained from something" },
  { id: "m9", word: "category", tier: "medium", definition: "A group of things that share common features" },
  { id: "m10", word: "colleague", tier: "medium", definition: "A person you work with, especially in a profession" },
  { id: "m11", word: "definite", tier: "medium", definition: "Clearly stated and not likely to change" },
  { id: "m12", word: "embarrass", tier: "medium", definition: "To make someone feel awkward or self-conscious" },
  { id: "m13", word: "exaggerate", tier: "medium", definition: "To describe something as larger or more extreme than it really is" },
  { id: "m14", word: "existence", tier: "medium", definition: "The state or fact of being real or alive" },
  { id: "m15", word: "fascinate", tier: "medium", definition: "To hold someone's attention completely because it's so interesting" },
  { id: "m16", word: "foreign", tier: "medium", definition: "Coming from or located in a country other than your own" },
  { id: "m17", word: "government", tier: "medium", definition: "The group of people who officially run a country or region" },
  { id: "m18", word: "harass", tier: "medium", definition: "To repeatedly bother or trouble someone" },
  { id: "m19", word: "humorous", tier: "medium", definition: "Causing laughter or amusement" },
  { id: "m20", word: "immediate", tier: "medium", definition: "Happening right away, without any delay" },
  { id: "m21", word: "jewelry", tier: "medium", definition: "Ornamental items like rings and necklaces worn on the body" },
  { id: "m22", word: "knowledge", tier: "medium", definition: "Information and understanding gained through learning or experience" },
  { id: "m23", word: "license", tier: "medium", definition: "An official document that gives permission to do something" },
  { id: "m24", word: "maintenance", tier: "medium", definition: "The work needed to keep something in good condition" },
  { id: "m25", word: "necessary", tier: "medium", definition: "Required in order for something to happen or be true" },
  { id: "m26", word: "occurrence", tier: "medium", definition: "Something that happens or takes place" },
  { id: "m27", word: "parallel", tier: "medium", definition: "Running side by side and always the same distance apart" },
  { id: "m28", word: "personnel", tier: "medium", definition: "The people who work for a particular organization" },
  { id: "m29", word: "questionnaire", tier: "medium", definition: "A written set of questions used to gather information from people" },
  { id: "m30", word: "recommend", tier: "medium", definition: "To suggest that something is good or suitable" },

  { id: "h1", word: "conscience", tier: "hard", definition: "An inner sense of right and wrong" },
  { id: "h2", word: "bureaucracy", tier: "hard", definition: "A system of government with many departments" },
  { id: "h3", word: "silhouette", tier: "hard", definition: "The dark shape of something against a light background" },
  { id: "h4", word: "millennium", tier: "hard", definition: "A period of one thousand years" },
  { id: "h5", word: "reconnaissance", tier: "hard", definition: "Military observation of enemy territory" },
  { id: "h6", word: "acquiesce", tier: "hard", definition: "To accept something without objecting, even reluctantly" },
  { id: "h7", word: "camaraderie", tier: "hard", definition: "A feeling of trust and friendship among a group of people" },
  { id: "h8", word: "circumference", tier: "hard", definition: "The distance measured around the outside edge of a circle" },
  { id: "h9", word: "connoisseur", tier: "hard", definition: "A person with expert knowledge and taste in a particular field" },
  { id: "h10", word: "deteriorate", tier: "hard", definition: "To become gradually worse in condition or quality" },
  { id: "h11", word: "entrepreneur", tier: "hard", definition: "A person who starts and runs their own business, taking on financial risk" },
  { id: "h12", word: "exacerbate", tier: "hard", definition: "To make an already difficult situation even worse" },
  { id: "h13", word: "extraordinary", tier: "hard", definition: "Far beyond what is usual or ordinary" },
  { id: "h14", word: "gregarious", tier: "hard", definition: "Fond of the company of others; very sociable" },
  { id: "h15", word: "hierarchy", tier: "hard", definition: "A system that ranks people or things in order of importance" },
  { id: "h16", word: "hypothesis", tier: "hard", definition: "An idea proposed as a starting point for further investigation" },
  { id: "h17", word: "indigenous", tier: "hard", definition: "Originating naturally in a particular place rather than arriving from elsewhere" },
  { id: "h18", word: "juxtaposition", tier: "hard", definition: "The placement of two contrasting things close together for effect" },
  { id: "h19", word: "kaleidoscope", tier: "hard", definition: "A tube of mirrors and colored glass that creates shifting patterns" },
  { id: "h20", word: "leisure", tier: "hard", definition: "Free time not taken up by work or obligations" },
  { id: "h21", word: "malevolent", tier: "hard", definition: "Having or showing a wish to cause harm to others" },
  { id: "h22", word: "nemesis", tier: "hard", definition: "A long-standing rival who seems impossible to overcome" },
  { id: "h23", word: "obsequious", tier: "hard", definition: "Overly eager to please or obey someone, often insincerely" },
  { id: "h24", word: "paradigm", tier: "hard", definition: "A typical example or pattern that serves as a model" },
  { id: "h25", word: "quintessential", tier: "hard", definition: "Representing the most perfect or typical example of something" },
  { id: "h26", word: "renaissance", tier: "hard", definition: "A period of renewed growth and creativity in a field or culture" },
  { id: "h27", word: "sovereignty", tier: "hard", definition: "The full authority a state has to govern itself" },
  { id: "h28", word: "tumultuous", tier: "hard", definition: "Marked by loud confusion, disorder, or violent change" },
  { id: "h29", word: "ubiquitous", tier: "hard", definition: "Seeming to appear everywhere at the same time" },
  { id: "h30", word: "vernacular", tier: "hard", definition: "The everyday language spoken by ordinary people in a region" },

  { id: "x1", word: "bromocriptine", tier: "expert", definition: "A drug used to treat certain hormonal disorders" },
  { id: "x2", word: "pharmaceutical", tier: "expert", definition: "Relating to the preparation of medicinal drugs" },
  { id: "x3", word: "onomatopoeia", tier: "expert", definition: "A word that phonetically imitates a sound" },
  { id: "x4", word: "idiosyncrasy", tier: "expert", definition: "A distinctive habit or peculiarity" },
  { id: "x5", word: "chiaroscuro", tier: "expert", definition: "The treatment of light and shade in art" },
  { id: "x6", word: "antediluvian", tier: "expert", definition: "Extremely old-fashioned, as if from before a great flood" },
  { id: "x7", word: "bildungsroman", tier: "expert", definition: "A novel that follows its main character's growth from youth to maturity" },
  { id: "x8", word: "chrysanthemum", tier: "expert", definition: "A flowering plant known for its many-petaled autumn blooms" },
  { id: "x9", word: "doppelganger", tier: "expert", definition: "A person who looks strikingly like someone else, as if a double" },
  { id: "x10", word: "ebullient", tier: "expert", definition: "Overflowing with excitement and high spirits" },
  { id: "x11", word: "fatuous", tier: "expert", definition: "Silly and pointless in a way that shows poor judgment" },
  { id: "x12", word: "gesticulate", tier: "expert", definition: "To wave your arms and hands while speaking to emphasize a point" },
  { id: "x13", word: "hegemony", tier: "expert", definition: "Dominant influence or control held by one group over others" },
  { id: "x14", word: "ignominious", tier: "expert", definition: "Causing public shame or disgrace" },
  { id: "x15", word: "kowtow", tier: "expert", definition: "To act in an overly submissive way toward someone in authority" },
  { id: "x16", word: "labyrinthine", tier: "expert", definition: "Extremely complicated and full of confusing twists, like a maze" },
  { id: "x17", word: "mellifluous", tier: "expert", definition: "Sweet and smooth sounding, especially describing a voice" },
  { id: "x18", word: "nefarious", tier: "expert", definition: "Wicked or criminal in a deliberate, calculated way" },
  { id: "x19", word: "obfuscate", tier: "expert", definition: "To make something unclear or hard to understand on purpose" },
  { id: "x20", word: "pachyderm", tier: "expert", definition: "A large thick-skinned mammal such as an elephant or rhinoceros" },
  { id: "x21", word: "quixotic", tier: "expert", definition: "Idealistic to an unrealistic or impractical degree" },
  { id: "x22", word: "rhinoceros", tier: "expert", definition: "A large thick-skinned mammal with one or two horns on its snout" },
  { id: "x23", word: "sycophant", tier: "expert", definition: "A person who flatters others to gain personal advantage" },
  { id: "x24", word: "taciturn", tier: "expert", definition: "Habitually saying very little" },
  { id: "x25", word: "unctuous", tier: "expert", definition: "Excessively and insincerely flattering or smooth in manner" },
  { id: "x26", word: "vicissitude", tier: "expert", definition: "An unexpected change in circumstances, often for the worse" },
  { id: "x27", word: "wunderkind", tier: "expert", definition: "A person who achieves great success at a young age" },
  { id: "x28", word: "xenophobia", tier: "expert", definition: "An intense fear or dislike of people from other countries" },
  { id: "x29", word: "yttrium", tier: "expert", definition: "A silvery metallic chemical element used in certain alloys and lasers" },
  { id: "x30", word: "zeitgeist", tier: "expert", definition: "The defining mood or spirit of a particular period in history" },

  // =========================================================================
  // PLACEHOLDER CONTENT — Session 15. NOT curated, NOT balanced, NOT final.
  //
  // The four tiers added in Session 15 (novice / building / advanced / master)
  // exist here only so the game does not break when someone picks them: 8 words
  // each instead of the 30 the original tiers carry. They were written to be
  // roughly plausible for their slot, but no frequency or grade-level sourcing
  // went into them.
  //
  // Session 16's word-sourcing pipeline REPLACES all of this with ~150 real
  // words per tier. Delete this whole block then — don't try to grow it by hand.
  //
  // Consequences while these stand, both already handled rather than bugs:
  //   - a singleplayer run on one of these tiers is 8 words long, not 30;
  //   - a multiplayer room on one of them ends when the words run out, which
  //     advance_round_tx already treats as game over (0006: `v_word_id is null
  //     or current_round >= rounds_per_game()`), so it finishes at 8 of 10.
  // =========================================================================

  // novice — placeholder
  { id: "n1", word: "cat", tier: "novice", definition: "A small furry pet that purrs" },
  { id: "n2", word: "sun", tier: "novice", definition: "The bright star that lights the day" },
  { id: "n3", word: "book", tier: "novice", definition: "Pages bound together for reading" },
  { id: "n4", word: "milk", tier: "novice", definition: "A white drink that comes from cows" },
  { id: "n5", word: "tree", tier: "novice", definition: "A tall plant with a trunk and branches" },
  { id: "n6", word: "hand", tier: "novice", definition: "The part of your body at the end of your arm" },
  { id: "n7", word: "door", tier: "novice", definition: "What you open to go into a room" },
  { id: "n8", word: "fish", tier: "novice", definition: "An animal that lives and swims in water" },

  // building — placeholder
  { id: "b1", word: "puzzle", tier: "building", definition: "A game or problem that tests your cleverness" },
  { id: "b2", word: "market", tier: "building", definition: "A place where goods are bought and sold" },
  { id: "b3", word: "silent", tier: "building", definition: "Making no sound at all" },
  { id: "b4", word: "journey", tier: "building", definition: "A trip from one place to another" },
  { id: "b5", word: "picture", tier: "building", definition: "A drawing, painting or photograph" },
  { id: "b6", word: "kitchen", tier: "building", definition: "The room where food is prepared" },
  { id: "b7", word: "monster", tier: "building", definition: "A large frightening imaginary creature" },
  { id: "b8", word: "whisper", tier: "building", definition: "To speak very quietly" },

  // advanced — placeholder
  { id: "a1", word: "corridor", tier: "advanced", definition: "A long passage inside a building" },
  { id: "a2", word: "reliable", tier: "advanced", definition: "Able to be trusted to do what is expected" },
  { id: "a3", word: "ceremony", tier: "advanced", definition: "A formal event held to mark an occasion" },
  { id: "a4", word: "gradual", tier: "advanced", definition: "Happening slowly over a period of time" },
  { id: "a5", word: "opponent", tier: "advanced", definition: "Someone you compete against" },
  { id: "a6", word: "sincere", tier: "advanced", definition: "Genuine and free from pretence" },
  { id: "a7", word: "turbulent", tier: "advanced", definition: "Marked by violent or unsteady movement" },
  { id: "a8", word: "vacancy", tier: "advanced", definition: "A position or space that is unoccupied" },

  // master — placeholder
  { id: "z1", word: "chiaroscuro", tier: "master", definition: "The treatment of light and shade in a work of art" },
  { id: "z2", word: "eleemosynary", tier: "master", definition: "Relating to or dependent on charity" },
  { id: "z3", word: "logorrhoea", tier: "master", definition: "Excessive and often incoherent talkativeness" },
  { id: "z4", word: "prestidigitation", tier: "master", definition: "Skilful sleight of hand performed as entertainment" },
  { id: "z5", word: "sesquipedalian", tier: "master", definition: "Given to using very long words" },
  { id: "z6", word: "usufruct", tier: "master", definition: "The legal right to use another's property short of destroying it" },
  { id: "z7", word: "vicissitude", tier: "master", definition: "A change of circumstance, typically an unwelcome one" },
  { id: "z8", word: "zugzwang", tier: "master", definition: "A chess position where any move a player makes worsens it" },
];

export function wordsForTier(tier: WordEntry["tier"]): WordEntry[] {
  return WORD_BANK.filter((w) => w.tier === tier);
}
