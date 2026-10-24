// Profilbild im schlichten Look (1024x1024, PNG): node tools/profilbild.mjs brand/
import {createRequire} from 'module';
import fs from 'fs';
import path from 'path';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PW_PATH||'playwright');
const outDir=process.argv[2]||'brand';
fs.mkdirSync(outDir,{recursive:true});
const html=`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000}canvas{display:block}</style></head><body>
<canvas id="c" width="1024" height="1024"></canvas>
<script>
const cv=document.getElementById('c'),ctx=cv.getContext('2d'),S=1024,FONT='Inter, "DejaVu Sans", sans-serif';
const CREAM='#f4f1ea',INK='#111111';
function hook(x,y,s,lw,col){ // Haken: kurzer Abstrich, langer Aufstrich, leicht geschwungen
  ctx.save();ctx.translate(x,y);ctx.scale(s,s);ctx.strokeStyle=col;ctx.lineWidth=lw;ctx.lineCap='round';ctx.lineJoin='round';
  ctx.beginPath();ctx.moveTo(-170,10);ctx.quadraticCurveTo(-90,60,-40,150);ctx.quadraticCurveTo(40,-40,190,-160);ctx.stroke();ctx.restore()}
window.draw=v=>{
  ctx.clearRect(0,0,S,S);
  if(v===1){ // heller Grund, großer schwarzer Haken, Wortmarke unten
    ctx.fillStyle=CREAM;ctx.fillRect(0,0,S,S);
    hook(512,470,1.55,46,INK);
    ctx.fillStyle=INK;ctx.font='800 92px '+FONT;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('nachgehakt',512,840);
    ctx.fillStyle='#6b6b6b';ctx.fillRect(452,905,120,6);
  }
  if(v===2){ // schwarzer Grund, heller Haken, nur Zeichen
    ctx.fillStyle=INK;ctx.fillRect(0,0,S,S);
    hook(512,540,1.9,52,CREAM);
    ctx.fillStyle=CREAM;ctx.font='700 54px '+FONT;ctx.textAlign='center';ctx.textBaseline='middle';ctx.letterSpacing='10px';ctx.fillText('NACHGEHAKT',512,900);
  }
  if(v===3){ // heller Grund, Wortmarke mit Haken als Punkt
    ctx.fillStyle=CREAM;ctx.fillRect(0,0,S,S);
    ctx.fillStyle=INK;ctx.font='900 150px '+FONT;ctx.textAlign='center';ctx.textBaseline='middle';
    ctx.fillText('nach',512,400);ctx.fillText('gehakt',512,560);
    hook(512,760,.7,30,INK);
  }
};
</script></body></html>`;
const browser=await chromium.launch({args:['--disable-gpu','--font-render-hinting=none']});
const page=await browser.newPage({viewport:{width:1024,height:1024}});
await page.setContent(html);await page.evaluate(()=>document.fonts.ready);
for(const v of [1,2,3]){
  await page.evaluate(v=>window.draw(v),v);
  const buf=Buffer.from((await page.evaluate(()=>document.getElementById('c').toDataURL('image/png'))).split(',')[1],'base64');
  fs.writeFileSync(path.join(outDir,`profil_schlicht_${v}.png`),buf);
}
await browser.close();console.log('Profilbilder gespeichert in',outDir);
