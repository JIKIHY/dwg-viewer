#!/bin/zsh
# Electron 공식 수동 패키징: Electron.app 복사 → Resources/app 에 소스 배치 → Info.plist 수정 → ad-hoc 서명
set -e
cd "$(dirname "$0")"
OUT="dist/DWG 뷰어.app"
rm -rf dist && mkdir -p dist
ditto node_modules/electron/dist/Electron.app "$OUT"
APP="$OUT/Contents/Resources/app"
mkdir -p "$APP/renderer/vendor"
cp main.js preload.js "$APP/"
cp renderer/*.html renderer/*.css renderer/*.js "$APP/renderer/"
cp renderer/vendor/* "$APP/renderer/vendor/"
node -e 'const p=require("./package.json");delete p.devDependencies;delete p.build;require("fs").writeFileSync(process.argv[1],JSON.stringify(p,null,2))' "$APP/package.json"
rm -f "$OUT/Contents/Resources/default_app.asar"
PL="$OUT/Contents/Info.plist"
B=/usr/libexec/PlistBuddy
$B -c "Set :CFBundleIdentifier local.jigihyeon.dwgviewer" "$PL"
$B -c "Set :CFBundleName DWG 뷰어" "$PL"
$B -c "Add :CFBundleDisplayName string DWG 뷰어" "$PL" 2>/dev/null || $B -c "Set :CFBundleDisplayName DWG 뷰어" "$PL"
VER=$(node -p "require('./package.json').version")
$B -c "Set :CFBundleShortVersionString $VER" "$PL"
$B -c "Delete :CFBundleDocumentTypes" "$PL" 2>/dev/null || true
$B -c "Add :CFBundleDocumentTypes array" "$PL"
i=0
for ext in dwg dxf; do
  $B -c "Add :CFBundleDocumentTypes:$i dict" "$PL"
  $B -c "Add :CFBundleDocumentTypes:$i:CFBundleTypeName string ${ext:u} Drawing" "$PL"
  $B -c "Add :CFBundleDocumentTypes:$i:CFBundleTypeRole string Viewer" "$PL"
  $B -c "Add :CFBundleDocumentTypes:$i:LSHandlerRank string Alternate" "$PL"
  $B -c "Add :CFBundleDocumentTypes:$i:CFBundleTypeExtensions array" "$PL"
  $B -c "Add :CFBundleDocumentTypes:$i:CFBundleTypeExtensions:0 string $ext" "$PL"
  i=$((i+1))
done
# DWG 변환기(LibreDWG) 내장: 다른 Mac에서도 Homebrew 없이 동작하도록
BIN="$OUT/Contents/Resources/bin"
mkdir -p "$BIN"
SRC=$(readlink -f /opt/homebrew/bin/dwg2dxf)
LIB=$(otool -L "$SRC" | awk 'NR>1 && /libredwg/{print $1}')
cp "$SRC" "$BIN/dwg2dxf"
cp "$LIB" "$BIN/libredwg.0.dylib"
chmod u+w "$BIN/dwg2dxf" "$BIN/libredwg.0.dylib"
install_name_tool -id @loader_path/libredwg.0.dylib "$BIN/libredwg.0.dylib"
install_name_tool -change "$LIB" @loader_path/libredwg.0.dylib "$BIN/dwg2dxf"
cat > "$BIN/LibreDWG-LICENSE.txt" <<'TXT'
dwg2dxf, libredwg.0.dylib: GNU LibreDWG 0.14 (GPLv3)
소스코드: https://www.gnu.org/software/libredwg/  ·  https://github.com/LibreDWG/libredwg
라이선스 전문: https://www.gnu.org/licenses/gpl-3.0.html
DWG 뷰어 전체 소스(GPLv3): https://github.com/JIKIHY/dwg-viewer
TXT
codesign --force --sign - "$BIN/libredwg.0.dylib"
codesign --force --sign - "$BIN/dwg2dxf"
codesign --force --deep --sign - "$OUT"
echo "built: $OUT"
