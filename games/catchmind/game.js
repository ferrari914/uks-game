/* =========================================================================
   캐치마인드 — 게임 로직 (game.js)

   구조
     · 방장 브라우저가 심판이다. 턴 진행 · 타이머 · 정답 판정 · 점수 계산은
       전부 방장 기기에서 하고, 결과만 상태 메시지로 뿌린다.
     · 참가자는 상태를 받아 화면만 그린다.
     · 제시어는 전원 토픽에 절대 싣지 않는다. 출제자 개인 토픽으로만 보낸다.
     · 토픽 ID·암호화 키를 방 코드에서 유도하고 페이로드를 AES-GCM으로 암복호화하는 일은
       net.js가 전담한다. 여기서는 S.tid(토픽 ID)만 들고 쓴다.

   토픽
     ekcm/<코드>/s        방장 → 전원 (상태 retain / 채팅·시스템 메시지 non-retain)
     ekcm/<코드>/c        참가자 → 방장 (join·ping·chat·team·pick·sync·leave)
     ekcm/<코드>/d        출제자 → 전원 (드로잉)
     ekcm/<코드>/p/<uid>  방장 → 개인 (제시어 후보, 근접 안내 등)
   ========================================================================= */
(function(){
"use strict";

/* ===================== 상수 ===================== */
var VERSION='1.0.0';

var MAX_PLAYERS=8;
var NAME_MAX=8;
var CHAT_MAX=60;

/* 타이밍 (ms) */
var TICK_MS=200;          // 방장 루프 주기
var UI_MS=100;            // 화면 타이머 갱신 주기
var PING_MS=3000;         // 참가자 생존 신호 주기
/* "자리 비움"과 "나감"은 다른 사건이다.
   브라우저는 숨은 탭의 타이머를 스로틀링한다(9초 동안 1초 인터벌이 4번만 도는 수준).
   한 턴이 90초이고 그동안 남이 그리는 걸 보고만 있는 게임이라, 사람들은 그 사이
   탭을 옮기고 폰에서는 메신저를 본다. 그걸 "나갔다"로 처리하면 잠깐 딴 걸 보고 온
   사람이 방에서 쫓겨난다. 그래서 자리 비움은 배지만 붙이고, 제거는 훨씬 뒤로 미룬다. */
var AWAY_MS=12000;        // 이 시간 넘게 조용하면 "자리 비움" 표시 (제거하지 않는다)
var DROP_MS=50000;        // 이 시간 넘게 조용해야 비로소 목록에서 제거
var NET_GRACE_MS=12000;   // 방장이 브로커에 재접속한 뒤 판정을 다시 시작하기까지의 유예
var HOST_GONE_MS=15000;   // 방장 상태가 이 시간 넘게 끊기면 브로커 탐색을 시작한다
var HOP_MS=5000;          // 탐색 중 브로커 체류 시간 (연결+구독+retain 수신에 충분해야 한다)
var BROKER_HOPS=6;        // 목록 두 바퀴까지 쓸어보고, 그래도 없으면 나간다
var RETURN_GRACE_MS=5000; // 탭으로 돌아온 뒤 방장 상태를 기다려 주는 시간
var PICK_MS=10000;        // 제시어 선택 제한시간
var REVEAL_MS=5000;       // 정답 공개 시간
var TURN_GAP_S=8;         // 예상 소요시간 계산에 쓰는 턴당 부가시간(초)
var STATE_MS=1200;        // 변화가 없어도 이 주기로는 상태를 다시 뿌린다

/* 설정 선택지 */
var ROUND_OPTS=[3,5,7,10];
var TIME_OPTS=[60,90,120];
var DIFF_OPTS=[{v:'all',t:'전체'},{v:'1',t:'쉬움'},{v:'2',t:'보통'},{v:'3',t:'어려움'}];

/* 점수 */
var SC_BASE=40;           // 정답 기본점
var SC_TIME=60;           // 남은 시간 비례 가산 최대치
var SC_RANK=[15,10,5];    // 1·2·3등 순위 보너스
var SC_DRAWER=20;         // 출제자: 맞힌 사람 1명당

/* 힌트: 남은 시간 비율이 이 값을 지날 때 한 글자씩 공개 */
var HINT_STEPS=[0.6,0.3];

/* 드로잉 */
var CW=800, CH=600;       // 논리 캔버스 크기 (표시 크기와 무관 — 좌표는 항상 이 기준)
var COARSE_MAX=900;       // 이 폭 이하이거나 손가락 입력이면 모바일로 본다
var GRIP_GAIN_MAX=4;      // 스크롤 그립 감도 상한
var D_BATCH_MS=80;        // 배치 전송 주기
var D_MAX_PAIRS=40;       // 배치 한 개당 좌표쌍 상한
var D_MIN_DIST=2;         // 논리좌표 2px 미만 이동은 버린다
var D_MAX_STROKES=200;    // 보관·스냅샷 스트로크 상한
var D_MAX_SNAP_PTS=4000;  // 스냅샷 전체 좌표 상한
var D_SNAP_GAP=2000;      // 스냅샷 재전송 최소 간격

var COLORS=['#111118','#ffffff','#ff4d6d','#ff8f3f','#ffd93d','#6ee36e',
            '#2bd9c4','#4d9dff','#8b6dff','#ff6ec7','#8b5a2b','#8b90a8'];
var WIDTHS=[2,6,12,24];

var EMOJIS=['😀','😎','🤠','🥸','👻','🤖','👽','🐶','🐱','🐼','🦊','🐸','🐵','🦁',
            '🐯','🐰','🐨','🐷','🐔','🦄','🐢','🦖','🍄','⭐'];

var LS_CFG='cm_cfg', LS_ME='cm_me';

var CHANGELOG=[
 {v:'1.0.0',t:['캐치마인드 첫 공개',
               '방 코드 5자로 들어가는 실시간 그림 퀴즈 (공용 MQTT 브로커)',
               '개인전 2~8명 / 팀전 2:2~4:4, 라운드 3·5·7·10 선택',
               '방 코드로 토픽 ID와 암호화 키를 따로 유도해 다른 방에서 엿보지 못하게 처리']}
];

/* ===================== 유틸 ===================== */
function rid(n,pool){
  var c=pool||'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',s='';
  for(var i=0;i<n;i++)s+=c[Math.floor(Math.random()*c.length)];
  return s;
}
function esc(s){
  return String(s==null?'':s).replace(/[&<>"']/g,function(m){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m];
  });
}
function cleanName(s){
  var t=String(s||'').replace(/[^0-9A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ ]/g,'').trim().slice(0,NAME_MAX);
  return t||'익명';
}
function shuffle(a){
  a=a.slice();
  for(var i=a.length-1;i>0;i--){var j=Math.floor(Math.random()*(i+1)),t=a[i];a[i]=a[j];a[j]=t}
  return a;
}
function clamp(v,a,b){return v<a?a:v>b?b:v}
function r3(v){return Math.round(v*1000)/1000}

/* 정답 비교용 정규화: 공백·특수문자 제거, 영문 소문자화 */
function norm(s){
  return String(s||'').toLowerCase().replace(/[^0-9a-z가-힣ㄱ-ㅎㅏ-ㅣ]/g,'');
}
/* 편집거리 1 이하인지 (근접 판정용) */
function near1(a,b){
  if(a===b)return false;
  var la=a.length,lb=b.length;
  if(Math.abs(la-lb)>1)return false;
  var i=0,j=0,diff=0;
  while(i<la&&j<lb){
    if(a[i]===b[j]){i++;j++;continue}
    if(++diff>1)return false;
    if(la>lb)i++; else if(lb>la)j++; else {i++;j++}
  }
  if(i<la||j<lb)diff++;
  return diff<=1;
}
function nowSync(){ return Date.now()+S.offset }
/* 상태는 최소 1.2초마다 다시 날아오지만 화면이 실제로 바뀌는 일은 드물다.
   내용이 같으면 innerHTML을 건드리지 않는다 — 문자열 비교가 DOM 재생성보다 훨씬 싸다.
   바꿨을 때만 true를 돌려주므로, 핸들러 재부착도 이 값으로 판단하면 된다. */
/* 클래스 토글도 값이 바뀔 때만 만진다. */
function setFlag(el,cls,on){
  if(!el)return;
  on=!!on;
  var k='__f_'+cls;
  if(el[k]===on)return;
  el[k]=on; el.classList.toggle(cls,on);
}
function setHTML(el,html){
  if(!el)return false;
  if(el.__h===html)return false;
  el.__h=html; el.innerHTML=html;
  return true;
}

/* ===================== 제시어 데이터 ===================== */
function wordsOk(){ return !!(window.CM_WORDS && window.CM_WORDS.length) }
/* words.js는 정적 데이터라 결과가 변하지 않는다. 대기실은 1.2초마다 다시 그려지므로
   400개를 매번 훑지 않도록 한 번만 계산해 둔다. */
var _catsCache=null;
function allCats(){
  if(_catsCache)return _catsCache;
  if(window.CM_CATEGORIES && window.CM_CATEGORIES.length)return (_catsCache=window.CM_CATEGORIES.slice());
  var seen={},out=[];
  (window.CM_WORDS||[]).forEach(function(w){ if(w&&w.c&&!seen[w.c]){seen[w.c]=1;out.push(w.c)} });
  return (_catsCache=out);
}
/* 같은 조건이면 결과가 같다. 시작 가능 여부 검사(startReason)가 대기실에서 계속 도는데,
   매번 400개를 필터링할 이유가 없다. 반환된 배열은 읽기 전용으로만 쓴다. */
var _poolKey='', _poolCache=null;
function wordPool(cfg){
  var key=cfg.diff+'|'+(cfg.cats||[]).join(',');
  if(_poolCache&&key===_poolKey)return _poolCache;
  var cats={},any=!cfg.cats||!cfg.cats.length;
  (cfg.cats||[]).forEach(function(c){cats[c]=1});
  _poolKey=key;
  return (_poolCache=(window.CM_WORDS||[]).filter(function(w){
    if(!w||!w.w)return false;
    if(cfg.diff!=='all' && String(w.d)!==String(cfg.diff))return false;
    if(!any && !cats[w.c])return false;
    return true;
  }));
}

/* ===================== 상태 ===================== */
var app=document.getElementById('app');
var connBar=document.getElementById('conn');
var navmid=document.getElementById('navmid');
var ovl=document.getElementById('ovl');

var S={
  screen:'home', name:'', emIdx:Math.floor(Math.random()*EMOJIS.length),
  pid:rid(12,'abcdefghijklmnopqrstuvwxyz0123456789'),
  code:'', tid:'', isHost:false,
  net:'idle', err:'', offset:0, lastState:0, lastPub:0, hop:0, hopAt:0,
  chat:[], lastSent:0,
  myWord:null, myCands:null,            // 출제자 본인만 아는 정보
  ovlKey:'', seenTurn:'', syncedTurn:''
};
var V=null;              // 방장이 뿌린 최신 상태
var G=null;              // 방장 전용 권위 상태
var NET=window.CM_NET.make();
var hostTimer=null, uiTimer=null, pingTimer=null;

/* 드로잉 로컬 상태 */
var DRAW={
  strokes:[], cur:null, out:[], timer:null,
  color:COLORS[0], width:WIDTHS[1], eraser:false,
  hasLast:false, lastX:0, lastY:0, lastSnap:0, ctx:null, cv:null, dpr:1,
  locked:false, scrollY:0
};

/* ===================== 토픽 ===================== */
/* 토픽에는 방 코드가 아니라 토픽 ID(코드의 해시)를 쓴다.
   방 코드를 토픽에 그대로 실으면 ekcm/# 로 엿보는 제3자가 코드를 읽어
   그대로 키를 만들 수 있다 — 암호화가 통째로 무의미해진다.
   S.tid는 방 생성·입장 시점에 한 번만 계산해 둔다(해시가 async라 여기선 동기로 쓴다). */
function tS(){ return 'ekcm/'+S.tid+'/s' }
function tC(){ return 'ekcm/'+S.tid+'/c' }
function tD(){ return 'ekcm/'+S.tid+'/d' }
function tP(pid){ return 'ekcm/'+S.tid+'/p/'+pid }
function inviteLink(){ return location.origin+location.pathname+'#'+S.code }
/* 방 코드로 토픽 ID·암호화 키를 준비한다. 연결·구독보다 먼저 끝나야 한다. */
function prepareRoom(code){
  S.code=code;
  NET.setKey(code);
  return window.CM_NET.topicId(code).then(function(tid){ S.tid=tid; return tid });
}

/* ===================== 설정 저장 ===================== */
function loadCfg(){
  var d={mode:'solo',rounds:3,tl:90,diff:'all',cats:[],hint:true};
  try{
    var raw=JSON.parse(localStorage.getItem(LS_CFG)||'null');
    if(raw&&typeof raw==='object'){
      if(raw.mode==='team'||raw.mode==='solo')d.mode=raw.mode;
      if(ROUND_OPTS.indexOf(+raw.rounds)>=0)d.rounds=+raw.rounds;
      if(TIME_OPTS.indexOf(+raw.tl)>=0)d.tl=+raw.tl;
      if(['all','1','2','3'].indexOf(String(raw.diff))>=0)d.diff=String(raw.diff);
      if(Object.prototype.toString.call(raw.cats)==='[object Array]')d.cats=raw.cats.slice(0,40);
      d.hint=raw.hint!==false;
    }
  }catch(e){}
  /* 저장된 카테고리 중 지금 데이터에 없는 건 버린다 */
  var live=allCats();
  d.cats=d.cats.filter(function(c){return live.indexOf(c)>=0});
  return d;
}
function saveCfg(){ if(!G)return; try{ localStorage.setItem(LS_CFG,JSON.stringify(G.cfg)) }catch(e){} }
function loadMe(){
  try{
    var m=JSON.parse(localStorage.getItem(LS_ME)||'null');
    if(m&&typeof m==='object'){
      if(m.n)S.name=cleanName(m.n);
      if(typeof m.e==='number')S.emIdx=clamp(m.e,0,EMOJIS.length-1);
    }
  }catch(e){}
}
function saveMe(){ try{ localStorage.setItem(LS_ME,JSON.stringify({n:S.name,e:S.emIdx})) }catch(e){} }

/* ===================== 연결 ===================== */
function setNet(s){
  S.net=s;
  if(s==='on'){ connBar.classList.remove('show'); return }
  connBar.textContent =
     s==='dead' ? '브로커에 연결할 수 없습니다. 잠시 후 새로고침해 주세요.'
   : s==='re'   ? '연결이 끊겨 재접속 중… (다른 서버로 옮겨 봅니다)'
   :              '네트워크 연결 대기 중…';
  connBar.classList.add('show');
}
function ensureNet(){
  if(S.net==='on')return Promise.resolve();
  return NET.connect(setNet).then(function(){ setNet('on') });
}
function httpsWarn(){
  return location.protocol!=='https:';
}
/* 멀티플레이 가능 여부.
   AES-GCM(crypto.subtle)은 보안 컨텍스트에서만 동작하고, wss://도 마찬가지다.
   폴백은 만들지 않는다 — 안내만 띄운다. */
function canMulti(){ return !!(window.CM_NET&&window.CM_NET.cryptoOk()) }
var HTTPS_MSG='멀티플레이는 https 주소에서만 됩니다. 파일을 직접 열거나 http로 열면 연결이 막힙니다.';

/* ===================== 홈 화면 ===================== */
/* 받아들이는 형태: 초대 링크 전체 / '#ABC12' / 'ABC12' / 소문자 / 옛 형식 'ABC12-<키>'.
   옛 링크를 붙여넣는 사람이 있으므로 뒤에 -무언가가 붙어도 앞 5자만 떼어 쓴다. */
function parseInvite(str){
  var t=String(str||'').trim();
  var h=t.indexOf('#'); if(h>=0)t=t.slice(h+1);
  t=t.replace(/\s+/g,'');
  var m=/^([A-Za-z0-9]{5})(?:-[A-Za-z0-9]*)?$/.exec(t);
  return m?{code:m[1].toUpperCase()}:null;
}
function renderHome(){
  var inv=parseInvite(location.hash);
  var noWords=!wordsOk();
  app.innerHTML=
  '<div class="narrow">'+
  '<div class="hero"><div class="kicker">실시간 그림 퀴즈</div>'+
  '<h1>캐치마인드</h1>'+
  '<p>한 명이 그림을 그리고, 나머지가 채팅으로 맞힙니다.<br>'+
  '잘 그려서 맞히게 하면 출제자도 점수를 받습니다.</p></div>'+

  (noWords?'<div class="warnbox">제시어 데이터를 불러오지 못했습니다(<code>words.js</code>). '+
    '방을 만들 수 없습니다. 페이지를 새로고침하거나 배포 파일을 확인해 주세요.</div>':'')+

  ((httpsWarn()||!canMulti())?'<div class="warnbox">멀티플레이는 <b>https 주소</b>에서만 됩니다. '+
    '지금은 <code>'+esc(location.protocol)+'</code>로 열려 있습니다'+
    (canMulti()?' (localhost는 예외적으로 동작할 수 있습니다).'
              :' — 브로커 연결과 암호화가 막혀 방을 만들거나 들어갈 수 없습니다.')+
    ' 화면과 그리기 도구는 그대로 확인할 수 있습니다.</div>':'')+

  '<div class="card"><label class="lbl" for="nm">이름</label>'+
  '<input type="text" id="nm" maxlength="'+NAME_MAX+'" placeholder="'+NAME_MAX+'자까지" value="'+esc(S.name)+'">'+
  '<label class="lbl" style="margin-top:16px">캐릭터</label>'+
  '<div class="emoji-grid" id="eg">'+
  EMOJIS.map(function(e,i){return '<button type="button" data-i="'+i+'" aria-pressed="'+(i===S.emIdx)+'">'+e+'</button>'}).join('')+
  '</div></div>'+

  (inv?'<div class="card"><h3>초대받은 방 '+esc(inv.code)+'</h3>'+
   '<button class="btn btn-main" id="jn2" style="width:100%">바로 입장</button></div>':'')+

  '<div class="card"><h3>방 만들기</h3>'+
  '<button class="btn btn-main" id="mk" style="width:100%"'+(noWords?' disabled':'')+'>새 방 열고 방 코드 받기</button>'+
  '<h3 style="margin-top:24px">친구 방에 들어가기</h3>'+
  '<label class="lbl" for="cd">방 코드 5자 (초대 링크를 붙여넣어도 됩니다)</label>'+
  '<div class="row"><input type="text" id="cd" maxlength="40" placeholder="ABC12" '+
  'style="flex:2;text-transform:uppercase" '+
  'value="'+esc(inv?inv.code:'')+'" autocomplete="off">'+
  '<button class="btn btn-ghost" id="jn" style="flex:1">입장</button></div>'+
  '<div class="err" id="er">'+esc(S.err)+'</div>'+
  '<p class="note">초대 링크를 받았거나, <b>방 코드 5자</b>만 알면 들어올 수 있습니다. 대소문자는 가리지 않습니다. '+
  '이름·그림·채팅은 같은 방 사람들에게 보이니 민감한 내용은 넣지 마세요.</p></div>'+
  '</div>';

  document.getElementById('eg').onclick=function(e){
    var b=e.target.closest('button'); if(!b)return;
    S.emIdx=+b.dataset.i; saveMe();
    Array.prototype.forEach.call(e.currentTarget.children,function(c){c.setAttribute('aria-pressed',c===b)});
  };
  document.getElementById('nm').oninput=function(e){ S.name=e.target.value };
  var mk=document.getElementById('mk'); if(mk)mk.onclick=createRoom;
  document.getElementById('jn').onclick=function(){ joinRoom(document.getElementById('cd').value) };
  var j2=document.getElementById('jn2');
  if(j2)j2.onclick=function(){ joinRoom(location.hash) };
  document.getElementById('cd').onkeydown=function(e){
    if(e.key==='Enter')joinRoom(document.getElementById('cd').value);
  };
}
function fail(m){
  S.err=m; var e=document.getElementById('er'); if(e)e.textContent=m;
}

/* ===================== 방 생성 / 입장 / 퇴장 ===================== */
function createRoom(){
  if(!wordsOk()){ fail('제시어 데이터가 없어 방을 만들 수 없습니다.'); return }
  if(!canMulti()){ fail(HTTPS_MSG); return }
  S.name=cleanName(document.getElementById('nm').value); saveMe();
  fail('연결 중…');
  prepareRoom(rid(5)).then(ensureNet).then(function(){
    S.isHost=true;
    G={ gno:0, phase:'lobby', players:{}, cfg:loadCfg(),
        order:[], rd:0, ti:0, tk:'', drawer:null,
        cands:null, word:null, used:{},
        endsAt:0, dur:0, revealed:[], solvers:[],
        rev:null, fin:null, dirty:true, lastPub:0,
        netLost:false, grace:0 };            // 방장 회선이 끊긴 동안 참가자 판정을 멈추기 위한 것
    NET.sub(tC(),onClientEvent);
    NET.sub(tD(),onDraw);
    hostAddPlayer(S.pid,S.name,S.emIdx);
    startHost(); startPing();
    S.screen='lobby'; fail(''); publish(true); render();
  },function(){
    fail(httpsWarn()
      ? '연결하지 못했습니다. 멀티플레이는 https 주소에서만 됩니다.'
      : '서버에 연결하지 못했습니다. 잠시 후 다시 시도하거나 다른 네트워크에서 열어보세요.');
  });
}
function joinRoom(raw){
  var inv=parseInvite(raw);
  if(!inv){ fail('방 코드 5자를 입력하거나 초대 링크를 붙여넣어 주세요.'); return }
  if(!canMulti()){ fail(HTTPS_MSG); return }
  S.name=cleanName(document.getElementById('nm').value); saveMe();
  fail('연결 중…');
  prepareRoom(inv.code).then(ensureNet).then(function(){
    S.isHost=false; S.lastState=0;
    NET.sub(tS(),onHostMsg);
    NET.sub(tP(S.pid),onPrivate);
    NET.sub(tD(),onDraw);
    NET.pub(tC(),{t:'join',pid:S.pid,name:S.name,em:S.emIdx});
    fail('방 찾는 중…');
    var waited=0;
    var iv=setInterval(function(){
      waited+=250;
      if(S.lastState||!S.code){clearInterval(iv);return}
      if(waited>6000){
        clearInterval(iv); NET.unsub(tS()); NET.unsub(tP(S.pid)); NET.unsub(tD());
        S.code=''; S.tid='';
        fail('그 방을 찾지 못했어요. 방 코드가 맞는지, 방장이 아직 창을 열어두었는지 확인해 주세요.');
      }
    },250);
    startPing();
  },function(){
    fail(httpsWarn()
      ? '연결하지 못했습니다. 멀티플레이는 https 주소에서만 됩니다.'
      : '서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  });
}
function leaveRoom(silent){
  if(S.code){
    if(S.isHost){ NET.pub(tS(),null,true) }
    else{ NET.pub(tC(),{t:'leave',pid:S.pid}) }
    NET.unsub(tS()); NET.unsub(tC()); NET.unsub(tD()); NET.unsub(tP(S.pid));
  }
  clearInterval(hostTimer); clearInterval(uiTimer); clearInterval(pingTimer);
  clearInterval(DRAW.timer);
  hostTimer=uiTimer=pingTimer=DRAW.timer=null;
  G=null; V=null;
  S.code=''; S.tid=''; S.isHost=false; S.myWord=null; S.myCands=null;
  S.chat=[]; S.ovlKey=''; S.seenTurn=''; S.syncedTurn=''; S.hop=0; S.hopAt=0; S.lastState=0; S.lastPub=0;
  DRAW.strokes=[]; DRAW.cur=null; DRAW.out=[]; DRAW.ctx=null; DRAW.cv=null;
  hideOvl();
  if(location.hash)history.replaceState(null,'',location.pathname);
  S.screen='home'; if(!silent)S.err='';
  render();
}
/* 나가기 확인. 방장이 나가면 방이 닫히므로 문구를 다르게 준다. */
function askLeave(){
  var msg=S.isHost
    ? '나가면 방이 닫히고 참가자 전원이 게임에서 나가게 됩니다. 나가시겠습니까?'
    : '정말 나가겠습니까?';
  if(confirm(msg))leaveRoom();
  return false;
}
function startPing(){
  clearInterval(pingTimer);
  pingTimer=setInterval(function(){
    if(!S.code||S.isHost)return;
    NET.pub(tC(),{t:'ping',pid:S.pid,name:S.name,em:S.emIdx});
    /* 숨은 탭은 타이머가 스로틀링돼 경과 시간 계산을 믿을 수 없다.
       화면이 다시 보이기 전까지는 "방장이 사라졌다"고 판단하지 않는다.
       (돌아왔더니 혼자 방에서 나가 있는 사고를 막는다) */
    if(document.visibilityState!=='visible')return;
    var now=Date.now();
    if(!S.lastState||now-S.lastState<=HOST_GONE_MS)return;
    /* 방장 소식이 끊겼다. 두 가지 경우가 있다.
       (1) 방장 탭이 그냥 죽었다 → 나가는 수밖에 없다.
       (2) 방장이 브로커에 거부당해 다른 브로커로 옮겨갔다 → 나도 따라가면 된다.
       (2)를 먼저 시도한다. 방장의 상태 메시지는 retain이라, 방장이 있는 브로커에
       구독만 붙으면 즉시 날아온다. 그래서 목록을 HOP_MS 간격으로 빠르게 쓸어본다.
       (느리게 옮기면 그 사이 방장이 또 옮겨가 서로 영영 엇갈린다.)
       두 바퀴를 쓸어도 소식이 없으면 그때 (1)로 보고 나간다. */
    if(S.hop>0&&now-S.hopAt<HOP_MS)return;      // 옮겨 붙을 시간은 준다
    if(S.hop<BROKER_HOPS&&!NET.dead()){
      S.hop++; S.hopAt=now;
      NET.promote();
      return;
    }
    hostGone();
  },PING_MS);
}
function hostGone(){
  leaveRoom(true);
  showNotice('방장과 연결이 끊겼습니다',
    '방장 쪽에서 소식이 끊겨 방에서 나왔습니다. 방 코드로 다시 들어가 보세요.','홈으로');
}

/* ===================== 방장 로직 ===================== */
function hostAddPlayer(pid,name,em){
  if(G.players[pid]){ G.players[pid].seen=Date.now(); return }
  if(Object.keys(G.players).length>=MAX_PLAYERS){
    if(pid!==S.pid)sendPriv(pid,{t:'full'});
    return;
  }
  var reds=0,blues=0;
  for(var k in G.players){ G.players[k].team==='red'?reds++:blues++ }
  G.players[pid]={
    pid:pid, name:cleanName(name), em:EMOJIS[(+em||0)%EMOJIS.length],
    team: reds<=blues?'red':'blue',
    sc:0, gain:0, ok:false,
    play: G.phase==='lobby',          // 게임 중 입장자는 다음 라운드부터
    away:false,
    joinAt:Date.now(), seen:Date.now()
  };
  G.dirty=true;
}
function onClientEvent(m){
  if(!S.isHost||!G||!m||!m.pid)return;
  var p=G.players[m.pid];
  if(m.t==='join'||m.t==='ping'){
    if(p){
      p.seen=Date.now();
      if(p.away){ p.away=false; G.dirty=true }        // 돌아왔다
      if(m.name&&p.name!==cleanName(m.name)){ p.name=cleanName(m.name); G.dirty=true }
    }else hostAddPlayer(m.pid,m.name,m.em);
    if(m.t==='join')G.dirty=true;
    return;
  }
  if(!p)return;
  p.seen=Date.now();
  if(m.t==='leave'){ delete G.players[m.pid]; G.dirty=true }
  else if(m.t==='team'){
    if(G.phase==='lobby'&&(m.team==='red'||m.team==='blue')){ p.team=m.team; G.dirty=true }
  }
  else if(m.t==='chat'){ hostChat(m.pid,m.id,m.x) }
  else if(m.t==='pick'){
    if(G.phase==='pick'&&m.pid===G.drawer&&m.tk===G.tk)confirmWord(+m.i||0);
  }
  else if(m.t==='sync'){
    if(G.drawer)sendPriv(G.drawer,{t:'syncreq'});
  }
}
function startHost(){
  clearInterval(hostTimer);
  hostTimer=setInterval(hostTick,TICK_MS);
}
function hostTick(){
  if(!G)return;
  var t=Date.now();

  /* 방장 자신이 브로커와 끊겨 있는 동안에는 참가자 판정을 멈춘다.
     내 회선 문제로 ping이 안 들어오는 것뿐인데 방을 해체하면 안 된다.
     다시 붙은 뒤에도 유예를 주고 나서 세기 시작한다. */
  if(!NET.online()){ G.netLost=true }
  else if(G.netLost){ G.netLost=false; G.grace=t+NET_GRACE_MS }
  var judging = NET.online() && t>=(G.grace||0);

  /* 자리 비움 "해제"는 벌칙이 아니라 복구다. 유예(judging)와 무관하게 즉시 반영한다.
     돌아온 사람이 몇 십 초씩 자리 비움으로 남아 있으면 정답 판정에서도 빠져 버린다. */
  for(var rp in G.players){
    var rq=G.players[rp];
    if(rq.away&&t-rq.seen<=AWAY_MS){ rq.away=false; G.dirty=true }
  }

  if(judging){
    for(var pid in G.players){
      if(pid===S.pid)continue;
      var p=G.players[pid], silent=t-p.seen, isDrawer=(pid===G.drawer);
      var inTurn=(G.phase==='pick'||G.phase==='draw');

      if(silent>DROP_MS){                         // 진짜로 나갔다 — 목록에서 제거
        delete G.players[pid]; G.dirty=true;
        if(isDrawer&&inTurn){ voidTurn(p.name+'님이 나가서 이번 차례를 넘깁니다.'); return }
        continue;
      }
      if(silent>AWAY_MS){                         // 자리 비움 — 점수·순서는 그대로 둔다
        if(!p.away){ p.away=true; G.dirty=true }
        /* 출제자가 자리를 비우면 그림이 멈춰 다들 기다리기만 한다. 바로 넘긴다.
           (제거는 하지 않으므로 다음 턴부터 다시 참가한다) */
        if(isDrawer&&inTurn){ voidTurn(p.name+'님이 자리를 비워 이번 차례를 넘깁니다.'); return }
      }
    }

    /* 남은 인원이 2명 미만이면 게임을 중단하고 대기실로.
       자리 비움은 아직 방에 있는 사람이므로 여기 인원수에 포함된다(제거된 사람만 빠진다). */
    if(G.phase!=='lobby'&&Object.keys(G.players).length<2){
      sysAll('남은 인원이 부족해 대기실로 돌아갑니다.','bad');
      backToLobby(); return;
    }
  }

  if(G.phase==='pick'){
    if(t>=G.endsAt)confirmWord(0);            // 10초 안에 안 고르면 첫 번째
  }else if(G.phase==='draw'){
    updateHint(t);
    if(t>=G.endsAt||allSolved())endTurn();
  }else if(G.phase==='reveal'){
    if(t>=G.endsAt)nextTurn();
  }
  if(G.dirty||Date.now()-G.lastPub>STATE_MS)publish();
}
function nameOf(pid){ var p=G.players[pid]; return p?p.name:'참가자' }

function startReason(){
  var list=[],k;
  for(k in G.players)list.push(G.players[k]);
  if(!wordsOk())return '제시어 데이터를 불러오지 못했습니다.';
  if(wordPool(G.cfg).length<3)return '고른 난이도·카테고리에 제시어가 3개도 없습니다. 조건을 넓혀 주세요.';
  if(G.cfg.mode==='team'){
    var r=list.filter(function(p){return p.team==='red'}).length;
    var b=list.filter(function(p){return p.team==='blue'}).length;
    if(list.length<4)return '팀전은 4명부터 시작할 수 있습니다. (지금 '+list.length+'명)';
    if(r!==b)return '양 팀 인원이 같아야 시작할 수 있습니다. (레드 '+r+' · 블루 '+b+')';
  }else if(list.length<2){
    return '2명부터 시작할 수 있습니다. 친구를 초대해 주세요.';
  }
  return '';
}
function buildOrder(){
  var list=[],k;
  for(k in G.players)list.push(G.players[k]);
  list.sort(function(a,b){return a.joinAt-b.joinAt});
  list.forEach(function(p){ p.play=true });
  if(G.cfg.mode==='team'){
    var red=list.filter(function(p){return p.team==='red'});
    var blue=list.filter(function(p){return p.team==='blue'});
    var out=[],i=0;
    while(i<red.length||i<blue.length){          // 레드 → 블루 번갈아
      if(i<red.length)out.push(red[i].pid);
      if(i<blue.length)out.push(blue[i].pid);
      i++;
    }
    G.order=out;
  }else{
    G.order=list.map(function(p){return p.pid});
  }
}
function startGame(){
  if(startReason())return;
  G.gno++; G.used={}; G.fin=null;
  for(var k in G.players){
    var p=G.players[k]; p.sc=0; p.gain=0; p.ok=false;
  }
  G.rd=1; buildOrder(); G.ti=0;
  saveCfg();
  beginTurn();
}
function beginTurn(){
  /* 이탈자 건너뛰기 */
  var guard=0;
  while(G.ti<G.order.length&&guard++<MAX_PLAYERS*2){
    var cand=G.players[G.order[G.ti]];
    if(cand&&!cand.away)break;                      // 나갔거나 자리 비운 사람은 출제자가 될 수 없다
    G.ti++;
  }
  if(G.ti>=G.order.length){ advanceRound(); return }

  G.drawer=G.order[G.ti];
  G.tk=G.gno+'_'+G.rd+'_'+G.ti;
  G.phase='pick'; G.dur=PICK_MS; G.endsAt=Date.now()+PICK_MS;
  G.word=null; G.revealed=[]; G.solvers=[]; G.rev=null;
  for(var k in G.players){ G.players[k].ok=false; G.players[k].gain=0 }

  G.cands=pick3();
  sendPriv(G.drawer,{t:'cands',tk:G.tk,list:G.cands});
  G.dirty=true; publish(true);
}
function pick3(){
  var pool=wordPool(G.cfg);
  var fresh=pool.filter(function(w){return !G.used[w.w]});
  if(fresh.length<3){ G.used={}; fresh=pool }
  return shuffle(fresh).slice(0,3).map(function(w){
    return {w:w.w,c:w.c,d:w.d,a:w.a||[]};
  });
}
function confirmWord(i){
  if(!G.cands||!G.cands.length)return;
  var idx=clamp(i|0,0,G.cands.length-1);
  G.word=G.cands[idx]; G.used[G.word.w]=1;
  G.phase='draw'; G.dur=G.cfg.tl*1000; G.endsAt=Date.now()+G.dur;
  G.revealed=[]; G.solvers=[];
  sendPriv(G.drawer,{t:'go',tk:G.tk,i:idx,word:G.word});
  sysAll(nameOf(G.drawer)+'님이 그리기 시작했습니다.','');
  G.dirty=true; publish(true);
}
/* 정답을 맞힐 자격이 있는 사람 (출제자 제외 · 팀전이면 같은 팀만) */
function eligible(p){
  if(!p||!p.play||p.away||p.pid===G.drawer)return false;
  if(G.cfg.mode==='team'){
    var d=G.players[G.drawer];
    if(!d||p.team!==d.team)return false;
  }
  return true;
}
function allSolved(){
  var any=false,k;
  for(k in G.players){
    var p=G.players[k];
    if(!eligible(p))continue;
    any=true;
    if(!p.ok)return false;
  }
  return any;
}
function updateHint(t){
  if(!G.cfg.hint||!G.word)return;
  var chars=G.word.w.split('');
  var idxs=[];
  chars.forEach(function(c,i){ if(c.trim())idxs.push(i) });
  var maxReveal=Math.max(0,idxs.length-1);
  var ratio=(G.endsAt-t)/G.dur;
  var want=0;
  for(var i=0;i<HINT_STEPS.length;i++)if(ratio<=HINT_STEPS[i])want=i+1;
  want=Math.min(want,maxReveal);
  while(G.revealed.length<want){
    var rest=idxs.filter(function(i){return G.revealed.indexOf(i)<0});
    if(!rest.length)break;
    G.revealed.push(rest[Math.floor(Math.random()*rest.length)]);
    G.dirty=true;
  }
}
function maskOf(){
  if(!G.word)return '';
  if(!G.cfg.hint)return '';
  return G.word.w.split('').map(function(c,i){
    if(!c.trim())return ' ';
    return G.revealed.indexOf(i)>=0?c:'_';
  }).join(' ');
}
function endTurn(){
  var rows=[],k;
  G.solvers.forEach(function(pid){
    var p=G.players[pid];
    if(p)rows.push({n:p.name,e:p.em,p:p.gain});
  });
  var d=G.players[G.drawer];
  var dpts=G.solvers.length*SC_DRAWER;
  if(d){ d.sc+=dpts; d.gain=dpts }
  G.rev={ w:G.word?G.word.w:'', rows:rows, none:rows.length===0,
          dr: d?{n:d.name,e:d.em,p:dpts}:null };
  G.phase='reveal'; G.dur=REVEAL_MS; G.endsAt=Date.now()+REVEAL_MS;
  G.dirty=true; publish(true);
}
/* 출제자가 중간에 사라진 턴은 무효다. 이미 준 점수를 되돌리고 다음 턴으로 넘어간다. */
function voidTurn(msg){
  G.solvers.forEach(function(pid){
    var p=G.players[pid];
    if(p){ p.sc-=p.gain; p.gain=0; p.ok=false }
  });
  G.solvers=[]; G.rev=null; G.word=null; G.cands=null;
  sysAll(msg,'bad');
  nextTurn();
}
function nextTurn(){
  G.ti++;
  if(G.ti>=G.order.length)advanceRound();
  else beginTurn();
}
function advanceRound(){
  G.rd++;
  if(G.rd>G.cfg.rounds){ finish(); return }
  buildOrder(); G.ti=0; beginTurn();
}
function finish(){
  var list=[],k;
  for(k in G.players)list.push(G.players[k]);
  list.sort(function(a,b){return b.sc-a.sc});
  var teams={red:0,blue:0};
  list.forEach(function(p){ teams[p.team]=(teams[p.team]||0)+p.sc });
  G.fin={
    rows:list.map(function(p){return {n:p.name,e:p.em,sc:p.sc,team:p.team}}),
    teams:teams, mode:G.cfg.mode
  };
  G.phase='final'; G.drawer=null; G.word=null; G.cands=null;
  G.dirty=true; publish(true);
}
function backToLobby(){
  if(!G)return;
  G.phase='lobby'; G.rev=null; G.fin=null; G.word=null; G.cands=null; G.drawer=null;
  for(var k in G.players){ var p=G.players[k]; p.sc=0; p.gain=0; p.ok=false; p.play=true }
  G.dirty=true; publish(true);
}

/* ===== 방장: 채팅 · 정답 판정 ===== */
function isAnswer(text,w){
  var n=norm(text);
  if(!n)return false;
  if(n===norm(w.w))return true;
  var a=w.a||[];
  for(var i=0;i<a.length;i++)if(n===norm(a[i]))return true;
  return false;
}
function isNear(text,w){
  var n=norm(text);
  if(n.length<2)return false;
  if(near1(n,norm(w.w)))return true;
  var a=w.a||[];
  for(var i=0;i<a.length;i++)if(near1(n,norm(a[i])))return true;
  return false;
}
function maskWord(text,w){
  var terms=[w.w].concat(w.a||[]);
  var out=text;
  terms.forEach(function(t){
    if(!t)return;
    var re=new RegExp(String(t).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi');
    out=out.replace(re,function(m){ return new Array(m.length+1).join('●') });
  });
  return out;
}
function hostChat(pid,id,raw){
  var p=G.players[pid]; if(!p)return;
  var text=String(raw||'').replace(/\s+/g,' ').trim().slice(0,CHAT_MAX);
  if(!text)return;

  if(G.phase==='draw'&&G.word){
    if(pid===G.drawer)return;                       // 출제자는 채팅 잠금
    if(p.ok)return;                                 // 이미 맞힌 사람도 잠금 (누설 차단)
    if(eligible(p)){
      if(isAnswer(text,G.word)){ award(p); return }
      if(isNear(text,G.word)){ sendPriv(pid,{t:'near'}); return }
    }
    bcastChat(p,maskWord(text,G.word),id);          // 제시어가 섞여 있으면 가린다
    return;
  }
  bcastChat(p,text,id);
}
function award(p){
  var remain=Math.max(0,G.endsAt-Date.now());
  var pts=SC_BASE+Math.round(SC_TIME*remain/G.dur);
  var rank=G.solvers.length;
  if(rank<SC_RANK.length)pts+=SC_RANK[rank];
  p.sc+=pts; p.gain=pts; p.ok=true;
  G.solvers.push(p.pid);
  sysAll(p.name+'님 정답! (+'+pts+')','ok');         // 원문은 절대 뿌리지 않는다
  G.dirty=true;
}
function bcastChat(p,text,id){
  pushMsg({id:String(id||rid(6)),ty:'chat',pid:p.pid,n:p.name,e:p.em,x:text,team:p.team});
}
function sysAll(text,tone){
  pushMsg({id:rid(6),ty:'sys',x:text,tone:tone||''});
}
function pushMsg(m){
  NET.pub(tS(),{k:'msg',m:m});    // non-retain: retain된 상태 메시지를 덮지 않는다
  handleMsg(m);                   // 방장 화면에는 즉시
}
function sendPriv(pid,obj){
  if(pid===S.pid)onPrivate(obj);
  else NET.pub(tP(pid),obj);
}

/* ===== 방장: 상태 발행 ===== */
function publish(force){
  if(!G)return;
  G.dirty=false; G.lastPub=Date.now();
  var list=[],k;
  for(k in G.players){
    var p=G.players[k];
    list.push({pid:p.pid,n:p.name,e:p.em,team:p.team,sc:p.sc,ok:p.ok,play:p.play,gain:p.gain,away:!!p.away});
  }
  list.sort(function(a,b){return b.sc-a.sc||a.n.localeCompare(b.n)});
  var v={
    k:'state', gno:G.gno, ph:G.phase, host:S.pid,
    mode:G.cfg.mode, rounds:G.cfg.rounds, tl:G.cfg.tl, hint:G.cfg.hint,
    diff:G.cfg.diff, cats:G.cfg.cats,
    rd:G.rd, ti:G.ti+1, tt:G.order.length, tk:G.tk,
    drawer:G.drawer, endsAt:G.endsAt, dur:G.dur,
    mask:(G.phase==='draw')?maskOf():'',
    /* 힌트 끄기면 글자 수·카테고리를 payload에도 싣지 않는다.
       화면에서만 감추면 개발자도구로 그대로 보여 힌트 끄기가 무의미해진다. */
    wlen:(G.cfg.hint&&G.word)?G.word.w.replace(/\s/g,'').length:0,
    cat:(G.cfg.hint&&G.word)?G.word.c:'',
    players:list, rev:(G.phase==='reveal')?G.rev:null,
    fin:(G.phase==='final')?G.fin:null,
    pub:Date.now()
  };
  V=v; S.offset=0; S.lastState=Date.now();
  NET.pub(tS(),v,true);
  applyView();
}

/* ===================== 클라이언트 수신 ===================== */
function onHostMsg(v){
  if(!v){
    if(S.screen!=='home')roomClosed();
    return;
  }
  if(v.k==='msg'){ handleMsg(v.m); return }
  if(v.k!=='state')return;
  /* 살아 있다는 증거는 "메시지가 왔다"가 아니라 "새 메시지가 왔다"이다.
     방장이 떠난 브로커에도 retain된 옛 상태가 그대로 남아 있어서, 도착만으로
     판단하면 죽은 브로커에 눌러앉게 된다. 방장은 STATE_MS마다 pub을 갱신하므로
     pub이 그대로면 그건 화석이다. */
  if(v.pub!==S.lastPub){
    S.lastPub=v.pub; S.lastState=Date.now(); S.hop=0;
  }
  S.offset=v.pub-Date.now();
  V=v; fail(''); applyView();
}
function onPrivate(m){
  if(!m)return;
  if(m.t==='cands'){ S.myCands=m.list; S.myWord=null; S.ovlKey=''; paintOvl() }
  else if(m.t==='go'){ S.myWord=m.word; S.ovlKey=''; paintOvl(); paintGame() }
  else if(m.t==='near'){ handleMsg({id:rid(6),ty:'sys',x:'아깝다! 거의 맞았어요',tone:'near'}) }
  else if(m.t==='syncreq'){ sendSnapshot() }
  else if(m.t==='full'){
    leaveRoom(true);
    showNotice('방이 꽉 찼습니다','한 방에는 최대 '+MAX_PLAYERS+'명까지 들어갈 수 있습니다.','홈으로');
  }
}
function handleMsg(m){
  if(!m||!m.x)return;
  for(var i=0;i<S.chat.length;i++)if(S.chat[i].id===m.id)return;   // 에코 중복 제거
  S.chat.push(m);
  if(S.chat.length>60)S.chat.shift();
  paintChat();
}

/* ===================== 화면 전환 ===================== */
function applyView(){
  if(!V)return;
  var target=V.ph==='lobby'?'lobby':'game';
  if(target!==S.screen){ S.screen=target; render() }
  else if(S.screen==='lobby')paintLobby();
  else if(S.screen==='game')paintGame();

  if(V.tk&&V.tk!==S.seenTurn){          // 새 턴 → 캔버스 초기화
    S.seenTurn=V.tk;
    resetCanvas();
    if(!amDrawer()){ S.myWord=null; S.myCands=null }
  }
  requestSyncIfLate();
  paintOvl();
  paintNav();
}
function render(){
  unlockScroll();                                // 화면이 바뀌는데 잠금이 남아 있으면 안 된다
  hideOvl();
  if(S.screen==='home')renderHome();
  else if(S.screen==='lobby')renderLobby();
  else if(S.screen==='game')renderGame();
  paintNav();
}
function paintNav(){
  setHTML(navmid, S.code?('방 <b>'+esc(S.code)+'</b>'+(S.isHost?' · 방장':'')):'');
}
function amDrawer(){ return !!(V&&V.drawer&&V.drawer===S.pid) }
function myRow(){
  if(!V)return null;
  for(var i=0;i<V.players.length;i++)if(V.players[i].pid===S.pid)return V.players[i];
  return null;
}
function drawerRow(){
  if(!V||!V.drawer)return null;
  for(var i=0;i<V.players.length;i++)if(V.players[i].pid===V.drawer)return V.players[i];
  return null;
}
function remainMs(){
  if(!V||!V.endsAt)return 0;
  return Math.max(0,V.endsAt-nowSync());
}

/* ===================== 대기실 ===================== */
function renderLobby(){
  app.innerHTML=
  '<div class="narrow">'+
  '<div class="codebox"><div class="lbl2">방 코드</div><div class="code">'+esc(S.code)+'</div>'+
  '<div style="font-size:12.5px;color:var(--muted);line-height:1.6">친구에게 <b>이 코드</b>만 알려주면 됩니다<br>'+
  '(링크를 보내도 되고, 코드 5자만 불러줘도 됩니다)</div>'+
  '<div class="row" style="margin-top:12px">'+
  '<button class="btn btn-ghost" id="cp" style="font-size:13px">초대 링크 복사</button>'+
  '<button class="btn btn-ghost" id="cp2" style="font-size:13px">초대 코드 복사</button></div></div>'+

  '<div class="card"><h3>참가자 <span id="pc" style="color:var(--muted);font-weight:400"></span></h3>'+
  '<div class="players" id="pl"></div><div id="tsel"></div></div>'+

  '<div class="card" id="hostbox"></div>'+

  '<div class="card"><h3>대기실 채팅</h3>'+chatHTML('메시지')+'</div>'+

  '<button class="btn btn-ghost" id="lv" style="width:100%;margin-top:16px">방 나가기</button>'+
  '<p class="note">방장이 창을 닫으면 방이 닫힙니다. 게임 도중 들어온 사람은 관전하다가 다음 라운드부터 참가합니다.</p>'+
  '</div>';

  document.getElementById('lv').onclick=function(){ askLeave() };
  document.getElementById('cp').onclick=function(e){ copy(inviteLink(),e.target,'초대 링크 복사') };
  document.getElementById('cp2').onclick=function(e){ copy(S.code,e.target,'초대 코드 복사') };
  bindChat();
  paintLobby(); paintChat();
}
function copy(txt,btn,orig){
  function done(){ btn.textContent='복사했어요'; setTimeout(function(){btn.textContent=orig},1800) }
  function fallback(){
    var ta=document.createElement('textarea');
    ta.value=txt; ta.style.position='fixed'; ta.style.opacity='0';
    document.body.appendChild(ta); ta.select();
    try{ document.execCommand('copy'); done() }catch(e){ prompt('복사해서 공유하세요',txt) }
    document.body.removeChild(ta);
  }
  if(navigator.clipboard&&navigator.clipboard.writeText)
    navigator.clipboard.writeText(txt).then(done,fallback);
  else fallback();
}
function paintLobby(){
  if(!V)return;
  var pl=document.getElementById('pl'); if(!pl)return;
  document.getElementById('pc').textContent=V.players.length+' / '+MAX_PLAYERS+'명';
  setHTML(pl, V.players.map(function(p){
    var cls=p.pid===V.host?' host':'';
    if(V.mode==='team')cls+=' '+p.team;
    return '<div class="pchip'+cls+'"><span class="av">'+esc(p.e)+'</span><span>'+esc(p.n)+'</span>'+
      (V.mode==='team'?'<span class="tag" style="color:var(--'+p.team+')">'+(p.team==='red'?'🔴 레드':'🔵 블루')+'</span>':'')+
      (p.away?'<span class="tag" style="color:var(--warn)">자리 비움</span>':'')+
      (p.pid===V.host?'<span class="tag">👑 방장</span>':'')+
      (p.pid===S.pid?'<span class="tag">나</span>':'')+'</div>';
  }).join(''));

  var ts=document.getElementById('tsel');
  if(V.mode==='team'){
    var me=myRow(), mine=me?me.team:'red';
    var built=setHTML(ts,'<div class="teamsel">'+
      '<button type="button" class="red" data-t="red" aria-pressed="'+(mine==='red')+'">🔴 레드팀</button>'+
      '<button type="button" class="blue" data-t="blue" aria-pressed="'+(mine==='blue')+'">🔵 블루팀</button></div>'+
      '<p class="hintline">팀전은 4명 이상, 양 팀 인원이 같아야 시작합니다. 출제자의 같은 팀원만 정답을 맞힐 수 있습니다.</p>');
    if(built)ts.querySelector('.teamsel').onclick=function(e){   // 다시 만들었을 때만 붙인다
      var b=e.target.closest('button'); if(!b)return;
      if(S.isHost){ G.players[S.pid].team=b.dataset.t; G.dirty=true; publish(true) }
      else NET.pub(tC(),{t:'team',pid:S.pid,team:b.dataset.t});
    };
  }else setHTML(ts,'');

  var hb=document.getElementById('hostbox');
  if(S.isHost&&G)paintHostBox(hb);
  else setHTML(hb,'<h3>대기 중</h3><p style="color:var(--muted);font-size:13.5px;line-height:1.7">'+
      '<b>'+(V.mode==='team'?'⚔️ 팀전':'🎯 개인전')+'</b> · '+V.rounds+'라운드 · 라운드당 '+V.tl+'초<br>'+
      '방장이 시작하면 첫 차례가 바로 시작합니다.</p>');
}
function paintHostBox(hb){
  var cats=allCats();
  var picked={}; (G.cfg.cats||[]).forEach(function(c){picked[c]=1});
  var allOn=!G.cfg.cats.length;
  var n=Object.keys(G.players).length;
  var reason=startReason();

  /* 설정 패널은 버튼이 수십 개라 만드는 것 자체가 비싸다. 화면에 영향을 주는 값이
     그대로면 문자열조차 만들지 않고 넘어간다. */
  var key=G.cfg.mode+'|'+G.cfg.rounds+'|'+G.cfg.tl+'|'+G.cfg.diff+'|'+
          (G.cfg.cats||[]).join(',')+'|'+G.cfg.hint+'|'+n+'|'+reason+'|'+cats.length;
  if(hb.__k===key)return;
  hb.__k=key;

  hb.innerHTML='<h3>게임 설정</h3>'+
   '<label class="lbl">모드</label><div class="opt wide" id="o_mode">'+
   '<button type="button" data-v="solo" aria-pressed="'+(G.cfg.mode==='solo')+'">🎯 개인전</button>'+
   '<button type="button" data-v="team" aria-pressed="'+(G.cfg.mode==='team')+'">⚔️ 팀전</button></div>'+

   '<label class="lbl" style="margin-top:16px">라운드 <span style="color:var(--muted-2)">— 1라운드 = 전원이 한 번씩 출제</span></label>'+
   '<div class="opt wide" id="o_rd">'+
   ROUND_OPTS.map(function(r){
     var mins=Math.max(1,Math.round(n*r*(G.cfg.tl+TURN_GAP_S)/60));
     return '<button type="button" data-v="'+r+'" aria-pressed="'+(G.cfg.rounds===r)+'">'+r+'라운드'+
            '<span style="display:block;font-size:10.5px;opacity:.75;margin-top:2px">약 '+mins+'분</span></button>';
   }).join('')+'</div>'+
   '<p class="hintline">'+n+'명 기준 · 전체 '+(n*G.cfg.rounds)+'차례</p>'+

   '<label class="lbl" style="margin-top:16px">차례당 제한시간</label><div class="opt" id="o_tl">'+
   TIME_OPTS.map(function(t){return '<button type="button" data-v="'+t+'" aria-pressed="'+(G.cfg.tl===t)+'">'+t+'초</button>'}).join('')+
   '</div>'+

   '<label class="lbl" style="margin-top:16px">난이도</label><div class="opt" id="o_df">'+
   DIFF_OPTS.map(function(d){return '<button type="button" data-v="'+d.v+'" aria-pressed="'+(G.cfg.diff===d.v)+'">'+d.t+'</button>'}).join('')+
   '</div>'+

   '<label class="lbl" style="margin-top:16px">카테고리</label><div class="opt" id="o_ct">'+
   '<button type="button" data-v="__all" aria-pressed="'+allOn+'">전체</button>'+
   cats.map(function(c){return '<button type="button" data-v="'+esc(c)+'" aria-pressed="'+(!allOn&&!!picked[c])+'">'+esc(c)+'</button>'}).join('')+
   '</div>'+

   '<label class="lbl" style="margin-top:16px">힌트(카테고리·글자 수·중간 공개)</label><div class="opt" id="o_hn">'+
   '<button type="button" data-v="1" aria-pressed="'+(G.cfg.hint===true)+'">켜기</button>'+
   '<button type="button" data-v="0" aria-pressed="'+(G.cfg.hint===false)+'">끄기</button></div>'+

   '<button class="btn btn-main" id="go" style="width:100%;margin-top:20px"'+(reason?' disabled':'')+'>게임 시작</button>'+
   '<div class="reason">'+esc(reason)+'</div>'+
   '<p class="note">인원이 몇 명이든 자동으로 시작하지 않습니다. 방장이 눌러야 시작합니다.</p>';

  function opt(id,fn){
    var el=hb.querySelector('#'+id); if(!el)return;
    el.onclick=function(e){
      var b=e.target.closest('button'); if(!b)return;
      fn(b.dataset.v); G.dirty=true; saveCfg(); publish(true);
    };
  }
  opt('o_mode',function(v){ G.cfg.mode=v });
  opt('o_rd',function(v){ G.cfg.rounds=+v });
  opt('o_tl',function(v){ G.cfg.tl=+v });
  opt('o_df',function(v){ G.cfg.diff=v });
  opt('o_hn',function(v){ G.cfg.hint=(v==='1') });
  opt('o_ct',function(v){
    if(v==='__all'){ G.cfg.cats=[]; return }
    var i=G.cfg.cats.indexOf(v);
    if(i>=0)G.cfg.cats.splice(i,1); else G.cfg.cats.push(v);
    if(G.cfg.cats.length===allCats().length)G.cfg.cats=[];   // 전부 고르면 = 전체
  });
  hb.querySelector('#go').onclick=function(){ startGame() };
}

/* ===================== 게임 화면 ===================== */
function renderGame(){
  app.innerHTML=
  '<div class="hud"><div class="rd" id="hrd"></div><div class="clock" id="hcl">--</div></div>'+
  '<div class="tbar"><div class="tfill" id="tf"></div></div>'+
  '<div class="wordbar"><div class="cat" id="wcat"></div>'+
  '<div class="mask" id="wmask"></div><div class="sub" id="wsub"></div></div>'+

  '<div class="gamegrid">'+
  '<div class="gcol players-col"><h4>참가자</h4><div class="plist" id="plist"></div></div>'+
  '<div class="gcol canvas-col">'+
    '<div class="cvrow">'+
      '<div class="cvwrap"><canvas id="cv"></canvas><div class="cvlock" id="cvlock"></div></div>'+
      '<div class="scrollgrip" id="sgrip" role="scrollbar" aria-label="화면 스크롤" aria-controls="app">'+
        '<span class="ar">▲</span><span class="lbl">스크롤</span><span class="ar">▼</span></div>'+
    '</div>'+
    '<div class="tools" id="tools">'+
      '<div class="swatches" id="sw">'+
      COLORS.map(function(c,i){
        return '<button type="button" class="sw" data-c="'+c+'" style="background:'+c+'" '+
               'aria-pressed="'+(i===0)+'" aria-label="색 '+(i+1)+'"></button>';
      }).join('')+'</div>'+
      '<div class="toolrow" id="tr">'+
      WIDTHS.map(function(w,i){
        var d=Math.min(22,w+4);
        return '<button type="button" class="tbtn wbtn" data-w="'+w+'" aria-pressed="'+(i===1)+'" aria-label="굵기 '+w+'">'+
               '<span class="wdot" style="width:'+d+'px;height:'+d+'px"></span></button>';
      }).join('')+
      '<button type="button" class="tbtn" id="tEr" aria-pressed="false">🩹 지우개</button>'+
      '<button type="button" class="tbtn" id="tUn">↩︎ 되돌리기</button>'+
      '<button type="button" class="tbtn" id="tCl">🗑 전체지우기</button>'+
      '</div>'+
      '<div class="toolnote">글자·숫자를 쓰지 마세요. 그림으로만 표현해 주세요.</div>'+
    '</div>'+
  '</div>'+
  '<div class="gcol chat-col"><h4>채팅 · 정답</h4>'+chatHTML('정답을 입력하세요')+'</div>'+
  '</div>'+
  '<button class="btn btn-ghost" id="lv" style="width:100%;margin-top:16px;font-size:13px">방 나가기</button>';

  document.getElementById('lv').onclick=function(){ askLeave() };
  bindChat();
  initCanvas();
  bindTools();
  bindGrip();
  clearInterval(uiTimer); uiTimer=setInterval(tickUI,UI_MS);
  paintGame(); paintChat();
}
function tickUI(){
  if(!V)return;
  var cl=document.getElementById('hcl'), tf=document.getElementById('tf');
  if(!cl||!tf)return;
  var rest=remainMs(), dur=V.dur||1;
  var sec=Math.ceil(rest/1000);
  if(V.ph==='draw'||V.ph==='pick'){
    cl.textContent=sec+'초';
    var warn=(V.ph==='draw'&&rest/dur<=0.25);
    cl.classList.toggle('warn',warn);
    tf.classList.toggle('warn',warn);
    tf.style.width=clamp(rest/dur*100,0,100)+'%';
  }else{
    cl.textContent=V.ph==='reveal'?'공개':'—';
    cl.classList.remove('warn'); tf.classList.remove('warn');
    tf.style.width=V.ph==='reveal'?clamp(rest/dur*100,0,100)+'%':'0%';
  }
  var pc=document.getElementById('pickCd');
  if(pc)pc.textContent=sec+'초';
}
function paintGame(){
  if(!V||!document.getElementById('hrd'))return;
  var dr=drawerRow(), me=myRow(), iAm=amDrawer();

  setHTML(document.getElementById('hrd'),
    (V.ph==='final'?'<b>게임 종료</b>'
     :'라운드 <b>'+V.rd+' / '+V.rounds+'</b> · <b>'+V.ti+'</b>번째 차례 / '+V.tt)+
    (dr?' · 출제자 '+esc(dr.e)+' <b>'+esc(dr.n)+'</b>':''));

  /* 제시어 줄 */
  var wcat=document.getElementById('wcat'), wmask=document.getElementById('wmask'), wsub=document.getElementById('wsub');
  wmask.classList.remove('mine');
  if(V.ph==='pick'){
    wcat.textContent='제시어 선택';
    wmask.textContent=dr?dr.n+'님이 제시어를 고르는 중…':'…';
    wsub.textContent=iAm?'세 개 중 하나를 고르세요.':'잠시만 기다려 주세요.';
  }else if(V.ph==='draw'){
    /* 힌트 끄기는 "아무 단서도 주지 않는다"는 뜻이다.
       글자 수·카테고리도 단서이므로 같이 감춘다. 출제자 본인은 예외. */
    wcat.textContent=(V.hint&&V.cat)?('카테고리 · '+V.cat):'';
    if(iAm&&S.myWord){ wmask.textContent=S.myWord.w; wmask.classList.add('mine'); wsub.textContent='이 제시어를 그림으로만 표현하세요.' }
    else if(V.hint&&V.mask){ wmask.textContent=V.mask; wsub.textContent=V.wlen+'글자' }
    else{ wmask.textContent='? ? ?'; wsub.textContent='' }
  }else if(V.ph==='reveal'){
    wcat.textContent='정답';
    wmask.textContent=V.rev?V.rev.w:'';
    wsub.textContent='';
  }else{
    wcat.textContent=''; wmask.textContent=''; wsub.textContent='';
  }

  /* 참가자 목록 */
  setHTML(document.getElementById('plist'), V.players.map(function(p){
    var cls='pl';
    if(p.pid===S.pid)cls+=' me';
    if(p.pid===V.drawer)cls+=' drawer';
    else if(p.ok)cls+=' ok';
    if(p.away)cls+=' away';
    if(!p.play)cls+=' wait';
    if(V.mode==='team')cls+=(p.team==='red'?' tred':' tblue');
    return '<div class="'+cls+'"><span class="av">'+esc(p.e)+'</span>'+
      '<span class="nm">'+esc(p.n)+'</span>'+
      (p.away?'<span class="bdg a">자리 비움</span>'
        :p.pid===V.drawer?'<span class="bdg d">그리는 중</span>'
        :p.ok?'<span class="bdg o">정답</span>':'')+
      '<span class="sc">'+p.sc+'</span></div>';
  }).join(''));

  /* 캔버스 잠금 · 도구바 */
  var tools=document.getElementById('tools'), lock=document.getElementById('cvlock');
  var drawing=iAm&&V.ph==='draw';
  tools.classList.toggle('on',drawing);
  /* 지금 그릴 수 있을 때만 캔버스가 터치를 삼킨다. 맞히는 사람에게는 캔버스 위에서도
     페이지가 평소처럼 스크롤돼야 한다(죽은 구역 방지). */
  setFlag(DRAW.cv,'drawable',drawing);
  /* 출제자는 캔버스가 터치를 삼키니 옆에 스크롤 그립을 준다. 모바일에서만. */
  setFlag(document.getElementById('sgrip'),'on',drawing&&isCoarse());
  if(!drawing)unlockScroll();
  var lockMsg='';
  if(V.ph==='pick')lockMsg=iAm?'제시어를 고르는 중…':(dr?dr.n+'님이 제시어를 고르는 중…':'');
  else if(V.ph==='final')lockMsg='게임이 끝났습니다.';
  lock.textContent=lockMsg;
  lock.classList.toggle('on',!!lockMsg);

  /* 채팅 입력 잠금 */
  var inp=document.getElementById('cmsg'), snd=document.getElementById('csend');
  var lockChat=false, ph='메시지';
  if(V.ph==='draw'){
    if(iAm){ lockChat=true; ph='출제자는 채팅할 수 없습니다' }
    else if(me&&me.ok){ lockChat=true; ph='정답! 이번 차례에는 채팅할 수 없습니다' }
    else if(!me||!me.play){ ph='관전 중 — 다음 라운드부터 참가합니다' }
    else if(V.mode==='team'&&dr&&me.team!==dr.team){ ph='상대팀 차례 — 정답은 맞힐 수 없어요' }
    else ph='정답을 입력하세요';
  }
  if(inp){ inp.disabled=lockChat; inp.placeholder=ph }
  if(snd)snd.disabled=lockChat;
}

/* ===================== 오버레이 ===================== */
function hideOvl(){ ovl.classList.remove('show'); ovl.innerHTML=''; S.ovlKey='' }
/* 안내 오버레이 (방 종료 등) — 확인을 누르면 홈으로 */
function showNotice(title,body,btn){
  ovl.innerHTML='<div class="obox"><h2>'+esc(title)+'</h2>'+
    '<p class="osub">'+esc(body)+'</p>'+
    '<button class="btn btn-main" id="ntOk" style="width:100%">'+esc(btn||'홈으로')+'</button></div>';
  ovl.classList.add('show'); S.ovlKey='notice';
  ovl.querySelector('#ntOk').onclick=function(){ hideOvl(); render() };
}
function roomClosed(){
  leaveRoom(true);
  showNotice('방이 닫혔습니다','방장이 나가서 방이 닫혔습니다. 새 방을 만들거나 다른 방 코드로 들어가 주세요.','홈으로');
}
function paintOvl(){
  /* 사용자가 직접 연 시트(버전 정보·안내)는 상태 갱신이 덮어쓰지 않는다 */
  if(S.ovlKey==='ver'||S.ovlKey==='notice')return;
  if(!V){ hideOvl(); return }
  var key='';
  if(V.ph==='pick')key='pick|'+V.tk+'|'+(amDrawer()&&S.myCands&&!S.myWord?'me':'wait');
  else if(V.ph==='reveal')key='rev|'+V.tk;
  else if(V.ph==='final')key='fin|'+V.gno;
  if(key===S.ovlKey)return;
  S.ovlKey=key;
  if(!key){ ovl.classList.remove('show'); ovl.innerHTML=''; return }

  if(V.ph==='pick')buildPickOvl();
  else if(V.ph==='reveal')buildRevealOvl();
  else if(V.ph==='final')buildFinalOvl();
  ovl.classList.add('show');
}
function buildPickOvl(){
  var dr=drawerRow();
  if(amDrawer()&&S.myCands&&!S.myWord){
    ovl.innerHTML='<div class="obox"><h2>제시어를 고르세요</h2>'+
      '<p class="osub"><span id="pickCd">10초</span> 안에 고르지 않으면 첫 번째가 자동으로 선택됩니다.</p>'+
      '<div class="wordbtns" id="wb">'+
      S.myCands.map(function(w,i){
        return '<button type="button" data-i="'+i+'">'+esc(w.w)+
               '<span class="wc">'+esc(w.c)+' · 난이도 '+(w.d||1)+'</span></button>';
      }).join('')+'</div></div>';
    ovl.querySelector('#wb').onclick=function(e){
      var b=e.target.closest('button'); if(!b)return;
      var i=+b.dataset.i;
      S.myWord=S.myCands[i];
      if(S.isHost)confirmWord(i);
      else NET.pub(tC(),{t:'pick',pid:S.pid,i:i,tk:V.tk});
      hideOvl();
    };
  }else{
    ovl.innerHTML='<div class="obox"><h2><span class="spin"></span>제시어 선택 중</h2>'+
      '<p class="osub">'+esc(dr?dr.n:'출제자')+'님이 제시어를 고르는 중입니다.<br>'+
      '<span id="pickCd">10초</span> 남았습니다.</p></div>';
  }
}
function buildRevealOvl(){
  var r=V.rev||{};
  var rows=(r.rows||[]).map(function(x,i){
    return '<div class="rrow'+(i===0?' gold':'')+'"><span class="rk">'+(i+1)+'</span>'+
      '<span>'+esc(x.e)+'</span><span class="rn">'+esc(x.n)+'</span><span class="rp">+'+x.p+'</span></div>';
  }).join('');
  ovl.innerHTML='<div class="obox"><h2>정답 공개</h2>'+
    '<div class="bigword">'+esc(r.w||'')+'</div>'+
    (r.none?'<p class="osub">아무도 못 맞혔습니다 😶</p>':'<div class="rtable">'+rows+'</div>')+
    (r.dr?'<div class="rtable" style="margin-top:12px"><div class="rrow drawer"><span class="rk">✏️</span>'+
      '<span>'+esc(r.dr.e)+'</span><span class="rn">'+esc(r.dr.n)+' (출제자)</span>'+
      '<span class="rp">+'+r.dr.p+'</span></div></div>':'')+
    '</div>';
}
function buildFinalOvl(){
  var f=V.fin||{rows:[],teams:{}};
  var html='<div class="obox"><h2>게임 결과</h2>';
  if(f.mode==='team'){
    var red=f.teams.red||0, blue=f.teams.blue||0;
    html+='<p class="wintxt">'+(red===blue?'무승부!':(red>blue?'🔴 레드팀 승리!':'🔵 블루팀 승리!'))+'</p>'+
      '<div class="teamscore">'+
      '<div class="ts red'+(red>blue?' win':'')+'"><div class="tn">🔴 레드</div><div class="tv">'+red+'</div></div>'+
      '<div class="ts blue'+(blue>red?' win':'')+'"><div class="tn">🔵 블루</div><div class="tv">'+blue+'</div></div>'+
      '</div>';
  }else{
    var top=f.rows.slice(0,3), ord=[1,0,2];
    html+='<div class="podium">'+ord.map(function(i,k){
      var p=top[i]; if(!p)return '';
      return '<div class="pod p'+(i+1)+'"><div class="av">'+esc(p.e)+'</div>'+
        '<div class="nm">'+esc(p.n)+'</div><div class="bar">'+p.sc+'</div></div>';
    }).join('')+'</div>';
  }
  html+='<div class="rtable">'+f.rows.map(function(p,i){
    return '<div class="rrow'+(i===0?' gold':'')+'"><span class="rk">'+(i+1)+'</span>'+
      '<span>'+esc(p.e)+'</span><span class="rn">'+esc(p.n)+
      (f.mode==='team'?' <span style="color:var(--'+p.team+')">'+(p.team==='red'?'🔴':'🔵')+'</span>':'')+
      '</span><span class="rp">'+p.sc+'</span></div>';
  }).join('')+'</div>';
  html+=(S.isHost
    ? '<button class="btn btn-main" id="toLobby" style="width:100%;margin-top:20px">대기실로</button>'
    : '<p class="osub" style="margin:20px 0 0">방장이 대기실로 돌아가기를 기다리는 중…</p>')+
    '<button class="btn btn-ghost" id="ovLeave" style="width:100%;margin-top:8px;font-size:13px">방 나가기</button></div>';
  ovl.innerHTML=html;
  var tl=ovl.querySelector('#toLobby');
  if(tl)tl.onclick=function(){ hideOvl(); backToLobby() };
  ovl.querySelector('#ovLeave').onclick=function(){ askLeave() };
}

/* ===================== 채팅 ===================== */
/* 대기실과 게임 화면이 같은 채팅 UI를 쓴다. 안내 문구만 다르므로 마크업은 한 곳에서 만든다. */
function chatHTML(ph){
  return '<div class="chatlog" id="clog"></div>'+
    '<div class="chatin"><input type="text" id="cmsg" maxlength="'+CHAT_MAX+'" placeholder="'+ph+'" autocomplete="off">'+
    '<button class="btn btn-main" id="csend">전송</button></div>';
}
function bindChat(){
  var inp=document.getElementById('cmsg'), btn=document.getElementById('csend');
  if(!inp||!btn)return;
  btn.onclick=function(){ sendChat(inp) };
  inp.onkeydown=function(e){ if(e.key==='Enter')sendChat(inp) };
}
function sendChat(inp){
  if(!inp||!S.code||inp.disabled)return;
  var t=inp.value.replace(/\s+/g,' ').trim().slice(0,CHAT_MAX);
  if(!t)return;
  var now=Date.now();
  if(now-S.lastSent<450)return;               // 도배 방지
  S.lastSent=now; inp.value='';
  if(S.isHost)hostChat(S.pid,rid(6),t);       // 방장은 자기 자신을 바로 판정한다
  else NET.pub(tC(),{t:'chat',pid:S.pid,id:rid(6),x:t});
}
function paintChat(){
  var box=document.getElementById('clog'); if(!box)return;
  var key=S.chat.length+'|'+(S.chat.length?S.chat[S.chat.length-1].id:'');
  if(box.getAttribute('data-k')===key)return;
  box.setAttribute('data-k',key);
  box.innerHTML=S.chat.length?S.chat.map(function(c){
    if(c.ty==='sys')
      return '<div class="cmsg sys '+esc(c.tone||'')+'">'+esc(c.x)+'</div>';
    var cls='cmsg'+(c.pid===S.pid?' mine':'')+(V&&V.mode==='team'?(c.team==='red'?' tred':' tblue'):'');
    return '<div class="'+cls+'"><span class="cav">'+esc(c.e)+'</span>'+
           '<span class="cnm">'+esc(c.n)+'</span><span>'+esc(c.x)+'</span></div>';
  }).join('')
   :'<div class="cempty">아직 메시지가 없습니다.<br>그림을 보고 떠오르는 단어를 입력하세요 👋</div>';
  box.scrollTop=box.scrollHeight;
}

/* ===================== 캔버스 ===================== */
function initCanvas(){
  var cv=document.getElementById('cv'); if(!cv)return;
  DRAW.cv=cv;
  DRAW.dpr=Math.min(2,window.devicePixelRatio||1);
  cv.width=CW*DRAW.dpr; cv.height=CH*DRAW.dpr;
  DRAW.ctx=cv.getContext('2d');
  DRAW.ctx.setTransform(DRAW.dpr,0,0,DRAW.dpr,0,0);
  DRAW.ctx.lineCap='round'; DRAW.ctx.lineJoin='round';
  clearSurface();
  redrawAll();

  cv.addEventListener('pointerdown',onDown);
  cv.addEventListener('pointermove',onMove);
  cv.addEventListener('pointerup',onUp);
  cv.addEventListener('pointercancel',onUp);
  cv.addEventListener('pointerleave',onUp);
  cv.addEventListener('contextmenu',function(e){e.preventDefault()});
}
function clearSurface(){
  if(!DRAW.ctx)return;
  DRAW.ctx.save();
  DRAW.ctx.setTransform(1,0,0,1,0,0);
  DRAW.ctx.fillStyle='#ffffff';
  DRAW.ctx.fillRect(0,0,DRAW.cv.width,DRAW.cv.height);
  DRAW.ctx.restore();
}
function resetCanvas(){
  DRAW.strokes=[]; DRAW.cur=null; DRAW.out=[]; DRAW.hasLast=false;
  unlockScroll();
  clearSurface();
}
function redrawAll(){
  clearSurface();
  DRAW.strokes.forEach(function(st){ st.dn=0; paintStroke(st) });
}
function paintStroke(st){
  var ctx=DRAW.ctx; if(!ctx)return;
  var p=st.p, dn=st.dn||0;
  if(p.length<2)return;
  ctx.strokeStyle=st.e?'#ffffff':st.c;
  ctx.fillStyle=st.e?'#ffffff':st.c;
  ctx.lineWidth=st.w*(st.e?2.4:1);
  if(p.length===2){                                    // 점 찍기
    ctx.beginPath();
    ctx.arc(p[0]*CW,p[1]*CH,Math.max(1,ctx.lineWidth/2),0,Math.PI*2);
    ctx.fill(); st.dn=2; return;
  }
  var s=dn>=2?dn-2:0;
  if(p.length<=s+2){ st.dn=p.length; return }
  ctx.beginPath();
  ctx.moveTo(p[s]*CW,p[s+1]*CH);
  for(var i=s+2;i<p.length;i+=2)ctx.lineTo(p[i]*CW,p[i+1]*CH);
  ctx.stroke();
  st.dn=p.length;
}
function canDraw(){ return amDrawer()&&V&&V.ph==='draw' }
/* 손가락 입력 환경인가. PC에서는 아래 잠금·그립 코드가 아예 돌지 않아야 한다. */
function isCoarse(){
  try{ if(window.matchMedia&&window.matchMedia('(pointer:coarse)').matches)return true }catch(e){}
  return window.innerWidth<=COARSE_MAX;
}
/* touch-action을 무시하는 브라우저(카톡 인앱 WebView 등)가 있어서, 그리는 동안에는
   페이지를 position:fixed로 물리적으로 붙잡아 둔다. 모바일에서만 건다. */
function lockScroll(){
  if(DRAW.locked||!isCoarse())return;
  DRAW.locked=true;
  DRAW.scrollY=window.scrollY||window.pageYOffset||0;
  document.body.style.top=(-DRAW.scrollY)+'px';
  document.body.classList.add('drawlock');
}
/* 반드시 원래 스크롤 위치로 되돌린다. 안 그러면 그릴 때마다 화면이 맨 위로 튄다. */
function unlockScroll(){
  if(!DRAW.locked)return;
  DRAW.locked=false;
  document.body.classList.remove('drawlock');
  document.body.style.top='';
  window.scrollTo(0,DRAW.scrollY);
}
function onDown(e){
  if(!canDraw())return;
  e.preventDefault();
  lockScroll();                                  // 레이아웃이 흔들리지 않는 방식이라 좌표는 그대로다
  try{ DRAW.cv.setPointerCapture(e.pointerId) }catch(err){}
  DRAW.cur={c:DRAW.color,w:DRAW.width,e:DRAW.eraser,p:[],dn:0};
  DRAW.strokes.push(DRAW.cur); trimStrokes();
  queue({t:'s',c:DRAW.cur.c,w:DRAW.cur.w,e:DRAW.cur.e});
  DRAW.hasLast=false;
  addPointFrom(e,DRAW.cv.getBoundingClientRect());
}
function onMove(e){
  if(!canDraw()||!DRAW.cur)return;
  e.preventDefault();
  /* 합쳐진 이벤트가 있으면 전부 반영해 선이 각지지 않게 한다.
     빈 배열을 돌려주는 브라우저가 있으므로 길이를 반드시 확인한다. */
  var evs=null;
  try{ if(e.getCoalescedEvents)evs=e.getCoalescedEvents() }catch(err){}
  if(!evs||!evs.length)evs=[e];
  /* getBoundingClientRect는 레이아웃을 강제로 계산시킨다. 합쳐진 이벤트가 수십 개씩
     들어오므로 점마다 부르면 안 된다 — 이벤트 한 번에 한 번만 읽어 돌려쓴다. */
  var r=DRAW.cv.getBoundingClientRect();
  for(var i=0;i<evs.length;i++)addPointFrom(evs[i],r);
}
function onUp(e){
  unlockScroll();                                // cur가 없어도(취소 등) 잠금은 반드시 푼다
  if(!DRAW.cur)return;
  DRAW.cur=null; DRAW.hasLast=false;
  queue({t:'e'});
  flush();
}
/* 화면 좌표 → 0~1 정규화(소수 3자리). 점마다 {x,y} 객체를 만들지 않는다. */
function addPointFrom(e,r){
  var st=DRAW.cur; if(!st)return;
  var x=r3(clamp((e.clientX-r.left)/r.width,0,1));
  var y=r3(clamp((e.clientY-r.top)/r.height,0,1));
  if(DRAW.hasLast){
    var dx=(x-DRAW.lastX)*CW, dy=(y-DRAW.lastY)*CH;
    if(dx*dx+dy*dy<D_MIN_DIST*D_MIN_DIST)return;      // 2px 미만은 버린다
  }
  DRAW.hasLast=true; DRAW.lastX=x; DRAW.lastY=y;
  st.p.push(x,y);
  paintStroke(st);
  queuePoint(x,y);
}
/* 전송 큐: 마지막 항목이 좌표 배치면 이어 붙이고, 40쌍을 넘으면 새 배치를 연다 */
function queuePoint(x,y){
  var last=DRAW.out[DRAW.out.length-1];
  if(last&&last.t==='p'&&last.p.length<D_MAX_PAIRS*2)last.p.push(x,y);
  else DRAW.out.push({t:'p',p:[x,y]});
  ensureFlush();
}
function queue(item){ DRAW.out.push(item); ensureFlush() }
function ensureFlush(){
  if(DRAW.timer)return;
  DRAW.timer=setInterval(flush,D_BATCH_MS);
}
function flush(){
  if(!DRAW.out.length){
    if(DRAW.timer&&!DRAW.cur){ clearInterval(DRAW.timer); DRAW.timer=null }
    return;
  }
  var ms=DRAW.out; DRAW.out=[];
  if(S.code)NET.pub(tD(),{u:S.pid,ms:ms});
}
function trimStrokes(){
  while(DRAW.strokes.length>D_MAX_STROKES)DRAW.strokes.shift();
}
/* 드로잉 수신 */
function onDraw(m){
  if(!m||!m.ms||m.u===S.pid)return;
  if(!V||!V.drawer||m.u!==V.drawer)return;      // 출제자 아닌 사람의 드로잉은 무시
  for(var i=0;i<m.ms.length;i++)applyDraw(m.ms[i]);
}
function applyDraw(d){
  if(!d)return;
  if(d.t==='s'){
    DRAW.strokes.push({c:d.c,w:d.w,e:d.e,p:[],dn:0}); trimStrokes();
  }else if(d.t==='p'){
    var st=DRAW.strokes[DRAW.strokes.length-1];
    if(!st)return;
    /* concat은 배치마다 스트로크 전체를 새 배열로 복사한다 — 선이 길수록 비싸진다.
       뒤에 덧붙이기만 하면 되므로 push로 바꾼다. */
    var dp=d.p||[];
    for(var i=0;i<dp.length;i++)st.p.push(dp[i]);
    paintStroke(st);
  }else if(d.t==='clr'){
    DRAW.strokes=[]; clearSurface();
  }else if(d.t==='undo'){
    DRAW.strokes.pop(); redrawAll();
  }else if(d.t==='snap'){
    DRAW.strokes=(d.ss||[]).map(function(x){return {c:x.c,w:x.w,e:x.e,p:x.p||[],dn:0}});
    redrawAll();
  }
}
/* 늦게 들어온 사람: 출제자에게 스냅샷을 요청한다 */
function requestSyncIfLate(){
  if(!V||V.ph!=='draw'||amDrawer())return;
  if(S.syncedTurn===V.tk)return;
  var elapsed=(V.dur||0)-remainMs();
  if(elapsed<2500)return;                     // 처음부터 본 사람은 요청할 필요 없다
  if(DRAW.strokes.length)return;
  S.syncedTurn=V.tk;
  if(S.isHost){ if(G&&G.drawer)sendPriv(G.drawer,{t:'syncreq'}) }
  else NET.pub(tC(),{t:'sync',pid:S.pid});
}
function sendSnapshot(){
  if(!amDrawer())return;
  var t=Date.now();
  if(t-DRAW.lastSnap<D_SNAP_GAP)return;
  DRAW.lastSnap=t;
  var ss=DRAW.strokes.slice(-D_MAX_STROKES).map(function(x){return {c:x.c,w:x.w,e:x.e,p:x.p}});
  var total=0,i;
  for(i=ss.length-1;i>=0;i--){                 // 좌표 총량 초과분은 오래된 것부터 자른다
    total+=ss[i].p.length;
    if(total>D_MAX_SNAP_PTS){ ss=ss.slice(i+1); break }
  }
  NET.pub(tD(),{u:S.pid,ms:[{t:'snap',ss:ss}]});
}
/* 출제자는 캔버스가 터치를 삼키므로 캔버스 옆 그립으로 페이지를 스크롤한다.
   그립은 캔버스 바깥이라 그리기 영역을 잡아먹지 않고, 여기서의 드래그는 그림이 되지 않는다. */
function bindGrip(){
  var g=document.getElementById('sgrip'); if(!g)return;
  var dragging=false, pid=null, startY=0, startScroll=0, gain=1;
  g.addEventListener('pointerdown',function(e){
    e.preventDefault(); e.stopPropagation();
    dragging=true; pid=e.pointerId;
    startY=e.clientY;
    startScroll=window.scrollY||window.pageYOffset||0;
    /* 그립을 끝까지 훑으면 페이지도 끝까지 가도록 이동량을 환산한다(스크롤바 손잡이와 같은 감각) */
    var max=Math.max(1,(document.documentElement.scrollHeight||0)-window.innerHeight);
    gain=Math.max(1,Math.min(GRIP_GAIN_MAX,max/Math.max(1,g.offsetHeight)));
    try{ g.setPointerCapture(pid) }catch(err){}
    g.classList.add('act');
  });
  g.addEventListener('pointermove',function(e){
    if(!dragging||e.pointerId!==pid)return;
    e.preventDefault(); e.stopPropagation();
    window.scrollTo(0,startScroll+(e.clientY-startY)*gain);
  });
  function end(e){
    if(!dragging)return;
    dragging=false; g.classList.remove('act');
    try{ g.releasePointerCapture(pid) }catch(err){}
  }
  g.addEventListener('pointerup',end);
  g.addEventListener('pointercancel',end);
  g.addEventListener('pointerleave',end);
}
/* 도구바 */
function bindTools(){
  var sw=document.getElementById('sw'); if(!sw)return;
  sw.onclick=function(e){
    var b=e.target.closest('button'); if(!b)return;
    DRAW.color=b.dataset.c; DRAW.eraser=false;
    Array.prototype.forEach.call(sw.children,function(c){c.setAttribute('aria-pressed',c===b)});
    document.getElementById('tEr').setAttribute('aria-pressed','false');
  };
  var tr=document.getElementById('tr');
  tr.onclick=function(e){
    var b=e.target.closest('button'); if(!b)return;
    if(b.dataset.w){
      DRAW.width=+b.dataset.w;
      Array.prototype.forEach.call(tr.querySelectorAll('.wbtn'),function(c){c.setAttribute('aria-pressed',c===b)});
    }
  };
  document.getElementById('tEr').onclick=function(e){
    DRAW.eraser=!DRAW.eraser;
    e.currentTarget.setAttribute('aria-pressed',String(DRAW.eraser));
  };
  document.getElementById('tUn').onclick=function(){
    if(!canDraw()||!DRAW.strokes.length)return;
    DRAW.strokes.pop(); redrawAll(); queue({t:'undo'}); flush();
  };
  document.getElementById('tCl').onclick=function(){
    if(!canDraw())return;
    DRAW.strokes=[]; clearSurface(); queue({t:'clr'}); flush();
  };
}

/* ===================== 버전 시트 ===================== */
function openVer(){
  ovl.innerHTML='<div class="obox"><h2>버전 정보</h2>'+
    '<p class="osub">현재 버전 <b style="color:var(--accent)">v'+VERSION+'</b></p>'+
    '<ol class="verlist">'+CHANGELOG.map(function(c,i){
      return '<li'+(i===0?' class="cur"':'')+'><b>v'+c.v+'</b>'+
        c.t.map(function(x){return '<p>· '+esc(x)+'</p>'}).join('')+'</li>';
    }).join('')+'</ol>'+
    '<button class="btn btn-ghost" id="verX" style="width:100%;margin-top:16px">닫기</button></div>';
  ovl.classList.add('show'); S.ovlKey='ver';
  ovl.querySelector('#verX').onclick=function(){ hideOvl(); paintOvl() };
}

/* ===================== 부팅 ===================== */
loadMe();
document.getElementById('verBtn').onclick=openVer;
document.getElementById('hubLink').onclick=function(e){
  if(S.code&&S.screen!=='home'){
    var msg=S.isHost
      ? '허브로 나가면 방이 닫히고 참가자 전원이 게임에서 나가게 됩니다. 정말 나가겠습니까?'
      : '정말 나가겠습니까?';
    if(!confirm(msg)){ e.preventDefault(); return }
    try{ leaveRoom(true) }catch(err){}
  }
};
window.addEventListener('pagehide',function(){
  try{
    if(S.code){
      if(S.isHost)NET.pub(tS(),null,true);       // 방 닫힘 (암호화 없이 즉시 나간다)
      else NET.pub(tC(),{t:'leave',pid:S.pid});
    }
    /* 소켓을 정리하고 나간다. 좀비 커넥션이 쌓이면 공용 브로커의 IP 제한을 빨리 맞는다. */
    NET.end();
  }catch(e){}
});
/* 백그라운드 탭은 타이머가 스로틀링되어 ping 간격이 크게 밀린다.
   돌아오면 인터벌을 기다리지 말고 그 자리에서 한 번 쏜다. 복귀가 가장 빨라진다. */
document.addEventListener('visibilitychange',function(){
  if(document.visibilityState!=='visible'||!S.code)return;
  /* 숨어 있는 동안 흐른 시간은 판정 근거가 못 된다. 기준을 다시 잡되,
     방장이 그새 다른 브로커로 옮겨갔을 수도 있으니 HOST_GONE_MS를 통째로 다시
     기다리게 하지는 않는다. RETURN_GRACE_MS만 주고, 그 안에 상태가 안 오면 탐색한다. */
  S.lastState=Date.now()-Math.max(0,HOST_GONE_MS-RETURN_GRACE_MS); S.hop=0;
  if(!S.isHost)NET.pub(tC(),{t:'ping',pid:S.pid,name:S.name,em:S.emIdx});
});
window.addEventListener('hashchange',function(){ if(S.screen==='home')renderHome() });
render();

})();
