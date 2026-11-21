# ADR-0079: A question that needs no research is answered directly, with an optional flow diagram

**Status:** Accepted · **Date:** 2026-11-21 · **Owner request:** "When I asked the agent to explain using a diagram, it returned an incorrect answer. Please investigate the root cause and fix it." — then: "If the agent determines that research is necessary, please route it to the research pipeline."

## Context

On 2026-11-21 the owner asked in Chat, after a research answer about 日東電工:
「バックグラインド、ダイシング、モールディングを図で説明してください。」
(run `run_7c1ae95a3bdc01f90a0a4409`, Sarashina 3.2 mini thinking). The run
searched the web three times, read five pages and published three verified
one-sentence definitions under the research template ("3 of 3 claim(s) are
supported…", "0 demand scenario(s), 0 supplier link(s) and 0 financial
observation(s) are on the canvas.", the investment disclaimer). No diagram
was drawn, and nothing said that one could not be.

Root cause: every Chat question became a `research` job, and the research
pipeline can only publish verified claims. The analysis prompt says "You
cannot write reports or free text", the model may only add tables and charts
over stored numeric datasets, and no component type can show a process.
A request to explain or illustrate a general concept has no output form in
that pipeline. The facts were right, but the answer was not what the owner
asked for.

## Decision

Both runners, held equal by the pipeline vectors (prompt version `research-v9`):

1. **The first planning round routes.** Only the first round, before
   anything was collected, carries `PLANNING_ROUTING_NOTE` and a
   `"needsResearch"` field in its Return line. The planner answers `false`,
   with no tool calls, only for an explanation, definition, comparison or
   illustration of general concepts, mechanisms or processes that an expert
   can answer from general knowledge alone. Anything about specific
   companies, products, markets, prices, statistics, recent events, dates,
   forecasts or investment decisions needs research. A missing field means
   research. A plan that asks for tools researches whatever it says. Later
   rounds and news tasks (`outputType: "news"`) never route. The choice
   costs no extra model turn on research questions.
2. **The direct answer is one turn** with its own prompt
   (`directAnswerPrompt`): it answers in the question's language, in plain
   text, states no figures, dates, company facts or recent developments, and
   cites nothing. When the owner asks for a diagram (図, 図解, フロー…) or the
   explanation is a sequence of stages, it also returns an ordered flow of 2
   to 10 stages (label at most 60 characters, detail at most 240, title at
   most 120). A reply in prose is taken as the answer. JSON without an answer
   fails the run as `DIRECT_ANSWER_INVALID`. A diagram with fewer than two
   usable stages is left out with a note, and one with more than ten keeps
   its first ten.
3. **It is published as unresearched.** The bundle has no evidence, claims
   or datasets, and `verificationStatus` is `unverified`. The pipeline, not
   the model, appends a fixed note to the answer in the question's language
   (Japanese when the question contains kana or kanji): 「この回答は調査を行わず、AI
   モデルの一般知識から書かれています。出典との照合は行っていません。投資助言ではありません。」.
   The job still walks planning → collecting → analyzing → verifying →
   publishing, so the Lean-verified transition matrix is unchanged.
4. **New component type `flow-diagram`** (schema version 1, no
   capabilities, no references): `title`, `steps` (`label`, `detail` or
   null) and `basis: "model-knowledge"`. The pipeline creates it as
   `<runId>_diagram`, so Chat shows it under the answer and the Notebook
   saves it like any other component. It is drawn top to bottom as an
   ordered list of numbered stage cards joined by arrows, and its caption
   always says that it was written by AI from general knowledge and not
   checked against sources. It is not model-authorable: a research run's
   display instructions still cannot create one.

## Consequences

- A conceptual question gets an explanation and a diagram in two model
  turns instead of a five-turn research run with web reads.
- The evidence-first rule now has one labelled exception: a direct answer is
  the model's own words. It is marked twice (the note in the answer, the
  caption under the diagram), carries no verification badge, and is never
  cited as evidence by a later run (earlier messages are context only).
- A misrouted question is answered without research. The routing note
  names what needs research, and a missing or unclear field defaults to
  research. If a direct answer is wrong for the question, asking again in
  research terms ("調べて") is the way back.
- Every planning, analysis and verification prompt vector was regenerated
  (`research-v9`): the routing note appears only on first rounds, so later
  rounds are byte-for-byte the `research-v8` planning prompts. The parity
  corpus gained hand-written direct-answer cases and generated
  `no-research` / direct-reply runs.
