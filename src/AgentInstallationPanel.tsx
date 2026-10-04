import { useState } from "react";
import { Search, RefreshCcw, Check } from "lucide-react";
import { api } from "./api";
import { agentIconMap, harnessById } from "./agentCatalog";
import type { AgentInstallation, EnableInstalledAgentsResult, Settings } from "./types";

const evidenceLabels = { command: "命令", application: "应用", extension: "插件", config: "配置目录" };

export function AgentInstallationPanel({ settings, onEnable }: {
  settings: Settings;
  onEnable: (ids: string[]) => Promise<EnableInstalledAgentsResult>;
}) {
  const [report, setReport] = useState<AgentInstallation[] | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const isEnabled = (id: string) => settings.customAgents.some((agent) => agent.id === id && agent.enabled);
  const installed = report?.filter((agent) => agent.status === "installed") ?? [];
  const configured = report?.filter((agent) => agent.status === "configured") ?? [];
  const eligibleIds = installed.filter((agent) => agent.canEnable && !isEnabled(agent.agentId)).map((agent) => agent.agentId);
  const selected = selectedIds.filter((id) => eligibleIds.includes(id));
  const busy = checking || enabling;

  async function detect() {
    setChecking(true); setError(null); setNotice(null);
    setReport(null); setSelectedIds([]);
    try {
      const result = await api.detectInstalledAgents();
      setReport(result);
      setSelectedIds(result.filter((agent) => agent.status === "installed" && agent.canEnable && !isEnabled(agent.agentId)).map((agent) => agent.agentId));
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally { setChecking(false); }
  }

  async function enable() {
    setEnabling(true); setError(null); setNotice(null);
    try {
      const result = await onEnable(selected);
      setSelectedIds([]);
      setNotice(result.enabledAgentIds.length > 0 ? `已启用 ${result.enabledAgentIds.length} 个 Agent。` : "所选 Agent 已全部启用。");
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally { setEnabling(false); }
  }

  return <section className="agent-installation-panel" aria-label="已安装 Agent 检测">
    <div className="agent-installation-toolbar">
      <p>检测本机已安装的 Agent，选择后一起启用。</p>
      <button type="button" onClick={() => void detect()} disabled={busy}>
        {checking ? <RefreshCcw size={15} className="spin" /> : <Search size={15} />}
        {checking ? "正在检测…" : report ? "重新检测" : "检测已安装 Agent"}
      </button>
    </div>
    {error && <p role="alert" className="agent-installation-error">{error}</p>}
    {notice && <p role="status" className="agent-installation-notice"><Check size={15} />{notice}</p>}
    {report && <>
      <div className="agent-installation-summary">
        <strong>发现 {installed.length} 个已安装 Agent</strong>
        {eligibleIds.length > 0 && <div className="agent-installation-actions">
          <button type="button" disabled={busy} onClick={() => setSelectedIds(selected.length === eligibleIds.length ? [] : eligibleIds)}>{selected.length === eligibleIds.length ? "取消全选" : "全选可启用"}</button>
          <button type="button" className="agent-installation-enable" disabled={busy || selected.length === 0} onClick={() => void enable()}>{enabling ? "正在启用…" : `一键启用 (${selected.length})`}</button>
        </div>}
      </div>
      {installed.length === 0 && <p>未在常见安装位置找到客户端。自定义安装位置、远程环境或仅在云端使用的 Agent，可在下方手动配置。</p>}
      <div className="agent-installation-list">
        {installed.map((agent) => {
          const harness = harnessById.get(agent.agentId);
          const enabled = isEnabled(agent.agentId);
          return <div className="agent-installation-row" key={agent.agentId}>
            <label>
              <input type="checkbox" aria-label={`启用 ${agent.name}`} checked={enabled || selected.includes(agent.agentId)} disabled={busy || enabled || !agent.canEnable}
                onChange={(event) => setSelectedIds((ids) => event.target.checked ? [...ids, agent.agentId] : ids.filter((id) => id !== agent.agentId))} />
              {harness && <img src={agentIconMap[harness.icon]} className={`agent-icon ${["cline", "goose", "hermes", "kilo", "roo", "kimi", "cursor", "githubcopilot", "opencode", "pi", "grok", "aider", "warp"].includes(harness.icon) ? "agent-icon-mono" : ""}`} alt="" width={18} height={18} />}
              <strong>{agent.name}</strong>
              <span>{enabled ? "已启用" : agent.canEnable ? "可启用" : harness?.status === "import" ? "客户端导入" : harness?.status === "manual" ? "手动读取" : "请先配置目录"}</span>
            </label>
            <div className="agent-installation-evidence">{agent.evidence.map((item) => <div key={`${item.kind}:${item.path}`}><span>{evidenceLabels[item.kind]}</span><code>{item.path}</code></div>)}</div>
            {!agent.canEnable && harness && <button type="button" className="link-button" onClick={() => void api.openUrl(harness.docs)}>查看使用方式 ↗</button>}
          </div>;
        })}
      </div>
      {configured.length > 0 && <details className="agent-installation-configured">
        <summary>仅发现配置目录 ({configured.length})</summary>
        <p>配置目录可能是历史残留，需要确认客户端是否仍在使用；这些 Agent 不会自动勾选。</p>
        {configured.map((agent) => <div key={agent.agentId}><strong>{agent.name}</strong>{agent.evidence.map((item) => <code key={item.path}>{item.path}</code>)}</div>)}
      </details>}
      <p className="agent-installation-hint">检测 PATH、常见应用位置和编辑器插件；不运行客户端。安装证据不代表已登录或插件已启用。启用后扫描配置的 Skill 目录。</p>
    </>}
  </section>;
}
