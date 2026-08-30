const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');

const app = express();
const PORT = process.env.PORT || 3000;

// ---- 무차별 대입·스팸 방지용 요청 제한 ----
// IP 기준으로 세는 가벼운 방식. 실제 서비스에서 프록시/로드밸런서 뒤에 두면
// trust proxy 설정도 함께 확인해야 정확한 IP로 카운트돼요.
// 개발 중(localhost)에는 같은 사람이 반복 테스트하다 금방 막혀서 오히려 방해가 되므로,
// NODE_ENV=production일 때만 실제로 제한을 걸어요.
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
function rateLimitJson(message) {
  return { ok: false, message };
}
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => !IS_PRODUCTION,
  message: rateLimitJson('로그인 시도가 너무 많아요. 15분 후 다시 시도해주세요.'),
});
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => !IS_PRODUCTION,
  message: rateLimitJson('회원가입 시도가 너무 많아요. 잠시 후 다시 시도해주세요.'),
});
const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => !IS_PRODUCTION,
  message: rateLimitJson('비밀번호 찾기 요청이 너무 많아요. 잠시 후 다시 시도해주세요.'),
});

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const POSTS_FILE = path.join(DATA_DIR, 'posts.json');
const BOARDS_FILE = path.join(DATA_DIR, 'boards.json');

// ---- 소셜 로그인 설정 ----
// .env 파일에 아래 값들을 채워야 카카오/구글 로그인이 동작해요. (README.md 참고)
const KAKAO_CLIENT_ID = process.env.KAKAO_CLIENT_ID || '';
const KAKAO_REDIRECT_URI = process.env.KAKAO_REDIRECT_URI || `http://localhost:${PORT}/auth/kakao/callback`;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/auth/google/callback`;

// ---- 이메일 발송 설정 (인증 메일 · 비밀번호 재설정) ----
const GMAIL_USER = process.env.GMAIL_USER || '';
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || '';
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24시간
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1시간

const mailTransporter = (GMAIL_USER && GMAIL_APP_PASSWORD)
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    })
  : null;

// Gmail 계정이 설정되지 않은 개발 환경에서는 실제 발송 대신 콘솔에 링크를 출력해요.
async function sendMail({ to, subject, html }) {
  if (!mailTransporter) {
    console.log(`\n[메일 발송 생략 — GMAIL_USER/GMAIL_APP_PASSWORD 미설정]\n받는 사람: ${to}\n제목: ${subject}\n${html}\n`);
    return;
  }
  await mailTransporter.sendMail({ from: `"쉼표" <${GMAIL_USER}>`, to, subject, html });
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ---- 이미지 업로드 (Cloudinary) ----
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || '';
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || '';
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || '';
const cloudinaryConfigured = !!(CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET);
if (cloudinaryConfigured) {
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
  });
}

// 업로드 파일은 디스크에 남기지 않고 메모리에서 바로 Cloudinary로 전달
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter(req, file, cb) {
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error('jpg, png, webp 형식의 이미지만 업로드할 수 있어요.'));
    }
    cb(null, true);
  },
});

function uploadBufferToCloudinary(buffer, folder) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({ folder }, (err, result) => {
      if (err) return reject(err);
      resolve(result.secure_url);
    });
    stream.end(buffer);
  });
}

// 실제 카카오/구글 서버 주소. 테스트 시에만 환경변수로 가짜 서버 주소를 넣어 검증해요.
const KAKAO_AUTH_BASE = process.env.KAKAO_AUTH_BASE || 'https://kauth.kakao.com';
const KAKAO_API_BASE = process.env.KAKAO_API_BASE || 'https://kapi.kakao.com';
const GOOGLE_AUTH_BASE = process.env.GOOGLE_AUTH_BASE || 'https://accounts.google.com';
const GOOGLE_TOKEN_URL = process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = process.env.GOOGLE_USERINFO_URL || 'https://www.googleapis.com/oauth2/v3/userinfo';

// ---- 운영자 / 신고·필터 정책 설정 ----
// .env의 ADMIN_EMAILS에 콤마로 구분해서 운영자 이메일을 등록하면, 그 계정으로 로그인했을 때
// 관리자 화면(신고 관리)에 접근할 수 있어요.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
function isAdminUser(user) {
  return !!(user && user.email && ADMIN_EMAILS.includes(String(user.email).toLowerCase()));
}
const REPORT_THRESHOLD = 3; // 이 횟수만큼 신고가 누적되면 자동 숨김
const REPORT_REASONS = ['욕설/비방', '광고', '신상 노출', '자해 조장', '기타'];
const SEVERE_REPORT_REASONS = new Set(['신상 노출', '자해 조장']);
const REPORT_SLA_MS = 24 * 60 * 60 * 1000; // 이 시간 안에 처리 안 되면 운영자에게 SLA 초과 메일 발송
const REPORT_SLA_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 이 주기로 SLA 초과 여부를 검사
const BANNED_WORDS_FILE = path.join(DATA_DIR, 'bannedWords.json');

// ---- 아주 가벼운 파일 기반 "DB" ----
// 데모/초기 검증 단계용입니다. 사용자가 늘어나면 실제 DB(PostgreSQL, MySQL 등)로 교체하는 것을 권장해요.
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]', 'utf8');

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(USERS_FILE, '[]', 'utf8');
  }
  return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
}
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

// ---- 게시판 목록 ----
// 게시판은 이제 코드가 아니라 data/boards.json에 저장돼요. 운영자 화면(운영자 > 게시판 관리)에서
// 추가·이름 변경·숨김·삭제를 직접 할 수 있어요. (처음 사용자가 제안한 5개로 시작함)
const DEFAULT_BOARDS = [
  { slug: 'diary', title: '오늘 하루 끄적끄적', category: '감정 · 마음', tag: '매일 쓰기 좋은',
    description: '거창하지 않아도 괜찮아요. 오늘 있었던 일을 편하게 남겨보세요.', hidden: false, order: 1 },
  { slug: 'comfort-self', title: '나에게 스스로 위로하는 말', category: '감정 · 마음', tag: '서로 위로',
    description: '오늘의 나에게 건네고 싶은 한마디를 적어보세요.', hidden: false, order: 2 },
  { slug: 'comfort-others', title: '누군가에게 위로를 건네고 싶은 말', category: '감정 · 마음', tag: '서로 위로',
    description: '얼굴 모르는 누군가에게, 조용히 마음을 전해보세요.', hidden: false, order: 3 },
  { slug: 'hobby', title: '내가 만든 취미 자랑', category: '감각 · 속도 늦추기', tag: '기록',
    description: '완벽하지 않아도 좋아요. 내가 만든 것을 자랑해보세요.', hidden: false, order: 4 },
  { slug: 'quote', title: '책 한 소절, 명대사', category: '감각 · 속도 늦추기', tag: '필사',
    description: '마음에 오래 남았던 문장을 남겨보세요.', hidden: false, order: 5 },
];

function loadBoards() {
  if (!fs.existsSync(BOARDS_FILE)) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(BOARDS_FILE, JSON.stringify(DEFAULT_BOARDS, null, 2), 'utf8');
  }
  return JSON.parse(fs.readFileSync(BOARDS_FILE, 'utf8'));
}
function saveBoards(boards) {
  fs.writeFileSync(BOARDS_FILE, JSON.stringify(boards, null, 2), 'utf8');
}
function getBoard(slug) {
  return loadBoards().find(b => b.slug === slug) || null;
}

function slugify(title) {
  const s = String(title || '').trim().toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || 'board';
}
function uniqueBoardSlug(base, boards) {
  let slug = base;
  let n = 2;
  while (boards.some(b => b.slug === slug)) {
    slug = `${base}-${n}`;
    n += 1;
  }
  return slug;
}

// 게시판별 초기 시드 글 (처음 서버를 켰을 때만 채워짐)
const SEED_POSTS = [
  { id: 1198, board: 'diary', title: '오늘은 조금 울었다', writerNickname: '익명', writerId: null, hearts: 30, views: 88,
    body: '그냥 오늘따라 마음이 무거웠어요.\n그래도 여기 와서 몇 줄 적으니까 조금 나아지네요.', comments: [
      { id: 1, writerNickname: '구름한점', writerId: null, body: '많이 힘드셨겠어요. 오늘 하루도 잘 견뎌내셨어요.', hearts: 6, createdAt: '2026-08-20T08:16:00.000Z' },
    ], createdAt: '2026-08-20T08:15:00.000Z' },
  { id: 1199, board: 'diary', title: '별 거 아닌데 기분 좋았던 순간', writerNickname: '산책러', writerId: null, hearts: 6, views: 41,
    body: '출근길에 강아지가 인사해주고 갔어요. 그것만으로 하루가 좀 밝아지네요.', comments: [], createdAt: '2026-08-20T08:47:00.000Z' },
  { id: 1200, board: 'diary', title: '오늘 하루도 버텼다, 나 자신 칭찬', writerNickname: '익명', writerId: null, hearts: 15, views: 63,
    body: '힘든 하루였지만 결국 다 해냈다. 잘했다, 나.', comments: [
      { id: 1, writerNickname: '늦은오후', writerId: null, body: '정말 잘하셨어요! 오늘 하루도 애쓰셨습니다.', hearts: 4, createdAt: '2026-08-20T09:03:00.000Z' },
    ], createdAt: '2026-08-20T09:02:00.000Z' },
  { id: 1201, board: 'diary', title: '비 오는 소리 듣다가 잠들었어요', writerNickname: '빗소리', writerId: null, hearts: 8, views: 37,
    body: '창문 열어두고 빗소리 들으면서 낮잠 잤는데 정말 오랜만에 개운했어요.', comments: [], createdAt: '2026-08-20T09:31:00.000Z' },
  { id: 1202, board: 'diary', title: '퇴근길에 혼잣말로 잘했다고 했어요', writerNickname: '늦은오후', writerId: null, hearts: 21, views: 214,
    body: '오늘 유독 힘든 하루였는데, 지하철역까지 걸으면서 혼잣말로 "오늘도 잘했다"고 해줬어요.\n\n누가 들으면 이상하다고 할 수도 있는데, 저는 그 말 한마디가 하루를 버티게 해주더라고요.\n다들 오늘 하루도 정말 고생 많으셨어요.', comments: [
      { id: 1, writerNickname: '구름한점', writerId: null, body: '저도 오늘 그렇게 해봐야겠어요. 감사해요 :)', hearts: 5, createdAt: '2026-08-20T10:00:00.000Z' },
      { id: 2, writerNickname: '익명', writerId: null, body: '이 글 보고 눈물 날 뻔했어요. 저도 잘했어요, 우리.', hearts: 9, createdAt: '2026-08-20T10:05:00.000Z' },
      { id: 3, writerNickname: '산책러', writerId: null, body: '오늘 하루도 애쓰셨어요 :)', hearts: 3, createdAt: '2026-08-20T10:10:00.000Z' },
    ], createdAt: '2026-08-20T09:58:00.000Z' },
  { id: 1203, board: 'diary', title: '오늘은 그냥 아무것도 안 했다', writerNickname: '익명', writerId: null, hearts: 4, views: 29,
    body: '가끔은 아무것도 안 하는 것도 필요한 것 같아요.', comments: [], createdAt: '2026-08-20T10:20:00.000Z' },
  { id: 1204, board: 'diary', title: '오랜만에 하늘이 예쁘더라', writerNickname: '구름한점', writerId: null, hearts: 12, views: 55,
    body: '퇴근하고 올려다본 하늘이 오늘따라 예뻤어요. 사진으로 다 담기지 않아서 아쉽네요.', comments: [
      { id: 1, writerNickname: '산책러', writerId: null, body: '오늘 하늘 진짜 예뻤죠 ㅎㅎ', hearts: 2, createdAt: '2026-08-20T10:43:00.000Z' },
    ], createdAt: '2026-08-20T10:42:00.000Z' },

  { id: 1210, board: 'hobby', title: '반년 걸려서 뜨개질로 목도리 완성했어요', writerNickname: '실뭉치', writerId: null, hearts: 18, views: 52,
    body: '처음 해보는 뜨개질이라 코도 많이 빠뜨렸는데, 그래도 완성하고 나니 뿌듯하네요. 삐뚤빼뚤해도 제가 만든 거라 더 좋아요.', comments: [
      { id: 1, writerNickname: '산책러', writerId: null, body: '와 대단하세요! 색깔도 예뻐요.', hearts: 3, createdAt: '2026-08-20T11:20:00.000Z' },
    ], createdAt: '2026-08-20T11:10:00.000Z' },
  { id: 1211, board: 'hobby', title: '베란다에서 상추 처음 수확했어요', writerNickname: '초록손가락', writerId: null, hearts: 9, views: 30,
    body: '씨앗 심은 지 한 달 만에 상추 몇 장 땄어요. 저녁에 쌈으로 먹었는데 유난히 맛있더라고요.', comments: [], createdAt: '2026-08-20T12:00:00.000Z' },

  { id: 1220, board: 'quote', title: '어린 왕자에서 오래 남는 문장', writerNickname: '책벌레', writerId: null, hearts: 25, views: 70,
    body: '"가장 중요한 건 눈에 보이지 않아." 이 문장 하나로 며칠을 곱씹었던 적이 있어요.', comments: [
      { id: 1, writerNickname: '늦은오후', writerId: null, body: '저도 이 책 읽을 때마다 다르게 다가와요.', hearts: 4, createdAt: '2026-08-20T13:05:00.000Z' },
    ], createdAt: '2026-08-20T13:00:00.000Z' },
  { id: 1221, board: 'quote', title: '영화 리틀 포레스트 마지막 대사', writerNickname: '구름한점', writerId: null, hearts: 14, views: 44,
    body: '"모든 건 다 때가 있다"는 말이 오늘따라 위로가 됐어요. 조급해하지 않아도 괜찮다고 해주는 것 같아서.', comments: [], createdAt: '2026-08-20T13:40:00.000Z' },

  { id: 1230, board: 'comfort-self', title: '오늘의 나에게', writerNickname: '익명', writerId: null, hearts: 20, views: 58,
    body: '오늘도 무너지지 않고 하루를 다 채워줘서 고마워. 내일은 조금 더 쉬어가도 괜찮아.', comments: [
      { id: 1, writerNickname: '빗소리', writerId: null, body: '이 글 보고 저도 저한테 이렇게 말해줘야겠다 싶었어요.', hearts: 5, createdAt: '2026-08-20T14:10:00.000Z' },
    ], createdAt: '2026-08-20T14:00:00.000Z' },
  { id: 1231, board: 'comfort-self', title: '잘하고 있다는 증거는 없어도', writerNickname: '산책러', writerId: null, hearts: 11, views: 33,
    body: '증거가 없어도, 그냥 오늘 버틴 것만으로도 충분하다고 스스로에게 말해주고 싶어요.', comments: [], createdAt: '2026-08-20T14:30:00.000Z' },

  { id: 1240, board: 'comfort-others', title: '지금 힘든 시간을 보내고 있는 누군가에게', writerNickname: '늦은오후', writerId: null, hearts: 27, views: 61,
    body: '얼굴도 이름도 모르지만, 지금 이 글을 보고 있다면 오늘 하루도 정말 애쓰셨다고 말해주고 싶어요. 혼자가 아니에요.', comments: [
      { id: 1, writerNickname: '익명', writerId: null, body: '오늘 딱 필요했던 말이었어요. 감사해요.', hearts: 8, createdAt: '2026-08-20T15:20:00.000Z' },
    ], createdAt: '2026-08-20T15:10:00.000Z' },
  { id: 1241, board: 'comfort-others', title: '새벽에 잠 못 드는 분들께', writerNickname: '구름한점', writerId: null, hearts: 10, views: 27,
    body: '잠이 안 와서 뒤척이고 계신다면, 그 시간도 그냥 흘러가는 대로 두셔도 괜찮아요. 내일이 조금 늦게 시작돼도 괜찮으니까요.', comments: [], createdAt: '2026-08-20T15:50:00.000Z' },

  { id: 1250, board: 'gratitude', title: '오늘 감사했던 일 세 가지', writerNickname: '산책러', writerId: null, hearts: 14, views: 40,
    body: '1. 아침에 늦잠 안 잔 것\n2. 점심에 좋아하는 반찬이 나온 것\n3. 퇴근길에 노을이 예뻤던 것\n\n적어보니 별거 아닌데도 마음이 따뜻해지네요.', comments: [
      { id: 1, writerNickname: '구름한점', writerId: null, body: '이렇게 세 가지씩 적는 거 저도 해봐야겠어요.', hearts: 3, createdAt: '2026-08-21T08:20:00.000Z' },
    ], createdAt: '2026-08-21T08:10:00.000Z' },
  { id: 1251, board: 'gratitude', title: '별 거 아니지만 감사한 것들', writerNickname: '늦은오후', writerId: null, hearts: 9, views: 25,
    body: '오늘도 무사히 하루를 마쳤다는 것, 따뜻한 물로 샤워할 수 있었다는 것, 그리고 이렇게 글을 남길 곳이 있다는 것.', comments: [], createdAt: '2026-08-21T08:45:00.000Z' },
  { id: 1252, board: 'gratitude', title: '오늘은 이 세 가지', writerNickname: '익명', writerId: null, hearts: 7, views: 19,
    body: '1. 엄마가 보내준 문자 한 줄\n2. 회사 앞 카페 아메리카노\n3. 집에 와서 마신 시원한 물 한 잔', comments: [
      { id: 1, writerNickname: '빗소리', writerId: null, body: '엄마 문자 저도 오늘 받았는데 반가워요 ㅎㅎ', hearts: 2, createdAt: '2026-08-21T09:30:00.000Z' },
    ], createdAt: '2026-08-21T09:15:00.000Z' },

  { id: 1255, board: 'self-praise', title: '오늘도 미루지 않고 해냈다', writerNickname: '구름한점', writerId: null, hearts: 16, views: 38,
    body: '하기 싫었던 일인데 결국 다 끝냈다. 잘했다 나, 정말.', comments: [], createdAt: '2026-08-21T10:00:00.000Z' },
  { id: 1256, board: 'self-praise', title: '거절할 줄 알게 된 나를 칭찬해', writerNickname: '산책러', writerId: null, hearts: 22, views: 51,
    body: '예전 같으면 그냥 다 받아줬을 텐데, 오늘은 무리한 부탁을 정중히 거절했어요. 나 좀 컸다.', comments: [
      { id: 1, writerNickname: '늦은오후', writerId: null, body: '멋져요! 그거 진짜 어려운 건데.', hearts: 5, createdAt: '2026-08-21T10:40:00.000Z' },
    ], createdAt: '2026-08-21T10:20:00.000Z' },
  { id: 1257, board: 'self-praise', title: '작은 습관 3일째 지키는 중', writerNickname: '익명', writerId: null, hearts: 8, views: 22,
    body: '매일 물 2리터 마시기, 겨우 3일이지만 꾸준히 하고 있는 나 칭찬해주고 싶어요.', comments: [], createdAt: '2026-08-21T11:05:00.000Z' },

  { id: 1260, board: 'anonymous-worry', title: '요즘 자꾸 비교하게 돼요', writerNickname: '익명', writerId: null, hearts: 12, views: 47,
    body: 'SNS 보다 보면 다들 잘 사는 것 같아서 자꾸 나만 뒤처지는 기분이 들어요. 다른 사람들도 이런 생각 하시나요.', comments: [
      { id: 1, writerNickname: '익명', writerId: null, body: '저도 그래요. SNS는 원래 좋은 순간만 올리는 거니까 너무 비교하지 않으셨으면 좋겠어요.', hearts: 6, createdAt: '2026-08-21T12:10:00.000Z' },
      { id: 2, writerNickname: '빗소리', writerId: null, body: '조언 아니고 그냥 공감만 남길게요. 저도 요즘 딱 그런 마음이에요.', hearts: 4, createdAt: '2026-08-21T12:25:00.000Z' },
    ], createdAt: '2026-08-21T12:00:00.000Z' },
  { id: 1261, board: 'anonymous-worry', title: '이직 고민 중인데 자신이 없어요', writerNickname: '익명', writerId: null, hearts: 9, views: 33,
    body: '지금 회사도 지치는데 막상 이직하려니 겁이 나요. 이런 마음 아시는 분 있을까요.', comments: [
      { id: 1, writerNickname: '초록손가락', writerId: null, body: '그 마음 너무 잘 알아요. 천천히 생각하셔도 괜찮아요.', hearts: 3, createdAt: '2026-08-21T13:15:00.000Z' },
    ], createdAt: '2026-08-21T13:00:00.000Z' },

  { id: 1265, board: 'transcription', title: '무소유 중에서', writerNickname: '책벌레', writerId: null, hearts: 19, views: 44,
    body: '"버리고 비우는 일은 얻고 채우는 일보다 어렵고 중요하다." 이 문장 필사하면서 마음이 차분해졌어요.', comments: [], createdAt: '2026-08-21T14:00:00.000Z' },
  { id: 1266, board: 'transcription', title: '나태주 시인의 풀꽃', writerNickname: '구름한점', writerId: null, hearts: 24, views: 60,
    body: '"자세히 보아야 예쁘다. 오래 보아야 사랑스럽다. 너도 그렇다."\n\n손글씨로 옮겨 적으니 문장이 더 오래 마음에 남네요.', comments: [
      { id: 1, writerNickname: '산책러', writerId: null, body: '이 시 정말 좋아해요. 필사하면 느낌이 또 다르네요.', hearts: 5, createdAt: '2026-08-21T14:35:00.000Z' },
    ], createdAt: '2026-08-21T14:20:00.000Z' },

  { id: 1270, board: 'digital-detox', title: '오늘 스마트폰 대신 산책 1시간', writerNickname: '산책러', writerId: null, hearts: 15, views: 36,
    body: '핸드폰 집에 두고 동네 한 바퀴 걸었어요. 처음엔 허전했는데 나중엔 오히려 개운했어요.', comments: [], createdAt: '2026-08-21T15:00:00.000Z' },
  { id: 1271, board: 'digital-detox', title: '저녁 8시 이후 폰 안 보기 3일차', writerNickname: '늦은오후', writerId: null, hearts: 11, views: 28,
    body: '대신 책을 좀 읽었더니 잠도 더 잘 오는 것 같아요. 다들 해보세요, 생각보다 할 만해요.', comments: [
      { id: 1, writerNickname: '익명', writerId: null, body: '저도 오늘부터 도전해볼게요!', hearts: 2, createdAt: '2026-08-21T15:40:00.000Z' },
    ], createdAt: '2026-08-21T15:25:00.000Z' },

  { id: 1275, board: 'slow-routine', title: '아침마다 차 한 잔의 여유', writerNickname: '초록손가락', writerId: null, hearts: 13, views: 31,
    body: '눈뜨자마자 폰 보는 대신, 따뜻한 차 한 잔 우리면서 창밖 보는 시간을 만들었어요. 하루가 훨씬 차분하게 시작돼요.', comments: [], createdAt: '2026-08-21T16:00:00.000Z' },
  { id: 1276, board: 'slow-routine', title: '자기 전 10분 스트레칭', writerNickname: '빗소리', writerId: null, hearts: 10, views: 24,
    body: '별거 아닌데 이거 하나로 잠드는 속도가 확실히 달라졌어요. 다들 하루 10분 내보시길.', comments: [
      { id: 1, writerNickname: '실뭉치', writerId: null, body: '저도 해봤는데 진짜 효과 있더라고요!', hearts: 3, createdAt: '2026-08-21T16:35:00.000Z' },
    ], createdAt: '2026-08-21T16:20:00.000Z' },

  { id: 1280, board: 'small-kindness', title: '버스에서 자리 양보받았어요', writerNickname: '익명', writerId: null, hearts: 17, views: 39,
    body: '짐이 많아 힘들어 보였는지 학생이 자리를 양보해줬어요. 별거 아닌데 하루 종일 기분이 좋았어요.', comments: [
      { id: 1, writerNickname: '구름한점', writerId: null, body: '따뜻한 학생이네요 :) 저도 오늘 누군가에게 양보해야겠어요.', hearts: 4, createdAt: '2026-08-22T08:20:00.000Z' },
    ], createdAt: '2026-08-22T08:10:00.000Z' },
  { id: 1281, board: 'small-kindness', title: '편의점 알바생분이 우산을 빌려주셨어요', writerNickname: '산책러', writerId: null, hearts: 20, views: 45,
    body: '갑자기 비가 왔는데 알바생분이 여분 우산을 그냥 빌려주셨어요. 다음에 꼭 돌려드리려고요. 세상 아직 따뜻하네요.', comments: [], createdAt: '2026-08-22T08:50:00.000Z' },

  { id: 1285, board: 'playlist', title: '비 오는 날 듣기 좋은 노래', writerNickname: '늦은오후', writerId: null, hearts: 18, views: 42,
    body: '오늘처럼 비 오는 날엔 잔잔한 어쿠스틱 노래가 최고예요. 창밖 보면서 듣기 딱 좋아요.', comments: [
      { id: 1, writerNickname: '빗소리', writerId: null, body: '저도 비 오는 날엔 어쿠스틱만 들어요 ㅎㅎ', hearts: 3, createdAt: '2026-08-22T09:30:00.000Z' },
    ], createdAt: '2026-08-22T09:10:00.000Z' },
  { id: 1286, board: 'playlist', title: '요즘 마시는 캐모마일 차 추천', writerNickname: '초록손가락', writerId: null, hearts: 8, views: 20,
    body: '잠들기 전에 캐모마일 차 한 잔 마시면 확실히 마음이 편안해져요. 은은한 향도 좋고요.', comments: [], createdAt: '2026-08-22T09:50:00.000Z' },

  { id: 1290, board: 'goodnight', title: '오늘 하루도 고생 많으셨어요', writerNickname: '구름한점', writerId: null, hearts: 26, views: 55,
    body: '여기까지 읽어주신 분들, 오늘 하루도 정말 애쓰셨어요. 편안한 밤 되세요.', comments: [
      { id: 1, writerNickname: '익명', writerId: null, body: '따뜻한 인사 감사해요. 좋은 밤 되세요 :)', hearts: 6, createdAt: '2026-08-22T22:20:00.000Z' },
    ], createdAt: '2026-08-22T22:10:00.000Z' },
  { id: 1291, board: 'goodnight', title: '내일은 오늘보다 조금 더 편안하시길', writerNickname: '산책러', writerId: null, hearts: 15, views: 34,
    body: '오늘 힘드셨던 분들 모두, 내일은 오늘보다 조금이라도 편안한 하루 되시길 바라요. 잘 자요.', comments: [], createdAt: '2026-08-22T22:45:00.000Z' },
];

function loadPosts() {
  if (!fs.existsSync(POSTS_FILE)) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(POSTS_FILE, JSON.stringify(SEED_POSTS, null, 2), 'utf8');
  }
  return JSON.parse(fs.readFileSync(POSTS_FILE, 'utf8'));
}
function savePosts(posts) {
  fs.writeFileSync(POSTS_FILE, JSON.stringify(posts, null, 2), 'utf8');
}

function publicPost(p) {
  // 목록용: 본문 전체는 빼고 요약 정보만
  return {
    id: p.id, board: p.board || 'diary', title: p.title, writerNickname: p.writerNickname,
    hearts: p.hearts, views: p.views, commentCount: p.comments.length, createdAt: p.createdAt,
    hidden: !!p.hidden, hasImages: !!(p.images && p.images.length),
  };
}

// 신고 누적으로 숨겨진 댓글은 작성자 본인/운영자에게만 보이게 걸러냄
function visibleComments(comments, me) {
  return (comments || []).filter(c => !c.hidden || (me && (me.id === c.writerId || isAdminUser(me))));
}

// 글/댓글 목록에 작성자의 "지금" 프로필 사진을 붙여줌. 익명으로 표시되는 글·댓글은
// 작성자를 특정할 수 없어야 하므로 프로필 사진도 붙이지 않음.
// users를 미리 불러와서 넘기면(같은 요청 안에서 여러 항목 처리할 때) 반복 조회를 피할 수 있음
function attachWriterProfileImages(items, users) {
  const list = users || loadUsers();
  return items.map(item => {
    if (item.writerNickname === '익명' || !item.writerId) {
      return { ...item, writerProfileImage: null };
    }
    const writer = list.find(u => u.id === item.writerId);
    return { ...item, writerProfileImage: (writer && writer.profileImage) || null };
  });
}

// ---- 금칙어 필터 ----
// 초기 기본 금칙어 목록. data/bannedWords.json으로 저장되며, 운영자 화면(추후) 또는
// POST /api/admin/banned-words 로 계속 보완할 수 있어요. 초성/공백/특수문자로 우회하는
// 흔한 패턴도 같이 잡아내려고 정규화(normalize) 후 비교해요.
const DEFAULT_BANNED_WORDS = [
  '씨발', '시발', 'ㅅㅂ', 'ㅄ', '병신', 'ㅂㅅ', '미친놈', '미친년', '개새끼', '새끼야',
  '좆', '걸레', '창녀', '지랄', '닥쳐', 'ㅁㅊ', 'ㅗㅜㅑ', '꺼져', '죽어버려',
  'fuck', 'shit', 'bitch', 'asshole',
];

function loadBannedWords() {
  if (!fs.existsSync(BANNED_WORDS_FILE)) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(BANNED_WORDS_FILE, JSON.stringify(DEFAULT_BANNED_WORDS, null, 2), 'utf8');
  }
  return JSON.parse(fs.readFileSync(BANNED_WORDS_FILE, 'utf8'));
}
function saveBannedWords(words) {
  fs.writeFileSync(BANNED_WORDS_FILE, JSON.stringify(words, null, 2), 'utf8');
}

// 공백/기호/숫자를 지우고 소문자로 바꿔서, "시 발"/"시.발"/"시1발" 같은 우회 표기를 잡아냄
function normalizeForFilter(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\s\-_.,!?~^*()[\]{}'"|\\/+=<>0-9@#$%&:;`]/g, '');
}

// 걸리는 첫 금칙어를 반환 (없으면 null)
function findBannedWord(text) {
  const normalized = normalizeForFilter(text);
  if (!normalized) return null;
  const words = loadBannedWords();
  for (const w of words) {
    const nw = normalizeForFilter(w);
    if (nw && normalized.includes(nw)) return w;
  }
  return null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  name: 'healing.sid',
  secret: process.env.SESSION_SECRET || 'change-this-secret-before-real-deploy',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7일
  },
}));

// 카카오/구글 소셜 로그인 계정은 이미 검증된 이메일이라 처음부터 인증된 것으로 취급.
// 이메일 로그인 계정은 emailVerified 값을 그대로 따름 (회원가입 시 false로 시작).
function isEmailVerified(user) {
  if (!user) return false;
  if (user.provider && user.provider !== 'local') return true;
  return !!user.emailVerified;
}

function publicUser(u) {
  return {
    id: u.id, email: u.email, nickname: u.nickname, provider: u.provider || 'local', createdAt: u.createdAt,
    isAdmin: isAdminUser(u),
    banned: !!u.banned,
    sanctionUntil: u.sanctionUntil || null,
    emailVerified: isEmailVerified(u),
    profileImage: u.profileImage || null,
  };
}

// 제재 중인 계정인지 확인해서, 문제가 있으면 안내 메시지를 돌려줌 (없으면 null)
function sanctionMessage(user) {
  if (!user) return null;
  if (user.banned) return '이용 정책 위반으로 계정이 영구 정지되었어요.';
  if (user.sanctionUntil && new Date(user.sanctionUntil).getTime() > Date.now()) {
    const d = new Date(user.sanctionUntil);
    const dateStr = `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;
    return `신고 누적으로 ${dateStr}까지 글쓰기·댓글 작성이 제한돼요.`;
  }
  // 이메일 미인증은 더 이상 글쓰기·댓글을 막지 않음 (마이페이지에서 인증 여부만 안내)
  return null;
}

function getCurrentUser(req) {
  if (!req.session.userId) return null;
  const users = loadUsers();
  return users.find(u => u.id === req.session.userId) || null;
}

// 방문자를 구분하기 위한 식별자. 로그인했으면 계정 id, 아니면 세션 기준
// (신고·공감 중복 방지에 공통으로 사용)
function getVisitorId(req) {
  if (req.session.userId) return 'u:' + req.session.userId;
  req.session.visited = true; // 세션이 저장되도록 값 하나를 기록해둠
  return 's:' + req.sessionID;
}

// 카카오/구글 프로필로 기존 회원을 찾거나 새로 만듦.
// 같은 이메일로 이미 로컬 가입된 계정이 있으면 그 계정에 소셜 로그인을 연결해요.
function findOrCreateSocialUser(users, info) {
  let user = users.find(u => u.provider === info.provider && u.providerId === info.providerId);
  if (user) return user;

  if (info.email) {
    user = users.find(u => u.email === info.email);
    if (user) {
      user.provider = user.provider || info.provider;
      user.providerId = user.providerId || info.providerId;
      user.emailVerified = true; // 소셜 서비스가 이미 검증한 이메일이므로 함께 인증 처리
      return user;
    }
  }

  const newUser = {
    id: users.length ? Math.max(...users.map(u => u.id)) + 1 : 1,
    email: info.email || null,
    passwordHash: null, // 소셜 로그인 전용 계정은 비밀번호가 없음
    nickname: info.nickname || (info.provider === 'kakao' ? '카카오사용자' : '구글사용자'),
    provider: info.provider,
    providerId: info.providerId,
    createdAt: new Date().toISOString(),
  };
  users.push(newUser);
  return newUser;
}

function configMissingPage(name, envVars) {
  return `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px;line-height:1.7;max-width:520px;margin:0 auto;">
  <h2>${name} 로그인이 아직 설정되지 않았어요</h2>
  <p>프로젝트 폴더에 <code>.env</code> 파일을 만들고 아래 값을 채워주세요.</p>
  <pre style="background:#f4f1ea;padding:14px;border-radius:8px;">${envVars}</pre>
  <p>발급 방법은 <code>README.md</code>의 "소셜 로그인 설정하기"를 참고해주세요.</p>
  <a href="/">← 홈으로 돌아가기</a>
  </body>`;
}

function verifyEmailMailHtml(link) {
  return `<div style="font-family:sans-serif;line-height:1.7;">
    <p>안녕하세요, 쉼표예요.</p>
    <p>아래 링크를 눌러 이메일 인증을 완료해주세요. 인증을 마치면 글쓰기·댓글을 쓸 수 있어요.</p>
    <p><a href="${link}">${link}</a></p>
    <p>이 링크는 24시간 동안만 유효해요.</p>
  </div>`;
}

async function sendVerificationEmail(user) {
  const link = `${APP_BASE_URL}/verify-email?token=${user.verifyToken}`;
  await sendMail({ to: user.email, subject: '[쉼표] 이메일 인증을 완료해주세요', html: verifyEmailMailHtml(link) });
}

// 회원가입
app.post('/api/signup', signupLimiter, async (req, res) => {
  const { email, password, nickname } = req.body || {};

  if (!email || !EMAIL_RE.test(String(email).trim())) {
    return res.status(400).json({ ok: false, message: '올바른 이메일을 입력해주세요.' });
  }
  if (!password || String(password).length < 6) {
    return res.status(400).json({ ok: false, message: '비밀번호는 6자 이상이어야 해요.' });
  }
  const nick = (nickname && String(nickname).trim()) || '익명';

  const users = loadUsers();
  const normalizedEmail = String(email).trim().toLowerCase();
  if (users.some(u => u.email === normalizedEmail)) {
    return res.status(409).json({ ok: false, message: '이미 가입된 이메일이에요.' });
  }

  const newUser = {
    id: users.length ? Math.max(...users.map(u => u.id)) + 1 : 1,
    email: normalizedEmail,
    passwordHash: bcrypt.hashSync(String(password), 10),
    nickname: nick,
    emailVerified: false,
    verifyToken: generateToken(),
    verifyTokenExpires: new Date(Date.now() + EMAIL_VERIFY_TTL_MS).toISOString(),
    createdAt: new Date().toISOString(),
  };
  users.push(newUser);
  saveUsers(users);

  try {
    await sendVerificationEmail(newUser);
  } catch (err) {
    console.error('인증 메일 발송 실패:', err);
  }

  req.session.userId = newUser.id;
  res.json({ ok: true, user: publicUser(newUser) });
});

// 이메일 인증 링크 클릭
app.get('/verify-email', (req, res) => {
  const { token } = req.query;
  const users = loadUsers();
  const user = users.find(u => u.verifyToken && u.verifyToken === token);

  if (!user) {
    return res.status(400).send(verifyResultPage(false, '유효하지 않은 인증 링크예요.'));
  }
  if (user.emailVerified) {
    return res.send(verifyResultPage(true, '이미 인증이 완료된 계정이에요.'));
  }
  if (!user.verifyTokenExpires || new Date(user.verifyTokenExpires).getTime() < Date.now()) {
    return res.status(400).send(verifyResultPage(false, '인증 링크가 만료됐어요. 다시 요청해주세요.'));
  }

  user.emailVerified = true;
  user.verifyToken = null;
  user.verifyTokenExpires = null;
  saveUsers(users);
  res.send(verifyResultPage(true, '이메일 인증이 완료됐어요! 이제 글쓰기·댓글을 쓸 수 있어요.'));
});

function verifyResultPage(success, message) {
  return `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px;line-height:1.7;max-width:520px;margin:0 auto;">
  <h2>${success ? '인증 완료' : '인증 실패'}</h2>
  <p>${message}</p>
  <a href="/">← 홈으로 돌아가기</a>
  </body>`;
}

// 로그인
app.post('/api/login', loginLimiter, (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ ok: false, message: '이메일과 비밀번호를 입력해주세요.' });
  }
  const users = loadUsers();
  const normalizedEmail = String(email).trim().toLowerCase();
  const user = users.find(u => u.email === normalizedEmail);

  // 이메일이 없을 때와 비밀번호가 틀렸을 때 메시지를 같게 해서, 가입 여부를 유추할 수 없게 함
  // (소셜 로그인 전용 계정은 passwordHash가 없어서 여기서 자연스럽게 거부됨)
  if (!user || !user.passwordHash || !bcrypt.compareSync(String(password), user.passwordHash)) {
    return res.status(401).json({ ok: false, message: '이메일 또는 비밀번호가 올바르지 않아요.' });
  }
  if (user.banned) {
    return res.status(403).json({ ok: false, message: '이용 정책 위반으로 영구 정지된 계정이에요.' });
  }

  req.session.userId = user.id;
  res.json({ ok: true, user: publicUser(user) });
});

// 로그아웃
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('healing.sid');
    res.json({ ok: true });
  });
});

function resetPasswordMailHtml(link) {
  return `<div style="font-family:sans-serif;line-height:1.7;">
    <p>안녕하세요, 쉼표예요.</p>
    <p>비밀번호 재설정을 요청하셨어요. 아래 링크를 눌러 새 비밀번호를 설정해주세요.</p>
    <p><a href="${link}">${link}</a></p>
    <p>본인이 요청하지 않았다면 이 메일을 무시하셔도 괜찮아요. 이 링크는 1시간 동안만 유효해요.</p>
  </div>`;
}

// 비밀번호 찾기: 이메일 입력 → 재설정 링크 발송.
// 가입 여부를 노출하지 않기 위해 계정이 없거나 소셜 전용 계정이어도 항상 같은 응답을 돌려줌.
app.post('/api/forgot-password', forgotPasswordLimiter, async (req, res) => {
  const { email } = req.body || {};
  if (!email || !EMAIL_RE.test(String(email).trim())) {
    return res.status(400).json({ ok: false, message: '올바른 이메일을 입력해주세요.' });
  }
  const normalizedEmail = String(email).trim().toLowerCase();
  const users = loadUsers();
  const user = users.find(u => u.email === normalizedEmail);

  if (user && user.passwordHash) {
    user.resetToken = generateToken();
    user.resetTokenExpires = new Date(Date.now() + PASSWORD_RESET_TTL_MS).toISOString();
    saveUsers(users);
    const link = `${APP_BASE_URL}/reset-password?token=${user.resetToken}`;
    try {
      await sendMail({ to: user.email, subject: '[쉼표] 비밀번호 재설정', html: resetPasswordMailHtml(link) });
    } catch (err) {
      console.error('비밀번호 재설정 메일 발송 실패:', err);
    }
  }

  res.json({ ok: true, message: '입력하신 이메일로 재설정 링크를 보냈어요. 메일함을 확인해주세요.' });
});

// 재설정 링크 클릭 시 보여줄 새 비밀번호 입력 폼
app.get('/reset-password', (req, res) => {
  const { token } = req.query;
  const users = loadUsers();
  const user = users.find(u => u.resetToken && u.resetToken === token
    && u.resetTokenExpires && new Date(u.resetTokenExpires).getTime() > Date.now());

  if (!user) {
    return res.status(400).send(verifyResultPage(false, '유효하지 않거나 만료된 링크예요. 비밀번호 찾기를 다시 요청해주세요.'));
  }
  res.send(`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px;line-height:1.7;max-width:420px;margin:0 auto;">
  <h2>새 비밀번호 설정</h2>
  <form id="f">
    <input type="hidden" id="token" value="${escapeHtmlServer(String(token))}">
    <input type="password" id="pw" placeholder="새 비밀번호 (6자 이상)" minlength="6" required style="width:100%;padding:10px;margin:8px 0;">
    <button type="submit" style="width:100%;padding:10px;">비밀번호 변경</button>
  </form>
  <p id="msg"></p>
  <script>
    document.getElementById('f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const token = document.getElementById('token').value;
      const password = document.getElementById('pw').value;
      const res = await fetch('/api/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      document.getElementById('msg').textContent = data.message || (data.ok ? '변경 완료' : '오류가 발생했어요.');
      if (data.ok) document.getElementById('f').style.display = 'none';
    });
  </script>
  </body>`);
});

// 새 비밀번호 저장
app.post('/api/reset-password', (req, res) => {
  const { token, password } = req.body || {};
  if (!password || String(password).length < 6) {
    return res.status(400).json({ ok: false, message: '비밀번호는 6자 이상이어야 해요.' });
  }
  const users = loadUsers();
  const user = users.find(u => u.resetToken && u.resetToken === token);
  if (!user || !user.resetTokenExpires || new Date(user.resetTokenExpires).getTime() < Date.now()) {
    return res.status(400).json({ ok: false, message: '유효하지 않거나 만료된 링크예요. 비밀번호 찾기를 다시 요청해주세요.' });
  }

  user.passwordHash = bcrypt.hashSync(String(password), 10);
  user.resetToken = null;
  user.resetTokenExpires = null;
  saveUsers(users);
  res.json({ ok: true, message: '비밀번호가 변경됐어요. 새 비밀번호로 로그인해주세요.' });
});

function escapeHtmlServer(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 로그인이 필요한 API에 붙이는 미들웨어
function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ ok: false, message: '로그인이 필요해요.' });
  }
  const users = loadUsers();
  const user = users.find(u => u.id === req.session.userId);
  if (!user) {
    return res.status(401).json({ ok: false, message: '로그인이 필요해요.' });
  }
  req.currentUser = user;
  next();
}

// 글쓰기/댓글처럼 실제로 콘텐츠를 남기는 API에 붙이는 미들웨어. 로그인은 물론
// 영구정지·일시제한 상태가 아닌지도 함께 확인함
function requireCanWrite(req, res, next) {
  requireAuth(req, res, () => {
    const msg = sanctionMessage(req.currentUser);
    if (msg) return res.status(403).json({ ok: false, message: msg });
    next();
  });
}

// 운영자 전용 API에 붙이는 미들웨어
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!isAdminUser(req.currentUser)) {
      return res.status(403).json({ ok: false, message: '운영자만 접근할 수 있어요.' });
    }
    next();
  });
}

// 현재 로그인한 사용자
app.get('/api/me', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ ok: false, message: '로그인이 필요해요.' });
  }
  const users = loadUsers();
  const user = users.find(u => u.id === req.session.userId);
  if (!user) {
    return res.status(401).json({ ok: false, message: '로그인이 필요해요.' });
  }
  res.json({ ok: true, user: publicUser(user) });
});

// 마이페이지: 내가 쓴 글 모아보기 (게시판 구분 포함, 최신순)
app.get('/api/me/posts', requireAuth, (req, res) => {
  const posts = loadPosts();
  const mine = posts
    .filter(p => p.writerId === req.currentUser.id)
    .slice()
    .sort((a, b) => b.id - a.id)
    .map(p => ({
      id: p.id,
      board: p.board || 'diary',
      boardTitle: (getBoard(p.board) || {}).title || p.board,
      title: p.title,
      hearts: p.hearts,
      commentCount: p.comments.length,
      hidden: !!p.hidden,
      createdAt: p.createdAt,
    }));
  res.json({ ok: true, posts: mine });
});

// 마이페이지: 내가 쓴 댓글 모아보기 (어느 글에 달았는지 포함, 최신순)
app.get('/api/me/comments', requireAuth, (req, res) => {
  const posts = loadPosts();
  const mine = [];
  posts.forEach(p => {
    (p.comments || []).forEach(c => {
      if (c.writerId === req.currentUser.id) {
        mine.push({
          postId: p.id,
          commentId: c.id,
          board: p.board || 'diary',
          boardTitle: (getBoard(p.board) || {}).title || p.board,
          postTitle: p.title,
          body: c.body,
          hidden: !!c.hidden,
          createdAt: c.createdAt,
        });
      }
    });
  });
  mine.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ ok: true, comments: mine });
});

// 신고 누적 제재(정지/일시제한) 상태만 안내하는 메시지. 이메일 미인증 안내는
// sanctionMessage와 달리 여기서는 다루지 않음 (마이페이지 제재 이력용).
function banOrLimitMessage(user) {
  if (!user) return null;
  if (user.banned) return '이용 정책 위반으로 계정이 영구 정지되었어요.';
  if (user.sanctionUntil && new Date(user.sanctionUntil).getTime() > Date.now()) {
    const d = new Date(user.sanctionUntil);
    const dateStr = `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;
    return `신고 누적으로 ${dateStr}까지 글쓰기·댓글 작성이 제한돼요.`;
  }
  return null;
}

// 마이페이지: 내 제재 이력 (현재 상태 + 누적 위반 횟수)
app.get('/api/me/sanctions', requireAuth, (req, res) => {
  const user = req.currentUser;
  res.json({
    ok: true,
    sanction: {
      banned: !!user.banned,
      sanctionUntil: user.sanctionUntil || null,
      violationCount: user.violationCount || 0,
      message: banOrLimitMessage(user),
    },
  });
});

// 게시판 목록 (숨김 처리된 게시판은 제외)
app.get('/api/boards', (req, res) => {
  const boards = loadBoards().filter(b => !b.hidden).sort((a, b) => (a.order || 0) - (b.order || 0));
  res.json({ ok: true, boards });
});

// ---- 게시글 ----

// 목록 (게시판별, 최신순). 신고 누적으로 숨겨진 글은 작성자 본인/운영자에게만 보임
app.get('/api/posts', (req, res) => {
  const me = getCurrentUser(req);
  const board = getBoard(req.query.board);
  if (!board || (board.hidden && !isAdminUser(me))) {
    return res.status(404).json({ ok: false, message: '존재하지 않는 게시판이에요.' });
  }
  const posts = loadPosts();
  const visible = posts.filter(p =>
    (p.board || 'diary') === board.slug &&
    (!p.hidden || (me && (me.id === p.writerId || isAdminUser(me))))
  );
  const sorted = visible.slice().sort((a, b) => b.id - a.id);
  res.json({ ok: true, board: board.slug, posts: sorted.map(publicPost) });
});

// 전체 게시판 검색 (제목·내용 대상). 숨김 게시판과 신고로 숨겨진 글은 결과에서 제외
app.get('/api/search', (req, res) => {
  const me = getCurrentUser(req);
  const query = String(req.query.q || '').trim().toLowerCase();
  if (!query) {
    return res.json({ ok: true, query: '', posts: [] });
  }
  const boards = loadBoards();
  const visibleBoardSlugs = new Set(boards.filter(b => !b.hidden).map(b => b.slug));
  const boardTitleOf = slug => (boards.find(b => b.slug === slug) || {}).title || slug;

  const posts = loadPosts();
  const matched = posts.filter(p => {
    const board = p.board || 'diary';
    if (!visibleBoardSlugs.has(board)) return false;
    if (p.hidden && !(me && (me.id === p.writerId || isAdminUser(me)))) return false;
    return p.title.toLowerCase().includes(query) || p.body.toLowerCase().includes(query);
  });
  const sorted = matched.slice().sort((a, b) => b.id - a.id);
  res.json({
    ok: true,
    query,
    posts: sorted.map(p => ({ ...publicPost(p), boardTitle: boardTitleOf(p.board || 'diary') })),
  });
});

// 상세 (조회수 +1)
app.get('/api/posts/:id', (req, res) => {
  const me = getCurrentUser(req);
  const posts = loadPosts();
  const post = posts.find(p => p.id === Number(req.params.id));
  if (!post) {
    return res.status(404).json({ ok: false, message: '글을 찾을 수 없어요.' });
  }
  if (post.hidden && !(me && (me.id === post.writerId || isAdminUser(me)))) {
    return res.status(403).json({ ok: false, message: '신고가 접수되어 검토 중인 글이에요.' });
  }
  // 댓글 수정·삭제 후 목록만 다시 불러올 때는 이 헤더를 보내서 조회수가 중복으로 올라가지 않게 함
  if (!req.get('X-No-View-Count')) {
    post.views = (post.views || 0) + 1;
    savePosts(posts);
  }
  const hearted = (post.hearters || []).includes(getVisitorId(req));
  const { hearters, ...safePost } = post;
  const users = loadUsers();
  const [postWithProfile] = attachWriterProfileImages([safePost], users);
  const comments = attachWriterProfileImages(visibleComments(post.comments, me), users);
  res.json({ ok: true, post: { ...postWithProfile, hearted, comments } });
});

// 글쓰기용 이미지 업로드 (최대 5장). 실제 글 저장과는 별도 — 먼저 업로드해서 URL을 받고,
// 그 URL들을 글쓰기 요청(POST /api/posts)의 images 필드에 담아 보내는 방식
app.post('/api/upload/post-images', requireCanWrite, imageUpload.array('images', 5), async (req, res) => {
  if (!cloudinaryConfigured) {
    return res.status(500).json({ ok: false, message: '이미지 업로드가 아직 설정되지 않았어요. 관리자에게 문의해주세요.' });
  }
  const files = req.files || [];
  if (!files.length) {
    return res.status(400).json({ ok: false, message: '업로드할 이미지를 선택해주세요.' });
  }
  try {
    const urls = await Promise.all(files.map(f => uploadBufferToCloudinary(f.buffer, 'healing-site/posts')));
    res.json({ ok: true, urls });
  } catch (err) {
    console.error('이미지 업로드 실패:', err);
    res.status(500).json({ ok: false, message: '이미지 업로드에 실패했어요. 잠시 후 다시 시도해주세요.' });
  }
});

// 프로필 사진 업로드 (1장). 성공하면 바로 내 계정에 반영
app.post('/api/upload/profile', requireAuth, imageUpload.single('image'), async (req, res) => {
  if (!cloudinaryConfigured) {
    return res.status(500).json({ ok: false, message: '이미지 업로드가 아직 설정되지 않았어요. 관리자에게 문의해주세요.' });
  }
  if (!req.file) {
    return res.status(400).json({ ok: false, message: '업로드할 이미지를 선택해주세요.' });
  }
  try {
    const url = await uploadBufferToCloudinary(req.file.buffer, 'healing-site/profiles');
    const users = loadUsers();
    const user = users.find(u => u.id === req.currentUser.id);
    user.profileImage = url;
    saveUsers(users);
    res.json({ ok: true, profileImage: url });
  } catch (err) {
    console.error('프로필 사진 업로드 실패:', err);
    res.status(500).json({ ok: false, message: '이미지 업로드에 실패했어요. 잠시 후 다시 시도해주세요.' });
  }
});

// 글쓰기 (로그인 필요, 정지·제한 계정은 불가)
// 업로드 API가 돌려준 Cloudinary URL만 통과시켜서, 임의 URL이 글에 끼어드는 걸 막음
function sanitizeImageUrls(images) {
  if (!Array.isArray(images)) return [];
  const cloudinaryPrefix = `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/`;
  return images
    .filter(url => typeof url === 'string' && url.startsWith(cloudinaryPrefix))
    .slice(0, 5);
}

app.post('/api/posts', requireCanWrite, (req, res) => {
  const { title, body, anonymous, board, images } = req.body || {};
  const boardObj = getBoard(board);
  if (!boardObj) {
    return res.status(400).json({ ok: false, message: '올바른 게시판을 선택해주세요.' });
  }
  if (boardObj.hidden) {
    return res.status(400).json({ ok: false, message: '지금은 글을 쓸 수 없는 게시판이에요.' });
  }
  const errorMessage = validatePostContent(title, body);
  if (errorMessage) {
    return res.status(400).json({ ok: false, message: errorMessage });
  }
  const trimmedTitle = String(title).trim();
  const trimmedBody = String(body).trim();

  const posts = loadPosts();
  const newPost = {
    id: posts.length ? Math.max(...posts.map(p => p.id)) + 1 : 1,
    board,
    title: trimmedTitle,
    body: trimmedBody,
    images: sanitizeImageUrls(images),
    // 글쓴이는 클라이언트가 아니라 서버의 로그인 세션 기준으로 결정 (닉네임 위조 방지)
    writerId: req.currentUser.id,
    writerNickname: anonymous ? '익명' : req.currentUser.nickname,
    hearts: 0,
    views: 0,
    comments: [],
    reports: [],
    hidden: false,
    createdAt: new Date().toISOString(),
  };
  posts.push(newPost);
  savePosts(posts);
  res.json({ ok: true, post: newPost });
});

// 제목·내용 유효성 검사 (글쓰기·글수정 공통). 통과하면 null, 실패하면 에러 메시지 반환
function validatePostContent(title, body) {
  const trimmedTitle = (title || '').trim();
  const trimmedBody = (body || '').trim();
  if (!trimmedTitle || !trimmedBody) return '제목과 내용을 모두 입력해주세요.';
  if (trimmedTitle.length > 200 || trimmedBody.length > 1000) return '제목 또는 내용이 너무 길어요.';
  const banned = findBannedWord(trimmedTitle) || findBannedWord(trimmedBody);
  if (banned) return '욕설·비속어로 보이는 표현이 포함되어 있어 등록할 수 없어요. 다정한 말로 다시 적어주세요.';
  return null;
}

// 본인 글 수정 (제목·내용만). 작성자 본인만 가능, 제재·미인증 상태면 불가
app.patch('/api/posts/:id', requireCanWrite, (req, res) => {
  const posts = loadPosts();
  const post = posts.find(p => p.id === Number(req.params.id));
  if (!post) {
    return res.status(404).json({ ok: false, message: '글을 찾을 수 없어요.' });
  }
  if (post.writerId !== req.currentUser.id) {
    return res.status(403).json({ ok: false, message: '본인이 쓴 글만 수정할 수 있어요.' });
  }
  const { title, body } = req.body || {};
  const errorMessage = validatePostContent(title, body);
  if (errorMessage) {
    return res.status(400).json({ ok: false, message: errorMessage });
  }
  post.title = String(title).trim();
  post.body = String(body).trim();
  savePosts(posts);
  res.json({ ok: true, post });
});

// 본인 글 삭제 (완전 삭제). 작성자 본인만 가능, 제재·미인증 상태면 불가
app.delete('/api/posts/:id', requireCanWrite, (req, res) => {
  const posts = loadPosts();
  const post = posts.find(p => p.id === Number(req.params.id));
  if (!post) {
    return res.status(404).json({ ok: false, message: '글을 찾을 수 없어요.' });
  }
  if (post.writerId !== req.currentUser.id) {
    return res.status(403).json({ ok: false, message: '본인이 쓴 글만 삭제할 수 있어요.' });
  }
  posts.splice(posts.indexOf(post), 1);
  savePosts(posts);
  res.json({ ok: true });
});

// 공감 보내기 (로그인 불필요 — 가볍게 응원 보내는 용도)
app.post('/api/posts/:id/heart', (req, res) => {
  const posts = loadPosts();
  const post = posts.find(p => p.id === Number(req.params.id));
  if (!post) {
    return res.status(404).json({ ok: false, message: '글을 찾을 수 없어요.' });
  }
  post.hearters = post.hearters || [];
  const visitorId = getVisitorId(req);
  if (post.hearters.includes(visitorId)) {
    return res.status(409).json({ ok: false, message: '이미 공감을 보낸 글이에요.', hearts: post.hearts });
  }
  post.hearters.push(visitorId);
  post.hearts = (post.hearts || 0) + 1;
  savePosts(posts);
  res.json({ ok: true, hearts: post.hearts, hearted: true });
});

// 댓글 작성 (로그인 불필요, 로그인했으면 닉네임으로 표시)
app.post('/api/posts/:id/comments', (req, res) => {
  const { body } = req.body || {};
  const trimmedBody = (body || '').trim();
  if (!trimmedBody) {
    return res.status(400).json({ ok: false, message: '댓글 내용을 입력해주세요.' });
  }
  if (trimmedBody.length > 300) {
    return res.status(400).json({ ok: false, message: '댓글이 너무 길어요.' });
  }
  const bannedWord = findBannedWord(trimmedBody);
  if (bannedWord) {
    return res.status(400).json({ ok: false, message: '욕설·비속어로 보이는 표현이 포함되어 있어 등록할 수 없어요. 다정한 말로 다시 적어주세요.' });
  }

  const posts = loadPosts();
  const post = posts.find(p => p.id === Number(req.params.id));
  if (!post) {
    return res.status(404).json({ ok: false, message: '글을 찾을 수 없어요.' });
  }

  let writerNickname = '익명';
  let writerId = null;
  if (req.session.userId) {
    const users = loadUsers();
    const user = users.find(u => u.id === req.session.userId);
    if (user) {
      const msg = sanctionMessage(user);
      if (msg) return res.status(403).json({ ok: false, message: msg });
      writerNickname = user.nickname;
      writerId = user.id;
    }
  }

  const newComment = {
    id: post.comments.length ? Math.max(...post.comments.map(c => c.id)) + 1 : 1,
    writerId,
    writerNickname,
    body: trimmedBody,
    hearts: 0,
    reports: [],
    hidden: false,
    createdAt: new Date().toISOString(),
  };
  post.comments.push(newComment);
  savePosts(posts);
  res.json({ ok: true, comment: newComment, commentCount: post.comments.length });
});

// 본인 댓글 수정. 작성자 본인만 가능, 제재·미인증 상태면 불가
app.patch('/api/posts/:id/comments/:commentId', requireCanWrite, (req, res) => {
  const posts = loadPosts();
  const post = posts.find(p => p.id === Number(req.params.id));
  if (!post) {
    return res.status(404).json({ ok: false, message: '글을 찾을 수 없어요.' });
  }
  const comment = post.comments.find(c => c.id === Number(req.params.commentId));
  if (!comment) {
    return res.status(404).json({ ok: false, message: '댓글을 찾을 수 없어요.' });
  }
  if (comment.writerId !== req.currentUser.id) {
    return res.status(403).json({ ok: false, message: '본인이 쓴 댓글만 수정할 수 있어요.' });
  }
  const { body } = req.body || {};
  const trimmedBody = (body || '').trim();
  if (!trimmedBody) {
    return res.status(400).json({ ok: false, message: '댓글 내용을 입력해주세요.' });
  }
  if (trimmedBody.length > 300) {
    return res.status(400).json({ ok: false, message: '댓글이 너무 길어요.' });
  }
  const bannedWord = findBannedWord(trimmedBody);
  if (bannedWord) {
    return res.status(400).json({ ok: false, message: '욕설·비속어로 보이는 표현이 포함되어 있어 등록할 수 없어요. 다정한 말로 다시 적어주세요.' });
  }
  comment.body = trimmedBody;
  savePosts(posts);
  res.json({ ok: true, comment });
});

// 본인 댓글 삭제 (완전 삭제). 작성자 본인만 가능, 제재·미인증 상태면 불가
app.delete('/api/posts/:id/comments/:commentId', requireCanWrite, (req, res) => {
  const posts = loadPosts();
  const post = posts.find(p => p.id === Number(req.params.id));
  if (!post) {
    return res.status(404).json({ ok: false, message: '글을 찾을 수 없어요.' });
  }
  const comment = post.comments.find(c => c.id === Number(req.params.commentId));
  if (!comment) {
    return res.status(404).json({ ok: false, message: '댓글을 찾을 수 없어요.' });
  }
  if (comment.writerId !== req.currentUser.id) {
    return res.status(403).json({ ok: false, message: '본인이 쓴 댓글만 삭제할 수 있어요.' });
  }
  post.comments.splice(post.comments.indexOf(comment), 1);
  savePosts(posts);
  res.json({ ok: true, commentCount: post.comments.length });
});

// 게시글 신고
app.post('/api/posts/:id/report', (req, res) => {
  const { reason } = req.body || {};
  if (!REPORT_REASONS.includes(reason)) {
    return res.status(400).json({ ok: false, message: '올바른 신고 사유를 선택해주세요.' });
  }
  const posts = loadPosts();
  const post = posts.find(p => p.id === Number(req.params.id));
  if (!post) {
    return res.status(404).json({ ok: false, message: '글을 찾을 수 없어요.' });
  }
  post.reports = post.reports || [];
  const reporterId = getVisitorId(req);
  if (post.reports.some(r => r.reporterId === reporterId)) {
    return res.status(409).json({ ok: false, message: '이미 신고한 글이에요.' });
  }
  post.reports.push({ reporterId, reason, createdAt: new Date().toISOString() });
  if (!post.hidden && post.reports.length >= REPORT_THRESHOLD) {
    post.hidden = true;
  }
  savePosts(posts);
  res.json({ ok: true, reportCount: post.reports.length, hidden: !!post.hidden });
});

// 댓글 신고
app.post('/api/posts/:id/comments/:commentId/report', (req, res) => {
  const { reason } = req.body || {};
  if (!REPORT_REASONS.includes(reason)) {
    return res.status(400).json({ ok: false, message: '올바른 신고 사유를 선택해주세요.' });
  }
  const posts = loadPosts();
  const post = posts.find(p => p.id === Number(req.params.id));
  if (!post) {
    return res.status(404).json({ ok: false, message: '글을 찾을 수 없어요.' });
  }
  const comment = post.comments.find(c => c.id === Number(req.params.commentId));
  if (!comment) {
    return res.status(404).json({ ok: false, message: '댓글을 찾을 수 없어요.' });
  }
  comment.reports = comment.reports || [];
  const reporterId = getVisitorId(req);
  if (comment.reports.some(r => r.reporterId === reporterId)) {
    return res.status(409).json({ ok: false, message: '이미 신고한 댓글이에요.' });
  }
  comment.reports.push({ reporterId, reason, createdAt: new Date().toISOString() });
  if (!comment.hidden && comment.reports.length >= REPORT_THRESHOLD) {
    comment.hidden = true;
  }
  savePosts(posts);
  res.json({ ok: true, reportCount: comment.reports.length, hidden: !!comment.hidden });
});

// ---- 운영자 신고 관리 ----

// 신고가 하나라도 있는 글/댓글 목록. 자해 조장 신고는 우선순위를 올려서 맨 위로 보여줌
function slaEmailHtml(items) {
  const rows = items.map(it => `
    <li>
      <strong>${it.type === 'post' ? '게시글' : '댓글'} · ${escapeHtmlServer(it.boardTitle)}</strong><br>
      ${escapeHtmlServer(it.type === 'post' ? it.title : it.body).slice(0, 80)}<br>
      신고 ${it.reportCount}건 · 최초 신고 ${it.oldestReportAt}
    </li>`).join('');
  return `<div style="font-family:sans-serif;line-height:1.7;">
    <p>안녕하세요, 쉼표예요.</p>
    <p>${items.length}건의 신고가 24시간 넘게 처리되지 않고 있어요. 운영자 화면에서 확인해주세요.</p>
    <ul>${rows}</ul>
    <p><a href="${APP_BASE_URL}/#screen-admin">운영자 화면 바로가기</a></p>
  </div>`;
}

// 24시간 넘게 처리되지 않은 신고를 찾아 운영자 전체에게 메일로 알림. 같은 신고에는
// 한 번만 보내도록 slaNotified 플래그를 남기고, 운영자가 처리(복구/삭제)하면
// reports 배열이 초기화되거나 글/댓글째 지워지므로 플래그도 함께 사라짐.
async function checkReportSla() {
  if (!ADMIN_EMAILS.length) return;
  const posts = loadPosts();
  const boards = loadBoards();
  const boardTitleOf = slug => (boards.find(b => b.slug === slug) || {}).title || slug;
  const now = Date.now();
  const overdue = [];
  let changed = false;

  function checkTarget(target, type, post) {
    const reports = target.reports || [];
    if (!reports.length || target.slaNotified) return;
    const oldest = reports.reduce((min, r) => Math.min(min, new Date(r.createdAt).getTime()), Infinity);
    if (now - oldest < REPORT_SLA_MS) return;
    overdue.push({
      type,
      boardTitle: boardTitleOf(post.board || 'diary'),
      title: post.title,
      body: target.body,
      reportCount: reports.length,
      oldestReportAt: new Date(oldest).toLocaleString('ko-KR'),
    });
    target.slaNotified = true;
    changed = true;
  }

  posts.forEach(p => {
    checkTarget(p, 'post', p);
    (p.comments || []).forEach(c => checkTarget(c, 'comment', p));
  });

  if (!overdue.length) return;
  if (changed) savePosts(posts);

  try {
    await sendMail({
      to: ADMIN_EMAILS.join(','),
      subject: `[쉼표] SLA 초과 신고 ${overdue.length}건 확인해주세요`,
      html: slaEmailHtml(overdue),
    });
  } catch (err) {
    console.error('SLA 알림 메일 발송 실패:', err);
  }
}

app.get('/api/admin/reports', requireAdmin, (req, res) => {
  const posts = loadPosts();
  const boards = loadBoards();
  const boardTitleOf = slug => (boards.find(b => b.slug === slug) || {}).title || slug;
  const items = [];

  posts.forEach(p => {
    const reports = p.reports || [];
    if (reports.length > 0) {
      items.push({
        type: 'post',
        postId: p.id,
        commentId: null,
        board: p.board || 'diary',
        boardTitle: boardTitleOf(p.board || 'diary'),
        title: p.title,
        body: p.body,
        writerNickname: p.writerNickname,
        writerId: p.writerId,
        reportCount: reports.length,
        reports,
        hidden: !!p.hidden,
        priority: reports.some(r => SEVERE_REPORT_REASONS.has(r.reason)),
        createdAt: p.createdAt,
      });
    }
    (p.comments || []).forEach(c => {
      const cReports = c.reports || [];
      if (cReports.length > 0) {
        items.push({
          type: 'comment',
          postId: p.id,
          commentId: c.id,
          board: p.board || 'diary',
          boardTitle: boardTitleOf(p.board || 'diary'),
          title: p.title,
          body: c.body,
          writerNickname: c.writerNickname,
          writerId: c.writerId,
          reportCount: cReports.length,
          reports: cReports,
          hidden: !!c.hidden,
          priority: cReports.some(r => SEVERE_REPORT_REASONS.has(r.reason)),
          createdAt: c.createdAt,
        });
      }
    });
  });

  items.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority ? -1 : 1;
    if (b.reportCount !== a.reportCount) return b.reportCount - a.reportCount;
    return new Date(a.createdAt) - new Date(b.createdAt);
  });

  res.json({ ok: true, items });
});

// 신고 처리: 복구 / 삭제(일반, 경고·제재 누적) / 삭제(중대, 즉시 영구정지)
app.post('/api/admin/resolve', requireAdmin, (req, res) => {
  const { type, postId, commentId, action } = req.body || {};
  if (!['post', 'comment'].includes(type)) {
    return res.status(400).json({ ok: false, message: '잘못된 요청이에요.' });
  }
  if (!['restore', 'delete_minor', 'delete_severe'].includes(action)) {
    return res.status(400).json({ ok: false, message: '잘못된 처리 방식이에요.' });
  }

  const posts = loadPosts();
  const post = posts.find(p => p.id === Number(postId));
  if (!post) {
    return res.status(404).json({ ok: false, message: '글을 찾을 수 없어요.' });
  }

  let target = post;
  if (type === 'comment') {
    target = post.comments.find(c => c.id === Number(commentId));
    if (!target) {
      return res.status(404).json({ ok: false, message: '댓글을 찾을 수 없어요.' });
    }
  }

  if (action === 'restore') {
    target.hidden = false;
    target.reports = [];
    target.slaNotified = false;
    savePosts(posts);
    return res.json({ ok: true });
  }

  // 삭제 (일반/중대) — 콘텐츠를 지우고, 작성자가 있으면 제재를 적용
  const writerId = target.writerId;
  if (type === 'post') {
    posts.splice(posts.indexOf(post), 1);
  } else {
    post.comments.splice(post.comments.indexOf(target), 1);
  }

  if (writerId) {
    const users = loadUsers();
    const user = users.find(u => u.id === writerId);
    if (user) {
      user.violationCount = (user.violationCount || 0) + 1;
      if (action === 'delete_severe') {
        user.banned = true; // 신상 노출·자해 조장 등 중대 위반은 즉시 영구 정지
      } else if (user.violationCount >= 5) {
        user.banned = true;
      } else if (user.violationCount >= 3) {
        user.sanctionUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      }
      saveUsers(users);
    }
  }

  savePosts(posts);
  res.json({ ok: true });
});

// 금칙어 목록 조회/수정 (운영자 전용)
app.get('/api/admin/banned-words', requireAdmin, (req, res) => {
  res.json({ ok: true, words: loadBannedWords() });
});
app.post('/api/admin/banned-words', requireAdmin, (req, res) => {
  const { action, word } = req.body || {};
  const trimmed = String(word || '').trim();
  if (!trimmed) {
    return res.status(400).json({ ok: false, message: '단어를 입력해주세요.' });
  }
  const words = loadBannedWords();
  if (action === 'remove') {
    const next = words.filter(w => w !== trimmed);
    saveBannedWords(next);
    return res.json({ ok: true, words: next });
  }
  if (!words.includes(trimmed)) words.push(trimmed);
  saveBannedWords(words);
  res.json({ ok: true, words });
});

// ---- 운영자 게시판 관리 ----

// 숨김 게시판을 포함한 전체 게시판 목록
app.get('/api/admin/boards', requireAdmin, (req, res) => {
  const boards = loadBoards().sort((a, b) => (a.order || 0) - (b.order || 0));
  res.json({ ok: true, boards });
});

// 새 게시판 만들기
app.post('/api/admin/boards', requireAdmin, (req, res) => {
  const { title, category, description, tag } = req.body || {};
  const trimmedTitle = (title || '').trim();
  const trimmedCategory = (category || '').trim();
  if (!trimmedTitle) {
    return res.status(400).json({ ok: false, message: '게시판 이름을 입력해주세요.' });
  }
  if (!trimmedCategory) {
    return res.status(400).json({ ok: false, message: '카테고리를 선택해주세요.' });
  }
  const boards = loadBoards();
  const slug = uniqueBoardSlug(slugify(trimmedTitle), boards);
  const maxOrder = boards.length ? Math.max(...boards.map(b => b.order || 0)) : 0;
  const newBoard = {
    slug,
    title: trimmedTitle,
    category: trimmedCategory,
    description: String(description || '').trim().slice(0, 80),
    tag: String(tag || '').trim().slice(0, 20),
    hidden: false,
    order: maxOrder + 1,
  };
  boards.push(newBoard);
  saveBoards(boards);
  res.json({ ok: true, board: newBoard });
});

// 게시판 수정 (이름 변경 / 카테고리 / 설명 / 태그 / 숨김 처리)
app.patch('/api/admin/boards/:slug', requireAdmin, (req, res) => {
  const boards = loadBoards();
  const b = boards.find(x => x.slug === req.params.slug);
  if (!b) {
    return res.status(404).json({ ok: false, message: '게시판을 찾을 수 없어요.' });
  }
  const { title, category, description, tag, hidden } = req.body || {};
  if (title !== undefined) {
    const t = String(title).trim();
    if (!t) return res.status(400).json({ ok: false, message: '게시판 이름을 입력해주세요.' });
    b.title = t;
  }
  if (category !== undefined) {
    const c = String(category).trim();
    if (!c) return res.status(400).json({ ok: false, message: '카테고리를 입력해주세요.' });
    b.category = c;
  }
  if (description !== undefined) b.description = String(description).trim().slice(0, 80);
  if (tag !== undefined) b.tag = String(tag).trim().slice(0, 20);
  if (hidden !== undefined) b.hidden = !!hidden;
  saveBoards(boards);
  res.json({ ok: true, board: b });
});

// 게시판 순서 이동 (같은 카테고리 안에서 위/아래로)
app.post('/api/admin/boards/:slug/move', requireAdmin, (req, res) => {
  const { direction } = req.body || {};
  if (!['up', 'down'].includes(direction)) {
    return res.status(400).json({ ok: false, message: '잘못된 요청이에요.' });
  }
  const boards = loadBoards();
  const target = boards.find(b => b.slug === req.params.slug);
  if (!target) {
    return res.status(404).json({ ok: false, message: '게시판을 찾을 수 없어요.' });
  }
  const siblings = boards.filter(b => b.category === target.category).sort((a, b) => (a.order || 0) - (b.order || 0));
  const idx = siblings.findIndex(b => b.slug === target.slug);
  const swapWith = direction === 'up' ? siblings[idx - 1] : siblings[idx + 1];
  if (swapWith) {
    const tmp = target.order;
    target.order = swapWith.order;
    swapWith.order = tmp;
    saveBoards(boards);
  }
  res.json({ ok: true });
});

// 게시판 삭제 (게시글이 하나도 없을 때만 가능 — 있으면 숨김 처리를 권장)
app.delete('/api/admin/boards/:slug', requireAdmin, (req, res) => {
  const boards = loadBoards();
  const idx = boards.findIndex(b => b.slug === req.params.slug);
  if (idx === -1) {
    return res.status(404).json({ ok: false, message: '게시판을 찾을 수 없어요.' });
  }
  const posts = loadPosts();
  const hasPosts = posts.some(p => (p.board || 'diary') === req.params.slug);
  if (hasPosts) {
    return res.status(400).json({ ok: false, message: '게시글이 있는 게시판은 삭제할 수 없어요. 먼저 숨김 처리해주세요.' });
  }
  boards.splice(idx, 1);
  saveBoards(boards);
  res.json({ ok: true });
});

// ---- 운영자 회원 관리 ----

// 전체 회원 목록 (이메일·닉네임으로 검색 가능). 비밀번호 해시 등은 publicUser로 걸러서 내려줌
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const query = String(req.query.q || '').trim().toLowerCase();
  const users = loadUsers();
  const filtered = query
    ? users.filter(u =>
        (u.email || '').toLowerCase().includes(query) ||
        (u.nickname || '').toLowerCase().includes(query))
    : users;
  const sorted = filtered.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ ok: true, users: sorted.map(publicUser) });
});

// 회원 직접 제재: 영구정지(ban) 또는 지정 일수 제한(limit)
app.post('/api/admin/users/:id/sanction', requireAdmin, (req, res) => {
  const { type, days } = req.body || {};
  if (!['ban', 'limit'].includes(type)) {
    return res.status(400).json({ ok: false, message: '잘못된 제재 방식이에요.' });
  }
  const users = loadUsers();
  const user = users.find(u => u.id === Number(req.params.id));
  if (!user) {
    return res.status(404).json({ ok: false, message: '회원을 찾을 수 없어요.' });
  }
  if (isAdminUser(user)) {
    return res.status(400).json({ ok: false, message: '운영자 계정은 제재할 수 없어요.' });
  }
  if (type === 'ban') {
    user.banned = true;
    user.sanctionUntil = null;
  } else {
    const numDays = Number(days);
    if (!numDays || numDays <= 0) {
      return res.status(400).json({ ok: false, message: '제한할 일수를 입력해주세요.' });
    }
    user.sanctionUntil = new Date(Date.now() + numDays * 24 * 60 * 60 * 1000).toISOString();
  }
  saveUsers(users);
  res.json({ ok: true, user: publicUser(user) });
});

// 제재 해제 (영구정지·기간제한 모두 풀어줌)
app.post('/api/admin/users/:id/unsanction', requireAdmin, (req, res) => {
  const users = loadUsers();
  const user = users.find(u => u.id === Number(req.params.id));
  if (!user) {
    return res.status(404).json({ ok: false, message: '회원을 찾을 수 없어요.' });
  }
  user.banned = false;
  user.sanctionUntil = null;
  saveUsers(users);
  res.json({ ok: true, user: publicUser(user) });
});

// ---- 운영자 게시글 관리 ----

// 전체 게시글 목록 (신고 여부와 무관, 제목으로 검색 가능)
app.get('/api/admin/posts', requireAdmin, (req, res) => {
  const query = String(req.query.q || '').trim().toLowerCase();
  const posts = loadPosts();
  const boards = loadBoards();
  const boardTitleOf = slug => (boards.find(b => b.slug === slug) || {}).title || slug;
  const filtered = query ? posts.filter(p => p.title.toLowerCase().includes(query)) : posts;
  const sorted = filtered.slice().sort((a, b) => b.id - a.id);
  res.json({
    ok: true,
    posts: sorted.map(p => ({
      id: p.id,
      board: p.board || 'diary',
      boardTitle: boardTitleOf(p.board || 'diary'),
      title: p.title,
      writerNickname: p.writerNickname,
      commentCount: p.comments.length,
      hidden: !!p.hidden,
      createdAt: p.createdAt,
    })),
  });
});

// 신고 여부와 무관하게 운영자가 직접 게시글 삭제 (제재 사다리에는 영향 없음)
app.delete('/api/admin/posts/:id', requireAdmin, (req, res) => {
  const posts = loadPosts();
  const post = posts.find(p => p.id === Number(req.params.id));
  if (!post) {
    return res.status(404).json({ ok: false, message: '글을 찾을 수 없어요.' });
  }
  posts.splice(posts.indexOf(post), 1);
  savePosts(posts);
  res.json({ ok: true });
});

// ---- 카카오 로그인 ----
app.get('/auth/kakao', (req, res) => {
  if (!KAKAO_CLIENT_ID) {
    return res.status(500).send(configMissingPage('카카오', 'KAKAO_CLIENT_ID=여기에_REST_API_키'));
  }
  const params = new URLSearchParams({
    client_id: KAKAO_CLIENT_ID,
    redirect_uri: KAKAO_REDIRECT_URI,
    response_type: 'code',
  });
  res.redirect(`${KAKAO_AUTH_BASE}/oauth/authorize?${params}`);
});

app.get('/auth/kakao/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) {
    return res.redirect('/?auth_error=kakao');
  }
  try {
    const tokenRes = await fetch(`${KAKAO_AUTH_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: KAKAO_CLIENT_ID,
        redirect_uri: KAKAO_REDIRECT_URI,
        code: String(code),
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('카카오 토큰 발급 실패: ' + JSON.stringify(tokenData));

    const profileRes = await fetch(`${KAKAO_API_BASE}/v2/user/me`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const profile = await profileRes.json();
    const kakaoAccount = profile.kakao_account || {};
    const nickname = (kakaoAccount.profile && kakaoAccount.profile.nickname) || '카카오사용자';
    const email = kakaoAccount.email || null;

    const users = loadUsers();
    const user = findOrCreateSocialUser(users, {
      provider: 'kakao',
      providerId: String(profile.id),
      nickname,
      email,
    });
    saveUsers(users);
    req.session.userId = user.id;
    res.redirect('/');
  } catch (err) {
    console.error('카카오 로그인 오류:', err);
    res.redirect('/?auth_error=kakao');
  }
});

// ---- 구글 로그인 ----
app.get('/auth/google', (req, res) => {
  if (!GOOGLE_CLIENT_ID) {
    return res.status(500).send(configMissingPage('구글', 'GOOGLE_CLIENT_ID=여기에_클라이언트_ID\nGOOGLE_CLIENT_SECRET=여기에_클라이언트_보안비밀'));
  }
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    prompt: 'select_account',
  });
  res.redirect(`${GOOGLE_AUTH_BASE}/o/oauth2/v2/auth?${params}`);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) {
    return res.redirect('/?auth_error=google');
  }
  try {
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(code),
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('구글 토큰 발급 실패: ' + JSON.stringify(tokenData));

    const profileRes = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const profile = await profileRes.json();

    const users = loadUsers();
    const user = findOrCreateSocialUser(users, {
      provider: 'google',
      providerId: profile.sub,
      nickname: profile.name || '구글사용자',
      email: profile.email || null,
    });
    saveUsers(users);
    req.session.userId = user.id;
    res.redirect('/');
  } catch (err) {
    console.error('구글 로그인 오류:', err);
    res.redirect('/?auth_error=google');
  }
});

// multer(이미지 업로드)에서 난 에러를 JSON으로 응답. 다른 라우트의 에러는 각자 처리하므로
// 여기까지 오지 않음 — 반드시 라우트 등록 전부가 끝난 뒤, 마지막에 있어야 동작함
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? '이미지 하나의 용량은 5MB를 넘을 수 없어요.'
      : err.code === 'LIMIT_UNEXPECTED_FILE'
        ? '이미지는 최대 5장까지 첨부할 수 있어요.'
        : '이미지를 업로드하지 못했어요.';
    return res.status(400).json({ ok: false, message });
  }
  if (err && err.message && err.message.includes('jpg, png, webp')) {
    return res.status(400).json({ ok: false, message: err.message });
  }
  next(err);
});

app.listen(PORT, () => {
  console.log(`쉼표 로그인 서버가 http://localhost:${PORT} 에서 실행 중이에요.`);
  checkReportSla();
  setInterval(checkReportSla, REPORT_SLA_CHECK_INTERVAL_MS);
});
