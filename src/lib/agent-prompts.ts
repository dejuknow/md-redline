export interface BuildAddressCommentsPromptOptions {
  filePaths: string[];
  commentCounts: Map<string, number>;
  enableResolve: boolean;
}

export function buildAddressCommentsPrompt({
  filePaths,
  commentCounts,
  enableResolve,
}: BuildAddressCommentsPromptOptions): string {
  if (filePaths.length === 0) return '';

  const afterAction = enableResolve
    ? 'After addressing a comment, resolve it by setting `"status":"resolved"` and `"resolved":true` in the marker JSON'
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
- \`anchor\`: the exact text the comment refers to
- \`text\`: my feedback - this is what I need you to address
- \`replies\`: threaded discussion - read for additional context

## Identifying yourself

Whenever you add a reply to a comment's \`replies\` array, set the \`"author"\` field to your own tool or model name (for example \`"Claude"\`, \`"Codex"\`, or \`"Gemini CLI"\`). Do not use a generic name like \`"Agent"\`.

## What to do

1. ${isSingle ? `Read ${filePaths[0]}` : 'For each file listed above,'} find all \`<!-- @comment{...} -->\` markers
2. For each comment, read the \`text\` field and address the feedback by editing the document
${
  enableResolve
    ? `3. For every comment you address, add a reply to the \`replies\` array summarising what you did or answering the question: \`"replies":[{"id":"<unique-id>","text":"your answer or description of the change","author":"<your tool name>","timestamp":"<ISO-8601>"}]\` (append to any existing replies). Do this whether the comment required a document edit or just an answer.
4. ${afterAction}
5. If a comment is unclear or you are unsure how to address it, leave the marker in place and ask me about it`
    : `3. ${afterAction}
4. If a comment is unclear or you are unsure how to address it, leave the marker in place and ask me about it`
}

## How to respond

After you are done, give me a brief summary:
- How many comments you addressed${isSingle ? '' : ' (grouped by file)'}
- For each one, a one-line description of what you ${enableResolve ? 'changed or replied' : 'changed'}
- Any comments you left in place and why`;
}
