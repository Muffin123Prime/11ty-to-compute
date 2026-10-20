// Rendert das Profilbild (quadratisch) und eine Vorschau im runden Ausschnitt.
import {createRequire} from 'module';import path from 'path';
const require=createRequire(import.meta.url);const {chromium}=require(process.env.PW_PATH||'playwright');
const b=await chromium.launch({args:['--disable-gpu']});const p=await b.newPage({viewport:{width:1080,height:1080}});
await p.goto('file://'+path.resolve('profilbild.html'));
await p.screenshot({path:'profilbild.png'});
await p.addStyleTag({content:'body{background:#fff}svg{border-radius:50%;width:1080px;height:1080px}'});
await p.screenshot({path:'profilbild_rund_vorschau.png'});
await b.close();console.log('fertig');
