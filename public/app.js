let allLogs = [];
let renderedLogsCount = 0;
const LOGS_CHUNK_SIZE = 50;

const statusIndicator = document.getElementById("gateway-status");
const refreshBtn = document.getElementById("refresh-btn");
const logsTbody = document.getElementById("logs-tbody");
const logsContainer = document.getElementById("logs-scroll-viewport");

refreshBtn.onclick = () => loadDashboard();

const STATUS_MAP = {
  "200": "status-200",
  "RPM": "status-rpm",
  "TPM": "status-tpm",
  "503": "status-503",
  "RPD": "status-rpd",
  "limit: 0": "status-zero",
  "KEY_ERR": "status-keyerr",
  "400": "status-keyerr",
  "401": "status-keyerr",
  "403": "status-keyerr",
  "404": "status-404",
  "UNDEFINED": "status-undefined",
};

async function loadDashboard() {
  statusIndicator.textContent = "SYNCING...";
  try {
    const savedToken = localStorage.getItem("dashboard_auth") || "";
    const headers = savedToken ? { "Authorization": `Bearer ${savedToken}` } : {};

    const res = await fetch("/api/stats", { headers });

    if (res.status === 401) {
      localStorage.removeItem("dashboard_auth");
      const pass = prompt("Доступ ограничен. Введите DASHBOARD_PASSWORD:");
      if (pass) {
        localStorage.setItem("dashboard_auth", pass.trim());
        return loadDashboard();
      }
      throw new Error("Требуется пароль дашборда");
    }

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    statusIndicator.textContent = "LIVE";

    renderOverview(data);
    renderKeys(data.discovery?.keysStatus || []);
    renderMatrix(data.matrix || {}, data.logs || []);
    renderModels(data.discovery);
    alignLayout();

    allLogs = data.logs || [];
    document.getElementById("logs-counter").textContent = `${allLogs.length} ENTRIES`;

    logsTbody.innerHTML = "";
    renderedLogsCount = 0;
    renderNextLogsChunk();

    if (data.discovery?.hasMoreUnchecked) {
      statusIndicator.textContent = "VALIDATING NEXT BATCH...";
      setTimeout(async () => {
        try {
          await fetch("/api/stats?validate_next=true", { headers });
          loadDashboard();
        } catch { }
      }, 1000);
    }
  } catch (err) {
    statusIndicator.textContent = "OFFLINE: " + err.message;
  }
}

function updateRpdCountdown() {
  const now = new Date();
  const nextMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
  const diffMs = Math.max(0, nextMidnight.getTime() - now.getTime());
  const totalMins = Math.floor(diffMs / (1000 * 60));
  const hrs = String(Math.floor(totalMins / 60)).padStart(2, "0");
  const mins = String(totalMins % 60).padStart(2, "0");
  const el = document.getElementById("rpd-reset-countdown");
  if (el) el.textContent = `${hrs}:${mins} (00:00 UTC)`;
}

setInterval(updateRpdCountdown, 30000);

function renderOverview(data) {
  document.getElementById("success-rate").textContent = data.successRate || "100% (0/0)";
  updateRpdCountdown();

  const r = data.lastResponse;
  if (r) {
    const d = new Date(r.timestamp);
    const timeFormatted = isNaN(d.getTime())
      ? r.timestamp.split("T")[1]?.slice(0, 5) || r.timestamp
      : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    document.getElementById("last-resp").textContent = `${r.model} (${r.keyId}) by ${r.user} at ${timeFormatted}`;
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

function formatKeyLabel(id) {
  if (!id) return "KEY";
  let s = id.trim();
  s = s.replace(/^GEMINI[-_]/i, "").trim();
  return s;
}

function renderKeys(keys) {
  const container = document.getElementById("keys-status-container");
  if (!keys.length) {
    container.innerHTML = "<div>NO GEMINI_KEY VARIABLES FOUND</div>";
    return;
  }

  container.innerHTML = keys.map(k => {
    let statusClass = "key-status-ok";
    let statusText = "VALID (200)";

    if (k.unchecked) {
      statusClass = "key-status-unchecked";
      statusText = "UNCHECKED (?)";
    } else if (!k.isValid) {
      statusClass = "key-status-bad";
      statusText = `INVALID (HTTP ${k.status})`;
    }

    const cleanId = formatKeyLabel(k.id);
    return `<div class="key-row"><span>${cleanId}</span><span class="${statusClass}">${statusText}</span></div>`;
  }).join("");
}

function alignLayout() {
  const smart = document.getElementById("smart-list");
  const lite = document.getElementById("lite-list");
  const raw = document.getElementById("raw-list");
  if (smart && smart.clientHeight > 0) {
    const h = smart.clientHeight;
    if (lite) lite.style.maxHeight = `${h}px`;
    if (raw) raw.style.maxHeight = `${h}px`;
  }

  const leftPanel = document.querySelector(".panel-left");
  const keysContainer = document.getElementById("keys-status-container");
  if (leftPanel && keysContainer) {
    if (window.innerWidth <= 900) {
      keysContainer.style.height = "auto";
      keysContainer.style.maxHeight = "350px";
    } else {
      const leftHeight = leftPanel.offsetHeight;
      const h2 = document.querySelector(".panel-right .sub-title");
      const titleHeight = h2 ? h2.offsetHeight : 20;
      // h2 margin-bottom is 16px
      const targetHeight = leftHeight - titleHeight - 16;
      if (targetHeight > 0) {
        keysContainer.style.height = `${targetHeight}px`;
        keysContainer.style.maxHeight = `${targetHeight}px`;
      }
    }
  }
}

function parseStatusFromLog(found) {
  if (!found) return "-";
  if (found.status === 200) return "200";
  const msg = (found.message || "").toUpperCase();
  if (msg.includes("RPD")) return "RPD";
  if (msg.includes("TPM")) return "TPM";
  if (msg.includes("RPM")) return "RPM";
  if (msg.includes("503") || found.status === 503) return "503";
  if (msg.includes("LIMIT: 0") || msg.includes("ZERO")) return "limit: 0";
  if (msg.includes("AUTH") || msg.includes("INVALID") || found.status === 401 || found.status === 403) return "KEY_ERR";
  if (msg.includes("404") || found.status === 404) return "404";
  return found.status ? String(found.status) : "UNDEFINED";
}

function renderMatrix(matrix, logs = []) {
  const table = document.getElementById("matrix-table");
  const thead = table.querySelector("thead");
  const tbody = table.querySelector("tbody");

  const models = Object.keys(matrix);
  if (!models.length) {
    thead.innerHTML = "";
    tbody.innerHTML = "<tr><td colspan=\"100\">NO DATA RECORDED</td></tr>";
    return;
  }

  const keys = Object.keys(matrix[models[0]] || {});
  thead.innerHTML = `<tr><th class="model-col-header">MODEL \\ KEY</th>${keys.map(k => {
    const compactKey = formatKeyLabel(k);
    return `<th class="key-col-header" title="${k}">${compactKey}</th>`;
  }).join("")}</tr>`;

  tbody.innerHTML = models.map(m => {
    // If the model is dead (404 or limit: 0), the entire row across all keys is banned
    let deadModelStatus = null;
    const modelDeadLog = logs.find(l => {
      if (l.model !== m) return false;
      const parsed = parseStatusFromLog(l);
      return parsed === "404" || parsed === "limit: 0";
    });
    if (modelDeadLog) {
      deadModelStatus = parseStatusFromLog(modelDeadLog);
    }

    const cells = keys.map(k => {
      const item = matrix[m][k] || { hits: 0, status: "-" };
      let statusText = item.status;

      // If the model is dead (404 or limit: 0), it takes precedence at the intersection
      if (deadModelStatus && (statusText === "-" || !statusText || statusText === "KEY_ERR")) {
        statusText = deadModelStatus;
      } else {
        // If the key is dead (401/403/KEY_ERR), the entire column across active models is banned
        const keyDeadLog = logs.find(l => l.key === k && parseStatusFromLog(l) === "KEY_ERR");
        if (keyDeadLog || statusText === "KEY_ERR") {
          statusText = "KEY_ERR";
        } else if (!statusText || statusText === "-") {
          const found = logs.find(l => l.model === m && l.key === k);
          statusText = found ? parseStatusFromLog(found) : (item.hits > 0 ? "200" : "-");
        }
      }
      const badgeClass = STATUS_MAP[statusText] || (statusText === "-" ? "status-none" : "status-undefined");
      return `<td class="matrix-cell"><span class="status-badge ${badgeClass}">${statusText}</span></td>`;
    }).join("");
    return `<tr><td class="model-name-cell" title="${m}"><strong>${m}</strong></td>${cells}</tr>`;
  }).join("");
}

function renderModels(disc) {
  const renderList = (id, items) => {
    document.getElementById(id).innerHTML = items?.length
      ? items.map(m => `<li>${m}</li>`).join("")
      : "<li>None</li>";
  };
  renderList("smart-list", disc?.smart);
  renderList("lite-list", disc?.lite);
  renderList("raw-list", disc?.rawModels);
  setTimeout(alignLayout, 50);
}

function renderNextLogsChunk() {
  if (renderedLogsCount >= allLogs.length) return;

  const nextSlice = allLogs.slice(renderedLogsCount, renderedLogsCount + LOGS_CHUNK_SIZE);
  const rowsHtml = nextSlice.map(l => {
    let localTime = "—";
    if (l.timestamp) {
      const d = new Date(l.timestamp);
      localTime = isNaN(d.getTime()) ? l.timestamp : d.toLocaleTimeString();
    }

    return `<tr>
      <td>${localTime}</td>
      <td class="lvl-${l.level}">${(l.level || "").toUpperCase()}</td>
      <td>${l.message || ""}</td>
      <td>${l.model || "—"}</td>
      <td>${l.key || "—"}</td>
      <td>${l.status || "—"}</td>
      <td>${l.durationMs != null ? `${l.durationMs}ms` : "—"}</td>
    </tr>`;
  }).join("");

  logsTbody.insertAdjacentHTML("beforeend", rowsHtml);
  renderedLogsCount += nextSlice.length;
}

logsContainer.addEventListener("scroll", () => {
  if (logsContainer.scrollTop + logsContainer.clientHeight >= logsContainer.scrollHeight - 100) {
    renderNextLogsChunk();
  }
});

// Theme Logic
const themeToggle = document.getElementById("theme-toggle-box");
const root = document.documentElement;

function initTheme() {
  const savedTheme = localStorage.getItem("gateway_theme");
  const systemDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = savedTheme || (systemDark ? "dark" : "light");
  root.setAttribute("data-theme", theme);
  document.body.setAttribute("data-theme", theme);
}

themeToggle.onclick = () => {
  const currentTheme = root.getAttribute("data-theme") || "light";
  const newTheme = currentTheme === "light" ? "dark" : "light";
  root.setAttribute("data-theme", newTheme);
  document.body.setAttribute("data-theme", newTheme);
  localStorage.setItem("gateway_theme", newTheme);
};

initTheme();
loadDashboard();
window.addEventListener("resize", alignLayout);
