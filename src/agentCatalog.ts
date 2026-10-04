import catalog from "./agent-catalog.json";

export interface HarnessInfo {
  id: string;
  name: string;
  tier: number;
  icon: string;
  paths: string[];
  pathsWindows?: string[];
  projectPaths: string[];
  loading: string;
  docs: string;
  status: string;
  flatSync: boolean;
}

export const harnessCatalog: HarnessInfo[] = catalog;
export const harnessById = new Map(harnessCatalog.map((entry) => [entry.id, entry]));
export const harnessGroups = [
  { tier: 1, label: "主流默认" },
  { tier: 2, label: "开源与终端 Agent" },
  { tier: 3, label: "其他与国内产品" },
  { tier: 0, label: "自定义 Agent" },
];

// Statically bundled assets: no runtime requests to an icon CDN.
const assets = import.meta.glob<string>("./assets/*.{svg,png}", {
  eager: true, query: "?url", import: "default",
});
const iconFiles: Record<string, string> = {
  claude: "claude-color.svg", codex: "codex-color.svg", kiro: "kiro-color.png",
  antigravity: "antigravity-color.svg", kilo: "kilocode.svg", roo: "roocode.svg",
  goose: "goose.svg", openclaw: "openclaw-color.svg", trae: "trae-color.svg",
  cline: "cline.svg", kimi: "kimi.svg", codebuddy: "codebuddy-color.svg",
  junie: "junie-color.svg", openhands: "openhands-color.svg", qoder: "qoder-color.svg",
  zencoder: "zencoder-color.svg", hermes: "hermesagent.svg", cursor: "cursor.svg",
  githubcopilot: "githubcopilot.svg", devin: "devin-color.svg", opencode: "opencode.svg",
  deepseek: "deepseek-color.svg", geminicli: "geminicli-color.svg", pi: "pi.svg",
  aider: "aider.svg", warp: "warp.svg", qwen: "qwen-color.svg", grok: "grok.svg",
  zcode: "zcode.png", workbuddy: "workbuddy.svg",
};
export const agentIconMap = Object.fromEntries(
  Object.entries(iconFiles).map(([icon, file]) => [icon, assets[`./assets/${file}`]]),
);
