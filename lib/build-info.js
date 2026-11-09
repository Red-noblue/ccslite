/**
 * 启动时固定版本身份，防止磁盘上的代码更新后，页面把旧进程显示成新版本。
 */
import crypto from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export function readBuildInfo(root) {
  const packageInfo = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  let manifest = null;
  try { manifest = JSON.parse(readFileSync(path.join(root, "release-manifest.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const digest = crypto.createHash("sha256");
  const files = ["server.js", ...readdirSync(path.join(root, "lib")).filter((name) => name.endsWith(".js")).map((name) => `lib/${name}`)].sort();
  for (const name of files) digest.update(name).update("\0").update(readFileSync(path.join(root, name))).update("\0");
  const codeHash = digest.digest("hex");
  return Object.freeze({
    version: packageInfo.version,
    releaseId: manifest?.releaseId || `workspace-${codeHash.slice(0, 12)}`,
    codeHash,
    packaged: Boolean(manifest),
  });
}
