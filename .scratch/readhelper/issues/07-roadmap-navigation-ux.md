# 07 — roadmap and navigation UX

Type: prototype
Status: open
Blocked by: 04
Parent: ../map.md

## Question

What does the roadmap look like, and how do you move through it?

The DAG is the differentiator — this ticket decides whether it's visible value or just
plumbing.

Sub-questions:

- **The graph view.** Rendered graph, or a linearised list with dependency annotations?
  38-ish units with a dense citation graph is a lot of nodes; a hairball helps nobody.
  Does the view default to the current chapter's neighbourhood rather than the whole
  book?
- **Goal entry.** Kobil types "I want to understand consensus" — how does that resolve to
  a unit? Search over unit titles and objectives, or a model call? What if it matches
  several?
- **Path rendering.** Once a goal is picked, the path is a set of ordered prerequisites
  and the rest is off-path. Does off-path work disappear, grey out, or stay reachable?
- **Auditing an edge.** The no-drift constraint means every edge carries its source
  sentence and page. What's the affordance — hover, click, a panel? This is the feature
  that proves the graph isn't AI opinion, so it should be easy to reach and hard to miss.
- **Progress display.** Per-unit and per-objective state on the graph — done, in
  progress, objectives partially met.
- **The default action.** When Kobil opens the app with no goal in mind, what does it
  show him first?

Use `/prototype` — build the view rough against the real DDIA graph and react to it.
