/* 쉼표 게임 공용 댓글창
 * /games/<slug>/ 페이지에 서버가 자동으로 붙여줍니다. 직접 쓰려면 <script src="/games/comments.js" defer></script>
 * 한 줄이면 되고, <div id="game-comments"></div>가 있으면 그 자리에, 없으면 페이지 맨 아래에 들어갑니다.
 * 색은 페이지의 --bg / --ink / --soft / --tray / --line / --accent 변수를 따라가고, 없으면 기본값을 씁니다. */
(function () {
  if (window.__gameCommentsLoaded) return;
  window.__gameCommentsLoaded = true;

  var m = location.pathname.match(/^\/games\/([^\/]+)\//);
  if (!m) return;
  var slug = decodeURIComponent(m[1]);
  var API = '/api/games/' + encodeURIComponent(slug) + '/comments';
  var NAME_KEY = 'swimpyo-game-comment-name';

  var css = [
    '.gc-wrap{max-width:1100px;margin:0 auto;padding:6px 14px 40px;box-sizing:border-box;font-family:inherit;color:var(--ink,#2A2140)}',
    '.gc-wrap *,.gc-wrap *::before,.gc-wrap *::after{box-sizing:border-box}',
    '.gc{border-top:1.5px solid var(--line,#D5CBE6);padding-top:20px}',
    '.gc h2{margin:0 0 12px;font-size:18px;font-weight:700}',
    '.gc-count{color:var(--soft,#6C6185);font-weight:400;font-size:15px;margin-left:4px}',
    '.gc-form{display:flex;flex-direction:column;gap:8px;margin-bottom:18px}',
    '.gc-form input,.gc-form textarea{width:100%;font:inherit;font-size:15px;color:var(--ink,#2A2140);background:var(--tray,#F8F5FC);border:1.5px solid var(--line,#D5CBE6);border-radius:12px;padding:10px 12px;outline:none}',
    '.gc-form input{max-width:220px}',
    '.gc-form input[readonly]{opacity:.75}',
    '.gc-form textarea{min-height:76px;resize:vertical;line-height:1.5}',
    '.gc-form input:focus,.gc-form textarea:focus{border-color:var(--accent,#E8579B)}',
    '.gc-row{display:flex;align-items:center;justify-content:space-between;gap:10px}',
    '.gc-hint{font-size:12.5px;color:var(--soft,#6C6185)}',
    '.gc-msg{font-size:13px;color:var(--accent,#E8579B);min-height:1em}',
    '.gc-btn{font:inherit;font-size:15px;border:0;border-radius:999px;padding:9px 22px;background:var(--accent,#E8579B);color:#fff;cursor:pointer;flex:none}',
    '.gc-btn:disabled{opacity:.55;cursor:default}',
    '.gc-list{list-style:none;margin:0;padding:0}',
    '.gc-item{padding:12px 2px;border-top:1px solid var(--line,#D5CBE6)}',
    '.gc-item:first-child{border-top:0}',
    '.gc-meta{display:flex;align-items:baseline;gap:8px;font-size:13px;color:var(--soft,#6C6185)}',
    '.gc-name{font-size:14px;font-weight:700;color:var(--ink,#2A2140)}',
    '.gc-body{margin:4px 0 0;font-size:15px;line-height:1.55;white-space:pre-wrap;word-break:break-word}',
    '.gc-empty{padding:18px 2px;color:var(--soft,#6C6185);font-size:14px}',
    /* 게임 하는 중, 가로로 돌린 휴대폰에서는 숨김 */
    'body.playing .gc-wrap{display:none}',
    '@media (orientation:landscape) and (max-height:500px){.gc-wrap{display:none}}'
  ].join('\n');

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function ago(iso) {
    var t = new Date(iso).getTime();
    if (!isFinite(t)) return '';
    var s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return '방금 전';
    if (s < 3600) return Math.floor(s / 60) + '분 전';
    if (s < 86400) return Math.floor(s / 3600) + '시간 전';
    if (s < 86400 * 7) return Math.floor(s / 86400) + '일 전';
    var d = new Date(t);
    return d.getFullYear() + '.' + (d.getMonth() + 1) + '.' + d.getDate();
  }

  // 지난번 댓글에 쓴 닉네임, 없으면 이 게임 순위표에 쓴 닉네임(<게임>-...-nick 키)을 가져옴
  function rememberedName() {
    try {
      var own = localStorage.getItem(NAME_KEY);
      if (own) return own;
      var pick = '';
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!/(^|-)nick(name)?$/i.test(k)) continue;
        var v = (localStorage.getItem(k) || '').trim();
        if (v.length < 2 || v.length > 10) continue;
        if (k.indexOf(slug) === 0) return v;   // 이 게임의 순위표 닉네임이 가장 우선
        if (!pick) pick = v;
      }
      return pick;
    } catch (e) { return ''; }
  }

  function build() {
    var style = el('style');
    style.textContent = css;
    document.head.appendChild(style);

    var wrap = el('section', 'gc-wrap');
    wrap.setAttribute('aria-label', '게임 댓글');
    var box = el('div', 'gc');
    var h = el('h2', null, '댓글');
    var count = el('span', 'gc-count', '');
    h.appendChild(count);

    var form = el('form', 'gc-form');
    var nameIn = el('input');
    nameIn.type = 'text'; nameIn.maxLength = 10; nameIn.placeholder = '닉네임 (2~10자)';
    nameIn.setAttribute('aria-label', '닉네임'); nameIn.autocomplete = 'nickname';
    var bodyIn = el('textarea');
    bodyIn.maxLength = 300; bodyIn.placeholder = '이 게임에 대한 한마디를 남겨 보세요';
    bodyIn.setAttribute('aria-label', '댓글 내용');
    var row = el('div', 'gc-row');
    var hint = el('span', 'gc-hint', '0 / 300');
    var btn = el('button', 'gc-btn', '등록');
    btn.type = 'submit';
    row.appendChild(hint); row.appendChild(btn);
    var msg = el('div', 'gc-msg');
    msg.setAttribute('role', 'status');
    form.appendChild(nameIn); form.appendChild(bodyIn); form.appendChild(row); form.appendChild(msg);

    var list = el('ul', 'gc-list');
    box.appendChild(h); box.appendChild(form); box.appendChild(list);
    wrap.appendChild(box);

    function setCount(n) { count.textContent = n ? String(n) : ''; }

    function item(c) {
      var li = el('li', 'gc-item');
      var meta = el('div', 'gc-meta');
      meta.appendChild(el('span', 'gc-name', c.name));
      meta.appendChild(el('span', null, ago(c.date)));
      li.appendChild(meta);
      li.appendChild(el('p', 'gc-body', c.body));
      return li;
    }

    function showEmpty() {
      if (!list.children.length) list.appendChild(el('li', 'gc-empty', '아직 댓글이 없어요. 첫 한마디를 남겨 보세요.'));
    }

    // 닉네임: 로그인했으면 계정 닉네임으로 고정, 아니면 지난번에 쓴 이름을 채워둠
    var loggedIn = false;
    nameIn.value = rememberedName();
    fetch('/api/me', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (d && d.ok && d.user && d.user.nickname) {
        loggedIn = true;
        nameIn.value = d.user.nickname;
        nameIn.readOnly = true;
        nameIn.title = '로그인한 닉네임으로 남겨져요';
      }
    }).catch(function () {});

    fetch(API).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) { list.appendChild(el('li', 'gc-empty', d.message || '댓글을 불러오지 못했어요.')); return; }
      d.comments.forEach(function (c) { list.appendChild(item(c)); });
      setCount(d.total);
      showEmpty();
    }).catch(function () {
      list.appendChild(el('li', 'gc-empty', '댓글을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.'));
    });

    bodyIn.addEventListener('input', function () { hint.textContent = bodyIn.value.length + ' / 300'; });

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var name = nameIn.value.trim(), body = bodyIn.value.trim();
      msg.textContent = '';
      if (!loggedIn && (name.length < 2 || name.length > 10)) { msg.textContent = '닉네임은 2~10자로 적어주세요.'; nameIn.focus(); return; }
      if (!body) { msg.textContent = '댓글 내용을 입력해주세요.'; bodyIn.focus(); return; }
      btn.disabled = true;
      fetch(API, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, body: body })
      }).then(function (r) { return r.json(); }).then(function (d) {
        btn.disabled = false;
        if (!d.ok) { msg.textContent = d.message || '댓글을 남기지 못했어요.'; return; }
        var empty = list.querySelector('.gc-empty');
        if (empty) empty.remove();
        list.insertBefore(item(d.comment), list.firstChild);
        setCount(d.total);
        bodyIn.value = ''; hint.textContent = '0 / 300';
        if (!loggedIn) { try { localStorage.setItem(NAME_KEY, name); } catch (e) {} }
        if (typeof window.gtag === 'function') { try { window.gtag('event', 'game_comment', { game: slug }); } catch (e) {} }
      }).catch(function () {
        btn.disabled = false;
        msg.textContent = '서버와 통신 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.';
      });
    });

    var mount = document.getElementById('game-comments');
    if (mount) { mount.appendChild(wrap); } else { document.body.appendChild(wrap); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
})();
