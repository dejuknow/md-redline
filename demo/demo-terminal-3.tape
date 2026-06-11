# demo-terminal-3.tape — Flow-2 scene 1: user asks the agent to review a PRD,
# agent posts comments via mdr_review and blocks on mdr_wait.

Output demo/clips/05-terminal-review-prompt.mp4

Set Shell "bash"
Set FontSize 28
Set Width 1440
Set Height 800
Set Padding 24
Set TypingSpeed 14ms
Set Framerate 60

# Start the mock Claude CLI (suppress bash prompt with PS1)
Hide
Type "PS1=''; cd /Users/dennisju/dev/md-redline && clear && ./demo/mock-claude.sh agent-review"
Enter
Sleep 1s
Show

# Give the viewer a moment to see the Claude Code banner before typing
Sleep 400ms

# User asks for the review. Short enough for one line at Width 1440 / FontSize 28.
Type "Use mdr to review prd.md and leave comments."
Sleep 750ms
Enter

# Agent prints the mdr_review + mdr_wait tool calls, ending on the waiting
# state. Tail hold matches the clip-01 rule: the CLI->MDR cut needs >=1.5s
# on the final waiting line.
Sleep 2.6s
