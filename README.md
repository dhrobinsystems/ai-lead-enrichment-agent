# AI-Powered Lead Enrichment & Qualification Agent

> A Node.js service and an n8n workflow that take a company domain, pull firmographics from **Apollo**, have an LLM score the company against your Ideal Customer Profile (ICP) and write a short outreach opener, then create or update the company in **HubSpot**.

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![n8n](https://img.shields.io/badge/built%20for-n8n-ff6d5a)
![Node](https://img.shields.io/badge/node-%3E%3D18-green)

---

## What It Does

1. **Webhook intake.** Accepts a domain, URL or email address (`acme.com`, `https://www.acme.com/pricing`, `jane@acme.com`), normalizes it to `acme.com` and rejects anything that isn't a valid domain. Callers must send a shared secret.
2. **Firmographics.** Looks the domain up in Apollo's Organization Enrichment API for name, industry, headcount, revenue range, description, keywords and tech stack.
3. **ICP scoring.** Sends that data and your ICP description to OpenAI or Anthropic. The model returns a 0–100 score, a 2-sentence outreach hook and its reasoning. The output is validated: the score is clamped and rounded, and the tier is derived from the score.
4. **HubSpot upsert.** Searches HubSpot for a company with the same domain. If one exists it is updated; otherwise a new company is created. No duplicates.

**Where the numbers come from:** headcount and revenue come only from Apollo. The LLM never supplies them. If Apollo has no data, those fields stay empty in HubSpot instead of being filled with guesses.

**Fit tiers:** 80–100 → Tier 1 · 60–79 → Tier 2 · 40–59 → Tier 3 · 0–39 → Disqualified.

---

## Repository Structure

```text
ai-lead-enrichment-agent/
├── workflows/
│   └── n8n-ai-enrichment-workflow.json   # Importable n8n workflow
├── src/
│   ├── agent-enrichment.js               # Enrichment, scoring, HubSpot upsert
│   └── server.js                         # Express webhook server
├── scripts/
│   └── create-hubspot-properties.js      # One-time HubSpot property setup
├── tests/
│   ├── agent.test.js                     # Domain parsing, scoring, Apollo/LLM/HubSpot logic
│   ├── server.test.js                    # Auth, validation, error handling
│   └── workflow.test.js                  # n8n workflow structure and code nodes
├── .env.example                          # Environment variable template
├── .gitignore
├── package.json
└── LICENSE
```

---

## Setup (Node.js service)

Requires Node.js 18 or later.

```bash
npm install
cp .env.example .env
```

Then edit `.env`:

| Variable | Required | Notes |
|---|---|---|
| `WEBHOOK_SECRET` | Yes | At least 16 random characters. The server won't start without it. |
| `AGENT_DRY_RUN` | — | Defaults to on. Only the exact value `false` enables writes to HubSpot. |
| `LLM_PROVIDER` | — | `openai` (default) or `anthropic` |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | Yes, for real scoring | Without a key, results are marked `simulated` and are never written to HubSpot. |
| `ICP_DESCRIPTION` | Recommended | Describe your ideal customer in plain English. |
| `APOLLO_API_KEY` | Recommended | Without it, scoring is based on the domain alone. |
| `HUBSPOT_ACCESS_TOKEN` | For live sync | HubSpot private app token (see below). |
| `PORT` | — | Defaults to 3000 (n8n uses 5678). |

### HubSpot setup

1. In HubSpot, go to **Settings → Integrations → Private Apps** and create an app with these scopes: `crm.objects.companies.read`, `crm.objects.companies.write`, `crm.schemas.companies.write`.
2. Put the token in `HUBSPOT_ACCESS_TOKEN`.
3. Create the custom company properties (run once):

   ```bash
   npm run setup:hubspot
   ```

   This creates `icp_score`, `fit_tier`, `estimated_revenue`, `personalization_hook`, `enrichment_reasoning` and `enriched_at`. Headcount goes into HubSpot's built-in `numberofemployees` property.

### Run

```bash
npm test                      # 50 tests, no network calls
npm run demo -- acme.com      # one-off enrichment from the command line
npm start                     # start the webhook server
```

```bash
curl -X POST http://localhost:3000/webhook/enrich \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: $WEBHOOK_SECRET" \
  -d '{"domain": "acme.com"}'
```

Responses:

| Status | Meaning |
|---|---|
| `200` | `{ success, enrichment, sync }`. `sync.status` is `dry_run`, `success` (`created` / `updated`) or `skipped` (simulated result). |
| `400` | Missing or invalid domain, or malformed JSON |
| `401` | Missing or wrong secret |
| `502` | Apollo, LLM or HubSpot call failed. Details are logged on the server, not returned to the caller. |

`GET /health` reports whether dry-run is on.

---

## Setup (n8n workflow)

1. In n8n, go to **Workflows → Import from File** and choose `workflows/n8n-ai-enrichment-workflow.json`.
2. Attach a credential to each of these nodes:
   - **Webhook Inbound**: a *Header Auth* credential, e.g. name `x-webhook-secret` with a long random value. Callers must send that header.
   - **Apollo Firmographics**: a *Header Auth* credential with name `x-api-key` and your Apollo API key as the value.
   - **OpenAI ICP Evaluation**: an *OpenAI* credential.
   - **HubSpot Find / Update / Create Company**: a *HubSpot App Token* credential (your private app token).
3. Run `npm run setup:hubspot` once, or create the custom properties listed above by hand.
4. Open the **Config & Validate** node and set `ICP_DESCRIPTION`. Leave `DRY_RUN = true` while testing: the webhook then returns the payload it *would* write. Change it to `false` when you're ready to write to HubSpot.
5. Activate the workflow and POST `{"domain": "acme.com"}` to `/webhook/enrich-lead`.

How the workflow runs: invalid domain → `400`. An Apollo error doesn't stop the run; scoring continues without firmographics. With dry-run on, the webhook returns the preview. With dry-run off, the workflow searches HubSpot by domain, then updates the matching company or creates a new one.

---

## Safety & Responsibilities
- **Liability:** dhrobinsystems is not responsible for anything.
- **Dry-run is on by default** in both the Node service and the n8n workflow. Test against a HubSpot sandbox or test portal before turning it off.
- **The webhook requires authentication**, so outsiders can't spend your API credits. If you expose it to the internet, add rate limiting at your proxy or gateway as well.
- **Costs:** every enrichment makes one Apollo call (uses credits) and one LLM call. You are responsible for your own API usage, rate limits and costs.
- **Outreach compliance:** AI-generated hooks should be reviewed before use. Cold outreach must comply with the laws that apply to you (e.g. GDPR, CAN-SPAM, CASL).
- The software is provided "as is", without warranty. See [LICENSE](LICENSE).

## License

Distributed under the MIT License. See [LICENSE](LICENSE) for details.

Built by DH Robin Systems.
