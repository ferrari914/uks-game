/* extra.js — 현대 어휘 보강 목록 (판정 전용)   [자동 생성: _source/build_core.py]

   왜 필요한가: dict.js의 원본인 ENABLE은 1997년경 리스트라 현대 어휘가 없다.
   실측 결과 현대어 표본에서 email·internet·online·website·blog·app·wifi·emoji 등이
   전부 누락이었다. 사전이 16만 개여도 학습자가 가장 먼저 떠올리는 단어가 거부되면
   그 자리에서 게임이 끝난다.

   ⚠ 이 목록은 **판정에만 쓰고 AI의 단어 풀에는 넣지 않는다.**
      표준 사전에 없는 조어가 섞여 있어 AI가 내면 플레이어가 납득하지 못한다.
      플레이어를 도와주기만 하고 불리하게는 작용하지 않는 쪽으로 비대칭을 유지한다.

   선정 기준
     포함 — 학습자가 실제로 입력할 법한 현대 어휘와 그 굴절형(app/apps 함께)
     제외 — 고유명사·상표(chatgpt, bitcoin, roomba, faceid),
            문자로 읽는 약어(url, usb — SPEC §3.5 약어 배제),
            두 낱말이 옳은 것(qrcode, solarpanel, carsharing),
            원형이 사전에 없는 억지 파생(googling), 16자 이상

   수록 350개. 전량 ENABLE과 대조해 중복 0 확인. 손으로 고른 목록이므로 빠진 것이 남아 있다.
*/
(function(){
"use strict";
window.WB_EXTRA=[
"addon","addons","adulting","adware","agritech","app","applet","applets","apps","audiobook",
"audiobooks","autocomplete","autocompleted","autocorrect","autocorrected","autoplay",
"autoplayed","autosave","autosaved","autosaving","barcode","barcodes","barista","baristas",
"bingeable","bingewatch","biohacking","bioprinting","bitmap","blockchain","blockchains",
"blog","blogged","blogger","bloggers","blogging","blogosphere","blogs","bluetooth",
"cardless","cellphone","cellphones","chatbot","chatbots","chatbox","chatroom","chatrooms",
"clickbait","clickbaity","compostable","contactless","cosplay","cosplayer","cosplayers",
"cosplaying","cowork","coworking","crowdfunded","crowdfunder","crowdfunders","crowdfunding",
"crowdsource","crowdsourced","crowdsourcing","cryptocurrency","cyber","cyberattack",
"cyberattacks","cyberbully","cyberbullying","cybercrime","cybersecurity","cyberwar",
"darkweb","dashcam","dashcams","datacenter","datacenters","deepfake","deepfakes",
"downloader","doxxing","dropdown","dropdowns","earbud","earbuds","ebook","ebooks",
"ecofriendly","ecommerce","edtech","email","emailed","emailing","emails","emoji","emojis",
"emoticon","emoticons","ereader","ereaders","esports","facemask","facemasks","fintech",
"firewall","firewalls","flexitarian","freeware","gameplay","gamification","gamified",
"gamifies","gamify","geolocation","geotag","geotagging","geotags","glamping","hangry",
"hashtag","hashtags","homepage","homepages","homescreen","hotspot","hotspots","hoverboard",
"hoverboards","hyperlink","hyperlinks","influencer","influencers","insourcing","insurtech",
"internet","intranet","jetlag","keylogger","keyloggers","livestream","livestreamed",
"livestreamer","livestreamers","livestreaming","livestreams","lockscreen","login","logins",
"logout","logouts","malware","manga","meme","memes","metadata","metaverse","microblog",
"microblogging","microloan","microloans","microplastic","microplastics","mocktail",
"mocktails","multitask","multitasked","multitasker","nanobot","nanobots","nanotech",
"netbook","netbooks","netiquette","netizen","netizens","newsfeed","offboarding","offline",
"onboarding","online","outsourced","outsourcer","passcode","passcodes","passphrase",
"passphrases","paywall","paywalls","pescatarian","petabyte","phisher","phishers","phishing",
"photobomb","photobombed","photobombing","pixelated","pixelation","plugin","plugins",
"podcast","podcasted","podcaster","podcasters","podcasting","podcasts","popup","popups",
"powerbank","ramen","ransomware","reskill","reskilled","reskilling","retweet","retweeted",
"retweeting","retweets","ringtone","ringtones","sanitizer","sanitizers","screencast",
"screencasts","screensaver","screenshot","screenshots","screenshotting","scrollable",
"seatbelt","seatbelts","selfcare","selfie","selfies","smartcard","smartcards","smartcity",
"smarthome","smarthomes","smartlock","smartlocks","smartphone","smartphones","smartwatch",
"smartwatches","soundbar","soundbars","soundcheck","soundscape","spam","spammed","spammer",
"spammers","spamming","speedrun","speedrunner","speedruns","spellcheck","spellchecker",
"spyware","staycation","staycations","subwoofer","subwoofers","sudoku","superfood",
"superfoods","swipeable","tappable","telehealth","telemedicine","telepresence","telework",
"teleworker","teleworkers","teleworking","terabyte","terabytes","texted","texting",
"touchless","touchpad","touchpads","touchscreen","touchscreens","trackpad","trackpads",
"unboxings","unfollow","unfollowed","unfollowing","unfriend","uninstall","uninstalled",
"uninstalling","unsubscribe","unsubscribed","unsubscribing","upcycle","upcycled",
"upcycling","uploader","upskill","upskilled","upskilling","username","usernames",
"videocall","videocalls","videogame","videogames","vlog","vlogger","vloggers","vlogging",
"vlogs","voicechat","voicemail","voicemails","voiceover","walkthrough","walkthroughs",
"webcam","webcams","webcast","webcasting","webcasts","webhost","webhosting","webhosts",
"webinar","webinars","webmail","webmaster","webpage","webpages","website","websites",
"webtoon","webtoons","whiteboard","whiteboards","wifi","wiki","wikis","workflow",
"workflows","workspace","workspaces"
];
})();
