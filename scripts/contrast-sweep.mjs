// Contrast sweep for trace-mcp.com — see docs/DESIGN-WEB.md §5.
//
// Renders every page in headless Chrome in both themes and checks each element
// carrying its own text against its real painted background.
//
// Two source modes. If a Jekyll build exists at docs/_site, it is served as-is
// and the DOM under test is exactly what Pages publishes — run `jekyll build`
// first and you get the real thing. Without one, doc pages are re-rendered here
// by a small Markdown converter that covers what the site's own pages use.
// That fallback approximates the DOM: a construct it does not implement paints
// no element, so a selector styling that construct goes untested. It is a
// regression gate for the token ladder, not a proof of full coverage. Extend
// the converter when a page starts using something new.
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const DOCS_DIR = path.join(REPO_ROOT, 'docs');
const SITE_DIR = path.join(DOCS_DIR, '_site');
const USE_BUILT_SITE = fs.existsSync(SITE_DIR) && fs.statSync(SITE_DIR).isDirectory();

// Helper to calculate relative luminance & contrast ratio
function sRGBtoLin(c) {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

function parseRgb(colorStr) {
  const match = colorStr.match(
    /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/,
  );
  if (!match) return [0, 0, 0, 1];
  return [
    parseFloat(match[1]),
    parseFloat(match[2]),
    parseFloat(match[3]),
    match[4] !== undefined ? parseFloat(match[4]) : 1,
  ];
}

function blend(fg, bg) {
  const [fr, fgCol, fb, fa] = fg;
  const [br, bgCol, bb] = bg;
  return [fr * fa + br * (1 - fa), fgCol * fa + bgCol * (1 - fa), fb * fa + bb * (1 - fa)];
}

function luminance(rgb) {
  return 0.2126 * sRGBtoLin(rgb[0]) + 0.7152 * sRGBtoLin(rgb[1]) + 0.0722 * sRGBtoLin(rgb[2]);
}

function contrast(rgb1, rgb2) {
  const l1 = luminance(rgb1);
  const l2 = luminance(rgb2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

// Basic markdown to HTML renderer for doc pages
function renderMarkdownToHtml(mdContent) {
  let md = mdContent.replace(/^---[\s\S]*?---\s*/, '');
  md = md.replace(/\{\{\s*site\.data\.counts\.languages\s*\}\}/g, '81');
  md = md.replace(/\{\{\s*site\.data\.counts\.frameworks\s*\}\}/g, '87');
  md = md.replace(/\{\{\s*site\.data\.counts\.tools\s*\}\}/g, '171');

  const lines = md.split('\n');
  const out = [];
  let inCode = false;
  let inTable = false;
  let tableRows = [];

  function flushTable() {
    if (!inTable || tableRows.length === 0) return;
    let html = '<div class="table-scroll" role="group" aria-label="Table"><table>\n<thead>\n<tr>';
    const headerCells = tableRows[0];
    for (const cell of headerCells) {
      html += `<th scope="col">${formatInline(cell)}</th>`;
    }
    html += '</tr>\n</thead>\n<tbody>\n';
    for (let i = 1; i < tableRows.length; i++) {
      html += '<tr>';
      for (let j = 0; j < tableRows[i].length; j++) {
        const cell = tableRows[i][j];
        if (j === 0) html += `<th scope="row">${formatInline(cell)}</th>`;
        else html += `<td>${formatInline(cell)}</td>`;
      }
      html += '</tr>\n';
    }
    html += '</tbody>\n</table></div>\n';
    out.push(html);
    tableRows = [];
    inTable = false;
  }

  function formatInline(str) {
    let s = str.trim();
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/_([^_]+)_/g, '<em>$1</em>');
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    s = s.replace(/✓/g, '<span class="mark mark-yes" role="img" aria-label="Yes">✓</span>');
    s = s.replace(/✗/g, '<span class="mark mark-no" role="img" aria-label="No">✗</span>');
    return s;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('```')) {
      if (inTable) flushTable();
      if (!inCode) {
        inCode = true;
        out.push('<pre role="group" aria-label="Code sample"><code>');
      } else {
        inCode = false;
        out.push('</code></pre>');
      }
      continue;
    }

    if (inCode) {
      out.push(line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '\n');
      continue;
    }

    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      const cells = line
        .trim()
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim());
      if (cells.every((c) => /^:?-+:?$/.test(c))) {
        continue;
      }
      inTable = true;
      tableRows.push(cells);
      continue;
    } else if (inTable) {
      flushTable();
    }

    if (line.startsWith('# ')) {
      out.push(`<h1>${formatInline(line.slice(2))}</h1>`);
    } else if (line.startsWith('## ')) {
      out.push(`<h2>${formatInline(line.slice(3))}</h2>`);
    } else if (line.startsWith('### ')) {
      out.push(`<h3>${formatInline(line.slice(4))}</h3>`);
    } else if (line.startsWith('#### ')) {
      out.push(`<h4>${formatInline(line.slice(5))}</h4>`);
    } else if (line.startsWith('---')) {
      out.push('<hr>');
    } else if (line.startsWith('> ') || line.trim() === '>') {
      out.push(`<blockquote><p>${formatInline(line.replace(/^>\s?/, ''))}</p></blockquote>`);
    } else if (line.startsWith('- ')) {
      out.push(`<ul><li>${formatInline(line.slice(2))}</li></ul>`);
    } else if (/^\d+\.\s/.test(line)) {
      out.push(`<ol><li>${formatInline(line.replace(/^\d+\.\s+/, ''))}</li></ol>`);
    } else if (line.trim().length > 0) {
      if (
        line.trim().startsWith('<script') ||
        line.trim().startsWith('</script>') ||
        line.trim().startsWith('{') ||
        line.trim().startsWith('}')
      ) {
        out.push(line);
      } else {
        out.push(`<p>${formatInline(line)}</p>`);
      }
    }
  }
  if (inTable) flushTable();

  return out.join('\n');
}

function buildDocHtml(mdFilePath) {
  const mdContent = fs.readFileSync(mdFilePath, 'utf8');
  const renderedContent = renderMarkdownToHtml(mdContent);
  const layout = fs.readFileSync(path.join(DOCS_DIR, '_layouts/default.html'), 'utf8');

  let navItems = [];
  try {
    const navYaml = fs.readFileSync(path.join(DOCS_DIR, '_data/docs_nav.yml'), 'utf8');
    const titles = [...navYaml.matchAll(/title:\s*([^\n]+)/g)].map((m) => m[1].trim());
    const urls = [...navYaml.matchAll(/url:\s*([^\n]+)/g)].map((m) => m[1].trim());
    navItems = titles.map((t, i) => ({ title: t, url: urls[i] || '#' }));
  } catch (e) {}

  let navHtml = '';
  for (const item of navItems) {
    navHtml += `<a href="${item.url}">${item.title}</a>\n`;
  }

  let html = layout
    .replace('{{ content }}', renderedContent)
    .replace(
      /\{\{\s*'\/fonts\/[^']+'\s*\|\s*relative_url\s*\}\}/g,
      '/fonts/space-grotesk-variable-latin.woff2',
    )
    .replace(
      /\{\{\s*'\/assets\/css\/docs\.css'\s*\|\s*relative_url\s*\}\}/g,
      '/assets/css/docs.css',
    )
    .replace(/\{\{\s*'\/'\s*\|\s*relative_url\s*\}\}/g, '/')
    .replace(/\{%\s*seo\s*%\}/g, '<title>Docs</title>')
    .replace(/\{%-?\s*if page\.noindex\s*-?%\}[\s\S]*?\{%-?\s*endif\s*-?%\}/g, '')
    .replace(
      /\{%-?\s*if page\.updated\s*-?%\}[\s\S]*?\{%-?\s*endif\s*-?%\}/g,
      '<p class="page-updated">Last updated: August 30, 2026</p>',
    )
    .replace(
      /\{%-?\s*for item in site\.data\.docs_nav\s*-?%\}[\s\S]*?\{%-?\s*endfor\s*-?%\}/g,
      navHtml,
    )
    .replace(/\{%-?[\s\S]*?-?%\}/g, '');

  return html;
}

// In-browser evaluation script
const EVAL_SCRIPT = String.raw`
(() => {
  try {
    function parseRgb(str) {
      const m = str.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/);
      if (!m) return [0, 0, 0, 1];
      return [
        parseFloat(m[1]),
        parseFloat(m[2]),
        parseFloat(m[3]),
        m[4] !== undefined ? parseFloat(m[4]) : 1
      ];
    }

    function blend(fg, bg) {
      const [fr, fgCol, fb, fa] = fg;
      const [br, bgCol, bb] = bg;
      return [
        fr * fa + br * (1 - fa),
        fgCol * fa + bgCol * (1 - fa),
        fb * fa + bb * (1 - fa)
      ];
    }

    function sRGBtoLin(c) {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    }

    function luminance(rgb) {
      return 0.2126 * sRGBtoLin(rgb[0]) + 0.7152 * sRGBtoLin(rgb[1]) + 0.0722 * sRGBtoLin(rgb[2]);
    }

    function contrast(rgb1, rgb2) {
      const l1 = luminance(rgb1);
      const l2 = luminance(rgb2);
      const lighter = Math.max(l1, l2);
      const darker = Math.min(l1, l2);
      return (lighter + 0.05) / (darker + 0.05);
    }

    function getEffectiveBg(el) {
      let current = el;
      let bgStack = [];
      while (current && current !== document) {
        const style = window.getComputedStyle(current);
        const bg = parseRgb(style.backgroundColor);
        if (bg[3] > 0) {
          bgStack.unshift(bg);
          if (bg[3] >= 0.99) break;
        }
        current = current.parentElement;
      }
      const theme = document.documentElement.getAttribute('data-theme') || 'dark';
      let composite = theme === 'light' ? [245, 245, 245] : [0, 0, 0];
      for (const bg of bgStack) {
        composite = blend(bg, composite);
      }
      return composite;
    }

    function isAriaHidden(el) {
      let cur = el;
      while (cur && cur !== document) {
        if (cur.getAttribute && cur.getAttribute('aria-hidden') === 'true') return true;
        cur = cur.parentElement;
      }
      return false;
    }

    const results = [];
    const allElements = Array.from(document.querySelectorAll('*'));
    for (const el of allElements) {
      if (isAriaHidden(el)) continue;
      if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'NOSCRIPT' || el.tagName === 'SVG' || el.tagName === 'HEAD' || el.tagName === 'HTML') continue;

      let hasDirectText = false;
      for (const child of el.childNodes) {
        if (child.nodeType === 3 && child.textContent.trim().length > 0) {
          hasDirectText = true;
          break;
        }
      }
      if (!hasDirectText) continue;

      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;

      const fg = parseRgb(style.color);
      const bg = getEffectiveBg(el);
      const effectiveFg = fg[3] < 1 ? blend(fg, bg) : [fg[0], fg[1], fg[2]];

      const ratio = contrast(effectiveFg, bg);
      const fontSize = parseFloat(style.fontSize);
      const fontWeight = parseInt(style.fontWeight, 10) || 400;
      const isLarge = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
      const required = isLarge ? 3.0 : 4.5;

      const text = el.textContent.replace(/\s+/g, ' ').trim().slice(0, 50);
      const selector = el.className ? el.tagName.toLowerCase() + '.' + String(el.className).trim().split(/\s+/).join('.') : el.tagName.toLowerCase();

      results.push({
        selector,
        text,
        fontSize,
        fontWeight,
        isLarge,
        fgRgb: effectiveFg.map(x => Math.round(x)),
        bgRgb: bg.map(x => Math.round(x)),
        fgHex: '#' + effectiveFg.map(x => Math.round(x).toString(16).padStart(2, '0')).join(''),
        bgHex: '#' + bg.map(x => Math.round(x).toString(16).padStart(2, '0')).join(''),
        ratio: Math.round(ratio * 100) / 100,
        required,
        // No epsilon: the ratio is computed at full precision, so 4.45 is a real
        // AA failure, not a rounding artefact. A tolerance here would hide the
        // near-misses this sweep exists to catch.
        pass: ratio >= required
      });
    }
    return results;
  } catch (err) {
    return [{ error: err.message, stack: err.stack }];
  }
})()
`;

function mimeFor(filePath) {
  return (
    {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css',
      '.js': 'text/javascript',
      '.woff2': 'font/woff2',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.json': 'application/json',
    }[path.extname(filePath)] || 'application/octet-stream'
  );
}

/**
 * Serves the site. With a Jekyll build at docs/_site, serves that verbatim —
 * the real published DOM. Otherwise re-renders .md through the layout locally.
 */
export function createDocsServer() {
  const root = USE_BUILT_SITE ? SITE_DIR : DOCS_DIR;
  return http.createServer((req, res) => {
    let reqPath = req.url.split('?')[0];
    if (reqPath === '/') reqPath = '/index.html';

    if (USE_BUILT_SITE) {
      let p = path.join(root, reqPath);
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': mimeFor(p) });
      res.end(fs.readFileSync(p));
      return;
    }

    // Check if markdown page requested
    const directPath = path.join(DOCS_DIR, reqPath);
    const mdPath = reqPath.endsWith('.html')
      ? path.join(DOCS_DIR, reqPath.replace(/\.html$/, '.md'))
      : null;

    if (mdPath && fs.existsSync(mdPath) && fs.statSync(mdPath).isFile()) {
      const html = buildDocHtml(mdPath);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (fs.existsSync(directPath) && fs.statSync(directPath).isFile()) {
      let data = fs.readFileSync(directPath);
      if (directPath.endsWith('.html')) {
        let str = data.toString('utf8');
        if (str.startsWith('---')) {
          str = str.replace(/^---[\s\S]*?---\s*/, '');
          str = str.replace(/\{\{\s*site\.data\.counts\.languages\s*\}\}/g, '81');
          str = str.replace(/\{\{\s*site\.data\.counts\.frameworks\s*\}\}/g, '87');
          str = str.replace(/\{\{\s*site\.data\.counts\.tools\s*\}\}/g, '171');
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(str);
        return;
      }
      res.writeHead(200, { 'Content-Type': mimeFor(directPath) });
      res.end(data);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });
}

export async function runContrastSweep(pageUrls) {
  const server = createDocsServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const serverPort = server.address().port;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-sweep-'));
  const chromePort = 9300 + Math.floor(Math.random() * 400);
  const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless',
    `--remote-debugging-port=${chromePort}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${tmpDir}`,
    '--disable-gpu',
    '--no-first-run',
    'about:blank',
  ]);

  try {
    let pageWsUrl = null;
    for (let i = 0; i < 100; i++) {
      try {
        const listData = await new Promise((resolve, reject) => {
          http
            .get(`http://127.0.0.1:${chromePort}/json/list`, (res) => {
              let buf = '';
              res.on('data', (d) => (buf += d));
              res.on('end', () => resolve(buf));
            })
            .on('error', reject);
        });
        // Chrome also exposes browser_ui targets (omnibox popup) — only a real page can navigate.
        const page = JSON.parse(listData).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) {
          pageWsUrl = page.webSocketDebuggerUrl;
          break;
        }
      } catch (e) {
        // Chrome not listening yet.
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    if (!pageWsUrl) throw new Error('Could not connect to Chrome CDP page target');

    const ws = new WebSocket(pageWsUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });

    let msgId = 1;
    const send = (method, params = {}) =>
      new Promise((resolve) => {
        const id = msgId++;
        const handler = (e) => {
          const res = JSON.parse(e.data);
          if (res.id === id) {
            ws.removeEventListener('message', handler);
            resolve(res.result);
          }
        };
        ws.addEventListener('message', handler);
        ws.send(JSON.stringify({ id, method, params }));
      });

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const report = [];

    for (const urlPath of pageUrls) {
      const fullUrl = `http://127.0.0.1:${serverPort}${urlPath.startsWith('/') ? urlPath : '/' + urlPath}`;
      // A missing page must fail the run, not get audited as if it were the page:
      // an error body is a handful of default-coloured words that can pass or fail
      // on its own and tells you nothing about the page you meant to check.
      const probe = await fetch(fullUrl);
      if (!probe.ok) throw new Error(`${urlPath} returned HTTP ${probe.status} — not swept`);
      await send('Page.navigate', { url: fullUrl });
      await new Promise((r) => setTimeout(r, 1000));

      for (const theme of ['dark', 'light']) {
        await send('Runtime.evaluate', {
          expression: `
            (() => {
              let s = document.getElementById('__sweep_style');
              if (!s) {
                s = document.createElement('style');
                s.id = '__sweep_style';
                s.textContent = '* { transition: none !important; animation: none !important; }';
                document.head.appendChild(s);
              }
              document.documentElement.setAttribute('data-theme', '${theme}');
              if (window.__sweepMeasure) window.__sweepMeasure();
            })()
          `,
        });
        await new Promise((r) => setTimeout(r, 400));

        const evalRes = await send('Runtime.evaluate', {
          expression: EVAL_SCRIPT,
          returnByValue: true,
        });
        if (evalRes?.exceptionDetails) {
          throw new Error(`${urlPath} (${theme}): ${evalRes.exceptionDetails.text}`);
        }

        const elements = evalRes?.result?.value || [];
        const failures = elements.filter((e) => !e.pass);
        report.push({
          page: urlPath,
          theme,
          total: elements.length,
          failures,
        });
      }
    }

    ws.close();
    chrome.kill('SIGTERM');
    await new Promise((r) => chrome.on('close', r));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {}
    server.close();
    return report;
  } catch (err) {
    chrome.kill('SIGTERM');
    await new Promise((r) => chrome.on('close', r));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {}
    server.close();
    throw err;
  }
}

/**
 * Every page to sweep, recursively. Jekyll's own `_`-prefixed dirs are not pages.
 *
 * With a build, walk the generated tree: a source path cannot be mapped to a URL
 * by hand because front matter can set `permalink` (docs/perf/README.md publishes
 * as /perf/), and guessing produces a 404 the sweep would then audit as if it
 * were the page. Without a build, walk the sources — that mapping is the same one
 * createDocsServer uses to render them, so it is correct by construction.
 */
function discoverPages() {
  if (USE_BUILT_SITE) return walk(SITE_DIR, '', '.html').sort();
  return ['/', ...walk(DOCS_DIR, '', '.md').sort()];
}

function walk(dir, prefix, ext) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full, `${prefix}/${entry.name}`, ext));
    } else if (entry.name.endsWith(ext)) {
      // A built index.html *is* its directory's URL; anything else keeps its name.
      out.push(
        entry.name === 'index.html'
          ? `${prefix}/`
          : `${prefix}/${entry.name.replace(/\.md$/, '.html')}`,
      );
    }
  }
  return out;
}

if (process.argv[1] === __filename) {
  const pages = process.argv.slice(2);
  const targetPages = pages.length > 0 ? pages : discoverPages();
  runContrastSweep(targetPages)
    .then((report) => {
      console.log('\n=== Contrast Sweep Report ===\n');
      let totalFailures = 0;
      for (const r of report) {
        console.log(
          `Page: ${r.page} | Theme: ${r.theme} | Checked: ${r.total} elements | Failures: ${r.failures.length}`,
        );
        if (r.failures.length > 0) {
          totalFailures += r.failures.length;
          const worst = [...r.failures].sort((a, b) => a.ratio - b.ratio)[0];
          console.log(
            `  Worst ratio: ${worst.ratio}:1 (required: ${worst.required}:1) on "${worst.text}" (fg: ${worst.fgHex}, bg: ${worst.bgHex})`,
          );
          console.log(`  Failing elements summary:`);
          const byHex = {};
          for (const f of r.failures) {
            const key = `${f.fgHex} on ${f.bgHex} (${f.selector})`;
            byHex[key] = (byHex[key] || 0) + 1;
          }
          for (const [k, count] of Object.entries(byHex)) {
            console.log(`    - ${count}x: ${k}`);
          }
        }
      }
      // Report the count rather than leaving anyone to quote one from memory.
      console.log(
        `\nSwept ${targetPages.length} pages x 2 themes from ${USE_BUILT_SITE ? 'the Jekyll build in docs/_site' : 'Markdown sources (fallback renderer — see the header comment)'}.`,
      );
      console.log(`Total failing elements: ${totalFailures}`);
      if (totalFailures > 0) process.exitCode = 1;
    })
    .catch((e) => {
      console.error('Sweep error:', e);
      process.exit(1);
    });
}
