#!/bin/bash
# mock-claude.sh — Simulates Claude Code CLI for demo recording.
# Usage: ./mock-claude.sh prompt   (scenes 1-3)
#        ./mock-claude.sh review   (scene 7)

set -e

DEMO_DIR="$(cd "$(dirname "$0")" && pwd)"

# ANSI codes
BOLD='\033[1m'
DIM='\033[2m'
CYAN='\033[36m'
GREEN='\033[32m'
YELLOW='\033[33m'
MAGENTA='\033[35m'
RED='\033[31m'
RESET='\033[0m'
BG_DARK='\033[48;5;236m'

# Thin horizontal rule
hr() {
  local cols=${1:-80}
  printf "  ${DIM}"
  printf '─%.0s' $(seq 1 "$cols")
  printf "${RESET}\n"
}

# Simulated streaming effect (fast)
stream() {
  while IFS= read -r line; do
    echo -e "$line"
    sleep 0.008
  done
}

prompt_mode() {
  # Claude Code startup banner (matches real CLI format)
  echo ""
  echo -e "  ${BOLD}Claude Code${RESET} ${DIM}v2.1.108${RESET}"
  echo -e "  ${DIM}Opus 4.6 (1M context) with high effort · Claude Max${RESET}"
  echo -e "  ${DIM}~/dev/myapp${RESET}"
  echo ""
  hr 76
  echo ""
  printf "  ${BOLD}❯${RESET} "

  # Wait for VHS to type the prompt
  read -r _

  echo ""
  hr 76
  echo ""
  echo -e "  ${BOLD}⏺${RESET} I'll create a comprehensive authentication spec covering"
  echo -e "    email/password, OAuth, and magic links."
  echo ""

  # Tool call: Write file
  echo -e "  ${YELLOW}⏺${RESET} ${BOLD}Write${RESET}${DIM}(sample.md)${RESET}"
  echo ""
  echo -e "    ${DIM}# User Authentication Spec${RESET}" | stream
  echo -e "    ${DIM}${RESET}" | stream
  echo -e "    ${DIM}## Overview${RESET}" | stream
  echo -e "    ${DIM}This document specifies the authentication system...${RESET}" | stream
  echo -e "    ${DIM}${RESET}" | stream
  echo -e "    ${DIM}## Email & Password Authentication${RESET}" | stream
  echo -e "    ${DIM}### Password Requirements${RESET}" | stream
  echo -e "    ${DIM}- Minimum 8 characters${RESET}" | stream
  echo -e "    ${DIM}- At least one uppercase letter${RESET}" | stream
  echo -e "    ${DIM}...${RESET}" | stream
  echo -e "    ${DIM}${RESET}" | stream
  echo -e "    ${DIM}## Password Reset${RESET}" | stream
  echo -e "    ${DIM}Password reset via email with expiring tokens (valid 1 hour).${RESET}" | stream
  echo -e "    ${DIM}...${RESET}" | stream
  echo ""
  echo -e "  ${GREEN}✓${RESET} ${DIM}Wrote sample.md (67 lines)${RESET}"
  echo ""
  hr 76
  echo ""
  printf "  ${BOLD}❯${RESET} "

  # Wait for VHS to type the review request
  read -r _

  echo ""
  hr 76
  echo ""
  echo -e "  ${BOLD}⏺${RESET} I'll open that in mdr for your review."
  echo ""

  # Tool call: mdr_request_review
  echo -e "  ${MAGENTA}⏺${RESET} ${BOLD}mdr_request_review${RESET}${DIM}({\"filePaths\": [\"sample.md\"]})${RESET}"
  echo -e "    ${DIM}⎿ Waiting for review in md-redline...${RESET}"
  echo ""

  # Hold until VHS ends the recording
  sleep 30
}

review_mode() {
  # Reproduce the tail of prompt_mode so clip 03 looks like a continuation
  # of clip 01 — the CLI is still waiting on the mdr_request_review tool call.
  echo ""
  echo -e "  ${BOLD}⏺${RESET} I'll open that in mdr for your review."
  echo ""
  echo -e "  ${MAGENTA}⏺${RESET} ${BOLD}mdr_request_review${RESET}${DIM}({\"filePaths\": [\"sample.md\"]})${RESET}"
  echo -e "    ${DIM}⎿ Waiting for review in md-redline...${RESET}"
  # Longer pause at the clip start — the CLI has just come back on screen
  # after the transition, so give viewers a beat to register the state
  # before the "Waiting..." line flips to "Review received".
  sleep 1.5

  # Overwrite the "Waiting..." line with "Review received"
  printf "\033[1A\033[2K"
  echo -e "    ${GREEN}✓${RESET} ${DIM}Review received (2 comments)${RESET}"
  echo ""
  hr 76
  echo ""
  sleep 0.2

  echo -e "  ${BOLD}⏺${RESET} Addressing your review comments:"
  echo ""
  sleep 0.1

  echo -e "    ${BOLD}1.${RESET} Password minimum length: updating from 8 to 12" | stream
  echo -e "       characters per your recommendation." | stream
  sleep 0.08

  echo ""
  echo -e "  ${YELLOW}⏺${RESET} ${BOLD}Edit${RESET}${DIM}(sample.md)${RESET}"
  echo -e "    ${DIM}  ${RED}- Minimum 8 characters${RESET}"
  echo -e "    ${DIM}  ${GREEN}+ Minimum 12 characters${RESET}"
  echo ""
  echo -e "  ${GREEN}✓${RESET} ${DIM}Updated sample.md${RESET}"
  sleep 0.1

  echo ""
  echo -e "    ${BOLD}2.${RESET} Token expiry: one hour is too aggressive. Industry" | stream
  echo -e "       standard is 24 hours (AWS Cognito, Auth0, Firebase)." | stream
  echo -e "       Updating to 24 hours with rationale." | stream
  sleep 0.08

  echo ""
  echo -e "  ${YELLOW}⏺${RESET} ${BOLD}Edit${RESET}${DIM}(sample.md)${RESET}"
  echo -e "    ${DIM}  ${RED}- Password reset via email with expiring tokens (valid 1 hour).${RESET}"
  echo -e "    ${DIM}  ${GREEN}+ Password reset via email with expiring tokens (valid 24 hours).${RESET}"
  echo -e "    ${DIM}  ${GREEN}+${RESET}"
  echo -e "    ${DIM}  ${GREEN}+ Industry standard for password reset tokens is 24 hours...${RESET}"
  echo ""
  echo -e "  ${GREEN}✓${RESET} ${DIM}Updated sample.md${RESET}"
  echo ""
  hr 76
  echo ""

  echo -e "  ${BOLD}⏺${RESET} Both comments addressed. The password minimum is now 12"
  echo -e "    characters and token expiry extended to 24 hours with"
  echo -e "    supporting rationale."
  echo ""
  hr 76
  echo ""
  # Show the ❯ prompt so viewers see the CLI is ready for the next input
  printf "  ${BOLD}❯${RESET} "
  sleep 30
}

case "${1:-prompt}" in
  prompt) prompt_mode ;;
  review) review_mode ;;
  *) echo "Usage: $0 {prompt|review}" && exit 1 ;;
esac
