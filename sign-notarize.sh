#!/bin/zsh
# 배포용: Developer ID 서명 → DMG → 애플 공증 → 스테이플
# 필요: "Developer ID Application" 인증서, notarytool 프로필 "dwg-notary"
#   xcrun notarytool store-credentials "dwg-notary" --apple-id <Apple ID> --team-id <팀 ID>
set -e
cd "$(dirname "$0")"
ID="Developer ID Application: kihyeon ji (Y78CLWCDMD)"
ENT="$PWD/entitlements.mac.plist"
PROFILE="${NOTARY_PROFILE:-dwg-notary}"

./build-app.sh
APP="$PWD/dist/DWG 뷰어.app"
sign() { codesign --force --timestamp --options runtime --sign "$ID" "$@"; }

# 1) 안쪽 실행 파일·라이브러리부터 (번들 밖의 Mach-O)
find "$APP" -type f \( -name "*.dylib" -o -perm +111 \) -print0 | while IFS= read -r -d '' f; do
  file -b "$f" | grep -q "Mach-O" || continue
  case "$f" in *.app/Contents/MacOS/*) continue ;; esac   # 앱 번들 실행 파일은 번들로 서명
  sign "$f"
done
# 2) 프레임워크, 헬퍼 앱 (깊은 것부터)
find "$APP/Contents/Frameworks" -depth -type d \( -name "*.framework" -o -name "*.app" \) -print0 | while IFS= read -r -d '' b; do
  if [[ "$b" == *.app ]]; then sign --entitlements "$ENT" "$b"; else sign "$b"; fi
done
# 3) 본 앱
sign --entitlements "$ENT" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

# 4) DMG
VER=$(node -p "require('./package.json').version")
OUTDIR=~/Downloads/클로드코드/DWG뷰어-설치파일
mkdir -p "$OUTDIR"
ST=$(mktemp -d)
ditto "$APP" "$ST/DWG 뷰어.app"
ln -s /Applications "$ST/Applications"
cp 설치방법.txt "$ST/설치 방법.txt"
DMG="$OUTDIR/DWG뷰어-$VER.dmg"
rm -f "$DMG"
hdiutil create -volname "DWG 뷰어" -srcfolder "$ST" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$ST"
codesign --force --timestamp --sign "$ID" "$DMG"

# 5) 공증 + 스테이플
xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait
xcrun stapler staple "$DMG"
spctl -a -t open --context context:primary-signature -vv "$DMG"
echo "공증 완료: $DMG"
