import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// bash-timeout: LLM이 bash 도구를 timeout 없이 호출하면 기본 타임아웃을 주입한다.
//
// pi 코어의 bash 도구는 per-call `timeout` 파라미터와 프로세스 그룹 kill
// (killProcessTree)을 이미 갖추고 있지만 기본값이 없다(bash.js: "no default
// timeout"). 그래서 모델이 timeout을 생략한 채 무한 루프 프로그램을 실행하면
// 턴이 영원히 끝나지 않고 세션 전체가 "Working"으로 굳는다(mario의
// tests.js 무한 while 루프로 실제 발생). tool_call 이벤트의 event.input은
// 실행 전에 mutable하므로(types.d.ts) 여기서 timeout만 채워 넣으면 나머지
// 강제 종료는 코어가 처리한다.
//
// 타임아웃에 걸리면 모델은 "Command timed out after N seconds" 에러를 보고
// 스스로 원인을 조사하거나, 정말 오래 걸리는 작업이면 명시적으로 더 큰
// timeout을 지정해 재시도할 수 있다. 명시된 timeout은 건드리지 않는다.
const DEFAULT_TIMEOUT_SECONDS = 300;

const CONFIG_PATH = path.join(
  process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"),
  "settings.json",
);

type SettingsFile = {
  bashTimeout?: { defaultSeconds?: number };
  [key: string]: unknown;
};

function isValidSeconds(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

/** settings.json의 bashTimeout.defaultSeconds를 읽는다. 0은 "주입 안 함"이다. */
function loadDefaultSeconds(): number {
  try {
    const settings = JSON.parse(
      fs.readFileSync(CONFIG_PATH, "utf8"),
    ) as SettingsFile;
    const value = settings.bashTimeout?.defaultSeconds;
    return isValidSeconds(value) ? value : DEFAULT_TIMEOUT_SECONDS;
  } catch {
    return DEFAULT_TIMEOUT_SECONDS;
  }
}

/** 다른 설정 키는 보존하고 bashTimeout 영역만 갱신한다(loop-agent와 동일 패턴). */
function saveDefaultSeconds(seconds: number): void {
  const settings = JSON.parse(
    fs.readFileSync(CONFIG_PATH, "utf8"),
  ) as SettingsFile;
  settings.bashTimeout = { defaultSeconds: seconds };
  fs.writeFileSync(
    CONFIG_PATH,
    `${JSON.stringify(settings, null, 2)}\n`,
    "utf8",
  );
}

/** 환경 변수 > settings.json > 코드 기본값. 환경 변수는 자식 pi 튜닝·테스트용이다. */
function resolveDefaultSeconds(): number {
  const fromEnv = Number(process.env.PI_BASH_DEFAULT_TIMEOUT);
  if (Number.isInteger(fromEnv) && fromEnv >= 0) return fromEnv;
  return loadDefaultSeconds();
}

export default function bashTimeoutExtension(pi: ExtensionAPI) {
  let defaultSeconds = resolveDefaultSeconds();

  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;
    if (defaultSeconds <= 0) return;

    const input = event.input as { command?: string; timeout?: number };
    // 모델이 명시한 유효한 timeout은 존중한다. 0 이하는 코어가 무시해
    // 무제한이 되므로(bash.js의 `timeout > 0` 가드) 누락과 동일하게 취급한다.
    if (typeof input.timeout === "number" && input.timeout > 0) return;
    input.timeout = defaultSeconds;
  });

  pi.registerCommand("bash-timeout", {
    description:
      "Default timeout for LLM bash calls. Usage: /bash-timeout status|set <seconds>|off",
    handler: async (args, ctx) => {
      const normalized = (
        Array.isArray(args) ? args.join(" ") : String(args ?? "")
      ).trim();
      const [rawCommand = "", value = ""] = normalized.split(/\s+/);
      const command = rawCommand.toLowerCase();

      const status = () =>
        defaultSeconds > 0
          ? `bash-timeout: LLM bash 호출에 기본 ${defaultSeconds}초 타임아웃을 주입합니다 (명시된 timeout은 유지).`
          : "bash-timeout: 비활성화됨 (timeout 없는 bash 호출은 무제한 실행).";

      switch (command) {
        case "":
        case "status":
          ctx.ui.notify(status(), "info");
          return;
        case "set": {
          const seconds = Number(value);
          if (!Number.isInteger(seconds) || seconds <= 0) {
            ctx.ui.notify(
              "bash-timeout: set <seconds>는 1 이상의 정수여야 합니다.",
              "error",
            );
            return;
          }
          defaultSeconds = seconds;
          saveDefaultSeconds(seconds);
          ctx.ui.notify(status(), "info");
          return;
        }
        case "off":
          defaultSeconds = 0;
          saveDefaultSeconds(0);
          ctx.ui.notify(status(), "info");
          return;
        default:
          ctx.ui.notify(
            `Unknown bash-timeout command: ${command}\n\nUsage: /bash-timeout status|set <seconds>|off\n\n${status()}`,
            "warning",
          );
      }
    },
  });
}
