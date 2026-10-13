#!/bin/zsh
# 배포용 DMG 생성: build-app.sh 결과물 + Applications 바로가기 + 설치 방법
set -e
cd "$(dirname "$0")"
./build-app.sh
VER=$(node -p "require('./package.json').version")
OUTDIR=~/Downloads/클로드코드/DWG뷰어-설치파일
mkdir -p "$OUTDIR"
ST=$(mktemp -d)
ditto "dist/DWG 뷰어.app" "$ST/DWG 뷰어.app"
ln -s /Applications "$ST/Applications"
cp 설치방법.txt "$ST/설치 방법.txt"
DMG="$OUTDIR/DWG뷰어-$VER.dmg"
rm -f "$DMG"
hdiutil create -volname "DWG 뷰어" -srcfolder "$ST" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$ST"
hdiutil verify "$DMG" >/dev/null && echo "DMG: $DMG"
