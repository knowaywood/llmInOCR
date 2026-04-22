function resolveInvoke() {
  if (typeof window.__TAURI__?.core?.invoke === "function") {
    return window.__TAURI__.core.invoke;
  }

  if (typeof window.__TAURI_INTERNALS__?.invoke === "function") {
    return window.__TAURI_INTERNALS__.invoke;
  }

  return null;
}

const invoke = resolveInvoke();
const listen = resolveListen();

const IMAGE_MAX_EDGE = 1600;
const IMAGE_OUTPUT_TYPE = "image/jpeg";
const IMAGE_QUALITY = 0.82;
const STREAM_EVENT = "convert-stream";

const state = {
  images: [],
  busy: false,
  currentRequestId: null,
  unlistenStream: null,
};

function resolveListen() {
  if (typeof window.__TAURI__?.event?.listen === "function") {
    return window.__TAURI__.event.listen;
  }

  if (typeof window.__TAURI_INTERNALS__?.event?.listen === "function") {
    return window.__TAURI_INTERNALS__.event.listen;
  }

  return null;
}

const tabs = document.querySelectorAll(".tab-btn");
const panels = {
  convert: document.getElementById("panel-convert"),
  settings: document.getElementById("panel-settings"),
};

const imagePreview = document.getElementById("image-preview");
const imageList = document.getElementById("image-list");
const fileInput = document.getElementById("file-input");
const selectImagesBtn = document.getElementById("select-images");
const deleteSelectedBtn = document.getElementById("delete-selected");
const inputText = document.getElementById("input-text");
const stopBtn = document.getElementById("stop-btn");
const convertBtn = document.getElementById("convert-btn");
const outputText = document.getElementById("output-text");
const resultMeta = document.getElementById("result-meta");
const copyResultBtn = document.getElementById("copy-result");
const statusLabel = document.getElementById("status-label");

const outputFormat = document.getElementById("output-format");
const themeMode = document.getElementById("theme-mode");
const modelInput = document.getElementById("model");
const apiKeyInput = document.getElementById("api-key");
const baseUrlInput = document.getElementById("base-url");
const saveSettingsBtn = document.getElementById("save-settings");
const settingsFeedback = document.getElementById("settings-feedback");
const systemThemeQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
let settingsFeedbackTimer = null;

function setStatus(message) {
  statusLabel.textContent = message;
}

function setResultMeta(format, model) {
  if (!resultMeta) {
    return;
  }
  const shownFormat = format || "-";
  const shownModel = model || "-";
  resultMeta.textContent = `Format: ${shownFormat} | Model: ${shownModel}`;
}

function setSettingsFeedback(message, type = "success") {
  if (!settingsFeedback) {
    return;
  }

  if (settingsFeedbackTimer) {
    clearTimeout(settingsFeedbackTimer);
    settingsFeedbackTimer = null;
  }

  settingsFeedback.textContent = message;
  settingsFeedback.classList.remove("success", "error");
  settingsFeedback.classList.add(type === "error" ? "error" : "success");

  settingsFeedbackTimer = setTimeout(() => {
    settingsFeedback.textContent = "";
    settingsFeedback.classList.remove("success", "error");
    settingsFeedbackTimer = null;
  }, 3000);
}

function setBusy(busy, message) {
  state.busy = busy;
  convertBtn.disabled = busy;
  stopBtn.disabled = !busy;
  selectImagesBtn.disabled = busy;
  copyResultBtn.disabled = busy;
  saveSettingsBtn.disabled = busy;
  deleteSelectedBtn.disabled = busy || imageList.selectedOptions.length === 0;
  setStatus(message);
}

function switchTab(name) {
  tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === name));
  Object.entries(panels).forEach(([panelName, panel]) => {
    panel.classList.toggle("active", panelName === name);
  });
}

function updatePreview() {
  const selected = Array.from(imageList.selectedOptions);
  if (selected.length > 1) {
    imagePreview.innerHTML = `${selected.length} images selected`;
    return;
  }

  const idx = selected.length === 1 ? Number(selected[0].value) : state.images.length - 1;
  const item = state.images[idx];

  if (!item) {
    imagePreview.textContent = "No image attached";
    return;
  }

  imagePreview.innerHTML = `<img src="${item.dataUrl}" alt="${item.name}" />`;
}

function refreshImageList() {
  imageList.innerHTML = "";
  state.images.forEach((img, idx) => {
    const option = document.createElement("option");
    option.value = String(idx);
    option.textContent = `${idx + 1}. ${img.name}`;
    imageList.appendChild(option);
  });

  if (state.images.length > 0) {
    imageList.options[state.images.length - 1].selected = true;
  }

  deleteSelectedBtn.disabled = state.busy || imageList.selectedOptions.length === 0;
  updatePreview();
}

function normalizeDataUrl(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
    return null;
  }
  return dataUrl;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = dataUrl;
  });
}

function scaledSize(width, height, maxEdge) {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) {
    return { width, height };
  }

  const ratio = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

function canvasToDataUrl(canvas, type = IMAGE_OUTPUT_TYPE, quality = IMAGE_QUALITY) {
  return canvas.toDataURL(type, quality);
}

async function compressImageDataUrl(dataUrl) {
  const normalized = normalizeDataUrl(dataUrl);
  if (!normalized) {
    return null;
  }

  const img = await loadImage(normalized);
  const size = scaledSize(img.naturalWidth || img.width, img.naturalHeight || img.height, IMAGE_MAX_EDGE);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas 2D context is unavailable");
  }

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvasToDataUrl(canvas);
}

function estimateBytes(dataUrl) {
  const base64 = typeof dataUrl === "string" ? dataUrl.split(",")[1] || "" : "";
  return Math.floor((base64.length * 3) / 4);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function createRequestId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function prepareImagesForUpload(images) {
  const compressed = [];
  let originalBytes = 0;
  let compressedBytes = 0;

  for (const image of images) {
    originalBytes += estimateBytes(image.dataUrl);
    const dataUrl = await compressImageDataUrl(image.dataUrl);
    if (!dataUrl) {
      continue;
    }

    compressed.push({
      name: image.name,
      dataUrl,
    });
    compressedBytes += estimateBytes(dataUrl);
  }

  return {
    images: compressed,
    stats: {
      sourceCount: images.length,
      uploadCount: compressed.length,
      originalBytes,
      compressedBytes,
    },
  };
}

async function ensureStreamListener() {
  if (state.unlistenStream || !listen) {
    return;
  }

  state.unlistenStream = await listen(STREAM_EVENT, (event) => {
    const payload = event?.payload;
    if (!payload || payload.request_id !== state.currentRequestId) {
      return;
    }

    if (payload.kind === "start") {
      outputText.value = "";
      setStatus(payload.message || "Streaming response...");
      return;
    }

    if (payload.kind === "chunk") {
      outputText.value += payload.chunk || "";
      outputText.scrollTop = outputText.scrollHeight;
      setStatus("Receiving streamed result...");
      return;
    }

    if (payload.kind === "error") {
      setStatus(payload.message || "Streaming failed");
    }
  });
}

async function addImageFiles(fileList, source = "file") {
  let added = 0;
  let clipboardSeq = state.images.length + 1;

  for (const file of fileList) {
    if (!file.type.startsWith("image/")) {
      continue;
    }

    try {
      const dataUrl = await readFileAsDataUrl(file);
      const normalized = normalizeDataUrl(dataUrl);
      if (!normalized) {
        continue;
      }

      const displayName = source === "clipboard" ? `clipboard-${clipboardSeq++}.png` : file.name;
      state.images.push({
        name: displayName,
        dataUrl: normalized,
      });
      added += 1;
    } catch {
      // Ignore single file failure and continue with others.
    }
  }

  if (added === 0) {
    setStatus("No valid image was added.");
    return;
  }

  refreshImageList();
  const prefix = source === "clipboard" ? "Pasted" : source === "drop" ? "Dropped" : "Attached";
  setStatus(`${prefix}: ${added} image(s). Total: ${state.images.length}`);
}

function selectedImageIndices() {
  return Array.from(imageList.selectedOptions)
    .map((opt) => Number(opt.value))
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => b - a);
}

function resolvedTheme(mode) {
  if (mode === "system") {
    return systemThemeQuery?.matches ? "dark" : "light";
  }

  return mode === "dark" ? "dark" : "light";
}

function applyTheme(mode) {
  document.documentElement.dataset.theme = resolvedTheme(mode);
}

function bindSystemTheme() {
  if (!systemThemeQuery) {
    return;
  }

  const handleChange = () => {
    if (themeMode.value === "system") {
      applyTheme("system");
    }
  };

  if (typeof systemThemeQuery.addEventListener === "function") {
    systemThemeQuery.addEventListener("change", handleChange);
    return;
  }

  if (typeof systemThemeQuery.addListener === "function") {
    systemThemeQuery.addListener(handleChange);
  }
}

async function loadSettings() {
  const settings = await invoke("get_settings");
  outputFormat.value = settings.output_format;
  themeMode.value = settings.theme_mode || "system";
  modelInput.value = settings.model;
  apiKeyInput.value = settings.api_key || "";
  baseUrlInput.value = settings.qwen_base_url || "";
  setResultMeta(settings.output_format, settings.model);
  applyTheme(themeMode.value);
}

async function saveSettings() {
  const model = modelInput.value.trim();
  if (!model) {
    setSettingsFeedback("Model cannot be empty.", "error");
    return;
  }

  const req = {
    output_format: outputFormat.value,
    theme_mode: themeMode.value,
    model,
    api_key: apiKeyInput.value.trim() || null,
    qwen_base_url: baseUrlInput.value.trim() || null,
  };

  saveSettingsBtn.disabled = true;
  try {
    await invoke("update_settings", { req });
    applyTheme(themeMode.value);
    setResultMeta(outputFormat.value, model);
    setStatus("Settings saved");
    setSettingsFeedback("Settings saved successfully.", "success");
  } catch (err) {
    const message = typeof err === "string" ? err : JSON.stringify(err);
    setSettingsFeedback(`Failed to save settings: ${message}`, "error");
  } finally {
    saveSettingsBtn.disabled = state.busy;
  }
}

async function runConvert() {
  const text = inputText.value.trim();

  if (state.images.length === 0 && !text) {
    alert("Please enter text or attach images first.");
    return;
  }

  await ensureStreamListener();
  const requestId = createRequestId();
  state.currentRequestId = requestId;
  outputText.value = "";
  setBusy(true, state.images.length > 0 ? `Preparing images... (${state.images.length} images)` : "Converting text...");

  try {
    let images = [];
    if (state.images.length > 0) {
      const prepared = await prepareImagesForUpload(state.images);
      images = prepared.images.map((img) => ({ name: img.name, data_url: img.dataUrl }));
      setStatus(
        `Uploading ${prepared.stats.uploadCount} image(s), source ${prepared.stats.sourceCount}. ` +
          `${formatBytes(prepared.stats.originalBytes)} -> ${formatBytes(prepared.stats.compressedBytes)}`,
      );
    }

    const req = {
      request_id: requestId,
      text,
      images,
    };

    const result = await invoke("convert", { req });
    outputText.value = result.result || "";
    setResultMeta(result.output_format, result.model);
    setBusy(false, "Conversion completed");
  } catch (err) {
    const message = typeof err === "string" ? err : JSON.stringify(err);
    if (message === "Conversion cancelled.") {
      setBusy(false, "Conversion cancelled");
      return;
    }

    setBusy(false, "Conversion failed");
    alert(message);
  }
}

async function stopConvert() {
  if (!state.busy) {
    return;
  }

  setStatus("Cancelling...");
  try {
    await invoke("cancel_convert");
  } catch (err) {
    const message = typeof err === "string" ? err : JSON.stringify(err);
    setStatus("Cancel failed");
    alert(message);
  }
}

async function copyResult() {
  const content = outputText.value.trim();
  if (!content) {
    alert("There is no result to copy.");
    return;
  }

  try {
    await navigator.clipboard.writeText(content);
    setStatus("Result copied to clipboard");
  } catch {
    outputText.focus();
    outputText.select();
    document.execCommand("copy");
    setStatus("Result copied to clipboard");
  }
}

function bindEvents() {
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });

  imageList.addEventListener("change", () => {
    deleteSelectedBtn.disabled = state.busy || imageList.selectedOptions.length === 0;
    updatePreview();
  });

  selectImagesBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    await addImageFiles(fileInput.files, "file");
    fileInput.value = "";
  });

  deleteSelectedBtn.addEventListener("click", () => {
    const rows = selectedImageIndices();
    if (rows.length === 0) {
      return;
    }
    rows.forEach((idx) => {
      if (idx >= 0 && idx < state.images.length) {
        state.images.splice(idx, 1);
      }
    });
    refreshImageList();
    setStatus(`Deleted selected images. Remaining: ${state.images.length}`);
  });

  inputText.addEventListener("dragover", (event) => {
    event.preventDefault();
  });

  inputText.addEventListener("drop", async (event) => {
    event.preventDefault();
    if (state.busy) {
      return;
    }
    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      await addImageFiles(files, "drop");
    }
  });

  inputText.addEventListener("paste", async (event) => {
    if (state.busy) {
      return;
    }

    const items = event.clipboardData?.items;
    if (!items) {
      return;
    }

    const files = [];
    for (const item of items) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) {
          files.push(file);
        }
      }
    }

    if (files.length > 0) {
      event.preventDefault();
      await addImageFiles(files, "clipboard");
    }
  });

  convertBtn.addEventListener("click", runConvert);
  stopBtn.addEventListener("click", stopConvert);
  saveSettingsBtn.addEventListener("click", saveSettings);
  copyResultBtn.addEventListener("click", copyResult);
  themeMode.addEventListener("change", () => applyTheme(themeMode.value));
}

async function bootstrap() {
  if (!invoke) {
    alert("Tauri API not available. Please run inside Tauri.");
    return;
  }

  bindSystemTheme();
  bindEvents();
  refreshImageList();

  try {
    await loadSettings();
  } catch (err) {
    const message = typeof err === "string" ? err : JSON.stringify(err);
    alert(`Failed to load settings: ${message}`);
  }
}

bootstrap();
