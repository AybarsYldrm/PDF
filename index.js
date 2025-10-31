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

  const pageWidthPt  = toPtMM(PAGE_MM.w);
  const pageHeightPt = toPtMM(PAGE_MM.h);

  const pdf = new PDFDoc({ title: 'HTML Render', author: 'FITFAK', compress: true });

  // Unicode font zorunlu
  const { fontTag, metrics } = pdf.registerTTF('NotoSans', ttfPath);

  // HTML → Spec
  const spec = htmlToSpec(html, { pageWidthPt, pageHeightPt, unitDefault:'px', defaultFontTag: fontTag, metrics, htmlPath });

  const pageSpecs = Array.isArray(spec.pages) && spec.pages.length
    ? spec.pages
    : [{ width: pageWidthPt, height: pageHeightPt, unit: spec.unit || 'pt', items: spec.items || [] }];

  for (const pageSpec of pageSpecs){
    const width = pageSpec.width || pageWidthPt;
    const height = pageSpec.height || pageHeightPt;
    const pageIndex = pdf.addPage({ width, height });
    const cv = new Canvas(pdf, pageIndex);
    cv.setFont(fontTag, metrics);
    const renderer = new Renderer(pdf, pageIndex, cv);
    renderer.run({ unit: pageSpec.unit || spec.unit || 'pt', items: pageSpec.items || [] });
  }

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
