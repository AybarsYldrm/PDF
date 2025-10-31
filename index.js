// make_pdf_from_html.js
const fs = require('fs');
const { htmlToSpec } = require('./html2spec');
// Aşağıdaki 3 sınıf senin çekirdeğinden geliyor:
// PDFDoc, Canvas, Renderer — fitfak_pdf_core.js içinden import et:
const { PDFDoc, Canvas, Renderer } = require('./core'); // <- senin dosyan

const PAGE_MM = { w: 297, h: 210 }; // A4 landscape
const PT_PER_MM = 72/25.4;

function toPtMM(v){ return v*PT_PER_MM; }

function buildPdfFromHtml({ htmlPath, outPdf, ttfPath }){
  const html = fs.readFileSync(htmlPath, 'utf8');

  const pdf = new PDFDoc({ title: 'HTML Render', author: 'FITFAK', compress: true });
  const p = pdf.addPage({ width: toPtMM(PAGE_MM.w), height: toPtMM(PAGE_MM.h) });

  // Unicode font zorunlu
  const { fontTag, metrics } = pdf.registerTTF('NotoSans', ttfPath);

  const cv = new Canvas(pdf, p);
  cv.setFont(fontTag, metrics);

  // HTML → Spec
  const pageWidthPt  = toPtMM(PAGE_MM.w);
  const pageHeightPt = toPtMM(PAGE_MM.h);
  const spec = htmlToSpec(html, { pageWidthPt, pageHeightPt, unitDefault:'px', defaultFontTag: fontTag });

  // İstersen çerçeve vb.
  const r = new Renderer(pdf, p, cv);
  r.run({ unit:'pt', items: spec.items });

  pdf.save(outPdf);
  console.log(`OK -> ${outPdf}`);
}

// CLI demo:
// node make_pdf_from_html.js template.html out.pdf ./NotoSans-Regular.ttf
if (require.main === module){
  const [,, htmlPath='template.html', outPdf='out.pdf', ttfPath='./NotoSans.ttf'] = process.argv;
  buildPdfFromHtml({ htmlPath, outPdf, ttfPath });
}

module.exports = { buildPdfFromHtml };
