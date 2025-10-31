// html2spec.js
const PT_PER_MM = 72/25.4;
const PT_PER_PX = 72/96;

const toPt = (v,u) => !u||u==='pt'? v : u==='mm'? v*PT_PER_MM : u==='px'? v*PT_PER_PX : v;
const parseStyle = s => { const o={}; if(!s) return o; for(const p of s.split(';')){ const [k,...r]=p.split(':'); if(!k||!r.length) continue; o[k.trim().toLowerCase()]=r.join(':').trim(); } return o; };
const parseDim = (s,def='px') => { if(!s) return {v:0,u:def}; const m=String(s).trim().match(/^(-?\d+(?:\.\d+)?)(mm|px|pt)?$/i); return m? {v:parseFloat(m[1]), u:(m[2]||def).toLowerCase()} : {v:parseFloat(s)||0,u:def}; };
const parseColor = c => { if(!c) return null; const m=c.trim().match(/^#?([0-9a-f]{6})$/i); if(!m) return null; const h=m[1]; return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)]; };

function tokenize(html){
  const out=[]; const re=/<\/?([a-zA-Z0-9]+)([^>]*)\/?>|([^<]+)/gms; let m;
  while((m=re.exec(html))){
    if (m[1]){ const name=m[1].toLowerCase(); const attrs={}; const ar=/([:\w-]+)\s*=\s*"([^"]*)"|([:\w-]+)\s*=\s*'([^']*)'|([:\w-]+)/g; let a;
      while((a=ar.exec(m[2]||''))){ if(a[1]) attrs[a[1].toLowerCase()]=a[2]; else if(a[3]) attrs[a[3].toLowerCase()]=a[4]; else if(a[5]) attrs[a[5].toLowerCase()]=''; }
      out.push({type:'tag', name, attrs});
    } else if (m[3]){ const txt=m[3].replace(/\s+/g,' ').trim(); if (txt) out.push({type:'text', text:txt}); }
  }
  return out;
}

function htmlToSpec(html, {pageWidthPt, pageHeightPt, unitDefault='px', defaultFontTag}){
  const toks = tokenize(html);
  const spec = { unit:'pt', items: [] };
  for (let i=0;i<toks.length;i++){
    const t=toks[i]; if (t.type!=='tag') continue;
    const style = parseStyle(t.attrs.style||''); const unitHint=(t.attrs['data-unit']||'').toLowerCase()||unitDefault;
    const L=parseDim(style.left, unitHint), T=parseDim(style.top, unitHint), W=parseDim(style.width, unitHint), H=parseDim(style.height, unitHint);
    const x=toPt(L.v,L.u), yTop=toPt(T.v,T.u), w=toPt(W.v,W.u), h=toPt(H.v,H.u), y=pageHeightPt - yTop - h;
    const color=parseColor(style.color), bg=parseColor(style['background']||style['background-color']);
    let stroke=null, sw=1; if (style['border']||style['border-color']||style['border-width']){ stroke=parseColor(style['border-color'])||[0,0,0]; const bw=parseDim(style['border-width']||'1px', unitHint); sw=toPt(bw.v,bw.u); }
    const fs = style['font-size'] ? toPt(parseDim(style['font-size'], unitHint).v, unitHint) : undefined;

    // textFit
    if (t.attrs['data-pdf-textfit']!==undefined){
      let text=(t.attrs['data-text']||'').trim(); if(!text && toks[i+1] && toks[i+1].type==='text') text=toks[i+1].text;
      spec.items.push({type:'textFit', t:text, x,y,w,h, min:Number(t.attrs['data-min']||8), max:Number(t.attrs['data-max']|| (fs||24)), color:color||[0,0,0], font:defaultFontTag});
      continue;
    }
    // text
    if (t.attrs['data-pdf-text']!==undefined){
      let text=(t.attrs['data-text']||'').trim(); if(!text && toks[i+1] && toks[i+1].type==='text') text=toks[i+1].text;
      spec.items.push({type:'text', t:text, x, y: y + (h>0 ? (h - (fs||12))/2 : 0), size: fs||12, color:color||[0,0,0], font:defaultFontTag});
      continue;
    }
    // image
    if (t.name==='img' && (t.attrs['data-pdf-image']!==undefined)){
      const src=t.attrs.src||''; if (src) spec.items.push({type:'image', src, x,y,w,h});
      continue;
    }
    // rect
    if (t.attrs['data-pdf-rect']!==undefined || bg || stroke){
      spec.items.push({type:'rect', x,y,w,h, fill:bg||null, stroke:stroke||null, sw});
    }
  }
  return spec;
}

module.exports = { htmlToSpec };
