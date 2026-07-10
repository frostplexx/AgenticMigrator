#!/usr/bin/env npx tsx
/**
 * Render a session JSONL (transcript) in the terminal.
 *
 * Usage:
 *   npx tsx scripts/view-transcript.ts run/transcript.jsonl
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── ANSI helpers ─────────────────────────────────────────────
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const RESET = "\x1b[0m";

const fg = (n: number) => `\x1b[38;5;${n}m`;
const bg = (n: number) => `\x1b[48;5;${n}m`;

const BLUE = fg(33);
const GREEN = fg(76);
const YELLOW = fg(220);
const GRAY = fg(245);
const DARK_GRAY = fg(240);
const WHITE = fg(255);
const RED = fg(196);
const CYAN = fg(45);

const BG_DARK = bg(234);
const BG_YELLOW = bg(94);
const BG_BLUE = bg(24);
const BG_GREEN = bg(22);

// ── Parse ────────────────────────────────────────────────────
const filePath = resolve(process.argv[2] ?? "run/transcript.jsonl");
const raw = readFileSync(filePath, "utf8");
const lines = raw.split("\n").filter(Boolean);
const entries: any[] = lines.map((l, i) => {
  try {
    return JSON.parse(l);
  } catch {
    return null;
  }
}).filter(Boolean);

// ── Collect rendered blocks ──────────────────────────────────
const out: string[] = [];

function push(label: string, labelColor: string, labelBg: string, lines: string[], opts?: { mono?: boolean; dim?: boolean }) {
  const tag = `${labelBg}${labelColor}${BOLD} ${label} ${RESET}`;
  const style = opts?.dim ? DIM : "";
  const nl = opts?.mono ? `${DARK_GRAY}│${RESET} ` : "";
  const body = lines
    .map((l) => {
      const line = l || " ";
      return opts?.mono ? `${nl}${line}` : `  ${line}`;
    })
    .join("\n");
  out.push(`\n${tag}\n${style}${body}${RESET}`);
}

for (const entry of entries) {
  if (entry.type === "session") continue;

  if (entry.type === "message" && entry.message) {
    const m = entry.message;
    const role = m.role ?? "unknown";

    if (role === "user") {
      const parts: string[] = [];
      const raw = Array.isArray(m.content) ? m.content : [m.content];
      for (const c of raw) {
        if (c?.type === "text" && typeof c.text === "string") parts.push(c.text);
        else if (typeof c === "string") parts.push(c);
        else parts.push(JSON.stringify(c, null, 2));
      }
      push("YOU", WHITE, BG_BLUE, parts.join("\n").split("\n"));
    }

    else if (role === "assistant") {
      const text = typeof m.content === "string" ? m.content : "";
      const toolCalls = m.tool_calls?.filter((tc: any) => tc.type === "toolCall" || tc.type === "function") ?? [];

      if (text) push("ASSISTANT", WHITE, BG_GREEN, text.split("\n"));
      else push("ASSISTANT", WHITE, BG_GREEN, ["(thinking or empty response)"]);

      for (const tc of toolCalls) {
        const name = tc.function?.name ?? tc.name ?? "?";
        const args = tc.function?.arguments ?? tc.arguments ?? "{}";
        const pretty = typeof args === "string" ? args : JSON.stringify(args, null, 2);
        const prefix = `${DARK_GRAY}│ ${CYAN}${BOLD}${name}${RESET}${DARK_GRAY}(`;
        const suffix = `${DARK_GRAY})${RESET}`;
        const lines = pretty.split("\n");
        // First line appended after prefix
        out.push(`\n  ${prefix}${lines[0]}${lines.length > 1 ? "," : ""}${suffix}`);
        for (let i = 1; i < lines.length; i++) {
          const sep = i < lines.length - 1 ? "," : "";
          out.push(`  ${DARK_GRAY}│ ${RESET}${lines[i]}${sep}`);
        }
      }
    }

    else if (role === "tool" || role === "toolResult") {
      // Extract text content from the result's content array
      const contents: string[] = [];
      const rawContent = Array.isArray(m.content) ? m.content : [m.content];
      for (const c of rawContent) {
        if (c?.type === "text" && typeof c.text === "string") contents.push(c.text);
        else contents.push(JSON.stringify(c, null, 2));
      }
      const text = contents.join("\n");
      const lines = text.split("\n");
      const preview = lines.length <= 8 ? lines : [...lines.slice(0, 7), `${DIM}… ${lines.length - 7} more lines${RESET}`];
      const toolName = m.toolName ?? "tool";
      push(toolName.toUpperCase(), GRAY, bg(236), preview, { dim: true, mono: true });
    }

    else if (role === "bashExecution" || m.role === "bashExecution") {
      const be = role === "bashExecution" ? m : m;
      const cmd = be.command ?? "";
      const output = (be.output ?? "").slice(0, 3000);
      const exitCode = be.exitCode;
      const lines = [`$ ${cmd}${exitCode != null ? `  ${DARK_GRAY}(exit ${exitCode})${RESET}` : ""}`, ...output.split("\n")];
      push("BASH", WHITE, bg(52), lines, { mono: true });
    }

    else if (role === "custom" || m.role === "custom") {
      const cm = role === "custom" ? m : m;
      const text = typeof cm.content === "string" ? cm.content : JSON.stringify(cm.content, null, 2);
      const preview = text.split("\n").slice(0, 10);
      push("CUSTOM", YELLOW, BG_YELLOW, preview, { dim: true, mono: true });
    }

    else {
      const text = JSON.stringify(m, null, 2);
      push(role.toUpperCase(), GRAY, bg(236), text.split("\n"), { dim: true });
    }
  }

  if (entry.type === "compaction") {
    push("COMPACT", YELLOW, BG_YELLOW, [
      `Context compacted — kept from entry ${entry.firstKeptEntryId}`,
      ...entry.summary.slice(0, 500).split("\n"),
    ], { dim: true });
  }

  if (entry.type === "branch_summary") {
    push("BRANCH", YELLOW, BG_YELLOW, [
      `Branch merged from ${entry.fromId}`,
      ...entry.summary.slice(0, 500).split("\n"),
    ], { dim: true });
  }

  if (entry.type === "model_change") {
    push("MODEL", CYAN, bg(236), [`${entry.provider}/${entry.modelId}`], { dim: true });
  }

  if (entry.type === "thinking_level_change") {
    push("THINK", CYAN, bg(236), [`level: ${entry.thinkingLevel}`], { dim: true });
  }
}

// ── Print ────────────────────────────────────────────────────
const header = `${BOLD}${WHITE}${bg(237)} Transcript: ${filePath} ${RESET}  ${DIM}${entries.length} entries${RESET}`;
console.log(`\n${header}\n${"─".repeat(Math.min(process.stdout.columns ?? 60, 60))}`);
console.log(out.join("\n"));
console.log();
