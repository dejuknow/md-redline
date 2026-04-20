# demo-terminal-1.tape — Scenes 1-3: User prompts Claude, agent generates spec,
# user requests review, agent waits.

Output demo/clips/01-terminal-prompt.mp4

Set Shell "bash"
Set FontSize 28
Set Width 1440
Set Height 800
Set Padding 24
Set TypingSpeed 14ms
Set Framerate 60

# Start the mock Claude CLI (suppress bash prompt with PS1)
Hide
Type "PS1=''; cd /Users/dennisju/dev/md-redline && clear && ./demo/mock-claude.sh prompt"
Enter
Sleep 1s
Show

# Give the viewer a moment to see the Claude Code banner before typing
Sleep 400ms

# Scene 1: User types the spec generation prompt. Kept short enough that it
# fits on one line at Width 1440 / FontSize 28 so continuation doesn't need
# a hanging indent (terminals don't do that automatically).
Type "Write a spec for user auth (email, OAuth, magic links) to sample.md."
Sleep 750ms
Enter

# Scene 2: Agent streams the spec output.
Sleep 1.2s

# Scene 3: User requests review in mdr
Type "Let me review sample.md in mdr before you continue."
Sleep 750ms
Enter

# Beat showing "I'll open that in mdr for your review." + the waiting state.
Sleep 1.5s
