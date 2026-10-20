#!/usr/bin/env python3
"""Setzt render/anim_illu.html aus anim.html (Helfer, Untertitel) und illu_scenes.js (Szenen) zusammen."""
s=open('render/anim.html',encoding='utf-8').read()
i1=s.index('/* ---------- Szenen ---------- */')
iS=s.index('/* ---------- Untertitel ---------- */'); iE=s.index('/* ---------- Effekte ---------- */')
iF=s.index('window.GUIDES=false;')
head=s[:i1]; subs=s[iS:iE]; guides=s[iF:s.index('window.setTimeline')]
subs=subs.replace("ctx.strokeStyle='rgba(0,0,10,.92)'","ctx.strokeStyle='rgba(28,8,64,.95)'").replace("cy=1100-","cy=1260-")
illu=open('render/illu_scenes.js',encoding='utf-8').read()
open('render/anim_illu.html','w',encoding='utf-8').write(head+subs+guides+'window.setTimeline=tl=>{TL=tl;prepSubs()};\n'+illu+'\n</script></body></html>\n')
print('anim_illu.html gebaut')
