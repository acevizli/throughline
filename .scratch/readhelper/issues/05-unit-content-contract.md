# 05 — unit content contract

Type: prototype
Status: open
Blocked by: 03
Parent: ../map.md

## Question

What is actually inside a generated unit — the thing Kobil will live in every study
session?

Working shape from the grilling, to be confirmed or torn up:

```
UNIT 04 — Encoding & Evolution
Read: pp. 111–128

Objectives
  1. Explain why schema evolution needs both backward and forward compatibility
  2. Compare Thrift / Protobuf / Avro on schema-change tolerance

Before you read
  Kleppmann assumes you know JSON is self-describing. The whole chapter is
  about what you lose without a schema.

After you read — can you answer?
  • Why does Avro need a writer's schema AND a reader's schema?
```

Open sub-questions:

- **How many objectives** per unit — a fixed count, or however many the material has?
  Fixed counts make progress legible; free counts stay honest to the content.
- **What is the primer for?** Naming assumed prior knowledge, flagging what to watch for,
  or framing why the chapter exists? It must not explain the content — that's the book's
  job, and explaining it here is exactly the drift we ruled out.
- **Recall questions**: how many, and are they 1:1 with objectives or independent? 1:1
  makes grading (ticket 06) tractable.
- What does a unit show about its **place in the graph** — prerequisites, what it unlocks?
- Does the unit ever quote the book, or only point at pages?

**Method**: generate one real unit — DDIA Ch.4, Encoding & Evolution, printed pp. 111–128
— from the actual page text, and react to it. Iterate on that one unit until it's the
thing worth having, then freeze the contract.

**Leaves working code**: the generation call and its output schema.
