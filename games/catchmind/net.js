/* =========================================================================
   캐치마인드 — 통신 계층 (net.js)
   OX 서바이벌의 makeMqttNet 패턴을 따르되, 브로커 폴백을 고쳤다.

   · 공용 MQTT 브로커(WebSocket) 3중 폴백 — **최초 연결뿐 아니라 연결 후 절단에도 동작한다.**
       공용 브로커는 IP당 연결 제한·주기적 강제 절단이 흔하다. mqtt.js의
       reconnectPeriod는 "같은 브로커"만 무한 재시도하므로, 한 번 그 브로커에
       거부당하면 영원히 못 붙는다. 그래서 재접속이 STALL_MS 안에 안 돌아오면
       현재 클라이언트를 버리고 **다음 브로커로 승격**한다(subs 전부 재구독).
       목록은 순환하고, MAX_ROUNDS 바퀴를 돌고도 실패하면 포기하고 알린다.
   · mqtt.js CDN 2중 폴백 (unpkg → jsdelivr)
   · 방 코드 하나로 토픽 ID와 암호화 키를 각각 유도한다 (솔트가 다르다).
     토픽에는 방 코드가 나타나지 않으므로, ekcm/# 와일드카드로 엿보는 제3자는
     의미 없는 hex 토픽과 암호문만 본다. 방 코드를 아는 친구는 그냥 들어온다.
   · 모든 페이로드를 그 키로 AES-GCM 암복호화한다 (SPEC 9항)
       - 암복호화는 이 파일 안에서만 일어난다. game.js는 평범한 객체만 주고받는다.
       - 반복키 XOR은 쓰지 않는다. JSON 앞머리가 사실상 고정이라 알려진 평문 공격에
         바로 뚫려서 난독화 효과가 없다.
       - Web Crypto는 브라우저 내장이라 라이브러리·CDN이 늘지 않는다.
       - crypto.subtle은 보안 컨텍스트(HTTPS)에서만 동작한다. 어차피 wss:// 때문에
         HTTPS가 전제이므로 폴백을 만들지 않는다.
       - 복호화 실패는 throw하지 않고 조용히 버린다 → 남의 방 메시지가 자동으로 걸러진다.
   · ⚠ crypto.subtle은 전부 async라, 그냥 호출하면 스트로크 순서가 뒤집힌다.
     발행(pubQ)·수신(recvQ) 각각에 프라미스 체인 큐를 둬서 직렬화한다.
   · 한계: 방 코드를 아는 사람은 당연히 다 읽는다. 이 암호화가 막는 것은
     방 코드를 모르는 제3자의 브로커 도청뿐이다. 코드가 5자라 오프라인
     무차별 대입은 이론상 가능하다(PBKDF2 반복이 비용을 올린다). (README 12-b 참고)
   ========================================================================= */
(function(){
"use strict";

/* ===== 브로커 · CDN ===== */
var BROKERS=[
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt'
];
var MQTT_CDN=[
  'https://unpkg.com/mqtt@5.14.1/dist/mqtt.min.js',
  'https://cdn.jsdelivr.net/npm/mqtt@5.14.1/dist/mqtt.min.js'
];
var CONNECT_MS=8000;    // 한 브로커에 붙어보는 시간
var STALL_MS=12000;     // 붙어 있다가 끊긴 뒤 이만큼 안 돌아오면 다음 브로커로 승격
var MAX_ROUNDS=3;       // 브로커 목록을 이만큼 돌고도 실패하면 포기

/* ===== Web Crypto ===== */
var SUB=(window.crypto&&window.crypto.subtle)?window.crypto.subtle:null;
/* 방 코드 하나에서 서로 다른 두 값을 뽑는다. 솔트를 달리해 서로를 역산할 수 없게 한다.
   - 토픽 ID: 브로커에 그대로 노출되는 값. 방 코드가 토픽에 나타나면 안 된다.
   - 암호화 키: 페이로드를 여는 값.
   토픽 ID만 보고 방 코드를 되돌릴 수 없고, 따라서 키도 만들 수 없다. */
var SALT_TOPIC='ekcm-v2-topic-salt';
var SALT_KEY='ekcm-v2-key-salt';
/* 방 코드는 5자(약 3,300만 조합)라 오프라인 무차별 대입이 이론상 가능하다.
   반복 횟수가 그 비용을 그대로 곱해 준다. 방 입장 때 한 번만 계산한다. */
var ITER=250000;
var IV_LEN=12;

function cryptoOk(){ return !!SUB }

/* 방 코드 → 토픽 ID (SHA-256 앞 16 hex자). 토픽에는 이 값만 쓴다. */
function topicId(code){
  if(!SUB)return Promise.reject(new Error('no-subtle'));
  return SUB.digest('SHA-256',u8(String(code||'').toUpperCase()+SALT_TOPIC)).then(function(buf){
    var a=new Uint8Array(buf),h='',i;
    for(i=0;i<8;i++)h+=('0'+a[i].toString(16)).slice(-2);
    return h;                                  // 8바이트 = 16 hex자
  });
}

function u8(s){
  if(window.TextEncoder)return new TextEncoder().encode(s);
  var e=unescape(encodeURIComponent(s)),a=new Uint8Array(e.length),i;
  for(i=0;i<e.length;i++)a[i]=e.charCodeAt(i);
  return a;
}
function fromU8(a){
  if(window.TextDecoder)return new TextDecoder('utf-8',{fatal:true}).decode(a);
  var s='',i;
  for(i=0;i<a.length;i++)s+=String.fromCharCode(a[i]);
  return decodeURIComponent(escape(s));
}
function b64(a){
  var s='',i,CH=0x8000;
  for(i=0;i<a.length;i+=CH)s+=String.fromCharCode.apply(null,a.subarray(i,i+CH));
  return btoa(s);
}
function unb64(s){
  var bin=atob(s),a=new Uint8Array(bin.length),i;
  for(i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i);
  return a;
}
/* 방 코드 → AES-GCM 256비트 키 (토픽 ID와는 다른 솔트를 쓴다) */
function deriveKey(code){
  if(!SUB)return Promise.reject(new Error('no-subtle'));
  return SUB.importKey('raw',u8(String(code||'').toUpperCase()),{name:'PBKDF2'},false,['deriveKey'])
    .then(function(base){
      return SUB.deriveKey(
        {name:'PBKDF2',salt:u8(SALT_KEY),iterations:ITER,hash:'SHA-256'},
        base,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
    });
}

/* ===== 네트워크 객체 ===== */
function makeMqttNet(){
  var cl=null, subs={};
  var bi=0;                            // 다음에 시도할 브로커 인덱스 (순환한다)
  var rounds=0;                        // 목록을 몇 바퀴 연속 실패했는지
  var dead=false;                      // 전부 소진 → 포기 상태
  var stallTimer=null, curUrl='';
  var firstRes=null, firstRej=null;    // connect()가 돌려준 프라미스
  var onNet=function(){};
  var keyP=null;                       // AES 키 프라미스
  var pubQ=Promise.resolve();          // 발행 직렬화 큐
  var recvQ=Promise.resolve();         // 수신 직렬화 큐
  function noop(){}
  function online(){ return !!(cl&&cl.connected) }

  function encrypt(obj){
    if(!keyP)return Promise.reject(new Error('no-key'));
    var plain=u8(JSON.stringify(obj));
    var iv=window.crypto.getRandomValues(new Uint8Array(IV_LEN));
    return keyP.then(function(k){
      return SUB.encrypt({name:'AES-GCM',iv:iv},k,plain);
    }).then(function(ct){
      var c=new Uint8Array(ct), out=new Uint8Array(IV_LEN+c.length);
      out.set(iv,0); out.set(c,IV_LEN);
      return b64(out);
    });
  }
  function decrypt(str){
    if(!keyP)return Promise.reject(new Error('no-key'));
    var raw;
    try{ raw=unb64(str) }catch(e){ return Promise.reject(e) }
    if(raw.length<=IV_LEN)return Promise.reject(new Error('short'));
    var iv=raw.subarray(0,IV_LEN), ct=raw.subarray(IV_LEN);
    return keyP.then(function(k){
      return SUB.decrypt({name:'AES-GCM',iv:iv},k,ct);
    }).then(function(pt){
      return JSON.parse(fromU8(new Uint8Array(pt)));
    });
  }

  /* ===== 브로커 승격 로직 ===== */
  function clearStall(){ if(stallTimer){ clearTimeout(stallTimer); stallTimer=null } }
  function armStall(){
    if(stallTimer||dead)return;
    /* mqtt.js가 같은 브로커로 재시도하는 동안 기다려 준다.
       STALL_MS 안에 안 돌아오면 그 브로커는 우리를 안 받아주는 것이다. */
    stallTimer=setTimeout(function(){ stallTimer=null; promote() },STALL_MS);
  }
  function drop(c){ try{ c&&c.end(true) }catch(e){} }
  /* 지금 클라이언트를 버리고 다음 브로커로 옮긴다 */
  function promote(){
    if(dead)return;
    clearStall();
    var old=cl; cl=null;
    drop(old);
    onNet('re');
    attempt();
  }
  function giveUp(){
    dead=true; clearStall();
    var old=cl; cl=null;
    drop(old);
    onNet('dead');
    if(firstRej){ firstRej(new Error('broker')); firstRes=firstRej=null }
  }
  function attempt(){
    if(dead)return;
    if(bi>=BROKERS.length){                  // 목록 한 바퀴 소진 → 순환
      bi=0; rounds++;
      if(rounds>=MAX_ROUNDS){ giveUp(); return }
    }
    var url=BROKERS[bi++], c;
    try{
      c=window.mqtt.connect(url,{
        clientId:'cm_'+Math.random().toString(16).slice(2,10),
        clean:true, reconnectPeriod:2500, connectTimeout:7000, keepalive:30
      });
    }catch(e){ setTimeout(attempt,400); return }

    var settled=false;                       // 이 후보의 최초 핸드셰이크가 끝났는지
    var to=setTimeout(function(){
      if(settled)return;
      settled=true; drop(c); attempt();
    },CONNECT_MS);

    c.on('connect',function(){
      clearTimeout(to);
      /* 이미 버린 후보가 뒤늦게 붙은 경우 — 정리하고 무시한다 */
      if(settled&&cl!==c){ drop(c); return }
      settled=true;
      if(cl&&cl!==c)drop(cl);
      cl=c; curUrl=url; rounds=0; clearStall();
      /* 승격이든 재접속이든, 붙으면 구독을 전부 다시 건다 */
      Object.keys(subs).forEach(function(t){ c.subscribe(t,{qos:0}) });
      onNet('on');
      if(firstRes){ firstRes(url); firstRes=firstRej=null }
    });
    c.on('error',function(){
      if(settled)return;                     // 붙은 뒤의 에러는 offline/reconnect가 처리한다
      settled=true; clearTimeout(to); drop(c); attempt();
    });
    c.on('offline',function(){
      if(cl!==c)return;
      onNet('off'); armStall();
    });
    c.on('reconnect',function(){
      if(cl!==c)return;
      onNet('re'); armStall();
    });
    c.on('message',function(t,p){
      if(cl!==c)return;
      if(!subs[t])return;
      var s=p.toString();
      /* 수신도 순서대로 처리한다 — 복호화가 async라 그냥 두면 스트로크가 뒤집힌다 */
      recvQ=recvQ.then(function(){
        var fn=subs[t];
        if(!fn)return;
        if(s===''){ try{ fn(null) }catch(e){} return }   // 빈 retain = 방 닫힘
        return decrypt(s).then(function(obj){
          var f=subs[t];
          if(f&&obj!=null){ try{ f(obj) }catch(e){} }
        },noop);                                        // 남의 방/잡음 — 조용히 버린다
      }).catch(noop);
    });
  }

  return {
    cryptoOk:cryptoOk,
    online:online,
    /* 진단용. 연결이 이상할 때 콘솔에서 상태를 볼 수 있어야 원인을 좁힐 수 있다. */
    info:function(){
      return {on:online(), url:curUrl, connected:!!(cl&&cl.connected),
              hasClient:!!cl, bi:bi, rounds:rounds, dead:dead, subs:Object.keys(subs)};
    },
    /* 방 코드 설정. 방을 만들거나 입장할 때 한 번 넣는다. */
    setKey:function(k){
      keyP=deriveKey(String(k||''));
      keyP.catch(noop);                // 미처리 거부 경고 방지
      return keyP;
    },

    connect:function(onState){
      if(!SUB)return Promise.reject(new Error('no-subtle'));
      onNet=onState||function(){};
      dead=false; rounds=0; bi=0;      // 재시도할 때는 목록 처음부터
      return loadMqtt().then(function(){
        return new Promise(function(res,rej){
          firstRes=res; firstRej=rej;
          attempt();
        });
      });
    },
    /* 밖에서 강제로 다음 브로커로 옮긴다.
       참가자가 "방장 소식이 한동안 없다"고 판단했을 때 쓴다 —
       방장이 다른 브로커로 승격했다면 이걸로 따라붙는다(retain된 상태가 즉시 온다). */
    promote:function(){ if(!dead)promote() },
    dead:function(){ return dead },

    sub:function(t,fn){ subs[t]=fn; if(cl)cl.subscribe(t,{qos:0}) },
    unsub:function(t){ delete subs[t]; if(cl)cl.unsubscribe(t) },

    /* 소켓이 열려 있을 때만 보낸다.
       닫히는 중에 쓰면 브라우저가 "WebSocket is already in CLOSING..." 에러를 남기고,
       끊긴 동안 쌓아 봤자 실시간 게임에서는 낡은 상태라 쓸모가 없다. */
    pub:function(t,obj,retain){
      var opt={qos:0,retain:!!retain};
      /* 방 닫기(빈 retain)는 암호화가 필요 없고, 페이지가 닫히는 순간에 나가므로
         큐를 기다리지 않고 바로 보낸다. */
      if(obj===null){
        if(online()){ try{ cl.publish(t,'',opt) }catch(e){} }
        return Promise.resolve();
      }
      pubQ=pubQ.then(function(){
        if(!online())return;
        return encrypt(obj).then(function(payload){
          if(online()){ try{ cl.publish(t,payload,opt) }catch(e){} }
        });
      }).catch(noop);
      return pubQ;
    },
    /* 페이지를 떠날 때 부른다. 좀비 커넥션이 쌓이면 공용 브로커의 IP 제한을 빨리 맞는다.
       force를 주지 않으면 보내던 메시지를 흘려보낸 뒤 DISCONNECT를 보낸다. */
    end:function(force){
      dead=true; clearStall();
      var old=cl; cl=null;
      try{ old&&old.end(!!force) }catch(e){}
    }
  };
}

/* ===== mqtt.js 로더 ===== */
function loadMqtt(){
  return new Promise(function(res,rej){
    if(window.mqtt)return res();
    var i=0;
    (function next(){
      if(i>=MQTT_CDN.length)return rej(new Error('mqtt-load'));
      var s=document.createElement('script');
      s.src=MQTT_CDN[i++];
      s.onload=function(){ window.mqtt?res():next() };
      s.onerror=next;
      document.head.appendChild(s);
    })();
  });
}

window.CM_NET={ make:makeMqttNet, brokers:BROKERS, cryptoOk:cryptoOk, topicId:topicId };
/* game.js가 만든 인스턴스의 진단 함수만 노출한다 (콘솔에서 window.__CMNET.info()).
   인스턴스를 통째로 내보내면 pub()까지 열려서, 같은 방 참가자가 방장 상태 메시지를
   한 줄로 위조할 수 있다. 키는 이미 링크에 있으니 원리상 막을 수는 없지만
   그 문턱을 콘솔 한 줄로 낮춰 줄 이유는 없다. */
var _mk=window.CM_NET.make;
window.CM_NET.make=function(){ var n=_mk(); window.__CMNET={info:n.info}; return n };
})();
