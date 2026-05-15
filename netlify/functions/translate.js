import JSZip from "jszip";
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const model = process.env.OPENAI_MODEL || "gpt-5.2";
const officeMime = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

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

    if (!["docx", "pptx", "xlsx"].includes(extension)) {
      return json(
        {
          error:
            "Nesta versao ja traduzimos DOCX, PPTX, XLSX e TXT. PDF fica para a fase seguinte com processamento proprio de layout.",
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
    return json({ error: error.message || "Erro inesperado ao traduzir." }, 500);
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
  for (const chunk of chunkTexts(texts)) {
    const response = await client.responses.create({
      model,
      instructions:
        "You translate document text. Preserve numbers, placeholders, punctuation, whitespace intent, and formatting markers. Return only a JSON array of strings with the same length and order as the input.",
      input: `Translate every item to ${targetLanguage}. Keep product names and URLs unchanged when appropriate.\n\n${JSON.stringify(
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
