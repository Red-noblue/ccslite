/**
 * 分组统计测试：历史只归默认组，同供应商跨组不共享计数，新建或复制分组从零开始。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createGroupStatistics } from "../../lib/group-usage.js";

test("历史默认归属、成功率和新分组计数隔离", () => {
  const stats = createGroupStatistics();
  stats.restore([
    { providerId: "same", statusCode: 200 },
    { providerId: "same", statusCode: 500, error: "test" },
    { providerId: "same", statusCode: 200, usageCategory: "ccok_probe" },
    { providerId: "same", groupId: "used", statusCode: 200 },
  ]);
  assert.equal(stats.snapshot("default").totalRequests, 2);
  assert.equal(stats.snapshot("default").successRate, 50);
  assert.equal(stats.snapshot("used").totalRequests, 1);
  assert.equal(stats.snapshot("clone").totalRequests, 0);
  const finish = stats.start("clone");
  assert.equal(stats.snapshot("clone").activeConnections, 1);
  assert.equal(stats.snapshot("default").totalRequests, 2);
  finish({ statusCode: 200, providerAttempts: [{ sequence: 2, outcome: "success" }] });
  finish({ statusCode: 500 });
  assert.equal(stats.snapshot("clone").successRate, 100);
  assert.equal(stats.snapshot("clone").activeConnections, 0);
  assert.equal(stats.snapshot("clone").failoverCount, 1);
  stats.record({ groupId: "used", statusCode: 500 });
  assert.equal(stats.snapshot("used").successRate, 50);
});

test("流式诊断按分组区分输出前切换、输出后断流和传输错误", () => {
  const stats = createGroupStatistics();
  stats.record({
    groupId: "quality",
    statusCode: 200,
    isStreaming: true,
    timestamp: "2026-10-21T00:00:00.000Z",
    providerAttempts: [
      {
        sequence: 1,
        outcome: "failure",
        failureClass: "transport",
        startedAt: "2026-10-21T00:00:00.000Z",
        streamDiagnostics: {
          firstByteAt: "2026-10-21T00:00:00.050Z",
          firstByteLatencyMs: 50,
          lastChunkAt: "2026-10-21T00:00:00.050Z",
          forwardedBytes: 0,
          outputStarted: false,
          termination: "upstream_closed_before_completion",
        },
      },
      { sequence: 2, outcome: "success" },
    ],
  });
  stats.record({
    groupId: "quality",
    statusCode: 502,
    error: "断流",
    isStreaming: true,
    timestamp: "2026-10-21T00:01:00.000Z",
    providerAttempts: [{
      sequence: 1,
      outcome: "failure",
      failureClass: "transport",
      startedAt: "2026-10-21T00:01:00.000Z",
      streamDiagnostics: {
        firstByteAt: "2026-10-21T00:01:00.020Z",
        firstByteLatencyMs: 20,
        lastChunkAt: "2026-10-21T00:01:00.100Z",
        forwardedBytes: 16,
        outputStarted: true,
        termination: "upstream_closed_before_completion",
      },
    }],
  });

  const diagnostic = stats.snapshot("quality").streamDiagnostics;
  assert.equal(diagnostic.preOutputFailovers, 1);
  assert.equal(diagnostic.midStreamDisconnects, 1);
  assert.equal(diagnostic.transportErrors, 2);
  assert.equal(diagnostic.firstByteAverageMs, 35);
  assert.equal(stats.snapshot("default").streamDiagnostics.streamAttempts, 0);
});
