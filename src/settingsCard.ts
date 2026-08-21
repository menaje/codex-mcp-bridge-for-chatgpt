import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const SETTINGS_CARD_URI = "ui://codex-mcp-bridge/settings-v4.html";
export const SETTINGS_CARD_MIME_TYPE = "text/html;profile=mcp-app";

export function registerSettingsCardResource(server: McpServer): void {
  server.registerResource(
    "codex-settings-card",
    SETTINGS_CARD_URI,
    {
      title: "Codex Bridge Settings",
      description: "Interactive settings card for user-configurable Codex bridge preferences.",
      mimeType: SETTINGS_CARD_MIME_TYPE
    },
    async () => ({
      contents: [
        {
          uri: SETTINGS_CARD_URI,
          mimeType: SETTINGS_CARD_MIME_TYPE,
          text: SETTINGS_CARD_HTML,
          _meta: {
            ui: {
              prefersBorder: true,
              csp: {
                connectDomains: [],
                resourceDomains: []
              },
              domain: "https://web-sandbox.oaiusercontent.com"
            },
            "openai/widgetDescription":
              "Configure saved access, model, working-directory, session, timeout, and concurrency defaults for the MacBook Air Codex Bridge.",
            "openai/widgetPrefersBorder": true,
            "openai/widgetCSP": {
              connect_domains: [],
              resource_domains: []
            },
            "openai/widgetDomain": "https://web-sandbox.oaiusercontent.com"
          }
        }
      ]
    })
  );
}

export const SETTINGS_CARD_HTML = String.raw`<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Codex Bridge 설정</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --surface: color-mix(in srgb, Canvas 96%, CanvasText 4%);
      --muted: color-mix(in srgb, CanvasText 62%, transparent);
      --border: color-mix(in srgb, CanvasText 16%, transparent);
      --accent: #1777ff;
      --danger: #c34132;
    }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 12px; background: transparent; color: CanvasText; }
    .card { border: 1px solid var(--border); border-radius: 16px; background: var(--surface); padding: 16px; }
    header { display: flex; gap: 12px; justify-content: space-between; align-items: start; margin-bottom: 14px; }
    h1 { font-size: 18px; line-height: 1.3; margin: 0; }
    .scope { font-size: 12px; color: var(--muted); margin: 4px 0 0; }
    .revision { font-size: 11px; color: var(--muted); white-space: nowrap; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .wide { grid-column: 1 / -1; }
    label { display: grid; gap: 6px; font-size: 12px; font-weight: 650; }
    select, input {
      width: 100%; min-height: 38px; border: 1px solid var(--border); border-radius: 10px;
      background: Canvas; color: CanvasText; padding: 8px 10px; font: inherit;
    }
    .hint { font-size: 11px; line-height: 1.45; font-weight: 400; color: var(--muted); }
    .warning { display: none; margin: 12px 0 0; border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent); border-radius: 10px; padding: 10px; color: var(--danger); font-size: 12px; line-height: 1.45; }
    .warning.show { display: block; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 16px; }
    button { min-height: 36px; border: 1px solid var(--border); border-radius: 10px; padding: 7px 12px; background: Canvas; color: CanvasText; font-weight: 650; cursor: pointer; }
    button.primary { border-color: var(--accent); background: var(--accent); color: white; }
    button:disabled { cursor: wait; opacity: .6; }
    #status { flex: 1; min-width: 180px; font-size: 12px; color: var(--muted); text-align: right; }
    #status.error { color: var(--danger); }
    @media (max-width: 560px) { .grid { grid-template-columns: 1fr; } .wide { grid-column: auto; } #status { text-align: left; } }
  </style>
</head>
<body>
  <main class="card">
    <header>
      <div>
        <h1>MacBook Air Codex Bridge 설정</h1>
        <p class="scope" id="scope">이 브리지 연결 전체에 적용되는 공유 설정입니다.</p>
      </div>
      <span class="revision" id="revision">불러오는 중…</span>
    </header>

    <form id="settings-form">
      <div class="grid">
        <label class="wide">접근 전략
          <select id="access-strategy"></select>
          <span class="hint" id="access-hint"></span>
        </label>

        <label>기본 모델
          <select id="default-model"></select>
          <span class="hint">설치된 Codex CLI에서 현재 모델 목록을 읽습니다.</span>
        </label>

        <label>기본 에포트
          <select id="default-effort"></select>
          <span class="hint">선택한 모델이 지원하는 값만 표시합니다.</span>
        </label>

        <label class="wide">기본 작업 폴더
          <input id="default-cwd" type="text" list="allowed-roots" autocomplete="off" spellcheck="false" />
          <datalist id="allowed-roots"></datalist>
          <span class="hint" id="cwd-hint"></span>
        </label>

        <label>기본 세션 방식
          <select id="session-mode">
            <option value="auto">최근 호환 세션 자동 연결</option>
            <option value="new">항상 새 세션</option>
          </select>
        </label>

        <label>자동 연결 유효시간 (시간)
          <input id="resume-hours" type="number" min="0.0167" step="any" required />
        </label>

        <label>작업 타임아웃 (분)
          <input id="timeout-minutes" type="number" min="1" step="any" required />
        </label>

        <label>최대 동시 작업 수
          <input id="concurrency" type="number" min="1" step="1" required />
        </label>
      </div>

      <div class="warning" id="full-warning">
        전체 접근 고정은 새 작업을 macOS 사용자 권한의 파일시스템·네트워크 전체 접근으로 실행합니다. 허용 작업 폴더는 시작 위치만 제한하며 OS 격리가 아닙니다.
      </div>
      <div class="warning" id="catalog-warning"></div>

      <div class="actions">
        <button class="primary" id="save" type="submit">설정 저장</button>
        <button id="refresh" type="button">모델 목록 새로고침</button>
        <button id="reset" type="button">운영자 기본값 복원</button>
        <span id="status" role="status" aria-live="polite"></span>
      </div>
    </form>
  </main>

  <script>
    const pendingRequests = new Map();
    const SETTINGS_REQUEST_TIMEOUT_MS = 90000;
    let nextRequestId = 1;
    let view = null;

    const elements = {
      form: document.getElementById("settings-form"),
      access: document.getElementById("access-strategy"),
      accessHint: document.getElementById("access-hint"),
      model: document.getElementById("default-model"),
      effort: document.getElementById("default-effort"),
      cwd: document.getElementById("default-cwd"),
      roots: document.getElementById("allowed-roots"),
      cwdHint: document.getElementById("cwd-hint"),
      session: document.getElementById("session-mode"),
      resume: document.getElementById("resume-hours"),
      timeout: document.getElementById("timeout-minutes"),
      concurrency: document.getElementById("concurrency"),
      save: document.getElementById("save"),
      refresh: document.getElementById("refresh"),
      reset: document.getElementById("reset"),
      status: document.getElementById("status"),
      revision: document.getElementById("revision"),
      scope: document.getElementById("scope"),
      fullWarning: document.getElementById("full-warning"),
      catalogWarning: document.getElementById("catalog-warning")
    };

    const accessLabels = {
      "read-only": "읽기 전용 고정",
      "adaptive": "GPT 자율 판단",
      "always-full": "전체 접근 고정"
    };
    const accessHints = {
      "read-only": "모든 새 작업을 읽기 전용으로 강제합니다.",
      "adaptive": "기본은 읽기 전용이며, 사용자 작업 요청에 따라 GPT가 허용된 쓰기 권한을 선택합니다.",
      "always-full": "모든 새 작업을 danger-full-access로 강제합니다."
    };

    function request(method, params) {
      const id = nextRequestId++;
      window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
      return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
          pendingRequests.delete(id);
          reject(new Error("ChatGPT 도구 호출 응답 시간이 초과되었습니다."));
        }, SETTINGS_REQUEST_TIMEOUT_MS);
        pendingRequests.set(id, {
          resolve: (value) => { window.clearTimeout(timer); resolve(value); },
          reject: (error) => { window.clearTimeout(timer); reject(error); }
        });
      });
    }

    async function callTool(name, args) {
      if (window.parent && window.parent !== window) {
        return request("tools/call", { name, arguments: args });
      }
      if (window.openai && typeof window.openai.callTool === "function") {
        return window.openai.callTool(name, args);
      }
      throw new Error("이 호스트는 설정 저장 도구 호출을 지원하지 않습니다.");
    }

    function setBusy(busy, message) {
      elements.save.disabled = busy;
      elements.refresh.disabled = busy;
      elements.reset.disabled = busy;
      elements.status.classList.remove("error");
      elements.status.textContent = message || "";
    }

    function setError(error) {
      elements.status.classList.add("error");
      elements.status.textContent = error && error.message ? error.message : String(error);
    }

    function option(value, label) {
      const entry = document.createElement("option");
      entry.value = value;
      entry.textContent = label;
      return entry;
    }

    function renderEfforts(preferredEffort = "") {
      const selectedModel = elements.model.value;
      const descriptor = (view.catalog.models || []).find((entry) => entry.id === selectedModel);
      const current = preferredEffort || "";
      elements.effort.replaceChildren(option("", "모델 기본값"));
      if (descriptor) {
        for (const entry of descriptor.supportedReasoningEfforts || []) {
          elements.effort.appendChild(option(entry.effort, entry.effort));
        }
      }
      if (current && !Array.from(elements.effort.options).some((entry) => entry.value === current)) {
        elements.effort.appendChild(option(current, current + " (현재 저장됨)"));
      }
      elements.effort.value = current;
      elements.effort.disabled = !selectedModel;
    }

    function render(nextView) {
      if (!nextView || !nextView.settings || !nextView.capabilities || !nextView.catalog) return;
      view = nextView;
      const settings = view.settings;
      const limits = view.capabilities;

      elements.access.replaceChildren();
      for (const value of limits.availableAccessStrategies || []) {
        elements.access.appendChild(option(value, accessLabels[value] || value));
      }
      elements.access.value = settings.accessStrategy;

      elements.model.replaceChildren(option("", "Codex 기본 모델"));
      for (const model of view.catalog.models || []) {
        elements.model.appendChild(option(model.id, model.displayName || model.id));
      }
      if (settings.defaultModel && !Array.from(elements.model.options).some((entry) => entry.value === settings.defaultModel)) {
        elements.model.appendChild(option(settings.defaultModel, settings.defaultModel + " (현재 저장됨)"));
      }
      elements.model.value = settings.defaultModel || "";
      renderEfforts(settings.defaultReasoningEffort || "");

      elements.cwd.value = settings.defaultCwd || "";
      elements.roots.replaceChildren();
      for (const root of limits.allowedRoots || []) elements.roots.appendChild(option(root, root));
      elements.cwdHint.textContent = "운영자가 허용한 경로 내부만 저장할 수 있습니다: " + (limits.allowedRoots || []).join(", ");
      elements.session.value = settings.defaultSessionMode;
      elements.resume.value = String(settings.autoResumeTtlMs / 3600000);
      elements.resume.min = String(limits.minAutoResumeTtlMs / 3600000);
      elements.resume.max = String(limits.maxAutoResumeTtlMs / 3600000);
      elements.timeout.value = String(settings.taskTimeoutMs / 60000);
      elements.timeout.min = String(limits.minTaskTimeoutMs / 60000);
      elements.timeout.max = String(limits.maxTaskTimeoutMs / 60000);
      elements.concurrency.value = String(settings.maxConcurrentJobs);
      elements.concurrency.max = String(limits.maxConcurrentJobs);
      elements.revision.textContent = "revision " + settings.revision;
      elements.scope.textContent = view.scopeNotice;
      updateAccessNotice();

      const warning = view.catalog.warning || "";
      elements.catalogWarning.textContent = warning;
      elements.catalogWarning.classList.toggle("show", Boolean(warning));
    }

    function updateAccessNotice() {
      const value = elements.access.value;
      elements.accessHint.textContent = accessHints[value] || "";
      elements.fullWarning.classList.toggle("show", value === "always-full");
    }

    function unwrap(result) {
      if (result && result.isError) {
        const errorEntry = Array.isArray(result.content)
          ? result.content.find((entry) => entry && entry.type === "text" && typeof entry.text === "string")
          : null;
        throw new Error(errorEntry && errorEntry.text ? errorEntry.text : "설정 도구 호출에 실패했습니다.");
      }
      const nextView = result && result.structuredContent ? result.structuredContent : result;
      if (!nextView || !nextView.settings || !nextView.capabilities || !nextView.catalog) {
        throw new Error("설정 도구가 올바른 응답을 반환하지 않았습니다.");
      }
      return nextView;
    }

    function scaledInteger(input, multiplier, label) {
      const value = Number(input.value);
      const result = Math.round(value * multiplier);
      if (!Number.isFinite(value) || !Number.isSafeInteger(result)) {
        throw new Error(label + " 값이 올바르지 않습니다.");
      }
      return result;
    }

    function integerValue(input, label) {
      const value = Number(input.value);
      if (!Number.isSafeInteger(value)) {
        throw new Error(label + " 값은 정수여야 합니다.");
      }
      return value;
    }

    window.addEventListener("message", (event) => {
      if (event.source !== window.parent) return;
      const message = event.data;
      if (!message || message.jsonrpc !== "2.0") return;
      if (message.id !== undefined && pendingRequests.has(message.id)) {
        const pending = pendingRequests.get(message.id);
        pendingRequests.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || "도구 호출 실패"));
        else pending.resolve(message.result);
        return;
      }
      if (message.method === "ui/notifications/tool-result") {
        render(message.params && message.params.structuredContent);
      }
    }, { passive: true });

    window.addEventListener("openai:set_globals", (event) => {
      const globals = event.detail && event.detail.globals;
      if (globals && globals.toolOutput) render(globals.toolOutput);
    });

    elements.access.addEventListener("change", updateAccessNotice);
    elements.model.addEventListener("change", () => {
      const savedModel = view && view.settings ? view.settings.defaultModel || "" : "";
      const preferredEffort =
        elements.model.value && elements.model.value === savedModel
          ? view.settings.defaultReasoningEffort || ""
          : "";
      renderEfforts(preferredEffort);
    });

    elements.form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!view || !elements.form.reportValidity()) return;
      setBusy(true, "저장 중…");
      try {
        const autoResumeTtlMs = scaledInteger(elements.resume, 3600000, "자동 연결 유효시간");
        const taskTimeoutMs = scaledInteger(elements.timeout, 60000, "작업 타임아웃");
        const maxConcurrentJobs = integerValue(elements.concurrency, "최대 동시 작업 수");
        const result = await callTool("codex_update_settings", {
          expectedRevision: view.settings.revision,
          accessStrategy: elements.access.value,
          defaultModel: elements.model.value || null,
          defaultReasoningEffort: elements.effort.value || null,
          defaultCwd: elements.cwd.value.trim() || null,
          defaultSessionMode: elements.session.value,
          autoResumeTtlMs,
          taskTimeoutMs,
          maxConcurrentJobs
        });
        render(unwrap(result));
        setBusy(false, "저장했습니다.");
      } catch (error) {
        setBusy(false);
        setError(error);
      }
    });

    elements.refresh.addEventListener("click", async () => {
      setBusy(true, "새로고침 중…");
      try {
        const result = await callTool("codex_settings", { refreshModels: true });
        render(unwrap(result));
        setBusy(false, "최신 설정과 모델 목록을 불러왔습니다.");
      } catch (error) {
        setBusy(false);
        setError(error);
      }
    });

    elements.reset.addEventListener("click", async () => {
      if (!view || !window.confirm("사용자 설정을 운영자 기본값으로 복원할까요?")) return;
      setBusy(true, "복원 중…");
      try {
        const result = await callTool("codex_update_settings", {
          expectedRevision: view.settings.revision,
          reset: true
        });
        render(unwrap(result));
        setBusy(false, "운영자 기본값으로 복원했습니다.");
      } catch (error) {
        setBusy(false);
        setError(error);
      }
    });

    if (window.openai && window.openai.toolOutput) render(window.openai.toolOutput);
  </script>
</body>
</html>`;
