# OneDoor MVP

A runnable first read-only slice of the enterprise chatbot plan: one chat UI, an entitlement-filtered manifest registry, a policy-enforcing gateway, and a Finance connector over HTTP.

**This is a local reference implementation, not a production Azure deployment.** It uses synthetic selectable customer identities and sample records. It does not implement Entra authentication or OBO. No Azure resources were provisioned.

## Run

Requires Node.js 22 or newer. No dependencies, downloads, build step, or API key are needed for the default mode.

```sh
node server.mjs
```

Open **http://127.0.0.1:4321** and select a demo account. The chat server binds to loopback only. The gateway and connector use separate, randomly assigned loopback HTTP ports in the same development process.

If the port is already in use:

```sh
PORT=4322 node server.mjs
```

Stop with Ctrl+C. Conversations and session credentials are intentionally held in memory and disappear on restart. Redacted operational events are written to `.local/audit.jsonl`; this local file is size-limited and is **not** tamper-evident production audit storage.

## Try it

| Demo account | Available data |
| --- | --- |
| Acme Industrial / Avery Morgan | Four invoices, an outstanding balance of $18,880, and Net 30 terms. |
| Northstar Studio / Jordan Lee | A different invoice set, a balance of $2,800, and Net 15 terms. |
| Cobalt Labs / Sam Rivera | No Finance entitlement; the catalog is empty and direct Finance calls are denied. |

Example requests:

- `What is my outstanding balance?`
- `Was INV-1042 paid?`
- `When is it due?` after a successful specific invoice lookup.
- `Show my overdue invoices`
- `Show invoices from last month`
- `What are our payment terms?`
- `Refund invoice INV-1042` to see the read-only boundary.
- Look up `INV-2088` as Acme to see a non-disclosing, cross-account rejection.

All records use the **2026-11-18** synthetic snapshot. Amounts are illustrative USD values, not live financial information. Switching accounts ends the previous session and clears its conversations.

## What is implemented

- Responsive web chat with streamed application events, follow-up suggestions, conversation history, cancellation, accessible controls, generic result cards, and source inspection.
- Three narrow read-only tools: `finance_account_summary`, `finance_invoice_search`, and `finance_payment_terms`.
- Server-side account mapping and re-authorization in both the gateway and Finance connector.
- Short-lived, separately signed, audience-bound **demo** service tokens. These are not OAuth/OIDC tokens. Tokens cannot be passed through from the gateway audience to the connector audience; session revocation invalidates issued tokens.
- A strict manifest schema, separate platform allowlist, deterministic registry digest, and canonical SHA-256 tool-definition pins. The model only sees tools after their live definitions pass pin and scope checks.
- A small MCP `2026-07-28` tools profile: `server/discover`, `tools/list`, `tools/call`, request metadata, method/name header checks, schema-validated structured results, and a client that accepts JSON or request-scoped SSE results.
- Per-connector deadlines, concurrency limits, circuit breakers, explicit partial failures, bounded response sizes, and no automatic retries.
- Per-session conversation limits, bounded context, CSRF/origin/Host protections, escaped text rendering, and a restrictive browser content-security policy.
- User/filter-bound expiring pagination cursors and pseudonymous audit records without prompts, tokens, or business payloads.

The local launcher runs the components in one process for convenience. Real HTTP and token boundaries are exercised, but process isolation is **not** a production security boundary here.

## Optional Azure OpenAI tool selection

By default, **the preview is deterministic and does not call an LLM**. The Finance demo planner is a connector-owned fixture driver. It supports the examples above, not arbitrary natural-language analysis.

An opt-in REST adapter uses Azure OpenAI to select from the reviewed tool catalog. It does not generate financial facts: the UI renders the connector's validated summaries and structured records. Text-only model responses become a clarification rather than unverified account claims.

Copy `.env.example` to a local ignored `.env` file, set `MODEL_PROVIDER=azure`, and configure:

```text
AZURE_OPENAI_ENDPOINT=https://YOUR-RESOURCE.openai.azure.com/
AZURE_OPENAI_DEPLOYMENT=YOUR-APPROVED-CHAT-DEPLOYMENT
AZURE_OPENAI_API_KEY=YOUR-KEY
```

Then run:

```sh
node --env-file=.env server.mjs
```

Use a deployment supporting the v1 Chat Completions API and function tools. The adapter uses `POST /openai/v1/chat/completions`, disables stored completions, limits completion output, and permits at most two tool calls per turn. Configuration, HTTP, timeout, malformed-output, and unauthorized-tool failures are explicit; the app never silently falls back to demo mode.

**Enabling this sends questions and bounded prior lookup arguments to the configured Azure deployment.** Do not enter sensitive data in this reference app. Authentication and Finance records remain synthetic even when the Azure model is enabled.

The Azure adapter is exercised using mocked HTTP responses. A live Azure deployment, credentials, regional data policies, and customer authentication have not been verified.

## Registry and connector changes

The source of customer-visible capabilities is `registry/connectors/finance.json`. The separate `registry/platform-policy.json` defines the maximum allowed audience, scopes, and read-only tools. The manifest cannot increase its own privileges.

Run the drift check:

```sh
node scripts/pin-registry.mjs
```

After explicitly reviewing a change to the Finance tool definitions, update the pins:

```sh
node scripts/pin-registry.mjs --write
```

Startup never auto-approves changed definitions. Pin checks also run against the live connector before catalog exposure and before each call. Restart the application to activate reviewed manifest changes; atomic hot reload and signed release promotion are not part of this MVP.

`lib/schema.mjs` implements a documented, bounded subset of JSON Schema: explicit scalar/object/array types, nullable type arrays, properties/required/additionalProperties, enum, string patterns/lengths, numeric ranges, and array size limits. It rejects unsupported keywords, including remote references. This is not a general JSON Schema engine.

Runtime endpoint bindings are supplied by the local launcher. Only explicit loopback `/mcp` bindings are accepted. The generic gateway and result renderer are registry-driven; automatic onboarding of arbitrary remote BUs and OpenAPI import are future work. The offline Finance planner is intentionally not a universal routing engine.

## Validation

```sh
node --test
```

Tests cover real HTTP chat/gateway/connector flows, two-account isolation, unauthorized accounts, session/CSRF checks, delegated audience rejection, logout revocation, schema/policy checks, drift quarantine, cursor ownership/expiry, deadlines/breakers, registry-driven capabilities, SSE parsing, and bounded Azure tool selection.

These are local acceptance checks, not evidence that the production plan's quality, scale, compliance, availability, or recovery gates have been met.

## Layout

```text
public/                 Web UI, no external assets or libraries
lib/app.mjs             Loopback launcher, chat/session APIs, SSE, volatile conversation state
lib/chat.mjs            Eligibility routing and bounded tool execution
lib/model.mjs           Optional Azure OpenAI REST tool planner
lib/identity.mjs        Explicitly demo-only identity and audience-scoped service tokens
lib/gateway.mjs         Policy, catalog pinning, mediation, deadlines, and circuit breakers
lib/mcp.mjs             Limited modern MCP tools transport
lib/registry.mjs        Validated immutable registry snapshot
lib/schema.mjs          Fail-closed schema subset and generic result contract
connectors/             Finance tools, synthetic data, and offline demo planner
registry/              Connector schema, manifest, and independent platform policy
test/                  Node built-in test suite
```

## Before a real customer pilot

Implement and verify Entra External ID sign-in and proper delegated OBO with the actual tenant/API topology; replace the synthetic data source with an approved BU API. Replace in-process demo trust, memory stores, and local audit files with the approved production boundaries and durable stores. Add signed registry releases, controlled promotion/revocation, complete protocol interoperability testing, and infrastructure/deployment automation.

Select the pilot BU, runtime ownership, Azure regions/model, data retention/residency policies, operational handoff, and numeric quality/capacity/recovery gates. Run the production plan's security, accessibility, model-quality, resilience, and operational acceptance work before exposing customer traffic.

Writes, refunds, OpenAPI generation, legacy MCP negotiation, MCP Tasks/MRTR, A2A agents, live support handoff, and multi-region deployment are deliberately outside this first slice.
