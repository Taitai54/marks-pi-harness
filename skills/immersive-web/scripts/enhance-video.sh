#!/bin/zsh
# Free, on-device video enhancement: Real-ESRGAN upscale + optional RIFE smoothing.
# No cloud, no cost. Everything an "I made this on my laptop" workflow can honestly claim.
# Usage: enhance-video.sh <input.mp4> <output.mp4> [scale=4] [--smooth]
#   scale    : Real-ESRGAN factor (2 or 4). Default 4.
#   --smooth : also RIFE-interpolate to 2x frame rate (buttery motion).
set -e

IN="$1"; OUT="$2"; SCALE="${3:-4}"; SMOOTH="$4"
BIN="${VIDEO_ENHANCE_BIN:-$HOME/.local/opt/video-enhance}"  # dir holding realesrgan-ncnn-vulkan + rife-ncnn-vulkan
RESR="$BIN/realesrgan-ncnn-vulkan"
# NOTE: pass -m models explicitly (segfaults without it) and run in FOREGROUND
# with an on-screen session — the Metal GPU is unavailable to detached processes.
RIFE="$BIN/rife-ncnn-vulkan-20221029-macos/rife-ncnn-vulkan"
RIFE_MODEL="$BIN/rife-ncnn-vulkan-20221029-macos/rife-v4.6"
WORK=$(mktemp -d)

[ -f "$IN" ] || { echo "ERROR: input not found: $IN"; exit 1; }
FPS=$(ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 "$IN" | awk -F/ '{printf "%.3f", $1/$2}')
echo "input fps: $FPS -> extracting frames..."
mkdir -p "$WORK/in" "$WORK/up"
ffmpeg -loglevel error -i "$IN" "$WORK/in/f_%05d.png"
N=$(ls "$WORK/in" | wc -l | tr -d ' ')
echo "$N frames -> Real-ESRGAN ${SCALE}x (this is the slow part, ~5-10s/frame)..."

# Frame-by-frame, NOT folder mode: folder mode segfaults (exit 139) on large
# sequences due to accumulated Vulkan/GPU memory. One process per frame is robust.
for fr in "$WORK/in"/*.png; do
  "$RESR" -i "$fr" -o "$WORK/up/$(basename "$fr")" -n realesrgan-x4plus -s "$SCALE" -m "$BIN/models" >/dev/null 2>&1
done

SRC="$WORK/up"; OUTFPS="$FPS"
if [ "$SMOOTH" = "--smooth" ]; then
  echo "RIFE interpolating to 2x fps..."
  mkdir -p "$WORK/smooth"
  "$RIFE" -i "$WORK/up" -o "$WORK/smooth" -m "$RIFE_MODEL" 2>/dev/null
  SRC="$WORK/smooth"; OUTFPS=$(echo "$FPS * 2" | bc)
fi

echo "reassembling -> $OUT (${OUTFPS}fps)..."
ffmpeg -y -loglevel error -framerate "$OUTFPS" -i "$SRC/%08d.png" 2>/dev/null || \
ffmpeg -y -loglevel error -framerate "$OUTFPS" -pattern_type glob -i "$SRC/*.png" \
  -c:v libx264 -pix_fmt yuv420p -crf 16 "$OUT"
# fallback for RIFE's 8-digit naming vs ESRGAN's naming
[ -f "$OUT" ] || ffmpeg -y -loglevel error -framerate "$OUTFPS" -pattern_type glob -i "$SRC/*.png" -c:v libx264 -pix_fmt yuv420p -crf 16 "$OUT"

rm -rf "$WORK"
echo "DONE: $OUT"
ffprobe -v error -show_entries stream=width,height,r_frame_rate -of default=nw=1 "$OUT"
