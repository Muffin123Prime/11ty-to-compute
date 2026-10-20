// Rendert die Animation Bild fuer Bild (Chromium) und schiebt sie in ffmpeg.
import {createRequire} from 'module';
import fs from 'fs';
import path from 'path';
import {spawn} from 'child_process';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PW_PATH||'playwright');
const args=process.argv.slice(2);
const opt=k=>{const i=args.indexOf('--'+k);return i>=0?args[i+1]:null};
const tlPath=args[0], outPath=args[1];
const TL=JSON.parse(fs.readFileSync(tlPath,'utf8'));
const FPS=+(opt('fps')||30);
const stills=opt('stills'); // z.B. --stills 0.1,1,2.5  -> JPGs neben outPath
const browser=await chromium.launch({args:['--disable-gpu','--font-render-hinting=none']});
const page=await browser.newPage({viewport:{width:1080,height:1920}});
await page.goto('file://'+path.resolve('render/anim.html'));
await page.evaluate(tl=>window.setTimeline(tl),TL);
await page.evaluate(()=>document.fonts.ready);
const grab=async t=>{
  const d=await page.evaluate(t=>{window.drawFrame(t);return document.getElementById('c').toDataURL('image/jpeg',0.93)},t);
  return Buffer.from(d.split(',')[1],'base64');
};
if(stills){
  fs.mkdirSync(outPath,{recursive:true});
  for(const t of stills.split(',').map(Number)){fs.writeFileSync(path.join(outPath,`still_${t.toFixed(2)}.jpg`),await grab(t))}
  await browser.close();process.exit(0);
}
const total=Math.round(TL.duration*FPS);
const ff=spawn('ffmpeg',['-v','error','-y','-f','image2pipe','-framerate',String(FPS),'-c:v','mjpeg','-i','-',
  '-c:v','libx264','-preset','medium','-crf','18','-pix_fmt','yuv420p',outPath],{stdio:['pipe','inherit','inherit']});
const t0=Date.now();
for(let f=0;f<total;f++){
  const buf=await grab(f/FPS);
  if(!ff.stdin.write(buf))await new Promise(r=>ff.stdin.once('drain',r));
  if(f%90===0)console.log(`Bild ${f}/${total}  ${((Date.now()-t0)/1000).toFixed(0)}s`);
}
ff.stdin.end();await new Promise(r=>ff.on('close',r));await browser.close();
console.log('fertig',outPath,((Date.now()-t0)/1000).toFixed(0)+'s');
