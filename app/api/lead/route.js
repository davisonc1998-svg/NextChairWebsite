// NextChair — lead capture
// Receives a barber's contact details after they see their scan result.
// For the MVP this emails the lead to you via Resend (if configured) and
// always logs it. Storing in a real database (Supabase) is the next upgrade.

export const runtime = "nodejs";

function valid(body) {
  const name = (body.name || "").toString().slice(0, 120).trim();
  const contact = (body.contact || "").toString().slice(0, 200).trim();
  const shopName = (body.shopName || "").toString().slice(0, 120).trim();
  const town = (body.town || "").toString().slice(0, 120).trim();
  const scanSummary = (body.scanSummary || "").toString().slice(0, 500).trim();
  if (!name || !contact) return null;
  return { name, contact, shopName, town, scanSummary };
}

async function emailLead(lead) {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.LEAD_NOTIFY_EMAIL;
  if (!key || !to) return; // Not configured yet — skip silently.

  const from = process.env.LEAD_FROM_EMAIL || "onboarding@resend.dev";
  const html = `
    <h2>New NextChair lead</h2>
    <p><strong>Name:</strong> ${lead.name}</p>
    <p><strong>Contact:</strong> ${lead.contact}</p>
    <p><strong>Shop:</strong> ${lead.shopName || "(not given)"}</p>
    <p><strong>Town:</strong> ${lead.town || "(not given)"}</p>
    <p><strong>Scan result:</strong> ${lead.scanSummary || "(none)"}</p>
    <p style="color:#888">Received ${new Date().toLocaleString("en-GB")}</p>
  `;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        from,
        to,
        subject: `New lead: ${lead.shopName || lead.name}`,
        html,
      }),
    });
  } catch (e) {
    // Non-fatal: we still return success to the user so they aren't blocked.
    console.error("lead email failed", e);
  }
}

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  const lead = valid(body);
  if (!lead) {
    return Response.json(
      { error: "Please enter your name and a way to reach you." },
      { status: 400 }
    );
  }

  // Always log (visible in Vercel function logs).
  console.log("NEW_LEAD", JSON.stringify(lead));

  await emailLead(lead);

  return Response.json({ ok: true });
}
