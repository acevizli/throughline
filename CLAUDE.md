# throughline

Turns a technical PDF into a course: a prerequisite graph of concept-sized units, shown
beside the rendered page, with AI-graded free recall. Pilot book is *Designing
Data-Intensive Applications*.

## The constraint that outranks everything

**Never drift from the book.** The book is the source of knowledge; this is a guide over
it, not a replacement. Anything the system asserts must be traceable to a page — graph
edges carry the sentence that produced them, grading cites the page a missed point lives
on, and generated content never restates what the author already said.

## Issue tracker: GitHub

Issues live as GitHub issues on `acevizli/throughline`. Use the `gh` CLI. There is no
`.scratch/` tracker — that was migrated to GitHub and deleted; don't recreate it.

### Wayfinding operations

Used by `/wayfinder`.

- **Map**: issue **#1**, labelled `wayfinder:map`. Holds Destination / Notes /
  Decisions-so-far / Not-yet-specified / Out-of-scope.
- **Child ticket**: a native GitHub **sub-issue** of #1, labelled `wayfinder:<type>`
  (`research` / `prototype` / `grilling` / `task`).
  List them: `gh api repos/acevizli/throughline/issues/1/sub_issues`
- **Blocking**: native issue dependencies.
  Add: `gh api --method POST repos/acevizli/throughline/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`
  where the db id is `gh api repos/acevizli/throughline/issues/<n> --jq .id` — **not** the
  `#number`.
- **Frontier** — open, no open blockers, unassigned:

  ```bash
  gh api repos/acevizli/throughline/issues/1/sub_issues --jq '
    .[] | select(.state=="open")
        | select((.issue_dependencies_summary.blocked_by // 0) == 0)
        | select(.assignees | length == 0)
        | "#\(.number)  \(.title)"'
  ```

- **Claim**: `gh issue edit <n> --add-assignee @me` — the session's first write, before
  any work.
- **Resolve**: `gh issue comment <n>` with the answer, `gh issue close <n>`, then append a
  one-line gist + link to Decisions-so-far in #1.

### Execution override

This map carries execution, not just decisions. Prototype tickets leave working code
behind, not just a verdict.

## Stack

Next.js (App Router, TypeScript) · pdf.js for extraction *and* rendering · SQLite ·
Anthropic SDK. Nothing is scaffolded yet — prototypes install what they need.
