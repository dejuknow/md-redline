# Roadmap Ideas

## Agent Loop
- **One-click "send to agent"** — trigger an agent run directly from the app with open comments as instructions, then auto-reload when done
- **Comment status: `addressed`** — let agents mark comments as addressed (distinct from resolved), so the reviewer can approve/reject changes
- **Round tracking** — show which review round a comment was created in, making multi-pass reviews easier to follow

## Editing & Authoring
- **Inline markdown editor** — split-pane or toggle to edit the raw markdown without leaving the app
- **Suggested edits** — comments that propose specific replacement text (like GitHub's "suggestion" blocks), easy for agents to apply

## Organization
- **Comment labels/tags** — categorize feedback (content, structure, tone, formatting) with color-coded badges
- **Priority levels** — flag comments as critical vs. nice-to-have so agents can triage
- **Workspace/project files** — group related files into a review set with aggregate progress tracking

## Export & Sharing
- **Export review summary** — markdown or HTML report of all comments and statuses, shareable with collaborators
- **Copy all open comments** — one-click copy of open feedback as a prompt-ready block for pasting into an agent

## Intelligence
- **AI-assisted commenting** — suggest comments based on common spec issues (vague acceptance criteria, missing edge cases, etc.)
- **Duplicate detection** — flag when a new comment is similar to an existing one
- **Auto-categorize** — classify comments by type as they're created

## Quality of Life
- **Markdown TOC navigation** — jump to sections via heading outline in the sidebar
- **Minimap** — visual overview of the document with comment density indicators
- **Comment anchoring resilience** — improve fuzzy matching when agents make large structural edits
- **Collaborative mode** — multiple reviewers via WebSocket sync (bigger lift)

## Eval & Metrics
- **Agent leaderboard** — compare multiple agents/models on the eval suite over time
- **Regression tracking** — alert when an agent update degrades scores on specific fixture types
