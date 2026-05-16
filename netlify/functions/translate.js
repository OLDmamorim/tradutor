import JSZip from "jszip";
import OpenAI from "openai";
import PDFParser from "pdf2json";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";

const model = process.env.OPENAI_MODEL || "gpt-5.2";
let openaiClient;
const officeMime = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
const pdfMime = "application/pdf";

export default async (request) => {
  if (request.method !== "POST") {
    return json({ error: "Metodo nao suportado." }, 405);
  }

  if (!process.env.OPENAI_API_KEY) {
    return json({ error: "Falta configurar OPENAI_API_KEY no Netlify." }, 500);
  }

  try {
    const body = await request.json();
    const { fileName, base64, targetLanguage } = body;
    const extension = getExtension(fileName);

    if (!fileName || !base64 || !targetLanguage) {
      return json({ error: "Pedido incompleto." }, 400);
    }

    const input = Buffer.from(base64, "base64");

    if (extension === "txt") {
      const translated = await translateTexts([input.toString("utf8")], targetLanguage);
      return json({
        fileName: outputName(fileName, targetLanguage),
        mimeType: "text/plain",
        base64: Buffer.from(translated[0] || "", "utf8").toString("base64"),
      });
    }

    if (extension === "pdf") {
      const output = await translatePdfFile(input, targetLanguage);
      return json({
        fileName: outputName(fileName, targetLanguage),
        mimeType: pdfMime,
        base64: Buffer.from(output).toString("base64"),
      });
    }

    if (!["docx", "pptx", "xlsx"].includes(extension)) {
      return json(
        {
          error: "Formato ainda nao suportado. Use PDF, DOCX, PPTX, XLSX ou TXT.",
        },
        415,
      );
    }

    const output = await translateOfficeFile(input, extension, targetLanguage);

    return json({
      fileName: outputName(fileName, targetLanguage),
      mimeType: officeMime[extension],
      base64: output.toString("base64"),
    });
  } catch (error) {
    console.error(error);
    return json(
      {
        error: error.message || "Erro inesperado ao traduzir.",
        source: "translate-function",
      },
      500,
    );
  }
};

async function translateOfficeFile(buffer, extension, targetLanguage) {
  const zip = await JSZip.loadAsync(buffer);
  const xmlPaths = Object.keys(zip.files).filter((path) =>
    isTranslatableXmlPath(path, extension),
  );

  for (const path of xmlPaths) {
    const file = zip.file(path);
    if (!file) continue;

    const xml = await file.async("string");
    const { nextXml, texts } = collectTextNodes(xml, extension);
    if (texts.length === 0) continue;

    const translated = await translateTexts(texts, targetLanguage);
    const finalXml = applyTranslations(nextXml, translated);
    zip.file(path, finalXml);
  }

  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

async function translatePdfFile(buffer, targetLanguage) {
  const parsedPages = await parsePdfPages(buffer);

  const outputPdf = await PDFDocument.create();
  const sourceDoc = await PDFDocument.load(buffer);
  const embeddedPages = await outputPdf.embedPdf(
    buffer,
    Array.from({ length: sourceDoc.getPageCount() }, (_, i) => i),
  );
  const font = await outputPdf.embedFont(StandardFonts.Helvetica);
  let translatedCount = 0;

  for (let pageIndex = 0; pageIndex < parsedPages.length; pageIndex += 1) {
    const parsedPage = parsedPages[pageIndex];
    const sourcePage = sourceDoc.getPage(pageIndex);
    const pageWidthPts = sourcePage.getWidth();
    const pageHeightPts = sourcePage.getHeight();

    // Scale factors: pdf2json units -> PDF points
    const scaleX = pageWidthPts / (parsedPage.Width || 1);
    const scaleY = pageHeightPts / (parsedPage.Height || 1);

    const items = [];
    for (const block of parsedPage.Texts || []) {
      const rawText = (block.R || []).map((r) => decodePdfText(r.T)).join("");
      if (!shouldTranslatePdfText(rawText)) continue;
      const fontSize = Math.max(6, Math.min(block.R?.[0]?.TS?.[1] ?? 12, 14));
      items.push({
        text: rawText,
        x: block.x * scaleX,
        // pdf2json Y=0 is at top; pdf-lib Y=0 is at bottom — flip and shift by fontSize
        y: pageHeightPts - block.y * scaleY - fontSize,
        fontSize,
      });
    }

    const page = outputPdf.addPage([pageWidthPts, pageHeightPts]);
    page.drawPage(embeddedPages[pageIndex], {
      x: 0,
      y: 0,
      width: pageWidthPts,
      height: pageHeightPts,
    });

    if (items.length === 0) continue;

    const translations = await translateTexts(
      items.map((item) => item.text),
      targetLanguage,
    );
    translatedCount += translations.length;

    items.forEach((item, index) => {
      const text = normalizePdfText(translations[index] || item.text);
      const translatedWidth = safeTextWidth(font, text, item.fontSize);
      const coverWidth = Math.min(
        pageWidthPts - item.x,
        Math.max(translatedWidth, 8) + 5,
      );

      page.drawRectangle({
        x: Math.max(0, item.x - 1),
        y: Math.max(0, item.y - 2),
        width: coverWidth,
        height: item.fontSize + 4,
        color: rgb(1, 1, 1),
      });
      page.drawText(text, {
        x: item.x,
        y: item.y,
        size: item.fontSize,
        font,
        color: rgb(0.05, 0.05, 0.05),
      });
    });
  }

  if (translatedCount === 0) {
    throw new Error(
      "Este PDF nao tem texto pesquisavel ou nao tem texto traduzivel.",
    );
  }

  return outputPdf.save();
}

function parsePdfPages(buffer) {
  return new Promise((resolve, reject) => {
    const parser = new PDFParser(null, 1);
    parser.on("pdfParser_dataError", (err) => {
      reject(new Error(err.parserError || "Erro ao ler o PDF."));
    });
    parser.on("pdfParser_dataReady", (data) => {
      resolve(data.Pages || []);
    });
    parser.parseBuffer(buffer);
  });
}

function decodePdfText(encoded) {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function isTranslatableXmlPath(path, extension) {
  if (!path.endsWith(".xml")) return false;
  if (extension === "docx") {
    return /^word\/(document|header\d+|footer\d+|footnotes|endnotes|comments|settings)\.xml$/.test(
      path,
    );
  }
  if (extension === "pptx") {
    return /^ppt\/(slides|notesSlides|slideMasters|slideLayouts)\/.+\.xml$/.test(path);
  }
  if (extension === "xlsx") {
    return path === "xl/sharedStrings.xml" || /^xl\/worksheets\/.+\.xml$/.test(path);
  }
  return false;
}

function collectTextNodes(xml, extension) {
  const texts = [];
  const patterns = {
    docx: /(<w:t\b[^>]*>)([\s\S]*?)(<\/w:t>)/g,
    pptx: /(<a:t\b[^>]*>)([\s\S]*?)(<\/a:t>)/g,
    xlsx: /(<t\b[^>]*>)([\s\S]*?)(<\/t>)/g,
  };

  const nextXml = xml.replace(patterns[extension], (match, open, rawText, close) => {
    const text = decodeXml(rawText);
    if (!shouldTranslate(text)) return match;
    const marker = `__TRANSLATION_SLOT_${texts.length}__`;
    texts.push(text);
    return `${open}${marker}${close}`;
  });

  return { nextXml, texts };
}

function applyTranslations(xml, translations) {
  return xml.replace(
    /__TRANSLATION_SLOT_(\d+)__/g,
    (_, index) => encodeXml(translations[Number(index)] || ""),
  );
}

async function translateTexts(texts, targetLanguage) {
  const output = [];
  const client = getOpenAIClient();
  for (const chunk of chunkTexts(texts)) {
    const response = await client.responses.create({
      model,
      instructions:
        "You translate document text. Preserve numbers, placeholders, punctuation, whitespace intent, formatting markers, proper names, addresses, company names, tax IDs, invoice IDs, and URLs when appropriate. Return only a JSON array of strings with the same length and order as the input.",
      input: `Translate every item to ${targetLanguage}.\n\n${JSON.stringify(
        chunk,
      )}`,
    });

    const parsed = parseJsonArray(response.output_text);
    if (parsed.length !== chunk.length) {
      throw new Error("A traducao devolveu uma quantidade inesperada de segmentos.");
    }
    output.push(...parsed);
  }
  return output;
}

function getOpenAIClient() {
  openaiClient ??= new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
  return openaiClient;
}

function chunkTexts(texts) {
  const chunks = [];
  let current = [];
  let size = 0;

  for (const text of texts) {
    const textSize = text.length;
    if (current.length > 0 && (current.length >= 40 || size + textSize > 7000)) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(text);
    size += textSize;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

function parseJsonArray(value) {
  const trimmed = value.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("[");
    const end = trimmed.lastIndexOf("]");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("Nao foi possivel ler a resposta da traducao.");
  }
}

function shouldTranslate(text) {
  return /[\p{L}\p{N}]/u.test(text) && text.trim().length > 0;
}

function shouldTranslatePdfText(text) {
  const trimmed = text.trim();
  if (!/[\p{L}]/u.test(trimmed)) return false;
  if (trimmed.length < 2) return false;
  if (/^[\d\s.,:/\\\-+()%]+$/.test(trimmed)) return false;
  return true;
}

function decodeXml(value) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function encodeXml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizePdfText(value) {
  return value
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/–|—/g, "-");
}

function safeTextWidth(font, text, fontSize) {
  try {
    return font.widthOfTextAtSize(text, fontSize);
  } catch {
    return font.widthOfTextAtSize(normalizePdfText(text), fontSize);
  }
}

function getExtension(fileName = "") {
  return fileName.split(".").pop()?.toLowerCase() || "";
}

function outputName(fileName, targetLanguage) {
  const extension = getExtension(fileName);
  const base = fileName.slice(0, -(extension.length + 1));
  const suffix = targetLanguage
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${base || "documento"}-${suffix}.${extension}`;
}

function json(payload, status = 200) {
  return Response.json(payload, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
