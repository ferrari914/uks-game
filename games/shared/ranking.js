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
      if(!r.ok){
        var e = new Error('랭킹을 불러오지 못했습니다 (' + r.status + ')');
        e.status = r.status;
        throw e;
      }
      return r.json();
    });
  }

  /* 색인이 없으면 Firebase 가 날짜 정렬 질의를 400 으로 거부한다.
     그때는 전부 받아 여기서 거른다. 느리지만 화면에 오류를 띄우는 것보다 낫다.
     색인(".indexOn": ["score","dk","wk"])이 들어오면 이 경로는 한 번도 안 탄다. */
  var noIndex = false;   /* 한 번 400 을 맞으면 기억한다 — 매번 실패 요청을 보내지 않는다 */
  var warned = false;
  function filterHere(game, scope, when){
    noIndex = true;
    if(!warned){
      warned = true;
      try{
        console.warn('[RANK] 날짜 색인이 없어 전체를 받아 거르는 중입니다. ' +
          'Firebase 규칙의 /ranking 에 ".indexOn": ["score","dk","wk"] 를 넣으면 ' +
          '서버가 기간별 상위만 보내 훨씬 빨라집니다.');
      }catch(e){}
    }
    var field  = (scope === 'day') ? 'dk' : 'wk';
    var bucket = (scope === 'day') ? dayOf(when) : weekOf(when);
    return get(url(game)).then(function(obj){
      var out = {}, k;
      if(obj) for(k in obj){
        var v = obj[k];
        if(v && typeof v.score === 'number' &&
           String(v[field] || '').indexOf(bucket + '|') === 0) out[k] = v;
      }
      return out;
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
  function top(game, scope, n, when, keepDupes){
    n = n || 20;
    /* 같은 이름을 접으므로 넉넉히 받아온 뒤 잘라낸다. 딱 n개만 받으면
       한 사람이 상위를 채웠을 때 20위까지 못 채운다. */
    var fetchN = keepDupes ? n : Math.min(300, n * 10);
    var qs;
    if(scope === 'day' || scope === 'week'){
      var field  = (scope === 'day') ? 'dk' : 'wk';
      var bucket = (scope === 'day') ? dayOf(when) : weekOf(when);
      qs = 'orderBy=' + q(field) +
           '&startAt=' + q(bucket + '|') +
           '&endAt='   + q(bucket + '|' + HIGH) +
           '&limitToLast=' + fetchN;
    }else{
      qs = 'orderBy=' + q('score') + '&limitToLast=' + fetchN;
    }
    var isPeriod = (scope === 'day' || scope === 'week');
    /* 색인이 없는 것을 이미 확인했으면 실패할 요청을 또 보내지 않는다 */
    var req = (isPeriod && noIndex) ? filterHere(game, scope, when) : get(url(game, qs));
    if(isPeriod && !noIndex){
      req = req['catch'](function(e){
        if(e && e.status === 400) return filterHere(game, scope, when);
        throw e;
      });
    }
    return req.then(function(obj){ return toList(obj, n, keepDupes); });
  }

  function toList(obj, n, keepDupes){
    var out = [], k;
    if(obj) for(k in obj){
      var v = obj[k];
      if(!v || typeof v.score !== 'number') continue;
      out.push({ id:k, name:v.name, score:v.score, ts:v.ts, raw:v });
    }
    /* 점수 높은 순. 같으면 먼저 세운 쪽이 위 */
    out.sort(function(a,b){ return (b.score - a.score) || ((a.ts||0) - (b.ts||0)); });

    /* 한 사람이 여러 줄을 차지하면 순위표가 "누가 잘하나"가 아니라
       "누가 많이 했나"가 된다. 같은 이름은 최고 기록 한 줄만 남긴다.
       ⚠ 이름은 신원이 아니다 — 다른 사람이 같은 이름을 쓰면 합쳐진다.
          로그인이 없는 한 피할 수 없다. 화면에 그 사실을 적어 둘 것. */
    if(!keepDupes) out = dedupeByName(out);
    out = out.slice(0, n);
    for(var i=0;i<out.length;i++) out[i].rank = i + 1;
    return out;
  }

  /* 점수 내림차순으로 이미 정렬된 배열에서 같은 이름의 뒷줄을 버린다 */
  function dedupeByName(arr){
    var seen = {}, uniq = [];
    for(var j=0;j<arr.length;j++){
      var key = String(arr[j].name==null?'':arr[j].name);
      if(seen[key]) continue;
      seen[key] = 1; uniq.push(arr[j]);
    }
    return uniq;
  }

  /* toList 와 같은 정렬 기준. 두 곳이 어긋나면 탭마다 동점자 순서가 뒤집힌다. */
  function bySCore(x,y){ return (y.score - x.score) || ((x.ts||0) - (y.ts||0)); }

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

      /* 명예의 전당만 다른 곳에서 더 가져와야 하는 게임이 있다 — 테트리스는 옛 경로
         /scores 에 옮길 수 없는 기록이 남아 있다(규칙이 삭제·수정을 막는다).
         opts.extraAll 은 그 옛 기록을 toList 와 같은 모양
         ({id,name,score,ts,raw})으로 돌려주면 된다.
         ⚠ 합친 뒤 순위를 **다시 매긴다** — toList 가 이미 1부터 박아 두므로
            그냥 이어붙이면 1위가 두 명 나온다. 그래서 이 처리는 board 안에 있어야 한다.
         ⚠ 실패해도 명예의 전당 자체는 떠야 한다. 옛 기록 때문에 순위판이 죽으면 손해가 크다. */
      var p = top(game, k, n, null, opts.keepDupes);
      if(k === 'all' && opts.extraAll){
        p = Promise.all([
          p,
          Promise.resolve().then(opts.extraAll).catch(function(){ return []; })
        ]).then(function(r){
          var a = r[0].concat(r[1] || []);
          a.sort(bySCore);
          if(!opts.keepDupes) a = dedupeByName(a);
          a = a.slice(0, n);
          for(var i=0;i<a.length;i++) a[i].rank = i + 1;
          return a;
        });
      }
      p.then(function(list){
        if(cur !== k) return;                     /* 그새 탭을 바꿨으면 버린다 */
        if(!list.length){
          body.innerHTML = '<p class="rk-msg">' +
            (k==='all' ? '아직 기록이 없습니다.' : '이 기간에는 아직 기록이 없습니다.') +
            '</p>';
          return;
        }
        var note = opts.keepDupes ? '' :
          '<p class="rk-msg" style="margin-top:10px">같은 이름은 그 기간의 최고 기록 하나만 표시합니다.</p>';
        body.innerHTML = '<ol class="rk-list">' + list.map(function(r){
          return '<li class="rk-row' + (opts.me && r.id===opts.me ? ' rk-me' : '') + '">' +
                   '<span class="rk-no">' + r.rank + '</span>' +
                   '<span class="rk-nm">' + esc(r.name) + '</span>' +
                   '<span class="rk-sc">' + esc(fmt(r.score, r.raw)) + '</span>' +
                 '</li>';
        }).join('') + '</ol>' + note;
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
      /* 탭 3개가 375px 한 줄에 들어가야 한다. "🏆 명예의 전당"이 가장 길어서
         min-width 를 두면 접힌다 — 폭은 내용에 맡기고 높이만 44px 을 지킨다. */
      '.rk-tab{flex:1;min-width:0;min-height:44px;padding:8px 5px;cursor:pointer;' +
        'background:transparent;color:var(--rk-dim);border:1px solid var(--rk-line);' +
        'border-radius:10px;font:inherit;font-size:.82em;line-height:1.25}' +
      '.rk-tab[aria-selected="true"]{color:var(--rk-hi);border-color:var(--rk-hi);' +
        'background:rgba(0,229,255,.10)}' +
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

  /* =======================================================================
     이름 · 자동 등재
     -----------------------------------------------------------------------
     기록은 수정도 삭제도 안 된다. 그래서 게임이 끝날 때마다 무조건 올리면
     한 사람이 하루에 수백 줄을 쌓는다. 그러면 순위표를 뽑을 때 그 사람
     기록만 받아와 20위를 못 채운다.

     그래서 **자기 기록을 갱신했을 때만** 올린다. 사용자가 보기에는 자동이고,
     쌓이는 것은 의미 있는 기록뿐이다. 기준은 세 개다 — 오늘 최고, 이번 주
     최고, 역대 최고. 셋 중 하나라도 넘으면 올린다(기록 하나가 세 랭킹에
     전부 들어가므로 한 번만 쓰면 된다).

     ⚠ 기준은 이 기기에만 남는다. 다른 기기에서 처음 하면 한 번 더 올라가고,
        그건 순위판이 이름으로 접어 준다. 로그인이 없는 한 이게 최선이다.
     ======================================================================= */
  var LS_NAME = 'rank.name';

  function ls(k, v){
    try{
      if(v === undefined) return localStorage.getItem(k);
      localStorage.setItem(k, v); return v;
    }catch(e){ return null; }
  }

  /* 험한 이름을 막는다. 테트리스가 쓰던 목록을 공용으로 옮긴 것이다.
     ⚠ 이건 악의적 우회를 막는 장치가 아니다 — 우회하려는 사람은 목록을 몰라도
        REST 로 직접 넣는다. 목적은 **평범한 사용자가 실수로 험한 이름을 올리는
        것을 막는 것**이다. 그래서 목록이 공개돼도 잃을 게 없다.
     ⚠ 자모 분리("ㅅㅣ발")나 유사 문자는 못 잡는다. 완벽하지 않다. */
  var BADWORDS = ['씨발','시발','병신','좆','새끼','개새','지랄',
                  'fuck','shit','bitch','asshole','nigg'];

  /* 이름 다듬기. 게임마다 규칙이 다르면 같은 사람이 여러 줄로 갈라진다.
     반드시 이 함수 하나만 쓸 것. */
  function cleanName(raw){
    var n = String(raw == null ? '' : raw)
              .replace(/[\u0000-\u001f\u007f]/g, '')   /* 제어문자 제거 */
              .replace(/\s+/g, ' ').trim();
    if(!n) return {ok:false, name:'', error:'이름을 입력해 주세요.'};

    /* 공백을 지우고 소문자로 맞춘 뒤 본다 — "시 발" 같은 단순 회피를 잡는다 */
    var flat = n.toLowerCase().replace(/\s/g, '');
    for(var i=0;i<BADWORDS.length;i++){
      if(flat.indexOf(BADWORDS[i]) >= 0){
        return {ok:false, name:n, error:'사용할 수 없는 단어가 들어 있습니다.'};
      }
    }
    /* 자르지 않고 되돌린다. 말없이 잘라 저장하면 자기가 적은 이름과
       순위표에 뜬 이름이 달라져 더 헷갈린다. */
    if(n.length > 12) return {ok:false, name:n, error:'이름은 12자까지 쓸 수 있습니다.'};
    return {ok:true, name:n, error:''};
  }

  function name(){ return ls(LS_NAME) || ''; }

  function setName(raw){
    var c = cleanName(raw);
    if(c.ok) ls(LS_NAME, c.name);
    return c;
  }

  /* 같은 사람으로 묶는 기준. 대소문자·공백 차이로 갈라지지 않게 한다. */
  function nameKey(n){ return String(n||'').toLowerCase(); }

  function bestKey(game, who){ return 'rank.best.' + game + '.' + nameKey(who); }

  function readBest(game, who){
    try{ return JSON.parse(ls(bestKey(game, who)) || '{}') || {}; }catch(e){ return {}; }
  }

  /* 자동 등재. 갱신했을 때만 실제로 보낸다.
     반환: {sent, reason, best:{day,week,all}, rec?} — reason 은 화면에 그대로 써도 된다. */
  function autoSubmit(game, score, opts){
    opts = opts || {};
    var who = opts.name || name();
    var c = cleanName(who);
    if(!c.ok) return Promise.resolve({sent:false, reason:'이름이 없어 순위에 올리지 않았습니다.', best:null});

    var ts = opts.ts || Date.now();
    var sc = Math.round(Number(score) || 0);
    var dk = dayOf(ts), wk = weekOf(ts);
    var b  = readBest(game, c.name);

    /* 날짜가 바뀌었으면 그 칸의 기준은 없는 것과 같다 */
    var dayBest  = (b.dk === dk) ? (b.day  || 0) : 0;
    var weekBest = (b.wk === wk) ? (b.week || 0) : 0;
    var allBest  = b.all || 0;

    /* 셋 중 하나만 넘어도 올린다 = 가장 낮은 문턱만 넘으면 된다.
       안내에도 그 문턱을 보여줘야 한다. 역대 최고를 보여주면 "오늘 1등인데
       왜 안 올라갔지"로 읽힌다. */
    var bar = Math.min(dayBest, weekBest, allBest);
    if(sc <= bar){
      /* 첫 판을 0점으로 끝낸 사람에게 "기존 기록(0)을 넘지 못했습니다"는
         있지도 않은 기록을 말하는 셈이라 어색하다. */
      return Promise.resolve({
        sent:false,
        reason: (sc <= 0) ? '0점은 순위에 올리지 않습니다.'
                          : '기존 기록(' + bar.toLocaleString() + ')을 넘지 못했습니다.',
        best:{day:dayBest, week:weekBest, all:allBest}
      });
    }

    return submit(game, {name:c.name, score:sc, ts:ts, extra:opts.extra}).then(function(r){
      ls(bestKey(game, c.name), JSON.stringify({
        dk:dk, wk:wk,
        day: Math.max(dayBest, sc), week: Math.max(weekBest, sc), all: Math.max(allBest, sc)
      }));
      return {sent:true, reason:'순위에 올렸습니다.', id:r.id, rec:r.rec,
              best:{day:Math.max(dayBest,sc), week:Math.max(weekBest,sc), all:Math.max(allBest,sc)}};
    });
  }

  window.RANK = {
    submit: submit,
    autoSubmit: autoSubmit,
    name: name, setName: setName, cleanName: cleanName,
    top: top,
    board: board,
    keys: function(ts){ return {dk: dayOf(ts), wk: weekOf(ts)}; },
    nextReset: nextReset,
    _pad: padScore
  };
})();
