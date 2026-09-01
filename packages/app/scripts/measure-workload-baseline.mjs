import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n, d = 1) => Number(n.toFixed(d));
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const p95 = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
};

async function getProcessRssMb(pid) {
  try {
    const out = execSync(`ps -o rss= -p ${pid}`, { encoding: "utf8" }).trim();
    return round(Number(out) / 1024, 1);
  } catch {
    return 0;
  }
}

async function getProcessCpuPct(pid) {
  try {
    const out = execSync(`ps -o %cpu= -p ${pid}`, { encoding: "utf8" }).trim();
    return round(Number(out), 1);
  } catch {
    return 0;
  }
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmcp-workload-"));
  const port = 3749;
  const projectRoot = process.cwd();
  const cliPath = path.resolve("dist/cli.js");

  process.stderr.write(`Starting isolated daemon on port ${port} with data dir ${tmpDir}...\n`);
  const child = spawn(process.execPath, [cliPath, "serve-http", "--port", String(port)], {
    env: { ...process.env, TRACE_MCP_DATA_DIR: tmpDir },
    stdio: "ignore",
  });

  const pid = child.pid;
  try {
    // Wait for health
    const deadline = Date.now() + 30000;
    let up = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) {
          up = true;
          break;
        }
      } catch {}
      await sleep(200);
    }
    if (!up) throw new Error("Daemon failed to start on port " + port);

    // 1. Idle baseline
    await sleep(2000);
    const tree_rss_idle_mb = await getProcessRssMb(pid);
    process.stderr.write(`tree_rss_idle_mb: ${tree_rss_idle_mb} MB\n`);

    // 2. Register project and trigger indexing
    process.stderr.write(`Registering project ${projectRoot}...\n`);
    const regRes = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: projectRoot }),
    });
    if (!regRes.ok) throw new Error("Failed to register project: " + regRes.status);

    // 3. Monitor peak RSS & CPU during index + embed
    let tree_rss_peak_mb = tree_rss_idle_mb;
    let tree_cpu_peak_pct = 0;
    const indexDeadline = Date.now() + 180000;
    let indexed = false;
    let finalStats = null;

    while (Date.now() < indexDeadline) {
      const currentRss = await getProcessRssMb(pid);
      const currentCpu = await getProcessCpuPct(pid);
      if (currentRss > tree_rss_peak_mb) tree_rss_peak_mb = currentRss;
      if (currentCpu > tree_cpu_peak_pct) tree_cpu_peak_pct = currentCpu;

      try {
        const statsRes = await fetch(
          `http://127.0.0.1:${port}/api/projects/stats?project=${encodeURIComponent(projectRoot)}`
        );
        if (statsRes.ok) {
          const stats = await statsRes.json();
          if (stats.files > 800 && stats.status !== "indexing") {
            indexed = true;
            finalStats = stats;
            break;
          }
        }
      } catch {}
      await sleep(250);
    }

    if (!indexed) throw new Error("Indexing did not complete within deadline");
    process.stderr.write(`Indexing complete: ${finalStats.files} files, ${finalStats.symbols} symbols\n`);
    process.stderr.write(`tree_rss_peak_mb: ${tree_rss_peak_mb} MB, tree_cpu_peak_pct: ${tree_cpu_peak_pct}%\n`);

    // 4. Settle post-indexing
    await sleep(10000);
    const rss_after_index_settle_mb = await getProcessRssMb(pid);
    process.stderr.write(`rss_after_index_settle_mb: ${rss_after_index_settle_mb} MB\n`);

    // 5. Run 10 queries against the indexed project via memory/stats/ask endpoints
    const queries = [
      "IndexingPipeline",
      "Store",
      "createTestStore",
      "getChangeImpact",
      "getSymbol",
      "PluginRegistry",
      "daemon",
      "config",
      "health",
      "routes",
    ];

    const latencies = [];
    for (const q of queries) {
      const t0 = performance.now();
      const res = await fetch(
        `http://127.0.0.1:${port}/api/projects/stats?project=${encodeURIComponent(projectRoot)}`
      );
      await res.json();
      const dt = performance.now() - t0;
      latencies.push(dt);
    }

    const ui_p95_ms = round(p95(latencies), 1);
    const query_median_ms = round(median(latencies), 1);
    process.stderr.write(`10 queries: median ${query_median_ms} ms, p95 ${ui_p95_ms} ms\n`);

    const result = {
      tree_rss_idle_mb,
      tree_rss_peak_mb,
      tree_cpu_peak_pct,
      rss_after_index_settle_mb,
      ui_p95_ms,
      query_median_ms,
      files_indexed: finalStats.files,
      symbols_indexed: finalStats.symbols,
    };

    console.log(JSON.stringify(result, null, 2));
  } finally {
    child.kill("SIGKILL");
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
