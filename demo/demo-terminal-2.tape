# demo-terminal-2.tape — Scene 7: CLI resumes (was blocked on mdr_request_review).
# Reproduces the tail of scene 3 then shows the agent processing comments.

Output demo/clips/03-terminal-agent.mp4

Set Shell "bash"
Set FontSize 28
Set Width 1440
Set Height 800
Set Padding 24
Set TypingSpeed 14ms
Set Framerate 60

# Run the review mode of the mock script
Hide
Type "PS1=''; cd /Users/dennisju/dev/md-redline && clear && ./demo/mock-claude.sh review"
Enter
Sleep 300ms
Show

# review_mode prints the waiting state briefly before replacing it with
# "Review received", streams the agent's edits, then prints "Both comments
# addressed..." + the ❯ prompt. Hold long enough after the final message
# that viewers can read it before the cut back to mdr.
Sleep 3.3s
