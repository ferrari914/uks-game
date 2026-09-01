/* multi.js — 온라인 멀티 (끄투 방식: 한 방 2~8명, 순서대로 잇고 최후 1인 승리)

   방장 브라우저 권위. 판정·타이머·턴 진행·탈락 처리를 방장이 전부 하고,
   참가자는 자기 차례에 단어를 보내기만 한다. 판정을 한 곳에서 하므로
   사람마다 결과가 갈릴 수 없다. (SPEC §16)

   판정 규칙과 사전은 game.js가 노출한 window.WB_RULES 를 그대로 쓴다.
   규칙을 두 벌 만들면 싱글과 멀티의 판정이 갈라진다. */
(function(){
"use strict";

var R=null, NET=null, M=null;
var localTick=null, hostTick=null, beatTick=null, watchTick=null;

var MAXP=8, MINP=2;
var GRACE_MS=700;      /* 마감 뒤 이만큼 늦게 온 제출까지는 받아준다 (SPEC §16.2) */
var JOIN_WAIT=9000;    /* 방장 응답을 이만큼 기다린다 */
var BEAT_MS=5000;      /* 방장이 조용해도 이 간격으로 상태를 다시 알린다 */
/* ⚠ "잠깐 자리를 비움"과 "나감"은 다른 사건이다.
   브라우저는 숨은 탭의 타이머와 소켓을 조인다. 폰에서 메신저를 한 번 보고 오는 것만으로도
   수십 초가 조용해지므로, 짧은 임계값으로 자르면 **가만히 있던 사람이 방에서 쫓겨난다.**
   실제로 26초로 뒀다가 배경 탭 참가자 둘이 통째로 튕겼다.
   그래서 ①숨어 있는 동안에는 아예 판단하지 않고 ②돌아온 순간 기준을 다시 잡는다.
   (games/catchmind/game.js 의 AWAY/DROP/RETURN_GRACE 설계를 따랐다) */
var WATCH_PROMOTE=20000;  /* 방장 소식이 이만큼 없으면 브로커를 옮겨 찾기 시작한다 */
var WATCH_HOP=6000;       /* 탐색 중 한 브로커에 머무는 시간 (연결+구독+retain 수신에 필요) */
var WATCH_DEAD=50000;     /* 그래도 못 찾으면 끊긴 것으로 본다 */
var RETURN_GRACE=6000;    /* 탭으로 돌아온 뒤 방장 상태를 기다려 주는 시간 */
var CODE_CHARS='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  /* 0O1I 제외 — 받아적기 쉽게 */

function $(id){ return document.getElementById(id); }
function rid(){ return Math.random().toString(36).slice(2,9); }
/* 참가자 ID는 탭이 살아 있는 동안 고정한다.
   튕겼다가 다시 들어갈 때 ID가 바뀌면 방장이 "처음 보는 사람"으로 보고
   진행 중인 방에 못 들여보낸다 — 잠깐 딴 데 본 대가가 패배가 된다. */
var MYID=null;
function myId(){
  if(MYID) return MYID;
  try{ MYID=sessionStorage.getItem('wb_pid')||''; }catch(e){}
  if(!MYID){ MYID=rid(); try{ sessionStorage.setItem('wb_pid',MYID) }catch(e){} }
  return MYID;
}
function newCode(){
  var s='',i;
  for(i=0;i<5;i++) s+=CODE_CHARS.charAt((Math.random()*CODE_CHARS.length)|0);
  return s;
}
function topics(id){ return { st:'wb/'+id+'/st', ev:'wb/'+id+'/ev' }; }

function say(el,text,cls){ var m=$(el); if(!m)return; m.textContent=text||''; m.className='msg'+(cls?' '+cls:''); }

/* ===== 방 상태 ===== */
function blank(){
  return { code:'', tid:'', isHost:false, myId:myId(), myName:'',
           players:[], phase:'lobby', turn:null, need:[], chain:[], used:{},
           limit:0, left:0, lap:0, turnAt:0, rejK:0, lastRej:0, winner:'', closed:false,
           seq:0, lastSeq:-1 };
}
function me(){ return find(M.myId); }
function find(id){
  for(var i=0;i<M.players.length;i++) if(M.players[i].id===id) return M.players[i];
  return null;
}
function alive(){
  var a=[],i;
  for(i=0;i<M.players.length;i++) if(M.players[i].alive) a.push(M.players[i]);
  return a;
}

/* ===== 방장: 상태 브로드캐스트 =====
   참가자는 이 상태만 보고 화면을 그린다. retain 이라 늦게 들어와도 즉시 받는다. */
function pubState(full){
  if(!M || !M.isHost || M.closed) return;
  var pl=[],i;
  for(i=0;i<M.players.length;i++){
    var p=M.players[i];
    pl.push({ i:p.id, n:p.name, h:Math.max(0,p.hp), s:p.score, a:p.alive?1:0 });
  }
  var ch = full ? M.chain : M.chain.slice(-14);
  /* q = 발행 일련번호.
     브로커는 마지막 상태를 retain 해 두므로, 참가자가 브로커를 옮길 때마다
     **죽은 방장의 낡은 상태가 다시 배달된다.** 그걸 생존 신호로 받아들이면
     방장이 죽어도 영영 눈치채지 못한다.
     그래서 "메시지를 받았다"가 아니라 "**번호가 늘었다**"를 생존의 근거로 삼는다. */
  M.seq=(M.seq||0)+1;
  var msg={ v:1, q:M.seq, ph:M.phase, pl:pl, tn:M.turn, nd:M.need, ch:ch,
            lm:M.limit, lf:leftSec(), wn:M.winner, k:M.rejK, rj:M.rej||null };
  NET.pub(topics(M.tid).st, msg, true);
}
/* 방장이 조용한 동안에도 살아 있음을 알린다.
   이게 없으면 참가자 쪽 감시 장치가 "조용한 대기실"을 끊김으로 오해한다. */
function startBeat(){
  if(beatTick) clearInterval(beatTick);
  beatTick=setInterval(function(){
    if(!M || !M.isHost || M.closed){ clearInterval(beatTick); beatTick=null; return; }
    pubState();
  }, BEAT_MS);
}

function leftSec(){
  if(M.phase!=='play' || !M.turnAt) return 0;
  return Math.max(0,(M.turnAt - Date.now())/1000);
}

/* ===== 방장: 게임 진행 ===== */
function hostStart(){
  if(!M.isHost || M.phase!=='lobby') return;
  if(M.players.length<MINP){ say('lobbyMsg','2명 이상이어야 시작할 수 있습니다','err'); return; }
  var seed=R.seedWord();
  M.phase='play'; M.used={}; M.chain=[]; M.lap=0; M.winner='';
  M.used[seed]=1;
  M.chain.push([seed,0,'',R.mean(seed)]);
  M.need=R.needFrom(seed);
  var i;
  for(i=0;i<M.players.length;i++){
    M.players[i].hp=R.TUNE.HP; M.players[i].score=0; M.players[i].alive=true;
  }
  M.turn=M.players[0].id;
  beginHostTurn(true);
}

function turnLimit(){
  return Math.max(R.TUNE.TURN_MIN, R.TUNE.TURN_SEC - M.lap);   /* 한 바퀴마다 1초 (SPEC §15.1) */
}

function beginHostTurn(){
  M.limit=turnLimit();
  M.turnAt=Date.now()+M.limit*1000;
  pubState();
  paint();
  if(hostTick) clearInterval(hostTick);
  hostTick=setInterval(function(){
    if(M.phase!=='play'){ clearInterval(hostTick); hostTick=null; return; }
    if(Date.now() > M.turnAt + GRACE_MS){ hostTimeout(); }
  },120);
}

function hostTimeout(){
  var p=find(M.turn); if(!p) return;
  p.hp-=R.TUNE.SELF_TIMEOUT;
  M.chain.push(['',-R.TUNE.SELF_TIMEOUT,p.name,'시간 초과']);
  if(p.hp<=0){ p.hp=0; p.alive=false; }
  advance();
}

function hostAccept(p, word){
  var dmg=R.damage(word, leftSec()/M.limit);   /* 멀티에서는 공격이 아니라 점수다 (SPEC §15) */
  p.score+=dmg;
  M.used[word]=1;
  M.chain.push([word,dmg,p.name,R.mean(word)]);
  M.need=R.needFrom(word);
  advance();
}

function advance(){
  var liv=alive();
  if(liv.length<=1){
    M.phase='over'; M.turn=null;
    M.winner=liv.length?liv[0].name:'';
    if(hostTick){ clearInterval(hostTick); hostTick=null; }
    pubState(true); paint();
    return;
  }
  /* 다음 생존자로. 처음 참가 순서를 유지한 채 죽은 사람만 건너뛴다. */
  var idx=0,i;
  for(i=0;i<M.players.length;i++) if(M.players[i].id===M.turn){ idx=i; break; }
  var n=M.players.length, k;
  for(k=1;k<=n;k++){
    var q=M.players[(idx+k)%n];
    if(q.alive){
      if((idx+k)>=n) M.lap++;        /* 한 바퀴 돌았다 */
      M.turn=q.id; break;
    }
  }
  beginHostTurn();
}

/* ===== 방장: 참가자 이벤트 처리 ===== */
function onEvent(ev){
  if(!M.isHost || !ev || !ev.t) return;

  if(ev.t==='j'){
    if(find(ev.i)) { pubState(); return; }              /* 재전송 — 상태만 다시 준다 */
    if(M.phase!=='lobby'){ pubState(); return; }        /* 시작 뒤에는 받지 않는다 */
    if(M.players.length>=MAXP){ pubState(); return; }
    M.players.push({ id:ev.i, name:String(ev.n||'기사').slice(0,8), hp:R.TUNE.HP, score:0, alive:true });
    pubState(); paint();
    return;
  }
  if(ev.t==='l'){
    var i;
    for(i=0;i<M.players.length;i++) if(M.players[i].id===ev.i){
      var was=(M.turn===ev.i);
      M.players.splice(i,1);
      if(M.phase==='play'){
        if(alive().length<=1){ advance(); return; }
        if(was){ M.turn=M.players[i%M.players.length].id; beginHostTurn(); return; }
      }
      pubState(); paint(); return;
    }
    return;
  }
  if(ev.t==='w'){
    if(M.phase!=='play' || ev.i!==M.turn) return;
    if(Date.now() > M.turnAt + GRACE_MS) return;        /* 유예까지 넘긴 제출은 버린다 */
    var p=find(ev.i); if(!p||!p.alive) return;
    var w=String(ev.w||'').trim().toLowerCase();
    var bad=R.judge(w, M.need, M.used);
    if(bad){ reject(ev.i, bad); return; }               /* 시간이 남았으면 다시 낼 수 있다 */
    hostAccept(p, w);
  }
}

function reject(pid, msg){
  M.rejK++; M.rej={ i:pid, m:msg, k:M.rejK };
  pubState();
  if(pid===M.myId) say('mMsg', msg+' · 다시 입력하세요','err');
}

/* ===== 참가자: 상태 수신 ===== */
function onState(st){
  if(!st || st.v!==1) return;
  if(st.ph==='closed'){ if(M) closed('방장이 나갔습니다'); return; }
  if(!M || M.isHost) return;      /* 방을 나간 뒤 늦게 도착한 상태는 버린다 */                                   /* 방장은 자기 상태가 진실이다 */

  M.phase=st.ph; M.turn=st.tn; M.need=st.nd||[]; M.chain=st.ch||[];
  M.limit=st.lm||0; M.winner=st.wn||'';
  M.players=[];
  var i;
  for(i=0;i<(st.pl||[]).length;i++){
    var q=st.pl[i];
    M.players.push({ id:q.i, name:q.n, hp:q.h, score:q.s, alive:!!q.a });
  }
  /* 거부 통지 — 나에게 온 새 것만 한 번 보여준다 */
  if(st.rj && st.rj.i===M.myId && st.k>M.lastRej){
    M.lastRej=st.k; say('mMsg', st.rj.m+' · 다시 입력하세요','err');
  }
  /* 번호가 늘었을 때만 "방장이 살아 있다"로 본다.
     같은 번호가 다시 오는 것은 브로커에 남아 있던 낡은 상태일 뿐이다.
     "다르다"가 아니라 "크다"여야 한다 — 방장이 살아 있는 동안 브로커를 옮겼다면
     브로커마다 서로 다른 낡은 상태가 남는다(A에 q=40, B에 q=95). 목록을 반복해
     훑으면 40, 95, 40, 95 … 가 번갈아 오고, "다르다"로 보면 전부 생존 신호가 되어
     죽은 방장을 영영 감지하지 못한다. */
  if(typeof st.q==='number' && st.q>M.lastSeq){
    M.lastSeq=st.q; M.seenAt=Date.now(); M.hopAt=0;
  }
  M.left=st.lf||0;
  runLocalTimer();
  paint();
}

/* 방장이 탭을 그냥 닫으면 '방장이 나갔습니다'가 못 나간다 —
   암호화가 비동기라 페이지가 사라지는 순간에 발행을 끝낼 수 없다.
   그래서 참가자 쪽에서 방장의 침묵을 직접 감시한다. 이쪽이 훨씬 튼튼하다:
   탭 닫힘·브라우저 종료·네트워크 끊김을 전부 같은 방식으로 잡는다. */
function startWatch(){
  if(watchTick) clearInterval(watchTick);
  M.seenAt=Date.now(); M.hopAt=0;
  watchTick=setInterval(function(){
    if(!M || M.isHost){ clearInterval(watchTick); watchTick=null; return; }
    /* 숨어 있는 동안 흐른 침묵은 판정 근거가 못 된다 — 브라우저가 조인 것뿐이다. */
    if(document.hidden) return;
    var now=Date.now(), gap=now-M.seenAt;
    if(gap>WATCH_DEAD){ clearInterval(watchTick); watchTick=null; closed('방장과 연결이 끊겼습니다'); return; }
    /* ⚠ 한 번만 옮겨보고 포기하면 안 된다.
       연결이 한 번 끊기면 방장과 참가자가 **각자 다른 브로커로 흩어진다.**
       실제로 방장이 emqx, 참가자가 hivemq에 앉아 서로를 못 보는 상황을 재현했다.
       그래서 목록을 여러 번 훑는다 — 캐치마인드의 HOP_MS/BROKER_HOPS와 같은 방식이다. */
    if(gap>WATCH_PROMOTE && (now-M.hopAt)>WATCH_HOP){
      M.hopAt=now;
      try{ NET && NET.promote() }catch(e){}
    }
  }, 2000);
}

/* 참가자 화면의 타이머는 표시용이다. 판정은 방장이 한다. */
function runLocalTimer(){
  if(localTick){ clearInterval(localTick); localTick=null; }
  if(M.phase!=='play') return;
  var end=Date.now()+M.left*1000;
  paintTimer(M.left);
  localTick=setInterval(function(){
    var l=Math.max(0,(end-Date.now())/1000);
    paintTimer(l);
    if(l<=0){ clearInterval(localTick); localTick=null; }
  },100);
}
function paintTimer(l){
  var t=$('mTimer'); if(!t)return;
  t.textContent=Math.ceil(l);
  t.className='timer'+(l<=3?' crit':(l<=6?' warn':''));
}

/* ===== 화면 ===== */
function paint(){
  if(M.phase==='lobby'){ paintLobby(); R.show('lobby'); return; }
  if(M.phase==='play'){ paintBattle(); R.show('mbattle'); return; }
  if(M.phase==='over'){ paintOver(); R.show('mresult'); return; }
}

function rowHTML(p, isTurn){
  var cls='prow'+(isTurn?' turn':'')+(p.alive?'':' dead')+(p.id===M.myId?' me':'');
  return '<div class="'+cls+'">'+
    (isTurn?'<span class="crown">▶</span>':'')+
    '<span class="pn">'+esc(p.name)+'</span>'+
    '<span class="phb"><span class="phf" style="width:'+Math.max(0,p.hp)+'%"></span></span>'+
    '<span class="pv">'+(p.alive?p.hp:'탈락')+' · '+p.score+'점</span></div>';
}
function esc(s){
  return String(s).replace(/[&<>"]/g,function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];
  });
}

function paintLobby(){
  $('roomCode').textContent=M.code;
  $('lobbyCnt').textContent=M.players.length;
  var h='',i;
  for(i=0;i<M.players.length;i++){
    var p=M.players[i];
    h+='<div class="prow'+(p.id===M.myId?' me':'')+'"><span class="pn">'+esc(p.name)+'</span>'+
       '<span class="pv">'+(i===0?'방장':'참가')+'</span></div>';
  }
  $('lobbyList').innerHTML=h;
  $('startGame').hidden=!M.isHost;
  $('startGame').disabled=(M.players.length<MINP);
  $('lobbySub').textContent = M.isHost
    ? (M.players.length<MINP?'한 명 더 들어오면 시작할 수 있습니다':'준비되면 시작하세요')
    : '방장이 시작하기를 기다리는 중';
}

function paintBattle(){
  var h='',i;
  for(i=0;i<M.players.length;i++) h+=rowHTML(M.players[i], M.players[i].id===M.turn);
  $('mPlayers').innerHTML=h;

  var c='';
  for(i=0;i<M.chain.length;i++){
    var e=M.chain[i], w=e[0], sc=e[1], who=e[2], ko=e[3];
    if(!w){ c+='<div class="mv sys">'+esc(who)+' — '+esc(ko)+' ('+sc+')</div>'; continue; }
    var mine=(who===(me()?me().name:''));
    c+='<div class="mv '+(mine?'me':'ai')+'"><span class="w">'+esc(w)+'</span>'+
       (ko?'<span class="ko">'+esc(ko)+'</span>':'')+
       (sc?'<span class="d">+'+sc+'</span>':'')+
       (who?'<span class="ko">'+esc(who)+'</span>':'')+'</div>';
  }
  var cd=$('mChain'); cd.innerHTML=c; cd.scrollTop=cd.scrollHeight;

  var nd='';
  if(M.need.length){
    nd='<span class="letter">'+M.need[0]+'</span>';
    if(M.need.length>1) nd+='<span class="badge">⚡ 구제</span><span class="letter alt">'+M.need[1]+'</span>';
    nd+='<span>(으)로 시작</span>';
  }
  $('mNeed').innerHTML=nd;

  var t=find(M.turn), my=(M.turn===M.myId), amAlive=(me()&&me().alive);
  $('mWhose').innerHTML = my ? '내 차례입니다'
      : (t? '<b>'+esc(t.name)+'</b>'+R.josa(t.name,'이','가').slice(t.name.length)+' 차례' : '');
  $('mWhose').className='whose'+(my?' mine':'');
  $('mWord').disabled=!(my&&amAlive);
  $('mSubmit').disabled=!(my&&amAlive);
  if(my&&amAlive){ try{ $('mWord').focus() }catch(e){} }
  if(!amAlive) say('mMsg','탈락했습니다 — 남은 대결을 지켜봅니다','');
}

function paintOver(){
  var win=(M.winner && me() && M.winner===me().name);
  $('mVerdict').textContent = win?'승리':'종료';
  $('mVerdict').className='verdict '+(win?'win':'');
  $('mVerdictSub').textContent = M.winner? (M.winner+' 님이 마지막까지 남았습니다') : '남은 사람이 없습니다';

  var sorted=M.players.slice().sort(function(a,b){
    if(a.alive!==b.alive) return a.alive?-1:1;
    return b.score-a.score;
  });
  var h='',i;
  for(i=0;i<sorted.length;i++){
    h+='<div class="prow'+(sorted[i].id===M.myId?' me':'')+(sorted[i].alive?'':' dead')+'">'+
       '<span class="pn">'+(i+1)+'. '+esc(sorted[i].name)+'</span>'+
       '<span class="pv">'+sorted[i].score+'점</span></div>';
  }
  $('mRank').innerHTML=h;

  var u='';
  for(i=0;i<M.chain.length;i++){
    var e=M.chain[i]; if(!e[0]) continue;
    u+='<span class="wchip"><b>'+esc(e[0])+'</b>'+(e[3]?'<span>'+esc(e[3])+'</span>':'')+'</span>';
  }
  $('mUsed').innerHTML=u;
  $('mAgain').hidden=!M.isHost;
}

/* ===== 접속 ===== */
function connect(code, isHost){
  M=blank();
  M.code=code; M.isHost=isHost;
  M.myName=($('nick').value||'').trim().slice(0,8) || (isHost?'방장':'기사');

  if(!window.WB_NET || !window.WB_NET.cryptoOk()){
    say('netMsg','이 브라우저·주소에서는 멀티를 쓸 수 없습니다. https 주소로 열어 주세요 (싱글은 그대로 됩니다)','err');
    return;
  }
  say('netMsg','연결하는 중…','');
  NET=window.WB_NET.make();
  NET.setKey(code);
  window.WB_NET.topicId(code).then(function(tid){
    M.tid=tid;
    var T=topics(tid);
    NET.sub(T.st, onState);
    if(isHost) NET.sub(T.ev, onEvent);
    return NET.connect(function(st){
      if(st&&st.dead) say('netMsg','브로커에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요','err');
    });
  }).then(function(){
    if(isHost){
      M.players=[{ id:M.myId, name:M.myName, hp:R.TUNE.HP, score:0, alive:true }];
      M.phase='lobby'; pubState(); paint(); startBeat();
      say('netMsg','','');
    }else{
      NET.pub(topics(M.tid).ev, { t:'j', i:M.myId, n:M.myName });
      var waited=0, iv=setInterval(function(){
        waited+=500;
        if(find(M.myId)){ clearInterval(iv); say('netMsg','',''); startWatch(); return; }
        if(waited>=JOIN_WAIT){
          clearInterval(iv);
          say('netMsg','방을 찾지 못했습니다. 코드를 확인하거나, 방장이 방을 열었는지 확인해 주세요','err');
          try{ NET.end(true) }catch(e){}
          NET=null;
        } else if(waited%2500===0){
          NET.promote();                                  /* 방장이 다른 브로커에 있을 수 있다 */
          NET.pub(topics(M.tid).ev, { t:'j', i:M.myId, n:M.myName });
        }
      },500);
    }
  }).catch(function(){
    say('netMsg','연결에 실패했습니다. 잠시 뒤 다시 시도해 주세요','err');
  });
}

/* 나가기 알림은 **보내진 것을 확인한 뒤** 연결을 끊는다.
   net.js의 pub은 AES-GCM 암호화 때문에 비동기다. 곧바로 end(true)를 부르면
   암호화가 끝나기 전에 소켓이 닫혀 알림이 나가지 않는다.
   그러면 방장 쪽에 유령 참가자가 남아 게임이 끝나지 않는다 — 실제로 겪은 버그다. */
function leave(){
  if(!M) return;
  /* ⚠ 알림을 보내기 **전에** 진행 타이머부터 끊는다.
     안 끊으면 방장의 턴이 만료돼 hostTimeout → pubState 가 돌면서
     방금 보낸 '방장이 나갔습니다'를 정상 상태로 덮어쓴다 — 실제로 겪은 버그다. */
  M.closed=true;
  if(hostTick){ clearInterval(hostTick); hostTick=null; }
  if(localTick){ clearInterval(localTick); localTick=null; }
  if(beatTick){ clearInterval(beatTick); beatTick=null; }
  if(watchTick){ clearInterval(watchTick); watchTick=null; }
  var done=false;
  function finish(){ if(done)return; done=true; cleanup(true); R.show('home'); }
  var pr=null;
  try{
    if(M.isHost) pr=NET && NET.pub(topics(M.tid).st, {v:1, ph:'closed'});
    else         pr=NET && NET.pub(topics(M.tid).ev, { t:'l', i:M.myId });
  }catch(e){}
  /* pub 프라미스가 풀려도 그 시점엔 WebSocket 프레임이 아직 안 나갔을 수 있다.
     end(true)로 강제로 끊으면 그대로 사라진다 — 실제로 그래서 유령 참가자가 남았다.
     그래서 ①프라미스를 기다리고 ②잠깐 더 두고 ③정상 종료(end(false))로 흘려보낸다. */
  if(pr && pr.then) pr.then(function(){ setTimeout(finish,300) }, finish);
  setTimeout(finish, 1500);       /* 브로커가 응답이 없어도 화면은 반드시 돌려놓는다 */
}
function closed(msg){
  var code=M?M.code:'';
  cleanup();
  /* 방 코드를 입력칸에 남겨 둔다. 방장 쪽에는 아직 자리가 있으므로
     [참가]만 누르면 같은 ID로 되돌아간다. */
  if(code){ try{ $('joinCode').value=code }catch(e){} }
  say('netMsg', msg+(code?' — [참가]를 누르면 같은 방으로 다시 들어갑니다':''), 'err');
  R.show('home');
}
/* graceful=true 면 보내던 메시지를 흘려보낸 뒤 끊는다.
   나가기 알림처럼 "끊기 직전에 보낸 것"이 살아남아야 할 때 쓴다. */
function cleanup(graceful){
  if(localTick){ clearInterval(localTick); localTick=null; }
  if(hostTick){ clearInterval(hostTick); hostTick=null; }
  if(beatTick){ clearInterval(beatTick); beatTick=null; }
  if(watchTick){ clearInterval(watchTick); watchTick=null; }
  try{ NET && NET.end(!graceful) }catch(e){}
  NET=null; M=null;
}

/* ===== 내(방장 포함) 제출 ===== */
function submit(){
  if(!M || M.phase!=='play' || M.turn!==M.myId) return;
  var w=$('mWord').value.trim().toLowerCase();
  if(!w) return;
  if(M.isHost){
    var bad=R.judge(w, M.need, M.used);
    if(bad){ say('mMsg', bad+' · 다시 입력하세요','err'); $('mWord').select(); return; }
    $('mWord').value=''; say('mMsg','','');
    hostAccept(me(), w);
  }else{
    NET.pub(topics(M.tid).ev, { t:'w', i:M.myId, w:w });
    $('mWord').value='';
  }
}

/* ===== 배선 ===== */
function init(){
  R=window.WB_RULES;
  if(!R) return;

  $('mkRoom').addEventListener('click', function(){ connect(newCode(), true); });
  $('joinRoom').addEventListener('click', function(){
    var c=($('joinCode').value||'').trim().toUpperCase();
    if(c.length!==5){ say('netMsg','방 코드는 5자입니다','err'); return; }
    connect(c, false);
  });
  $('joinCode').addEventListener('keydown', function(e){ if(e.key==='Enter') $('joinRoom').click(); });

  $('roomCode').addEventListener('click', function(){
    var t=M?M.code:'';
    if(!t) return;
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(t).then(function(){ say('lobbyMsg','방 코드를 복사했습니다','ok') },
                                           function(){ say('lobbyMsg','복사에 실패했습니다 — 직접 적어 주세요','err') });
    } else say('lobbyMsg','복사를 쓸 수 없습니다 — 직접 적어 주세요','err');
  });

  $('startGame').addEventListener('click', hostStart);
  $('leaveLobby').addEventListener('click', leave);
  $('mLeave').addEventListener('click', leave);
  $('mHome').addEventListener('click', leave);
  $('mAgain').addEventListener('click', function(){
    if(!M||!M.isHost) return;
    M.phase='lobby'; M.turn=null; M.chain=[]; M.used={};
    pubState(); paint();
  });
  $('mSubmit').addEventListener('click', submit);
  $('mWord').addEventListener('keydown', function(e){ if(e.key==='Enter'){ e.preventDefault(); submit(); }});

  /* ⚠ 탭을 그냥 닫으면 암호화가 끝나기 전에 페이지가 사라져 알림이 못 나갈 수 있다.
     그 경우 방장 쪽에 유령 참가자가 남지만, 자기 차례마다 시간 초과로 체력이 깎여
     결국 탈락하므로 게임은 계속 진행된다. (알려진 한계 — SPEC §16.3) */
  /* 탭으로 돌아온 순간. 숨어 있던 동안의 침묵은 근거가 못 되니 기준을 다시 잡는다.
     단, 처음부터 다시 세면 방장이 정말 사라진 경우를 너무 늦게 알게 되므로
     RETURN_GRACE 만큼만 주고 그 안에 상태가 안 오면 브로커 탐색으로 넘어간다. */
  document.addEventListener('visibilitychange', function(){
    if(document.hidden || !M || M.isHost) return;
    /* ⚠ 기준점은 WATCH_DEAD(사망 확정)가 아니라 WATCH_PROMOTE(탐색 시작)다.
       DEAD에 걸면 "돌아왔으니 6초 뒤에 죽었다고 하자"가 되어, 탐색을 한 번밖에 못 하고
       그마저 WATCH_HOP(6초)을 못 채운 채 끊긴다. 폰은 탭을 벗어나면 WebSocket이 멈추고
       돌아와서 재연결하는 데만 몇 초가 걸리므로, 살아 있는 사람이 그대로 튕긴다.
       PROMOTE에 걸어야 "돌아왔으니 6초 뒤부터 찾아보자"가 되고,
       50초까지 남은 예산으로 목록을 다섯 번 훑는다. */
    M.seenAt=Date.now()-Math.max(0, WATCH_PROMOTE-RETURN_GRACE);
    M.hopAt=0;
  });

  window.addEventListener('beforeunload', function(){
    if(!M) return;
    try{
      if(M.isHost) NET && NET.pub(topics(M.tid).st, {v:1, ph:'closed'});
      else NET && NET.pub(topics(M.tid).ev, { t:'l', i:M.myId });
    }catch(e){}
  });
}

window.WB_MULTI={ init:init };
})();
