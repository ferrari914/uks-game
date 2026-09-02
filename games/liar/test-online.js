/* =========================================================================
   라이어 온라인 모드 — 자동 진행 시험 스크립트
   games/liar/test-online.js

   [왜 있나] 온라인 모드는 최소 3명이라 사람이 탭 세 개를 손으로 모는 것이
   사실상 불가능하다. 각 탭 콘솔에 이 파일을 붙여넣고 AUTO() 를 돌리면
   한 판이 자동으로 진행된다. 회귀 시험 때 재사용한다.
   (선례: games/duel/test-renju.js)

   [쓰는 법] 탭마다 이 파일을 콘솔에 붙여넣은 뒤
     await AUTO('라이어로 지목할 이름', 60)   // 60초 동안 자동 진행
     H.info()    현재 단계·화면·연결 상태·수집된 오류
     H.card()    내 카드 펼쳐 보기

   ⚠ 브라우저 패널이 접혀 있으면 탭이 hidden 이 되어 타이머가 조여진다.
      그러면 MQTT keepalive 가 밀려 방장 연결이 끊기고 판이 멈춘다 —
      게임 결함이 아니라 시험 환경 문제다. 판을 끝까지 돌리려면 창을
      실제로 띄워 두거나 실기기를 쓸 것.
      (같은 IP 다중 접속은 원인이 아니다 — 8개 동시 연결을 3회 반복해
       전부 성공하는 것을 게임 관리자가 실측했다.)
   ========================================================================= */

window.__ERR=[];
window.addEventListener('error',function(e){window.__ERR.push(String(e.message))});
window.AUTO=async function(liarName,secs){
  var log=[],t0=Date.now();
  while(Date.now()-t0<secs*1000){
    var ok=document.getElementById('oOk'); if(ok&&!ok.disabled){ok.click();log.push('ok')}
    var say=document.getElementById('oSay');
    if(say){say.value='설명'+Math.floor(Math.random()*90+10);document.getElementById('oSend').click();log.push('say')}
    var bs=[].slice.call(document.querySelectorAll('#ogAct .votebox .pick'));
    if(bs.length){
      var b=bs.filter(function(x){return x.textContent.trim()===liarName})[0]||bs[0];
      b.click();
      var v=document.getElementById('oVote');
      if(v&&!v.disabled){v.click();log.push('vote>'+b.textContent.trim())}
    }
    var gb=document.querySelector('#ogAct .guessbox .opt');
    if(gb){gb.click();var g=document.getElementById('oGuess');if(g&&!g.disabled){g.click();log.push('guess')}}
    var tv=document.getElementById('oToVote'); if(tv){tv.click();log.push('toVote')}
    var nx=document.getElementById('oNext'); if(nx){nx.click();log.push('next')}
    await new Promise(r=>setTimeout(r,700));
  }
  return log.join(',');
};
window.H={
  info:function(){return {ph:document.getElementById('phaseName').textContent,
    top:document.getElementById('ogTop').textContent,
    act:document.getElementById('ogAct').textContent.slice(0,400),
    chat:document.getElementById('ogChat').textContent.slice(-400),
    on:window.__LRNET.info().on,err:window.__ERR}},
  card:function(){var b=document.getElementById('ogCardBtn');
    if(b&&document.getElementById('ogCard').textContent.indexOf('접기')<0)b.click();
    return document.getElementById('ogCard').textContent}
};
'ready'
