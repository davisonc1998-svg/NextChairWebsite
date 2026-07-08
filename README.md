# NextChair — free AI visibility scan tool

A simple web tool for barbershops. A shop owner enters their shop name and town,
and it checks whether ChatGPT, Gemini, Claude and Perplexity recommend them when
someone asks for "the best barber near me". At the end it shows an honest
scorecard and invites them to leave their details so you can help them fix it.

## What's here

- `app/page.js` — the whole front page (form → loading → results → lead capture)
- `app/api/scan/route.js` — the scan engine: asks the four AI models real
  customer questions and checks if the shop is named
- `app/api/lead/route.js` — receives interested shops' contact details
- `app/globals.css` — the styling (barbershop blue + brass look)

## Keys it needs (set these in Vercel, never in the code)

Required for the scan to work:
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `GEMINI_API_KEY`
- `PERPLEXITY_API_KEY`

Optional, for getting leads emailed to you (set up later):
- `RESEND_API_KEY`, `LEAD_NOTIFY_EMAIL`, `LEAD_FROM_EMAIL`

The tool is built to be resilient: if one AI model's key is missing or its API
fails, the scan still runs with the others and shows that model as
"No response" rather than breaking.

## Deploying (we'll do this together step by step)

1. Push this folder to a GitHub repo.
2. In Vercel: New Project → import that repo.
3. Add the environment variables above under Project Settings → Environment
   Variables.
4. Deploy. Then connect the `nextchair.co.uk` domain in Vercel's Domains tab.

## Where leads go for now

Every lead is written to the Vercel function logs (`NEW_LEAD ...`) and, once
Resend is configured, emailed to you. The next upgrade is storing them in a
proper database (Supabase) so you have a running list.
