// Static analysis: the mechanical deprecated-API findings + non-mechanical migration
// signals. TypeScript port of src/utils/static_analyzer.py — same regexes and category
// routing, producing the analysis.json plan the in-container agent reads.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface Finding {
  api: string;
  replacement: string;
  file: string;
  line: number;
  snippet: string;
}
export interface Signal {
  category: string;
  skill: string;
  file: string;
  line: number;
  snippet: string;
}
export interface ScanResult {
  findings: Finding[];
  signals: Signal[];
}

export const CATEGORIES: Record<
  string,
  { order: number; skill: string; title: string; hint: string }
> = {
  blocking_webrequest: {
    order: 0,
    skill: "mv3-non-trivial",
    title: "Blocking webRequest -> declarativeNetRequest (DNR)",
    hint:
      'MV3 removes blocking webRequest. Re-express these block/redirect/modify rules ' +
      "declaratively in a rules.json and drop the \"webRequestBlocking\" permission. The " +
      "manifest's \"declarative_net_request\": {\"rule_resources\": [...]} entry requires ALL " +
      "THREE keys per ruleset — id, enabled, AND path — e.g. " +
      '{"id": "ruleset_1", "enabled": true, "path": "rules.json"}; omitting any one fails ' +
      "extension load.\n" +
      "rules.json is an ARRAY of rules. A REDIRECT rule must put the target inside " +
      "action.redirect.url (there is no \"detail\" or \"redirectUrl\" field). Exact shape:\n" +
      '[{"id": 1, "priority": 1, "action": {"type": "redirect", "redirect": ' +
      '{"url": "https://example.com/x"}}, "condition": {"regexFilter": ' +
      '"^https?://.*\\\\.lmu\\\\.de/.*\\\\.(jpg|png|gif)$", "resourceTypes": ["image"]}}]\n' +
      'A BLOCK rule uses action {"type": "block"}. id must be an integer.',
  },
  background_dom: {
    order: 1,
    skill: "mv3-non-trivial",
    title: "Background-context DOM / Web API -> offscreen document",
    hint:
      "The service worker has no DOM/window/localStorage/audio. Move this work to an " +
      "offscreen document (or chrome.storage / fetch where possible) per the mv3-non-trivial skill.",
  },
  remote_code: {
    order: 2,
    skill: "mv3-non-trivial",
    title: "Remotely-hosted or eval'd code (forbidden in MV3)",
    hint:
      "MV3 forbids remote code and most eval. Bundle the code locally; use a sandbox page " +
      "only where runtime evaluation is genuinely required.",
  },
  background_page_access: {
    order: 3,
    skill: "mv3-semi-trivial",
    title: "getBackgroundPage removed",
    hint:
      "chrome.{runtime,extension}.getBackgroundPage is gone in MV3. Communicate via " +
      "chrome.runtime messaging or chrome.storage instead.",
  },
};

const BACKGROUND_DOM =
  /\b(document\.|window\.|localStorage\b|sessionStorage\b|XMLHttpRequest\b|new\s+Audio\b|AudioContext\b|webkitAudioContext\b|DOMParser\b|navigator\.clipboard\b|navigator\.geolocation\b|alert\s*\(|confirm\s*\(|prompt\s*\()/;
const REMOTE_EVAL = /\b(eval\s*\(|new\s+Function\s*\(|importScripts\s*\(\s*['"]https?:)/;
const REMOTE_SCRIPT_SRC = /<script[^>]*\bsrc\s*=\s*['"](?:https?:)?\/\//i;
const GET_BACKGROUND_PAGE = /chrome\.(?:runtime|extension)\.getBackgroundPage\b/;
const WEBREQUEST_LISTENER = /chrome\.webRequest\.\w+\.addListener/;
const BLOCKING_RESPONSE =
  /['"]blocking['"]|\b(?:cancel|redirectUrl|requestHeaders|responseHeaders)\s*:/;

const SCANNABLE = [".js", ".ts", ".mjs", ".html", ".htm"];

function extractApi(body: string): string | null {
  const m = body.match(/(chrome(?:\.[a-zA-Z_][a-zA-Z0-9_]*)+)/);
  return m ? m[1] : null;
}

export class StaticAnalyzer {
  private apiMap = new Map<string, string>();
  private apiRe: RegExp;

  constructor(mappings: { mappings: Array<{ source: { body: string }; target: { body: string } }> }) {
    for (const m of mappings.mappings) {
      const s = extractApi(m.source.body);
      const t = extractApi(m.target.body);
      if (s && t && !this.apiMap.has(s)) this.apiMap.set(s, t);
    }
    // Longest-first alternation so chrome.browserAction.setTitle beats chrome.browserAction.
    const apis = [...this.apiMap.keys()].sort((a, b) => b.length - a.length);
    const esc = apis.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    this.apiRe = apis.length ? new RegExp(esc.join("|"), "g") : /(?!)/g;
  }

  scan(extPath: string): ScanResult {
    const result: ScanResult = { findings: [], signals: [] };
    let manifest: any = {};
    try {
      manifest = JSON.parse(readFileSync(join(extPath, "manifest.json"), "utf8"));
    } catch {}

    const bgFiles = this.backgroundFiles(manifest);

    if (Array.isArray(manifest.permissions) && manifest.permissions.includes("webRequestBlocking")) {
      this.addSignal(result, "blocking_webrequest", "manifest.json", 0, '"permissions": [..., "webRequestBlocking"]');
    }

    for (const filepath of walk(extPath)) {
      const filename = filepath.split(sep).pop()!;
      if (!SCANNABLE.some((e) => filename.endsWith(e))) continue;
      const rel = relative(extPath, filepath).split(sep).join("/");
      const text = readFileSync(filepath, "utf8");
      const lines = text.split(/\r?\n/);
      const isHtml = /\.html?$/.test(filename);
      const isBackground = bgFiles.has(rel);
      const fileHasWebrequest = lines.some((l) => l.includes("chrome.webRequest"));

      lines.forEach((line, i) => {
        const lineno = i + 1;
        this.scanApi(result, rel, lineno, line);
        this.scanSignals(result, rel, lineno, line, isHtml, isBackground, fileHasWebrequest);
      });
    }
    return result;
  }

  private backgroundFiles(manifest: any): Set<string> {
    const bg = manifest.background ?? {};
    const files = new Set<string>();
    if (bg && typeof bg === "object") {
      if (typeof bg.service_worker === "string") files.add(bg.service_worker);
      if (Array.isArray(bg.scripts)) for (const s of bg.scripts) if (typeof s === "string") files.add(s);
    }
    return new Set([...files].map((f) => f.replace(/^\/+/, "").replace(/\\/g, "/")));
  }

  private scanApi(result: ScanResult, rel: string, lineno: number, line: string): void {
    const seen = new Set<string>();
    this.apiRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = this.apiRe.exec(line))) {
      const api = m[0];
      if (!seen.has(api)) {
        seen.add(api);
        result.findings.push({ api, replacement: this.apiMap.get(api)!, file: rel, line: lineno, snippet: line.trim() });
      }
    }
  }

  private scanSignals(
    result: ScanResult, rel: string, lineno: number, line: string,
    isHtml: boolean, isBackground: boolean, fileHasWebrequest: boolean,
  ): void {
    if (isHtml) {
      if (REMOTE_SCRIPT_SRC.test(line)) this.addSignal(result, "remote_code", rel, lineno, line);
      return;
    }
    if (WEBREQUEST_LISTENER.test(line) || (fileHasWebrequest && BLOCKING_RESPONSE.test(line)))
      this.addSignal(result, "blocking_webrequest", rel, lineno, line);
    if (REMOTE_EVAL.test(line)) this.addSignal(result, "remote_code", rel, lineno, line);
    if (GET_BACKGROUND_PAGE.test(line)) this.addSignal(result, "background_page_access", rel, lineno, line);
    if (isBackground && BACKGROUND_DOM.test(line)) this.addSignal(result, "background_dom", rel, lineno, line);
  }

  private addSignal(result: ScanResult, category: string, file: string, line: number, raw: string): void {
    result.signals.push({ category, skill: CATEGORIES[category].skill, file, line, snippet: raw.trim() });
  }
}

export function buildAnalysis(findings: Finding[], extPath: string): any {
  let name: string | null = null;
  try {
    name = JSON.parse(readFileSync(join(extPath, "manifest.json"), "utf8")).name ?? null;
  } catch {}
  const byFile = new Map<string, any[]>();
  for (const f of findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file)!.push({ type: "api_replacement", line: f.line, api: f.api, replacement: f.replacement, snippet: f.snippet });
  }
  const files = [...byFile.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, changes]) => ({ path, changes: changes.sort((a, b) => a.line - b.line) }));
  return {
    extension_name: name,
    source: "static-analysis",
    files,
    note:
      "Static analysis lists known deprecated API call sites and their MV3 replacements. " +
      "Manifest changes and anything not listed here must still be applied using the migration reference.",
  };
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}
