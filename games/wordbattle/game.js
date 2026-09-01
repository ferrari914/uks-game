/* game.js — 영어 끝말잇기 (Englknight)
   판정 · 전투 · AI · 타이머. classic script (ES 모듈·fetch 미사용 → file:// 에서 동작)
   사전: dict.js(ENABLE 168,452) + extra.js(현대어 350) + core.js(기초어 1,443 + 차단 103) */
(function(){
"use strict";

/* ===== 버전 기록 ===== */
var VERSION='1.1.0';
var CHANGELOG=[
  { v:'1.1.0', t:[
      '온라인 멀티 추가 — 한 방 2~8명, 순서대로 잇고 최후 1인이 승리',
      '방 코드 5자로 참가 · 방장 브라우저가 판정과 진행을 맡는다',
      '못 내면 체력 -15, 0이 되면 탈락하고 관전으로 넘어간다',
      '단어마다 점수가 쌓여 탈락해도 순위가 남는다',
      '멀티는 https에서만 됩니다 — 싱글은 그대로 동작합니다'
  ]},
  { v:'1.0.0', t:[
      '첫 배포 — AI 기사와의 싱글 대전 (견습·기사·검성)',
      '내장 사전 168,802단어로 판정 (ENABLE + 현대어 보강 + 기초어)',
      '구제 글자 규칙 — x·y로 끝나면 끝에서 두 번째 글자도 허용',
      '체력 대결 · 패스 1회 · 힌트 2회'
  ]}
];

/* ===== 조정용 수치 — 전부 여기 모은다 (SPEC §6.1) ===== */
var TUNE={
  HP:100,
  DMG_PER_LEN:2,      /* 단어 길이당 피해 */
  DMG_RARE:4,         /* 희귀 글자 1개당 가산 */
  DMG_TIME_MAX:10,    /* 남은 시간 비율에 곱할 최대 보너스 */
  SELF_TIMEOUT:15, SELF_PASS:10, SELF_HINT:5,
  TURN_SEC:15, TURN_MIN:7, TURN_STEP:2, TURN_EVERY:5,
  PASS_MAX:1, HINT_MAX:2,
  RARE:'jqxzv'
};
var AI={
  easy  :{ name:'견습 기사', minD:1600, maxD:3600, fail:0.12, maxLen:7,  pool:'core', killer:false },
  normal:{ name:'기사',      minD:1200, maxD:2600, fail:0.05, maxLen:11, pool:'fam',  killer:false },
  hard  :{ name:'검성',      minD: 700, maxD:1600, fail:0.00, maxLen:15, pool:'dict', killer:true  }
};

/* ===== 사전 ===== */
var WORDS=null, BLOCK=null, MEAN=null, RESCUE=null, BY1={}, CORE1={}, FAM1={};

function boot(){
  var d=window.WB_DICT, list=d.unpack();
  RESCUE={}; for(var r=0;r<d.RESCUE.length;r++) RESCUE[d.RESCUE[r]]=1;
  BLOCK={}; var bl=window.WB_CORE.BLOCK;
  for(var b=0;b<bl.length;b++) BLOCK[bl[b]]=1;
  MEAN=window.WB_CORE.MEAN;

  WORDS=new Set(list);
  var ex=window.WB_EXTRA, i;
  for(i=0;i<ex.length;i++) WORDS.add(ex[i]);
  var cw=window.WB_CORE.WORDS;
  for(i=0;i<cw.length;i++) WORDS.add(cw[i]);

  /* AI 검색용 첫 글자 색인. 차단어는 여기서 미리 제외해 AI가 절대 내지 못하게 한다.
     extra.js(현대 조어)는 색인에 넣지 않는다 — 판정은 되지만 AI는 쓰지 않는다 (SPEC §2.2.1) */
  for(i=0;i<list.length;i++){
    var w=list[i]; if(BLOCK[w]) continue;
    (BY1[w.charAt(0)] || (BY1[w.charAt(0)]=[])).push(w);
  }
  for(i=0;i<cw.length;i++){
    var c=cw[i]; if(BLOCK[c]) continue;
    (CORE1[c.charAt(0)] || (CORE1[c.charAt(0)]=[])).push(c);
  }
  buildFamiliar(cw);
}

/* 기사 난이도용 "알아볼 만한" 풀.
   기초어 전체 + 그 굴절형 중 사전에 실제로 있는 것만 모은다.
   이유: 사전 전체(16만)를 풀로 쓰면 AI가 scandias·zyzzyva 같은 스크래블 전용어를 낸다.
   규칙상 맞지만 학습자에게는 외계어라 배우는 것도 겨루는 재미도 없다.
   빈도 데이터가 없으므로 "기초어에서 파생된 말"을 알아볼 만함의 대용으로 쓴다. */
function buildFamiliar(cw){
  var seen={}, i, j;
  function add(w){
    if(w.length<3 || w.length>15 || seen[w] || BLOCK[w] || !WORDS.has(w)) return;
    seen[w]=1; (FAM1[w.charAt(0)] || (FAM1[w.charAt(0)]=[])).push(w);
  }
  for(i=0;i<cw.length;i++){
    var w=cw[i]; add(w);
    var last=w.charAt(w.length-1);
    /* 어미는 -s -ing -ed -ly 넷만 쓴다.
       -er -est -ful -ness -less 까지 넓히면 풀은 6,289개로 늘지만
       senseful·ruleless·urbanest·oftener 같은 어색한 말이 섞인다.
       AI가 내는 단어는 학습자가 알아볼 수 있어야 하므로 개수보다 품질을 택했다. */
    var cand=[w+'s', w+'ing', w+'ed', w+'ly'];
    /* 철자 규칙이 실제로 성립할 때만 어간을 바꾼다.
       무조건 끝글자를 떼면 egg→eg+est=egest 처럼 뜻이 무관한 단어가 섞인다. */
    if(last==='e'){
      var noE=w.slice(0,-1);
      cand.push(w+'d', noE+'ing');
    }
    if(last==='y'){
      var noY=w.slice(0,-1)+'i';
      cand.push(noY+'es', noY+'ed');
    }
    if('sxz'.indexOf(last)>=0 || /(ch|sh)$/.test(w)) cand.push(w+'es');
    for(j=0;j<cand.length;j++) add(cand[j]);
  }
}

/* 한글 받침 유무로 조사를 고른다. "기사이(가)" 같은 표기를 쓰지 않기 위함. */
function hasBat(name){
  var c=name.charCodeAt(name.length-1);
  if(c<0xAC00 || c>0xD7A3) return false;
  return ((c-0xAC00)%28)!==0;
}
function josa(name, withB, withoutB){ return name + (hasBat(name)?withB:withoutB); }

/* ===== 화면 조작 ===== */
function $(id){ return document.getElementById(id); }
/* 화면 전환. .screen 을 단 섹션을 전부 숨기고 하나만 보인다.
   멀티가 화면을 더 붙여도 여기를 고칠 필요가 없다. */
function show(id){
  var ss=document.querySelectorAll('section.screen');
  for(var i=0;i<ss.length;i++) ss[i].hidden = (ss[i].id!==id);
}

/* ===== 기록 (localStorage — 못 써도 게임은 그대로 돌아간다) ===== */
var REC_KEY='wb_rec_v1';
function loadRec(){
  try{ var j=localStorage.getItem(REC_KEY); if(j) return JSON.parse(j); }catch(e){}
  return {win:0,lose:0,best:0};
}
function saveRec(r){ try{ localStorage.setItem(REC_KEY, JSON.stringify(r)); }catch(e){} }
function paintRec(){
  var r=loadRec();
  $('recWin').textContent=r.win; $('recLose').textContent=r.lose; $('recBest').textContent=r.best;
}

/* ===== 판정 (SPEC §3) =====
   반환: null 이면 통과, 문자열이면 거부 사유. 사유 문구는 플레이어가 아니라
   사전을 탓하도록 쓴다 — "틀렸습니다"가 아니라 "내장 사전에 없는 단어입니다" */
function judge(w, need, used){
  if(!/^[a-z]+$/.test(w))            return '영어 알파벳만 입력하세요';
  if(w.length<3)                     return '3글자 이상이어야 합니다';
  if(w.length>15)                    return '15글자 이하여야 합니다';
  if(need.indexOf(w.charAt(0))<0)    return need.length>1
        ? "'"+need[0].toUpperCase()+"' 또는 '"+need[1].toUpperCase()+"'(으)로 시작해야 합니다"
        : "'"+need[0].toUpperCase()+"'(으)로 시작해야 합니다";
  if(used[w])                        return '이미 나온 단어입니다';
  if(BLOCK[w])                       return '이 단어는 사용할 수 없습니다';
  if(!WORDS.has(w))                  return '내장 사전에 없는 단어입니다';
  return null;
}

/* 다음에 이어야 할 글자들. 구제 글자로 끝나면 끝에서 두 번째 글자도 허용 (SPEC §4.3) */
function needFrom(word){
  var last=word.charAt(word.length-1);
  if(RESCUE[last] && word.length>=2){
    var alt=word.charAt(word.length-2);
    if(alt!==last) return [last, alt];
  }
  return [last];
}

function damage(word, ratio){
  var d=word.length*TUNE.DMG_PER_LEN;
  for(var i=0;i<word.length;i++) if(TUNE.RARE.indexOf(word.charAt(i))>=0) d+=TUNE.DMG_RARE;
  d += Math.round(Math.max(0,Math.min(1,ratio))*TUNE.DMG_TIME_MAX);
  return d;
}

/* ===== 대전 상태 ===== */
var S=null, tick=null;

function start(level){
  var cfg=AI[level];
  var seedPool=CORE1['a'].concat(CORE1['s'],CORE1['t'],CORE1['b'],CORE1['c']);
  var seed=seedPool[(Math.random()*seedPool.length)|0];
  S={
    level:level, cfg:cfg,
    hpMe:TUNE.HP, hpAi:TUNE.HP,
    used:{}, chain:[], rejected:[],
    turn:0, pass:TUNE.PASS_MAX, hint:TUNE.HINT_MAX,
    need:needFrom(seed), limit:TUNE.TURN_SEC, left:TUNE.TURN_SEC,
    over:false, myTurn:true
  };
  S.used[seed]=1; S.chain.push(seed);

  $('aiName').textContent=cfg.name;
  $('chain').innerHTML='';
  addMove('sys','시작 단어');
  addMove('ai', seed, 0);
  $('msg').textContent=''; $('msg').className='msg';
  paintHp(); paintAids();
  show('battle');
  beginTurn();
}

function addMove(who, word, dmg){
  var el=document.createElement('div');
  if(who==='sys'){ el.className='mv sys'; el.textContent=word; }
  else{
    el.className='mv '+who;
    var ko=MEAN[word]?'<span class="ko">'+MEAN[word]+'</span>':'';
    var dd=dmg?'<span class="d">-'+dmg+'</span>':'';
    el.innerHTML='<span class="w">'+word+'</span>'+ko+dd;
  }
  var c=$('chain'); c.appendChild(el); c.scrollTop=c.scrollHeight;
}

function paintHp(){
  var me=Math.max(0,S.hpMe), ai=Math.max(0,S.hpAi);
  $('hpMe').style.width=(me/TUNE.HP*100)+'%'; $('hpMeN').textContent=me;
  $('hpAi').style.width=(ai/TUNE.HP*100)+'%'; $('hpAiN').textContent=ai;
}
function paintAids(){
  $('passBtn').textContent='패스 ('+S.pass+')'; $('passBtn').disabled=(S.pass<=0||!S.myTurn);
  $('hintBtn').textContent='힌트 ('+S.hint+')'; $('hintBtn').disabled=(S.hint<=0||!S.myTurn);
}
function paintNeed(){
  var h='<span class="letter">'+S.need[0]+'</span>';
  if(S.need.length>1) h+='<span class="badge">⚡ 구제</span><span class="letter alt">'+S.need[1]+'</span>';
  h+='<span>(으)로 시작</span>';
  $('need').innerHTML=h;
}

function beginTurn(){
  if(S.over) return;
  S.myTurn=true;
  S.limit=Math.max(TUNE.TURN_MIN, TUNE.TURN_SEC - Math.floor(S.turn/TUNE.TURN_EVERY)*TUNE.TURN_STEP);
  S.left=S.limit;
  paintNeed(); paintAids();
  $('word').value=''; $('word').disabled=false; $('submit').disabled=false;
  try{ $('word').focus(); }catch(e){}
  runTimer();
}

function runTimer(){
  stopTimer();
  var end=Date.now()+S.left*1000;
  paintTimer();
  tick=setInterval(function(){
    S.left=Math.max(0,(end-Date.now())/1000);
    paintTimer();
    if(S.left<=0){ stopTimer(); timeout(); }
  },100);
}
function stopTimer(){ if(tick){ clearInterval(tick); tick=null; } }
function paintTimer(){
  var t=$('timer'); t.textContent=Math.ceil(S.left);
  t.className='timer'+(S.left<=3?' crit':(S.left<=6?' warn':''));
}

function lockInput(){
  S.myTurn=false; stopTimer();
  $('word').disabled=true; $('submit').disabled=true;
  $('passBtn').disabled=true; $('hintBtn').disabled=true;
}

function say(text, cls){
  var m=$('msg'); m.textContent=text; m.className='msg'+(cls?' '+cls:'');
}

/* ===== 플레이어 제출 ===== */
function submit(){
  if(!S || S.over || !S.myTurn) return;
  var w=$('word').value.trim().toLowerCase();
  if(!w) return;
  var bad=judge(w, S.need, S.used);
  if(bad){
    /* 거부는 곧 실패가 아니다 — 시간이 남아 있으면 다시 낼 수 있다 (SPEC §2.4) */
    if(bad==='내장 사전에 없는 단어입니다' && S.rejected.indexOf(w)<0) S.rejected.push(w);
    say(bad+' · 다시 입력하세요','err');
    $('word').select();
    return;
  }
  var dmg=damage(w, S.left/S.limit);
  S.hpAi-=dmg; S.used[w]=1; S.chain.push(w);
  addMove('me', w, dmg);
  say('','');
  $('word').value='';
  lockInput(); paintHp();
  if(S.hpAi<=0){ finish(true); return; }
  S.need=needFrom(w); S.turn++;
  paintNeed();
  setTimeout(aiTurn, 320);
}

function timeout(){
  if(S.over || !S.myTurn) return;
  lockInput();
  S.hpMe-=TUNE.SELF_TIMEOUT; paintHp();
  addMove('sys','시간 초과 — 내 체력 '+TUNE.SELF_TIMEOUT+' 감소');
  if(S.hpMe<=0){ finish(false); return; }
  S.turn++;
  setTimeout(aiTurn, 320);
}

function doPass(){
  if(!S || S.over || !S.myTurn || S.pass<=0) return;
  S.pass--; lockInput(); paintAids();
  S.hpMe-=TUNE.SELF_PASS; paintHp();
  addMove('sys','패스 — 체력 '+TUNE.SELF_PASS+' 감소, 같은 글자로 넘김');
  if(S.hpMe<=0){ finish(false); return; }
  S.turn++;
  setTimeout(aiTurn, 320);
}

function doHint(){
  if(!S || S.over || !S.myTurn || S.hint<=0) return;
  var w=pick(CORE1, S.need, 15, false) || pick(FAM1, S.need, 12, false) || pick(BY1, S.need, 9, false);
  if(!w){ say('힌트로 줄 단어를 찾지 못했습니다','err'); return; }
  S.hint--; S.hpMe-=TUNE.SELF_HINT; paintHp(); paintAids();
  say('힌트: '+w.slice(0,2).toUpperCase()+'… ('+w.length+'글자'+(MEAN[w]?', '+MEAN[w]:'')+')','ok');
  if(S.hpMe<=0){ lockInput(); finish(false); }
}

/* ===== AI =====
   무작위 표본을 뽑아 조건에 맞는 것을 고른다. 전수 탐색은 16만 개라 느리고 불필요하다. */
function pick(index, need, maxLen, killer){
  var pool=[], i;
  for(i=0;i<need.length;i++){ var a=index[need[i]]; if(a) pool=pool.length?pool.concat(a):a; }
  if(!pool.length) return null;
  var best=null;
  for(i=0;i<400;i++){
    var w=pool[(Math.random()*pool.length)|0];
    if(w.length<3 || w.length>maxLen) continue;
    if(S.used[w] || BLOCK[w]) continue;
    if(killer && RESCUE[w.charAt(w.length-1)]) return w;   /* 막다른 글자로 끝내 몰아붙인다 */
    if(!best || w.length>best.length) best=w;
    if(!killer && best.length>=5) return best;
  }
  if(best) return best;
  for(i=0;i<pool.length;i++){                              /* 표본으로 못 찾으면 전수 탐색 */
    var v=pool[i];
    if(v.length>=3 && v.length<=maxLen && !S.used[v] && !BLOCK[v]) return v;
  }
  return null;
}

function aiTurn(){
  if(S.over) return;
  var cfg=S.cfg;
  var delay=cfg.minD + Math.random()*(cfg.maxD-cfg.minD);
  $('need').innerHTML='<span>'+josa(cfg.name,'이','가')+' 생각하는 중…</span>';
  setTimeout(function(){
    if(S.over) return;
    var w=null;
    if(Math.random()>=cfg.fail){
      var idx=(cfg.pool==='core')?CORE1:(cfg.pool==='fam'?FAM1:BY1);
      w=pick(idx, S.need, cfg.maxLen, cfg.killer);
      if(!w && cfg.pool!=='dict') w=pick(BY1, S.need, 8, false);   /* 좁은 풀이 마르면 사전으로 */
    }
    if(!w){
      S.hpAi-=TUNE.SELF_TIMEOUT; paintHp();
      addMove('sys', josa(cfg.name,'이','가')+' 답하지 못했다 — 체력 '+TUNE.SELF_TIMEOUT+' 감소');
      if(S.hpAi<=0){ finish(true); return; }
      S.turn++; beginTurn(); return;
    }
    var dmg=damage(w, 0.5);
    S.hpMe-=dmg; S.used[w]=1; S.chain.push(w);
    addMove('ai', w, dmg);
    paintHp();
    if(S.hpMe<=0){ finish(false); return; }
    S.need=needFrom(w); S.turn++;
    beginTurn();
  }, delay);
}

/* ===== 결과 ===== */
function finish(win){
  S.over=true; lockInput();
  var r=loadRec();
  if(win) r.win++; else r.lose++;
  if(S.chain.length>r.best) r.best=S.chain.length;
  saveRec(r);

  $('verdict').textContent = win?'승리':'패배';
  $('verdict').className='verdict '+(win?'win':'lose');
  $('verdictSub').textContent =
    (win?josa(S.cfg.name,'을','를')+' 쓰러뜨렸다':S.cfg.name+'에게 무너졌다')+
    ' · 단어 '+S.chain.length+'개 · 남은 체력 '+Math.max(0,win?S.hpMe:S.hpAi);

  var ul=$('usedList'); ul.innerHTML='';
  for(var i=0;i<S.chain.length;i++){
    var w=S.chain[i], el=document.createElement('span');
    el.className='wchip';
    el.innerHTML='<b>'+w+'</b>'+(MEAN[w]?'<span>'+MEAN[w]+'</span>':'');
    ul.appendChild(el);
  }
  var rc=$('rejCard');
  $('copyRej').textContent='목록 복사';   /* 지난 판의 결과 문구가 남지 않게 되돌린다 */
  if(S.rejected.length){
    rc.hidden=false;
    var rl=$('rejList'); rl.innerHTML='';
    for(var j=0;j<S.rejected.length;j++){
      var e2=document.createElement('span'); e2.className='wchip';
      e2.innerHTML='<b>'+S.rejected[j]+'</b>'; rl.appendChild(e2);
    }
  } else rc.hidden=true;
  show('result');
}

/* ===== 버전 기록 ===== */
function openVer(){
  var h='';
  for(var i=0;i<CHANGELOG.length;i++){
    var c=CHANGELOG[i], li='';
    for(var j=0;j<c.t.length;j++) li+='<li>'+c.t[j]+'</li>';
    h+='<div class="log"><div class="v">v'+c.v+'</div><ul>'+li+'</ul></div>';
  }
  $('verLog').innerHTML=h;
  $('verModal').hidden=false;
}

/* ===== 배선 ===== */
function wire(){
  var ds=document.querySelectorAll('.diff');
  for(var i=0;i<ds.length;i++)(function(b){
    b.addEventListener('click',function(){ start(b.getAttribute('data-d')); });
  })(ds[i]);

  $('submit').addEventListener('click', submit);
  $('word').addEventListener('keydown', function(e){ if(e.key==='Enter'){ e.preventDefault(); submit(); }});
  $('passBtn').addEventListener('click', doPass);
  $('hintBtn').addEventListener('click', doHint);

  $('again').addEventListener('click', function(){ start(S.level); });
  $('toHome').addEventListener('click', function(){ stopTimer(); paintRec(); show('home'); });
  $('copyRej').addEventListener('click', function(){
    var t=S.rejected.join(', ');
    /* file:// 은 보안 컨텍스트가 아니라 navigator.clipboard 가 없거나 비동기로 거부된다.
       거부를 잡지 않으면 실패했는데도 "복사했습니다"가 뜨므로 반드시 폴백까지 확인한다. */
    function fallback(){
      try{
        var ta=document.createElement('textarea');
        ta.value=t; ta.setAttribute('readonly','');
        ta.style.position='fixed'; ta.style.left='-9999px';
        document.body.appendChild(ta); ta.select();
        var ok=document.execCommand('copy');
        document.body.removeChild(ta);
        $('copyRej').textContent = ok ? '복사했습니다' : '복사에 실패했습니다 — 직접 선택해 주세요';
      }catch(e){ $('copyRej').textContent='복사에 실패했습니다 — 직접 선택해 주세요'; }
    }
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(t).then(function(){
        $('copyRej').textContent='복사했습니다';
      }, fallback);
    } else fallback();
  });

  $('verBtn').textContent='v'+VERSION;
  $('verBtn').addEventListener('click', openVer);
  $('verClose').addEventListener('click', function(){ $('verModal').hidden=true; });
  $('verModal').addEventListener('click', function(e){ if(e.target===$('verModal')) $('verModal').hidden=true; });
  document.addEventListener('keydown', function(e){ if(e.key==='Escape') $('verModal').hidden=true; });
}

/* ===== 시작 ===== */
function init(){
  boot(); wire(); paintRec();
  /* 멀티(multi.js)가 같은 사전·같은 규칙을 쓰도록 노출한다.
     규칙을 두 벌 만들면 싱글과 멀티의 판정이 갈라진다. */
  window.WB_RULES={
    TUNE:TUNE, VERSION:VERSION,
    has:function(w){ return WORDS.has(w) },
    blocked:function(w){ return !!BLOCK[w] },
    mean:function(w){ return MEAN[w]||'' },
    judge:judge, needFrom:needFrom, damage:damage,
    seedWord:function(){
      var pool=CORE1['a'].concat(CORE1['s'],CORE1['t'],CORE1['b'],CORE1['c']);
      return pool[(Math.random()*pool.length)|0];
    },
    show:show, $:$, josa:josa, openVer:openVer
  };
  if(window.WB_MULTI && window.WB_MULTI.init) window.WB_MULTI.init();
  $('loading').hidden=true;
  show('home');
}
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', init);
else init();
})();
