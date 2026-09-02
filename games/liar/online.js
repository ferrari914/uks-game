/* =========================================================================
   라이어 게임 — 온라인 멀티 모드 (online.js)  v1.1.0

   패스 앤 플레이(index.html 인라인 스크립트)는 손대지 않는다. 이 파일은
   "온라인으로" 버튼을 누른 뒤의 화면·로직만 담당하며, 같은 #main 안에
   자기 섹션(#scOnHome / #scOnLobby / #scOnGame)을 열고 닫는다.

   ── 왜 방장이 심판인가
   서버가 없다(GitHub Pages 정적 배포). 그래서 역할 배정·개표·판정은 방장 브라우저가
   한다. 방장은 정답을 알 수밖에 없다 → 규칙 시트에 그대로 적고, "방장은 진행만 하기"
   옵션으로 우회한다.

   ── 무엇이 어떻게 가려지는가 (net.js와 짝)
   · 전송 계층: 방 코드에서 유도한 AES-GCM 키. 방 밖 제3자를 막는다.
   · E2E 계층: 참가자별 ECDH 공개키로 한 번 더 싼다. **같은 방 사람도 못 연다.**
       - 역할 카드(제시어/라이어 여부/스파이 정보) → 방장 → 각자
       - 투표 → 각자 → 방장
       - 추리 보기·선택 → 방장 ↔ 지목된 라이어
   · 공개 상태(state)에는 제시어·역할이 절대 들어가지 않는다. 결과 페이즈의 fin에만 들어간다.

   ── 토픽
     eklr/<tid>/s        방장 → 전원 (state는 retain, 채팅/시스템은 non-retain)
     eklr/<tid>/c        참가자 → 방장
     eklr/<tid>/p/<pid>  방장 → 개인 (E2E 봉투)
   ========================================================================= */
(function(){
'use strict';
if(!window.LIAR_NET)return;

/* ===================== 상수 ===================== */
var W=window.LIAR_WORDS||{};
var CATS=Object.keys(W);
var NET=window.LIAR_NET.make();
var E2E=window.LIAR_NET.e2e;

var MAXP=10, MINP=3, NAME_MAX=6, SAY_MAX=60, CHAT_MAX=200;
var TICK_MS=400;          // 방장 판정 주기
var STATE_MS=2500;        // 방장 상태 재발행 주기 (변화 없어도 "살아있다" 신호)
var PING_MS=3000;         // 참가자 생존 신고 주기
/* 자리 비움·퇴장 판정은 넉넉하게 잡는다. 브라우저는 화면이 꺼지거나 탭이 뒤로 가면
   타이머를 초 단위·분 단위로 늦추기 때문에, 빡빡하게 잡으면 멀쩡히 있는 사람이
   튕겨 나간다. 캐치마인드에서 검증된 값(12초/50초)을 그대로 쓴다. */
var AWAY_MS=12000;        // 이만큼 조용하면 자리 비움 (목록에서 빼지는 않는다)
var DROP_MS=50000;        // 이만큼 조용해야 비로소 나간 것으로 본다
var HOST_GONE_MS=14000;   // 방장 소식이 이만큼 없으면 브로커 승격 → 그래도 없으면 퇴장
var HOP_MS=5000, HOPS=6, NET_GRACE_MS=12000;
var LS_CFG='liar_ocfg', LS_ME='liar_ome';

/* 「방장은 진행만 하기」의 기본값. 스펙 M2 기준 기본은 "방장도 참가"(=true).
   방침이 바뀌면 이 한 줄만 false로 바꾸면 된다 (저장된 설정이 없을 때의 초기값). */
var HOST_PLAYS_DEFAULT=true;

var PH={lobby:'대기실',reveal:'역할 배정',describe:'설명 라운드',debate:'토론',
        vote:'비밀 투표',tally:'개표',guess:'라이어 추리',result:'결과'};

/* ===================== 유틸 ===================== */
var $=function(s){return document.querySelector(s)};
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function rnd(n){return Math.floor(Math.random()*n)}
function rid(n,al){al=al||'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';var s='',i;
  for(i=0;i<n;i++)s+=al.charAt(rnd(al.length));return s}
function shuffle(a){a=a.slice();for(var i=a.length-1;i>0;i--){var j=rnd(i+1);var t=a[i];a[i]=a[j];a[j]=t}return a}
function mmss(s){s=Math.max(0,s|0);return Math.floor(s/60)+':'+('0'+(s%60)).slice(-2)}
function josa(w,withF,noF){var t=String(w),c=t.charCodeAt(t.length-1);
  return ((c>=0xAC00&&c<=0xD7A3)&&((c-0xAC00)%28!==0))?withF:noF}
function clean(s){return String(s||'').replace(/\s+/g,' ').trim().slice(0,NAME_MAX)}
function keys(o){return Object.keys(o||{})}
function noop(){}

/* ===================== 상태 ===================== */
var S={
  screen:'',                       // '' | onHome | onLobby | onGame
  name:'', pid:rid(12,'abcdefghijklmnopqrstuvwxyz0123456789'),
  code:'', tid:'', isHost:false,
  kp:null, kpReady:false,
  net:'idle', err:'', busy:false,
  offset:0, lastState:0, lastPub:0, hop:0, hopAt:0,
  chat:[], seenGno:-1,
  card:null, cardOpen:false,
  gopts:null, myVote:null, myGuess:null, voteSent:false, guessSent:false, okSent:false,
  lastSay:0
};
var V=null;                        // 방장이 뿌린 최신 상태 (참가자·방장 공통 뷰)
var G=null;                        // 방장 전용 권위 상태
var hostTimer=null, uiTimer=null, pingTimer=null;
var guardOn=false;

/* ===================== 토픽 ===================== */
function tS(){return 'eklr/'+S.tid+'/s'}
function tC(){return 'eklr/'+S.tid+'/c'}
function tP(p){return 'eklr/'+S.tid+'/p/'+p}
function prepareRoom(code){
  S.code=code;
  NET.setKey(code);
  return window.LIAR_NET.topicId(code).then(function(t){S.tid=t;return t});
}

/* ===================== 설정 저장 ===================== */
function defCfg(){
  return {cats:CATS.slice(),mode:'basic',liarCount:1,laps:1,
          turnLimit:30,debate:120,guessOpts:6,guessTimer:30,hostPlays:HOST_PLAYS_DEFAULT};
}
function loadCfg(){
  var d=defCfg();
  try{
    var r=JSON.parse(localStorage.getItem(LS_CFG)||'null');
    if(r&&typeof r==='object'){
      if(['basic','fool','spy'].indexOf(r.mode)>=0)d.mode=r.mode;
      if([1,2].indexOf(+r.liarCount)>=0)d.liarCount=+r.liarCount;
      if([1,2].indexOf(+r.laps)>=0)d.laps=+r.laps;
      if([0,15,30].indexOf(+r.turnLimit)>=0)d.turnLimit=+r.turnLimit;
      if([0,60,120,180].indexOf(+r.debate)>=0)d.debate=+r.debate;
      if([4,6,8].indexOf(+r.guessOpts)>=0)d.guessOpts=+r.guessOpts;
      if([0,30].indexOf(+r.guessTimer)>=0)d.guessTimer=+r.guessTimer;
      if(typeof r.hostPlays==='boolean')d.hostPlays=r.hostPlays;
      if(Object.prototype.toString.call(r.cats)==='[object Array]'){
        var c=r.cats.filter(function(x){return CATS.indexOf(x)>=0});
        if(c.length)d.cats=c;
      }
    }
  }catch(e){}
  return d;
}
function saveCfg(){ if(!G)return; try{localStorage.setItem(LS_CFG,JSON.stringify(G.cfg))}catch(e){} }
function loadMe(){ try{var m=JSON.parse(localStorage.getItem(LS_ME)||'null');if(m&&m.n)S.name=clean(m.n)}catch(e){} }
function saveMe(){ try{localStorage.setItem(LS_ME,JSON.stringify({n:S.name}))}catch(e){} }

/* ===================== 화면 ===================== */
function oshow(id){
  S.screen=id;
  var all=document.querySelectorAll('.sc'),i;
  for(i=0;i<all.length;i++)all[i].classList.remove('show');
  var el=$('#sc'+id.charAt(0).toUpperCase()+id.slice(1));
  if(el)el.classList.add('show');
  $('#main').scrollTop=0;
}
function setNav(){
  var ph=V?V.ph:'lobby';
  $('#phaseName').textContent=(S.screen==='onHome')?'온라인':(PH[ph]||'온라인');
  $('#roundNum').textContent=(S.screen==='onHome')?''
    :('방 '+S.code+(S.isHost?' · 방장':'')+(V&&V.rd?(' · '+V.rd+'라운드'):''));
}
function setTimerBox(sec){
  var t=$('#timer');
  if(sec==null){t.textContent='--';t.classList.remove('low');return}
  t.textContent=mmss(sec);
  t.classList.toggle('low',sec<=10);
}
function setNet(s){
  S.net=s;
  var b=$('#netBar');
  if(!b)return;
  if(s==='on'){b.classList.remove('show');return}
  b.textContent = s==='dead' ? '브로커에 연결할 수 없습니다. 잠시 후 새로고침해 주세요.'
    : s==='re' ? '연결이 끊겨 재접속 중… (다른 서버로 옮겨 봅니다)'
    : '네트워크 연결 대기 중…';
  b.classList.add('show');
}
function guard(on){
  if(on===guardOn)return;guardOn=on;
  if(on)window.addEventListener('beforeunload',onBeforeUnload);
  else window.removeEventListener('beforeunload',onBeforeUnload);
}
function onBeforeUnload(e){e.preventDefault();e.returnValue='';return ''}

/* ===================== 입장 화면 ===================== */
function canMulti(){return !!(window.LIAR_NET&&window.LIAR_NET.cryptoOk())}
var HTTPS_MSG='온라인 모드는 https 주소로 접속해야 합니다. 파일을 직접 열면(file://) 암호화가 막혀 제시어를 안전하게 나눠 줄 수 없습니다.';

function parseCode(str){
  var t=String(str||'').trim();
  var h=t.indexOf('#'); if(h>=0)t=t.slice(h+1);
  t=t.replace(/\s+/g,'');
  var m=/^([A-Za-z0-9]{6})$/.exec(t);
  return m?m[1].toUpperCase():null;
}
function renderOnHome(){
  oshow('onHome');
  V=null;setNav();setTimerBox(null);
  var bad=!canMulti();
  var inv=parseCode(location.hash);
  $('#ohBody').innerHTML=
   '<div class="pan"><div class="ptRow"><div class="pt">🌐 온라인 모드</div></div>'+
   '<p class="lead">각자 자기 폰으로 들어와 <b>채팅으로</b> 한 판. 제시어는 <b>암호화</b>돼 각자에게만 갑니다.</p></div>'+
   (bad?'<div class="pan"><p class="lead" style="color:var(--gold)">'+esc(HTTPS_MSG)+'</p></div>':'')+
   '<div class="pan"><div class="lbl">닉네임</div>'+
   '<input class="tin" type="text" id="onNick" maxlength="'+NAME_MAX+'" placeholder="'+NAME_MAX+'자까지" '+
     'value="'+esc(S.name)+'" autocomplete="off"></div>'+
   '<div class="pan"><div class="lbl">방 만들기</div>'+
   '<button class="btn" id="onMake"'+(bad?' disabled':'')+'>새 방 열고 코드 받기</button>'+
   '<div class="lbl" style="margin-top:6px">친구 방에 들어가기</div>'+
   '<div class="inrow"><input class="tin" type="text" id="onCode" maxlength="24" placeholder="방 코드 6자" '+
     'style="text-transform:uppercase" value="'+esc(inv||'')+'" autocomplete="off">'+
   '<button class="btn ghost" id="onJoin" style="width:74px;flex:none"'+(bad?' disabled':'')+'>입장</button></div>'+
   '<p class="lead" id="onErr" style="color:var(--gold);min-height:16px">'+esc(S.err)+'</p></div>'+
   '<div class="foot"><button class="btn ghost" id="onBack">모드 선택으로</button></div>';

  $('#onNick').oninput=function(e){S.name=e.target.value};
  $('#onMake').onclick=createRoom;
  $('#onJoin').onclick=function(){joinRoom($('#onCode').value)};
  $('#onCode').onkeydown=function(e){if(e.key==='Enter')joinRoom($('#onCode').value)};
  $('#onBack').onclick=function(){
    S.screen='';V=null;
    if(location.hash)history.replaceState(null,'',location.pathname);
    $('#phaseName').textContent='모드 선택';$('#roundNum').textContent='';setTimerBox(null);
    var all=document.querySelectorAll('.sc'),i;
    for(i=0;i<all.length;i++)all[i].classList.remove('show');
    $('#scHome').classList.add('show');
  };
}
function fail(m){S.err=m;var e=$('#onErr');if(e)e.textContent=m}

/* ===================== 키쌍 ===================== */
function ensureKeys(){
  if(S.kpReady)return Promise.resolve(S.kp);
  return E2E.gen().then(function(kp){S.kp=kp;S.kpReady=true;return kp});
}
function ensureNet(){
  if(S.net==='on')return Promise.resolve();
  return NET.connect(setNet).then(function(){setNet('on')});
}

/* ===================== 방 생성 / 입장 / 퇴장 ===================== */
function createRoom(){
  if(!canMulti()){fail(HTTPS_MSG);return}
  if(!CATS.length){fail('제시어 데이터를 불러오지 못했습니다.');return}
  if(S.busy)return;S.busy=true;
  S.name=clean($('#onNick').value)||'방장';saveMe();
  fail('연결 중…');
  ensureKeys().then(function(){
    return prepareRoom(rid(6));
  }).then(ensureNet).then(function(){
    S.busy=false;S.isHost=true;
    G={gno:0,ph:'lobby',players:{},cfg:loadCfg(),rd:0,
       cat:'',word:'',fool:null,mode:'basic',liars:[],spy:null,
       order:[],turn:0,totalTurns:0,endsAt:0,
       votes:{},cands:null,revoted:false,tally:null,accused:null,caught:false,
       guessQ:[],guessPtr:0,guessOpts:[],guessPicks:[],guessHit:false,fin:null,
       dirty:true,lastPub:0,netLost:false,grace:0};
    NET.sub(tC(),onClientEvent);
    NET.sub(tP(S.pid),onPrivRaw);
    addPlayer(S.pid,S.name,S.kp.pub);
    startHost();startUI();guard(true);
    fail('');publish(true);
  }).catch(function(){
    S.busy=false;
    fail(location.protocol!=='https:'&&location.hostname!=='localhost'
      ? '연결하지 못했습니다. ' + HTTPS_MSG
      : '서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  });
}
function joinRoom(raw){
  var code=parseCode(raw);
  if(!code){fail('방 코드 6자를 입력해 주세요.');return}
  if(!canMulti()){fail(HTTPS_MSG);return}
  if(S.busy)return;S.busy=true;
  S.name=clean($('#onNick').value)||'손님';saveMe();
  fail('연결 중…');
  ensureKeys().then(function(){
    return prepareRoom(code);
  }).then(ensureNet).then(function(){
    S.busy=false;S.isHost=false;S.lastState=0;S.lastPub=0;
    NET.sub(tS(),onHostMsg);
    NET.sub(tP(S.pid),onPrivRaw);
    NET.pub(tC(),{t:'join',pid:S.pid,name:S.name,pk:S.kp.pub});
    fail('방 찾는 중…');
    startPing();startUI();guard(true);
    var waited=0;
    var iv=setInterval(function(){
      waited+=250;
      if(S.lastState||!S.code){clearInterval(iv);return}
      if(waited>7000){
        clearInterval(iv);
        leaveRoom(true);
        fail('그 방을 찾지 못했어요. 코드가 맞는지, 방장이 창을 열어두었는지 확인해 주세요.');
      }
    },250);
  }).catch(function(){
    S.busy=false;
    fail(location.protocol!=='https:'&&location.hostname!=='localhost'
      ? '연결하지 못했습니다. ' + HTTPS_MSG
      : '서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  });
}
function leaveRoom(silent){
  if(S.code){
    if(S.isHost)NET.pub(tS(),null,true);
    else NET.pub(tC(),{t:'leave',pid:S.pid});
    NET.unsub(tS());NET.unsub(tC());NET.unsub(tP(S.pid));
  }
  clearInterval(hostTimer);clearInterval(uiTimer);clearInterval(pingTimer);
  hostTimer=uiTimer=pingTimer=null;
  G=null;V=null;guard(false);
  S.code='';S.tid='';S.isHost=false;S.chat=[];S.card=null;S.cardOpen=false;
  S.gopts=null;S.myVote=null;S.myGuess=null;S.voteSent=false;S.guessSent=false;S.okSent=false;
  S.seenGno=-1;S.lastState=0;S.lastPub=0;S.hop=0;S.hopAt=0;
  if(location.hash)history.replaceState(null,'',location.pathname);
  if(!silent)S.err='';
  renderOnHome();
}
function askLeave(){
  var m=S.isHost?'나가면 방이 닫히고 참가자 전원이 게임에서 나갑니다. 나가시겠습니까?':'정말 나가겠습니까?';
  if(confirm(m))leaveRoom();
}

/* ===================== 생존 신고 ===================== */
function startPing(){
  clearInterval(pingTimer);
  pingTimer=setInterval(function(){
    if(!S.code||S.isHost)return;
    NET.pub(tC(),{t:'ping',pid:S.pid,name:S.name,pk:S.kp.pub});
    if(document.visibilityState!=='visible')return;   // 숨은 탭은 판단 보류
    var now=Date.now();
    if(!S.lastState||now-S.lastState<=HOST_GONE_MS)return;
    if(S.hop>0&&now-S.hopAt<HOP_MS)return;
    if(S.hop<HOPS&&!NET.dead()){S.hop++;S.hopAt=now;NET.promote();return}
    leaveRoom(true);
    fail('방장 쪽에서 소식이 끊겨 방에서 나왔습니다.');
  },PING_MS);
}
function startUI(){
  clearInterval(uiTimer);
  uiTimer=setInterval(paint,250);
}

/* ===================== 방장: 참가자 관리 ===================== */
function addPlayer(pid,name,pk){
  if(G.players[pid]){G.players[pid].seen=Date.now();return}
  if(keys(G.players).length>=MAXP+1){ if(pid!==S.pid)privRaw(pid,{t:'full'}); return }
  G.players[pid]={pid:pid,name:clean(name)||'손님',pk:pk||'',sc:0,
    play:(G.ph==='lobby'),ok:false,away:false,joinAt:Date.now(),seen:Date.now()};
  G.dirty=true;
}
function playingPids(){
  var out=[],k;
  for(k in G.players){
    var p=G.players[k];
    if(!p.play)continue;
    if(k===S.pid&&!G.cfg.hostPlays)continue;
    out.push(k);
  }
  out.sort(function(a,b){return G.players[a].joinAt-G.players[b].joinAt});
  return out;
}
function nameOf(pid){return (G&&G.players[pid])?G.players[pid].name:'?'}
function vName(pid){
  if(!V)return '?';
  for(var i=0;i<V.players.length;i++)if(V.players[i].pid===pid)return V.players[i].n;
  return '?';
}

/* ===================== 방장: 수신 ===================== */
function onClientEvent(m){
  if(!S.isHost||!G||!m||!m.pid)return;
  var p=G.players[m.pid];
  if(m.t==='join'||m.t==='ping'){
    if(p){
      p.seen=Date.now();
      if(p.away){p.away=false;G.dirty=true}
      if(m.pk&&p.pk!==m.pk){p.pk=m.pk;G.dirty=true}
      if(m.name&&p.name!==clean(m.name)){p.name=clean(m.name);G.dirty=true}
    }else{
      addPlayer(m.pid,m.name,m.pk);
      if(G.players[m.pid])sys(clean(m.name)+'님이 들어왔습니다.','');
    }
    if(m.t==='join')G.dirty=true;
    return;
  }
  if(!p)return;
  p.seen=Date.now();
  if(m.t==='leave'){dropPlayer(m.pid,true);return}
  if(m.t==='ok'){ if(G.ph==='reveal'&&p.play&&!p.ok){p.ok=true;G.dirty=true} return }
  if(m.t==='say'){ hostSay(m.pid,m.id,m.x); return }
  if(m.t==='sec'){
    if(!m.b)return;
    E2E.open(S.kp.priv,m.b).then(function(o){hostSecret(m.pid,o)},noop);
    return;
  }
}
function onPrivRaw(m){
  if(!m)return;
  if(m.t==='full'){leaveRoom(true);fail('방이 꽉 찼습니다. (최대 '+MAXP+'명)');return}
  if(!m.b)return;
  E2E.open(S.kp.priv,m.b).then(handlePriv,noop);
}
function handlePriv(o){
  if(!o)return;
  if(o.t==='card'){S.card=o;S.cardOpen=false;return}
  if(o.t==='gopts'){S.gopts=o.opts;S.myGuess=null;S.guessSent=false;return}
}
function hostSecret(pid,o){
  if(!G||!o)return;
  var p=G.players[pid];if(!p)return;
  if(o.t==='vote'&&G.ph==='vote'){
    if(!p.play)return;
    if(!canVote(pid))return;
    if(G.votes[pid]!==undefined)return;
    if(!voteTargets(pid).length)return;
    if(voteTargets(pid).indexOf(o.tg)<0)return;
    G.votes[pid]=o.tg;G.dirty=true;
    if(allVoted())toTally();
    return;
  }
  if(o.t==='guess'&&G.ph==='guess'){
    if(G.guessQ[G.guessPtr]!==pid)return;
    submitGuess(o.pick);
    return;
  }
}

/* ===================== 방장: 발행 ===================== */
function sys(x,tone){pushMsg({id:rid(8),ty:'sys',x:x,tone:tone||''})}
function pushMsg(m){
  NET.pub(tS(),{k:'msg',m:m});
  handleMsg(m);
}
function privRaw(pid,obj){ if(pid!==S.pid)NET.pub(tP(pid),obj) }
function sendPriv(pid,obj){
  var p=G.players[pid];if(!p)return;
  if(pid===S.pid){handlePriv(obj);return}
  if(!p.pk)return;
  E2E.seal(p.pk,obj).then(function(box){NET.pub(tP(pid),{b:box})},noop);
}
function publish(force){
  if(!G)return;
  G.dirty=false;G.lastPub=Date.now();
  var list=[],k;
  for(k in G.players){
    var p=G.players[k];
    list.push({pid:p.pid,n:p.name,pk:p.pk,sc:p.sc,play:p.play,ok:p.ok,away:!!p.away});
  }
  list.sort(function(a,b){return (G.players[a.pid].joinAt-G.players[b.pid].joinAt)});
  var v={
    k:'state',gno:G.gno,ph:G.ph,host:S.pid,hostPk:S.kp?S.kp.pub:'',
    rd:G.rd,cfg:G.cfg,
    cat:(G.ph==='lobby')?'':G.cat,
    players:list,
    order:(G.ph==='describe')?G.order:null,
    turn:G.turn,totalTurns:G.totalTurns,laps:G.cfg.laps,
    endsAt:G.endsAt,
    voted:(G.ph==='vote')?keys(G.votes):null,
    cands:G.cands,
    tally:(G.ph==='tally')?G.tally:null,
    guessWho:(G.ph==='guess')?G.guessQ[G.guessPtr]:null,
    guessI:G.guessPtr,guessN:G.guessQ.length,
    fin:(G.ph==='result')?G.fin:null,
    pub:Date.now()
  };
  V=v;S.offset=0;S.lastState=Date.now();
  NET.pub(tS(),v,true);
  applyView();
}

/* ===================== 참가자: 수신 ===================== */
function onHostMsg(v){
  if(!v){ if(S.code)roomClosed(); return }
  if(v.k==='msg'){handleMsg(v.m);return}
  if(v.k!=='state')return;
  if(v.pub!==S.lastPub){S.lastPub=v.pub;S.lastState=Date.now();S.hop=0}
  S.offset=v.pub-Date.now();
  V=v;fail('');applyView();
}
function roomClosed(){
  leaveRoom(true);
  fail('방장이 방을 닫았습니다.');
}
function handleMsg(m){
  if(!m||!m.x)return;
  for(var i=0;i<S.chat.length;i++)if(S.chat[i].id===m.id)return;
  S.chat.push(m);
  if(S.chat.length>CHAT_MAX)S.chat.shift();
  paintChat(true);
}
function applyView(){
  if(!V)return;
  if(V.gno!==S.seenGno){       // 새 라운드 → 개인 정보 초기화
    S.seenGno=V.gno;
    /* 카드에는 라운드 번호가 실려 있다. 암복호화가 async라 카드 봉투가 상태보다
       먼저 도착할 수 있는데, 그때 무조건 지우면 이번 판 카드를 잃는다. */
    if(!S.card||S.card.g!==V.gno)S.card=null;
    S.cardOpen=false;S.gopts=null;
    S.myVote=null;S.myGuess=null;S.voteSent=false;S.guessSent=false;S.okSent=false;
  }
  var target=(V.ph==='lobby')?'onLobby':'onGame';
  if(target!==S.screen){
    oshow(target);
    /* 화면을 갈아끼웠으니 부분 렌더 캐시 키를 비운다 (안 비우면 첫 칠이 건너뛰어진다) */
    ['#ogTop','#ogCard','#ogChat','#ogAct','#olBody'].forEach(function(s){
      var e=$(s); if(e)e.__k='';
    });
  }
  paint();
}

/* ===================== 방장: 틱 ===================== */
function startHost(){
  clearInterval(hostTimer);
  hostTimer=setInterval(hostTick,TICK_MS);
}
function dropPlayer(pid,quiet){
  if(!G||!G.players[pid])return;
  var nm=G.players[pid].name;
  var wasPlaying=G.players[pid].play;
  delete G.players[pid];
  delete G.votes[pid];
  G.dirty=true;
  sys(nm+'님이 나갔습니다.','bad');
  if(G.ph==='lobby'||G.ph==='result')return;
  if(!wasPlaying)return;
  if(G.liars.indexOf(pid)>=0){voidRound('라이어가 나가 이번 판이 종료됐습니다.');return}
  if(G.spy===pid)G.spy=null;
  if(playingPids().length<MINP){
    sys('남은 인원이 부족해 대기실로 돌아갑니다.','bad');
    backToLobby();return;
  }
  if(G.ph==='vote'&&allVoted()){toTally();return}
  if(G.ph==='describe'&&G.order[G.turn%G.order.length]===pid){nextTurn();return}
  if(G.ph==='guess'&&G.guessQ[G.guessPtr]===pid){submitGuess(null);return}
}
function hostTick(){
  if(!G)return;
  var t=Date.now();
  if(!NET.online()){G.netLost=true}
  else if(G.netLost){G.netLost=false;G.grace=t+NET_GRACE_MS}
  var judging=NET.online()&&t>=(G.grace||0);

  for(var rp in G.players){
    var rq=G.players[rp];
    if(rq.away&&t-rq.seen<=AWAY_MS){rq.away=false;G.dirty=true}
  }
  if(judging){
    var ids=keys(G.players),i;
    for(i=0;i<ids.length;i++){
      var pid=ids[i];if(pid===S.pid)continue;
      var p=G.players[pid];if(!p)continue;
      var silent=t-p.seen;
      if(silent>DROP_MS){dropPlayer(pid);continue}
      if(silent>AWAY_MS&&!p.away){p.away=true;G.dirty=true}
    }
  }
  if(G.ph==='describe'&&G.endsAt&&t>=G.endsAt){
    var cur=curSpeaker();
    if(cur)sys(nameOf(cur)+' — (시간 초과)','');
    nextTurn();return;
  }
  if(G.ph==='debate'&&G.endsAt&&t>=G.endsAt){toVote(false);return}
  if(G.ph==='guess'&&G.endsAt&&t>=G.endsAt){submitGuess(null);return}

  if(G.dirty||t-G.lastPub>=STATE_MS)publish();
}

/* ===================== 게임 진행 ===================== */
function cfgProblem(){
  var n=playingPids().length;
  if(n<MINP)return '참가 인원이 '+MINP+'명 이상이어야 합니다. (지금 '+n+'명'+(G.cfg.hostPlays?'':' · 방장은 진행만')+')';
  if(n>MAXP)return '참가 인원은 최대 '+MAXP+'명입니다.';
  if(!G.cfg.cats.length)return '주제를 하나 이상 골라 주세요.';
  return '';
}
function startGame(){
  if(!G||G.ph!=='lobby')return;
  if(cfgProblem())return;
  G.rd=0;
  newRound();
}
function newRound(){
  var pl=playingPids();
  var n=pl.length;
  var cfg=G.cfg;
  G.gno++;G.rd++;
  var liarCount=(n>=6)?cfg.liarCount:1;
  if(liarCount>=n)liarCount=1;
  var mode=(cfg.mode==='spy'&&n<5)?'basic':cfg.mode;
  var cats=cfg.cats.filter(function(c){return CATS.indexOf(c)>=0});
  if(!cats.length)cats=CATS.slice();
  var cat=cats[rnd(cats.length)];
  var pool=W[cat];
  var word=pool[rnd(pool.length)];
  var fool=null;
  if(mode==='fool'){do{fool=pool[rnd(pool.length)]}while(fool===word)}
  var sh=shuffle(pl);
  var liars=sh.slice(0,liarCount);
  var spy=null;
  if(mode==='spy'){var cz=sh.slice(liarCount);if(cz.length)spy=cz[rnd(cz.length)]}

  G.ph='reveal';G.cat=cat;G.word=word;G.fool=fool;G.mode=mode;G.liars=liars;G.spy=spy;
  G.order=shuffle(pl);G.turn=0;G.totalTurns=pl.length*cfg.laps;G.endsAt=0;
  G.votes={};G.cands=null;G.revoted=false;G.tally=null;G.accused=null;G.caught=false;
  G.guessQ=[];G.guessPtr=0;G.guessOpts=[];G.guessPicks=[];G.guessHit=false;G.fin=null;
  for(var k in G.players){
    var p=G.players[k];
    p.ok=false;
    p.play=(k!==S.pid||cfg.hostPlays);
  }
  sys('── '+G.rd+'라운드 시작 · 주제 「'+cat+'」 ──','ok');
  for(var i=0;i<pl.length;i++)sendPriv(pl[i],cardFor(pl[i]));
  G.dirty=true;publish(true);
}
function cardFor(pid){
  var isLiar=G.liars.indexOf(pid)>=0, isSpy=(G.spy===pid);
  var g=G.gno;
  /* 바보 모드 라이어에게는 시민 카드와 **완전히 같은 모양**을 보낸다.
     필드가 하나라도 다르면 봉투를 연 본인이 자기가 라이어임을 알아챈다. */
  if(isLiar&&G.mode==='fool')return {t:'card',g:g,cat:G.cat,word:G.fool};
  if(isLiar)return {t:'card',g:g,cat:G.cat,liar:true,n:G.liars.length};
  if(isSpy)return {t:'card',g:g,cat:G.cat,word:G.word,spy:true,ln:G.liars.map(nameOf)};
  return {t:'card',g:g,cat:G.cat,word:G.word};
}
function allOk(){
  var pl=playingPids(),i;
  for(i=0;i<pl.length;i++)if(!G.players[pl[i]].ok)return false;
  return true;
}
function toDescribe(){
  G.ph='describe';G.turn=0;
  var pl=playingPids();
  G.order=G.order.filter(function(p){return pl.indexOf(p)>=0});
  if(!G.order.length)G.order=pl;
  G.totalTurns=G.order.length*G.cfg.laps;
  armTurn();
  sys('설명 라운드를 시작합니다. 자기 차례에만 입력창이 열립니다.','');
  G.dirty=true;publish(true);
}
function curSpeaker(){
  if(!G.order.length)return null;
  var start=G.turn,n=G.order.length;
  for(var i=0;i<n;i++){
    var pid=G.order[(start+i)%n];
    if(G.players[pid]&&G.players[pid].play)return pid;
  }
  return null;
}
function armTurn(){
  G.endsAt=G.cfg.turnLimit>0?(Date.now()+G.cfg.turnLimit*1000):0;
}
function nextTurn(){
  G.turn++;
  while(G.turn<G.totalTurns){
    var pid=G.order[G.turn%G.order.length];
    if(G.players[pid]&&G.players[pid].play)break;
    G.turn++;
  }
  if(G.turn>=G.totalTurns){toDebate();return}
  armTurn();G.dirty=true;publish(true);
}
function hostSay(pid,id,x){
  var t=String(x||'').replace(/\s+/g,' ').trim().slice(0,SAY_MAX);
  if(!t)return;
  var p=G.players[pid];if(!p)return;
  if(G.ph==='describe'){
    if(G.order[G.turn%G.order.length]!==pid)return;      // 자기 차례가 아니면 무시
    pushMsg({id:String(id||rid(8)),ty:'say',pid:pid,n:p.name,x:t,
             lap:Math.floor(G.turn/G.order.length)+1});
    nextTurn();
    return;
  }
  if(G.ph==='debate'||G.ph==='tally'||G.ph==='result'||G.ph==='lobby'){
    if(!p.play&&G.ph!=='lobby'&&pid!==S.pid)return;
    pushMsg({id:String(id||rid(8)),ty:'chat',pid:pid,n:p.name,x:t});
  }
}
function toDebate(){
  G.ph='debate';
  G.endsAt=G.cfg.debate>0?(Date.now()+G.cfg.debate*1000):0;
  sys('자유 토론 — 누가 라이어인지 이야기하세요.','');
  G.dirty=true;publish(true);
}
function canVote(pid){
  var p=G.players[pid];
  if(!p||!p.play)return false;
  if(G.cands&&G.cands.length&&G.cands.length===1&&G.cands[0]===pid)return false;
  return true;
}
function voteTargets(voter){
  var base=(G.cands&&G.cands.length)?G.cands.slice():playingPids();
  var out=base.filter(function(p){return p!==voter&&G.players[p]&&G.players[p].play});
  if(!out.length)out=playingPids().filter(function(p){return p!==voter});
  return out;
}
function allVoted(){
  var pl=playingPids(),i,need=0,got=0;
  for(i=0;i<pl.length;i++){
    if(!voteTargets(pl[i]).length)continue;
    need++;
    if(G.votes[pl[i]]!==undefined)got++;
  }
  return need>0&&got>=need;
}
function toVote(isRevote){
  G.ph='vote';G.votes={};G.endsAt=0;
  if(!isRevote)G.cands=null;
  sys(isRevote?'재투표 — 동률이었던 후보 중에서 고르세요.':'비밀 투표 — 라이어로 의심되는 사람을 고르세요.','');
  G.dirty=true;publish(true);
}
function toTally(){
  var pl=playingPids();
  var counts={},by={},i;
  for(i=0;i<pl.length;i++)counts[pl[i]]=0;
  for(var v in G.votes){
    var tg=G.votes[v];
    if(counts[tg]===undefined)continue;
    counts[tg]++;by[v]=tg;
  }
  var max=0;
  for(i=0;i<pl.length;i++)if(counts[pl[i]]>max)max=counts[pl[i]];
  var top=[];
  for(i=0;i<pl.length;i++)if(counts[pl[i]]===max&&max>0)top.push(pl[i]);

  G.ph='tally';G.endsAt=0;
  G.tally={counts:counts,by:by,max:max,top:top,order:pl.slice(),
           tie:(top.length!==1),revoted:G.revoted};
  if(top.length!==1){
    if(!G.revoted){G.revoted=true;G.cands=top.slice();G.tally.next='revote'}
    else{G.tally.next='result';G.accused=null;G.caught=false}
  }else{
    G.accused=top[0];
    G.caught=(G.liars.indexOf(G.accused)>=0);
    G.tally.accused=G.accused;
    G.tally.next=G.caught?'guess':'result';
  }
  G.dirty=true;publish(true);
}
function buildOptions(){
  var pool=W[G.cat].filter(function(w){return w!==G.word&&w!==G.fool});
  pool=shuffle(pool);
  var need=Math.min(G.cfg.guessOpts,pool.length+1);
  return shuffle([G.word].concat(pool.slice(0,need-1)));
}
function toGuess(){
  var q=[G.accused],i;
  for(i=0;i<G.liars.length;i++){
    var l=G.liars[i];
    if(l!==G.accused&&G.players[l]&&G.players[l].play)q.push(l);
  }
  G.ph='guess';G.guessQ=q;G.guessPtr=0;G.guessOpts=buildOptions();
  G.guessPicks=[];G.guessHit=false;
  armGuess();
  sys(nameOf(G.accused)+'님이 지목되었습니다. 라이어의 마지막 추리가 남았습니다.','');
  G.dirty=true;publish(true);
}
function armGuess(){
  var who=G.guessQ[G.guessPtr];
  if(!who||!G.players[who]){submitGuess(null);return}
  sendPriv(who,{t:'gopts',opts:G.guessOpts});
  G.endsAt=G.cfg.guessTimer>0?(Date.now()+G.cfg.guessTimer*1000):0;
}
function submitGuess(pick){
  if(!G||G.ph!=='guess')return;
  var who=G.guessQ[G.guessPtr];
  if(pick!=null&&G.guessOpts.indexOf(pick)<0)pick=null;
  G.guessPicks.push({who:who,pick:pick});
  if(pick===G.word)G.guessHit=true;
  G.guessPtr++;
  if(G.guessPtr>=G.guessQ.length){toResult();return}
  armGuess();G.dirty=true;publish(true);
}
function voidRound(reason){
  G.ph='result';G.endsAt=0;
  G.fin={vd:reason,word:G.word,fool:G.fool,mode:G.mode,
         liars:G.liars.slice(),spy:G.spy,names:nameMap(),
         outcome:'void',gain:{},picks:[],accused:G.accused};
  G.dirty=true;publish(true);
}
function nameMap(){
  var m={},k;
  for(k in G.players)m[k]=G.players[k].name;
  for(var i=0;i<G.liars.length;i++)if(!m[G.liars[i]])m[G.liars[i]]='(나간 사람)';
  return m;
}
function toResult(){
  var pl=playingPids(),i;
  var caught=G.caught,hit=G.guessHit;
  var outcome=!caught?'liarWin':(hit?'comeback':'citizenWin');
  var team=G.liars.slice();
  if(G.spy)team.push(G.spy);
  var gain={};
  for(i=0;i<pl.length;i++)gain[pl[i]]=0;
  if(outcome==='liarWin'){team.forEach(function(p){if(gain[p]!==undefined)gain[p]+=2})}
  else if(outcome==='comeback'){team.forEach(function(p){if(gain[p]!==undefined)gain[p]+=1})}
  else{for(i=0;i<pl.length;i++)if(team.indexOf(pl[i])<0)gain[pl[i]]+=1}
  if(caught){
    for(i=0;i<pl.length;i++){
      var p=pl[i];
      if(team.indexOf(p)>=0)continue;
      if(G.votes[p]===G.accused)gain[p]+=1;
    }
  }
  for(i=0;i<pl.length;i++)if(G.players[pl[i]])G.players[pl[i]].sc+=gain[pl[i]];

  G.ph='result';G.endsAt=0;
  G.fin={outcome:outcome,word:G.word,fool:G.fool,mode:G.mode,
         liars:G.liars.slice(),spy:G.spy,names:nameMap(),
         gain:gain,picks:G.guessPicks.slice(),accused:G.accused};
  G.dirty=true;publish(true);
}
function backToLobby(){
  G.ph='lobby';G.endsAt=0;G.cat='';G.word='';G.fool=null;
  G.liars=[];G.spy=null;G.order=[];G.turn=0;G.totalTurns=0;
  G.votes={};G.cands=null;G.revoted=false;G.tally=null;G.accused=null;G.caught=false;
  G.guessQ=[];G.guessPtr=0;G.guessOpts=[];G.guessPicks=[];G.guessHit=false;G.fin=null;
  for(var k in G.players){G.players[k].ok=false;G.players[k].play=true}
  G.gno++;G.dirty=true;publish(true);
}

/* ===================== 참가자: 송신 ===================== */
function sendSay(text){
  var t=String(text||'').replace(/\s+/g,' ').trim().slice(0,SAY_MAX);
  if(!t)return;
  var now=Date.now();
  if(now-S.lastSay<350)return;
  S.lastSay=now;
  if(S.isHost)hostSay(S.pid,rid(8),t);
  else NET.pub(tC(),{t:'say',pid:S.pid,id:rid(8),x:t});
}
function sendSecret(obj){
  if(S.isHost){hostSecret(S.pid,obj);return}
  if(!V||!V.hostPk)return;
  E2E.seal(V.hostPk,obj).then(function(box){NET.pub(tC(),{t:'sec',pid:S.pid,b:box})},noop);
}
function sendOk(){
  if(S.okSent)return;S.okSent=true;
  if(S.isHost){var p=G.players[S.pid];if(p&&p.play){p.ok=true;G.dirty=true}}
  else NET.pub(tC(),{t:'ok',pid:S.pid});
}

/* ===================== 그리기 ===================== */
function me(){
  if(!V)return null;
  for(var i=0;i<V.players.length;i++)if(V.players[i].pid===S.pid)return V.players[i];
  return null;
}
function iPlay(){var m=me();return !!(m&&m.play)}
function remain(){
  if(!V||!V.endsAt)return null;
  return Math.max(0,Math.round((V.endsAt-(Date.now()+S.offset))/1000));
}
function paint(){
  if(!V)return;
  setNav();
  var r=remain();
  setTimerBox((V.ph==='describe'||V.ph==='debate'||V.ph==='guess')?r:null);
  if(S.screen==='onLobby')paintLobby();
  else if(S.screen==='onGame'){paintTop();paintCard();paintChat(false);paintAct()}
}

/* ---------- 대기실 ---------- */
function paintLobby(){
  var host=(V.host===S.pid);
  var key=[V.players.map(function(p){return p.pid+p.n+p.sc}).join(','),
           JSON.stringify(V.cfg),host,S.code].join('|');
  var box=$('#olBody');
  if(box.__k!==key){
    box.__k=key;
    var n=V.players.filter(function(p){return p.play&&!(p.pid===V.host&&!V.cfg.hostPlays)}).length;
    var h='<div class="pan"><div class="ptRow"><div class="pt">대기실</div>'+
      '<button class="verBtn" id="olCopy">코드 '+esc(S.code)+' 복사</button></div>'+
      '<p class="lead">친구에게 <b>방 코드 '+esc(S.code)+'</b>를 알려 주세요. 참가 <b>'+n+'명</b> / 3~10명</p></div>';
    h+='<div class="pan"><div class="lbl">참가자 '+V.players.length+'명</div><div class="order" id="olList">'+
      V.players.map(function(p,i){
        var tag=(p.pid===V.host)?'방장':(p.play?'참가':'관전');
        if(p.pid===V.host&&!V.cfg.hostPlays)tag='방장 · 진행만';
        return '<div class="orow'+(p.pid===S.pid?' now':'')+(p.away?' done':'')+'">'+
          '<span class="no">'+(i+1)+'</span><span class="n">'+esc(p.n)+'</span>'+
          '<span class="s">'+tag+'</span></div>';
      }).join('')+'</div></div>';

    if(host){
      h+='<div class="pan"><div class="lbl">주제 <em id="oCatCnt"></em></div><div class="chips" id="oCatList"></div></div>';
      h+='<div class="pan">'+
        '<div class="lbl">모드</div><div class="seg" data-okey="mode">'+
          '<button data-v="basic">기본</button><button data-v="fool">바보</button>'+
          '<button data-v="spy" id="oSpy">스파이 <small>(5인+)</small></button></div>'+
        '<div class="lbl">라이어 수</div><div class="seg" data-okey="liarCount" data-num="1">'+
          '<button data-v="1">1명</button><button data-v="2" id="oLiar2">2명 <small>(6인+)</small></button></div>'+
        '<div class="lbl">설명 바퀴</div><div class="seg" data-okey="laps" data-num="1">'+
          '<button data-v="1">1바퀴</button><button data-v="2">2바퀴</button></div>'+
        '<div class="lbl">1인 발언 제한</div><div class="seg" data-okey="turnLimit" data-num="1">'+
          '<button data-v="0">끄기</button><button data-v="15">15초</button><button data-v="30">30초</button></div>'+
        '<div class="lbl">토론 시간</div><div class="seg" data-okey="debate" data-num="1">'+
          '<button data-v="60">1분</button><button data-v="120">2분</button><button data-v="180">3분</button><button data-v="0">무제한</button></div>'+
        '<div class="lbl">추리 보기 수</div><div class="seg" data-okey="guessOpts" data-num="1">'+
          '<button data-v="4">4개</button><button data-v="6">6개</button><button data-v="8">8개</button></div>'+
        '<div class="lbl">추리 제한시간</div><div class="seg" data-okey="guessTimer" data-num="1">'+
          '<button data-v="30">30초</button><button data-v="0">끄기</button></div>'+
        '<div class="lbl">방장 참가</div><div class="seg" data-okey="hostPlays">'+
          '<button data-v="yes">같이 한다</button><button data-v="no">진행만 한다</button></div>'+
        '<p class="lead">배정을 방장 브라우저가 하므로 <b>방장은 정답을 볼 수 있습니다</b>. '+
        '완전히 공정한 판이 필요하면 <b>진행만 한다</b>를 고르세요.</p></div>';
      h+='<div class="foot"><p class="lead" id="oWarn" style="color:var(--gold);min-height:15px"></p>'+
         '<button class="btn" id="oStart">게임 시작</button>'+
         '<button class="btn ghost" id="oLeave">방 닫고 나가기</button></div>';
    }else{
      h+='<div class="pan mid"><div class="em" style="font-size:40px">⏳</div>'+
         '<p class="lead">방장이 설정을 마치고 시작하기를 기다리는 중입니다.</p></div>'+
         '<div class="foot"><button class="btn ghost" id="oLeave">나가기</button></div>';
    }
    box.innerHTML=h;
    $('#olCopy').onclick=function(){
      var t=S.code;
      if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(t).then(function(){
        $('#olCopy').textContent='복사됨!';setTimeout(function(){var e=$('#olCopy');if(e)e.textContent='코드 '+t+' 복사'},1200);
      },noop);
      else{try{prompt('방 코드',t)}catch(e){}}
    };
    var lv=$('#oLeave');if(lv)lv.onclick=askLeave;
    if(host){
      paintCats();
      $('#oCatList').onclick=function(e){
        var b=e.target.closest('.chip');if(!b||!G)return;
        if(b.getAttribute('data-all')){
          G.cfg.cats=(G.cfg.cats.length===CATS.length)?[CATS[0]]:CATS.slice();
        }else{
          var c=b.getAttribute('data-c'),i=G.cfg.cats.indexOf(c);
          if(i>=0){if(G.cfg.cats.length>1)G.cfg.cats.splice(i,1)}else G.cfg.cats.push(c);
        }
        saveCfg();paintCats();G.dirty=true;publish(true);
      };
      box.addEventListener('click',function(e){
        var b=e.target.closest('.seg[data-okey] > button');if(!b||!G)return;
        if(b.disabled)return;
        var seg=b.parentNode,k=seg.getAttribute('data-okey');
        var v=b.getAttribute('data-v');
        if(k==='hostPlays')G.cfg.hostPlays=(v==='yes');
        else G.cfg[k]=seg.getAttribute('data-num')?parseInt(v,10):v;
        saveCfg();G.dirty=true;publish(true);
      });
      $('#oStart').onclick=startGame;
    }
  }
  if(host)paintHostSegs();
}
function paintCats(){
  var el=$('#oCatList');if(!el||!G)return;
  var h='<button class="chip all" data-all="1">전체</button>';
  for(var i=0;i<CATS.length;i++){
    var on=G.cfg.cats.indexOf(CATS[i])>=0;
    h+='<button class="chip'+(on?' on':'')+'" data-c="'+esc(CATS[i])+'">'+esc(CATS[i])+'</button>';
  }
  el.innerHTML=h;
  var c=$('#oCatCnt');if(c)c.textContent=G.cfg.cats.length+'개 선택';
}
function paintHostSegs(){
  if(!G)return;
  var n=playingPids().length;
  var segs=document.querySelectorAll('#olBody .seg[data-okey]'),i,j;
  for(i=0;i<segs.length;i++){
    var k=segs[i].getAttribute('data-okey');
    var bs=segs[i].querySelectorAll('button');
    for(j=0;j<bs.length;j++){
      var want=(k==='hostPlays')?(G.cfg.hostPlays?'yes':'no'):String(G.cfg[k]);
      bs[j].classList.toggle('on',want===bs[j].getAttribute('data-v'));
    }
  }
  var s=$('#oSpy'),l2=$('#oLiar2');
  if(s)s.disabled=(n<5);
  if(l2)l2.disabled=(n<6);
  if(n<5&&G.cfg.mode==='spy'){G.cfg.mode='basic';G.dirty=true}
  if(n<6&&G.cfg.liarCount===2){G.cfg.liarCount=1;G.dirty=true}
  var w=$('#oWarn'),st=$('#oStart');
  var prob=cfgProblem();
  if(w)w.textContent=prob;
  if(st)st.disabled=!!prob;
}

/* ---------- 게임 상단 ---------- */
function paintTop(){
  var key=[V.ph,V.turn,V.rd,V.players.map(function(p){return p.pid+p.n+p.sc+(p.ok?1:0)+(p.away?1:0)}).join(','),
           (V.voted||[]).join(','),V.guessWho].join('|');
  var el=$('#ogTop');
  if(el.__k===key)return;
  el.__k=key;
  var speaker=(V.ph==='describe'&&V.order&&V.order.length)?V.order[V.turn%V.order.length]:null;
  var voted=V.voted||[];
  var h='<div class="pan" style="gap:6px"><div class="lbl" id="ogPhase">'+esc(phaseLine())+'</div>'+
    '<div class="pstrip">'+V.players.filter(function(p){return p.play}).map(function(p){
      var cls='pchip';
      if(p.pid===speaker)cls+=' now';
      if(V.ph==='reveal'&&p.ok)cls+=' ok';
      if(V.ph==='vote'&&voted.indexOf(p.pid)>=0)cls+=' ok';
      if(p.away)cls+=' away';
      return '<span class="'+cls+'">'+esc(p.n)+(p.sc?'<i>'+p.sc+'</i>':'')+'</span>';
    }).join('')+'</div></div>';
  el.innerHTML=h;
}
function phaseLine(){
  if(!V)return '';
  if(V.ph==='reveal'){
    var n=V.players.filter(function(p){return p.play}).length;
    var ok=V.players.filter(function(p){return p.play&&p.ok}).length;
    return '주제 「'+V.cat+'」 · 확인 '+ok+'/'+n;
  }
  if(V.ph==='describe'){
    var lap=V.order&&V.order.length?Math.floor(V.turn/V.order.length)+1:1;
    return '주제 「'+V.cat+'」 · '+lap+'/'+V.laps+'바퀴 · '+(V.turn+1)+'/'+V.totalTurns+'번째 발언';
  }
  if(V.ph==='debate')return '주제 「'+V.cat+'」 · 자유 토론';
  if(V.ph==='vote'){
    var need=V.players.filter(function(p){return p.play}).length;
    return '비밀 투표 · '+(V.voted?V.voted.length:0)+'/'+need+'명 완료';
  }
  if(V.ph==='tally')return '개표 결과';
  if(V.ph==='guess')return '라이어 추리'+(V.guessN>1?(' ('+(V.guessI+1)+'/'+V.guessN+')'):'');
  if(V.ph==='result')return '결과 · '+V.rd+'라운드';
  return '';
}

/* ---------- 내 카드 (접힘) ---------- */
function paintCard(){
  var el=$('#ogCard');
  var show=(V.ph==='reveal'||V.ph==='describe'||V.ph==='debate'||V.ph==='vote'||V.ph==='tally'||V.ph==='guess');
  var key=[show,S.cardOpen,S.card?JSON.stringify(S.card):'-'].join('|');
  if(el.__k===key)return;
  el.__k=key;
  if(!show||!S.card){el.innerHTML='';return}
  if(!S.cardOpen){
    el.innerHTML='<button class="cardfold" id="ogCardBtn">🔒 내 카드 보기 <small>옆사람 조심</small></button>';
  }else{
    el.innerHTML='<button class="cardfold open" id="ogCardBtn">🔓 카드 접기</button>'+cardHTML(S.card,true);
  }
  $('#ogCardBtn').onclick=function(){S.cardOpen=!S.cardOpen;paintCard()};
}
function cardHTML(c,compact){
  var head='<div class="cat">주제 · <b>'+esc(c.cat)+'</b></div>';
  if(c.liar){
    return '<div class="rcard liar'+(compact?' mini':'')+'">'+head+
      '<div class="liarT">당신은 라이어입니다</div>'+
      '<div class="note">제시어를 모릅니다. 다른 사람의 설명을 듣고 아는 척 연기하세요.'+
      (c.n>1?'<br>라이어는 총 '+c.n+'명입니다.':'')+'</div></div>';
  }
  var spy='';
  if(c.spy){
    spy='<div class="spy">🕶 당신은 스파이입니다<br>라이어: '+esc((c.ln||[]).join(' · '))+'</div>'+
        '<div class="note">라이어가 들키지 않게 은근히 도우세요. 라이어가 이기면 함께 이깁니다.</div>';
  }
  return '<div class="rcard'+(compact?' mini':'')+'">'+head+
    '<div class="word'+(String(c.word).length>6?' small':'')+'">'+esc(c.word)+'</div>'+spy+'</div>';
}

/* ---------- 채팅 ---------- */
function paintChat(force){
  var el=$('#ogChat');
  if(!el)return;
  if(S.screen!=='onGame')return;
  var last=S.chat.length?S.chat[S.chat.length-1].id:'';
  var key=S.chat.length+'|'+last;
  if(!force&&el.__k===key)return;
  el.__k=key;
  var atBottom=(el.scrollHeight-el.scrollTop-el.clientHeight)<60;
  el.innerHTML=S.chat.map(function(m){
    if(m.ty==='sys')return '<div class="cm sys'+(m.tone?' '+m.tone:'')+'">'+esc(m.x)+'</div>';
    var who=(m.pid===S.pid)?' mine':'';
    return '<div class="cm'+(m.ty==='say'?' say':'')+who+'">'+
      '<b>'+esc(m.n)+(m.ty==='say'&&m.lap?' <i>'+m.lap+'바퀴</i>':'')+'</b>'+esc(m.x)+'</div>';
  }).join('');
  if(atBottom||force)el.scrollTop=el.scrollHeight;
}

/* ---------- 액션 영역 ---------- */
function actKey(){
  var m=me();
  return [V.ph,V.turn,V.gno,V.guessWho,V.guessI,S.voteSent,S.myVote,S.guessSent,S.myGuess,
          S.okSent,!!S.card,S.gopts?S.gopts.join(','):'',V.host===S.pid,m?m.play:0,
          V.tally?V.tally.next:'',(V.voted||[]).length,V.players.length].join('|');
}
function paintAct(){
  var el=$('#ogAct');
  var k=actKey();
  if(el.__k===k)return;
  el.__k=k;
  var host=(V.host===S.pid);
  var h='',wire=null;

  if(V.ph==='reveal'){
    if(!iPlay()){
      h='<p class="lead" style="text-align:center">이번 판은 진행만 합니다. 전원 확인을 기다리는 중…</p>';
    }else if(!S.card){
      h='<p class="lead" style="text-align:center">카드를 받는 중…</p>';
    }else{
      h='<p class="lead" style="text-align:center">위의 <b>내 카드 보기</b>로 확인한 뒤 눌러 주세요.</p>'+
        '<button class="btn gold" id="oOk"'+(S.okSent?' disabled':'')+'>'+
        (S.okSent?'확인함 · 다른 사람 기다리는 중':'확인했습니다')+'</button>';
      wire=function(){var b=$('#oOk');if(b)b.onclick=function(){sendOk();paintAct()}};
    }
    if(host)h+='<button class="btn ghost" id="oForce">모두 확인한 걸로 하고 시작</button>';
  }
  else if(V.ph==='describe'){
    var mine=(V.order&&V.order.length&&V.order[V.turn%V.order.length]===S.pid);
    if(mine){
      h='<div class="inrow"><input class="tin" type="text" id="oSay" maxlength="'+SAY_MAX+'" '+
        'placeholder="한 문장으로 설명 ('+SAY_MAX+'자)" autocomplete="off">'+
        '<button class="btn" id="oSend" style="width:74px;flex:none;padding:12px 0">보내기</button></div>';
      wire=function(){
        var i=$('#oSay');
        $('#oSend').onclick=function(){sendSay(i.value);i.value=''};
        i.onkeydown=function(e){if(e.key==='Enter'){sendSay(i.value);i.value=''}};
        try{i.focus()}catch(e){}
      };
    }else{
      var sp=(V.order&&V.order.length)?vName(V.order[V.turn%V.order.length]):'';
      h='<p class="lead" style="text-align:center"><b>'+esc(sp)+'</b>님이 설명 중입니다. 차례를 기다리세요.</p>';
    }
    if(host)h+='<button class="btn ghost" id="oSkip">이 차례 건너뛰기</button>';
  }
  else if(V.ph==='debate'){
    h='<div class="inrow"><input class="tin" type="text" id="oSay" maxlength="'+SAY_MAX+'" '+
      'placeholder="자유 토론" autocomplete="off">'+
      '<button class="btn" id="oSend" style="width:74px;flex:none;padding:12px 0">보내기</button></div>';
    wire=function(){
      var i=$('#oSay');
      $('#oSend').onclick=function(){sendSay(i.value);i.value=''};
      i.onkeydown=function(e){if(e.key==='Enter'){sendSay(i.value);i.value=''}};
    };
    if(host)h+='<button class="btn" id="oToVote">투표 시작</button>';
  }
  else if(V.ph==='vote'){
    if(!iPlay()){
      h='<p class="lead" style="text-align:center">진행자는 투표하지 않습니다.</p>';
    }else if(S.voteSent){
      h='<p class="lead" style="text-align:center">투표를 보냈습니다. 다른 사람을 기다리는 중…</p>';
    }else{
      var tg=V.players.filter(function(p){
        if(!p.play||p.pid===S.pid)return false;
        if(V.cands&&V.cands.length)return V.cands.indexOf(p.pid)>=0;
        return true;
      });
      h='<div class="picks votebox">'+tg.map(function(p){
        return '<button class="pick'+(S.myVote===p.pid?' on':'')+'" data-p="'+esc(p.pid)+'">'+
          '<span class="mk"></span><span>'+esc(p.n)+'</span></button>';
      }).join('')+'</div>'+
      '<button class="btn gold" id="oVote"'+(S.myVote?'':' disabled')+'>투표 확정</button>';
      wire=function(){
        $('#ogAct').querySelector('.votebox').onclick=function(e){
          var b=e.target.closest('.pick');if(!b)return;
          S.myVote=b.getAttribute('data-p');paintAct();
        };
        $('#oVote').onclick=function(){
          if(!S.myVote)return;
          S.voteSent=true;sendSecret({t:'vote',tg:S.myVote});paintAct();
        };
      };
    }
    if(host)h+='<button class="btn ghost" id="oTally">지금 개표하기</button>';
  }
  else if(V.ph==='tally'){
    h=tallyHTML();
    if(host){
      var nx=V.tally?V.tally.next:'result';
      h+='<button class="btn" id="oNext">'+(nx==='revote'?'재투표 시작':(nx==='guess'?'라이어 추리로 →':'결과 보기'))+'</button>';
    }else h+='<p class="lead" style="text-align:center">방장이 다음으로 넘기기를 기다리는 중…</p>';
  }
  else if(V.ph==='guess'){
    if(V.guessWho===S.pid){
      if(!S.gopts)h='<p class="lead" style="text-align:center">보기를 받는 중…</p>';
      else if(S.guessSent)h='<p class="lead" style="text-align:center">선택을 보냈습니다.</p>';
      else{
        var fn=(V.cfg.mode==='fool')?'<p class="lead">사실 당신이 <b>라이어</b>였습니다. 보고 있던 제시어는 가짜입니다.</p>':'';
        h=fn+'<div class="opts guessbox">'+S.gopts.map(function(w){
          return '<button class="opt'+(S.myGuess===w?' on':'')+'" data-w="'+esc(w)+'">'+esc(w)+'</button>';
        }).join('')+'</div>'+
        '<button class="btn gold" id="oGuess"'+(S.myGuess?'':' disabled')+'>이걸로 확정</button>';
        wire=function(){
          $('#ogAct').querySelector('.guessbox').onclick=function(e){
            var b=e.target.closest('.opt');if(!b)return;
            S.myGuess=b.getAttribute('data-w');paintAct();
          };
          $('#oGuess').onclick=function(){
            if(!S.myGuess)return;
            S.guessSent=true;sendSecret({t:'guess',pick:S.myGuess});paintAct();
          };
        };
      }
    }else{
      h='<p class="lead" style="text-align:center"><b>'+esc(vName(V.guessWho))+'</b>님이 제시어를 추리하는 중입니다…</p>';
    }
  }
  else if(V.ph==='result'){
    h=resultHTML();
    if(host)h+='<button class="btn" id="oNextRound">다음 라운드</button>'+
               '<button class="btn ghost" id="oLobby">대기실로</button>';
    else h+='<p class="lead" style="text-align:center">방장이 다음 라운드를 시작하기를 기다리는 중…</p>';
  }
  el.innerHTML=h;
  if(wire)wire();
  if(host){
    var f=$('#oForce');if(f)f.onclick=function(){if(G&&G.ph==='reveal')toDescribe()};
    var sk=$('#oSkip');if(sk)sk.onclick=function(){
      if(!G||G.ph!=='describe')return;
      var c=curSpeaker();if(c)sys(nameOf(c)+' — (건너뜀)','');
      nextTurn();
    };
    var tv=$('#oToVote');if(tv)tv.onclick=function(){if(G&&G.ph==='debate')toVote(false)};
    var tl=$('#oTally');if(tl)tl.onclick=function(){if(G&&G.ph==='vote')toTally()};
    var nb=$('#oNext');if(nb)nb.onclick=function(){
      if(!G||G.ph!=='tally')return;
      var nx=G.tally?G.tally.next:'result';
      if(nx==='revote')toVote(true);
      else if(nx==='guess')toGuess();
      else toResult();
    };
    var nr=$('#oNextRound');if(nr)nr.onclick=function(){if(G&&G.ph==='result')newRound()};
    var lb=$('#oLobby');if(lb)lb.onclick=function(){if(G&&G.ph==='result')backToLobby()};
  }
}
function tallyHTML(){
  var t=V.tally;if(!t)return '';
  var rows=t.order.map(function(p){return {p:p,c:t.counts[p]||0}});
  rows.sort(function(a,b){return b.c-a.c});
  var from={};
  for(var v in t.by){(from[t.by[v]]=from[t.by[v]]||[]).push(vName(v))}
  var msg;
  if(t.tie&&t.next==='revote')msg='<b>동률입니다.</b> ('+t.top.map(vName).map(esc).join(' · ')+')<br>이 후보들만 대상으로 재투표 1회.';
  else if(t.tie)msg='<b>재투표도 동률입니다.</b> 아무도 지목하지 못했으므로 <b>라이어의 승리</b>입니다.';
  else if(t.next==='guess')msg='<b>'+esc(vName(t.accused))+'</b>님이 지목되었습니다. 라이어의 마지막 추리가 남았습니다.';
  else msg='<b>'+esc(vName(t.accused))+'</b>님이 지목되었습니다. 과연 라이어였을까요?';
  return '<div class="pan"><p class="lead">'+msg+'</p></div>'+
    '<div class="tally">'+rows.map(function(o){
      var isTop=(o.c===t.max&&t.max>0);
      return '<div class="trow'+(isTop?' top':'')+'">'+
        '<div class="th"><span class="n">'+esc(vName(o.p))+'</span><span class="v">'+o.c+'표</span></div>'+
        (from[o.p]?'<div class="from">← '+esc(from[o.p].join(', '))+'</div>':'')+
        '<div class="bar"><i style="width:'+(t.max?Math.round(o.c/t.max*100):0)+'%"></i></div></div>';
    }).join('')+'</div>';
}
function resultHTML(){
  var f=V.fin;if(!f)return '';
  if(f.outcome==='void'){
    return '<div class="pan"><div class="big liar">판 종료</div>'+
      '<p class="lead" style="text-align:center">'+esc(f.vd)+'</p></div>'+
      '<div class="answer"><div class="k">정답이었던 제시어</div><div class="w">'+esc(f.word)+'</div></div>';
  }
  var T,cls,D;
  if(f.outcome==='liarWin'){T='라이어 승리!';cls='liar';
    D=f.accused?('<b>'+esc(f.names[f.accused]||'?')+'</b>님은 라이어가 아니었습니다.'):'투표가 끝내 갈렸습니다.'}
  else if(f.outcome==='comeback'){T='라이어 역전승!';cls='liar';D='지목당했지만 제시어를 맞혔습니다.'}
  else{T='시민 승리!';cls='cit';D='라이어를 찾아냈고, 제시어도 지켜냈습니다.'}

  var sub='';
  if(f.mode==='fool'&&f.fool)sub+='바보 모드 — 라이어에게는 <b>'+esc(f.fool)+'</b>'+josa(f.fool,'이','가')+' 보였습니다.<br>';
  if(f.picks&&f.picks.length){
    sub+=f.picks.map(function(g){
      return esc(f.names[g.who]||'?')+'의 추리: <b>'+(g.pick?esc(g.pick):'시간 초과')+'</b>'+(g.pick===f.word?' ⭕':' ❌');
    }).join('<br>');
  }
  var players=V.players.filter(function(p){return p.play});
  var roles=players.map(function(p){
    var isL=f.liars.indexOf(p.pid)>=0,isS=(f.spy===p.pid);
    var g=f.gain[p.pid]||0;
    return '<li class="'+(isL?'isLiar':(isS?'isSpy':''))+'"><span class="n">'+esc(p.n)+'</span>'+
      '<span class="r">'+(isL?'라이어':(isS?'스파이':'시민'))+'</span>'+
      '<span class="g'+(g?'':' zero')+'">'+(g?'+'+g:'0')+'</span></li>';
  }).join('');
  var sc=players.slice().sort(function(a,b){return b.sc-a.sc}).map(function(p,i){
    return '<li><span class="rk">'+(i+1)+'</span><span class="n">'+esc(p.n)+'</span><span class="p">'+p.sc+'</span></li>';
  }).join('');
  return '<div class="pan"><div class="big '+cls+'">'+T+'</div>'+
    '<p class="lead" style="text-align:center">'+D+'</p></div>'+
    '<div class="answer"><div class="k">주제 · '+esc(V.cat)+'</div><div class="w">'+esc(f.word)+'</div>'+
    (sub?'<div class="sub">'+sub+'</div>':'')+'</div>'+
    '<div class="pan"><div class="lbl">정체 공개 · 이번 판 획득</div><ul class="rlist">'+roles+'</ul>'+
    '<div class="lbl" style="margin-top:4px">방 안 누적 점수</div><ul class="score">'+sc+'</ul></div>';
}

/* ===================== 방장 페이즈 자동 전환 ===================== */
setInterval(function(){
  if(!G)return;
  if(G.ph==='reveal'&&allOk()&&playingPids().length>=MINP)toDescribe();
},400);

/* ===================== 종료 처리 ===================== */
window.addEventListener('pagehide',function(){
  if(!S.code)return;
  try{
    if(S.isHost)NET.pub(tS(),null,true);
    else NET.pub(tC(),{t:'leave',pid:S.pid});
  }catch(e){}
  try{NET.end()}catch(e){}
});

/* ===================== 진입 ===================== */
loadMe();
var entry=$('#modeOnline');
if(entry)entry.onclick=function(){
  if(!S.kpReady&&canMulti())ensureKeys().catch(noop);
  renderOnHome();
};
/* 초대 링크(#코드)로 들어오면 온라인 화면을 먼저 연다 */
if(parseCode(location.hash))setTimeout(function(){ if(entry)entry.onclick() },0);

})();
