// NextChair — AI visibility scan engine
// Queries multiple AI models with realistic customer prompts, then checks
// whether the given barbershop is mentioned in the responses.

export const runtime = "nodejs";
export const maxDuration = 60;

// Build the set of customer-style queries for a given town/area.
function buildQueries(town) {
  const t = town.trim();
  return [
    `Best barbershop in ${t}?`,
    `Where can I get a good skin fade in ${t}?`,
    `Recommend a top-rated barber near ${t}.`,
    `I'm new to ${t} and need a reliable barber for regular haircuts. Any suggestions?`,
    `Best place for a men's haircut and beard trim in ${t}?`,
  ];
}

// Normalise text for loose matching (lowercase, strip punctuation/extra spaces).
function normalise(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Collapse a word to a rough stem so "gentleman"/"gentlemans"/"gentleman's"
// and singular/plural variants match loosely.
function stem(w) {
  let s = w;
  if (s.length > 4 && s.endsWith("s")) s = s.slice(0, -1);
  return s;
}

// Check whether the shop name appears in a response. Uses a forgiving match so
// that small differences in how the owner types their name vs how the AI writes
// it (apostrophes, "barbers" vs "barber", plurals) still count.
function isMentioned(responseText, shopName) {
  const resp = normalise(responseText);
  const full = normalise(shopName);
  if (!full) return false;

  // Direct full-name match first.
  if (resp.includes(full)) return true;

  // Strip generic barbershop words to get the distinctive core of the name.
  const stop = new Set([
    "the", "barbers", "barber", "barbershop", "barbershops", "shop",
    "salon", "salons", "hair", "haircuts", "cuts", "co", "ltd", "limited",
    "and", "of", "for", "studio", "lounge", "gents", "grooming", "mens",
  ]);
  const coreWords = full.split(" ").filter((w) => w && !stop.has(w));

  // Whole-core contiguous match.
  const core = coreWords.join(" ");
  if (core.length >= 3 && resp.includes(core)) return true;

  // Word-level stemmed match: every distinctive word must appear (stemmed)
  // somewhere in the response. This catches "Gentleman's Cut" vs "Gentlemans Cut".
  if (coreWords.length > 0) {
    const respWords = new Set(resp.split(" ").map(stem));
    const allPresent = coreWords.every((w) => {
      if (w.length < 3) return true; // ignore tiny fragments
      return respWords.has(stem(w));
    });
    // Require at least one distinctive word of length >= 4 to avoid matching on
    // something too generic.
    const hasDistinctive = coreWords.some((w) => w.length >= 4);
    if (allPresent && hasDistinctive) return true;
  }

  return false;
}

// Extract a shortlist of competitor barbershop names the model recommended.
//
// AI models almost always present recommendations as a list where the name is
// the emphasised lead of each item, e.g.:
//   "1. **Sharp & Co Barbers** - known for fades"
//   "- Aatos Barbershop: great for walk-ins"
//   "* The Gentleman's Cut — classic cuts"
// So instead of grabbing any capitalised phrase (which catches place names and
// stray words), we look specifically for the lead name of each list item and
// then filter hard against non-business phrases.
function extractCompetitors(responseText, shopName, max = 3) {
  if (!responseText) return [];
  const selfCore = normalise(shopName);

  // Words/phrases that indicate something is NOT a shop name (areas, directions,
  // generic descriptors, common list intros).
  const banned = new Set([
    "north", "south", "east", "west", "central", "greater", "the",
    "london", "city", "town", "area", "areas", "nearby", "near", "local",
    "locals", "region", "district", "borough", "neighbourhood", "neighborhood",
    "check", "note", "here", "there", "these", "those", "some", "many",
    "several", "based", "however", "please", "while", "although", "google",
    "reviews", "review", "reddit", "yelp", "recommendation", "recommendations",
    "option", "options", "consider", "additionally", "unfortunately", "overall",
    "best", "top", "popular", "great", "good", "reputable", "known", "barbershops",
    "barbers", "haircuts", "services", "prices", "booking", "online", "walk",
  ]);

  // Common generic multi-word phrases to reject outright (normalised).
  const bannedPhrases = new Set([
    "local barbershops", "local barbers", "north london", "south london",
    "east london", "west london", "central london", "greater london",
    "the area", "your area", "this area", "the city", "walk ins", "walk in",
    "google reviews", "customer reviews", "opening hours", "book online",
  ]);

  const candidates = [];

  // Split into lines and pull the "lead name" from each list-style line.
  const lines = responseText.split(/\r?\n/);
  for (const line of lines) {
    let l = line.trim();
    if (!l) continue;

    // Strip common list markers: "1.", "2)", "-", "*", "•"
    l = l.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "");

    // Take the part before the first separator (–, -, :, —, or a comma that
    // precedes a description). The name is almost always first.
    let namePart = l.split(/\s+[–—-]\s+|:\s+/)[0].trim();

    // Remove markdown emphasis markers ** __ around the name.
    namePart = namePart.replace(/[*_`#]/g, "").trim();

    // Cut off trailing description that sometimes follows without a separator
    // (keep at most the first 5 words — real shop names are short).
    const words = namePart.split(/\s+/).filter(Boolean);
    if (words.length > 6) continue; // whole line, not a name — skip
    const name = words.join(" ").trim();

    if (name.length < 3 || name.length > 45) continue;

    const n = normalise(name);
    if (!n) continue;

    // Reject self-mentions.
    if (n === selfCore || (selfCore && (n.includes(selfCore) || selfCore.includes(n)))) continue;

    // Reject banned exact phrases.
    if (bannedPhrases.has(n)) continue;

    // The name must contain at least one capitalised word (proper noun).
    const hasCap = /[A-Z]/.test(name);
    if (!hasCap) continue;

    // Reject if EVERY significant word is banned (i.e. it's just area/generic words).
    const nWords = n.split(" ").filter((w) => w.length > 1);
    const meaningful = nWords.filter((w) => !banned.has(w));
    if (meaningful.length === 0) continue;

    // Reject if it's a single banned word or a bare place/direction.
    if (nWords.length === 1 && banned.has(nWords[0])) continue;

    // Reject sentence fragments: if the phrase contains common verbs/filler,
    // it's a description, not a name.
    const fragmentWords = new Set([
      "are", "is", "was", "has", "have", "offers", "provides", "listings",
      "plentiful", "many", "options", "here", "available", "located", "found",
      "include", "includes", "such", "well", "very", "quite", "also", "more",
    ]);
    if (nWords.some((w) => fragmentWords.has(w))) continue;

    // Require at least one "strong" proper-noun-ish word: a capitalised word
    // that isn't a banned area/generic term. This is the key filter that keeps
    // real names ("Fade Factory") and drops area phrases ("North London").
    const rawWords = name.split(/\s+/);
    const strongProperNoun = rawWords.some((w) => {
      const clean = w.replace(/[^\w&]/g, "");
      if (clean.length < 2) return false;
      const isCap = /^[A-Z]/.test(clean);
      return isCap && !banned.has(clean.toLowerCase());
    });
    if (!strongProperNoun) continue;

    candidates.push(name);
  }

  // Score: prefer names that look like barbershops, then de-duplicate.
  const hints = ["barber", "cut", "cutz", "fade", "grooming", "gents",
    "chair", "blade", "razor", "trim", "clipper", "sharp", "shave", "co"];
  const seen = new Set();
  const scored = [];
  for (const name of candidates) {
    const n = normalise(name);
    if (seen.has(n)) continue;
    seen.add(n);
    const score = hints.some((h) => n.includes(h)) ? 1 : 0;
    scored.push({ name, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max).map((x) => x.name);
}

// --- Individual model callers. Each returns { text } or throws. ---

async function callOpenAI(query) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("no key");
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: query }],
      max_tokens: 400,
      temperature: 0.4,
    }),
  });
  if (!res.ok) throw new Error(`openai ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

async function callAnthropic(query) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("no key");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 400,
      messages: [{ role: "user", content: query }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}`);
  const data = await res.json();
  return data.content?.map((b) => b.text || "").join("\n") || "";
}

async function callGemini(query) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("no key");

  // Try a few model names for resilience across API versions.
  const models = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"];
  let lastErr = "";

  for (const model of models) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Newer AI Studio keys authenticate via this header.
            "x-goog-api-key": key,
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: query }] }],
          }),
        }
      );
      if (!res.ok) {
        const body = await res.text();
        lastErr = `gemini ${res.status} (${model}): ${body.slice(0, 200)}`;
        // 404 = model name not found for this key; try the next model.
        // Other errors (403/400) usually apply to all models, so break early.
        if (res.status === 404) continue;
        throw new Error(lastErr);
      }
      const data = await res.json();
      return (
        data.candidates?.[0]?.content?.parts
          ?.map((p) => p.text || "")
          .join("\n") || ""
      );
    } catch (e) {
      lastErr = e.message || String(e);
      // Network-level failure: try next model.
    }
  }
  throw new Error(lastErr || "gemini failed");
}

async function callPerplexity(query) {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) throw new Error("no key");
  const res = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: "sonar",
      messages: [{ role: "user", content: query }],
      max_tokens: 400,
    }),
  });
  if (!res.ok) throw new Error(`perplexity ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

const MODELS = [
  { id: "openai", label: "ChatGPT", call: callOpenAI },
  { id: "anthropic", label: "Claude", call: callAnthropic },
  { id: "gemini", label: "Gemini", call: callGemini },
  { id: "perplexity", label: "Perplexity", call: callPerplexity },
];

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  const shopName = (body.shopName || "").toString().slice(0, 120).trim();
  const town = (body.town || "").toString().slice(0, 120).trim();

  if (!shopName || !town) {
    return Response.json(
      { error: "Please enter both your shop name and town." },
      { status: 400 }
    );
  }

  const queries = buildQueries(town);

  // For each model, run all queries. We flatten into per-(model,query) checks.
  const modelResults = [];

  await Promise.all(
    MODELS.map(async (model) => {
      const perQuery = [];
      for (const q of queries) {
        try {
          const text = await model.call(q);
          perQuery.push({
            query: q,
            mentioned: isMentioned(text, shopName),
            competitors: extractCompetitors(text, shopName),
            ok: true,
          });
        } catch (e) {
          console.error(`MODEL_ERROR [${model.label}]:`, e?.message || String(e));
          perQuery.push({ query: q, mentioned: false, competitors: [], ok: false });
        }
      }
      const answered = perQuery.filter((p) => p.ok);
      const mentions = perQuery.filter((p) => p.mentioned).length;
      modelResults.push({
        id: model.id,
        label: model.label,
        available: answered.length > 0,
        totalQueries: queries.length,
        answeredQueries: answered.length,
        mentions,
        perQuery,
      });
    })
  );

  // Aggregate competitor mentions across everything.
  const compCount = {};
  for (const m of modelResults) {
    for (const p of m.perQuery) {
      for (const c of p.competitors) {
        const key = c.trim();
        compCount[key] = (compCount[key] || 0) + 1;
      }
    }
  }
  const topCompetitors = Object.entries(compCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  const availableModels = modelResults.filter((m) => m.available);
  const totalChecks = availableModels.reduce((s, m) => s + m.answeredQueries, 0);
  const totalMentions = availableModels.reduce((s, m) => s + m.mentions, 0);

  return Response.json({
    shopName,
    town,
    models: modelResults,
    totalChecks,
    totalMentions,
    topCompetitors,
    scannedAt: new Date().toISOString(),
  });
}
