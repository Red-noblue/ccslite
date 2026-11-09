/**
 * 服务器版 ProviderActions。
 * 迁移 ccswitch 原版按钮布局，动作改为调用父组件提供的 HTTP API 适配函数。
 */
import {
  Activity,
  BarChart3,
  Check,
  Copy,
  Edit,
  Loader2,
  Coins,
  Play,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";

export function ProviderActions({
  isCurrent,
  isTesting = false,
  isAutoFailoverEnabled = false,
  isRoutingEnabled = false,
  onSwitch,
  onEdit,
  onDuplicate,
  onTest,
  onConfigureUsage,
  onOpenPriceLab,
  onResetCircuit,
  onDelete,
  onToggleRouting,
}) {
  const mainText = isAutoFailoverEnabled
    ? isRoutingEnabled
      ? "已参与"
      : "参与"
    : isCurrent
      ? "使用中"
      : "使用此供应商";
  const MainIcon = isAutoFailoverEnabled
    ? isRoutingEnabled ? Check : Plus
    : isCurrent ? Check : Play;

  function handleMainClick() {
    if (isAutoFailoverEnabled && onToggleRouting) {
      onToggleRouting(!isRoutingEnabled);
      return;
    }
    if (!isCurrent) onSwitch();
  }

  return (
    <div className="provider-actions">
      <span className={isCurrent && !isAutoFailoverEnabled ? "cursor-disabled" : ""}>
        <button
          className={`cc-button cc-button-sm ${isCurrent && !isAutoFailoverEnabled ? "cc-button-muted" : "cc-button-primary"}`}
          onClick={handleMainClick}
          disabled={isCurrent && !isAutoFailoverEnabled}
        >
          <MainIcon size={15} />
          {mainText}
        </button>
      </span>

      <div className="provider-icon-actions">
        <button className="cc-icon-action" onClick={onEdit} title="编辑">
          <Edit size={15} />
        </button>
        <button className="cc-icon-action" onClick={onDuplicate} title="复制">
          <Copy size={15} />
        </button>
        <button className="cc-icon-action" onClick={onTest} disabled={isTesting} title="检测连通并更新路由健康">
          {isTesting ? <Loader2 className="spin" size={15} /> : <Activity size={15} />}
        </button>
        <button className="cc-icon-action" onClick={onConfigureUsage} title="使用统计">
          <BarChart3 size={15} />
        </button>
        <button className="cc-icon-action" onClick={onOpenPriceLab} title="价格实验">
          <Coins size={15} />
        </button>
        <button className="cc-icon-action" onClick={onResetCircuit} title="重置熔断">
          <RotateCcw size={15} />
        </button>
        <button className="cc-icon-action danger" onClick={onDelete} title="删除">
          <Trash2 size={15} />
        </button>
      </div>
    </div>
  );
}
