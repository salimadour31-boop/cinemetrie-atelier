#!/usr/bin/env bash
# Builds a synthetic test film with known cuts (25 fps, VP9 WebM): 7 shots of different sources,
# including a dark shot, a slow camera-like pan and a single white flash frame inside a shot.
# Truth (cut times, s): 2.4 4.0 7.0 7.8 10.0 11.0  — total 13.0 s
set -euo pipefail
out=${1:-tests/fixture.webm}
ff="ffmpeg -loglevel error -y"
tmp=$(mktemp -d)
$ff -f lavfi -i "testsrc2=size=640x360:rate=25" -t 2.4 -pix_fmt yuv420p $tmp/1.y4m
$ff -f lavfi -i "mandelbrot=size=640x360:rate=25" -t 1.6 -pix_fmt yuv420p $tmp/2.y4m
# pan over a still image (camera move, no cut) with a one-frame white flash at 5.5 s (frame 37 of this shot)
$ff -f lavfi -i "smptehdbars=size=1280x360:rate=25" -vf "crop=640:360:x='t*120':y=0,drawbox=enable='eq(n,37)':x=0:y=0:w=640:h=360:color=white:t=fill" -t 3.0 -pix_fmt yuv420p $tmp/3.y4m
$ff -f lavfi -i "life=size=640x360:rate=25:mold=10:ratio=0.3:death_color=#202060:life_color=#e0c040" -vf scale=640:360 -t 0.8 -pix_fmt yuv420p $tmp/4.y4m
# dark shot (night): testsrc2 at 15 % brightness with a different hue
$ff -f lavfi -i "testsrc2=size=640x360:rate=25" -vf "hue=h=140,eq=brightness=-0.35:contrast=0.4,hflip" -t 2.2 -pix_fmt yuv420p $tmp/5.y4m
$ff -f lavfi -i "cellauto=size=640x360:rate=25:rule=110" -vf "scale=640:360,colorchannelmixer=rr=0.9:gg=0.3:bb=0.2" -t 1.0 -pix_fmt yuv420p $tmp/6.y4m
$ff -f lavfi -i "rgbtestsrc=size=640x360:rate=25" -vf "rotate=a=t/2:fillcolor=#305080" -t 2.0 -pix_fmt yuv420p $tmp/7.y4m
for i in 1 2 3 4 5 6 7; do echo "file '$tmp/$i.y4m'"; done > $tmp/list.txt
$ff -f concat -safe 0 -i $tmp/list.txt -c:v libvpx-vp9 -b:v 1.5M -deadline realtime -cpu-used 8 -g 50 -an "$out"
rm -rf "$tmp"
echo "$out"
