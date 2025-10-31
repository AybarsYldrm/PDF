// fitfak_pdf_core.js
const fs = require('fs');
const zlib = require('zlib');

/* ---------- sabitler / yardımcılar ---------- */
const PT_PER_MM = 72 / 25.4;
const PT_PER_PX = 72 / 96;
const clamp255 = v => Math.max(0, Math.min(255, v));
const fnum = n => Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/\.?0+$/, '');
const rgb  = (r,g,b) => `${(clamp255(r)/255).toFixed(3)} ${(clamp255(g)/255).toFixed(3)} ${(clamp255(b)/255).toFixed(3)}`;
const esc  = t => String(t).replace(/([()\\])/g,'\\$1');
const toPt = (v,u='pt') => u==='pt'?v : u==='mm'? v*(72/25.4) : u==='px'? v*(72/96) : v;

function utf16Hex(s){
  const b = Buffer.alloc(2 + s.length*2);
  b.writeUInt16BE(0xFEFF,0);
  let o=2; for(const ch of s){ b.writeUInt16BE(ch.codePointAt(0), o); o+=2; }
  return '<'+b.toString('hex').toUpperCase()+'>';
}

/* ---------- PDF çekirdeği ---------- */
class PDFDoc {
  constructor({ title='Untitled', author='Node', compress=true }={}){
    this.compress = compress;
    this.objects  = [];
    this.offsets  = [];
    this.pages    = [];
    this.pagesKids= [];
    this.nextId   = 1;
    this.info     = { title, author };
    this.catalogId = null;
    this.pagesTreeId = null;
    this.fonts = {};
    this.extGStates = {};
    this._gsCount = 1;
    // Base14 fallback (sadece ASCII)
    this.fonts.F1 = this._addObject(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);
  }

  addPage({width=595.28,height=841.89}={}){
    const streamBuffer = [];
    const resourcesId = this._addObject(this._resourcesDict());
    const contentsId  = this._addObject('stream_placeholder');
    const pageId = this._addObject(`<<
/Type /Page
/Parent 0 0 R
/MediaBox [0 0 ${fnum(width)} ${fnum(height)}]
/Resources ${resourcesId} 0 R
/Contents ${contentsId} 0 R
>>`);
    this.pages.push({pageId, contentsId, resourcesId, width, height, streamBuffer});
    this.pagesKids.push(`${pageId} 0 R`);
    return this.pages.length - 1;
  }

  /* drawing */
  cmd(p, s){ const pg=this.pages[p]; if(!pg) throw Error('Geçersiz sayfa'); pg.streamBuffer.push(s); }
  setFillColor(p,r,g,b){ this.cmd(p, `${rgb(r,g,b)} rg`); }
  setStrokeColor(p,r,g,b){ this.cmd(p, `${rgb(r,g,b)} RG`); }
  setLineWidth(p,w){ this.cmd(p, `${fnum(w)} w`); }
  rect(p,x,y,w,h){ this.cmd(p, `${fnum(x)} ${fnum(y)} ${fnum(w)} ${fnum(h)} re`); }
  fill(p){ this.cmd(p, 'f'); }
  stroke(p){ this.cmd(p, 'S'); }
  fillStroke(p){ this.cmd(p, 'B'); }

  drawRect(p,x,y,w,h,{fillColor=null,strokeColor=null,strokeWidth=1}={}){
    if (fillColor) this.setFillColor(p, ...fillColor);
    if (strokeColor){ this.setStrokeColor(p, ...strokeColor); this.setLineWidth(p, strokeWidth); }
    this.rect(p,x,y,w,h);
    if (fillColor && strokeColor) this.fillStroke(p);
    else if (fillColor) this.fill(p);
    else if (strokeColor) this.stroke(p);
  }

  drawRoundedRect(p,x,y,w,h,{fillColor=null,strokeColor=null,strokeWidth=1,radius=0}={}){
    const r = Math.max(0, Math.min(radius || 0, Math.min(w,h)/2));
    if (r <= 0){ this.drawRect(p,x,y,w,h,{fillColor,strokeColor,strokeWidth}); return; }
    const cmds = this._roundedRectPath(x,y,w,h,r);
    this._paintPath(p, cmds, {fillColor, strokeColor, strokeWidth});
  }

  _paintPath(p, cmds, {fillColor=null, strokeColor=null, strokeWidth=1}={}){
    if (fillColor) this.setFillColor(p, ...fillColor);
    if (strokeColor){ this.setStrokeColor(p, ...strokeColor); this.setLineWidth(p, strokeWidth); }
    this.cmd(p, cmds.join('\n'));
    if (fillColor && strokeColor) this.fillStroke(p);
    else if (fillColor) this.fill(p);
    else if (strokeColor) this.stroke(p);
  }

  _roundedRectPath(x,y,w,h,r){
    const k = 0.552284749831;
    const c = r * k;
    const cmds = [];
    cmds.push(`${fnum(x+r)} ${fnum(y)} m`);
    cmds.push(`${fnum(x+w-r)} ${fnum(y)} l`);
    cmds.push(`${fnum(x+w-r+c)} ${fnum(y)} ${fnum(x+w)} ${fnum(y+c)} ${fnum(x+w)} ${fnum(y+r)} c`);
    cmds.push(`${fnum(x+w)} ${fnum(y+h-r)} l`);
    cmds.push(`${fnum(x+w)} ${fnum(y+h-r+c)} ${fnum(x+w-r+c)} ${fnum(y+h)} ${fnum(x+w-r)} ${fnum(y+h)} c`);
    cmds.push(`${fnum(x+r)} ${fnum(y+h)} l`);
    cmds.push(`${fnum(x+r-c)} ${fnum(y+h)} ${fnum(x)} ${fnum(y+h-r+c)} ${fnum(x)} ${fnum(y+h-r)} c`);
    cmds.push(`${fnum(x)} ${fnum(y+r)} l`);
    cmds.push(`${fnum(x)} ${fnum(y+r-c)} ${fnum(x+r-c)} ${fnum(y)} ${fnum(x+r)} ${fnum(y)} c`);
    cmds.push('h');
    return cmds;
  }

  drawTextSimple(p,text,x,y,{size=12,color=null,fontTag='F1'}={}){
    const a=['BT', `/${fontTag} ${fnum(size)} Tf`, `${fnum(x)} ${fnum(y)} Td`];
    if (color) a.push(`${rgb(...color)} rg`);
    a.push(`(${esc(text)}) Tj`, 'ET');
    this.cmd(p, a.join('\n'));
  }

  drawTextU16(p,text,x,y,{size=12,color=null,fontTag='F1'}={}){
    const a=['BT', `/${fontTag} ${fnum(size)} Tf`, `${fnum(x)} ${fnum(y)} Td`];
    if (color) a.push(`${rgb(...color)} rg`);
    a.push(`${utf16Hex(text)} Tj`, 'ET');
    this.cmd(p, a.join('\n'));
  }

  drawImageXObject(p, name, x,y,w,h){
    this.cmd(p, ['q', `${fnum(w)} 0 0 ${fnum(h)} ${fnum(x)} ${fnum(y)} cm`, `/${name} Do`, 'Q'].join('\n'));
  }

  addXObjectImage(name, objId, pageIndex){
    const pg = this.pages[pageIndex];
    const res = this.objects.find(o => o.id===pg.resourcesId);
    res.data = res.data.replace('/XObject << >>', `/XObject << /${name} ${objId} 0 R >>`);
  }

  save(outPath){
    this.pagesTreeId = this._addObject(`<< /Type /Pages /Kids [ ${this.pagesKids.join(' ')} ] /Count ${this.pagesKids.length} >>`);
    this.catalogId   = this._addObject(`<< /Type /Catalog /Pages ${this.pagesTreeId} 0 R >>`);
    const infoId = this._addObject(`<<
/Producer (FITFAK Node PDF)
/Creator (Node)
/Title (${esc(this.info.title)})
/Author (${esc(this.info.author)})
>>`);

    for(const o of this.objects){
      if (typeof o.data==='string' && o.data.includes('/Type /Page')) {
        o.data = o.data.replace('/Parent 0 0 R', `/Parent ${this.pagesTreeId} 0 R`);
      }
    }
    for(const pg of this.pages){
      const content = Buffer.from(pg.streamBuffer.join('\n')+'\n');
      const body = this.compress ? zlib.deflateSync(content) : content;
      const head = `<< /Length ${body.length}${this.compress? ' /Filter /FlateDecode':''} >>\nstream\n`;
      const payload = Buffer.concat([Buffer.from(head), body, Buffer.from('\nendstream')]);
      const idx = this.objects.findIndex(o => o.id===pg.contentsId);
      this.objects[idx].data = payload;
    }

    const chunks = []; const header = Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');
    chunks.push(header); let offset = header.length; this.offsets=[0];
    for(const {id,data} of this.objects){
      const head = Buffer.from(`${id} 0 obj\n`);
      const body = Buffer.isBuffer(data)? data : Buffer.from(String(data));
      const end  = Buffer.from('\nendobj\n');
      this.offsets[id]=offset;
      chunks.push(head, body, end);
      offset += head.length + body.length + end.length;
    }
    const xrefStart = offset;
    const xref = ['xref', `0 ${this.nextId}`, '0000000000 65535 f '];
    for(let i=1;i<this.nextId;i++) xref.push(`${String(this.offsets[i]||0).padStart(10,'0')} 00000 n `);
    chunks.push(Buffer.from(xref.join('\n')+'\n'));
    const trailer = Buffer.from(`trailer
<< /Size ${this.nextId} /Root ${this.catalogId} 0 R /Info ${infoId} 0 R >>
startxref
${xrefStart}
%%EOF`);
    chunks.push(trailer);
    fs.writeFileSync(outPath, Buffer.concat(chunks));
  }

  /* kaynak yardımcıları */
  _resourcesDict(){
    const fontEntries = Object.entries(this.fonts).map(([k,id])=>`/${k} ${id} 0 R`).join(' ');
    const gStateEntries = Object.values(this.extGStates).map(gs => `/${gs.name} ${gs.id} 0 R`).join(' ');
    const parts = ['<<'];
    parts.push(`/Font << ${fontEntries} >>`);
    parts.push('/XObject << >>');
    if (gStateEntries) parts.push(`/ExtGState << ${gStateEntries} >>`);
    parts.push('>>');
    return parts.join(' ');
  }
  _addObject(s){ const id=this.nextId++; this.objects.push({id,data:String(s)}); return id; }
  _addObjectRaw(b){ const id=this.nextId++; this.objects.push({id,data:b}); return id; }
  _allocFontTag(){ let i=1; while(this.fonts['F'+i]) i++; return 'F'+i; }
  _allocGStateTag(){ const name = 'GS'+this._gsCount++; return name; }

  _ensureExtGState({ fillAlpha=1, strokeAlpha=1 }={}){
    const f = Number.isFinite(fillAlpha) ? Math.max(0, Math.min(1, fillAlpha)) : 1;
    const s = Number.isFinite(strokeAlpha) ? Math.max(0, Math.min(1, strokeAlpha)) : f;
    const key = `${f.toFixed(3)}_${s.toFixed(3)}`;
    if (this.extGStates[key]) return this.extGStates[key];
    const parts = ['<< /Type /ExtGState'];
    if (f < 1) parts.push(`/ca ${fnum(f)}`);
    if (s < 1) parts.push(`/CA ${fnum(s)}`);
    parts.push('>>');
    const objId = this._addObject(parts.join(' '));
    const name = this._allocGStateTag();
    const gs = { id: objId, name, fillAlpha: f, strokeAlpha: s };
    this.extGStates[key] = gs;
    this._propagateExtGState(gs);
    return gs;
  }

  _propagateExtGState(gs){
    const token = `/${gs.name} ${gs.id} 0 R`;
    for (const pg of this.pages){
      const res = this.objects.find(o => o.id === pg.resourcesId);
      if (!res) continue;
      let data = String(res.data);
      if (data.includes(token)) continue;
      if (data.includes('/ExtGState')){
        res.data = data.replace('/ExtGState <<', `/ExtGState << ${token} `);
      } else {
        const idx = data.lastIndexOf('>>');
        if (idx !== -1) res.data = data.slice(0, idx) + ` /ExtGState << ${token} >> >>`;
      }
    }
  }

  /* TTF kayıt + gömme (Type0/CIDFontType2 + ToUnicode) */
  registerTTF(tag, ttfPath){
    const ttf = fs.readFileSync(ttfPath);
    const parsed = TTF.parse(ttf);
    const toUniId = this._addObject(TTF.makeToUnicodeCMap(tag));
    const fontFile2Id = this._addObjectRaw(Buffer.concat([
      Buffer.from(`<< /Length ${ttf.length} /Length1 ${ttf.length} /Filter /FlateDecode >>\nstream\n`),
      zlib.deflateSync(ttf), Buffer.from('\nendstream')
    ]));
    const fdId = this._addObject(`<<
/Type /FontDescriptor
/FontName /${tag}
/Flags 32
/ItalicAngle 0
/Ascent ${parsed.ascent}
/Descent ${parsed.descent}
/CapHeight ${parsed.ascent}
/StemV 80
/FontFile2 ${fontFile2Id} 0 R
>>`);
    const cidId = this._addObject(`<<
/Type /Font /Subtype /CIDFontType2
/BaseFont /${tag}
/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>
/FontDescriptor ${fdId} 0 R
>>`);
    const type0Id = this._addObject(`<<
/Type /Font /Subtype /Type0
/BaseFont /${tag}
/Encoding /Identity-H
/DescendantFonts [ ${cidId} 0 R ]
/ToUnicode ${toUniId} 0 R
>>`);
    const fontTag = this._allocFontTag();
    this.fonts[fontTag] = type0Id;
    return { fontTag, metrics: parsed };
  }
}

/* ---------- PNG (alfa/SMask) ---------- */
class PNGImage {
  static parse(buf){
    const sig = Buffer.from([137,80,78,71,13,10,26,10]);
    if (!buf.subarray(0,8).equals(sig)) throw Error('PNG imzası geçersiz');
    let pos=8;
    let width=0,height=0,bitDepth=8,colorType=2,palette=null,trns=null, interlace=0;
    const idats=[];
    while(pos<buf.length){
      const len = buf.readUInt32BE(pos); pos+=4;
      const type = buf.toString('ascii', pos, pos+4); pos+=4;
      const data = buf.subarray(pos, pos+len); pos+=len; pos+=4; // crc skip
      if (type==='IHDR'){
        width=data.readUInt32BE(0); height=data.readUInt32BE(4);
        bitDepth=data[8]; colorType=data[9];
        if (data[10]!==0 || data[11]!==0) throw Error('Desteklenmeyen compression/filter');
        interlace=data[12]; if (interlace===1) throw Error('Adam7 desteklenmiyor');
      } else if (type==='PLTE'){ palette=Buffer.from(data); }
      else if (type==='tRNS'){ trns=Buffer.from(data); }
      else if (type==='IDAT'){ idats.push(data); }
      else if (type==='IEND'){ break; }
    }
    const zlibData = Buffer.concat(idats);
    const channels = ({0:1,2:3,3:1,4:2,6:4})[colorType]||3;
    const hasAlpha = (colorType===4||colorType===6)||(colorType===3&&trns);
    let csName='/DeviceRGB'; if(colorType===0) csName='/DeviceGray';
    if (colorType===3) csName=`[/Indexed /DeviceRGB ${(palette.length/3)-1} <${palette.toString('hex')}>]`;
    if (!hasAlpha) return { width,height,bitDepth,colorType, zlibData, csName, smaskZlib:null };

    const inflated = zlib.inflateSync(zlibData);
    const stride = Math.ceil((bitDepth*channels*width)/8);
    const bytesPerSample = Math.max(1, Math.ceil(bitDepth/8));
    const outRGB = Buffer.alloc(width*height*(colorType===4?1:3));
    const outA   = Buffer.alloc(width*height);
    let inPos=0, rowRGBpos=0, rowApos=0, prevRecon=null;
    const bpp = Math.max(1, Math.ceil((bitDepth*channels)/8));
    for(let y=0;y<height;y++){
      const ft = inflated[inPos++]; const row=inflated.subarray(inPos, inPos+stride); inPos+=stride;
      const recon = PNGImage._unfilter(ft, row, prevRecon, bpp); prevRecon = recon;
      if (colorType===4){ // GA
        let i=0; for(let x=0;x<width;x++){ outRGB[rowRGBpos+x]=recon[i]; i+=bytesPerSample; outA[rowApos+x]=recon[i]; i+=bytesPerSample; }
        rowRGBpos+=width; rowApos+=width;
      } else if (colorType===6){ // RGBA
        let i=0; for(let x=0;x<width;x++){ const off=rowRGBpos+x*3; outRGB[off]=recon[i]; outRGB[off+1]=recon[i+1]; outRGB[off+2]=recon[i+2]; outA[rowApos+x]=recon[i+3]; i+=4*bytesPerSample; }
        rowRGBpos+=width*3; rowApos+=width;
      } else if (colorType===3 && trns){ // indexed + tRNS
        for(let x=0;x<width;x++){ const idx=recon[x]; const off=rowRGBpos+x*3; outRGB[off]=palette[idx*3]; outRGB[off+1]=palette[idx*3+1]; outRGB[off+2]=palette[idx*3+2]; outA[rowApos+x]= idx<trns.length? trns[idx]:255; }
        rowRGBpos+=width*3; rowApos+=width;
      }
    }
    const mainZ=zlib.deflateSync(outRGB), maskZ=zlib.deflateSync(outA);
    csName = (colorType===4)? '/DeviceGray' : '/DeviceRGB';
    return { width,height,bitDepth,colorType, zlibData:mainZ, csName, smaskZlib:maskZ };
  }
  static _unfilter(ft, row, prev, bpp){
    const line = Buffer.alloc(row.length);
    if (ft===0){ row.copy(line); return line; }
    if (ft===1){ for(let i=0;i<row.length;i++){ const left=i>=bpp? line[i-bpp]:0; line[i]=(row[i]+left)&255; } return line; }
    if (ft===2){ for(let i=0;i<row.length;i++){ const up=prev? prev[i]:0; line[i]=(row[i]+up)&255; } return line; }
    if (ft===3){ for(let i=0;i<row.length;i++){ const left=i>=bpp? line[i-bpp]:0; const up=prev? prev[i]:0; line[i]=(row[i]+Math.floor((left+up)/2))&255; } return line; }
    if (ft===4){
      const paeth=(a,b,c)=>{ const p=a+b-c; const pa=Math.abs(p-a), pb=Math.abs(p-b), pc=Math.abs(p-c); return (pa<=pb && pa<=pc)?a: (pb<=pc?b:c); };
      for(let i=0;i<row.length;i++){ const a=i>=bpp? line[i-bpp]:0; const b=prev? prev[i]:0; const c=(prev && i>=bpp)? prev[i-bpp]:0; line[i]=(row[i]+paeth(a,b,c))&255; }
      return line;
    }
    throw Error('PNG filtresi desteklenmiyor: '+ft);
  }
}

/* ---------- TTF parser (cmap4 + hhea + head + hmtx) ---------- */
class TTF {
  static parse(buf){
    const tab = TTF._dir(buf);
    const head = TTF._head(buf, tab.head);
    const hhea = TTF._hhea(buf, tab.hhea);
    const cmap = TTF._cmap4(buf, tab.cmap);
    const hmtx = TTF._hmtx(buf, tab.hmtx, hhea);
    return {
      unitsPerEm: head.unitsPerEm,
      ascent: hhea.ascent,
      descent: hhea.descent,
      cmap, hmtx,
      textWidth: (text, size)=>{
        let aw=0;
        for(const ch of text){ const gid=cmap[ch.codePointAt(0)]||0; aw += (hmtx[gid] ?? hmtx[hmtx.length-1] ?? 0); }
        return aw * (size / head.unitsPerEm);
      }
    };
  }
  static makeToUnicodeCMap(name){
    return `<< /Length 300 >>\nstream
/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> def
/CMapName /${name} def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
1 beginbfrange
<0000> <FFFF> <0000>
endbfrange
endcmap
CMapName currentdict /CMap defineresource pop
end
end
endstream`;
  }
  static _dir(buf){ const n=buf.readUInt16BE(4); const out={}; let p=12; for(let i=0;i<n;i++){ const tag=buf.toString('ascii',p,p+4); p+=4; p+=4; const off=buf.readUInt32BE(p); p+=4; const len=buf.readUInt32BE(p); p+=4; out[tag]={offset:off,length:len}; } return out; }
  static _head(buf,t){ const p=t.offset; return { unitsPerEm: buf.readUInt16BE(p+18), indexToLocFormat: buf.readInt16BE(p+50) }; }
  static _hhea(buf,t){ const p=t.offset; return { ascent:buf.readInt16BE(p+4), descent:buf.readInt16BE(p+6), numberOfHMetrics:buf.readUInt16BE(p+34), offset:p }; }
  static _cmap4(buf,t){
    let p=t.offset; p+=2; const num=buf.readUInt16BE(p); p+=2; let sub=null;
    for(let i=0;i<num;i++){ const plat=buf.readUInt16BE(p); p+=2; const enc=buf.readUInt16BE(p); p+=2; const off=buf.readUInt32BE(p); p+=4; if(plat===3 && (enc===1||enc===10)) sub=t.offset+off; }
    if(!sub) return {};
    let q=sub; const fmt=buf.readUInt16BE(q); q+=2; if(fmt!==4) return {}; const len=buf.readUInt16BE(q); q+=2; q+=2;
    const segCount = buf.readUInt16BE(q)/2; q+=2; q+=6;
    const endCodes=[]; for(let i=0;i<segCount;i++){ endCodes.push(buf.readUInt16BE(q)); q+=2; }
    q+=2;
    const startCodes=[]; for(let i=0;i<segCount;i++){ startCodes.push(buf.readUInt16BE(q)); q+=2; }
    const idDeltas=[]; for(let i=0;i<segCount;i++){ idDeltas.push(buf.readInt16BE(q)); q+=2; }
    const idROffPos=q; const idRangeOffsets=[];
    for(let i=0;i<segCount;i++){ idRangeOffsets.push(buf.readUInt16BE(q)); q+=2; }
    const map={};
    for(let i=0;i<segCount;i++){
      const s=startCodes[i], e=endCodes[i], d=idDeltas[i], ro=idRangeOffsets[i];
      for(let c=s;c<=e;c++){
        let gid=0;
        if(ro===0){ gid=(c+d)&0xFFFF; }
        else{
          const roff = idROffPos + i*2 + ro;
          const idx  = roff + (c-s)*2;
          gid = buf.readUInt16BE(idx); if(gid!==0) gid=(gid+d)&0xFFFF;
        }
        map[c]=gid;
      }
    }
    return map;
  }
  static _hmtx(buf,t,hhea){
    const p=t.offset; const n=hhea.numberOfHMetrics; const aw=[]; let q=p;
    for(let i=0;i<n;i++){ aw.push(buf.readUInt16BE(q)); q+=4; }
    return aw;
  }
}

/* ---------- Canvas & Renderer ---------- */
class Canvas {
  constructor(pdf, pageIndex){ this.pdf=pdf; this.p=pageIndex; const pg=pdf.pages[pageIndex]; this.W=pg.width; this.H=pg.height; this.state={font:'F1', metrics:null}; }
  setFont(fontTag, metrics){ this.state.font=fontTag; this.state.metrics=metrics; }
  text({t,x,y,sz=12,c=null,font,alpha=1}){
    const tag = font||this.state.font;
    const useAlpha = alpha !== undefined && alpha < 1;
    let gs=null;
    if (useAlpha){
      gs = this.pdf._ensureExtGState({ fillAlpha: alpha, strokeAlpha: alpha });
      this.pdf.cmd(this.p,'q');
      this.pdf.cmd(this.p,`/${gs.name} gs`);
    }
    if (tag==='F1') this.pdf.drawTextSimple(this.p, t, x, y, {size:sz, color:c, fontTag:tag});
    else            this.pdf.drawTextU16  (this.p, t, x, y, {size:sz, color:c, fontTag:tag});
    if (useAlpha) this.pdf.cmd(this.p,'Q');
  }
  textFit({t,x,y,w,h,min=8,max=72,c=null,font,alpha=1}){
    const tag=font||this.state.font, m=this.state.metrics;
    if (!m){ let sz=max, tw=t.length*sz*0.5; while(tw>w && sz>min){ sz-=0.5; tw=t.length*sz*0.5; } this.text({t,x:x+(w-tw)/2,y:y+(h-sz)/2,sz,c,font:tag,alpha}); return sz; }
    let lo=min, hi=max, best=min;
    while(hi-lo>0.5){ const mid=(hi+lo)/2, tw=m.textWidth(t, mid); if (tw<=w){ best=mid; lo=mid; } else hi=mid; }
    const tw=m.textWidth(t,best); const base=y+(h-best)/2;
    this.text({t, x:x+(w-tw)/2, y:base, sz:best, c, font:tag, alpha}); return best;
  }
  rect({x,y,w,h,fill=null,stroke=null,sw=1,alpha=1,alphaStroke=1,radius=0}){
    const hasFill = Array.isArray(fill);
    const hasStroke = Array.isArray(stroke);
    const useAlpha = (hasFill && alpha < 1) || (hasStroke && alphaStroke < 1);
    let gs=null;
    if (useAlpha){
      gs = this.pdf._ensureExtGState({ fillAlpha: hasFill?alpha:1, strokeAlpha: hasStroke?alphaStroke:1 });
      this.pdf.cmd(this.p,'q');
      this.pdf.cmd(this.p,`/${gs.name} gs`);
    }
    if (radius){ this.pdf.drawRoundedRect(this.p, x,y,w,h,{fillColor:fill, strokeColor:stroke, strokeWidth:sw, radius}); }
    else this.pdf.drawRect(this.p, x,y,w,h, {fillColor:fill, strokeColor:stroke, strokeWidth:sw});
    if (useAlpha) this.pdf.cmd(this.p,'Q');
  }
  frame({m=20, color=[3,50,72], sw=4}={}){ this.pdf.setStrokeColor(this.p,...color); this.pdf.setLineWidth(this.p,sw);
    const x0=m,y0=m,x1=this.W-m,y1=this.H-m; this.pdf.cmd(this.p,`${fnum(x0)} ${fnum(y0)} m`); this.pdf.cmd(this.p,`${fnum(x1)} ${fnum(y0)} l`);
    this.pdf.cmd(this.p,`${fnum(x1)} ${fnum(y1)} l`); this.pdf.cmd(this.p,`${fnum(x0)} ${fnum(y1)} l`); this.pdf.cmd(this.p,`${fnum(x0)} ${fnum(y0)} l`); this.pdf.cmd(this.p,'S'); }
  imagePNG({path,x,y,w,h,name}){ const buf=fs.readFileSync(path); const png=PNGImage.parse(buf);
    const head=`<<
/Type /XObject /Subtype /Image
/Width ${png.width} /Height ${png.height}
/ColorSpace ${png.csName}
/BitsPerComponent ${png.bitDepth}
/Filter /FlateDecode
>>\nstream\n`;
    const imgObj = Buffer.concat([Buffer.from(head), png.zlibData, Buffer.from('\nendstream')]);
    const objId = this.pdf._addObjectRaw(imgObj);
    const xName = name || Canvas._uniqueName(this.pdf, this.p);
    this.pdf.addXObjectImage(xName, objId, this.p);
    if (png.smaskZlib){
      const smHead=`<< /Type /XObject /Subtype /Image /Width ${png.width} /Height ${png.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode >>\nstream\n`;
      const smObj = Buffer.concat([Buffer.from(smHead), png.smaskZlib, Buffer.from('\nendstream')]);
      const smId  = this.pdf._addObjectRaw(smObj);
      const xObj  = this.pdf.objects.find(o=>o.id===objId);
      xObj.data = Buffer.from(xObj.data.toString().replace('>>\nstream', ` /SMask ${smId} 0 R >>\nstream`));
    }
    this.pdf.drawImageXObject(this.p, xName, x,y,w,h);
  }
  static _uniqueName(pdf,p){ let i=1; for(;;){ const n=`Im${i}`; const res=pdf.objects.find(o=>o.id===pdf.pages[p].resourcesId); if(!String(res.data).includes(`/${n} `)) return n; i++; } }
}

class Renderer {
  constructor(pdf, pageIndex, canvas){ this.pdf=pdf; this.p=pageIndex; this.cv=canvas; }
  run(spec){ const unit=spec.unit||'pt'; if (Array.isArray(spec.items)) for(const it of spec.items) this._it(it, unit); }
  _it(it,unit){
    const T=it.type;
    if (T==='rect'){
      this.cv.rect({
        x:toPt(it.x,unit),
        y:toPt(it.y,unit),
        w:toPt(it.w,unit),
        h:toPt(it.h,unit),
        fill:it.fill||null,
        stroke:it.stroke||null,
        sw:it.sw||1,
        alpha: it.alpha !== undefined ? it.alpha : 1,
        alphaStroke: it.alphaStroke !== undefined ? it.alphaStroke : (it.alpha !== undefined ? it.alpha : 1),
        radius: it.radius || 0
      });
    }
    else if (T==='strokeRect'){
      this.cv.rect({
        x:toPt(it.x,unit),
        y:toPt(it.y,unit),
        w:toPt(it.w,unit),
        h:toPt(it.h,unit),
        fill:null,
        stroke:it.stroke||[0,0,0],
        sw:it.sw||1,
        alpha:1,
        alphaStroke: it.alpha !== undefined ? it.alpha : 1,
        radius: it.radius || 0
      });
    }
    else if (T==='text'){
      this.cv.text({t:it.t, x:toPt(it.x,unit), y:toPt(it.y,unit), sz:it.size||12, c:it.color||null, font:it.font, alpha: it.alpha !== undefined ? it.alpha : 1});
    }
    else if (T==='textFit'){
      this.cv.textFit({t:it.t, x:toPt(it.x,unit), y:toPt(it.y,unit), w:toPt(it.w,unit), h:toPt(it.h,unit), min:it.min||8, max:it.max||48, c:it.color||null, font:it.font, alpha: it.alpha !== undefined ? it.alpha : 1});
    }
    else if (T==='image'){
      this.cv.imagePNG({path:it.src, x:toPt(it.x,unit), y:toPt(it.y,unit), w:toPt(it.w,unit), h:toPt(it.h,unit)});
    }
    else if (T==='group' && Array.isArray(it.items)) for(const c of it.items) this._it(c,unit);
  }
}

module.exports = { PDFDoc, PNGImage, TTF, Canvas, Renderer, PT_PER_MM, PT_PER_PX, toPt };
