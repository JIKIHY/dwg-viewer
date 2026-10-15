# DWG 뷰어 (Mac)

Mac에서 AutoCAD DWG/DXF 도면을 보는 무료 뷰어입니다. 도면은 이 Mac 안에서만 처리되며 인터넷으로 보내지 않습니다.

- 파일별 탭, 레이어 켜고 끄기, 문자 검색, XREF 자동 찾기
- 거리·면적 측정(스냅), 치수선
- CTB 플롯 스타일을 적용한 인쇄 · PDF 저장

## 설치
[Releases](../../releases)에서 `DWG뷰어-<버전>.dmg`를 받아 'DWG 뷰어'를 Applications 폴더로 끌어다 놓습니다.
Apple Silicon(M1 이상) Mac, macOS 12 이상.

## 직접 빌드
```bash
brew install libredwg   # 빌드하는 Mac에만 필요 (앱 안에 포함됨)
npm install
npm start               # 개발 실행
./build-app.sh          # dist/DWG 뷰어.app
./make-dmg.sh           # DMG 만들기
```

## 라이선스
GNU General Public License v3.0 — [LICENSE](LICENSE)

이 앱은 DWG→DXF 변환에 [GNU LibreDWG](https://www.gnu.org/software/libredwg/) 0.14 (GPLv3, 소스: https://github.com/LibreDWG/libredwg)의 `dwg2dxf`를 포함합니다.
삼각 분할에 [earcut](https://github.com/mapbox/earcut) (ISC)을 사용합니다.

모바일 버전: https://github.com/JIKIHY/dwg-viewer-mobile
