/* ===== Illustrierter Stil (flach, warme Verlaeufe, Tiefe) ===== */
COL.green='#ffd23c';            // Akzentfarbe der Untertitel: warmes Gelb
COL.yellow='#ffd23c';
const PL={ink:'#140a2e',purple:'#2b1260',plum:'#5a1d73',magenta:'#c23a8a',orange:'#ff7a3c',yellow:'#ffc93c',cream:'#fff2d9',teal:'#1fd6c1',blue:'#2f7bff',skin:'#f2b48c',red:'#ff3b5c'};
const CX=510;                    // Mitte der TikTok-Sicherheitszone
const SCN={};
function vgrad(y0,y1,stops){const g=ctx.createLinearGradient(0,y0,0,y1);stops.forEach(([o,c])=>g.addColorStop(o,c));return g}
function blob(cx,cy,r,seed,n=9,wob=.25){
  const rr=rng(seed),pts=[];for(let i=0;i<n;i++){const a=i/n*6.283,k=1+(rr()-.5)*2*wob;pts.push([cx+Math.cos(a)*r*k,cy+Math.sin(a)*r*k])}
  ctx.beginPath();
  for(let i=0;i<n;i++){const p0=pts[i],p1=pts[(i+1)%n],mx=(p0[0]+p1[0])/2,my=(p0[1]+p1[1])/2;
    if(i===0){const pl=pts[n-1];ctx.moveTo((pl[0]+p0[0])/2,(pl[1]+p0[1])/2)}ctx.quadraticCurveTo(p0[0],p0[1],mx,my)}
  ctx.closePath();
}
const GRAIN=(()=>{const c=document.createElement('canvas');c.width=c.height=256;const x=c.getContext('2d'),r=rng(5);
  for(let i=0;i<5200;i++){x.fillStyle=r()>.5?'rgba(255,255,255,.07)':'rgba(0,0,0,.08)';x.fillRect(r()*256,r()*256,2,2)}return c})();
function starfield(t,a=1){for(const s of STARS){const y=((s.y-t*s.v*.4)%H+H)%H;ctx.fillStyle=`rgba(255,240,220,${a*(.3+.45*Math.sin(t*2+s.p)**2)})`;ctx.fillRect(s.x,y,s.s,s.s)}}
function pill(txt,x,y,fill,size=34){ctx.save();ctx.font=`800 ${size}px ${FONT}`;const w=ctx.measureText(txt).width+56,h=size+30;
  ctx.fillStyle=fill;ctx.beginPath();ctx.roundRect(x-w/2,y-h/2,w,h,h/2);ctx.fill();ctx.fillStyle='#fff';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(txt,x,y+2);ctx.restore()}
function bigText(txt,x,y,size,o={}){ctx.save();ctx.font=`900 ${size}px ${FONT}`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.globalAlpha=o.alpha??1;
  ctx.shadowColor='rgba(20,5,50,.65)';ctx.shadowBlur=22;ctx.shadowOffsetY=8;ctx.lineJoin='round';ctx.lineWidth=size*.12;ctx.strokeStyle='rgba(30,8,70,.85)';ctx.strokeText(txt,x,y);
  ctx.shadowColor='transparent';ctx.fillStyle=o.color||'#fff';ctx.fillText(txt,x,y);ctx.restore()}
function eraLabel(t,title,sub){
  ctx.save();ctx.textAlign='right';ctx.textBaseline='alphabetic';ctx.shadowColor='rgba(20,5,50,.7)';ctx.shadowBlur=8;
  ctx.fillStyle='#fff';ctx.font=`800 30px ${FONT}`;ctx.fillText(title,960,140);
  ctx.font=`700 22px ${FONT}`;ctx.fillStyle='rgba(255,255,255,.88)';ctx.fillText(sub,960,167);
  ctx.shadowBlur=0;ctx.fillStyle='rgba(255,255,255,.28)';ctx.fillRect(760,179,200,4);ctx.fillStyle=PL.red;ctx.fillRect(760,179,200*clamp(t/TL.duration),4);ctx.restore()}

function earth(cx,cy,r,rot){
  ctx.save();
  let g=ctx.createRadialGradient(cx,cy,r*.9,cx,cy,r*1.8);g.addColorStop(0,'rgba(80,170,255,.5)');g.addColorStop(1,'rgba(80,170,255,0)');
  ctx.fillStyle=g;ctx.beginPath();ctx.arc(cx,cy,r*1.8,0,7);ctx.fill();
  ctx.beginPath();ctx.arc(cx,cy,r,0,7);ctx.clip();
  g=ctx.createLinearGradient(cx-r,cy-r,cx+r,cy+r);g.addColorStop(0,'#3d92ff');g.addColorStop(1,'#0c2a9a');ctx.fillStyle=g;ctx.fillRect(cx-r,cy-r,2*r,2*r);
  const span=r*3.4;
  for(let k=-1;k<=1;k++){const off=((rot*r*.45)%span)+k*span-span/2+r*.2;
    [[.0,-.3,.4,3,'#4fd873'],[.55,.3,.3,8,'#3fc462'],[-.45,.5,.27,12,'#5be07d'],[-.1,-.8,.2,5,'#eaf7ff'],[1.2,-.1,.34,17,'#4fd873']].forEach(([x,y,rr,sd,c])=>{ctx.fillStyle=c;blob(cx+off+x*r,cy+y*r,rr*r,sd,10,.35);ctx.fill()})}
  ctx.fillStyle='rgba(255,255,255,.8)';
  for(let i=0;i<7;i++){const x=cx+(((i*.55+rot*.3)%2.8)-1.4)*r;ctx.beginPath();ctx.ellipse(x,cy+((i*37)%5-2)*r*.3,r*.26,r*.06,0,0,7);ctx.fill()}
  g=ctx.createRadialGradient(cx-r*.45,cy-r*.45,r*.15,cx,cy,r*1.15);g.addColorStop(0,'rgba(255,255,255,.22)');g.addColorStop(.55,'rgba(0,0,0,0)');g.addColorStop(1,'rgba(5,0,45,.62)');
  ctx.fillStyle=g;ctx.fillRect(cx-r,cy-r,2*r,2*r);ctx.restore();
}
function person(x,y,t,o={}){
  const bob=Math.sin(t*2.2)*4,sk=PL.skin;ctx.save();ctx.translate(x,y+bob);ctx.scale(o.s||1,o.s||1);
  ctx.fillStyle=o.shirt||PL.teal;ctx.beginPath();ctx.roundRect(-150,0,300,240,[100,100,0,0]);ctx.fill();
  ctx.fillStyle='rgba(20,5,60,.16)';ctx.beginPath();ctx.roundRect(10,0,140,240,[0,100,0,0]);ctx.fill();
  ctx.fillStyle='#fff6e0';ctx.beginPath();ctx.moveTo(-40,0);ctx.lineTo(0,56);ctx.lineTo(40,0);ctx.closePath();ctx.fill();
  ctx.fillStyle=sk;ctx.fillRect(-26,-44,52,62);
  ctx.beginPath();ctx.ellipse(0,-108,76,90,0,0,7);ctx.fill();
  ctx.beginPath();ctx.ellipse(-76,-100,13,20,0,0,7);ctx.ellipse(76,-100,13,20,0,0,7);ctx.fill();
  ctx.fillStyle='rgba(255,120,110,.35)';ctx.beginPath();ctx.ellipse(-44,-72,14,9,0,0,7);ctx.ellipse(44,-72,14,9,0,0,7);ctx.fill();
  ctx.fillStyle='#2a1a22';ctx.beginPath();ctx.moveTo(-82,-112);ctx.quadraticCurveTo(-94,-214,0,-204);ctx.quadraticCurveTo(94,-214,82,-112);
  ctx.quadraticCurveTo(44,-160,-8,-146);ctx.quadraticCurveTo(-60,-146,-82,-112);ctx.fill();
  const lx=(o.lookx||0)*6,ly=(o.looky||0)*4,blink=(t%3.4)>3.3?.15:1;
  ctx.strokeStyle='#2a1a22';ctx.lineWidth=7;ctx.beginPath();ctx.arc(-30,-98,26,0,7);ctx.moveTo(56,-98);ctx.arc(30,-98,26,0,7);ctx.moveTo(-4,-100);ctx.lineTo(4,-100);ctx.stroke();
  ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(-30,-98,22,0,7);ctx.arc(30,-98,22,0,7);ctx.fill();
  ctx.fillStyle='#2a1a22';ctx.beginPath();ctx.ellipse(-30+lx,-98+ly,9,9*blink,0,0,7);ctx.ellipse(30+lx,-98+ly,9,9*blink,0,0,7);ctx.fill();
  ctx.lineWidth=7;ctx.lineCap='round';const br=o.brow||0;
  ctx.beginPath();ctx.moveTo(-52,-138-br);ctx.lineTo(-10,-142-br*1.5);ctx.moveTo(52,-138-br);ctx.lineTo(10,-142-br*1.5);ctx.stroke();
  ctx.beginPath();if(o.smile){ctx.arc(0,-62,16,.15,3)}else{ctx.moveTo(-14,-52);ctx.quadraticCurveTo(0,-58,14,-52)}ctx.stroke();
  ctx.restore();
}
/* --- Szenen --- */
SCN.hook=(tl,t)=>{
  ctx.fillStyle=vgrad(0,H,[[0,'#090419'],[.55,'#1c0d47'],[1,'#3b1566']]);ctx.fillRect(0,0,W,H);
  starfield(t);
  { const g=ctx.createRadialGradient(540,2560,900,540,2560,1140);g.addColorStop(0,'#140a3c');g.addColorStop(.86,'#25278a');g.addColorStop(.935,'#4fa0ff');g.addColorStop(1,'rgba(80,160,255,0)');
    ctx.fillStyle=g;ctx.beginPath();ctx.arc(540,2560,1140,0,7);ctx.fill(); }
  const k=eBack(tl/.9),s=.55+.45*k;
  ctx.save();ctx.translate(CX,700);ctx.scale(s,s);ctx.translate(-CX,-700);earth(CX,700,270,tl*1.6);ctx.restore();
  const yr=Math.round(lerp(2025,1950,eOut((tl-.5)/3.4)));
  bigText(String(yr),CX,300,210);
  if(tl>3.7){const a=eBack((tl-3.7)/.4);ctx.save();ctx.translate(CX,1060);ctx.scale(a,a);pill('vor 75 Jahren',0,0,PL.magenta,44);ctx.restore()}
};
SCN.question=(tl,t)=>{
  ctx.fillStyle=vgrad(0,H,[[0,'#2b1260'],[.5,'#6a2078'],[1,'#c23a8a']]);ctx.fillRect(0,0,W,H);
  ctx.save();rrect(140,230,740,540,44);ctx.clip();
  ctx.fillStyle=vgrad(230,770,[[0,'#ff5f6d'],[.55,'#ff9a3c'],[1,'#ffd23c']]);ctx.fillRect(130,220,760,560);
  ctx.fillStyle='#fff3b0';ctx.shadowColor='#fff3b0';ctx.shadowBlur=60;ctx.beginPath();ctx.arc(CX,620,120,0,7);ctx.fill();ctx.shadowBlur=0;
  ctx.fillStyle='#8a2a6e';blob(300,790,260,4,8,.15);ctx.fill();ctx.fillStyle='#5a1d73';blob(740,800,300,9,8,.15);ctx.fill();
  ctx.restore();ctx.strokeStyle=PL.cream;ctx.lineWidth=16;rrect(140,230,740,540,44);ctx.stroke();
  ctx.beginPath();ctx.moveTo(CX,236);ctx.lineTo(CX,764);ctx.moveTo(146,500);ctx.lineTo(874,500);ctx.lineWidth=10;ctx.stroke();
  person(CX,890,t,{lookx:Math.sin(tl*1.5),looky:-.8,brow:10,s:1.3});
  // Schreibtisch (reicht bis zum unteren Rand)
  ctx.fillStyle=vgrad(1000,H,[[0,'#7a3046'],[.04,'#4a1d2f'],[1,'#240c20']]);ctx.fillRect(0,1000,W,H-1000);
  ctx.fillStyle='rgba(255,255,255,.1)';ctx.fillRect(0,1000,W,10);
  ctx.fillStyle='#fff6e0';ctx.save();ctx.translate(250,985);ctx.rotate(-.07);ctx.beginPath();ctx.roundRect(-90,-10,180,24,4);ctx.fill();ctx.restore();
  ctx.fillStyle='#ffd23c';ctx.beginPath();ctx.roundRect(760,960,120,40,10);ctx.fill();
  ctx.strokeStyle='#ffd23c';ctx.lineWidth=12;ctx.lineCap='round';ctx.beginPath();ctx.moveTo(820,960);ctx.lineTo(850,880);ctx.lineTo(800,820);ctx.stroke();
  ctx.fillStyle='#ffe9a0';ctx.shadowColor='#ffd23c';ctx.shadowBlur=50;ctx.beginPath();ctx.moveTo(770,800);ctx.lineTo(850,790);ctx.lineTo(880,850);ctx.lineTo(760,850);ctx.fill();ctx.shadowBlur=0;
  // Gedankenblase mit Fragezeichen
  const a=eBack((tl-.25)/.5);ctx.save();ctx.translate(690,330);ctx.scale(a,a);
  ctx.fillStyle=PL.cream;ctx.shadowColor='rgba(255,220,150,.8)';ctx.shadowBlur=40;
  blob(0,0,125,2,9,.12);ctx.fill();ctx.shadowBlur=0;
  [[-120,150,26],[-170,215,17]].forEach(([x,y,r])=>{ctx.beginPath();ctx.arc(x,y,r,0,7);ctx.fill()});
  ctx.font=`900 190px ${FONT}`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle=PL.magenta;ctx.fillText('?',0,12+Math.sin(tl*4)*5);ctx.restore();
  // schwebende Zeichen
  ['0','1','+','=','∑'].forEach((c,i)=>{const yy=300+((i*140-tl*40)%560+560)%560;ctx.globalAlpha=.55;ctx.fillStyle=PL.cream;ctx.font=`800 56px ${FONT}`;ctx.fillText(c,120+(i%2)*55,yy);ctx.globalAlpha=1});
};
function lab(tl,t){
  ctx.fillStyle=vgrad(0,1500,[[0,'#0f1d4a'],[1,'#1d5f78']]);ctx.fillRect(0,0,W,H);
  const pan=-tl*16;
  // Lampen mit Lichtkegeln
  for(const x of [200,540,880]){const g=ctx.createLinearGradient(0,60,0,900);g.addColorStop(0,'rgba(255,230,160,.34)');g.addColorStop(1,'rgba(255,230,160,0)');
    ctx.fillStyle=g;ctx.beginPath();ctx.moveTo(x-40,70);ctx.lineTo(x+40,70);ctx.lineTo(x+210,1080);ctx.lineTo(x-210,1080);ctx.fill();
    ctx.fillStyle='#fff3c0';ctx.beginPath();ctx.ellipse(x,66,60,16,0,0,7);ctx.fill()}
  // Rechenschraenke
  for(let i=-1;i<7;i++){const x=pan*.6+i*200+30;
    ctx.fillStyle=i%2?'#2c4fa0':'#3a63c0';ctx.beginPath();ctx.roundRect(x,300,180,780,18);ctx.fill();
    ctx.fillStyle='rgba(0,0,30,.25)';ctx.beginPath();ctx.roundRect(x+90,300,90,780,[0,18,18,0]);ctx.fill();
    ctx.fillStyle='#10204a';ctx.beginPath();ctx.roundRect(x+16,350,148,150,12);ctx.fill();
    for(let r=0;r<4;r++)for(let c=0;c<6;c++){const on=rng(i*131+r*17+c*5+Math.floor(t*2.6)*7)()>.5;
      ctx.fillStyle=on?[PL.yellow,PL.orange,PL.teal][(r+c)%3]:'#223566';ctx.shadowColor=ctx.fillStyle;ctx.shadowBlur=on?10:0;
      ctx.beginPath();ctx.arc(x+34+c*22,372+r*30,7,0,7);ctx.fill()}
    ctx.shadowBlur=0;
    if(i%2===1){for(const dx of [50,130]){ctx.save();ctx.translate(x+dx,610);ctx.rotate((dx>60?-1:1)*tl*3);
      ctx.fillStyle='#e8dfc9';ctx.beginPath();ctx.arc(0,0,48,0,7);ctx.fill();ctx.fillStyle='#10204a';
      for(let k=0;k<3;k++){ctx.rotate(2.094);ctx.beginPath();ctx.ellipse(0,-26,11,17,0,0,7);ctx.fill()}ctx.beginPath();ctx.arc(0,0,9,0,7);ctx.fill();ctx.restore()}}
    else{ctx.fillStyle='#10204a';ctx.beginPath();ctx.roundRect(x+16,540,148,80,10);ctx.fill();ctx.fillStyle=PL.teal;
      for(let k=0;k<4;k++)ctx.fillRect(x+28,552+k*16,60+((k*37+Math.floor(t*2))%60),6)}
    ctx.fillStyle='#10204a';for(let yy=690;yy<=1030;yy+=40)ctx.fillRect(x+16,yy,148,12)}
  // Boden
  ctx.fillStyle=vgrad(1080,H,[[0,'#2b1260'],[1,'#12062e']]);ctx.fillRect(0,1080,W,H-1080);
  for(const [x0,c] of [[260,PL.yellow],[600,PL.teal],[900,PL.orange]]){ctx.save();ctx.strokeStyle=c;ctx.lineWidth=20;ctx.lineCap='round';ctx.shadowColor=c;ctx.shadowBlur=16;
    ctx.beginPath();ctx.moveTo(x0+pan*.8,1070);ctx.bezierCurveTo(x0+pan*.8,1320,x0+240,1300,x0+180,H+20);ctx.stroke();ctx.restore()}
  ctx.strokeStyle='rgba(255,160,120,.18)';ctx.lineWidth=2;for(let i=1;i<9;i++){const y=1080+(i*i)*14;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(W,y);ctx.stroke()}
}
SCN.turing=(tl,t)=>{
  lab(tl,t);const a=eOut(tl/.45);
  { const g=ctx.createRadialGradient(CX,470,40,CX,470,470);g.addColorStop(0,'rgba(24,6,60,.78)');g.addColorStop(1,'rgba(24,6,60,0)');ctx.fillStyle=g;ctx.fillRect(0,0,W,1000); }
  ctx.save();ctx.globalAlpha=a;ctx.translate(0,(1-a)*-60);
  bigText('ALAN',CX,300,150);bigText('TURING',CX,440,150);
  ctx.restore();
  if(tl>.7){const b=eBack((tl-.7)/.4);ctx.save();ctx.translate(CX,600);ctx.scale(b,b);pill('Mathematiker  ·  1912 – 1954',0,0,PL.magenta,34);ctx.restore()}
};
SCN.test=(tl,t,sc)=>{
  ctx.fillStyle=vgrad(0,H,[[0,'#2b1260'],[.55,'#7a2480'],[1,'#e0553c']]);ctx.fillRect(0,0,W,H);
  starfield(t,.5);
  for(let i=0;i<9;i++){const r=rng(i*13+2),bx=r()*W,by=1050+r()*820+Math.sin(t*.8+i)*14;ctx.fillStyle=`rgba(255,${180+i*8},120,.16)`;ctx.beginPath();ctx.arc(bx,by,40+r()*70,0,7);ctx.fill()}
  ctx.fillStyle=vgrad(1000,H,[[0,'rgba(255,140,80,0)'],[1,'rgba(60,10,70,.55)']]);ctx.fillRect(0,1000,W,H-1000);
  const rooms=[{x:90,l:'A',h:0},{x:550,l:'B',h:1}],a=eBack(tl/.5);
  ctx.save();ctx.translate(0,60);
  for(const r of rooms){
    ctx.save();ctx.translate(r.x+190,560);ctx.scale(a,a);ctx.translate(-(r.x+190),-560);
    ctx.save();rrect(r.x,300,380,520,40);ctx.clip();
    ctx.fillStyle=vgrad(300,820,[[0,'#ffe9b0'],[1,'#ff9a5c']]);ctx.fillRect(r.x,300,380,520);
    const px=r.x+190+Math.sin(tl*1.4+r.h)*10;
    ctx.fillStyle='#3a1860';
    if(!r.h){ctx.beginPath();ctx.arc(px,560,66,0,7);ctx.fill();ctx.beginPath();ctx.roundRect(px-120,640,240,200,[100,100,0,0]);ctx.fill()}
    else{ctx.beginPath();ctx.roundRect(px-70,490,140,120,22);ctx.fill();ctx.fillRect(px-5,440,10,52);ctx.beginPath();ctx.arc(px,436,14,0,7);ctx.fill();
      ctx.beginPath();ctx.roundRect(px-120,640,240,200,[40,40,0,0]);ctx.fill();ctx.fillStyle=PL.teal;ctx.shadowColor=PL.teal;ctx.shadowBlur=20;ctx.beginPath();ctx.arc(px,548,22,0,7);ctx.fill();ctx.shadowBlur=0}
    ctx.fillStyle='rgba(255,255,255,.2)';ctx.fillRect(r.x,300,380,520);          // Milchglas
    ctx.fillStyle='rgba(255,255,255,.16)';ctx.beginPath();ctx.moveTo(r.x+40,300);ctx.lineTo(r.x+130,300);ctx.lineTo(r.x+10,820);ctx.lineTo(r.x-80,820);ctx.fill();
    ctx.restore();
    ctx.strokeStyle=PL.cream;ctx.lineWidth=14;rrect(r.x,300,380,520,40);ctx.stroke();
    ctx.fillStyle=PL.cream;ctx.beginPath();ctx.arc(r.x+190,262,38,0,7);ctx.fill();
    ctx.fillStyle=PL.plum;ctx.font=`900 48px ${FONT}`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(r.l,r.x+190,266);
    const dots=(Math.floor(tl*3+r.h)%3)+1;
    ctx.fillStyle='#fff';ctx.beginPath();ctx.roundRect(r.x+(r.h?20:170),840,190,64,32);ctx.fill();ctx.fillStyle=PL.plum;ctx.font=`900 48px ${FONT}`;ctx.fillText('.'.repeat(dots),r.x+(r.h?115:265),846);
    ctx.restore();
  }
  ctx.restore();
  const ev=TL.events.find(e=>e.type==='stamp');
  if(ev&&t>=ev.t){const u=t-ev.t,s=lerp(3,1,eOut(u/.18)),sh=u<.3?(Math.random()-.5)*14*(1-u/.3):0;
    ctx.save();ctx.translate(CX+sh,640+sh);ctx.rotate(-.18);ctx.scale(s,s);
    ctx.fillStyle=PL.cream;ctx.beginPath();ctx.roundRect(-330,-90,660,180,24);ctx.fill();ctx.lineWidth=14;ctx.strokeStyle=PL.teal;ctx.stroke();
    ctx.font=`900 118px ${FONT}`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle='#0d8f80';ctx.fillText('BESTANDEN',0,6);ctx.restore();
    if(u<.12){ctx.fillStyle=`rgba(255,255,255,${.5*(1-u/.12)})`;ctx.fillRect(0,0,W,H)}}
};
window.drawFrame=t=>{
  const sc=TL.scenes.find(s=>t>=s.start&&t<s.end)||TL.scenes[TL.scenes.length-1],tl=t-sc.start;
  ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,W,H);
  ctx.save();const p=1+.05*clamp(1-tl/.4);ctx.translate(CX,700);ctx.scale(p,p);ctx.translate(-CX,-700);
  (SCN[sc.id]||SCN.hook)(tl,t,sc);ctx.restore();
  eraLabel(t,'KI-GESCHICHTE',t<5.4?'Teil 1':'ab 1950');
  drawSubs(t);
  ctx.save();ctx.globalAlpha=1;ctx.fillStyle=ctx.createPattern(GRAIN,'repeat');ctx.fillRect(0,0,W,H);ctx.restore();
  const g=ctx.createRadialGradient(540,960,600,540,960,1300);g.addColorStop(0,'rgba(0,0,0,0)');g.addColorStop(1,'rgba(10,0,30,.45)');ctx.fillStyle=g;ctx.fillRect(0,0,W,H);
  if(tl<.22){ctx.fillStyle=`rgba(255,240,220,${.6*(1-tl/.22)})`;ctx.fillRect(0,0,W,H)}
  if(t<.3){ctx.fillStyle=`rgba(0,0,0,${1-t/.3})`;ctx.fillRect(0,0,W,H)}
  if(window.GUIDES)guides();
};
