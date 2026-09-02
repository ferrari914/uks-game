/* =========================================================================
   Englknight 공용 랭킹 — 명예의 전당 / 주간 / 일간
   games/shared/ranking.js   ·  게임 관리자 작성 2026-09-01

   [왜 이 파일이 있나]
   랭킹을 게임마다 따로 구현하면 스키마가 갈라진다. 갈라지면 나중에
   "전 게임 통합 순위" 같은 걸 만들 수 없고, 기록은 이미 영구 보존이라
   되돌릴 수도 없다. 그래서 스키마와 질의는 이 파일 하나에만 둔다.

   [쓰는 법] classic script. 모듈 아니다. file:// 에서도 동작한다.
     <script src="../shared/ranking.js"></script>
     RANK.submit('tetris', {name:'홍길동', score:12345})
     RANK.board(document.getElementById('hof'), 'tetris')

   [저장 구조] 기록 하나가 세 랭킹에 전부 쓰인다. 중복 저장하지 않는다.
     /ranking/<게임>/<자동키> = {
       name, score, ts,
       dk: "2026-09-01|00012345",   ← 그날(KST) + 8자리 0채움 점수
       wk: "2026-08-31|00012345"    ← 그 주 월요일(KST) + 같은 점수
     }

   [왜 날짜와 점수를 한 문자열에 붙이나]
   Firebase 실시간 DB는 한 질의에 정렬 기준을 하나만 쓴다. "오늘 것 중
   높은 순 20개"를 서버에서 뽑으려면 날짜와 점수가 한 필드에 있어야 한다.
   점수를 같은 자릿수로 0을 채우면 문자열 순서가 곧 숫자 순서가 된다.
   이렇게 안 하면 오늘 기록을 전부 내려받아 브라우저에서 정렬해야 하고,
   기록이 쌓일수록 느려진다.

   [초기화를 어떻게 하나 — 지우지 않는다]
   날짜가 바뀌면 새 날짜 칸에 쌓이기 시작하고, 어제 칸은 그대로 남는다.
   즉 "초기화"는 삭제가 아니라 칸이 바뀌는 것이다. 규칙상 아무도 기록을
   지울 수 없으므로(그게 남의 기록을 지키는 방법이다) 이 방식이어야 한다.
   덤으로 지난 날짜 순위를 나중에 다시 꺼내볼 수 있다.

   [기준 시간] 한국 시간(KST, UTC+9). 하루는 KST 자정에, 한 주는 KST
   월요일 자정에 바뀐다. 브라우저 시계가 아니라 KST로 고정한다 — 해외에서
   접속한 사람과 국내 접속자가 다른 날짜 칸에 들어가면 안 된다.

   [한계 — 숨기지 말 것]
   점수는 검증되지 않는다. 누구나 아무 점수나 보낼 수 있고, 날짜 칸도
   보내는 쪽이 정한다. 서버가 없으니 막을 방법이 없다. 게임 화면에
   이 사실을 적어 둘 것.
   ========================================================================= */
(function(){
  'use strict';

  var DB   = 'https://tetris260827-30fe0-default-rtdb.asia-southeast1.firebasedatabase.app';
  var BASE = DB + '/ranking/';
  var KST  = 9 * 3600 * 1000;   /* 한국 시간 보정 */
  var PAD  = 8;                 /* 점수 자릿수. 99,999,999 까지 */
  var MAXS = 99999999;
  var HIGH = '';          /* 범위 질의의 끝. 어떤 글자보다 뒤에 온다 */

  /* ---- 날짜 칸 계산 (전부 KST 기준) ---- */
  function kst(ts){ return new Date((ts==null?Date.now():ts) + KST); }

  function dayOf(ts){ return kst(ts).toISOString().slice(0,10); }

  function weekOf(ts){
    var d = kst(ts);
    var back = (d.getUTCDay() + 6) % 7;        /* 월요일=0 이 되게 */
    d.setUTCDate(d.getUTCDate() - back);
    return d.toISOString().slice(0,10);
  }

  function padScore(n){
    n = Math.round(Number(n) || 0);
    if(n < 0) n = 0; if(n > MAXS) n = MAXS;
    return (new Array(PAD + 1).join('0') + n).slice(-PAD);
  }

  /* 다음 초기화 시각 (KST 자정 / KST 월요일 자정) → 로컬 Date */
  function nextReset(scope, ts){
    var now = (ts==null ? Date.now() : ts);
    var d = kst(now);
    d.setUTCHours(0,0,0,0);
    if(scope === 'week'){
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay()+6)%7) + 7);
    }else{
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return new Date(d.getTime() - KST);
  }

  /* ---- 통신 ---- */
  function url(game, qs){
    return BASE + encodeURIComponent(game) + '.json' + (qs ? '?' + qs : '');
  }
  function q(v){ return encodeURIComponent(JSON.stringify(v)); }

  function get(u){
    return fetch(u, {method:'GET'}).then(function(r){
      if(!r.ok) throw new Error('랭킹을 불러오지 못했습니다 (' + r.status + ')');
      return r.json();
    });
  }

  /* ---- 등재 ---- */
  function submit(game, rec){
    var ts    = rec.ts || Date.now();
    var score = Math.round(Number(rec.score) || 0);
    if(score < 0) score = 0; if(score > MAXS) score = MAXS;
    var name  = String(rec.name == null ? '' : rec.name).trim().slice(0,12) || '이름없음';
    var p     = padScore(score);

    var body = { name:name, score:score, ts:ts,
                 dk: dayOf(ts)  + '|' + p,
                 wk: weekOf(ts) + '|' + p };

    /* 게임이 자기만의 정보를 더 붙일 수 있다 (테트리스의 level·lines 처럼).
       위 다섯 개 이름만 건드리지 않으면 된다. */
    if(rec.extra) for(var k in rec.extra) if(!(k in body)) body[k] = rec.extra[k];

    return fetch(url(game), {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(body)
    }).then(function(r){
      if(!r.ok) throw new Error('등재하지 못했습니다 (' + r.status + ')');
      return r.json();
    }).then(function(j){ return {ok:true, id:j && j.name, rec:body}; });
  }

  /* ---- 조회 ----
     scope: 'all' 명예의 전당 · 'week' 주간 · 'day' 일간
     when:  다른 날짜/주를 보고 싶을 때 넘기는 시각(ms). 없으면 지금.     */
  function top(game, scope, n, when){
    n = n || 20;
    var qs;
    if(scope === 'day' || scope === 'week'){
      var field  = (scope === 'day') ? 'dk' : 'wk';
      var bucket = (scope === 'day') ? dayOf(when) : weekOf(when);
      qs = 'orderBy=' + q(field) +
           '&startAt=' + q(bucket + '|') +
           '&endAt='   + q(bucket + '|' + HIGH) +
           '&limitToLast=' + n;
    }else{
      qs = 'orderBy=' + q('score') + '&limitToLast=' + n;
    }
    return get(url(game, qs)).then(function(obj){ return toList(obj, n); });
  }

  function toList(obj, n){
    var out = [], k;
    if(obj) for(k in obj){
      var v = obj[k];
      if(!v || typeof v.score !== 'number') continue;
      out.push({ id:k, name:v.name, score:v.score, ts:v.ts, raw:v });
    }
    /* 점수 높은 순. 같으면 먼저 세운 쪽이 위 */
    out.sort(function(a,b){ return (b.score - a.score) || ((a.ts||0) - (b.ts||0)); });
    out = out.slice(0, n);
    for(var i=0;i<out.length;i++) out[i].rank = i + 1;
    return out;
  }

  /* ---- 3탭 순위판 ----
     el     : 넣을 자리
     game   : 게임 id
     opts.n : 몇 위까지 (기본 20)
     opts.unit  : 점수 뒤에 붙일 말 ('층' 같은 것). 기본 '점'
     opts.format: 점수를 직접 꾸미고 싶을 때 function(score, rec) → 문자열
     opts.me    : 내 기록 id. 있으면 그 줄을 강조한다                      */
  var TABS = [
    {k:'all',  t:'🏆 명예의 전당', sub:'영구 보존'},
    {k:'week', t:'주간',           sub:'월요일 0시(KST)에 새로 시작'},
    {k:'day',  t:'일간',           sub:'매일 0시(KST)에 새로 시작'}
  ];

  function board(el, game, opts){
    opts = opts || {};
    injectCSS();
    var n    = opts.n || 20;
    var unit = opts.unit || '점';
    var fmt  = opts.format || function(s){ return s.toLocaleString() + unit; };
    var cur  = opts.scope || 'all';

    el.className = (el.className || '') + ' rk';
    el.innerHTML =
      '<div class="rk-tabs" role="tablist">' +
        TABS.map(function(t){
          return '<button class="rk-tab" role="tab" data-k="' + t.k + '" ' +
                 'aria-selected="' + (t.k===cur) + '">' + t.t + '</button>';
        }).join('') +
      '</div>' +
      '<p class="rk-sub"></p>' +
      '<div class="rk-body" role="tabpanel"><p class="rk-msg">불러오는 중…</p></div>';

    var body = el.querySelector('.rk-body');
    var sub  = el.querySelector('.rk-sub');

    el.querySelectorAll('.rk-tab').forEach(function(b){
      b.addEventListener('click', function(){ show(b.getAttribute('data-k')); });
    });

    function show(k){
      cur = k;
      el.querySelectorAll('.rk-tab').forEach(function(b){
        b.setAttribute('aria-selected', String(b.getAttribute('data-k') === k));
      });
      var meta = TABS.filter(function(t){ return t.k===k; })[0];
      sub.textContent = meta.sub + (k==='all' ? '' : ' · 다음 초기화 ' + human(nextReset(k)));
      body.innerHTML = '<p class="rk-msg">불러오는 중…</p>';

      top(game, k, n).then(function(list){
        if(cur !== k) return;                     /* 그새 탭을 바꿨으면 버린다 */
        if(!list.length){
          body.innerHTML = '<p class="rk-msg">' +
            (k==='all' ? '아직 기록이 없습니다.' : '이 기간에는 아직 기록이 없습니다.') +
            '</p>';
          return;
        }
        body.innerHTML = '<ol class="rk-list">' + list.map(function(r){
          return '<li class="rk-row' + (opts.me && r.id===opts.me ? ' rk-me' : '') + '">' +
                   '<span class="rk-no">' + r.rank + '</span>' +
                   '<span class="rk-nm">' + esc(r.name) + '</span>' +
                   '<span class="rk-sc">' + esc(fmt(r.score, r.raw)) + '</span>' +
                 '</li>';
        }).join('') + '</ol>';
      }).catch(function(e){
        if(cur !== k) return;
        body.innerHTML = '<p class="rk-msg rk-err">' + esc(e.message) + '</p>';
      });
    }

    show(cur);
    return { show: show, reload: function(){ show(cur); } };
  }

  function human(d){
    var m = d.getMonth()+1, day = d.getDate(), h = d.getHours();
    return m + '월 ' + day + '일 ' + (h===0 ? '0시' : h + '시');
  }

  function esc(s){
    return String(s).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }

  var cssDone = false;
  function injectCSS(){
    if(cssDone) return; cssDone = true;
    var s = document.createElement('style');
    s.textContent =
      '.rk{--rk-line:#262b40;--rk-dim:#8b93ad;--rk-hi:#00e5ff;--rk-me:#ff2d95}' +
      '.rk-tabs{display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap}' +
      '.rk-tab{flex:1;min-width:88px;min-height:44px;padding:8px 10px;cursor:pointer;' +
        'background:transparent;color:var(--rk-dim);border:1px solid var(--rk-line);' +
        'border-radius:10px;font:inherit;font-size:.92em}' +
      '.rk-tab[aria-selected="true"]{color:var(--rk-hi);border-color:var(--rk-hi)}' +
      '.rk-sub{margin:0 0 10px;font-size:.8em;color:var(--rk-dim)}' +
      '.rk-list{list-style:none;margin:0;padding:0}' +
      '.rk-row{display:flex;align-items:center;gap:10px;padding:9px 2px;' +
        'border-bottom:1px solid var(--rk-line)}' +
      '.rk-row:last-child{border-bottom:0}' +
      '.rk-no{width:2em;text-align:right;color:var(--rk-dim);font-variant-numeric:tabular-nums}' +
      '.rk-nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.rk-sc{font-weight:700;color:var(--rk-hi);font-variant-numeric:tabular-nums}' +
      '.rk-me .rk-nm,.rk-me .rk-sc{color:var(--rk-me)}' +
      '.rk-msg{margin:14px 2px;font-size:.9em;color:var(--rk-dim)}' +
      '.rk-err{color:#ff8080}';
    document.head.appendChild(s);
  }

  window.RANK = {
    submit: submit,
    top: top,
    board: board,
    keys: function(ts){ return {dk: dayOf(ts), wk: weekOf(ts)}; },
    nextReset: nextReset,
    _pad: padScore
  };
})();
