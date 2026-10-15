# DWG 뷰어 (Mac, Electron)

DWG/DXF 뷰어. DWG는 LibreDWG `dwg2dxf`로 DXF 변환 후 직접 해석·표시한다. 응답·주석은 한국어 존댓말.

## 구조
- `main.js` — 메인 프로세스: 파일 열기(도면 하나 = macOS 네이티브 탭 하나, `winPaths`로 중복 열기 방지), DWG→DXF 변환·캐시(`~/Library/Application Support/DWG 뷰어/dxf-cache`), XREF 경로 탐색, 메뉴, 인쇄(PDF/프린터), CTB 보관함 IPC
- `preload.js` — `window.api` 브리지
- `renderer/dxf.js` — DXF 파서 (HEADER/TABLES/BLOCKS/ENTITIES/OBJECTS의 XCLIP). 깨진 UTF-8 줄만 CP949로 재해석
- `renderer/scene.js` — 블록·XREF·XCLIP·선종류·해치·문자를 전개해 GPU 버퍼로. 색은 (ACI<<24|RGB), 선가중치는 `lineLw`
- `renderer/view.js` — WebGL 선/채움 + 2D 캔버스 문자
- `renderer/plot.js` — CTB 해석 + 벡터 SVG 용지 생성 (인쇄)
- `renderer/app.js` — UI: 레이어/XREF/측정/검색 패널, 스냅, 인쇄창, 패널 숨기기
  - 단축키는 `ev.code`(KeyD 등)로 판단 — 한글 입력 상태에서도 동작해야 함. 단축키를 추가·변경하면 `KEYS` 표(버튼 툴팁·`?` 목록)도 같이 고칠 것
  - 거리 측정 = 이동 가능한 치수(`off`), 인쇄 시 `Plot.dimPrims`로 함께 출력

## 빌드·배포
- 개발 실행: `npm start`
- 앱 빌드: `./build-app.sh` → `dist/DWG 뷰어.app` (LibreDWG를 Resources/bin에 내장, ad-hoc 서명). electron-builder는 Electron 44에서 시작 즉시 크래시하므로 쓰지 않는다
- 설치: `ditto "dist/DWG 뷰어.app" "/Applications/DWG 뷰어.app"`
- 배포용 DMG: `./sign-notarize.sh` — Developer ID 서명(하드닝 런타임, `entitlements.mac.plist`) → DMG → `notarytool`(키체인 프로필 `dwg-notary`) → 스테이플. Homebrew rsync 충돌은 없음(xcodebuild 미사용)
- 시험용 DMG: `./make-dmg.sh` → `~/Downloads/클로드코드/DWG뷰어-설치파일/DWG뷰어-<버전>.dmg` (버전은 package.json)
- 빌드 머신에 `brew install libredwg` 필요 (사용자 Mac에는 불필요)

## 자동 테스트 (숨은 창 캡처)
환경변수 `DWGV_TEST_MENU`(쉼표로 구분한 메뉴 단축키, 예 `CmdOrCtrl+B`) `DWGV_TEST_OPEN`(도면) `DWGV_TEST_SHOT`(png) `DWGV_TEST_JS`(실행할 JS) `DWGV_TEST_WAIT`(ms) `DWGV_TEST_PDF`(PDF 저장 대화상자 건너뛰기)로 `./node_modules/.bin/electron .` 실행. 렌더러 내부는 `window.__dwg = { S, view, openPath }`.

## 미지원 / 다음 후보
배치(레이아웃) 탭·뷰포트, MLINE·MULTILEADER, 이미지/OLE, 인텔 Mac 빌드, 실제 설계사 CTB(Ga3*.ctb)로 출력 검증
