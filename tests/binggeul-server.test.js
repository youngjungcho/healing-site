// 빙글빙글 달리기: 기록 저장 API가 binggeul 기록을 SCORE_CHECKS 규칙대로 받고 거절하는지
// 임시 데이터 폴더로 server.js를 띄워서 확인함. 기록 POST는 10분에 10번 제한이 있어서 네 번만 보냄
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 4031;
const API = `http://127.0.0.1:${PORT}/api/games/binggeul/scores`;

let srv, dir;
test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'binggeul-'));
  const banned = path.join(ROOT, 'data/bannedWords.json');
  if (fs.existsSync(banned)) fs.copyFileSync(banned, path.join(dir, 'bannedWords.json'));
  srv = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR_OVERRIDE: dir }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { await fetch(API); return; } catch (e) { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
});
test.after(() => { srv && srv.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

const post = body => fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '테스트', char: 'bing', from: 1, ...body }) }).then(r => r.json());

test('accepts a run at top speed for 100s with 60 stars', async () => {
  const d = await post({ score: 2600 + 20 * 60, to: 26, time: 100 });
  assert.equal(d.ok, true, d.message);
});
test('rejects 40m per second', async () => {
  assert.equal((await post({ score: 4000, to: 40, time: 100 })).ok, false);
});
test('rejects 400 points per second', async () => {
  assert.equal((await post({ score: 400 * 100, to: 20, time: 100 })).ok, false);
});
test('rejects runs not starting at stage 1', async () => {
  assert.equal((await post({ score: 1000, from: 2, to: 10, time: 100 })).ok, false);
});
