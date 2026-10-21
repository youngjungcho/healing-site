# 빙글빙글 달리기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 놈 오마주 원버튼 무한 러너 '빙글빙글 달리기'(`binggeul`)를 쉼표 게임에 추가한다.

**Architecture:** 기존 게임처럼 `public/games/binggeul/index.html` 한 파일에 담는다. 그림·소리와 무관한 규칙(속도, 코스 생성, 충돌, 점수)은 `// ==CORE==` … `// ==/CORE==` 표시 사이에 순수 함수로 모아 둔다. 그래서 node 테스트가 HTML에서 이 블록만 잘라 `vm`으로 돌려 볼 수 있다. 화면, 메뉴, 기록판, 공유는 `public/games/bureung/index.html`을 뼈대로 복사해 고친다.

**Tech Stack:** 순수 HTML/CSS/Canvas/WebAudio, Express(`server.js`), Node 24 내장 `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-21-binggeul-runner-design.md`

## Global Constraints

- 파일은 `public/games/binggeul/index.html`와 `public/games/binggeul/og.png`. 외부 라이브러리 없음.
- 제목 "빙글빙글 달리기", slug `binggeul`, 아이콘 🌀, 태그 `러너`, `원버튼`, `키보드·터치`, `added:"2026-10-21"`, `stageUnit:"km10"`
- 원작 놈의 캐릭터, 이름, 그림, 글자는 쓰지 않는다. 설명문에도 "놈"을 쓰지 않는다.
- 액정 팔레트: `#9BBC0F` `#8BAC0F` `#306230` `#0F380F`. 액정은 저해상도 오프스크린에 그린 뒤 `imageSmoothingEnabled=false`로 키운다. 캐릭터는 고해상도 파스텔(볼터치, 표정 calm/scared/dizzy/happy)로 그린다.
- 액정 밖 UI는 Jua, 파스텔, 기존 게임 CSS 변수와 다크모드를 따른다.
- localStorage 키 접두사 `binggeul-side-`. 닉네임 키 `binggeul-side-nick`(공용 댓글창이 읽음)
- 펫, 상점, 일일 미션, 난이도 모드는 넣지 않는다.
- 저장소 `master`에 바로 커밋한다. 푸시는 사용자 확인 뒤에 한다.
- 테스트용 임시 코드는 `//TESTONLY` 표시를 하고, 커밋 전에 지운다.

## Review Focus

1. **회전 도중 입력**: 화면이 도는 0.45초 동안 탭을 연타해도 점프가 쌓이거나 벽 속으로 끼면 안 된다. 회전 중에는 점프를 받지 않고 다음 장애물도 없다(Task 1 `course fairness` 테스트와 Task 3 브라우저 확인).
2. **탭 전환과 rAF 정지**: 다른 탭에 갔다 오면 dt가 튀어 구멍을 순간이동으로 지나치면 안 된다. dt는 0.05초로 자르고, `visibilitychange`에서 일시정지한다(Task 3).
3. **아주 긴 판**: 3km 넘게 가도 속도가 상한에서 멈추고, 코스 배열이 무한히 커지지 않아야 한다. 지나간 조각은 버린다(Task 1 `speedAt cap`, `trimCourse` 테스트).
4. **서버 검증과 실제 기록의 어긋남**: 최고 속도로 끝까지 달린 정상 기록이 `SCORE_CHECKS`에 거절되면 안 된다(Task 2 경계값 테스트).
5. **오프라인과 localStorage 막힘**: `file://`로 열거나 저장소가 막혀도 게임은 돌아야 한다. 기존 `store` 래퍼(try/catch)와 `ONLINE` 판정을 그대로 쓴다(Task 4·5).

---

## 파일 구조

| 파일 | 할 일 |
|---|---|
| Create `public/games/binggeul/index.html` | 게임 전체. CORE 블록 + 화면 + 메뉴/결과/캐릭터/기록판/공유 |
| Create `public/games/binggeul/og.png` | 공유 미리보기 1200×630 |
| Create `tests/binggeul-core.test.js` | CORE 블록 단위 테스트 |
| Create `tests/binggeul-server.test.js` | 기록 저장 API의 `binggeul` 검증 테스트 |
| Modify `server.js:2046-2060` | `SCORE_CHECKS`에 `binggeul` 추가 |
| Modify `public/games/games.json` | 게임 카드 한 줄 |
| Modify `/Users/joyeongjung/workspace/carcarcar/.claude/launch.json` | `healing-test-binggeul` 설정(포트 4031) |

테스트 실행: `cd ~/healing-site-backend && node --test tests/`

---

### Task 1: CORE 규칙 (속도, 코스, 충돌, 점수)

**Files:**
- Create: `public/games/binggeul/index.html` (이 단계에서는 `<script>` 안에 CORE 블록만 있는 최소 HTML)
- Test: `tests/binggeul-core.test.js`

**Interfaces:**
- Produces (모두 CORE 블록 안의 전역 `const`/`function`. 단위는 미터와 초):
  - `CFG = {startSpeed:9, maxSpeed:26, speedPer100m:0.8, gravity:60, jumpV:19, holdBoost:0.35, rotateSec:0.45, safeAfterWallSec:1, hazardFrom:500, starPts:20}`
  - `speedAt(dist:number) -> number`: `min(maxSpeed, startSpeed + floor(dist/100)*speedPer100m)`
  - `maxJumpLen(speed:number) -> number`: 길게 누르지 않은 점프로 넘을 수 있는 수평 거리 `speed * 2*jumpV/gravity`
  - `makeRng(seed:number) -> () => number`: mulberry32
  - 조각 `Seg = {type:'flat'|'hole'|'spike'|'ceil'|'wall', x:number, len:number}`. x는 지금 면에서의 시작 위치이다. 면이 바뀌면 x는 0부터 다시 센다. `wall`은 len 0이고 면의 끝이다.
  - 별 `Star = {x:number, h:number, got:boolean}`. h는 바닥에서의 높이(m)이다.
  - `genFace(rng, distAtStart:number) -> {segs:Seg[], stars:Star[], len:number}`: 한 면(벽까지)을 만든다. 면 길이는 60~140m이고 마지막은 반드시 `wall`이다.
  - `hazardAt(face, x:number, y:number) -> null|'hole'|'spike'|'ceil'`: y는 바닥에서의 발 높이이다. 구멍은 y≤0일 때만, 가시는 y<0.6일 때, 낮은 천장은 y>1.4일 때 걸린다.
  - `scoreOf(dist:number, stars:number) -> number` = `floor(dist) + stars*CFG.starPts`
  - `stageOf(dist:number) -> number` = `max(1, min(999, floor(dist/100)))` (서버의 km10 단위)

- [ ] **Step 1: 테스트 작성** — `tests/binggeul-core.test.js`

  HTML에서 CORE 블록을 꺼내 `vm.runInNewContext`로 실행하는 `loadCore()` 도우미를 둔다(`/\/\/ ==CORE==([\s\S]*?)\/\/ ==\/CORE==/`). 블록 끝에 `globalThis.CORE={CFG,speedAt,...}`가 있다고 가정한다. 테스트는 다음과 같다.
  ```js
  test('speedAt starts at 9 and caps at 26', () => {
    assert.equal(C.speedAt(0), 9); assert.equal(C.speedAt(250), 9 + 2*0.8);
    assert.equal(C.speedAt(100000), 26);
  });
  test('scoreOf / stageOf', () => {
    assert.equal(C.scoreOf(1234.9, 3), 1294);
    assert.equal(C.stageOf(0), 1); assert.equal(C.stageOf(1234), 12); assert.equal(C.stageOf(1e7), 999);
  });
  test('course fairness over 300 faces (seed 7)', () => {
    const rng = C.makeRng(7); let dist = 0;
    for (let i = 0; i < 300; i++) {
      const f = C.genFace(rng, dist), v = C.speedAt(dist);
      assert.equal(f.segs.at(-1).type, 'wall');
      assert.ok(f.len >= 60 && f.len <= 140);
      // 면 시작(벽 직후) 1초 달리는 거리는 평지
      for (const s of f.segs) if (s.type !== 'flat' && s.type !== 'wall') {
        assert.ok(s.x >= v * C.CFG.safeAfterWallSec, 'hazard too early ' + s.x);
        if (s.type === 'hole' || s.type === 'spike') assert.ok(s.len <= 0.7 * C.maxJumpLen(C.speedAt(dist + f.len)));
      }
      // 장애물 사이에는 착지할 평지가 2m 이상
      const hz = f.segs.filter(s => s.type !== 'flat' && s.type !== 'wall');
      for (let k = 1; k < hz.length; k++) assert.ok(hz[k].x - (hz[k-1].x + hz[k-1].len) >= 2);
      if (dist + f.len < C.CFG.hazardFrom) assert.ok(!f.segs.some(s => s.type === 'ceil'));
      dist += f.len;
    }
  });
  test('hazardAt', () => {
    const face = { segs: [{type:'flat',x:0,len:10},{type:'hole',x:10,len:3},{type:'spike',x:15,len:2},{type:'ceil',x:20,len:4},{type:'wall',x:30,len:0}] };
    assert.equal(C.hazardAt(face, 11, 0), 'hole'); assert.equal(C.hazardAt(face, 11, 0.5), null);
    assert.equal(C.hazardAt(face, 16, 0.3), 'spike'); assert.equal(C.hazardAt(face, 16, 1), null);
    assert.equal(C.hazardAt(face, 21, 2), 'ceil'); assert.equal(C.hazardAt(face, 21, 0), null);
    assert.equal(C.hazardAt(face, 5, 0), null);
  });
  ```

- [ ] **Step 2: 실패 확인** — `node --test tests/binggeul-core.test.js` → index.html이나 CORE 블록이 없어서 FAIL

- [ ] **Step 3: CORE 구현** — `index.html`에 `<!doctype html>`, 제목 `빙글빙글 달리기`, 그리고 `<script>` 안에 `// ==CORE==` 블록을 둔다. 조각 확률은 정해 둔다. 500m 전에는 평지와 구멍과 가시만, 500m부터는 낮은 천장도 나오고 장애물 사이 평지가 짧아진다. 별은 구멍과 가시 위 h=2.5에 1~3개, 평지에는 가끔 h=0.8에 놓는다. 블록 끝에 `globalThis.CORE = {...}`를 넣는다.

- [ ] **Step 4: 통과 확인** — `node --test tests/binggeul-core.test.js` → 4개 PASS

- [ ] **Step 5: 커밋** — `git add public/games/binggeul/index.html tests/binggeul-core.test.js && git commit -m "빙글빙글 달리기: 코스·속도·충돌 규칙"`

---

### Task 2: 서버 연결 (기록 검증, 게임 목록)

**Files:**
- Modify: `server.js:2046-2060` (`SCORE_CHECKS`)
- Modify: `public/games/games.json`
- Test: `tests/binggeul-server.test.js`

**Interfaces:**
- Consumes: Task 1의 `CFG.maxSpeed=26`, `CFG.starPts=20`
- Produces: POST `/api/games/binggeul/scores` body `{name, score, from:1, to:stageOf(dist), time, char}`

- [ ] **Step 1: 테스트 작성** — 테스트는 임시 폴더(`fs.mkdtempSync`)를 `DATA_DIR_OVERRIDE`로, 포트 4031을 `PORT`로 주고 `server.js`를 `child_process.spawn`한다. 서버가 뜰 때까지 GET을 재시도한 뒤 다음을 확인한다.
  - `{name:'테스트', score: 2600+20*60, from:1, to:26, time:100, char:'bing'}` → `ok:true` (최고 속도로 100초 동안 2.6km를 가고 별 60개를 먹은 경우)
  - `{..., to:40, time:100}` → `ok:false` (1초에 40m는 불가능)
  - `{..., score: 400*100, to:20, time:100}` → `ok:false`
  - `{..., from:2}` → `ok:false`
  
  끝나면 서버를 kill하고 임시 폴더를 지운다. 기록 POST는 10분에 10번 제한(`scoreLimiter`)이 있어서 POST는 이 네 번만 보낸다.

- [ ] **Step 2: 실패 확인** — `node --test tests/binggeul-server.test.js` → 게임 목록에 없어서 404 FAIL

- [ ] **Step 3: 구현**
  - `games.json` 맨 끝에 추가: `{"slug":"binggeul","title":"빙글빙글 달리기","desc":"쉬지 않고 달리는 작은 친구! 벽을 만나면 그대로 타고 올라가고 세상이 빙글 돌아요. 한 번 누르면 점프, 실수 한 번이면 끝. 옛날 휴대폰 액정 감성으로 최대한 멀리!","icon":"🌀","tags":["러너","원버튼","키보드·터치"],"added":"2026-10-21","stageUnit":"km10"}`
  - `SCORE_CHECKS`에 기존 형식대로 주석과 함께 추가: `binggeul: ({ score, from, to, time }) => from === 1 && to <= 1 + time * 0.3 && score <= 300 * time + 1000`. 주석에는 최고 속도가 1초에 26m라서 1초에 0.3(=30m)를 못 넘고, 거리 점수 26에 별을 1초에 최대 13개(20점) 먹어도 1초에 300점 안쪽이라는 근거를 적는다.

- [ ] **Step 4: 통과 확인** — `node --test tests/` → 전부 PASS

- [ ] **Step 5: 커밋** — `git add server.js public/games/games.json tests/binggeul-server.test.js && git commit -m "빙글빙글 달리기: 게임 목록과 기록 검증"`

---

### Task 3: 플레이 화면 (피처폰 액정, 달리기, 점프, 회전, 죽음)

**Files:**
- Modify: `public/games/binggeul/index.html`
- Modify: `/Users/joyeongjung/workspace/carcarcar/.claude/launch.json` (`healing-test-binggeul`: `node server.js`, `PORT=4031`, `DATA_DIR_OVERRIDE`=이 세션 scratchpad의 `data` 복사본)

**Interfaces:**
- Consumes: Task 1의 CORE 전부
- Produces:
  - `state: 'menu'|'play'|'dying'|'over'`, `run = {dist, stars, time, face, faceIdx, rot}`, `P = {x, y, vy, hold, onGround}`
  - `startRun()`, `jumpPress()`, `jumpRelease()`, `endRun(cause:'hole'|'spike'|'ceil')`. `endRun`은 `lastRun = {dist, stars, score, time, char, cause}`를 만들고 `onRunEnd()`를 부른다(Task 4가 채움).
  - `drawKid(g, ch, o)`: 발 밑이 원점이다. `o = {step, face:'calm'|'scared'|'dizzy'|'happy'}`, `ch`는 Task 4의 캐릭터 정의 `{id, shirt, hair, ...}`
  - 소리: `play(name)`, name은 `'jump'|'climb'|'star'|'die'|'win'`. 배경음은 `setMusic(on)`, 음소거는 `setMute(m)`이다. bureung의 `audio`/`tone`/`MUSIC` 구조를 복사해 8비트 사각파로 바꾼다.

- [ ] **Step 1: 화면 뼈대** — bureung의 `<head>`(테마, 글꼴, 다크모드, GA, `store`, `track`, `ONLINE`, `isTouch`)를 복사하고, 키를 `binggeul-side-`로 바꾼다. 무대는 다음과 같다.
  - CSS로 만든 피처폰 몸체(스피커 홈, 둥근 몸체, 아래 3×2 키패드)
  - 그 안의 `<canvas id="cv">` 액정. 논리 크기 240×300, 세로형
  - 키패드 버튼과 캔버스 모두 `pointerdown`이면 `jumpPress`, `pointerup`/`pointercancel`이면 `jumpRelease`
  - 스페이스와 ↑ 키도 같은 동작을 한다.

- [ ] **Step 2: 움직임** — 고정 dt(최대 0.05)로 매 프레임 갱신한다.
  - `run.dist += speedAt(run.dist)*dt`. 지금 면 안의 x도 같이 늘린다.
  - 점프는 땅에 있을 때만 된다(`vy=CFG.jumpV`). 누르고 있는 동안 위로 올라가는 중이면 중력을 `1-holdBoost`배로 줄인다.
  - `hazardAt`가 값을 돌려주면 `endRun`을 부른다.
  - x가 면 길이에 닿으면 `'climb'` 소리를 내고 `run.rot`을 0→1로 `rotateSec`에 걸쳐 올린다. 그동안 입력은 무시하고 x는 멈춘다. 끝나면 `faceIdx++`, 다음 면을 `genFace`로 만들고, x=0, y=0으로 둔다.
  - 지나간 면은 버리고, 지금 면과 다음 면만 들고 있는다.
  - `visibilitychange`로 숨겨지면 일시정지한다.

- [ ] **Step 3: 그리기**
  - 액정: 오프스크린(실제 크기의 1/3)에 팔레트로 그린다. 순서는 배경 건물(느린 패럴랙스), 바닥, 구멍, 가시, 낮은 천장, 앞쪽 벽, 별(반짝이는 도트), 속도선과 바닥 무늬(속도에 비례)이다. 그다음 `imageSmoothingEnabled=false`로 키운다.
  - 회전 연출: 세상을 `-ease(run.rot)*90°`로 돌린다(smoothstep). 피처폰 몸체에 CSS `transform: rotate()`로 최대 6° 흔들림을 준다.
  - 캐릭터: 키운 뒤 위에 고해상도로 `drawKid`를 그린다. 표정은 평소 calm, 다음 위험이 3m 안이면 scared, 죽을 때 dizzy이다.
  - HUD: 액정 위쪽에 고정폭 `String(floor(dist)).padStart(5,'0')+'m'`와 `★n`을 쓴다.
  - 죽음(`dying`): 0.6초 멈춤과 깜빡임 뒤 `over`로 넘어간다.

- [ ] **Step 4: 브라우저 확인** — `preview_start {name:"healing-test-binggeul"}` → `/games/binggeul/`
  - `read_console_messages onlyErrors` → 오류 없음
  - `javascript_tool`로 `startRun()` 뒤 2초 기다렸다가 `run.dist > 15`
  - 회전 확인: `run.face`의 x를 면 길이 직전으로 옮기고 0.6초 뒤 `run.faceIdx===1 && run.rot===0`
  - 회전 중 연타: rot 진행 중에 `jumpPress()`를 10번 → 회전이 끝난 뒤 `P.y===0`
  - 탭 숨김: `document.dispatchEvent(new Event('visibilitychange'))`를 `hidden` 흉내로 보내 일시정지 확인. 안 되면 `paused=true` 경로를 직접 확인한다.
  - 스크린샷 한 장을 남긴다.
  - 창이 가려져 rAF가 멈추면 메모리에 적어 둔 헤드리스 크롬 + CDP 방식으로 확인한다.

- [ ] **Step 5: 커밋** — `git add public/games/binggeul/index.html && git commit -m "빙글빙글 달리기: 피처폰 액정 플레이 화면"` (launch.json은 저장소 밖이라 커밋하지 않음)

---

### Task 4: 메뉴, 결과, 캐릭터 해금, 첫 판 안내

**Files:**
- Modify: `public/games/binggeul/index.html`

**Interfaces:**
- Consumes: Task 3의 `startRun`, `lastRun`, `onRunEnd`, `drawKid`
- Produces:
  - `CHARS = [{id:'bing', name:'빙글이', price:0, ...}, {id:'dal', name:'달순이', price:30}, {id:'ppi', name:'삐삐', price:80}, {id:'mung', name:'멍군', price:150}, {id:'star', name:'별똥이', price:300}]`. 색과 머리, 소품만 다르다.
  - `wallet`(별, `store 'stars'`), `owned`(`store 'owned'`, 기본 `['bing']`), `charId`(`store 'char'`)
  - `runs = {best: [], recent: []}`(`store 'runs'`). 각 항목은 `{score, dist, stars, char, date}`. best는 점수순 10개, recent는 최근 10개이다.

- [ ] **Step 1: 첫 화면과 결과 화면** — bureung의 `menuOv`/`overOv` 구조를 복사해 고친다.
  - 첫 화면: 지금 캐릭터 미리보기(`drawKid` happy), 최고 기록, 별 지갑, 버튼 [달리기] [캐릭터] [🏆 기록판], 소리와 음악 토글
  - 결과 화면: 원인 문구(구멍 "앗, 떨어졌어요!", 가시 "따끔!", 천장 "쿵!"), 거리 m, 별, 점수, 최고 기록이면 표시, 버튼 [다시 달리기] [📤 공유하기] [메인 메뉴], 그리고 전체 순위 올리기 칸(`gsub`)
  - `onRunEnd`는 지갑에 별을 더하고, `runs`를 갱신하고, `track('game_over', {dist, score})` 뒤 결과를 보여준다.

- [ ] **Step 2: 캐릭터 선택** — 카드에 캐릭터 그림, 이름, 가격을 넣는다.
  - 가진 캐릭터를 누르면 선택한다.
  - 못 가진 캐릭터를 누르면, 별이 충분할 때 사고 고르며 `play('win')`를 낸다. 부족하면 "별 N개 더 필요해요"를 보여준다.

- [ ] **Step 3: 첫 판 안내** — `store 'tutDone'`이 false면 첫 `startRun` 때 액정 위에 "누르면 점프! 벽은 그냥 달려가면 타요"를 띄우고, 첫 회전이 끝나면 지운 뒤 `tutDone=true`로 둔다.

- [ ] **Step 4: 브라우저 확인**
  - `javascript_tool`로 `wallet=100; renderChars()` 뒤 '달순이' 카드를 클릭 → `owned.includes('dal') && wallet===70`
  - 한 판을 일부러 끝낸다(`endRun('hole')`) → 결과 화면에 "앗, 떨어졌어요!"가 나오고 `runs.recent.length===1`
  - localStorage가 막힌 상황은 `store`가 try/catch로 감싸서 생략하되, 콘솔 오류는 없어야 한다.

- [ ] **Step 5: 커밋** — `git commit -am "빙글빙글 달리기: 메뉴·결과·캐릭터 해금"`

---

### Task 5: 기록판, 전체 순위 올리기, 공유

**Files:**
- Modify: `public/games/binggeul/index.html`

**Interfaces:**
- Consumes: Task 2의 POST 형식, Task 4의 `runs`, `CHARS`, `lastRun`
- Produces: `SCORE_API='/api/games/binggeul/scores'`, `SHARE_URL='https://swimpyonote.com/games/binggeul/'`

- [ ] **Step 1: 복사해 고치기** — bureung `index.html`에서 `/* 기록판 */`, `/* 전체 순위 올리기 */`, `/* 공유 */` 블록(1630~1728줄 근처)과 `rankOv` HTML을 가져온다. 고칠 부분은 다음과 같다.
  - 행 표시: 로컬 탭은 `${r.dist}m · 캐릭터이름 · ★${r.stars}`, 전체/이번 주 탭은 `${(r.stage/10).toFixed(1)}km`
  - 올리는 run: `{score:lastRun.score, from:1, to:stageOf(lastRun.dist), time:Math.ceil(lastRun.time), char:lastRun.char}`
  - 공유 문구: `🌀 빙글빙글 달리기에서 ${dist}m 달렸어요! (★${stars})` + 순위 줄 + `나보다 멀리 갈 수 있어?`

- [ ] **Step 2: 브라우저 확인** — 테스트 서버(4031)에서 한 판을 끝낸다. `lastRun`을 300m, 40초로 만들어 `offerGlobal('over')`를 부른다.
  - `gsub`가 보인다.
  - 닉네임 "테스트"로 올리면 "전체 1위" 문구가 나온다.
  - 기록판 '전체' 탭에 `0.3km`가 보인다.
  - `read_network_requests`에서 POST 201/200을 확인한다.

- [ ] **Step 3: 커밋** — `git commit -am "빙글빙글 달리기: 기록판·전체 순위·공유"`

---

### Task 6: og.png와 마무리

**Files:**
- Create: `public/games/binggeul/og.png`
- Modify: `public/games/binggeul/index.html` (`og:image`, `og:title`, `og:description` 메타. bureung과 같은 형식)

- [ ] **Step 1: og.png** — 1200×630에 피처폰 액정 장면, 캐릭터, Jua 제목 "빙글빙글 달리기"를 넣는다.
  - 임시 HTML을 scratchpad에 만들고, 크롬 헤드리스 `--screenshot --window-size=1200,630`으로 캡처한다.
  - Jua는 `document.fonts.load('..px Jua', '빙글빙글 달리기')`로 미리 받는다.

- [ ] **Step 2: 마지막 확인**
  - `node --test tests/` → 전부 PASS
  - `/games/` 허브에 🌀 카드가 보인다.
  - 운영자 화면(`public/index.html`) 드롭다운에 '빙글빙글 달리기'가 있고 기록이 `N.Nkm`으로 표시된다.
  - 모바일 크기(`resize_window mobile`)에서 피처폰이 화면 안에 들어오고 가로 스크롤이 없다.
  - 다크모드를 확인한다.
  - `grep -n TESTONLY public/games/binggeul/index.html` → 결과 없음

- [ ] **Step 3: 커밋** — `git add public/games/binggeul/og.png && git commit -am "빙글빙글 달리기: 미리보기 이미지"`. 푸시는 사용자에게 물어본 뒤에 한다.
