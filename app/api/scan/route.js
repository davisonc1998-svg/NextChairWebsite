// NextChair — AI visibility scan engine
// Queries multiple AI models with realistic customer prompts, then checks
// whether the given barbershop is mentioned in the responses.

export const runtime = "nodejs";
export const maxDuration = 60;

// --- Rate limiting & abuse protection ---------------------------------------
// Serverless functions don't share memory reliably between instances, so this
// is a best-effort limiter: it catches the common cases (one visitor hammering
// the scan, or a sudden flood hitting a single warm instance). The hard backstop
// is the spend cap set in each AI provider's own dashboard.
//
// Tunable limits:
const RATE = {
  perIpPerHour: 5, // max scans from one IP per rolling hour
  perIpCooldownMs: 8000, // min gap between scans from the same IP
  globalPerHour: 200, // rough ceiling on total scans per instance per hour
};

// In-memory stores (reset when the instance recycles — acceptable for now).
const ipHits = new Map(); // ip -> [timestamps]
const ipLast = new Map(); // ip -> last timestamp
let globalHits = []; // timestamps of all scans on this instance

function getClientIp(req) {
  // Vercel forwards the real client IP in these headers.
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}

// Returns { ok: true } or { ok: false, reason, retryAfter }.
function checkRateLimit(ip) {
  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;

  // Global ceiling.
  globalHits = globalHits.filter((t) => t > hourAgo);
  if (globalHits.length >= RATE.globalPerHour) {
    return { ok: false, reason: "busy" };
  }

  // Per-IP cooldown (rapid repeat-fire).
  const last = ipLast.get(ip) || 0;
  if (now - last < RATE.perIpCooldownMs) {
    return { ok: false, reason: "cooldown" };
  }

  // Per-IP hourly quota.
  const hits = (ipHits.get(ip) || []).filter((t) => t > hourAgo);
  if (hits.length >= RATE.perIpPerHour) {
    return { ok: false, reason: "quota" };
  }

  // Record this hit.
  hits.push(now);
  ipHits.set(ip, hits);
  ipLast.set(ip, now);
  globalHits.push(now);

  // Opportunistic cleanup so the maps don't grow unbounded.
  if (ipHits.size > 5000) {
    for (const [k, v] of ipHits) {
      const fresh = v.filter((t) => t > hourAgo);
      if (fresh.length === 0) ipHits.delete(k);
      else ipHits.set(k, fresh);
    }
  }

  return { ok: true };
}
// ---------------------------------------------------------------------------


// Build the set of customer-style queries for a given town/area.
function buildQueries(town) {
  const t = town.trim();
  const instruction =
    ` After your answer, on a new line, list ONLY the actual barbershop ` +
    `business names you named above, in this exact format: ` +
    `SHOPS: name one | name two | name three. ` +
    `Include only real named barbershops or salons — no generic advice, ` +
    `no directories (Google, Yelp, Treatwell), no phone numbers, no areas. ` +
    `If you didn't name any specific shops, write: SHOPS: none.`;
  return [
    `Best barbershop in ${t}?` + instruction,
    `Where can I get a good skin fade in ${t}?` + instruction,
    `Recommend a top-rated barber near ${t}.` + instruction,
    `I'm new to ${t} and need a reliable barber for regular haircuts. Any suggestions?` +
      instruction,
    `Best place for a men's haircut and beard trim in ${t}?` + instruction,
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

  // Space-insensitive match: "Mancave" vs "Man Cave", "Hair Tonic" vs "Hairtonic".
  // We compare with all spaces removed so joined/split spellings both match.
  const respNoSpace = resp.replace(/\s+/g, "");
  const fullNoSpace = full.replace(/\s+/g, "");
  if (fullNoSpace.length >= 4 && respNoSpace.includes(fullNoSpace)) return true;

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

  // Space-insensitive core match (e.g. "Man Cave" core vs "Mancave" in response).
  const coreNoSpace = core.replace(/\s+/g, "");
  if (coreNoSpace.length >= 4 && respNoSpace.includes(coreNoSpace)) return true;

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

// Extract competitor barbershop names from a model response.
//
// We instruct each model (in the query) to end its answer with a structured
// block: "SHOPS: name one | name two | name three" (or "SHOPS: none"). We parse
// only that block, which is far more reliable than mining names from free prose.
// A light sanity filter still drops any obvious non-shop entries that slip in.
function extractCompetitors(responseText, shopName, max = 3) {
  if (!responseText) return [];

  // Find the SHOPS: block. Require it to be a standalone token (start of line
  // or preceded by whitespace) so it doesn't match inside "barberSHOPS:".
  const match = responseText.match(/(?:^|\s)SHOPS:\s*(.+)/i);
  if (!match) return [];

  let list = match[1].trim();

  // "none" (any casing/punctuation) means the model named no specific shops.
  if (/^none/i.test(list.replace(/[^a-zA-Z]/g, ' ').trim())) return [];

  const selfNorm = normalise(shopName);

  // Reject entries that are clearly not shop names even inside the block.
  const bannedExact = new Set([
    'none', 'social media', 'google', 'google maps', 'yelp', 'treatwell',
    'facebook', 'instagram', 'nearby shops', 'local shops', 'ask for a trial cut',
    'ask for recommendations', 'visit nearby shops', 'recommendations',
    'trial cut', 'reviews', 'directories', 'search online', 'word of mouth',
  ]);

  const names = list
    .split('|')
    .map((s) => s.replace(/[*_`#"]/g, '').trim())
    .filter(Boolean)
    .filter((name) => {
      const n = normalise(name);
      if (!n || n.length < 3 || name.length > 45) return false;
      if (bannedExact.has(n)) return false;
      // Drop self-mentions.
      if (selfNorm && (n === selfNorm || n.includes(selfNorm) || selfNorm.includes(n))) return false;
      // Drop anything with digits (phone/address fragments).
      if (/\d/.test(name)) return false;
      // Must contain a capital letter (proper noun) somewhere.
      if (!/[A-Z]/.test(name)) return false;
      return true;
    });

  // De-duplicate (case-insensitive), preserve order, cap at max.
  const seen = new Set();
  const out = [];
  for (const name of names) {
    const n = normalise(name);
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(name);
    if (out.length >= max) break;
  }
  return out;
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

// --- Google Places verification ---------------------------------------------
// Each AI-suggested competitor is checked against Google Places. We keep a name
// only if Places finds a real, currently-operational business matching that name
// near the searched town. This drops hallucinated shops and wrong-city results.
//
// Uses the Places API (New) Text Search endpoint. Fails safe: if the key is
// missing or a lookup errors, that candidate is dropped (better blank than wrong).
async function verifyCompetitor(name, town) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return null; // No key → can't verify → drop (fail safe).

  try {
    const res = await fetch(
      "https://places.googleapis.com/v1/places:searchText",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
          // Ask only for the fields we need, to keep cost/response small.
          "X-Goog-FieldMask":
            "places.displayName,places.formattedAddress,places.businessStatus,places.location",
        },
        body: JSON.stringify({
          textQuery: `${name} barber ${town}`,
          maxResultCount: 1,
          languageCode: "en",
        }),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const place = data.places?.[0];
    if (!place) return null; // Not found on Places → almost certainly not real.

    // Must be operational (not permanently/temporarily closed).
    if (place.businessStatus && place.businessStatus !== "OPERATIONAL") {
      return null;
    }

    const address = (place.formattedAddress || "").toLowerCase();
    const townLc = town.toLowerCase().trim();

    // Location sanity check: the town the user searched should appear somewhere
    // in the verified address. Handles "Islington, London" by checking each part.
    const townParts = townLc.split(/[,\s]+/).filter((p) => p.length >= 3);
    const townMatches =
      townParts.length === 0 ||
      townParts.some((part) => address.includes(part));

    if (!townMatches) return null; // Real business, but wrong location → drop.

    // Return the canonical name Google has, which is cleaner than the AI's text.
    return place.displayName?.text || name;
  } catch (e) {
    console.error("PLACES_VERIFY_ERROR:", e?.message || String(e));
    return null; // Fail safe.
  }
}

// Verify a list of candidate competitors in parallel, preserving order and
// de-duplicating by the canonical name Google returns.
async function verifyCompetitors(candidates, town) {
  const results = await Promise.all(
    candidates.map(async (c) => ({
      original: c.name,
      count: c.count,
      verified: await verifyCompetitor(c.name, town),
    }))
  );

  const seen = new Set();
  const out = [];
  for (const r of results) {
    if (!r.verified) continue;
    const key = r.verified.toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: r.verified, count: r.count });
  }
  return out;
}
// ---------------------------------------------------------------------------

export async function POST(req) {
  // Rate-limit before doing any paid API work.
  const ip = getClientIp(req);
  const limit = checkRateLimit(ip);
  if (!limit.ok) {
    const messages = {
      cooldown: "Please wait a few seconds before running another check.",
      quota:
        "You've run several checks in the last hour. Please try again a little later.",
      busy: "We're handling a lot of checks right now — please try again shortly.",
    };
    return Response.json(
      { error: messages[limit.reason] || "Please try again shortly." },
      { status: 429 }
    );
  }

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

  // Reject obviously junk input (e.g. a single character, or no letters) before
  // spending on API calls.
  if (shopName.length < 2 || town.length < 2 || !/[a-zA-Z]/.test(shopName)) {
    return Response.json(
      { error: "Please enter a valid shop name and town." },
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
  // Build candidate list (take more than 5, since verification will drop some).
  const candidateCompetitors = Object.entries(compCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));

  // Verify each candidate is a real, operational business in the searched town.
  // Hallucinated or wrong-city names are dropped (fail safe → blank not wrong).
  const verified = await verifyCompetitors(candidateCompetitors, town);
  const topCompetitors = verified.slice(0, 5);

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
