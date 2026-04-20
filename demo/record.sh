#!/bin/bash
# record.sh — Produces the final demo video from VHS + Playwright clips.
# Usage: npm run demo:record

set -euo pipefail

DEMO_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$DEMO_DIR/.." && pwd)"
CLIPS_DIR="$DEMO_DIR/clips"
OUTPUT_DIR="$DEMO_DIR/output"
FRAMES_DIR="$DEMO_DIR/frames"
ASSETS="$DEMO_DIR/assets"
BG_IMG="$ASSETS/background.png"

# Check dependencies
for cmd in vhs ffmpeg npx; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Error: $cmd is required but not found. Install it first."
    exit 1
  fi
done

rm -rf "$CLIPS_DIR" "$OUTPUT_DIR"
mkdir -p "$CLIPS_DIR" "$OUTPUT_DIR"

echo "==> Recording terminal scenes with VHS..."
cd "$REPO_ROOT"
vhs "$DEMO_DIR/demo-terminal-1.tape"
vhs "$DEMO_DIR/demo-terminal-2.tape"

echo "==> Recording browser scenes with Playwright..."
cd "$REPO_ROOT"
npx playwright test --config "$DEMO_DIR/playwright.demo.config.ts"

# ---------------------------------------------------------------------------
# Stitch browser frames — already include wallpaper + chrome from the page,
# so no ffmpeg framing needed. Output is 1920x1080.
# ---------------------------------------------------------------------------
echo "==> Stitching browser frames..."
for clip in clip-02 clip-04; do
  frame_count=$(ls "$FRAMES_DIR/$clip"/*.jpg 2>/dev/null | wc -l | tr -d ' ')
  if [ "$frame_count" -eq 0 ]; then
    echo "Error: No frames found for $clip"
    exit 1
  fi

  if [ "$clip" = "clip-02" ]; then
    OUT="$CLIPS_DIR/02-browser-comments.mp4"
  else
    OUT="$CLIPS_DIR/04-browser-results.mp4"
  fi

  # Read the observed capture framerate (written by startScreenCapture)
  # so the stitched clip plays back at wall-clock speed, then upsample to
  # 60fps via duplication for uniformity with the rest of the timeline.
  FPS_IN=$(cat "$FRAMES_DIR/$clip/fps.txt" 2>/dev/null || echo 25)
  ffmpeg -y -framerate "$FPS_IN" -i "$FRAMES_DIR/$clip/frame_%06d.jpg" \
    -c:v libx264 -preset slow -crf 8 -pix_fmt yuv420p \
    -vf "fps=60" "$OUT" 2>/dev/null
done

# ---------------------------------------------------------------------------
# Generate title bar PNG for terminal clips
# ---------------------------------------------------------------------------
echo "==> Generating title bar..."
node "$DEMO_DIR/gen-titlebar.mjs"

# ---------------------------------------------------------------------------
# Frame VHS terminal clips to match the browser visual: wallpaper background,
# window chrome at top, rounded corners. Terminal clips are 1700x960 content.
# ---------------------------------------------------------------------------
echo "==> Framing terminal clips..."

OUT_W=1600
OUT_H=1000
WIN_W=1440              # matches Playwright's window chrome width (CSS left:80, width:1440)
BAR_H=40
RADIUS=12
WIN_LEFT=80             # matches CSS: left: 80px
WIN_TOP=80              # matches CSS: top: 80px (chrome top)

TITLEBAR="$ASSETS/titlebar-claude.png"

frame_terminal_clip() {
  local clip="$1"
  local base
  base=$(basename "$clip")
  local framed="$CLIPS_DIR/framed-$base"
  local R=$RADIUS

  # Combine: wallpaper background, terminal + title bar stacked with rounded corners,
  # placed on wallpaper at (WIN_LEFT, WIN_TOP).
  ffmpeg -y -i "$clip" -i "$TITLEBAR" -i "$BG_IMG" -filter_complex "
    [0:v]scale=${WIN_W}:-2:force_original_aspect_ratio=decrease,pad=${WIN_W}:ih:(ow-iw)/2:0:color=#232730[terminal];
    [1:v]loop=-1:size=1[bar];
    [bar][terminal]vstack=shortest=1,
      format=rgba,
      geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(X,${R})*lt(Y,${R}),if(gt(hypot(${R}-X,${R}-Y),${R}),0,255),if(lt(X,${R})*gt(Y,H-${R}),if(gt(hypot(${R}-X,Y-H+${R}),${R}),0,255),if(gt(X,W-${R})*lt(Y,${R}),if(gt(hypot(X-W+${R},${R}-Y),${R}),0,255),if(gt(X,W-${R})*gt(Y,H-${R}),if(gt(hypot(X-W+${R},Y-H+${R}),${R}),0,255),255))))'[window];
    [2:v]scale=${OUT_W}:${OUT_H},loop=-1:size=1[bg];
    [bg][window]overlay=${WIN_LEFT}:${WIN_TOP}:shortest=1
  " -c:v libx264 -preset slow -crf 8 -pix_fmt yuv420p -r 60 "$framed" 2>/dev/null

  mv "$framed" "$clip"
  echo "  $base framed"
}

# Apply a subtle zoom at given time ranges (pass filter-ready expression parts).
# $1 = clip path, $2 = z expression, $3 = x expr, $4 = y expr
apply_zoom() {
  local clip="$1"
  local zexpr="$2"
  local xexpr="$3"
  local yexpr="$4"
  local zoomed="${clip%.mp4}-zoomed.mp4"

  echo "    DEBUG: zoompan z='${zexpr}'"
  echo "    DEBUG: input size: $(ls -la "$clip" | awk '{print $5}')"

  local logfile
  logfile=$(mktemp)
  if ! ffmpeg -y -i "$clip" -vf "zoompan=z='${zexpr}':x='${xexpr}':y='${yexpr}':d=1:s=${OUT_W}x${OUT_H}:fps=25" \
    -c:v libx264 -preset slow -crf 10 -pix_fmt yuv420p "$zoomed" >"$logfile" 2>&1; then
    echo "    ERROR: ffmpeg zoom failed:"
    tail -10 "$logfile"
    rm -f "$logfile" "$zoomed"
    return 1
  fi
  rm -f "$logfile"
  if [ -s "$zoomed" ]; then
    echo "    DEBUG: zoomed size: $(ls -la "$zoomed" | awk '{print $5}')"
    mv "$zoomed" "$clip"
    echo "    DEBUG: after mv, clip size: $(ls -la "$clip" | awk '{print $5}')"
  else
    echo "    ERROR: zoom produced empty file"
    rm -f "$zoomed"
    return 1
  fi
}

for clip in "$CLIPS_DIR"/01-*.mp4; do
  frame_terminal_clip "$clip"
done
for clip in "$CLIPS_DIR"/03-*.mp4; do
  frame_terminal_clip "$clip"
done

# CLI zoom currently skipped — zoompan with complex expressions on video input
# is unreliable across ffmpeg versions. The VHS font is sized so the typed
# text is readable without zoom. Browser clips still use CSS-based zoom in
# the Playwright test.

# ---------------------------------------------------------------------------
# Stitch all clips together
# ---------------------------------------------------------------------------
echo "==> Stitching clips with crossfade transitions..."

# Get each clip's duration
D1=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$CLIPS_DIR/01-terminal-prompt.mp4")
D2=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$CLIPS_DIR/02-browser-comments.mp4")
D3=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$CLIPS_DIR/03-terminal-agent.mp4")
D4=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$CLIPS_DIR/04-browser-results.mp4")

# Crossfade duration (each transition overlap)
XF=0.5

# Offset for each xfade = cumulative duration minus overlap
# xfade 1: after clip 1, offset = D1 - XF
# xfade 2: after clip 1+2, offset = D1 + D2 - 2*XF
# xfade 3: after 1+2+3, offset = D1 + D2 + D3 - 3*XF
OFF1=$(awk "BEGIN { print $D1 - $XF }")
OFF2=$(awk "BEGIN { print $D1 + $D2 - 2 * $XF }")
OFF3=$(awk "BEGIN { print $D1 + $D2 + $D3 - 3 * $XF }")

cd "$CLIPS_DIR"
ffmpeg -y \
  -i 01-terminal-prompt.mp4 \
  -i 02-browser-comments.mp4 \
  -i 03-terminal-agent.mp4 \
  -i 04-browser-results.mp4 \
  -filter_complex "
    [0:v][1:v]xfade=transition=fade:duration=${XF}:offset=${OFF1}[v01];
    [v01][2:v]xfade=transition=fade:duration=${XF}:offset=${OFF2}[v012];
    [v012][3:v]xfade=transition=fade:duration=${XF}:offset=${OFF3}[vout]
  " -map "[vout]" \
  -c:v libx264 -preset slow -crf 8 -profile:v high -level 5.0 \
  -pix_fmt yuv420p -movflags +faststart -r 60 \
  "$OUTPUT_DIR/demo.mp4" 2>/dev/null

echo ""
echo "✓ Demo video saved to demo/output/demo.mp4"
echo "  Upload to GitHub and update the README link."
