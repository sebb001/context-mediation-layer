# Concepts and Limitations

A Context Mediation Layer (CML) models context as state transitions that can
be read, inspected, and changed through governed interfaces. Its purpose is
mutual legibility: giving humans and agents a shared surface on which
governing intent and operational reality can be reconciled, rather than
drifting apart in parallel transcripts.

This repository implements that layer as a pilot substrate. This document is
the deep dive: what the concepts mean, what the implementation actually
enforces, and where its honest limits are.

## Coordination objects

- **Intent:** a requested outcome, mandate, or goal.
- **Interpretation:** a given actor's current best understanding of an intent.
- **Action:** an attributable record of a step taken by an actor.
- **Claim:** a temporary ownership or active-work signal.
- **Report:** a reference or decision artefact produced in the course of the
  work.
- **Contract:** a typed record of behavioural authority — active, proposed, or
  superseded.
- **Actor:** the accountable identity behind a contribution.
- **Session:** the execution context that produced a trace.
- **Event:** the recorded transition trail.
- **Domain:** an addressable namespace used to organise work.
- **Role and actor type:** participation envelopes an actor can assume.

## Authority is typed, not assumed

Most coordination failures begin when identity, mandate, execution context,
and rule are silently conflated. CML keeps them distinct because each answers
a different governance question:

| Concept | Question it answers |
| --- | --- |
| Actor | Who is accountable for this contribution? |
| Role | What posture or mandate can be assumed? |
| Binding | On which surface may this actor assume that role? |
| Session | Which execution context produced this trace? |
| Contract | Which active rule governs the behaviour? |

A role is not an identity. A session is not an actor. A file called
`CONTRACT.md` is not an active contract: contract truth lives in the registry,
and editing a copied contract body changes nothing until a new registry
revision supersedes the old one.

Files, docs, vault notes, issues, and logs can be evidence, but they are not
CML records unless a coordination object points to them.

**Status: SUPPORTED inside an adopted workflow.** This repo can be the
source-of-record for a pilot corridor. It is not an organisation-wide source
of truth by default; it becomes operational authority only where a team
explicitly agrees to gate the relevant work through it.

## The promotion gate

The governing invariant:

> Stable actors own accountability. Sessions are execution context. Only
> promoted outputs become durable coordination state.

A transcript can be evidence. A session can produce good work. A model can
draft an interpretation. None of it becomes canonical merely by existing —
material becomes durable state only when promoted with attribution,
provenance, and a relevant mandate.

The gate exists because generation is cheap and format is persuasive. A
polished artefact can carry the appearance of an agreed position without any
deliberation having produced it. The system deliberately refuses to let
production quality confer authority that only mandate and review can grant.

## Divergence is first-class state

Incompatible interpretations are recorded side by side with their provenance.
Corrections supersede rather than overwrite, so the record shows not only what
was decided, but what was believed before, by whom, and why it changed.
Absence of awareness is recorded as a state of its own — operationally
different from disagreement.

## Legibility pattern

**Status: METHOD, with partial schema support.**

For substantive mediation, actors separate:

- **Observed:** what was directly found in CML or cited evidence.
- **Inferred:** what follows from observed state.
- **Unresolved:** what remains uncertain, contradictory, or unauthorised.
- **Proposed:** the next best reversible action or recommendation.

The schema supports this indirectly — interpretations, alignment, status
progression, claims, reports, source references, events, resolution notes —
but the code does not semantically classify content into these buckets.
Missing context stays visible only when actors enter it into the record
surface, or a surrounding workflow requires them to.

The layer does not produce organisational coherence by itself, and it does not
absolve actors of their obligation to engage with existing context, classify
missing context, and manage their own downstream actions within an agreed
workflow.

## Claim language

Repository claims fall into four categories, and the wording should match:

- **IMPLEMENTED** — enforced or computed by current code. Say "enforces" only
  here: selected service validations, supersession transitions, gateway tool
  allowlists, OAuth token checks, path-scoped vault writes.
- **SUPPORTED** — represented by schema and service calls but dependent on
  actor discipline or integration choices. Say "records", "supports", or
  "makes inspectable when used".
- **METHOD** — an operating practice or writing convention, reliable only when
  a workflow requires it.
- **FUTURE** — not provided by this repo.

Avoid "proves", "guarantees", "fully", "automatic", and "source of truth"
unless the sentence names the exact boundary. The repo supports mediation and
inspection; it cannot guarantee coherence.

## Maturity

This is v0.0.1 pilot software: good enough for local evaluation and bounded
pilot investigation, not production operation.

**Works today:** typed records for all coordination objects; SQLite
persistence behind a service layer; service-level validations for selected
actor, contract, status, and supersession rules; CLI, MCP (stdio, HTTP, public
gateway), SDK, and operator-UI adapters; OAuth/OIDC verification with actor
mapping and path-scoped vault writes; event audit trail; tests at the
component boundaries.

**Deliberately thin:** the UI is an operator surface, not a product console;
orchestration is thin composition, not an autonomous platform; vault and
knowledge access are seams, not a content platform; the pilot OAuth issuer is
for controlled pilots, not durable identity; SQLite is a local evaluation
store, not a production storage strategy.

**Not implemented:** automated classification of missing context or
observed/inferred buckets; migration framework and schema versioning;
multi-tenant separation; production backup, retention, and deletion
workflows; compliance-grade audit export; formal security review.

**Production would require:** a migration framework, a durable persistence and
identity strategy, backup/restore/retention workflows, security review of the
MCP and OAuth surfaces, monitoring and incident response, and tenant
separation. Until then, the repo is not acceptable for production customer
data, regulated production workflows, or autonomous writes into production
systems.

## Evidence status

The evidence pack is operational self-evidence from the author's own lab. It
is useful because it shows the grammar carrying weight in one live environment
under pressure. It is not third-party validation: the same person was
theorist, operator, and primary evaluator, and the evidence is n=1.

It does not prove buyer value, transferability to another team or regulated
environment, or that a buyer should build on this repo rather than a fresh
lightweight implementation. The honest claim is not "this has been
validated"; it is "this has run once in the author's own lab, with real
pressure and real evidence boundaries, and now needs a bounded independent
test."

## Pilot boundary

A pilot tests one thing: whether the grammar and record surface create
practical coherence for an independent team in a bounded corridor. It is not a
proof of production readiness or buyer value before the evidence exists.

The shape is **one corridor, one daily habit, one close-out**: one bounded
coordination problem (not a company rollout); one repeated record-writing
practice (not continuous surveillance or broad process redesign); and a
written close-out — what improved, what did not, what stays unresolved, what
data is deleted or retained, and whether the next step is stop, continue, or
rebuild differently.

Default posture: synthetic or sanitised data only; no production customer
data, regulated workflows, or autonomous downstream writes; no employee-wide
exposure before compliance/legal review. Name readers, writers,
administrators, and export/deletion approvers before anyone else touches the
system. If the public MCP gateway is used, start read-only and allowlist only
the tools the corridor needs. Set retention before the pilot starts and keep
it short; deletion must cover database and WAL/SHM files, vault folders, OAuth
stores, logs, and exports.

Do not migrate an existing source of truth or broaden adoption until an
independent team has used the grammar and reported concrete value, and the
identity, persistence, backup, and security items above are settled.
