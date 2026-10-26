// 無操作・無生成が続いたら /__idle（Cloudflare Worker の切断画面）へ移動し、RunPod への通信を止める
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const SETTING_ENABLED = "IdleDisconnect.Enabled";
const SETTING_TIMEOUT = "IdleDisconnect.TimeoutMinutes";
const SETTING_WARN = "IdleDisconnect.WarnMinutes";
const DEFAULTS = { [SETTING_ENABLED]: true, [SETTING_TIMEOUT]: 5, [SETTING_WARN]: 3 };

const CHECK_INTERVAL_MS = 1000;
const POINTERMOVE_THROTTLE_MS = 1000;
const IDLE_PATH = "/__idle";

// 設定値は判定のたびに読み直す（変更を即座に反映するため）
function getSetting(id) {
  try {
    const v = app.extensionManager?.setting?.get(id);
    return v === undefined || v === null ? DEFAULTS[id] : v;
  } catch {
    return DEFAULTS[id];
  }
}

const pageLoadedAt = Date.now();
let lastActivity = 0;
let lastGenerationEnd = 0;
let queueRemaining = 0;
let isRunning = false;
let disconnecting = false;
let warningEl = null;

// 他の拡張が window.__torilabBusy に立てたフラグ（例：URL ダウンローダーのダウンロード中）
function isOtherExtensionBusy() {
  try {
    const flags = window.__torilabBusy;
    return !!flags && Object.values(flags).some((v) => v === true);
  } catch {
    return false;
  }
}

function isQueueBusy() {
  return queueRemaining > 0 || isRunning || isOtherExtensionBusy();
}

function markActivity() {
  lastActivity = Date.now();
}

function markGenerationEnd() {
  lastGenerationEnd = Date.now();
}

// 警告表示：初回に 1 つだけ作り、以後は表示・非表示を切り替える。ComfyUI の操作を妨げないようクリックは透過させる
function showWarning(remainingMs) {
  if (!warningEl) {
    warningEl = document.createElement("div");
    Object.assign(warningEl.style, {
      position: "fixed",
      right: "16px",
      bottom: "16px",
      zIndex: "10000",
      maxWidth: "min(420px, calc(100vw - 32px))",
      padding: "10px 14px",
      borderRadius: "6px",
      background: "rgba(40, 40, 40, 0.92)",
      color: "#fff",
      border: "1px solid #c9a227",
      font: "13px/1.5 system-ui, sans-serif",
      boxShadow: "0 2px 8px rgba(0, 0, 0, 0.4)",
      pointerEvents: "none",
    });
    warningEl.setAttribute("role", "status");
    document.body.appendChild(warningEl);
  }
  const totalSec = Math.max(0, Math.ceil(remainingMs / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = String(totalSec % 60).padStart(2, "0");
  warningEl.textContent = `操作がないため、あと ${min}分${sec}秒 で切断します（GPU の課金を止めるため）`;
  warningEl.style.display = "block";
}

function hideWarning() {
  if (warningEl) warningEl.style.display = "none";
}

function check() {
  try {
    if (disconnecting) return;
    if (!getSetting(SETTING_ENABLED)) {
      hideWarning();
      return;
    }
    // キューに処理が残っている間は切断も警告もしない。空になった時点から計測し直す
    if (isQueueBusy()) {
      hideWarning();
      markGenerationEnd();
      return;
    }

    const timeoutMs = Number(getSetting(SETTING_TIMEOUT)) * 60_000;
    // 警告開始時間が切断までの時間以上なら、切断までの時間と同じとして扱う（0 なら表示しない）
    const warnMs = Math.min(Number(getSetting(SETTING_WARN)) * 60_000, timeoutMs);
    if (!(timeoutMs > 0)) return;

    // 経過時間は Date.now() の差で計算する（非表示タブでタイマーが間引かれても正しく判定するため）
    const base = Math.max(lastActivity, lastGenerationEnd, pageLoadedAt);
    const remaining = base + timeoutMs - Date.now();

    if (remaining <= 0) {
      disconnecting = true;
      // replace を使い、「戻る」で ComfyUI に戻って通信が再開されるのを防ぐ
      location.replace(IDLE_PATH);
      return;
    }
    if (warnMs > 0 && remaining <= warnMs) showWarning(remaining);
    else hideWarning();
  } catch (err) {
    console.warn("[IdleDisconnect] check failed", err);
  }
}

app.registerExtension({
  name: "torilab.IdleDisconnect",
  settings: [
    {
      id: SETTING_ENABLED,
      category: ["IdleDisconnect", "自動切断", "有効"],
      name: "無操作時に自動切断する",
      type: "boolean",
      defaultValue: DEFAULTS[SETTING_ENABLED],
    },
    {
      id: SETTING_TIMEOUT,
      category: ["IdleDisconnect", "自動切断", "切断までの時間"],
      name: "切断までの時間（分）",
      type: "number",
      attrs: { min: 1, max: 120, step: 1 },
      defaultValue: DEFAULTS[SETTING_TIMEOUT],
    },
    {
      id: SETTING_WARN,
      category: ["IdleDisconnect", "自動切断", "警告表示"],
      name: "警告表示を始める残り時間（分）",
      tooltip: "0 なら警告を表示しない",
      type: "number",
      attrs: { min: 0, max: 60, step: 1 },
      defaultValue: DEFAULTS[SETTING_WARN],
    },
  ],
  setup() {
    try {
      const opts = { capture: true, passive: true };
      for (const type of ["pointerdown", "keydown", "wheel", "touchstart"]) {
        window.addEventListener(type, markActivity, opts);
      }
      // pointermove は頻度が高いので 1 秒に 1 回までに間引く
      let lastMove = 0;
      window.addEventListener(
        "pointermove",
        () => {
          const now = Date.now();
          if (now - lastMove < POINTERMOVE_THROTTLE_MS) return;
          lastMove = now;
          markActivity();
        },
        opts
      );

      api.addEventListener("execution_start", () => {
        isRunning = true;
      });
      for (const type of ["execution_success", "execution_error", "execution_interrupted"]) {
        api.addEventListener(type, () => {
          isRunning = false;
          markGenerationEnd();
        });
      }
      api.addEventListener("status", (e) => {
        const remaining = e?.detail?.exec_info?.queue_remaining;
        if (typeof remaining !== "number") return;
        if (queueRemaining > 0 && remaining === 0) markGenerationEnd();
        queueRemaining = remaining;
      });

      setInterval(check, CHECK_INTERVAL_MS);
    } catch (err) {
      console.warn("[IdleDisconnect] setup failed", err);
    }
  },
});
