export interface BuildAddressCommentsPromptOptions {
  filePaths: string[];
  commentCounts: Map<string, number>;
  enableResolve: boolean;
  commentIds?: string[];
}

export function buildAddressCommentsPrompt({
  filePaths,
  commentCounts,
  enableResolve,
  commentIds,
}: BuildAddressCommentsPromptOptions): string {
  if (filePaths.length === 0) return '';

  const scopeInstruction = commentIds
    ? `Address ONLY the comments with the following IDs: ${commentIds.map((id) => `\`${id}\``).join(', ')}. Leave any other comment markers in the file untouched.`
    : null;

  const afterAction = enableResolve
    ? 'After addressing a comment that required a document edit, resolve it by setting `"status":"resolved"` and `"resolved":true` in the marker JSON. If a comment only needed a reply (e.g. answering a question), leave it open.'
    : 'After addressing a comment, remove the entire `<!-- @comment{...} -->` marker from the file';

  const isSingle = filePaths.length === 1;
  const fileRef = isSingle ? filePaths[0] : 'the files listed below';
  const fileList = isSingle
    ? ''
    : '\n\n## Files to review\n' +
      filePaths
        .map((path, index) => {
          const count = commentCounts.get(path) ?? 0;
          return `${index + 1}. ${path} (${count} comment${count !== 1 ? 's' : ''})`;
        })
        .join('\n');

  return `I've left review comments in ${fileRef} using inline comment markers. Please read ${isSingle ? 'the file' : 'each file'} and address them.${fileList}

## Comment format

Comments are embedded as HTML comment markers: \`<!-- @comment{JSON} -->\`
Each marker is placed immediately before the text it refers to (the "anchor").
The JSON contains these fields:
- \`anchor\`: the exact text the comment refers to, and the key md-redline uses to find it (see "Keeping anchors valid" below)
- \`text\`: my feedback - this is what I need you to address
- \`replies\`: threaded discussion - read for additional context
- \`contextBefore\` / \`contextAfter\`: optional snippets of the text surrounding the anchor when I wrote the comment, used to disambiguate repeated text

## Keeping anchors valid

The \`anchor\` field is how md-redline locates a comment in the document. It is not a description, it is a lookup key: if the exact text stops existing, the comment detaches from the document and I lose the thread of what it was about.

So whenever an edit rewrites, restructures, or moves the text a marker points at, update that marker's \`anchor\` in the same edit so it quotes the new text that replaced it. This applies to comments you resolve as well as ones you leave open. Never leave an \`anchor\` pointing at text that is no longer in the file.

When you change an \`anchor\`, **delete** that marker's \`contextBefore\` and \`contextAfter\` rather than trying to rewrite them. Both fields are optional. They describe where the OLD anchor sat, so leaving them is actively wrong: md-redline weighs a context match above the marker's own position, and stale context will pull the highlight onto the wrong copy of repeated text. Removing them lets it fall back to the marker position, which is correct by construction.

If the anchored text is deleted outright with nothing replacing it, say so in your reply rather than re-pointing the anchor at unrelated text.

## Identifying yourself

Whenever you add a reply to a comment's \`replies\` array, set the \`"author"\` field to your own tool or model name (for example \`"Claude"\`, \`"Codex"\`, or \`"Gemini CLI"\`). Do not use a generic name like \`"Agent"\`.

## Important: edit the original files

You MUST edit the files at the exact paths listed above. Do NOT copy them to a different location, do NOT create new files. If you cannot access a file at its given path (e.g. workspace restrictions), stop and tell me immediately instead of working around it.

## What to do
${scopeInstruction ? `\n${scopeInstruction}\n` : ''}
1. ${isSingle ? `Read ${filePaths[0]}` : 'For each file listed above,'} ${commentIds ? 'find the `<!-- @comment{...} -->` markers with the IDs listed above' : 'find all `<!-- @comment{...} -->` markers'}
2. For each comment, read the \`text\` field and address the feedback by editing the document or answering the question
${
  enableResolve
    ? `3. For every comment you address, add a reply to the \`replies\` array: \`"replies":[{"id":"<unique-id>","text":"your answer or description of the change","author":"<your tool name>"}]\` (append to any existing replies). Do NOT include a \`timestamp\` field in your reply; md-redline will fill it in automatically when it reads your edit.
4. ${afterAction}
5. If a comment is unclear or you are unsure how to address it, leave the marker in place and ask me about it`
    : `3. ${afterAction}
4. If a comment is unclear or you are unsure how to address it, leave the marker in place and ask me about it`
}

## Asking me a question

If a comment is ambiguous, or you encounter a planning fork while editing where the right answer would meaningfully change your edit, you may call the \`mdr_ask\` tool to post one or more anchored questions to me. Pass the \`sessionId\` from this review and the file path, the exact text to anchor against, and your question. The tool blocks until I have replied to every question. Prefer asking over guessing when the answer matters.

## How to respond

After you are done, give me a brief summary:
- How many comments you addressed${isSingle ? '' : ' (grouped by file)'}
- For each one, whether you resolved it (document edit) or left it open (question/discussion)${enableResolve ? '' : ' or removed the marker'}
- Any comments you left in place and why`;
}
