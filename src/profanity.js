/*
 * DeenScreen profanity word list + censor function (v2)
 *
 * Plain word matching, no AI. Exposes one global for content.js:
 *   DeenScreenProfanity.censor(text) -> { text, count }
 *
 * Words are matched as whole words (letters on either side block a match),
 * so "class", "assume", "scrap" or "Hancock" are never touched.
 * Already-censored text like YouTube's "[ __ ]" is left exactly as it is.
 */
(() => {
  // Each entry is a regex fragment for one word family.
  // Keep fragments simple: they are joined into a single regex below.
  const WORDS = [
    "f+u+c+k+\\w*",            // fuck, fucking, fucked, fucker, fuckin
    "motherf+u+c+k+\\w*",      // motherfucker, motherfucking
    "f+u+k+(?:ing|in|ed|er|s)?",// fuk, fukin
    "shit(?:s|ty|tier|tiest|ting|ted|head|heads|hole|holes|show|load|faced)?", // not "shiitake"
    "bullshit\\w*",
    "horseshit\\w*",
    "b+i+t+c+h+\\w*",          // bitch, bitches, bitching, bitchy
    "ass(?:hole|holes|hat|hats|wipe|es)?", // ass, asshole (whole word only)
    "jackass\\w*",
    "dumbass\\w*",
    "badass\\w*",
    "bastards?",
    "cunts?",
    "dick(?:s|head|heads)?",
    "cock(?:s|sucker|suckers)?",
    "pussy|pussies",
    "piss(?:ed|es|ing)?",
    "goddamn\\w*|god damn\\w*",
    "damn(?:ed|it|n)?",
    "crap(?:py|s)?",
    "whores?",
    "sluts?",
    "slutty",
    "wtf",
    "stfu",
    "fag(?:s|got|gots)?",
    "n+i+g+g+(?:a|as|er|ers|ah|az)",
    "retards?",
    "twats?",
    "wankers?",
  ];

  // Not a letter before or after: keeps matches to whole words.
  const PATTERN = new RegExp(
    "(?<![A-Za-z])(?:" + WORDS.join("|") + ")(?![A-Za-z])",
    "gi"
  );

  const MASK = "****";

  function censor(text) {
    if (!text) return { text, count: 0 };
    let count = 0;
    const out = text.replace(PATTERN, () => {
      count++;
      return MASK;
    });
    return { text: out, count };
  }

  // (v3) For speech recognition output, one word at a time.
  // Also counts words the speech model itself wrote with asterisks ("f***"),
  // because that means the model actually heard a swear word in the audio.
  function isProfaneWord(word) {
    const w = String(word || "").trim().replace(/^[^A-Za-z*]+|[^A-Za-z*]+$/g, "");
    if (!w) return false;
    if (/^[A-Za-z]\*+[A-Za-z]*$/.test(w)) return true;
    return censor(w).count > 0;
  }

  globalThis.DeenScreenProfanity = { censor, isProfaneWord, MASK };
})();
