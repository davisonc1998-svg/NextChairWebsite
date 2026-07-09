"use client";

import { useState, useEffect } from "react";

const LOADING_STEPS = [
  "Asking ChatGPT for the best barber in town…",
  "Checking what Gemini recommends…",
  "Asking Claude who it would send a customer to…",
  "Seeing who Perplexity puts first…",
  "Counting how often your shop came up…",
];

function ScoreRing({ mentions, total }) {
  const pct = total > 0 ? mentions / total : 0;
  const circumference = 2 * Math.PI * 58;
  const dash = circumference * pct;
  const color =
    pct === 0 ? "var(--oxblood)" : pct < 0.5 ? "var(--brass)" : "var(--green)";
  return (
    <div className="score-ring">
      <svg width="132" height="132" viewBox="0 0 132 132">
        <circle
          cx="66" cy="66" r="58" fill="none"
          stroke="var(--cream-deep)" strokeWidth="11"
        />
        <circle
          cx="66" cy="66" r="58" fill="none"
          stroke={color} strokeWidth="11" strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference}`}
          transform="rotate(-90 66 66)"
        />
      </svg>
      <div className="num">
        <b>{mentions}/{total}</b>
        <span>AI searches</span>
      </div>
    </div>
  );
}

export default function ScanTool() {
  const [stage, setStage] = useState("form"); // form | loading | result
  const [shopName, setShopName] = useState("");
  const [town, setTown] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [loadingStep, setLoadingStep] = useState(0);

  // Lead capture
  const [leadName, setLeadName] = useState("");
  const [leadContact, setLeadContact] = useState("");
  const [leadError, setLeadError] = useState("");
  const [leadDone, setLeadDone] = useState(false);
  const [leadSending, setLeadSending] = useState(false);

  useEffect(() => {
    if (stage !== "loading") return;
    setLoadingStep(0);
    const iv = setInterval(() => {
      setLoadingStep((s) => (s < LOADING_STEPS.length - 1 ? s + 1 : s));
    }, 2200);
    return () => clearInterval(iv);
  }, [stage]);

  async function runScan(e) {
    e.preventDefault();
    setError("");
    if (!shopName.trim() || !town.trim()) {
      setError("Please enter both your shop name and town.");
      return;
    }
    setStage("loading");
    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shopName, town }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Something went wrong. Please try again.");
        setStage("form");
        return;
      }
      setResult(data);
      setStage("result");
    } catch {
      setError("Couldn't run the scan. Please check your connection and try again.");
      setStage("form");
    }
  }

  async function submitLead(e) {
    e.preventDefault();
    setLeadError("");
    if (!leadName.trim() || !leadContact.trim()) {
      setLeadError("Please add your name and a way to reach you.");
      return;
    }
    setLeadSending(true);
    try {
      const summary = result
        ? `Appeared in ${result.totalMentions}/${result.totalChecks} AI checks`
        : "";
      const res = await fetch("/api/lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: leadName,
          contact: leadContact,
          shopName: result?.shopName,
          town: result?.town,
          scanSummary: summary,
        }),
      });
      if (!res.ok) {
        const d = await res.json();
        setLeadError(d.error || "Couldn't send that. Try again.");
        setLeadSending(false);
        return;
      }
      setLeadDone(true);
    } catch {
      setLeadError("Couldn't send that. Try again.");
    }
    setLeadSending(false);
  }

  function reset() {
    setStage("form");
    setResult(null);
    setError("");
    setLeadName("");
    setLeadContact("");
    setLeadDone(false);
    setLeadError("");
  }

  const total = result?.totalChecks || 0;
  const mentions = result?.totalMentions || 0;
  const pct = total > 0 ? mentions / total : 0;
  const verdict =
    pct === 0
      ? { cls: "bad", label: "You're invisible to AI", sub: "When locals ask AI for the best barber near you, your shop isn't coming up at all — so those customers never hear your name." }
      : pct < 0.5
      ? { cls: "mid", label: "You're barely showing up", sub: "You come up sometimes, but you're being left out of most AI recommendations — so a lot of nearby customers never hear your name." }
      : { cls: "good", label: "You're on AI's radar", sub: "You're being recommended fairly often. There's still room to lock in the top spot and come up more consistently." };

  function modelTag(m) {
    if (!m.available) return { cls: "na", text: "No response" };
    if (m.mentions === 0) return { cls: "miss", text: "Didn't recommend you" };
    if (m.mentions < m.answeredQueries) return { cls: "some", text: `Recommended you ${m.mentions}/${m.answeredQueries}` };
    return { cls: "hit", text: "Recommended you" };
  }

  return (
    <div className="page">
      <div className="pole-stripe" />
      <header className="masthead">
        <div className="wrap">
          <div className="brand">
            <div className="brand-mark" />
            <div className="brand-name">NextChair</div>
          </div>
        </div>
      </header>

      <main className="wrap" style={{ flex: 1, width: "100%" }}>
        {stage === "form" && (
          <>
            <section className="hero">
              <div className="eyebrow">For barbershops</div>
              <h1>
                When locals ask AI for the best barber,<br />
                <span className="hl">do they hear your name?</span>
              </h1>
              <p className="sub">
                More people are asking ChatGPT and Google's AI "best barber near me"
                instead of scrolling. Run a free check to see whether you show up —
                or whether the shop down the road does.
              </p>
            </section>

            <div className="card">
              <div className="card-inner">
                <form className="form-row" onSubmit={runScan}>
                  <div className="field">
                    <label htmlFor="shop">Your shop name</label>
                    <input
                      id="shop"
                      value={shopName}
                      onChange={(e) => setShopName(e.target.value)}
                      placeholder="e.g. Sharp & Co Barbers"
                      autoComplete="off"
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="town">Your town or area</label>
                    <input
                      id="town"
                      value={town}
                      onChange={(e) => setTown(e.target.value)}
                      placeholder="e.g. Islington, London"
                      autoComplete="off"
                    />
                  </div>
                  <button className="btn btn-primary" type="submit">
                    Run my free AI check
                  </button>
                </form>
                {error && <div className="hint err">{error}</div>}
                {!error && (
                  <div className="hint">Takes about 30 seconds. No sign-up needed.</div>
                )}
              </div>
            </div>

            <section className="how">
              <h2>How it works</h2>
              <div className="steps">
                <div className="step">
                  <div className="n">1</div>
                  <h4>We ask the AIs</h4>
                  <p>We put real "best barber near me" questions to the four biggest AI tools.</p>
                </div>
                <div className="step">
                  <div className="n">2</div>
                  <h4>We check for you</h4>
                  <p>We see how often your shop gets named — and which rivals get named instead.</p>
                </div>
                <div className="step">
                  <div className="n">3</div>
                  <h4>You see the truth</h4>
                  <p>A plain, honest scorecard. No jargon, no dashboard to figure out.</p>
                </div>
              </div>
            </section>
          </>
        )}

        {stage === "loading" && (
          <div className="card" style={{ marginTop: 40 }}>
            <div className="loading">
              <div className="spinner" />
              <div className="status">{LOADING_STEPS[loadingStep]}</div>
              <div className="sub">Checking {shopName} in {town}…</div>
            </div>
          </div>
        )}

        {stage === "result" && result && (
          <div className="card" style={{ marginTop: 36 }}>
            <div className="result-head">
              <ScoreRing mentions={mentions} total={total} />
              <div className={`verdict ${verdict.cls}`}>{verdict.label}</div>
              <p className="verdict-sub">{verdict.sub}</p>
            </div>

            <div className="models">
              {result.models.map((m) => {
                const tag = modelTag(m);
                return (
                  <div className="model-row" key={m.id}>
                    <div className="name">{m.label}</div>
                    <div className={`tag ${tag.cls}`}>{tag.text}</div>
                  </div>
                );
              })}
            </div>

            <div className="competitors">
              <h3>Local barbers AI names when asked</h3>
              {result.topCompetitors && result.topCompetitors.length > 0 ? (
                <>
                  <ul>
                    {result.topCompetitors.map((c, i) => (
                      <li key={i}>
                        <span className="dot" />
                        {c.name}
                      </li>
                    ))}
                  </ul>
                  <p className="comp-note">
                    These are real, local shops AI has suggested to people asking
                    for a barber near you. AI answers change from day to day — the
                    point is simple: right now these names come up, and getting
                    yours to come up consistently is what we help with.
                  </p>
                </>
              ) : (
                <div className="none">
                  No specific shop names came up clearly this time — but AI answers
                  change day to day, and that can shift quickly. What matters is
                  making sure yours is the name that comes up.
                </div>
              )}
            </div>

            {!leadDone ? (
              <div className="lead">
                <h3>Want to be the name AI recommends?</h3>
                <p>
                  We fix the things that decide whether AI recommends your shop —
                  and re-check every month so you can see it working. Leave your
                  details and we'll show you exactly what to do.
                </p>
                <form className="fields" onSubmit={submitLead}>
                  <input
                    value={leadName}
                    onChange={(e) => setLeadName(e.target.value)}
                    placeholder="Your name"
                    autoComplete="name"
                  />
                  <input
                    value={leadContact}
                    onChange={(e) => setLeadContact(e.target.value)}
                    placeholder="Email or mobile"
                    autoComplete="email"
                  />
                  <button className="btn btn-primary" type="submit" disabled={leadSending}>
                    {leadSending ? "Sending…" : "Show me how to fix this"}
                  </button>
                </form>
                {leadError && (
                  <div className="microcopy" style={{ color: "#ffd7d7" }}>
                    {leadError}
                  </div>
                )}
                <div className="microcopy">
                  No spam. We'll only be in touch about your AI visibility.
                </div>
              </div>
            ) : (
              <div className="lead done">
                <h3>Got it — thank you</h3>
                <p>
                  We'll be in touch shortly with exactly what's holding your shop
                  back and how to fix it. Keep an eye on your inbox or phone.
                </p>
              </div>
            )}

            <div className="restart">
              <button onClick={reset}>← Check another shop</button>
            </div>
          </div>
        )}
      </main>

      <footer className="foot">
        <div className="wrap">
          <p className="disc">
            NextChair checks how AI assistants respond to typical customer
            questions. Results vary between checks because AI answers aren't fixed —
            that's part of what we help you improve.
          </p>
          <p>© {new Date().getFullYear()} NextChair</p>
        </div>
      </footer>
    </div>
  );
}
