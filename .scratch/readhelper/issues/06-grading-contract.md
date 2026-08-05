# 06 — grading contract

Type: grilling
Status: open
Blocked by: 05
Parent: ../map.md

## Question

Free recall is AI-graded against the objective **and** the source pages. What is the
rubric, and what does a grade actually *do*?

Sub-questions:

- **Verdict shape.** Binary met/unmet, or three-state (met / partial / missed)? The
  mockup Kobil picked showed `✓ got: … ✗ missed: … → objective 2: partial`, so partial
  credit is in — but does partial count as done for progress purposes?
- **Grounding.** The grader sees the source pages, so it can cite where the missed point
  lives (`see p.124`). Is citing the page mandatory for every miss? That's the
  no-drift constraint applied to grading: a grader that says you're wrong without
  pointing at a page is asserting something the book didn't.
- **False negatives.** A right answer in different words must not be marked wrong. Can
  Kobil contest a grade, and does contesting change the stored state?
- **Consequence.** What does a failed objective do — reopen the unit, mark just that
  objective unmet, gate downstream units in the DAG, or nothing but a record? Gating is
  the strongest and the most annoying; a record is the weakest and may be pointless.
- **Retry.** Same question again, or a fresh one? Same question rewards remembering the
  answer rather than the idea.
- Where does the graded transcript live, and is it ever shown back later?

Use `/grilling`. This is a pedagogy decision, not a technical one.
