/* =========================================================
   Englknight — 게임 목록 데이터
   ---------------------------------------------------------
   게임을 추가하려면 아래 배열에 항목 하나만 추가하면 됩니다.
   허브 메인 페이지에 자동으로 카드가 생깁니다.

   id       : 고유 식별자 (영문/숫자/하이픈)
   title    : 카드에 표시될 게임 이름
   desc     : 한 줄 설명
   path     : 게임 실행 경로 (games/<폴더>/index.html)
   emoji    : 썸네일 대신 쓰는 이모지 (이미지 준비 전 임시)
   color    : 썸네일 그라데이션 색 (hex 2개)
   tags     : 검색/분류용 태그
   status   : "ready"(플레이 가능) | "wip"(준비중)
   added    : 등록일 (YYYY-MM-DD)
   ========================================================= */

window.GAMES = [
  {
    id: "tetris",
    title: "테트리스",
    desc: "블록을 쌓아 줄을 지우는 클래식 퍼즐 게임.",
    path: "games/tetris/index.html",
    emoji: "🟦",
    color: ["#3b82f6", "#8b5cf6"],
    tags: ["퍼즐", "클래식", "싱글"],
    status: "ready",
    added: "2026-08-27"
  },
  {
    id: "ox-survival",
    title: "OX 서바이벌",
    desc: "친구들과 실시간 멀티플레이! 틀린 쪽 발판은 무너진다. 마지막 한 명이 우승.",
    path: "games/ox-survival/index.html",
    emoji: "🕳️",
    color: ["#2bd9c4", "#ff4d6d"],
    tags: ["퀴즈", "멀티", "서바이벌"],
    status: "ready",
    added: "2026-08-27"
  },
  {
    id: "mafia",
    title: "마피아",
    desc: "친구들과 방을 만들어 함께 하는 실시간 마피아. 혼자서도 즐길 수 있습니다.",
    path: "games/mafia/index.html",
    emoji: "🔪",
    color: ["#e02947", "#4c1d95"],
    tags: ["추리", "멀티", "싱글", "심리"],
    status: "ready",
    added: "2026-08-27"
  },
  {
    id: "catchmind",
    title: "캐치마인드",
    desc: "제시어를 그림으로! 친구들과 실시간으로 그리고 맞히는 그림 퀴즈.",
    path: "games/catchmind/index.html",
    emoji: "🎨",
    color: ["#f59e0b", "#ec4899"],
    tags: ["그림", "퀴즈", "멀티"],
    status: "ready",
    added: "2026-08-28"
  },
  {
    id: "liar",
    title: "라이어 게임",
    desc: "한 기기를 돌려가며 즐기는 3~10인 파티 추리 게임. 라이어를 찾아내라.",
    path: "games/liar/index.html",
    emoji: "🎭",
    color: ["#a97bff", "#3b1d6e"],
    tags: ["파티", "추리", "심리"],
    status: "ready",
    added: "2026-08-28"
  },
  {
    id: "duel",
    title: "오목",
    desc: "방 코드 하나로 친구와 단둘이. 금수까지 지키는 정통 렌주룰 오목.",
    path: "games/duel/index.html",
    emoji: "⚪",
    color: ["#d4a373", "#3b2412"],
    tags: ["보드", "1:1", "멀티"],
    status: "ready",
    added: "2026-08-28"
  },
  {
    id: "stairs",
    title: "무한의 계단",
    desc: "계단을 오르며 얼마나 높이 갈 수 있는지. 혼자서, 또는 2~8인이 한 명 남을 때까지.",
    path: "games/stairs/index.html",
    emoji: "🪜",
    color: ["#4ade80", "#14532d"],
    // `반응속도`는 `아케이드`와 구분되는 게임이 하나도 없어 칩만 늘린다.
    // 반대로 `1:1`(오목)은 남긴다 — 나머지 멀티가 전부 3~10인이라
    // "둘이서 할 게임"을 찾을 다른 수단이 없다.
    tags: ["아케이드", "멀티"],
    status: "ready",
    added: "2026-08-28"
  },
  {
    id: "wordbattle",
    title: "영어 끝말잇기",
    desc: "앞 단어의 마지막 글자로 잇는 영어 단어 대결. AI 기사와 체력을 걸고 겨룬다.",
    path: "games/wordbattle/index.html",
    emoji: "🔤",
    color: ["#818cf8", "#1e1b4b"],
    tags: ["영어", "싱글", "퍼즐"],
    status: "ready",
    added: "2026-08-28"
  }
];

/* 옷입히기(dressup)는 RPG 컨셉 전환에 따라 게임이 아니라
   캐릭터 프로필/꾸미기 화면(profile/index.html)으로 재분류되어
   이 목록에서 제외했습니다. games/dressup/ 폴더는 그대로 남아 있습니다. */
