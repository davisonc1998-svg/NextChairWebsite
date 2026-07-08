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

// Extract a shortlist of competitor names the model recommended, for display.
// This is a light heuristic — we look for capitalised multi-word names in the
// original (non-normalised) text. Kept deliberately simple and defensive.
function extractCompetitors(responseText, shopName, max = 3) {
  if (!responseText) return [];
  const selfCore = normalise(shopName);
  const found = [];
  // Match sequences like "Sharp Edge Barbers" or "The Gentleman's Cut".
  const regex = /([A-Z][a-zA-Z'&]+(?:\s+(?:[A-Z][a-zA-Z'&]+|the|of|and|&|for)){0,3})/g;
  const matches = responseText.match(regex) || [];
  for (const m of matches) {
    const clean = m.trim();
    const n = normalise(clean);
    // Skip short/junk matches, self-mentions, and obvious non-names.
    if (clean.length < 4) continue;
    if (n === selfCore || (selfCore && n.includes(selfCore))) continue;
    // Skip common sentence-starter words that get capitalised.
    const firstWord = n.split(" ")[0];
    const skipWords = new Set([
      "here", "there", "these", "those", "some", "many", "several", "based",
      "however", "note", "please", "while", "although", "if", "when", "for",
      "you", "your", "they", "this", "that", "one", "two", "three", "first",
      "second", "another", "additionally", "unfortunately", "i", "as", "in",
      "to", "the", "a", "an", "google", "reviews", "review", "reddit",
    ]);
    if (skipWords.has(firstWord)) continue;
    // Must look like a business name (contain a barber/cut/grooming hint OR be title case multi-word).
    if (!found.some((f) => normalise(f) === n)) {
      found.push(clean);
    }
    if (found.length >= max * 2) break;
  }
  // Prefer names that hint at being a barbershop.
  const hints = ["barber", "cut", "fade", "grooming", "gents", "chair", "blade", "razor", "trim"];
  const scored = found
    .map((name) => ({
      name,
      score: hints.some((h) => normalise(name).includes(h)) ? 1 : 0,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => x.name);
  return scored;
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
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: query }] }],
      }),
    }
  );
  if (!res.ok) throw new Error(`gemini ${res.status}`);
  const data = await res.json();
  return (
    data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("\n") ||
    ""
  );
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
