/**
 * NodemailerPlugin — detects email-sending libraries (nodemailer, @sendgrid/mail,
 * mailgun.js, resend, postmark, @aws-sdk/client-ses, mailersend) and tags files
 * with roles for transport creation, sending, templates, and generic usage.
 *
 * Pass 2 edges:
 *   - email_transport: enclosing symbol → smtp-host::<host>     (nodemailer createTransport with host)
 *   - email_transport: enclosing symbol → smtp-service::<name>  (nodemailer createTransport with service)
 *   - email_transport: enclosing symbol → smtp-provider::<name> (SaaS client construction/import)
 *   - email_sends:     enclosing symbol → smtp-provider::nodemailer (.sendMail call)
 *   - email_sends:     enclosing symbol → smtp-provider::<name>    (SaaS send call)
 */
import fs from 'node:fs';
import path from 'node:path';
import { ok, type TraceMcpResult } from '../../../../../errors.js';
import type {
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  FileParseResult,
  RawEdge,
  ResolveContext,
} from '../../../../../plugin-api/types.js';
import { findEnclosingSymbol, lineOfIndex } from '../../_shared/regex-edges.js';

const MAIL_PACKAGES = [
  'nodemailer',
  '@sendgrid/mail',
  'mailgun.js',
  'mailgun-js',
  'resend',
  'postmark',
  '@aws-sdk/client-ses',
  'mailersend',
];

const TRANSPORT_RE = /(?:nodemailer\s*\.\s*)?createTransport\s*\(/g;
const SEND_MAIL_RE = /\.\s*sendMail\s*\(/g;
const SENDGRID_RE = /\b(?:sgMail|sendgrid)\s*\.\s*(?:send|setApiKey)\s*\(/g;
const RESEND_SEND_RE = /\bresend\s*\.\s*emails\s*\.\s*send\s*\(/g;
const POSTMARK_RE = /\.\s*sendEmail(?:Batch|WithTemplate)?\s*\(/g;
const MAILGUN_RE = /\bmg\s*\.\s*messages\s*\.\s*create\s*\(/g;
const TEMPLATE_HINT_RE = /\b(?:template|html|text)\s*:\s*['"`]/g;
const MAIL_IMPORT_RE =
  /(?:import|require)\s*(?:\(|{)?\s*.*['"](?:nodemailer|@sendgrid\/mail|mailgun\.js|mailgun-js|resend|postmark|@aws-sdk\/client-ses|mailersend)['"]/;

const _PROVIDER_IMPORT_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'sendgrid', re: /['"]@sendgrid\/mail['"]/ },
  { name: 'resend', re: /['"]resend['"]/ },
  { name: 'postmark', re: /['"]postmark['"]/ },
  { name: 'mailgun', re: /['"]mailgun(?:\.js|-js)['"]/ },
  { name: 'aws-ses', re: /['"]@aws-sdk\/client-ses['"]/ },
  { name: 'mailersend', re: /['"]mailersend['"]/ },
];

const CREATE_TRANSPORT_BLOCK_RE = /createTransport\s*\(\s*\{([\s\S]*?)\}\s*\)/g;
const HOST_KEY_RE = /\bhost\s*:\s*['"`]([^'"`]+)['"`]/;
const SERVICE_KEY_RE = /\bservice\s*:\s*['"`]([^'"`]+)['"`]/;

const SENDMAIL_CALL_RE = /\.\s*sendMail\s*\(/g;
const RESEND_EMAILS_SEND_CALL_RE = /\bresend\s*\.\s*emails\s*\.\s*send\s*\(/g;
const SENDGRID_SEND_CALL_RE = /\b(?:sgMail|sendgrid)\s*\.\s*send\s*\(/g;
const POSTMARK_SEND_CALL_RE = /\.\s*sendEmail(?:Batch|WithTemplate)?\s*\(/g;
const MAILGUN_SEND_CALL_RE = /\bmg\s*\.\s*messages\s*\.\s*create\s*\(/g;

export class NodemailerPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'nodemailer',
    version: '1.0.0',
    priority: 40,
    category: 'tooling',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    if (ctx.packageJson) {
      const deps = {
        ...(ctx.packageJson.dependencies as Record<string, string> | undefined),
        ...(ctx.packageJson.devDependencies as Record<string, string> | undefined),
      };
      for (const pkg of MAIL_PACKAGES) {
        if (pkg in deps) return true;
      }
    }

    try {
      const pkgPath = path.join(ctx.rootPath, 'package.json');
      const content = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);
      const deps = {
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.devDependencies as Record<string, string> | undefined),
      };
      for (const p of MAIL_PACKAGES) {
        if (p in deps) return true;
      }
    } catch {
      return false;
    }

    return false;
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'email_transport', category: 'email', description: 'Email transport creation' },
        { name: 'email_sends', category: 'email', description: 'Email send operation' },
      ],
    };
  }

  extractNodes(
    _filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (!['typescript', 'javascript'].includes(language)) {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    const result: FileParseResult = { status: 'ok', symbols: [] };

    const hasImport = MAIL_IMPORT_RE.test(source);
    const hasTransport = TRANSPORT_RE.test(source);
    const hasSendMail = SEND_MAIL_RE.test(source);
    const hasSendgrid = SENDGRID_RE.test(source);
    const hasResend = RESEND_SEND_RE.test(source);
    // `.sendEmail(` is too generic for a role signal — only trust it when postmark
    // is actually imported. Without this guard, any class with a `sendEmail()`
    // method gets mis-tagged as `email_sender`.
    const hasPostmark = POSTMARK_RE.test(source) && /['"]postmark['"]/.test(source);
    const hasMailgun = MAILGUN_RE.test(source);
    const hasTemplateHint = TEMPLATE_HINT_RE.test(source);

    const sends = hasSendMail || hasSendgrid || hasResend || hasPostmark || hasMailgun;

    if (hasTransport && sends) {
      result.frameworkRole = 'email_sender';
    } else if (hasTransport) {
      result.frameworkRole = 'email_transport';
    } else if (sends) {
      result.frameworkRole = 'email_sender';
    } else if (hasImport && hasTemplateHint) {
      result.frameworkRole = 'email_template';
    } else if (hasImport) {
      result.frameworkRole = 'email_usage';
    }

    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];

    for (const file of ctx.getAllFiles()) {
      if (file.language !== 'typescript' && file.language !== 'javascript') continue;
      const source = ctx.readFile(file.path);
      if (!source) continue;
      const symbols = ctx.getSymbolsByFile(file.id);

      // 1. nodemailer createTransport blocks → host/service edges.
      CREATE_TRANSPORT_BLOCK_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = CREATE_TRANSPORT_BLOCK_RE.exec(source)) !== null) {
        const line = lineOfIndex(source, m.index);
        const encl = findEnclosingSymbol(symbols, line);
        if (!encl) continue;
        const block = m[1];
        const hostMatch = HOST_KEY_RE.exec(block);
        const serviceMatch = SERVICE_KEY_RE.exec(block);
        let target: string;
        const metadata: Record<string, unknown> = { line, file: file.path };
        if (hostMatch) {
          target = `smtp-host::${hostMatch[1]}`;
          metadata.host = hostMatch[1];
          metadata.kind = 'smtp';
        } else if (serviceMatch) {
          target = `smtp-service::${serviceMatch[1]}`;
          metadata.service = serviceMatch[1];
          metadata.kind = 'service';
        } else {
          target = 'smtp-host::unknown';
          metadata.kind = 'unknown';
        }
        edges.push({
          edgeType: 'email_transport',
          sourceNodeType: 'symbol',
          sourceRefId: encl.id,
          targetSymbolId: target,
          metadata,
          resolution: 'text_matched',
        });
      }

      // 2. SaaS provider import → email_transport (once per file, at first import line).
      //    We pick the first import of a mail provider package and attach the edge to it.
      const importRe =
        /(?:import|require)\s*(?:\(|{)?\s*.*['"](@sendgrid\/mail|resend|postmark|mailgun(?:\.js|-js)|@aws-sdk\/client-ses|mailersend)['"]/g;
      importRe.lastIndex = 0;
      const seenProviders = new Set<string>();
      while ((m = importRe.exec(source)) !== null) {
        const raw = m[1];
        const providerName =
          raw === '@sendgrid/mail'
            ? 'sendgrid'
            : raw === '@aws-sdk/client-ses'
              ? 'aws-ses'
              : raw === 'mailgun.js' || raw === 'mailgun-js'
                ? 'mailgun'
                : raw; // resend / postmark / mailersend
        if (seenProviders.has(providerName)) continue;
        seenProviders.add(providerName);
        const line = lineOfIndex(source, m.index);
        const encl = findEnclosingSymbol(symbols, line);
        if (!encl) continue;
        edges.push({
          edgeType: 'email_transport',
          sourceNodeType: 'symbol',
          sourceRefId: encl.id,
          targetSymbolId: `smtp-provider::${providerName}`,
          metadata: { provider: providerName, kind: 'provider', line, file: file.path },
          resolution: 'text_matched',
        });
      }

      // 3. Send calls — one edge per call site with accurate line/enclosing-symbol.
      const emitSend = (re: RegExp, provider: string) => {
        re.lastIndex = 0;
        let sm: RegExpExecArray | null;
        while ((sm = re.exec(source)) !== null) {
          const line = lineOfIndex(source, sm.index);
          const encl = findEnclosingSymbol(symbols, line);
          if (!encl) continue;
          edges.push({
            edgeType: 'email_sends',
            sourceNodeType: 'symbol',
            sourceRefId: encl.id,
            targetSymbolId: `smtp-provider::${provider}`,
            metadata: { provider, line, file: file.path },
            resolution: 'text_matched',
          });
        }
      };
      emitSend(SENDMAIL_CALL_RE, 'nodemailer');
      emitSend(RESEND_EMAILS_SEND_CALL_RE, 'resend');
      emitSend(SENDGRID_SEND_CALL_RE, 'sendgrid');
      emitSend(MAILGUN_SEND_CALL_RE, 'mailgun');
      // Postmark — overlaps with nodemailer's sendMail naming; only emit if postmark imported.
      if (/['"]postmark['"]/.test(source)) {
        emitSend(POSTMARK_SEND_CALL_RE, 'postmark');
      }
    }

    return ok(edges);
  }
}
