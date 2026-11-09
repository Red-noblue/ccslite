/**
 * 轻量信息提示控件。
 * 常驻显示信息图标，鼠标悬停或键盘聚焦时显示补充说明。
 */
import { Info } from "lucide-react";

export function InfoHint({ children, label = "查看说明" }) {
  return (
    <span className="info-hint">
      <button className="info-hint-button" type="button" aria-label={label}>
        <Info size={14} />
      </button>
      <span className="info-hint-tooltip" role="tooltip">{children}</span>
    </span>
  );
}
