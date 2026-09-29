let allLogs = [];
let renderedLogsCount = 0;
const LOGS_CHUNK_SIZE = 50;

const statusIndicator = document.getElementById("gateway-status");
const refreshBtn = document.getElementById("refresh-btn");
const logsTbody = document.getElementById("logs-tbody");
const logsContainer = document.getElementById("logs-scroll-viewport");

refreshBtn.onclick = () => loadDashboard();

const API_BASE = (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
  ? "https://gemini-edge-gateway.sergey-pugin080107.workers.dev"
  : "";

async function loadDashboard() {
  statusIndicator.textContent = "SYNCING...";
  try {
    const res = await fetch(`${API_BASE}/api/stats`);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();

    statusIndicator.textContent = "LIVE";

    renderOverview(data);
    renderKeys(data.discovery?.keysStatus || []);
    renderMatrix(data.matrix || {});
    renderModels(data.discovery);

    allLogs = data.logs || [];
    document.getElementById("logs-counter").textContent = `${allLogs.length} ENTRIES`;

    // Сброс и рендер первой пачки логов
    logsTbody.innerHTML = "";
    renderedLogsCount = 0;
    renderNextLogsChunk();

  } catch (err) {
    statusIndicator.textContent = "OFFLINE: " + err.message;
  }
}

function renderOverview(data) {
  document.getElementById("total-reqs").textContent = data.totalRequests;

  if (data.lastResponse) {
    const r = data.lastResponse;
    document.getElementById("last-resp").textContent =
      `${r.model} (${r.keyId}) by ${r.user} at ${r.timestamp.split("T")[1].replace("Z", "")}`;
  } else {
    document.getElementById("last-resp").textContent = "NO TRAFFIC YET";
  }

  const lastDisc = data.discovery?.lastUpdated;
  if (lastDisc) {
    const d = new Date(lastDisc);
    document.getElementById("last-disc").textContent = isNaN(d.getTime()) ? lastDisc : d.toLocaleString();
  } else {
    document.getElementById("last-disc").textContent = "NOT INITIALIZED";
  }
}

function renderKeys(keys) {
  const container = document.getElementById("keys-status-container");
  if (!keys.length) {
    container.innerHTML = "<div>NO GEMINI_KEY VARIABLES FOUND</div>";
    return;
  }
  container.innerHTML = keys.map(k => `
    <div class="key-row">
      <span>${k.id}</span>
      <span class="${k.isValid ? 'key-status-ok' : 'key-status-bad'}">
        ${k.isValid ? 'VALID (200)' : 'INVALID (HTTP ' + k.status + ')'}
      </span>
    </div>
  `).join("");
}

function renderMatrix(matrix) {
  const table = document.getElementById("matrix-table");
  const thead = table.querySelector("thead");
  const tbody = table.querySelector("tbody");

  const models = Object.keys(matrix);
  if (!models.length) {
    thead.innerHTML = "";
    tbody.innerHTML = "<tr><td>NO DATA RECORDED</td></tr>";
    return;
  }

  const keys = Object.keys(matrix[models[0]] || {});
  thead.innerHTML = "<tr><th>MODEL \\ KEY</th>" + keys.map(k => `<th>${k}</th>`).join("") + "</tr>";

  tbody.innerHTML = models.map(m => {
    const cells = keys.map(k => {
      const item = matrix[m][k] || { hits: 0, percentage: 0 };
      return `<td>${item.percentage}% (${item.hits})</td>`;
    }).join("");
    return `<tr><td><strong>${m}</strong></td>${cells}</tr>`;
  }).join("");
}

function renderModels(disc) {
  document.getElementById("smart-list").innerHTML =
    (disc?.smart || []).map(m => `<li>${m}</li>`).join("") || "<li>None</li>";
  document.getElementById("lite-list").innerHTML =
    (disc?.lite || []).map(m => `<li>${m}</li>`).join("") || "<li>None</li>";
  document.getElementById("raw-list").innerHTML =
    (disc?.rawModels || []).map(m => `<li>${m}</li>`).join("") || "<li>None</li>";
}

// Виртуальный рендер: подгружает логи порциями по 50 строк при скролле
function renderNextLogsChunk() {
  if (renderedLogsCount >= allLogs.length) return;

  const nextSlice = allLogs.slice(renderedLogsCount, renderedLogsCount + LOGS_CHUNK_SIZE);
  const rowsHtml = nextSlice.map(l => {
    let localTime = "—";
    if (l.timestamp) {
      const d = new Date(l.timestamp);
      localTime = isNaN(d.getTime()) ? l.timestamp : d.toLocaleTimeString();
    }

    return `
      <tr>
        <td>${localTime}</td>
        <td class="lvl-${l.level}">${(l.level || "").toUpperCase()}</td>
        <td>${l.message || ""}</td>
        <td>${l.model || "—"}</td>
        <td>${l.key || "—"}</td>
        <td>${l.status || "—"}</td>
        <td>${l.durationMs != null ? l.durationMs + 'ms' : "—"}</td>
      </tr>
    `;
  }).join("");

  logsTbody.insertAdjacentHTML("beforeend", rowsHtml);
  renderedLogsCount += nextSlice.length;
}

// Слушатель скролла для бесконечной подгрузки
logsContainer.addEventListener("scroll", () => {
  if (logsContainer.scrollTop + logsContainer.clientHeight >= logsContainer.scrollHeight - 100) {
    renderNextLogsChunk();
  }
});

loadDashboard();
