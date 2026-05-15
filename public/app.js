const form = document.querySelector("#translator-form");
const fileInput = document.querySelector("#document-file");
const dropZone = document.querySelector("#drop-zone");
const fileTitle = document.querySelector("#file-title");
const fileMeta = document.querySelector("#file-meta");
const statusPill = document.querySelector("#status-pill");
const submitButton = document.querySelector("#submit-button");
const progressArea = document.querySelector("#progress-area");
const progressText = document.querySelector("#progress-text");
const resultArea = document.querySelector("#result-area");
const downloadLink = document.querySelector("#download-link");

const maxBrowserPayloadMb = 5;

function setFile(file) {
  if (!file) return;
  fileTitle.textContent = file.name;
  fileMeta.textContent = `${formatBytes(file.size)} - ${file.type || "documento"}`;
  resultArea.hidden = true;
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result);
      resolve(value.slice(value.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function setBusy(isBusy, message = "A traduzir o documento...") {
  submitButton.disabled = isBusy;
  if (isBusy) {
    progressArea.hidden = false;
    statusPill.textContent = "A traduzir";
    progressText.textContent = message;
  }
}

fileInput.addEventListener("change", () => setFile(fileInput.files?.[0]));

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("is-dragging");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("is-dragging");
});

dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("is-dragging");
  const file = event.dataTransfer.files?.[0];
  if (!file) return;
  fileInput.files = event.dataTransfer.files;
  setFile(file);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = fileInput.files?.[0];
  if (!file) return;

  if (file.size > maxBrowserPayloadMb * 1024 * 1024) {
    statusPill.textContent = "Ficheiro grande";
    progressArea.hidden = false;
    progressText.textContent = `Nesta versao, use ficheiros ate ${maxBrowserPayloadMb} MB.`;
    return;
  }

  try {
    setBusy(true, "A ler o ficheiro...");
    const base64 = await fileToBase64(file);
    setBusy(true, "A enviar para traducao...");

    const response = await fetch("/.netlify/functions/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: file.name,
        mimeType: file.type,
        targetLanguage: new FormData(form).get("targetLanguage"),
        base64,
      }),
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Nao foi possivel traduzir o documento.");
    }

    const blob = base64ToBlob(payload.base64, payload.mimeType);
    downloadLink.href = URL.createObjectURL(blob);
    downloadLink.download = payload.fileName;
    resultArea.hidden = false;
    progressArea.hidden = true;
    statusPill.textContent = "Concluido";
  } catch (error) {
    statusPill.textContent = "Erro";
    progressArea.hidden = false;
    progressText.textContent = error.message;
  } finally {
    setBusy(false);
  }
});

function base64ToBlob(base64, mimeType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
}
