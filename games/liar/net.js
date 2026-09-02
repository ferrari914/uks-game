/* =========================================================================
   라이어 게임 — 통신 계층 (net.js)
   캐치마인드 net.js(검증된 브로커 다중화 계층)를 복사해 라이어용으로 고쳤다.
   바뀐 것: 솔트·클라이언트 ID 접두사·전역 이름(window.LIAR_NET), 그리고 **E2E 계층 추가**.

   [1] 전송 계층 (캐치마인드와 동일)
   · 공용 MQTT 브로커(WebSocket) 3중 폴백 — 최초 연결뿐 아니라 연결 후 절단에도 동작한다.
     재접속이 STALL_MS 안에 안 돌아오면 현재 클라이언트를 버리고 다음 브로커로 승격한다.
   · mqtt.js CDN 2중 폴백 (unpkg → jsdelivr)
   · 방 코드 하나로 토픽 ID와 방 키를 각각 유도한다 (솔트가 다르다).
     토픽에 방 코드가 나타나지 않으므로 eklr/# 로 엿보는 제3자는 hex 토픽과 암호문만 본다.
   · 모든 페이로드를 그 방 키로 AES-GCM 암복호화한다. 복호화 실패는 조용히 버린다.
   · crypto.subtle이 전부 async라 발행(pubQ)·수신(recvQ) 프라미스 큐로 순서를 직렬화한다.

   [2] E2E 계층 (라이어에서 새로 만든 것) — 이 게임의 핵심
   전송 계층의 방 키는 **같은 방 사람이면 누구나 갖고 있다.** 즉 제시어를 그냥 실어 보내면
   라이어가 개발자도구로 그대로 읽는다. 그래서 개인 배정·투표는 한 겹 더 싼다.
   · 참가자마다 ECDH P-256 키쌍을 만들고 **공개키만** 방에 올린다.
   · 보내는 쪽은 일회용(ephemeral) 키쌍을 만들어 받는 사람 공개키와 ECDH →
     공유 비밀을 SHA-256(비밀‖솔트) 해서 AES-GCM 256 키로 쓴다 (ECIES).
     일회용 공개키는 암호문과 함께 보낸다.
   · 받는 쪽은 자기 개인키로만 같은 키를 만들 수 있다. 제3자는 같은 방이어도 못 연다.
   · HKDF 대신 SHA-256을 쓴 이유: HKDF는 브라우저 지원 편차가 있고, 여기서는
     한 번 쓰고 버리는 키라 SHA-256 한 번으로 충분하다. 외부 라이브러리는 쓰지 않는다.
   · 한계: 배정을 방장 브라우저가 하므로 **방장은 정답을 안다.** 서버가 없으면 못 없앤다.
     게임 쪽에서 "방장은 진행만 하기" 옵션으로 우회한다(규칙 시트에 명시).
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
var SALT_TOPIC='eklr-v1-topic-salt';
var SALT_KEY='eklr-v1-key-salt';
var SALT_E2E='eklr-v1-e2e-salt';
var ITER=250000;
var IV_LEN=12;

function cryptoOk(){ return !!SUB }

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

/* 방 코드 → 토픽 ID (SHA-256 앞 16 hex자). 토픽에는 이 값만 쓴다. */
function topicId(code){
  if(!SUB)return Promise.reject(new Error('no-subtle'));
  return SUB.digest('SHA-256',u8(String(code||'').toUpperCase()+SALT_TOPIC)).then(function(buf){
    var a=new Uint8Array(buf),h='',i;
    for(i=0;i<8;i++)h+=('0'+a[i].toString(16)).slice(-2);
    return h;
  });
}
/* 방 코드 → AES-GCM 256비트 방 키 (토픽 ID와는 다른 솔트) */
function deriveKey(code){
  if(!SUB)return Promise.reject(new Error('no-subtle'));
  return SUB.importKey('raw',u8(String(code||'').toUpperCase()),{name:'PBKDF2'},false,['deriveKey'])
    .then(function(base){
      return SUB.deriveKey(
        {name:'PBKDF2',salt:u8(SALT_KEY),iterations:ITER,hash:'SHA-256'},
        base,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
    });
}

/* ===================== E2E (ECDH P-256 + AES-GCM) ===================== */
var EC={name:'ECDH',namedCurve:'P-256'};

/* 내 키쌍. 공개키는 raw(b64)로 방에 올리고, 개인키는 이 탭 밖으로 나가지 않는다. */
function e2eGen(){
  if(!SUB)return Promise.reject(new Error('no-subtle'));
  return SUB.generateKey(EC,false,['deriveBits']).then(function(kp){
    /* ECDH generateKey에서 extractable 플래그는 개인키에만 적용된다.
       공개키는 규격상 항상 추출 가능하므로 false로 만들어도 export된다. */
    return SUB.exportKey('raw',kp.publicKey).then(function(raw){
      return {priv:kp.privateKey, pub:b64(new Uint8Array(raw))};
    });
  });
}
function importPub(s){
  return SUB.importKey('raw',unb64(s),EC,false,[]);
}
/* 공유 비밀 → AES-GCM 키. 솔트를 붙여 해싱해 이 용도에 묶는다. */
function sharedKey(priv,pubKey){
  return SUB.deriveBits({name:'ECDH',public:pubKey},priv,256).then(function(bits){
    var a=new Uint8Array(bits), s=u8(SALT_E2E), m=new Uint8Array(a.length+s.length);
    m.set(a,0); m.set(s,a.length);
    return SUB.digest('SHA-256',m);
  }).then(function(h){
    return SUB.importKey('raw',h,{name:'AES-GCM'},false,['encrypt','decrypt']);
  });
}
/* 상대 공개키로 봉인. 일회용 공개키(e)·IV(i)·암호문(c)만 나간다. */
function e2eSeal(theirPub,obj){
  if(!SUB)return Promise.reject(new Error('no-subtle'));
  return SUB.generateKey(EC,true,['deriveBits']).then(function(eph){
    return Promise.all([importPub(theirPub),SUB.exportKey('raw',eph.publicKey)]).then(function(r){
      return sharedKey(eph.privateKey,r[0]).then(function(k){
        var iv=window.crypto.getRandomValues(new Uint8Array(IV_LEN));
        return SUB.encrypt({name:'AES-GCM',iv:iv},k,u8(JSON.stringify(obj))).then(function(ct){
          return {e:b64(new Uint8Array(r[1])),i:b64(iv),c:b64(new Uint8Array(ct))};
        });
      });
    });
  });
}
/* 내 개인키로 열기. 남에게 온 봉투는 복호화가 실패하므로 자동으로 걸러진다. */
function e2eOpen(priv,box){
  if(!SUB)return Promise.reject(new Error('no-subtle'));
  if(!box||!box.e||!box.i||!box.c)return Promise.reject(new Error('bad-box'));
  return importPub(box.e).then(function(pk){
    return sharedKey(priv,pk);
  }).then(function(k){
    return SUB.decrypt({name:'AES-GCM',iv:unb64(box.i)},k,unb64(box.c));
  }).then(function(pt){
    return JSON.parse(fromU8(new Uint8Array(pt)));
  });
}

/* ===================== 네트워크 객체 ===================== */
function makeMqttNet(){
  var cl=null, subs={};
  var bi=0, rounds=0, dead=false;
  var stallTimer=null, curUrl='';
  var firstRes=null, firstRej=null;
  var onNet=function(){};
  var keyP=null;
  var pubQ=Promise.resolve();
  var recvQ=Promise.resolve();
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

  function clearStall(){ if(stallTimer){ clearTimeout(stallTimer); stallTimer=null } }
  function armStall(){
    if(stallTimer||dead)return;
    stallTimer=setTimeout(function(){ stallTimer=null; promote() },STALL_MS);
  }
  function drop(c){ try{ c&&c.end(true) }catch(e){} }
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
    if(bi>=BROKERS.length){
      bi=0; rounds++;
      if(rounds>=MAX_ROUNDS){ giveUp(); return }
    }
    var url=BROKERS[bi++], c;
    try{
      c=window.mqtt.connect(url,{
        clientId:'lr_'+Math.random().toString(16).slice(2,10),
        clean:true, reconnectPeriod:2500, connectTimeout:7000, keepalive:30
      });
    }catch(e){ setTimeout(attempt,400); return }

    var settled=false;
    var to=setTimeout(function(){
      if(settled)return;
      settled=true; drop(c); attempt();
    },CONNECT_MS);

    c.on('connect',function(){
      clearTimeout(to);
      if(settled&&cl!==c){ drop(c); return }
      settled=true;
      if(cl&&cl!==c)drop(cl);
      cl=c; curUrl=url; rounds=0; clearStall();
      Object.keys(subs).forEach(function(t){ c.subscribe(t,{qos:0}) });
      onNet('on');
      if(firstRes){ firstRes(url); firstRes=firstRej=null }
    });
    c.on('error',function(){
      if(settled)return;
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
      recvQ=recvQ.then(function(){
        var fn=subs[t];
        if(!fn)return;
        if(s===''){ try{ fn(null) }catch(e){} return }   // 빈 retain = 방 닫힘
        return decrypt(s).then(function(obj){
          var f=subs[t];
          if(f&&obj!=null){ try{ f(obj) }catch(e){} }
        },noop);
      }).catch(noop);
    });
  }

  return {
    cryptoOk:cryptoOk,
    online:online,
    info:function(){
      return {on:online(), url:curUrl, connected:!!(cl&&cl.connected),
              hasClient:!!cl, bi:bi, rounds:rounds, dead:dead, subs:Object.keys(subs)};
    },
    setKey:function(k){
      keyP=deriveKey(String(k||''));
      keyP.catch(noop);
      return keyP;
    },
    connect:function(onState){
      if(!SUB)return Promise.reject(new Error('no-subtle'));
      onNet=onState||function(){};
      dead=false; rounds=0; bi=0;
      return loadMqtt().then(function(){
        return new Promise(function(res,rej){
          firstRes=res; firstRej=rej;
          attempt();
        });
      });
    },
    promote:function(){ if(!dead)promote() },
    dead:function(){ return dead },

    sub:function(t,fn){ subs[t]=fn; if(cl)cl.subscribe(t,{qos:0}) },
    unsub:function(t){ delete subs[t]; if(cl)cl.unsubscribe(t) },

    pub:function(t,obj,retain){
      var opt={qos:0,retain:!!retain};
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

window.LIAR_NET={
  make:makeMqttNet, brokers:BROKERS, cryptoOk:cryptoOk, topicId:topicId,
  e2e:{ gen:e2eGen, seal:e2eSeal, open:e2eOpen }
};
/* 인스턴스를 통째로 내보내지 않는다 — pub()이 열리면 같은 방 참가자가 방장 상태를
   콘솔 한 줄로 위조할 수 있다. 진단용 info()만 노출한다. */
var _mk=window.LIAR_NET.make;
window.LIAR_NET.make=function(){ var n=_mk(); window.__LRNET={info:n.info}; return n };
})();
