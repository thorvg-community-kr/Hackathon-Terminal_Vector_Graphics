# TermVG 상세 매뉴얼 (Details)

본 문서는 TermVG의 아키텍처, 사용법, 성능 벤치마크, LottieFiles MCP 연동 및 기술 스택에 대한 상세 내용을 다룹니다.

> 📖 [← README (English / 한국어)](../README.md)

## 📋 목차

1. [✨ 핵심 기능](#-핵심-기능)
2. [🏗 아키텍처](#-아키텍처)
3. [🎮 사용법 (단축키 및 UI)](#-사용법-단축키-및-ui)
4. [🎨 렌더링 모드 비교](#-렌더링-모드-비교)
5. [📊 성능 벤치마크](#-성능-벤치마크)
6. [🌐 LottieFiles MCP 연동](#-lottiefiles-mcp-연동)
7. [🔧 트러블슈팅 하이라이트](#-트러블슈팅-하이라이트)
8. [🛠 기술 스택](#-기술-스택)

---

## ✨ 핵심 기능

| 기능 | 설명 |
|------|------|
| **실시간 벡터 렌더링** | ThorVG C++ 엔진을 WebAssembly로 컴파일하여 터미널에서 네이티브급 성능으로 SVG/Lottie 렌더링 |
| **4가지 렌더링 모드** | Half-block(`1×2`), Quadrant(`2×2`), **Sextant(`2×3`)**, Braille(`2×4`) 문자를 활용한 터미널 해상도 극대화 및 인메모리 종횡비 보정 |
| **파일 탐색기** | 비동기 안전 스캐너(`25MB` 상한, 심볼릭 링크 루프·설정 JSON 차단)로 SVG/Lottie 파일 자동 탐지 및 로컬 필터(`/`, `F`) |
| **재생 제어 & 정적 유휴** | `Space` 일시정지/재생, `←→` 프레임 시크(Seek), 정적 SVG `0%` CPU 유휴화(`STATIC`) |
| **실시간 FPS 모니터** | Wall-Clock 프레임 동기화 및 WASM 렌더링 성능을 실시간 측정하여 색상 인디케이터로 표시 |
| **다크 모드 & 4종 배경 프리셋** | `D` 다크 모드 색상 반전 및 `B` 배경 프리셋(`transparent`, `dark`, `light`, `checkerboard`) 실시간 전환 |
| **더블 버퍼링 & SGR RLE** | Synchronized Output Mode(`\x1b[?2026h/l`)로 깜빡임 제거 및 단일 패스 SGR RLE 압축(`50%+` 바이트 절감) |
| **LottieFiles MCP 연동** | MCP 프로토콜 + OAuth 2.0 PKCE(QR 코드 / 수동 코드 입력)로 온라인 에셋 검색/다운로드/즉시 재생 |
| **웹 터미널 지원** | `ttyd` 연동 및 GitHub Pages 배포로 브라우저에서도 렌더링 체험 제공 |
| **Graceful Shutdown** | `SIGINT`/`SIGTERM`/`SIGHUP` 및 `Q` 종료 시 `engine.delete()` 호출로 WASM 메모리 안전 해제 |

---

## 🏗 아키텍처

```mermaid
graph LR
    subgraph "C++ / WASM Layer"
        TVG["ThorVG Engine<br/>(SwCanvas, Animation)"]
        RENDER["WASM ANSI Renderer<br/>(Half-block / Quadrant / Braille)"]
    end

    subgraph "WASM & Preprocess Bridge"
        EMB["Emscripten<br/>embind"]
        WASM["realWasmModule.ts<br/>(WASM Loader)"]
        PREP["vectorPreprocessor.ts<br/>(Aspect 2.0 / 4:3)"]
    end

    subgraph "TS Render & Sync Layer"
        PX["pixelExtractor.ts +<br/>sextantRenderer.ts (2x3)"]
        RLE["ansiPostProcessor.ts<br/>(SGR RLE + Bg Presets)"]
        AUTH["lottieAuth.ts<br/>(OAuth 2.0 PKCE)"]
        MCP_C["useMcpSearch.ts<br/>(MCP + GraphQL)"]
    end

    subgraph "React Ink UI"
        SCAN["useFileScanner.ts"]
        MENU["InteractiveMenu<br/>(LeftPanel / HelpOverlay)"]
        PLAYER["LottiePlayer +<br/>useAnimationLoop"]
        SYNC["syncOutput.ts<br/>(DEC Mode 2026)"]
    end

    subgraph "External"
        LOTTIE["LottieFiles<br/>MCP Server"]
        TTYD["ttyd<br/>(Web Terminal)"]
    end

    TVG --> RENDER --> EMB --> WASM
    PREP --> WASM
    WASM --> PLAYER
    PLAYER --> PX
    PLAYER --> RLE
    PLAYER --> SYNC
    AUTH --> MCP_C
    MCP_C -->|GraphQL| LOTTIE
    SCAN --> MENU
    MENU --> PLAYER
    MCP_C --> MENU
    TTYD -.->|WebSocket| MENU
```

### 렌더링 파이프라인

1. `vectorPreprocessor.ts`가 SVG `<!DOCTYPE>` 정제 및 모드별 종횡비 보정(`quadrant`: `2.0`, `sextant`: `4/3`) 수행
2. ThorVG C++ 엔진(`SwCanvas`)이 SVG/Lottie를 ARGB 픽셀 버퍼로 래스터라이즈하고 Mode 0/1/2 24-bit TrueColor ANSI 생성
3. `sextant` 모드에서는 `WasmPixelExtractor`가 무손실 Mode 0 출력을 재사용 `Uint8Array` RGBA 버퍼로 디코딩하고 `renderPixelsToSextant`가 2-클러스터 `2×3` Sextant 모자이크 생성; 그 외 모드는 `ansiPostProcessor.ts`가 단일 패스 SGR RLE 압축 및 배경 프리셋 적용
4. React Ink와 `createSyncStdout`(DEC Private Mode `\x1b[?2026h/l`)이 터미널에 깜빡임 없이 출력

---

## 🎮 사용법 (단축키 및 UI)

### 키보드 단축키

| 키 | 동작 | 비고 |
|:---:|------|------|
| `↑` `↓` | 파일 목록 탐색 | 하이라이트 시 즉시 프리뷰 전환 |
| `←` `→` | 페이지 넘기기 | 재생 중일 때 |
| `←` `→` | 프레임 시크 | 일시정지 중일 때 |
| `Enter` | 파일 또는 검색 항목 선택 | |
| `Space` | 재생 / 일시정지 | `▶` ↔ `⏸ PAUSED` 표시 |
| `M` | 렌더링 모드 전환 | Quadrant → Sextant → Braille → Half-block |
| `D` | 다크 모드 토글 | 어두운 색상 자동 반전 |
| `B` | 배경 프리셋 전환 | transparent → dark → light → checkerboard |
| `R` | 하위 폴더 스캔 깊이 순환 | `Depth: 0 → 1 → 2 → 3 → 0` |
| `/` 또는 `F` | 현재 폴더 로컬 필터 검색 | `ESC`로 검색 해제, `Enter`로 결과 리스트 이동 |
| `O` | 경로 직접 입력 | 잘못된 경로 입력 시 기존 목록 유지 |
| `L` | LottieFiles 검색 | MCP 연동 온라인 검색 (`zoom === 1.0x` 기본 뷰) |
| `+` `=` / `-` / `0` | 무손실 벡터 줌 / 리셋 | `1.0x ~ 8.0x` 실시간 벡터 재래스터라이즈 확대·축소 및 초기화 |
| `H` `J` `K` `L` | 뷰포트 패닝 | 확대 중(`zoom > 1.0x`) 좌/하/상/우 패닝 (`0`으로 리셋) |
| `?` | 단축키 도움말 오버레이 토글 | `?` 또는 `ESC`로 닫기 |
| `Q` | 안전한 리소스 해제 후 종료 | WASM 메모리 해제(`destroy()`) 후 종료 |

### UI 구성

```
┌─ 30% Left Panel ──┐┌──── 70% Right Panel ────┐
│ Name: alien.json   ││ Live Preview ▶  30fps   │
│ 4.33s | 100.7kb    ││                         │
│ quadrant(M) OFF(D) ││   ┌─────────────────┐   │
│ Bg:transparent(B)  ││   │                 │   │
│ Depth:1(R)         ││   │   (Animation    │   │
│ 📄 11555.json      ││   │    Rendering)   │   │
│ 📂 effects/        ││   │                 │   │
│ > 📄 alien.json    ││   └─────────────────┘   │
│                    ││                         │
│ Page 1/11 (155)    ││                         │
│ ↑↓ browse ←→ pages ││                         │
│ /:Search R:Depth   ││                         │
│ B:Bg ?:Help        ││                         │
│ L:LottieFiles O:Open││                        │
│ Q:Quit             ││                         │
└────────────────────┘└─────────────────────────┘
```

---

## 🎨 렌더링 모드 비교

TermVG는 터미널의 한계를 극복하기 위해 네 가지 유니코드 기반 렌더링 모드를 제공합니다.

| 모드 | 문자 | 셀당 해상도 | 종횡비 보정 | 특징 |
|------|------|:---:|:---:|------|
| **Half-block** | `▀` `▄` `█` | 1×2 px | `1.0` | 최고 색상 정확도, 무손실 24-bit TrueColor 픽셀 브릿지 기반 |
| **Quadrant** | `▖` `▗` `▘` `▝` `▞` `▟` ... | 2×2 px | `2.0` | 해상도/색상 균형, **TUI 기본값** (`vectorPreprocessor.ts` 2× 가로 보정) |
| **Sextant** | `🬀`~`🬻` (`U+1FB00..1FB3B`) | 2×3 px | `4/3` | Zero-GC `WasmPixelExtractor` + 2-클러스터 Luma 모자이크 + 단색 심 제거(`colorDist < 15`) |
| **Braille** | `⠁` `⠂` `⠄` `⡀` ... | 2×4 px | `1.0` | 최고 서브픽셀 해상도, 셀당 단일 평균색, **`termvg play` 기본값** |

### 해상도 계산 예시 (80×40 터미널)

| 모드 | 유효 픽셀 해상도 | 배율 |
|------|:---:|:---:|
| Half-block | 80 × 80 | 1× |
| Quadrant | 160 × 80 | 2× |
| Sextant | 160 × 120 | 3× |
| Braille | 160 × 160 | 4× |

### 배경 프리셋 (`B` 키 전환)

| 프리셋 | 색상 / 시퀀스 | 설명 |
|--------|---------------|------|
| **`transparent`** *(기본값)* | `\x1b[49m` | 터미널 고유 배경 보존 + 16-쌍 `BLOCK_COMPLEMENT_LUT` 보수 글리프 반전으로 검은 테두리 제거 |
| **`dark`** | `#181825` (`24,24,37`) | 다크 테마 고정 배경 + 양방향 `inBg`/`inFg` 크로마키 치환(Black Halo 방지) |
| **`light`** | `#F5F5F7` (`245,245,247`) | 라이트 테마 고정 배경 + 양방향 크로마키 치환 |
| **`checkerboard`** | `#2A2A37` / `#1E1E28` | 그래픽 툴 스타일의 교차 투명도 체크 격자 배경 |

---

## 📊 성능 벤치마크

### 테스트 환경
- **CPU:** Apple M-series
- **Terminal:** iTerm2 (24-bit TrueColor, Synchronized Output 지원)
- **WASM:** Emscripten으로 컴파일된 ThorVG (`SwCanvas`)

### FPS 측정 결과

| 파일 | 용량 | 프레임 수 | Quadrant FPS | Braille FPS |
|------|:---:|:---:|:---:|:---:|
| 단순 아이콘 (alien.json) | 100KB | 120 | 30 fps 🟢 | 28 fps 🟢 |
| 중간 복잡도 (fireworks.json) | 9KB | 90 | 30 fps 🟢 | 30 fps 🟢 |
| 고복잡도 (10MB+) | 10MB | 300+ | 20~25 fps 🟡 | 15~20 fps 🟡 |

> FPS 색상 기준: 🟢 ≥25fps (쾌적) | 🟡 15~24fps (경고) | 🔴 <15fps (저하)
> - **SGR RLE 후처리 예산**: `160×80` 터미널 프레임 기준 평균 `< 2 ms`, 바이트 크기 `50%` 이상 절감 (`tests/ansiPostProcessor.test.ts` 검증).
> - **Sextant 추출·모자이크 예산**: `160×120` 및 `200×200` 픽셀 프레임 기준 평균 `< 10 ms` (`tests/pixelAndSextant.test.ts` 검증).

### 메모리 관리
- WASM 엔진 초기화: ~2MB
- `WasmPixelExtractor` 내부 `Uint8Array` 버퍼 재사용(Zero-GC) 및 정적 SVG `0%` CPU 유휴화
- Graceful Shutdown 시 `engine.delete()` 호출로 C++ 소멸자 명시 실행
- `SIGINT`/`SIGTERM`/`SIGHUP` 시그널 핸들링으로 좀비 프로세스 방지

---

## 🌐 LottieFiles MCP 연동

TermVG는 **Model Context Protocol (MCP)** 을 통해 LottieFiles 에셋을 CLI 환경에서 직접 검색하고 다운로드할 수 있습니다.

### 검색 및 다운로드

- `L` 키를 눌러 검색 모드 진입
- OAuth 2.0 PKCE(`S256`) 인증 지원 — 터미널 QR 코드 스캔, 로컬 콜백 서버(`localhost:9876/callback`, 동적 포트 폴백), 리다이렉트 URL/코드 수동 붙여넣기 지원
- 토큰을 `~/.termvg/token.json` (`0o600` 파일, `0o700` 디렉터리)에 저장하고 `refresh_token`으로 자동 갱신
- GraphQL(`searchPublicAnimations`) 기반으로 에셋 검색 및 작성자/좋아요(`♥`)/다운로드(`↓`) 표시
- 다운로드 시 파일명은 `이름_by_작성자_ID.json` 형태로 현재 스캔 디렉터리(기본 경로 미지정 시 `~/.termvg/downloads/`)에 저장 및 즉시 재생

---

## 🔧 트러블슈팅 하이라이트

개발 과정에서 겪은 주요 과제와 해결책입니다.

### 1. 터미널 더블 버퍼링 (깜빡임 제거)
**문제:** 매 프레임마다 Ink의 Clear→Write 2-Pass로 인한 깜빡임
**해결:** DEC Private Mode `\x1b[?2026h/l` (Synchronized Output) 적용. 터미널이 출력을 버퍼링하고 한 번에 플러시하여 깜빡임을 원천 차단.

### 2. ESM/CJS 모듈 충돌 해결
**문제:** Emscripten이 생성한 `termvg.js`가 CommonJS인데 `"type": "module"` 프로젝트에서 `require()` 불가
**해결:** `.cjs` 확장자로 명시적 분리 + `createRequire(import.meta.url)`로 ESM 내 CommonJS 로딩.

### 3. MCP 응답 구조 파싱
**문제:** `result.content[0].text`를 JSON 파싱하면 에러 발생
**해결:** `result.structuredContent.data`에 이미 파싱된 객체로 접근하여 해결.

---

## 🛠 기술 스택

| 영역 | 기술 | 역할 |
|------|------|------|
| **렌더링 엔진** | ThorVG (C++) | SVG/Lottie 래스터라이징 |
| **컴파일** | Emscripten (WASM) | C++ → WebAssembly 크로스 컴파일 |
| **바인딩** | embind | C++ ↔ JavaScript 함수 바인딩 |
| **런타임** | Node.js 18+ | WASM 호스팅 + 파일시스템 접근 |
| **UI 프레임워크** | React + Ink v5 | 선언적 터미널 UI |
| **프로토콜** | MCP (Model Context Protocol) | LottieFiles API 연동 |
| **인증** | OAuth 2.0 + PKCE | LottieFiles 인증 |
| **언어** | TypeScript + C++ | 타입 안전성 + 네이티브 성능 |
