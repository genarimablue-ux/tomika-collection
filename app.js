import { CATALOG, MAX_NUMBER } from "./data/catalog.js";

const STORAGE_KEY = "tomica-collection-v1";
const MIGRATION_KEY = "tomica-cloud-migrated-v1";
const PLACEHOLDER_IMAGE = "./images/car-placeholder.svg";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const API_TIMEOUT_MS = 12_000;
const IMAGE_UPLOAD_TIMEOUT_MS = 45_000;
const numberLabel = (number) => `No. ${String(number).padStart(3, "0")}`;
const grid = document.querySelector("#tomica-grid");
const emptyState = document.querySelector("#empty-state");
const searchInput = document.querySelector("#search-input");
const undoButton = document.querySelector("#undo-button");
const toast = document.querySelector("#toast");
const resetDialog = document.querySelector("#reset-dialog");
const customDialog = document.querySelector("#custom-dialog");
const customForm = document.querySelector("#custom-form");
const importFile = document.querySelector("#import-file");
const syncStatus = document.querySelector("#sync-status");
const syncLabel = document.querySelector("#sync-label");

let activeFilter = "current";
let searchQuery = "";
let resetTarget = null;
let selectedImage = null;
let previewObjectUrl = null;
let toastTimer;
let cloudReady = false;
let cloudInitialLoadComplete = false;
let cloudSyncInFlight = false;
let collection = loadCollection();
const legacySnapshot = {
  counts: { ...collection.counts },
  customItems: collection.customItems.map((item) => ({ ...item })),
};

function emptyCollection() {
  return { counts: {}, customItems: [], revision: 0, canUndo: false };
}

function safeStorageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function sanitizeCounts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const counts = {};
  for (const [key, rawCount] of Object.entries(value)) {
    const number = Number(key);
    const count = Number(rawCount);
    if (Number.isInteger(number) && number >= 1 && number <= MAX_NUMBER && Number.isInteger(count) && count > 0) {
      counts[number] = count;
    }
  }
  return counts;
}

function sanitizeCustomItems(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item.id === "string" && typeof item.name === "string")
    .map((item) => ({
      id: item.id,
      name: item.name.slice(0, 120),
      imageUrl: safeImageUrl(item.imageUrl),
      quantity: Math.max(0, Math.min(9999, Number(item.quantity ?? item.count) || 0)),
      createdAt: String(item.createdAt || ""),
    }));
}

function loadCollection() {
  try {
    const stored = JSON.parse(safeStorageGet(STORAGE_KEY) || "null");
    if (!stored || typeof stored !== "object") return emptyCollection();
    return {
      counts: sanitizeCounts(stored.counts),
      customItems: sanitizeCustomItems(stored.customItems),
      revision: Math.max(0, Number(stored.revision) || 0),
      canUndo: Boolean(stored.canUndo),
    };
  } catch {
    return emptyCollection();
  }
}

function cacheCollection() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(collection));
  } catch {
    // Cloud storage remains authoritative if this browser blocks localStorage.
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function safeImageUrl(value) {
  const url = String(value || "").trim();
  if (url.startsWith("https://") || url.startsWith("./") || url.startsWith("../") || url.startsWith("/manus-storage/")) return url;
  return PLACEHOLDER_IMAGE;
}

function hasLegacyData(value) {
  return Object.keys(value.counts || {}).length > 0 || (value.customItems || []).length > 0;
}

function visibleCatalog() {
  const query = searchQuery.trim().toLocaleLowerCase("ja");
  const official = CATALOG.map((item) => ({
    ...item,
    kind: "official",
    key: String(item.number),
    quantity: Number(collection.counts[item.number] || 0),
  }));
  const custom = collection.customItems.map((item) => ({ ...item, kind: "custom", key: item.id }));
  let items;
  if (activeFilter === "current") items = official;
  else if (activeFilter === "other") items = custom;
  else items = [...official, ...custom];
  if (activeFilter === "owned") items = items.filter((item) => item.quantity > 0);
  if (query) {
    items = items.filter((item) => {
      const label = item.kind === "official" ? `${item.number} ${numberLabel(item.number)} ${item.name}` : item.name;
      return label.toLocaleLowerCase("ja").includes(query);
    });
  }
  return items;
}

function renderCard(item) {
  const isOwned = item.quantity > 0;
  const name = escapeHtml(item.name);
  const imageUrl = escapeHtml(safeImageUrl(item.imageUrl));
  const stateClass = isOwned ? " is-owned" : "";
  const tag = item.kind === "official" ? numberLabel(item.number) : "その他";
  const subtitle = isOwned ? `所持中 · ${item.quantity}台` : (item.kind === "custom" ? "家族の追加車両" : "コレクションに追加");
  const label = item.kind === "official" ? `${numberLabel(item.number)} ${name}` : `その他 ${name}`;

  return `
    <article class="tomica-card${stateClass}" data-kind="${item.kind}" data-key="${escapeHtml(item.key)}">
      <button class="card-main" type="button" data-action="increment" aria-label="${label}。タップして所持数を1台増やす" aria-pressed="${isOwned}">
        <span class="card-photo">
          <img class="tomica-image" src="${imageUrl}" alt="${name}のトミカ" loading="lazy" />
          <span class="number-tag${item.kind === "custom" ? " other-tag" : ""}">${escapeHtml(tag)}</span>
          <span class="owned-stamp" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="m3.5 8.2 2.8 2.8 6.2-6.3" /></svg></span>
        </span>
        <span class="card-body">
          <span class="card-title-wrap">
            <span class="card-name">${name}</span>
            <span class="card-subtitle">${escapeHtml(subtitle)}</span>
          </span>
          <span class="count-pill" aria-hidden="true">${isOwned ? `${item.quantity}台` : ""}</span>
        </span>
      </button>
      ${isOwned && activeFilter !== "all" ? `<button class="card-reset" type="button" data-action="reset" aria-label="${label}の所持状態をリセット" title="このトミカをリセット"><svg viewBox="0 0 18 18"><path d="M3.6 5.4h10.8M7 5.4V3.5h4v1.9m-5.2 0 .6 9.1h6.2l.6-9.1m-4.2 3v3.3m2-3.3v3.3" /></svg></button>` : ""}
      ${item.kind === "custom" ? `<div class="custom-card-tools"><span>家族の登録</span><button type="button" data-action="delete" aria-label="${name}をその他一覧から削除">削除</button></div>` : ""}
    </article>`;
}

function renderStats() {
  const officialCounts = Object.values(collection.counts);
  const officialOwned = officialCounts.length;
  const customOwned = collection.customItems.filter((item) => item.quantity > 0).length;
  const totalUnique = officialOwned + customOwned;
  const totalQuantity = officialCounts.reduce((sum, count) => sum + count, 0)
    + collection.customItems.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
  const percentage = Math.min(100, (officialOwned / MAX_NUMBER) * 100);
  const waitingForCloud = !cloudInitialLoadComplete && !hasLegacyData(collection);
  const offlineBeforeFirstLoad = waitingForCloud && syncStatus.dataset.state === "offline";
  const pendingValue = offlineBeforeFirstLoad ? "—" : "…";

  document.querySelector("#owned-count").textContent = waitingForCloud ? pendingValue : String(totalUnique);
  document.querySelector("#total-count").textContent = waitingForCloud ? pendingValue : String(totalQuantity);
  document.querySelector("#progress-label").textContent = waitingForCloud
    ? (offlineBeforeFirstLoad ? "未接続" : "読み込み中")
    : `${officialOwned} / ${MAX_NUMBER}`;
  document.querySelector("#progress-fill").style.width = `${percentage}%`;
  const progressBar = document.querySelector("#progress-bar");
  progressBar.setAttribute("aria-valuenow", String(officialOwned));
  progressBar.setAttribute("aria-valuemax", String(MAX_NUMBER));
  progressBar.setAttribute("aria-valuetext", waitingForCloud
    ? (offlineBeforeFirstLoad ? "未接続" : "読み込み中")
    : `${officialOwned} / ${MAX_NUMBER}種類`);
  document.querySelector("#current-tab-count").textContent = String(MAX_NUMBER);
  document.querySelector("#all-tab-count").textContent = waitingForCloud ? "…" : String(MAX_NUMBER + collection.customItems.length);
  document.querySelector("#other-tab-count").textContent = waitingForCloud ? "…" : String(collection.customItems.length);
  document.querySelector("#owned-tab-count").textContent = waitingForCloud ? pendingValue : String(totalUnique);
  undoButton.disabled = !collection.canUndo || !cloudReady;
  const addButton = document.querySelector("#add-custom-button");
  addButton.hidden = activeFilter !== "other";
  addButton.disabled = !cloudReady;
  document.querySelector("#empty-add-button").hidden = activeFilter !== "other" || !cloudReady;
}

function renderGrid() {
  const items = visibleCatalog();
  const searchHasQuery = Boolean(searchQuery.trim());
  grid.setAttribute("aria-busy", "true");
  if (!cloudInitialLoadComplete && !hasLegacyData(collection)) {
    const isOffline = syncStatus.dataset.state === "offline";
    grid.innerHTML = "";
    emptyState.hidden = false;
    emptyState.classList.add("is-loading");
    document.querySelector("#empty-mark").textContent = isOffline ? "↻" : "…";
    document.querySelector("#empty-title").textContent = isOffline ? "共有データに接続できません" : "登録状況を読み込み中";
    document.querySelector("#empty-copy").textContent = isOffline
      ? "通信を確認すると自動で再取得します。LINE内で続く場合はSafariなど外部ブラウザで開いてください。"
      : "家族の登録状況をクラウドから取得しています。少しお待ちください。";
    document.querySelector("#empty-add-button").hidden = true;
    document.querySelector("#result-count").textContent = isOffline ? "未接続" : "読み込み中";
    return;
  }
  emptyState.classList.remove("is-loading");
  document.querySelector("#empty-mark").textContent = "∅";
  grid.innerHTML = items.map(renderCard).join("");
  emptyState.hidden = items.length > 0;
  if (activeFilter === "other" && !searchHasQuery && items.length === 0) {
    document.querySelector("#empty-title").textContent = "その他の車両はまだありません";
    document.querySelector("#empty-copy").textContent = "写真と名前を登録して、家族のコレクションに追加できます。";
  } else {
    document.querySelector("#empty-title").textContent = "見つかりませんでした";
    document.querySelector("#empty-copy").textContent = "番号や名前を変えて、もう一度検索してください。";
  }
  document.querySelector("#result-count").textContent = `${items.length}台`;
  grid.querySelectorAll(".tomica-image").forEach((image) => {
    image.addEventListener("error", () => {
      if (!image.src.endsWith("car-placeholder.svg")) image.src = PLACEHOLDER_IMAGE;
    }, { once: true });
  });
  grid.setAttribute("aria-busy", "false");
}

function render() {
  renderStats();
  renderGrid();
}

function setSyncStatus(state) {
  const labels = { connecting: "接続中", syncing: "同期中", online: "同期済み", offline: "未接続" };
  syncStatus.dataset.state = state;
  syncLabel.textContent = labels[state] || labels.offline;
  syncStatus.setAttribute("aria-label", labels[state] || labels.offline);
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 2300);
}

async function apiRequest(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !(options.body instanceof Blob) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const timeoutMs = path === "/custom-image" ? IMAGE_UPLOAD_TIMEOUT_MS : API_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let data;
  try {
    response = await fetch(`/api${path}`, {
      cache: "no-store",
      ...options,
      headers,
      signal: controller.signal,
    });
    data = await response.json().catch((error) => {
      if (controller.signal.aborted || error?.name === "AbortError") throw error;
      return {};
    });
  } catch (error) {
    if (controller.signal.aborted || error?.name === "AbortError") {
      const seconds = Math.ceil(timeoutMs / 1000);
      throw new Error(path === "/custom-image"
        ? "画像のアップロードが時間切れになりました。写真を小さくして再度お試しください。"
        : `${seconds}秒以内にサーバーから応答がありませんでした。接続を確認して再試行します。`);
    }
    throw new Error("クラウドとの通信に失敗しました。接続を確認して、再度お試しください。");
  } finally {
    window.clearTimeout(timeoutId);
  }
  if (!response.ok) throw new Error(data.error || "クラウドとの通信に失敗しました。");
  return data;
}

async function migrateLegacyData(state) {
  if (safeStorageGet(MIGRATION_KEY) === "1") return state;
  let migratedState = state;
  if (hasLegacyData(legacySnapshot)) {
    setSyncStatus("syncing");
    migratedState = await apiRequest("/import", {
      method: "POST",
      body: JSON.stringify({ counts: legacySnapshot.counts, customItems: legacySnapshot.customItems }),
    });
    showToast("この端末の所持データを共有一覧へ引き継ぎました。");
  }
  try {
    localStorage.setItem(MIGRATION_KEY, "1");
  } catch {
    // An idempotent merge is safe to repeat if browser storage is unavailable.
  }
  return migratedState;
}

function applyCloudState(state, force = false) {
  const revision = Math.max(0, Number(state?.revision) || 0);
  if (!force && revision < collection.revision) return false;
  if (!force && revision === collection.revision) return false;
  collection = {
    counts: sanitizeCounts(state?.counts),
    customItems: sanitizeCustomItems(state?.customItems),
    revision,
    canUndo: Boolean(state?.canUndo),
  };
  cacheCollection();
  render();
  return true;
}

async function startCloudSync() {
  if (cloudSyncInFlight) return;
  cloudSyncInFlight = true;
  setSyncStatus("connecting");
  try {
    let state = await apiRequest("/state");
    state = await migrateLegacyData(state);
    cloudInitialLoadComplete = true;
    applyCloudState(state, true);
    cloudReady = true;
    setSyncStatus("online");
    render();
  } catch (error) {
    cloudReady = false;
    setSyncStatus("offline");
    render();
    showToast(error.message || "共有データに接続できません。再読み込みしてください。");
  } finally {
    cloudSyncInFlight = false;
    window.setInterval(syncCloudState, 3500);
  }
}

async function syncCloudState() {
  if (document.hidden || cloudSyncInFlight) return;
  cloudSyncInFlight = true;
  try {
    let state = await apiRequest("/state");
    state = await migrateLegacyData(state);
    const isFirstSuccessfulLoad = !cloudInitialLoadComplete;
    cloudInitialLoadComplete = true;
    if (isFirstSuccessfulLoad) applyCloudState(state, true);
    else if (state.revision !== collection.revision) applyCloudState(state);
    cloudReady = true;
    setSyncStatus("online");
    renderStats();
  } catch {
    cloudReady = false;
    setSyncStatus("offline");
    renderStats();
  } finally {
    cloudSyncInFlight = false;
  }
}

async function writeAndApply(path, options, successMessage) {
  if (!cloudReady) {
    showToast("共有データに接続できません。接続後にもう一度お試しください。");
    return null;
  }
  setSyncStatus("syncing");
  try {
    const state = await apiRequest(path, options);
    applyCloudState(state, true);
    cloudReady = true;
    setSyncStatus("online");
    renderStats();
    if (successMessage) showToast(successMessage);
    if (navigator.vibrate) navigator.vibrate(8);
    return state;
  } catch (error) {
    cloudReady = false;
    setSyncStatus("offline");
    render();
    showToast(error.message || "保存できませんでした。接続を確認してください。");
    return null;
  }
}

function itemLabel(kind, key) {
  if (kind === "official") {
    const number = Number(key);
    const item = CATALOG[number - 1];
    return `${numberLabel(number)}「${item?.name || ""}」`;
  }
  const item = collection.customItems.find((candidate) => candidate.id === key);
  return `その他「${item?.name || "登録車両"}」`;
}

function openReset(kind, key) {
  const item = kind === "official"
    ? CATALOG[Number(key) - 1]
    : collection.customItems.find((candidate) => candidate.id === key);
  if (!item) return;
  resetTarget = { kind, key };
  document.querySelector("#reset-copy").textContent = `${itemLabel(kind, key)}を所持数0台に戻します。家族全員の一覧に反映され、「ひとつ戻す」で取り消せます。`;
  resetDialog.showModal();
}

async function confirmReset() {
  if (!resetTarget) return;
  const { kind, key } = resetTarget;
  const path = kind === "official" ? `/counts/official/${encodeURIComponent(key)}/reset` : `/counts/custom/${encodeURIComponent(key)}/reset`;
  const state = await writeAndApply(path, { method: "PUT" }, `${itemLabel(kind, key)}をリセットしました。`);
  if (state) {
    resetDialog.close();
    resetTarget = null;
  }
}

async function handleGridAction(event) {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const card = button.closest(".tomica-card");
  if (!card) return;
  const { kind, key } = card.dataset;
  const action = button.dataset.action;
  if (action === "reset") {
    openReset(kind, key);
    return;
  }
  if (action === "delete" && kind === "custom") {
    const item = collection.customItems.find((candidate) => candidate.id === key);
    if (!item || !window.confirm(`「${item.name}」をその他一覧から削除しますか？\n所持データから非表示になり、写真データは保存領域に残ります。`)) return;
    await writeAndApply(`/custom-items/${encodeURIComponent(key)}`, { method: "DELETE" }, "その他の車両を削除しました。");
    return;
  }
  if (action === "increment") {
    const path = kind === "official"
      ? `/counts/official/${encodeURIComponent(key)}/increment`
      : `/counts/custom/${encodeURIComponent(key)}/increment`;
    await writeAndApply(path, { method: "POST" });
  }
}

async function undo() {
  if (!collection.canUndo || !cloudReady) return;
  await writeAndApply("/undo", { method: "POST" }, "共有データの直前の操作を取り消しました。");
}

function exportBackup() {
  const backup = {
    format: "tomica-collection-backup",
    version: 2,
    exportedAt: new Date().toISOString(),
    maxNumber: MAX_NUMBER,
    counts: collection.counts,
    customItems: collection.customItems,
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `tomica-collection-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast("共有データのバックアップを保存しました。");
}

async function importBackup(file) {
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (parsed.format !== "tomica-collection-backup" || ![1, 2].includes(parsed.version) || !parsed.counts) {
      throw new Error("backup format mismatch");
    }
    if (!window.confirm("バックアップの所持数を共有一覧へ統合します。同じ番号は多い方の個数を残し、登録車両は追加されます。続けますか？")) return;
    await writeAndApply("/import", {
      method: "POST",
      body: JSON.stringify({ counts: parsed.counts, customItems: parsed.customItems || [] }),
    }, "バックアップを共有一覧に統合しました。");
  } catch (error) {
    showToast(error.message === "backup format mismatch" ? "バックアップ形式を確認してください。" : "バックアップを読み込めませんでした。");
  } finally {
    importFile.value = "";
  }
}

function fileContentType(file) {
  const allowed = new Set(["image/jpeg", "image/png", "image/webp", "image/avif", "image/heic", "image/heif"]);
  if (allowed.has(file.type.toLowerCase())) return file.type.toLowerCase();
  const extension = file.name.split(".").pop()?.toLowerCase();
  const fromExtension = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
    avif: "image/avif", heic: "image/heic", heif: "image/heif",
  }[extension];
  return allowed.has(fromExtension) ? fromExtension : "";
}

function setSelectedImage(file) {
  if (!file) return;
  if (!fileContentType(file)) {
    showToast("JPEG・PNG・WebP・AVIF・HEIC形式の写真を選んでください。");
    return;
  }
  if (file.size > MAX_IMAGE_BYTES) {
    showToast("写真は8MB以下にしてください。");
    return;
  }
  selectedImage = file;
  if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
  previewObjectUrl = URL.createObjectURL(file);
  document.querySelector("#preview-image").src = previewObjectUrl;
  document.querySelector("#image-preview").hidden = false;
}

function resetCustomForm() {
  customForm.reset();
  selectedImage = null;
  if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
  previewObjectUrl = null;
  document.querySelector("#preview-image").removeAttribute("src");
  document.querySelector("#image-preview").hidden = true;
  document.querySelector("#save-custom").disabled = false;
  document.querySelector("#save-custom").textContent = "登録する";
}

async function addCustomItem(event) {
  event.preventDefault();
  if (!cloudReady) {
    showToast("共有データに接続できません。接続後に登録してください。");
    return;
  }
  const name = document.querySelector("#custom-name").value.trim();
  if (!name) {
    document.querySelector("#custom-name").focus();
    return;
  }
  if (!selectedImage) {
    showToast("カメラで撮るか、登録する写真を選んでください。");
    return;
  }
  const contentType = fileContentType(selectedImage);
  const saveButton = document.querySelector("#save-custom");
  saveButton.disabled = true;
  saveButton.textContent = "保存中…";
  setSyncStatus("syncing");
  try {
    const uploaded = await apiRequest("/custom-image", {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: selectedImage,
    });
    const state = await apiRequest("/custom-items", {
      method: "POST",
      body: JSON.stringify({ name, imageUrl: uploaded.imageUrl }),
    });
    applyCloudState(state, true);
    cloudReady = true;
    setSyncStatus("online");
    renderStats();
    customDialog.close();
    resetCustomForm();
    showToast("その他の車両を家族の一覧へ追加しました。");
  } catch (error) {
    cloudReady = false;
    setSyncStatus("offline");
    renderStats();
    saveButton.disabled = false;
    saveButton.textContent = "登録する";
    showToast(error.message || "写真と車両を保存できませんでした。");
  }
}

grid.addEventListener("click", handleGridAction);
undoButton.addEventListener("click", undo);
document.querySelector("#export-button").addEventListener("click", exportBackup);
document.querySelector("#import-button").addEventListener("click", () => importFile.click());
importFile.addEventListener("change", () => importBackup(importFile.files?.[0]));
document.querySelector("#confirm-reset").addEventListener("click", confirmReset);
document.querySelector("#cancel-reset").addEventListener("click", () => resetDialog.close());
resetDialog.addEventListener("click", (event) => {
  if (event.target === resetDialog) resetDialog.close();
});
searchInput.addEventListener("input", () => {
  searchQuery = searchInput.value;
  renderGrid();
});
document.querySelectorAll(".filter-tab").forEach((button) => {
  button.addEventListener("click", () => {
    activeFilter = button.dataset.filter;
    document.querySelectorAll(".filter-tab").forEach((tab) => {
      const selected = tab === button;
      tab.classList.toggle("is-active", selected);
      tab.setAttribute("aria-pressed", String(selected));
    });
    render();
  });
});
document.querySelector("#add-custom-button").addEventListener("click", () => {
  if (!cloudReady) return showToast("共有データに接続できません。");
  customDialog.showModal();
  document.querySelector("#custom-name").focus();
});
document.querySelector("#empty-add-button").addEventListener("click", () => document.querySelector("#add-custom-button").click());
document.querySelector("#cancel-custom").addEventListener("click", () => {
  customDialog.close();
  resetCustomForm();
});
customDialog.addEventListener("close", () => resetCustomForm());
customForm.addEventListener("submit", addCustomItem);
document.querySelector("#camera-button").addEventListener("click", () => document.querySelector("#camera-input").click());
document.querySelector("#gallery-button").addEventListener("click", () => document.querySelector("#gallery-input").click());
document.querySelector("#camera-input").addEventListener("change", (event) => setSelectedImage(event.target.files?.[0]));
document.querySelector("#gallery-input").addEventListener("change", (event) => setSelectedImage(event.target.files?.[0]));
document.querySelector("#remove-photo-button").addEventListener("click", () => {
  selectedImage = null;
  if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
  previewObjectUrl = null;
  document.querySelector("#preview-image").removeAttribute("src");
  document.querySelector("#image-preview").hidden = true;
  document.querySelector("#camera-input").value = "";
  document.querySelector("#gallery-input").value = "";
});
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !event.repeat) {
    event.preventDefault();
    undo();
  }
  if (event.key === "/" && document.activeElement !== searchInput && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) {
    event.preventDefault();
    searchInput.focus();
  }
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) syncCloudState();
});
window.addEventListener("online", syncCloudState);

render();
startCloudSync();
