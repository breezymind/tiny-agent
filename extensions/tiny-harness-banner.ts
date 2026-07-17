import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

const TINY_AGENT_BANNER = String.raw`
█████ ███ █   █ █   █     ███   ███  █████ █   █ █████
  █    █  ██  █  █ █     █   █ █     █     ██  █   █
  █    █  █ █ █   █      █████ █  ██ ████  █ █ █   █
  █    █  █  ██   █      █   █ █   █ █     █  ██   █
  █   ███ █   █   █      █   █  ███  █████ █   █   █
`.trim().split("\n");

export default function tinyAgentBanner(pi: ExtensionAPI): void {
  pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setHeader((_tui: TUI, theme: Theme): Component => ({
      render: () => TINY_AGENT_BANNER.map((line) => theme.bold(theme.fg("accent", line))),
      invalidate: () => {},
    }));
  });
}
