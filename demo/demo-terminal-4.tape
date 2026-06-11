# demo-terminal-4.tape — Flow-2 scene 4: CLI resumes (was blocked on mdr_wait).
# Reproduces the waiting tail, then shows the agent reading the user's reply.

Output demo/clips/07-terminal-review-done.mp4

Set Shell "bash"
Set FontSize 28
Set Width 1440
Set Height 800
Set Padding 24
Set TypingSpeed 14ms
Set Framerate 60

# Run the done mode of the mock script
Hide
Type "PS1=''; cd /Users/dennisju/dev/md-redline && clear && ./demo/mock-claude.sh agent-review-done"
Enter
Sleep 300ms
Show

# agent-review-done prints the waiting state, flips it to "User finished
# review", reads the file, and summarizes the reply. Hold long enough after
# the final message that viewers can read it before the video ends.
Sleep 4.2s
