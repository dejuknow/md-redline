# HTML comment forms

Every section holds an HTML comment in a different position or shape. Open it in the rendered view
with **Render HTML comments** on, then off, and compare each section with what it says to expect.

A rendered comment is a muted mono span. The `<!--` and `-->` delimiters are CSS chrome, so
selecting one gives you only the body, and the body is emitted verbatim.

---

## 1 · Block level, on its own line

<!-- This is a block-level comment. It sits between two paragraphs and should render on a line of its own. -->

That was one. This paragraph follows it.

## 2 · Inline, mid-sentence

The interesting case is a comment that interrupts a sentence, <!-- an inline note, mid-sentence --> because
it has to render inline without breaking the paragraph's flow.

## 3 · Inside a code span

`<!-- @comment{"id":"…","anchor":"…"} -->` should be one visible code span, and so should `<!-- plain -->`.
Both are code, so both render the same with comments on or off.

## 4 · Inside a fenced code block (untouched)

```html
<p>Some markup</p>
<!-- a comment inside a fenced code block -->
```

## 5 · Multi-line, preformatted

Renders as a block with the delimiters on their own lines, the indent on line three kept, and no
stray indent on line one or blank line at the foot.

<!--
A comment spanning several lines.
The second line.
    An indented third line, to check that leading whitespace is emitted verbatim.
-->

ASCII shapes only work if the column alignment holds:

<!--
  client ──► server ──► store
     ▲                    │
     └────── ack ◄────────┘
-->

## 6 · Ligatures

`-->`, `<!--`, `=>` and `!=` must not merge into single glyphs, here or in the raw view.

<!-- arrows -> => <= != in a body, which should stay separate characters -->

## 7 · Shipped directives, all hidden

One from each tool in Settings, plus the other forms a tool writes. None of these should be
visible.

<!-- prettier-ignore -->
<!--lint disable no-duplicate-headings-->
<!-- markdownlint-disable MD013 -->
<!-- markdownlint-disable-next-line MD033 -->
<!-- deno-fmt-ignore -->
<!-- textlint-disable -->
<!-- alex ignore -->
<!-- vale off -->
<!-- vale Microsoft.Contractions = NO -->
<!-- cSpell:ignore mdr rehype -->
<!-- cspell:words redline -->
<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->
<!-- END doctoc generated TOC please keep comment here to allow auto update -->
<!-- TOC -->
<!-- /TOC -->
<!-- markdown-link-check-disable-next-line -->
<!-- truncate -->
<!-- ALL-CONTRIBUTORS-LIST:START - Do not remove or modify this section -->

### A heading ending in a Markdown All in One marker <!-- omit from toc -->

The second line has no space after `<!--`. The match runs after `trimStart`, so one entry covers
both forms.

## 8 · A note that mentions a directive renders

<!-- We use prettier-ignore on the table below because the alignment is hand-tuned. -->

## 9 · The short prefixes

`more`, `toc` and `tocstop` are hidden by default. Both of these directives are hidden:

<!-- more -->
<!-- toc -->

A genuine note that opens with the same lowercase word is hidden too. That is the cost of shipping
the short prefixes, and unticking the tool in Settings is how a reader resolves it:

<!-- more thought needed on the caching strategy here -->
<!-- toc generation was disabled deliberately, see the build script -->

A prefix matches only as a whole word, so these two render:

<!-- moreover, this paragraph was rewritten after review -->
<!-- tocopherol is vitamin E, a note from the nutrition doc -->

Matching is case-sensitive, because directives are lowercase or fixed-case and a note starts with a
capital. So this one renders:

<!-- More thought needed on the caching strategy. -->

## 10 · A malformed marker stays hidden

<!-- @comment-malformed this is not valid marker JSON and should not appear -->

## 11 · Inside other containers

- Second item, with a comment after it. <!-- a comment inside a list item -->

> A quoted line. <!-- a comment inside a blockquote -->

| Column | Value |
| --- | --- |
| First | one <!-- a comment inside a table cell --> |

<!-- a comment directly above a heading -->

### A heading preceded by a comment

## 12 · Content that looks like it could break the parser

<!-- A comment containing **markdown**, a `code span`, and a [link](https://example.com), all of which should render as literal text. -->

<!-- A comment containing an angle bracket < and an ampersand & and a stray dash - here. -->

<!---->

That last one was empty, so it stays hidden: an empty comment is never a note. CommonMark uses one to
separate two lists:

- first list

<!-- -->

- second list, with nothing visible between it and the first

## 13 · Settings: toggle, hidden tools, your own words

Open Settings, then:

1. Turn **Render HTML comments** off. Every comment in sections 1–12 disappears.
2. Turn it back on. Open **Keep hidden** and untick **Vale**. Both of its lines in section 7 appear.
3. Add `TODO` to **Your own**. This line vanishes:

<!-- TODO: wire the retry budget into the config -->

4. Reload the page. The state from steps 2 and 3 persists.

## 14 · Commenting on a comment

Select the body below and comment on it. The marker lands on the line above this block, not inside
it, and the document does not visibly break.

<!-- Select this text and comment on it. The marker should land above this block, and the anchor should stay byte-identical. -->

Do the same across a line break inside the first section 5 block. The selection includes the real
newlines, so it anchors.
