'use strict';

const fs = require('fs');
const path = require('path');
const { PT_PER_MM, PT_PER_PX, PNGImage } = require('./core');

const PT_PER_CM = PT_PER_MM * 10;
const PT_PER_IN = 72;

const VOID_ELEMENTS = new Set(['br','hr','img','meta','input','link','source','area','base','col','embed','param','track','wbr']);

const NAMED_SIZES = {
  a4: { width: PT_PER_MM * 210, height: PT_PER_MM * 297 },
  'a4-landscape': { width: PT_PER_MM * 297, height: PT_PER_MM * 210 },
  a3: { width: PT_PER_MM * 297, height: PT_PER_MM * 420 },
  letter: { width: PT_PER_IN * 8.5, height: PT_PER_IN * 11 },
  'letter-landscape': { width: PT_PER_IN * 11, height: PT_PER_IN * 8.5 },
};

function clamp255(v){ return Math.max(0, Math.min(255, v)); }

function parseColor(input){
  if (!input) return null;
  const txt = String(input).trim();
  if (!txt) return null;
  const hex = txt.match(/^#([0-9a-f]{3,8})$/i);
  if (hex){
    let h = hex[1];
    if (h.length === 3) h = h.split('').map(ch => ch+ch).join('');
    if (h.length === 4) h = h.split('').map(ch => ch+ch).join('');
    const r = parseInt(h.slice(0,2),16);
    const g = parseInt(h.slice(2,4),16);
    const b = parseInt(h.slice(4,6),16);
    const a = h.length>=8 ? parseInt(h.slice(6,8),16)/255 : 1;
    return { r, g, b, a };
  }
  const rgb = txt.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (rgb){
    const r = clamp255(parseFloat(rgb[1]));
    const g = clamp255(parseFloat(rgb[2]));
    const b = clamp255(parseFloat(rgb[3]));
    const a = rgb[4] !== undefined ? Math.max(0, Math.min(1, parseFloat(rgb[4]))) : 1;
    return { r, g, b, a };
  }
  return null;
}

function parseStyle(str){
  const out = {};
  if (!str) return out;
  const parts = String(str).split(';');
  for (const raw of parts){
    const idx = raw.indexOf(':');
    if (idx === -1) continue;
    const key = raw.slice(0, idx).trim().toLowerCase();
    if (!key) continue;
    const val = raw.slice(idx+1).trim();
    if (!val) continue;
    out[key] = val;
  }
  return out;
}

function parseLength(value, { base=0, fontSize=16, allowAuto=true }={}){
  if (value === undefined || value === null) return null;
  const str = String(value).trim();
  if (!str) return null;
  if (allowAuto && str === 'auto') return 'auto';
  const percent = str.match(/^(-?[\d.]+)%$/);
  if (percent) return { type:'percent', value: parseFloat(percent[1]) };
  const unit = str.match(/^(-?[\d.]+)([a-zA-Z]*)$/);
  if (!unit) return null;
  const num = parseFloat(unit[1]);
  const u = unit[2].toLowerCase();
  if (!u || u === 'pt') return num;
  if (u === 'px') return num * PT_PER_PX;
  if (u === 'mm') return num * PT_PER_MM;
  if (u === 'cm') return num * PT_PER_CM;
  if (u === 'in') return num * PT_PER_IN;
  if (u === 'em') return num * fontSize;
  if (u === 'rem') return num * fontSize;
  if (u === 'vh') return { type:'vh', value: num };
  if (u === 'vw') return { type:'vw', value: num };
  if (u === '') return num;
  return num;
}

function resolveLength(len, { base=0, fontSize=16, viewportWidth=0, viewportHeight=0 }){
  if (len === null) return null;
  if (len === 'auto') return 'auto';
  if (typeof len === 'number') return len;
  if (len.type === 'percent') return base * len.value / 100;
  if (len.type === 'vh') return viewportHeight * len.value / 100;
  if (len.type === 'vw') return viewportWidth * len.value / 100;
  return null;
}

function parseShorthand(value){
  if (!value) return [0,0,0,0];
  const parts = value.trim().split(/\s+/).map(v => v.trim());
  if (!parts.length) return [0,0,0,0];
  if (parts.length === 1) return [parts[0], parts[0], parts[0], parts[0]];
  if (parts.length === 2) return [parts[0], parts[1], parts[0], parts[1]];
  if (parts.length === 3) return [parts[0], parts[1], parts[2], parts[1]];
  return [parts[0], parts[1], parts[2], parts[3]];
}

function parseBoxEdges(style, prefix, ctx){
  const shorthand = parseShorthand(style[prefix] || style[`${prefix}-block`] || '');
  const top    = parseLength(style[`${prefix}-top`]    ?? shorthand[0], ctx);
  const right  = parseLength(style[`${prefix}-right`]  ?? shorthand[1], ctx);
  const bottom = parseLength(style[`${prefix}-bottom`] ?? shorthand[2], ctx);
  const left   = parseLength(style[`${prefix}-left`]   ?? shorthand[3], ctx);
  return { top, right, bottom, left };
}

function parseBorder(style, ctx){
  const width = parseLength(style['border-width'] || '0', ctx) || 0;
  const color = parseColor(style['border-color']);
  const radius = parseLength(style['border-radius'] || '0', ctx) || 0;
  return { width, color, radius };
}

function mergeStyles(target, source){
  for (const [k,v] of Object.entries(source||{})) target[k] = v;
}

function parseAttributes(str){
  const attrs = {};
  if (!str) return attrs;
  const re = /([:\w-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>/]+)))?/g;
  let m;
  while((m = re.exec(str))){
    const name = m[1].toLowerCase();
    const val = m[3] ?? m[4] ?? m[5] ?? '';
    attrs[name] = val;
  }
  return attrs;
}

function parseHTML(html){
  const root = { type:'element', name:'root', attrs:{}, children:[], parent:null };
  const stack = [root];
  const re = /<(\/)?([a-zA-Z0-9:-]+)([^>]*)>|([^<]+)/gms;
  let m;
  while((m = re.exec(html))){
    if (m[4]){
      const text = m[4].replace(/\s+/g, ' ');
      if (text.trim()){
        const parent = stack[stack.length-1];
        parent.children.push({ type:'text', text: text.trim(), parent });
      }
      continue;
    }
    const closing = !!m[1];
    const name = m[2].toLowerCase();
    const attrStr = m[3] || '';
    if (closing){
      while(stack.length>1){
        const top = stack.pop();
        if (top.name === name) break;
      }
      continue;
    }
    const attrs = parseAttributes(attrStr);
    const selfClosing = /\/$/.test(attrStr) || VOID_ELEMENTS.has(name);
    const parent = stack[stack.length-1];
    const node = { type:'element', name, attrs, children:[], parent };
    parent.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

function collectStyleBlocks(node, list){
  if (!list) list = [];
  if (node.type === 'element' && node.name === 'style'){
    const text = node.children.filter(c => c.type==='text').map(c => c.text).join(' ');
    if (text) list.push(text);
    if (node.parent){
      node.parent.children = node.parent.children.filter(ch => ch !== node);
    }
  }
  for (const ch of node.children||[]){
    collectStyleBlocks(ch, list);
  }
  return list;
}

function parseCSS(css){
  const rules = [];
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m;
  while((m=re.exec(css))){
    const selectors = m[1].split(',').map(s => s.trim()).filter(Boolean);
    const body = parseStyle(m[2]);
    if (!selectors.length) continue;
    rules.push({ selectors, body });
  }
  return rules;
}

function matchesSelector(node, selector){
  if (selector === '*') return true;
  const parts = selector.split(/(?=[.#])/);
  let tag = null;
  const classes = [];
  let id = null;
  for (const part of parts){
    if (!part) continue;
    if (part.startsWith('.')) classes.push(part.slice(1));
    else if (part.startsWith('#')) id = part.slice(1);
    else tag = part.toLowerCase();
  }
  if (tag && node.name !== tag) return false;
  if (id && node.attrs.id !== id) return false;
  if (classes.length){
    const classList = (node.attrs.class || '').split(/\s+/).filter(Boolean);
    for (const cl of classes) if (!classList.includes(cl)) return false;
  }
  return true;
}

function gatherInherited(parent){
  if (!parent) return {};
  return {
    color: parent.color,
    'font-size': parent['font-size'],
    'font-family': parent['font-family'],
    'font-weight': parent['font-weight'],
    'text-align': parent['text-align'],
    'line-height': parent['line-height'],
    'text-transform': parent['text-transform'],
  };
}

function computeStyles(root, rules){
  const queue = [root];
  while(queue.length){
    const node = queue.shift();
    for (const child of node.children||[]){
      if (child.type === 'element') queue.push(child);
    }
    if (node === root) continue;
    if (node.type !== 'element') continue;
    const style = {};
    mergeStyles(style, gatherInherited(node.parent && node.parent.computedStyle));
    mergeStyles(style, defaultStyleForTag(node.name));
    for (const rule of rules){
      for (const sel of rule.selectors){
        if (matchesSelector(node, sel)) mergeStyles(style, rule.body);
      }
    }
    mergeStyles(style, parseStyle(node.attrs.style));
    node.computedStyle = style;
  }
}

function defaultStyleForTag(tag){
  switch(tag){
    case 'body':
    case 'div':
    case 'section':
    case 'header':
    case 'footer':
    case 'main':
    case 'article':
    case 'p':
    case 'ul':
    case 'li':
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return { display:'block' };
    case 'img':
      return { display:'inline-block' };
    case 'span':
    case 'strong':
    case 'em':
    case 'b':
    case 'i':
      return { display:'inline' };
    default:
      return { display:'block' };
  }
}

function ensureArray(v){ return Array.isArray(v) ? v : [v]; }

function createPage(width, height){
  return { width, height, items: [] };
}

function toRGBA(color){
  if (!color) return null;
  return { r:color.r, g:color.g, b:color.b, a:color.a ?? 1 };
}

function measureText(text, metrics, size){
  if (!text) return 0;
  if (metrics && typeof metrics.textWidth === 'function'){
    return metrics.textWidth(text, size);
  }
  return text.length * size * 0.5;
}

function wrapLines(text, width, metrics, size){
  const lines = [];
  const rawLines = text.split(/\r?\n/);
  for (const raw of rawLines){
    const words = raw.split(/\s+/).filter(Boolean);
    if (!words.length){ lines.push({ text:'', width:0 }); continue; }
    let current = '';
    let currentWidth = 0;
    const spaceWidth = measureText(' ', metrics, size);
    for (const word of words){
      const w = measureText(word, metrics, size);
      if (!current){
        current = word;
        currentWidth = w;
        continue;
      }
      if (currentWidth + spaceWidth + w <= width){
        current += ' ' + word;
        currentWidth += spaceWidth + w;
      } else {
        lines.push({ text: current, width: currentWidth });
        current = word;
        currentWidth = w;
      }
    }
    if (current) lines.push({ text: current, width: currentWidth });
  }
  if (!lines.length) lines.push({ text:'', width:0 });
  return lines;
}

function parseBackground(style){
  const bg = style.background || style['background-color'];
  if (!bg) return null;
  if (/linear-gradient/i.test(bg)){
    const grad = bg.match(/linear-gradient\((.*)\)/i);
    if (!grad) return null;
    const parts = grad[1].split(',');
    let angle = 180; // default to bottom->top
    const stops = [];
    for (let i=0;i<parts.length;i++){
      let token = parts[i].trim();
      if (i===0 && /deg/.test(token)){
        const m = token.match(/(-?[\d.]+)deg/);
        if (m) angle = parseFloat(m[1]);
        continue;
      }
      const seg = token.split(/\s+/);
      const color = parseColor(seg[0]);
      let pos = i/(parts.length-1);
      if (seg[1]){
        const pc = seg[1].match(/^([\d.]+)%$/);
        if (pc) pos = parseFloat(pc[1])/100;
      }
      if (color) stops.push({ color, pos });
    }
    if (stops.length < 2) return null;
    stops.sort((a,b)=>a.pos-b.pos);
    return { type:'gradient', angle, stops };
  }
  const color = parseColor(bg);
  if (!color) return null;
  return { type:'color', color };
}

function isFlexDisplay(style){
  const display = (style.display || '').toLowerCase();
  return display === 'flex' || display === 'inline-flex';
}

function numeric(v){ return typeof v === 'number' ? v : 0; }

function parseFlexGrow(style){
  if (style.flex){
    const parts = String(style.flex).trim().split(/\s+/);
    if (parts.length) return parseFloat(parts[0]) || 0;
  }
  if (style['flex-grow'] !== undefined) return parseFloat(style['flex-grow']) || 0;
  return 0;
}

function parseFlexBasis(style, ctx){
  if (style['flex-basis']){
    const len = parseLength(style['flex-basis'], ctx);
    const resolved = resolveLength(len, ctx);
    if (typeof resolved === 'number') return resolved;
  }
  if (style.width){
    const len = parseLength(style.width, ctx);
    const resolved = resolveLength(len, ctx);
    if (typeof resolved === 'number') return resolved;
  }
  return 0;
}

function parseBoxShadow(style, ctx){
  const shadow = style['box-shadow'];
  if (!shadow || shadow === 'none') return null;
  const parts = shadow.split(/\s+/);
  if (parts.length < 3) return null;
  const color = parseColor(parts[parts.length-1]);
  if (!color) return null;
  const numbers = parts.slice(0, parts.length-1);
  if (numbers.length < 2) return null;
  const [ox, oy, blur=0, spread=0] = numbers.map(v => resolveLength(parseLength(v, ctx), ctx) || 0);
  return { ox, oy, blur, spread, color };
}

function createFlowSpec(root, options){
  const { pageWidthPt, pageHeightPt, defaultFontTag, metrics } = options;
  const cssText = collectStyleBlocks(root).join('\n');
  const rules = parseCSS(cssText);
  computeStyles(root, rules);

  const body = findFirst(root, 'body') || root.children.find(ch => ch.type==='element');
  const pageSize = resolvePageSize(body, { pageWidthPt, pageHeightPt });
  const pages = [createPage(pageSize.width, pageSize.height)];

  const context = {
    pages,
    pageWidth: pageSize.width,
    pageHeight: pageSize.height,
    cursorY: 0,
    defaultFontTag,
    metrics,
    viewportWidth: pageSize.width,
    viewportHeight: pageSize.height,
    htmlPath: options.htmlPath,
  };

  layoutElement(body, {
    x: 0,
    y: 0,
    width: pageSize.width,
    height: pageSize.height,
    pageIndex: 0,
  }, context);

  return { unit:'pt', pages };
}

function resolvePageSize(body, defaults){
  const meta = collectMeta(body);
  if (meta.page){
    const key = meta.page.toLowerCase().replace(/\s+/g,'-');
    if (NAMED_SIZES[key]) return NAMED_SIZES[key];
  }
  let width = defaults.pageWidthPt;
  let height = defaults.pageHeightPt;
  if (meta.width){
    const val = resolveLength(parseLength(meta.width, { allowAuto:false }), { base: defaults.pageWidthPt, viewportWidth: defaults.pageWidthPt, viewportHeight: defaults.pageHeightPt, fontSize:16 });
    if (typeof val === 'number') width = val;
  }
  if (meta.height){
    const val = resolveLength(parseLength(meta.height, { allowAuto:false }), { base: defaults.pageHeightPt, viewportWidth: defaults.pageWidthPt, viewportHeight: defaults.pageHeightPt, fontSize:16 });
    if (typeof val === 'number') height = val;
  }
  if (width && height) return { width, height };
  return { width: defaults.pageWidthPt, height: defaults.pageHeightPt };
}

function collectMeta(node){
  const out = {};
  if (!node || !node.children) return out;
  const metas = [];
  traverse(node, n => {
    if (n.type==='element' && n.name==='meta') metas.push(n);
  });
  for (const m of metas){
    const name = (m.attrs.name || '').toLowerCase();
    if (name.startsWith('pdf:')){
      out[name.slice(4)] = m.attrs.content;
    }
  }
  return out;
}

function traverse(node, fn){
  fn(node);
  for (const ch of node.children||[]){
    traverse(ch, fn);
  }
}

function findFirst(node, tag){
  if (!node) return null;
  if (node.type==='element' && node.name===tag) return node;
  for (const ch of node.children||[]){
    const found = findFirst(ch, tag);
    if (found) return found;
  }
  return null;
}

function layoutElement(node, parentBox, context){
  if (!node || node.type!=='element') return;
  const style = node.computedStyle || {};
  if (style.display === 'none') return;

  const page = context.pages[parentBox.pageIndex];
  const startIndex = page.items.length;

  const fontSize = resolveLength(parseLength(style['font-size'] || (node.parent?.computedStyle?.['font-size'] ?? '12pt'), { fontSize:12 }), {
    fontSize: node.parent?.layout?.fontSize || 12,
    base: node.parent?.layout?.contentWidth || parentBox.width,
    viewportWidth: context.viewportWidth,
    viewportHeight: context.viewportHeight,
  }) || (node.parent?.layout?.fontSize || 12);

  const layout = {
    fontSize,
  };

  const margin = toBox(parseBoxEdges(style, 'margin', { fontSize, base: parentBox.width, viewportWidth: context.viewportWidth, viewportHeight: context.viewportHeight }));
  const padding = toBox(parseBoxEdges(style, 'padding', { fontSize, base: parentBox.width, viewportWidth: context.viewportWidth, viewportHeight: context.viewportHeight }));
  const border = parseBorder(style, { fontSize, base: parentBox.width, viewportWidth: context.viewportWidth, viewportHeight: context.viewportHeight });
  const background = parseBackground(style);
  const boxShadow = parseBoxShadow(style, { fontSize, base: parentBox.width, viewportWidth: context.viewportWidth, viewportHeight: context.viewportHeight });
  const marginLeftVal = typeof margin.left === 'number' ? margin.left : 0;
  const marginRightVal = typeof margin.right === 'number' ? margin.right : 0;
  let width = resolveLength(parseLength(style.width, { fontSize, allowAuto:true }), {
    base: parentBox.width - marginLeftVal - marginRightVal,
    fontSize,
    viewportWidth: context.viewportWidth,
    viewportHeight: context.viewportHeight,
  });
  const maxWidth = resolveLength(parseLength(style['max-width'], { fontSize }), {
    base: parentBox.width,
    fontSize,
    viewportWidth: context.viewportWidth,
    viewportHeight: context.viewportHeight,
  });
  const minWidth = resolveLength(parseLength(style['min-width'], { fontSize }), {
    base: parentBox.width,
    fontSize,
    viewportWidth: context.viewportWidth,
    viewportHeight: context.viewportHeight,
  });

  const availableWidth = parentBox.width - marginLeftVal - marginRightVal;
  if (width === null || width === 'auto') width = availableWidth;
  if (typeof maxWidth === 'number') width = Math.min(width, maxWidth);
  if (typeof minWidth === 'number') width = Math.max(width, minWidth);

  let x = parentBox.x + margin.left;
  if (margin.left === 'auto' && margin.right === 'auto'){
    const space = parentBox.width - width;
    const offset = space/2;
    margin.left = offset;
    margin.right = offset;
    x = parentBox.x + offset;
  } else if (margin.left === 'auto'){
    const offset = parentBox.width - width - (typeof margin.right === 'number' ? margin.right : 0);
    margin.left = offset;
    x = parentBox.x + offset;
  } else if (margin.right === 'auto'){
    margin.right = parentBox.width - width - margin.left;
  }

  let cursorY = parentBox.cursorY || parentBox.y;
  const y = cursorY + margin.top;

  const innerX = x + padding.left + (border.width||0);
  const innerWidth = width - padding.left - padding.right - 2*(border.width||0);
  let innerCursor = y + padding.top + (border.width||0);

  const children = node.children || [];
  const absoluteChildren = [];
  const isFlex = isFlexDisplay(style);

  if (isFlex){
    innerCursor = layoutFlex(children, {
      node,
      innerX,
      innerWidth,
      startY: innerCursor,
      parentBox,
      context,
      fontSize,
      absoluteChildren,
    });
  } else {
    let pendingText = '';

    const flushText = () => {
      const text = pendingText.trim();
      if (!text) return;
      const align = style['text-align'] || node.parent?.computedStyle?.['text-align'] || 'left';
      const transform = style['text-transform'] || node.parent?.computedStyle?.['text-transform'] || 'none';
      const color = toRGBA(parseColor(style.color) || parseColor(node.parent?.computedStyle?.color) || {r:0,g:0,b:0,a:1});
      const lineHeightRaw = style['line-height'] || node.parent?.computedStyle?.['line-height'];
      let lineHeight = null;
      if (lineHeightRaw){
        const raw = String(lineHeightRaw).trim();
        if (/^[0-9.]+$/.test(raw)){
          lineHeight = parseFloat(raw) * fontSize;
        } else {
          const len = parseLength(raw, { fontSize });
          if (typeof len === 'number') lineHeight = len;
          else if (len === null) lineHeight = parseFloat(raw) * fontSize;
          else if (typeof len === 'object' && len.type === 'percent') lineHeight = fontSize * len.value / 100;
        }
      }
      if (!lineHeight) lineHeight = fontSize * 1.4;
      const lines = wrapLines(applyTransform(text, transform), innerWidth, context.metrics, fontSize);
      for (const ln of lines){
        const lineText = ln.text;
        const lineWidth = ln.width;
        let textX = innerX;
        if (align === 'center') textX = innerX + (innerWidth - lineWidth)/2;
        else if (align === 'right') textX = innerX + innerWidth - lineWidth;
        const lineBaseline = innerCursor + fontSize;
        addTextItem(context, parentBox.pageIndex, textX, lineBaseline, fontSize, color, lineText, context.defaultFontTag);
        innerCursor += lineHeight;
      }
      pendingText = '';
    };

    for (const ch of children){
      if (ch.type === 'text'){
        pendingText += ' ' + ch.text;
        continue;
      }
      if (ch.type !== 'element') continue;
      if (ch.computedStyle?.position === 'absolute'){
        absoluteChildren.push(ch);
        continue;
      }
      const childDisplay = ch.computedStyle?.display || defaultStyleForTag(ch.name).display;
      if (childDisplay === 'inline'){
        pendingText += ' ' + collectText(ch);
        continue;
      }
      flushText();
      if (ch.name === 'img'){
        layoutImage(ch, innerX, innerCursor, innerWidth, context, parentBox.pageIndex);
        innerCursor = ch.layout.after;
      } else {
        layoutElement(ch, {
          x: innerX,
          y: innerCursor,
          width: innerWidth,
          height: parentBox.height,
          cursorY: innerCursor,
          pageIndex: parentBox.pageIndex,
        }, context);
        innerCursor = ch.layout.after;
      }
    }
    flushText();
  }

  const heightContent = innerCursor - (y + padding.top + (border.width||0));
  let height = resolveLength(parseLength(style.height, { fontSize }), {
    base: heightContent,
    fontSize,
    viewportWidth: context.viewportWidth,
    viewportHeight: context.viewportHeight,
  });
  if (height === null || height === 'auto') height = heightContent + padding.bottom + (border.width||0);
  const totalHeight = padding.top + padding.bottom + height + (border.width||0)*2;
  const after = y + totalHeight + margin.bottom;

  layout.x = x;
  layout.y = y;
  layout.width = width;
  layout.height = totalHeight;
  layout.innerWidth = innerWidth;
  layout.contentWidth = innerWidth;
  layout.after = after;
  layout.margin = margin;
  layout.padding = padding;
  layout.border = border;
  layout.background = background;
  layout.boxShadow = boxShadow;
  layout.pageIndex = parentBox.pageIndex;
  layout.innerCursor = innerCursor;

  node.layout = layout;

  parentBox.cursorY = after;

  paintBox(node, context, startIndex);

  for (const abs of absoluteChildren){
    layoutAbsolute(abs, node, context);
  }
}

function layoutAbsolute(node, anchor, context){
  const style = node.computedStyle || {};
  const anchorLayout = anchor.layout;
  const fontSize = anchorLayout.fontSize;
  const margin = toBox(parseBoxEdges(style, 'margin', { fontSize, base: anchorLayout.innerWidth }));
  const padding = toBox(parseBoxEdges(style, 'padding', { fontSize, base: anchorLayout.innerWidth }));
  const border = parseBorder(style, { fontSize, base: anchorLayout.innerWidth });
  const widthSpec = parseLength(style.width, { fontSize });
  let width = resolveLength(widthSpec, { base: anchorLayout.innerWidth, fontSize, viewportWidth: context.viewportWidth, viewportHeight: context.viewportHeight });
  if (width === null || width === 'auto') width = anchorLayout.innerWidth - margin.left - margin.right;
  const left = resolveLength(parseLength(style.left, { fontSize }), { base: anchorLayout.innerWidth, fontSize, viewportWidth: context.viewportWidth, viewportHeight: context.viewportHeight }) ?? 0;
  const top = resolveLength(parseLength(style.top, { fontSize }), { base: anchorLayout.height, fontSize, viewportWidth: context.viewportWidth, viewportHeight: context.viewportHeight }) ?? 0;
  const x = anchorLayout.x + padding.left + border.width + left + margin.left;
  const y = anchorLayout.y + padding.top + border.width + top + margin.top;
  const innerWidth = width - padding.left - padding.right - 2*(border.width||0);
  let innerCursor = y + padding.top + (border.width||0);

  const color = toRGBA(parseColor(style.color) || parseColor(anchor.computedStyle?.color) || {r:0,g:0,b:0,a:1});
  const align = style['text-align'] || 'left';
  const transform = style['text-transform'] || anchor.computedStyle?.['text-transform'] || 'none';
  const text = collectText(node).trim();
  if (text){
    const lines = wrapLines(applyTransform(text, transform), innerWidth, context.metrics, fontSize);
    for (const ln of lines){
      const lineBaseline = innerCursor + fontSize;
      let textX = x;
      if (align === 'center') textX = x + (innerWidth - ln.width)/2;
      else if (align === 'right') textX = x + innerWidth - ln.width;
      addTextItem(context, anchor.layout.pageIndex, textX, lineBaseline, fontSize, color, ln.text, context.defaultFontTag);
      innerCursor += fontSize * 1.4;
    }
  }
}

function layoutImage(node, x, cursorY, maxWidth, context, pageIndex){
  const style = node.computedStyle || {};
  const fontSize = node.parent?.layout?.fontSize || 12;
  const margin = toBox(parseBoxEdges(style, 'margin', { fontSize, base: maxWidth }));
  const padding = toBox(parseBoxEdges(style, 'padding', { fontSize, base: maxWidth }));
  const border = parseBorder(style, { fontSize, base: maxWidth });
  const src = node.attrs.src;
  if (!src) return;
  const resolved = resolveResource(src, context.htmlPath);
  const info = getImageDimensions(resolved);
  const widthSpecified = resolveLength(parseLength(style.width, { fontSize }), { base: maxWidth, fontSize, viewportWidth: context.viewportWidth, viewportHeight: context.viewportHeight });
  const heightSpecified = resolveLength(parseLength(style.height, { fontSize }), { base: context.viewportHeight, fontSize, viewportWidth: context.viewportWidth, viewportHeight: context.viewportHeight });
  let width = typeof widthSpecified === 'number' ? widthSpecified : (info.widthPt || maxWidth);
  let height = typeof heightSpecified === 'number' ? heightSpecified : (info.heightPt || width);
  if (typeof widthSpecified === 'number' && typeof heightSpecified !== 'number' && info.widthPt){
    height = widthSpecified * (info.heightPt / info.widthPt);
  } else if (typeof heightSpecified === 'number' && typeof widthSpecified !== 'number' && info.heightPt){
    width = heightSpecified * (info.widthPt / info.heightPt);
  }
  width = Math.min(width, maxWidth - (margin.left === 'auto'?0:margin.left) - (typeof margin.right === 'number'? margin.right : 0));
  const posX = x + (typeof margin.left === 'number'? margin.left : 0) + padding.left + (border.width||0);
  const posY = cursorY + (margin.top || 0) + padding.top + (border.width||0);
  const bottom = context.pages[pageIndex].height - posY - height;
  const page = context.pages[pageIndex];
  page.items.push({ type:'image', src: resolved, x: posX, y: bottom, w: width, h: height });
  node.layout = {
    x: posX,
    y: posY,
    width,
    height: height + (border.width||0)*2 + padding.top + padding.bottom,
    after: posY + height + (margin.bottom || 0) + padding.bottom + (border.width||0),
    pageIndex,
  };
}

function layoutFlex(children, { node, innerX, innerWidth, startY, parentBox, context, fontSize, absoluteChildren }){
  const items = [];
  for (const ch of children){
    if (ch.type === 'element'){
      if (ch.computedStyle?.position === 'absolute'){ absoluteChildren.push(ch); continue; }
      const childStyle = ch.computedStyle || {};
      if ((childStyle.display || '').toLowerCase() === 'none') continue;
      const margin = toBox(parseBoxEdges(childStyle, 'margin', { fontSize, base: innerWidth, viewportWidth: context.viewportWidth, viewportHeight: context.viewportHeight }));
      const basis = parseFlexBasis(childStyle, { base: innerWidth, fontSize, viewportWidth: context.viewportWidth, viewportHeight: context.viewportHeight }) || 0;
      const grow = parseFlexGrow(childStyle);
      items.push({ node: ch, margin, basis, grow });
    }
  }
  if (!items.length) return startY;

  const gapValue = resolveLength(parseLength(node.computedStyle?.gap, { fontSize }), { base: innerWidth, fontSize, viewportWidth: context.viewportWidth, viewportHeight: context.viewportHeight }) || 0;

  let totalWidth = 0;
  for (const it of items){
    totalWidth += it.basis + numeric(it.margin.left) + numeric(it.margin.right);
  }

  let freeSpace = innerWidth - totalWidth - gapValue * (items.length - 1);
  if (freeSpace < 0) freeSpace = 0;
  const growSum = items.reduce((sum,it)=>sum + it.grow, 0);
  if (growSum > 0){
    for (const it of items){
      const delta = freeSpace * (it.grow / growSum);
      it.finalWidth = Math.max(0, it.basis + delta);
    }
    freeSpace = 0;
  } else {
    for (const it of items) it.finalWidth = Math.max(0, it.basis);
  }

  const occupied = items.reduce((sum,it)=> sum + it.finalWidth + numeric(it.margin.left) + numeric(it.margin.right), 0);
  let remaining = innerWidth - occupied - gapValue * (items.length - 1);
  if (remaining < 0) remaining = 0;

  const justify = (node.computedStyle?.['justify-content'] || 'flex-start').toLowerCase();
  let offsetStart = 0;
  let spacing = gapValue;
  if (justify === 'flex-end'){ offsetStart = remaining; }
  else if (justify === 'center'){ offsetStart = remaining / 2; }
  else if (justify === 'space-between' && items.length > 1){ spacing = gapValue + remaining / (items.length - 1); }
  else if (justify === 'space-around' && items.length > 0){ spacing = gapValue + remaining / items.length; offsetStart = spacing / 2; }
  else if (justify === 'space-evenly' && items.length > 0){ spacing = gapValue + remaining / (items.length + 1); offsetStart = spacing; }

  let cursorX = innerX + offsetStart;
  let maxBottom = startY;
  items.forEach((it, index) => {
    const marginLeft = numeric(it.margin.left);
    const marginRight = numeric(it.margin.right);
    layoutElement(it.node, {
      x: cursorX,
      y: startY,
      width: it.finalWidth,
      height: parentBox.height,
      cursorY: startY,
      pageIndex: parentBox.pageIndex,
    }, context);
    const childLayout = it.node.layout;
    if (childLayout && childLayout.after > maxBottom) maxBottom = childLayout.after;
    const totalWidth = it.finalWidth + marginLeft + marginRight;
    cursorX += totalWidth;
    if (index < items.length - 1) cursorX += spacing;
  }
  );
  return maxBottom;
}

function applyTransform(text, transform){
  if (!text) return '';
  switch((transform||'').toLowerCase()){
    case 'uppercase': return text.toUpperCase();
    case 'lowercase': return text.toLowerCase();
    case 'capitalize':
      return text.replace(/\b(\w)(\w*)/g, (_,a,b)=>a.toUpperCase()+b.toLowerCase());
    default: return text;
  }
}

function toBox(box){
  return {
    top: box?.top === 'auto' ? 0 : box?.top || 0,
    right: box?.right === 'auto' ? 'auto' : box?.right || 0,
    bottom: box?.bottom === 'auto' ? 0 : box?.bottom || 0,
    left: box?.left === 'auto' ? 'auto' : box?.left || 0,
  };
}

function collectText(node){
  if (node.type === 'text') return node.text;
  if (!node.children) return '';
  return node.children.map(collectText).join(' ');
}

function addTextItem(context, pageIndex, x, baseline, size, color, text, fontTag){
  const page = context.pages[pageIndex];
  const y = page.height - baseline;
  const rgb = [color.r, color.g, color.b];
  page.items.push({ type:'text', t:text, x, y, size, color: rgb, alpha: color.a, font: fontTag });
}

function paintBox(node, context, insertIndex){
  const { layout } = node;
  if (!layout) return;
  const page = context.pages[layout.pageIndex];
  const x = layout.x;
  const y = layout.y;
  const width = layout.width;
  const height = layout.height;
  const bottomY = page.height - y - height;

  const items = [];

  if (layout.boxShadow){
    const shadow = layout.boxShadow;
    const color = shadow.color;
    if (color && color.a > 0){
      const ox = shadow.ox;
      const oy = shadow.oy;
      const spread = shadow.spread || 0;
      const shadowX = x + ox - spread;
      const shadowY = bottomY - oy - spread;
      const shadowW = width + spread*2;
      const shadowH = height + spread*2;
      items.push({ type:'rect', x: shadowX, y: shadowY, w: shadowW, h: shadowH, fill:[color.r, color.g, color.b], alpha: color.a });
    }
  }

  if (layout.background){
    if (layout.background.type === 'color'){
      const color = layout.background.color;
      items.push({ type:'rect', x, y: bottomY, w: width, h: height, fill:[color.r,color.g,color.b], alpha: color.a });
    } else if (layout.background.type === 'gradient'){
      const { angle, stops } = layout.background;
      items.push(...createGradientItems({ x, y: bottomY, w: width, h: height }, angle, stops));
    }
  }

  if (layout.border && layout.border.width){
    const border = layout.border;
    if (border.color){
      items.push({ type:'strokeRect', x, y: bottomY, w: width, h: height, sw: border.width, stroke:[border.color.r,border.color.g,border.color.b], alpha:border.color.a, radius:border.radius||0 });
    }
  }

  if (items.length) page.items.splice(insertIndex, 0, ...items);
}

function createGradientItems(box, angleDeg, stops){
  const steps = Math.max(8, stops.length * 16);
  const angle = ((angleDeg % 360) + 360) % 360;
  const rad = angle * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const items = [];
  for (let i=0;i<steps;i++){
    const t0 = i/steps;
    const t1 = (i+1)/steps;
    const color0 = sampleGradient(stops, t0);
    const color1 = sampleGradient(stops, t1);
    const color = {
      r: Math.round(color0.r*(1-t0)+color1.r*t0),
      g: Math.round(color0.g*(1-t0)+color1.g*t0),
      b: Math.round(color0.b*(1-t0)+color1.b*t0),
      a: color0.a*(1-t0)+color1.a*t0,
    };
    const sliceX = box.x + (cos>=0 ? 0 : box.w) + cos * box.w * t0;
    const sliceY = box.y + (sin>=0 ? 0 : box.h) + sin * box.h * t0;
    const sliceW = Math.abs(cos) * box.w / steps + 1;
    const sliceH = Math.abs(sin) * box.h / steps + 1;
    items.push({ type:'rect', x: sliceX, y: sliceY, w: sliceW, h: sliceH, fill:[color.r,color.g,color.b], alpha: color.a });
  }
  return items;
}

function sampleGradient(stops, t){
  if (t <= stops[0].pos) return stops[0].color;
  if (t >= stops[stops.length-1].pos) return stops[stops.length-1].color;
  for (let i=0;i<stops.length-1;i++){
    const a = stops[i];
    const b = stops[i+1];
    if (t >= a.pos && t <= b.pos){
      const u = (t - a.pos) / (b.pos - a.pos);
      return {
        r: a.color.r + (b.color.r - a.color.r)*u,
        g: a.color.g + (b.color.g - a.color.g)*u,
        b: a.color.b + (b.color.b - a.color.b)*u,
        a: a.color.a + (b.color.a - a.color.a)*u,
      };
    }
  }
  return stops[stops.length-1].color;
}

function legacyHtmlToSpec(html, options){
  const toks = tokenizeLegacy(html);
  const spec = { unit:'pt', items: [] };
  const { pageWidthPt, pageHeightPt, defaultFontTag } = options;
  for (let i=0;i<toks.length;i++){
    const t = toks[i];
    if (t.type !== 'tag' || t.close) continue;
    const style = parseStyle(t.attrs.style || '');
    const unitHint = (t.attrs['data-unit'] || '').toLowerCase() || 'px';
    const L = parseDimLegacy(style.left, unitHint);
    const T = parseDimLegacy(style.top, unitHint);
    const W = parseDimLegacy(style.width, unitHint);
    const H = parseDimLegacy(style.height, unitHint);
    const x = toLegacyPt(L.v, L.u);
    const yTop = toLegacyPt(T.v, T.u);
    const w = toLegacyPt(W.v, W.u);
    const h = toLegacyPt(H.v, H.u);
    const y = pageHeightPt - yTop - h;
    const color = parseColor(style.color);
    const bg = parseColor(style['background'] || style['background-color']);
    let stroke = null, sw = 1;
    if (style['border'] || style['border-color'] || style['border-width']){
      stroke = parseColor(style['border-color']) || {r:0,g:0,b:0,a:1};
      const bw = parseDimLegacy(style['border-width'] || '1px', unitHint);
      sw = toLegacyPt(bw.v, bw.u);
    }
    const fs = style['font-size'] ? toLegacyPt(parseDimLegacy(style['font-size'], unitHint).v, unitHint) : undefined;
    if (t.attrs['data-pdf-textfit'] !== undefined){
      let text = (t.attrs['data-text'] || '').trim();
      if (!text && toks[i+1] && toks[i+1].type==='text') text = toks[i+1].text;
      spec.items.push({ type:'textFit', t:text, x,y,w,h, min:Number(t.attrs['data-min']||8), max:Number(t.attrs['data-max']||(fs||24)), color: color? [color.r,color.g,color.b]:[0,0,0], font: defaultFontTag });
      continue;
    }
    if (t.attrs['data-pdf-text'] !== undefined){
      let text = (t.attrs['data-text'] || '').trim();
      if (!text && toks[i+1] && toks[i+1].type==='text') text = toks[i+1].text;
      const size = fs || 12;
      spec.items.push({ type:'text', t:text, x, y: y + (h>0 ? (h - size)/2 : 0), size, color: color? [color.r,color.g,color.b]:[0,0,0], font: defaultFontTag });
      continue;
    }
    if (t.name === 'img' && t.attrs['data-pdf-image'] !== undefined){
      const src = t.attrs.src || '';
      if (src){
        const resolved = resolveResource(src, options.htmlPath);
        spec.items.push({ type:'image', src: resolved, x,y,w,h });
      }
      continue;
    }
    if (t.attrs['data-pdf-rect'] !== undefined || bg || stroke){
      const fill = bg ? [bg.r,bg.g,bg.b] : null;
      const sc = stroke ? [stroke.r,stroke.g,stroke.b] : null;
      spec.items.push({ type:'rect', x,y,w,h, fill, stroke: sc, sw });
    }
  }
  return spec;
}

function tokenizeLegacy(html){
  const out = [];
  const re = /<(\/)?([a-zA-Z0-9]+)([^>]*)>|([^<]+)/gms;
  let m;
  while((m=re.exec(html))){
    if (m[4]){
      const text = m[4].replace(/\s+/g,' ').trim();
      if (text) out.push({ type:'text', text });
      continue;
    }
    const closing = !!m[1];
    const name = m[2].toLowerCase();
    const attrs = parseAttributes(m[3]||'');
    out.push({ type:'tag', name, attrs, close: closing });
  }
  return out;
}

function parseDimLegacy(s, def='px'){
  if (!s) return { v:0, u:def };
  const m = String(s).trim().match(/^(-?\d+(?:\.\d+)?)(mm|px|pt|cm|in)?$/i);
  if (m) return { v: parseFloat(m[1]), u: (m[2]||def).toLowerCase() };
  return { v: parseFloat(s)||0, u: def };
}

function toLegacyPt(v,u){
  switch(u){
    case 'mm': return v * PT_PER_MM;
    case 'cm': return v * PT_PER_CM;
    case 'px': return v * PT_PER_PX;
    case 'in': return v * PT_PER_IN;
    default: return v;
  }
}

function resolveResource(src, htmlPath){
  if (!htmlPath) return src;
  if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:')) return src;
  const dir = path.dirname(htmlPath);
  return path.resolve(dir, src);
}

function getImageDimensions(filePath){
  try {
    const buf = fs.readFileSync(filePath);
    if (/\.png$/i.test(filePath)){
      const png = PNGImage.parse(buf);
      return { widthPt: png.width * PT_PER_PX, heightPt: png.height * PT_PER_PX };
    }
  } catch (err){
    return { widthPt: PT_PER_MM * 50, heightPt: PT_PER_MM * 30 };
  }
  return { widthPt: PT_PER_MM * 50, heightPt: PT_PER_MM * 30 };
}

function htmlToSpec(html, options){
  const opts = options || {};
  if (/data-pdf-/.test(html)){
    return legacyHtmlToSpec(html, opts);
  }
  const tree = parseHTML(html);
  return createFlowSpec(tree, opts);
}

module.exports = { htmlToSpec };
