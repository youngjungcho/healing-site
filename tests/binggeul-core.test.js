// 빙글빙글 달리기: index.html의 // ==CORE== 블록(그림·소리와 무관한 규칙)만 꺼내 돌려 보는 테스트
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadCore() {
  const html = fs.readFileSync(path.join(__dirname, '../public/games/binggeul/index.html'), 'utf8');
  const m = html.match(/\/\/ ==CORE==([\s\S]*?)\/\/ ==\/CORE==/);
  assert.ok(m, 'CORE 블록이 없음');
  const ctx = {};
  vm.runInNewContext(m[1] + '\nglobalThis.__CORE = CORE;', ctx);
  return ctx.__CORE;
}
const C = loadCore();

test('speedAt starts at 9 and caps at 26', () => {
  assert.equal(C.speedAt(0), 9);
  assert.equal(C.speedAt(250), 9 + 2 * 0.8);
  assert.equal(C.speedAt(100000), 26);
});

test('scoreOf / stageOf', () => {
  assert.equal(C.scoreOf(1234.9, 3), 1294);
  assert.equal(C.stageOf(0), 1);
  assert.equal(C.stageOf(1234), 12);
  assert.equal(C.stageOf(1e7), 999);
});

test('course fairness over 300 faces (seed 7)', () => {
  const rng = C.makeRng(7);
  let dist = 0;
  for (let i = 0; i < 300; i++) {
    const f = C.genFace(rng, dist), v = C.speedAt(dist);
    assert.equal(f.segs.at(-1).type, 'wall');
    assert.ok(f.len >= 60 && f.len <= 140, 'face len ' + f.len);
    // 면 시작(벽 직후) 1초 달리는 거리는 평지
    for (const s of f.segs) if (s.type !== 'flat' && s.type !== 'wall') {
      assert.ok(s.x >= v * C.CFG.safeAfterWallSec, 'hazard too early ' + s.x);
      if (s.type === 'hole' || s.type === 'spike') assert.ok(s.len <= 0.7 * C.maxJumpLen(C.speedAt(dist + f.len)), 'too long ' + s.len);
    }
    // 장애물 사이에는 착지할 평지가 2m 이상
    const hz = f.segs.filter(s => s.type !== 'flat' && s.type !== 'wall');
    for (let k = 1; k < hz.length; k++) assert.ok(hz[k].x - (hz[k - 1].x + hz[k - 1].len) >= 2);
    // 벽 앞에도 착지할 평지
    if (hz.length) assert.ok(f.len - (hz.at(-1).x + hz.at(-1).len) >= 2);
    if (dist + f.len < C.CFG.hazardFrom) assert.ok(!f.segs.some(s => s.type === 'ceil'));
    dist += f.len;
  }
});

test('hazardAt', () => {
  const face = { segs: [{ type: 'flat', x: 0, len: 10 }, { type: 'hole', x: 10, len: 3 }, { type: 'spike', x: 15, len: 2 }, { type: 'ceil', x: 20, len: 4 }, { type: 'wall', x: 30, len: 0 }] };
  assert.equal(C.hazardAt(face, 11, 0), 'hole');
  assert.equal(C.hazardAt(face, 11, 0.5), null);
  assert.equal(C.hazardAt(face, 16, 0.3), 'spike');
  assert.equal(C.hazardAt(face, 16, 1), null);
  assert.equal(C.hazardAt(face, 21, 2), 'ceil');
  assert.equal(C.hazardAt(face, 21, 0), null);
  assert.equal(C.hazardAt(face, 5, 0), null);
});
