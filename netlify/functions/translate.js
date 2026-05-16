import JSZip from "jszip";
import OpenAI from "openai";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";

const model = process.env.AI_MODEL || "llama3-70b-8192";
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

  if (!process.env.AI_API_KEY) {
    return json({ error: "Falta configurar AI_API_KEY no Netlify." }, 500);
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
  const collectedPages = [];

  await pdfParse(buffer, {
    pagerender: async (page) => {
      const viewport = page.getViewport(1.0);
      const textContent = await page.getTextContent();
      collectedPages.push({
        width: viewport.width,
        height: viewport.height,
        items: textContent.items
          .filter((item) => typeof item.str === "string" && shouldTranslatePdfText(item.str))
          .map((item) => ({
            text: item.str,
            x: item.transform[4],
            y: item.transform[5],
            width: Math.max(item.width || 0, 8),
            height: Math.max(Math.abs(item.height || item.transform[3] || 10), 7),
          })),
      });
      return "";
    },
  });

  if (collectedPages.length === 0) {
    throw new Error("Este PDF nao tem paginas.");
  }

  const outputPdf = await PDFDocument.create();
  const embeddedPages = await outputPdf.embedPdf(
    buffer,
    Array.from({ length: collectedPages.length }, (_, i) => i),
  );
  const font = await outputPdf.embedFont(StandardFonts.Helvetica);
  let translatedCount = 0;

  for (let pageIndex = 0; pageIndex < collectedPages.length; pageIndex += 1) {
    const { width, height, items } = collectedPages[pageIndex];
    const page = outputPdf.addPage([width, height]);
    page.drawPage(embeddedPages[pageIndex], { x: 0, y: 0, width, height });

    if (items.length === 0) continue;

    const translations = await translateTexts(
      items.map((item) => item.text),
      targetLanguage,
    );
    translatedCount += translations.length;

    items.forEach((item, index) => {
      const text = normalizePdfText(translations[index] || item.text);
      const fontSize = Math.max(6, Math.min(item.height * 0.92, 14));
      const translatedWidth = safeTextWidth(font, text, fontSize);
      const coverWidth = Math.min(
        width - item.x,
        Math.max(item.width, translatedWidth) + 5,
      );

      page.drawRectangle({
        x: Math.max(0, item.x - 1),
        y: Math.max(0, item.y - 2),
        width: coverWidth,
        height: item.height + 4,
        color: rgb(1, 1, 1),
      });
      page.drawText(text, {
        x: item.x,
        y: item.y,
        size: fontSize,
        font,
        color: rgb(0.05, 0.05, 0.05),
      });
    });
  }

  if (translatedCount === 0) {
    throw new Error("Este PDF nao tem texto pesquisavel ou nao tem texto traduzivel.");
  }

  return outputPdf.save();
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
  const client = getAIClient();
  for (const chunk of chunkTexts(texts)) {
    const response = await client.chat.completions.create({
      model,
      messages: [
        {
          role: "system",
          content:
            "You translate document text. Preserve numbers, placeholders, punctuation, whitespace intent, formatting markers, proper names, addresses, company names, tax IDs, invoice IDs, and URLs when appropriate. Return only a JSON array of strings with the same length and order as the input.",
        },
        {
          role: "user",
          content: `Translate every item to ${targetLanguage}.\n\n${JSON.stringify(chunk)}`,
        },
      ],
    });

    const parsed = parseJsonArray(response.choices[0].message.content);
    if (parsed.length !== chunk.length) {
      throw new Error("A traducao devolveu uma quantidade inesperada de segmentos.");
    }
    output.push(...parsed);
  }
  return output;
}

function getAIClient() {
  openaiClient ??= new OpenAI({
    apiKey: process.env.AI_API_KEY,
    baseURL: process.env.AI_BASE_URL || "https://api.groq.com/openai/v1",
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
