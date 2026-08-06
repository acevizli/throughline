# throughline

Turns a technical PDF into a course: a linear roadmap of concept-sized units, shown beside
the rendered page, each with a primer, objectives, and page-anchored multiple choice marked
mechanically. Pilot book is *Designing Data-Intensive Applications*.

Two things this used to say and no longer does, because both were charted and then dropped
on evidence — don't reintroduce either without reopening the map. The **prerequisite graph**
became a linear roadmap plus a per-unit "leans on" panel: 84% of DDIA's citations point
backward and every chapter's prerequisites are earlier chapters, so the transitive closure
was the table of contents with extra steps. **AI-graded free recall** became model-authored
multiple choice, marked by set comparison; no model call grades anything.

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
Claude Agent SDK, with the Anthropic SDK behind a switch.

Every model call goes through `ask()` in `src/model/ask.ts` — one shape, written once in
zod, handed to whichever backend `THROUGHLINE_BACKEND` selects. Don't call either SDK
directly from a call site. The agent backend runs with no built-in tools, no MCP servers
but its own, and no inherited settings; that isolation is the no-drift rule enforced
mechanically, so treat `src/model/agent.ts`'s options as load-bearing rather than tidy.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
