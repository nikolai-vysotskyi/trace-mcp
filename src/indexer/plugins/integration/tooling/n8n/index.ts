/**
 * N8nPlugin — comprehensive n8n workflow indexing.
 *
 * Extracts and models the full structure of n8n workflow JSON files:
 *   - All node categories: triggers, actions, flow control, data transforms, AI/LangChain
 *   - Typed connections (main, error, ai_languageModel, ai_tool, ai_memory, etc.)
 *   - Webhook/form/schedule routes as discoverable endpoints
 *   - Sub-workflow calls with cross-file resolution
 *   - HTTP request external dependencies
 *   - Credential references with full ID/name
 *   - Implicit data dependencies via expression parsing ($node["Name"])
 *   - Sticky notes as documentation
 *   - Workflow-level settings (errorWorkflow, timezone, callerPolicy)
 *   - Node-level error handling (continueOnFail, retryOnFail, onError)
 *   - Custom n8n node package detection
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
  RawRoute,
  RawSymbol,
  ResolveContext,
} from '../../../../../plugin-api/types.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface N8nCredentialRef {
  id: string | null;
  name: string;
}

export interface N8nNode {
  id?: string;
  name: string;
  type: string;
  position: [number, number];
  parameters?: Record<string, unknown>;
  typeVersion?: number;
  credentials?: Record<string, N8nCredentialRef>;
  disabled?: boolean;
  notes?: string;
  notesInFlow?: boolean;
  retryOnFail?: boolean;
  maxTries?: number;
  waitBetweenTries?: number;
  continueOnFail?: boolean;
  onError?: 'continueErrorOutput' | 'continueRegularOutput' | 'stopWorkflow';
  alwaysOutputData?: boolean;
  executeOnce?: boolean;
  webhookId?: string;
  color?: number;
}

export interface N8nConnectionTarget {
  node: string;
  type: string;   // "main", "ai_languageModel", "ai_tool", etc.
  index: number;
}

export interface N8nConnection {
  sourceNode: string;
  sourceOutput: number;
  targetNode: string;
  targetInput: number;
  connectionType: string;   // "main", "ai_languageModel", "ai_tool", etc.
}

export interface N8nWorkflowSettings {
  timezone?: string;
  errorWorkflow?: string;
  callerIds?: string;
  callerPolicy?: 'any' | 'none' | 'workflowsFromAList';
  saveDataErrorExecution?: string;
  saveDataSuccessExecution?: string;
  saveManualExecutions?: string | boolean;
  saveExecutionProgress?: string | boolean;
  executionTimeout?: number;
  executionOrder?: 'v0' | 'v1';
}

export interface N8nWorkflow {
  id?: string;
  name?: string;
  nodes: N8nNode[];
  connections: Record<string, Record<string, Array<Array<N8nConnectionTarget>>>>;
  active?: boolean;
  settings?: N8nWorkflowSettings;
  staticData?: Record<string, unknown> | null;
  pinData?: Record<string, unknown[]>;
  tags?: string[] | Array<{ name: string }>;
  meta?: { templateId?: string; instanceId?: string };
}

// ══════════════════════════════════════════════════════════════════════════
// Node classification — pattern-based to cover ALL n8n node types (400+)
// without needing to enumerate each one.
//
// Classification order:
//   1. Exact-match sets for core types with special extraction logic
//   2. Pattern matching (suffix/prefix) for the long tail
//   3. Service-domain map for external dependency tracking
// ══════════════════════════════════════════════════════════════════════════

// -- Exact-match sets (nodes that need special handling) --

const CODE_TYPES = new Set([
  'n8n-nodes-base.code',
  'n8n-nodes-base.function',
  'n8n-nodes-base.functionItem',
  'n8n-nodes-base.executeCommand',
  '@n8n/n8n-nodes-langchain.code',
]);

const FLOW_CONTROL_TYPES = new Set([
  'n8n-nodes-base.if',
  'n8n-nodes-base.switch',
  'n8n-nodes-base.merge',
  'n8n-nodes-base.splitInBatches',
  'n8n-nodes-base.wait',
  'n8n-nodes-base.filter',
  'n8n-nodes-base.limit',
  'n8n-nodes-base.noOp',
  'n8n-nodes-base.respondToWebhook',
  'n8n-nodes-base.compareDatasets',
  'n8n-nodes-base.executionData',
  'n8n-nodes-base.loopOverItems',
]);

const DATA_TRANSFORM_TYPES = new Set([
  'n8n-nodes-base.set',
  'n8n-nodes-base.itemLists',
  'n8n-nodes-base.splitOut',
  'n8n-nodes-base.aggregate',
  'n8n-nodes-base.summarize',
  'n8n-nodes-base.sort',
  'n8n-nodes-base.removeDuplicates',
  'n8n-nodes-base.crypto',
  'n8n-nodes-base.markdown',
  'n8n-nodes-base.xml',
  'n8n-nodes-base.html',
  'n8n-nodes-base.convertToFile',
  'n8n-nodes-base.extractFromFile',
  'n8n-nodes-base.readWriteFile',
  'n8n-nodes-base.spreadsheetFile',
  'n8n-nodes-base.editImage',
  'n8n-nodes-base.moveFile',
  'n8n-nodes-base.compression',
  'n8n-nodes-base.aiTransform',
  'n8n-nodes-base.dateTime',
  'n8n-nodes-base.renameKeys',
  'n8n-nodes-base.jmespath',
  'n8n-nodes-base.jsonParse',
]);

const SUBWORKFLOW_TYPES = new Set([
  'n8n-nodes-base.executeWorkflow',
  '@n8n/n8n-nodes-langchain.toolWorkflow',
]);

const HTTP_REQUEST_TYPES = new Set([
  'n8n-nodes-base.httpRequest',
  'n8n-nodes-base.httpRequestTool',
  'n8n-nodes-base.graphql',
]);

const STICKY_NOTE_TYPE = 'n8n-nodes-base.stickyNote';

// -- Connection types for AI/LangChain wiring --

const AI_CONNECTION_TYPES = new Set([
  'ai_agent', 'ai_chain', 'ai_document', 'ai_embedding',
  'ai_languageModel', 'ai_memory', 'ai_outputParser',
  'ai_retriever', 'ai_reranker', 'ai_textSplitter',
  'ai_tool', 'ai_vectorStore',
]);

// -- Service domain classification for ALL integration nodes --
// Maps the short node name (after the dot) to a service domain.
// This covers every n8n-nodes-base.* action/trigger node.
// Pattern: n8n-nodes-base.<nodeName> → lookup SERVICE_DOMAINS[<nodeName lower>]

export type N8nServiceDomain =
  | 'communication' | 'database' | 'cloud_storage' | 'dev_tools'
  | 'crm_sales' | 'marketing' | 'productivity' | 'finance'
  | 'analytics' | 'cms' | 'social_media' | 'ecommerce'
  | 'cloud_infra' | 'security' | 'iot_hardware' | 'hr_recruiting'
  | 'support' | 'design' | 'forms_surveys' | 'other';

// Each key is the lowercased short name from n8n-nodes-base.<name> (without Trigger suffix).
// This lets us classify both action and trigger variants of every node.
const SERVICE_DOMAINS: Record<string, N8nServiceDomain> = {
  // ── Communication ──────────────────────────────────────────────
  slack: 'communication', discord: 'communication', telegram: 'communication',
  telegrambot: 'communication', microsoftteams: 'communication', mattermost: 'communication',
  rocketchat: 'communication', zulip: 'communication', googlechat: 'communication',
  matrix: 'communication', gotify: 'communication', pushbullet: 'communication',
  pushover: 'communication', pushcut: 'communication', line: 'communication',
  sendgrid: 'communication', mailgun: 'communication', mailjet: 'communication',
  ses: 'communication', mandrill: 'communication', postmark: 'communication',
  emailsend: 'communication', emailreademail: 'communication', emailreadimap: 'communication',
  gmail: 'communication', microsoftoutlook: 'communication', imap: 'communication',
  smtp: 'communication', twilio: 'communication', vonage: 'communication',
  whatsapp: 'communication', whatsappbusiness: 'communication', signal: 'communication',
  intercom: 'communication', crisp: 'communication', drift: 'communication',
  chatwork: 'communication', flock: 'communication', messagebirdSms: 'communication',
  brevo: 'communication',

  // ── Databases ──────────────────────────────────────────────────
  postgres: 'database', mysql: 'database', mariadb: 'database',
  mongodb: 'database', redis: 'database', elasticsearch: 'database',
  microsoftsql: 'database', oracledb: 'database', sqlite: 'database',
  cockroachdb: 'database', questdb: 'database', timescaledb: 'database',
  couchdb: 'database', dynamodb: 'database', cassandra: 'database',
  neo4j: 'database', fauna: 'database', supabase: 'database',
  firebase: 'database', firebaserealtimedb: 'database',
  firebasecloudfirestore: 'database', snowflake: 'database',
  bigquery: 'database', clickhouse: 'database',
  neondb: 'database', planetscale: 'database', turso: 'database',
  upstash: 'database', xata: 'database',

  // ── Cloud Storage ──────────────────────────────────────────────
  s3: 'cloud_storage', awss3: 'cloud_storage', minio: 'cloud_storage',
  googledrive: 'cloud_storage', onedrive: 'cloud_storage',
  microsoftonedrive: 'cloud_storage', dropbox: 'cloud_storage',
  box: 'cloud_storage', nextcloud: 'cloud_storage', ftp: 'cloud_storage',
  sftp: 'cloud_storage', googlecloudstorage: 'cloud_storage',
  azureblobstorage: 'cloud_storage', backblazeb2: 'cloud_storage',
  wasabi: 'cloud_storage', filemaker: 'cloud_storage',

  // ── Developer Tools ────────────────────────────────────────────
  github: 'dev_tools', gitlab: 'dev_tools', bitbucket: 'dev_tools',
  git: 'dev_tools', jira: 'dev_tools', jirasoftware: 'dev_tools',
  linear: 'dev_tools', sentry: 'dev_tools', grafana: 'dev_tools',
  pagerduty: 'dev_tools', opsgenie: 'dev_tools', victorops: 'dev_tools',
  datadog: 'dev_tools', uptimerobot: 'dev_tools', statuspage: 'dev_tools',
  ssh: 'dev_tools', jenkins: 'dev_tools', circleci: 'dev_tools',
  travisci: 'dev_tools', docker: 'dev_tools', kubernetes: 'dev_tools',
  terraform: 'dev_tools', ansible: 'dev_tools', vagrant: 'dev_tools',
  n8n: 'dev_tools', gist: 'dev_tools', raindrop: 'dev_tools',
  netlify: 'dev_tools', vercel: 'dev_tools', render: 'dev_tools',
  railway: 'dev_tools', fly: 'dev_tools', cloudflare: 'dev_tools',
  postman: 'dev_tools', npm: 'dev_tools', twake: 'dev_tools',
  coda: 'dev_tools', nocodb: 'dev_tools', baserow: 'dev_tools',
  gitea: 'dev_tools', taiga: 'dev_tools', sourcify: 'dev_tools',

  // ── CRM & Sales ────────────────────────────────────────────────
  salesforce: 'crm_sales', hubspot: 'crm_sales', pipedrive: 'crm_sales',
  copper: 'crm_sales', close: 'crm_sales', freshworks: 'crm_sales',
  freshworksCrm: 'crm_sales', zohocrm: 'crm_sales', zoho: 'crm_sales',
  agilecrm: 'crm_sales', capsulecrm: 'crm_sales', highLevel: 'crm_sales',
  activecampaign: 'crm_sales', keap: 'crm_sales', infusionsoft: 'crm_sales',
  streak: 'crm_sales', affinity: 'crm_sales', attio: 'crm_sales',
  nutshell: 'crm_sales', onfleet: 'crm_sales', harvest: 'crm_sales',
  lemlist: 'crm_sales', phantombuster: 'crm_sales', hunter: 'crm_sales',
  clearbit: 'crm_sales', uplead: 'crm_sales', apollo: 'crm_sales',
  lonescale: 'crm_sales',

  // ── Marketing ──────────────────────────────────────────────────
  mailchimp: 'marketing', convertkit: 'marketing', drip: 'marketing',
  sendinblue: 'marketing', moosend: 'marketing', beehiiv: 'marketing',
  buttondown: 'marketing', customerio: 'marketing', klaviyo: 'marketing',
  iterable: 'marketing', campaign_monitor: 'marketing', aweber: 'marketing',
  mailerlite: 'marketing', emailable: 'marketing', getresponse: 'marketing',
  autopilot: 'marketing', mautic: 'marketing', onesignal: 'marketing',
  pushover_marketing: 'marketing', segment: 'marketing',
  mixpanel: 'marketing', amplitude: 'marketing', plausible: 'marketing',
  matomo: 'marketing', posthog: 'marketing', rudderstack: 'marketing',
  googleads: 'marketing', facebookads: 'marketing', linkedinads: 'marketing',

  // ── Productivity ───────────────────────────────────────────────
  googlesheets: 'productivity', airtable: 'productivity', notion: 'productivity',
  asana: 'productivity', trello: 'productivity', monday: 'productivity',
  clickup: 'productivity', todoist: 'productivity', wrike: 'productivity',
  basecamp: 'productivity', smartsheet: 'productivity', teamwork: 'productivity',
  microsoftexcel: 'productivity', microsoftword: 'productivity',
  microsofttodo: 'productivity', googledocs: 'productivity',
  googleslides: 'productivity', googlecalendar: 'productivity',
  googlecontacts: 'productivity', googletasks: 'productivity',
  microsoftoutlookcalendar: 'productivity', applecalendar: 'productivity',
  caldav: 'productivity', evernote: 'productivity', onenote: 'productivity',
  roamresearch: 'productivity', obsidian: 'productivity',
  seatable: 'productivity', milanote: 'productivity',
  toggletrack: 'productivity', clockify: 'productivity', toggl: 'productivity',
  timely: 'productivity', rescuetime: 'productivity',
  cal: 'productivity', calendly: 'productivity', schedule: 'productivity',

  // ── Finance & Accounting ───────────────────────────────────────
  stripe: 'finance', paypal: 'finance', quickbooks: 'finance',
  quickbooksonline: 'finance', xero: 'finance', freshbooks: 'finance',
  wave: 'finance', invoiceninja: 'finance', chargebee: 'finance',
  recurly: 'finance', paddle: 'finance', gumroad: 'finance',
  lemonsqueezy: 'finance', mollie: 'finance', square: 'finance',
  braintree: 'finance', coinbase: 'finance', wise: 'finance',
  transferwise: 'finance', plaid: 'finance',

  // ── Analytics & Monitoring ─────────────────────────────────────
  googleanalytics: 'analytics', googlebigquery: 'analytics',
  googletagmanager: 'analytics', hotjar: 'analytics',
  newrelic: 'analytics', splunk: 'analytics', logdna: 'analytics',
  elastic: 'analytics', prometheus: 'analytics',
  kibana: 'analytics', sumo: 'analytics', honeybadger: 'analytics',
  bugsnag: 'analytics', rollbar: 'analytics', airbrake: 'analytics',
  raygun: 'analytics',

  // ── CMS & Content ──────────────────────────────────────────────
  wordpress: 'cms', ghost: 'cms', strapi: 'cms', contentful: 'cms',
  webflow: 'cms', sanity: 'cms', directus: 'cms', prismic: 'cms',
  cockpit: 'cms', storyblok: 'cms', buttercms: 'cms', agilitycms: 'cms',
  medium: 'cms', devto: 'cms', hashnode: 'cms', blogger: 'cms',
  discourse: 'cms', lemmy: 'cms', grafbase: 'cms', payload: 'cms',

  // ── Social Media ───────────────────────────────────────────────
  twitter: 'social_media', x: 'social_media', facebook: 'social_media',
  facebookgraph: 'social_media', facebookleadads: 'social_media',
  instagram: 'social_media', linkedin: 'social_media', reddit: 'social_media',
  pinterest: 'social_media', tumblr: 'social_media', mastodon: 'social_media',
  youtube: 'social_media', tiktok: 'social_media', snapchat: 'social_media',
  buffer: 'social_media', hootsuite: 'social_media',

  // ── eCommerce ──────────────────────────────────────────────────
  shopify: 'ecommerce', woocommerce: 'ecommerce', magento: 'ecommerce',
  bigcommerce: 'ecommerce', prestashop: 'ecommerce', saleor: 'ecommerce',
  medusa: 'ecommerce', etsy: 'ecommerce', ebay: 'ecommerce',
  amazon: 'ecommerce', amazonses: 'ecommerce', amazonsns: 'ecommerce',
  amazonrekognition: 'ecommerce',

  // ── Cloud Infrastructure ───────────────────────────────────────
  awslambda: 'cloud_infra', awssns: 'cloud_infra', awssqs: 'cloud_infra',
  awsdynamodb: 'cloud_infra', awsses: 'cloud_infra',
  awstextract: 'cloud_infra', awstranscribe: 'cloud_infra',
  awscomprehend: 'cloud_infra', awsrekognition: 'cloud_infra',
  googlecloud: 'cloud_infra', googlecloudfunctions: 'cloud_infra',
  googlecloudnaturallanguage: 'cloud_infra', googlecloudtranslate: 'cloud_infra',
  googlevision: 'cloud_infra', googlespeechtotext: 'cloud_infra',
  googlesheetsheet: 'cloud_infra', googleperspective: 'cloud_infra',
  azuredevops: 'cloud_infra', azurecognitive: 'cloud_infra',
  azureopenai: 'cloud_infra',

  // ── Security ───────────────────────────────────────────────────
  thehive: 'security', misp: 'security', urlscanio: 'security',
  virustotal: 'security', alienvault: 'security', crowdstrike: 'security',
  securityscorecard: 'security', snyk: 'security',
  haveibeenpwned: 'security', shodan: 'security',

  // ── Support & Helpdesk ─────────────────────────────────────────
  zendesk: 'support', freshdesk: 'support', freshservice: 'support',
  helpscout: 'support', servicedesk: 'support', servicenow: 'support',
  zammad: 'support', happyfox: 'support', front: 'support',
  kustomer: 'support', helpscoutdocs: 'support',

  // ── HR & Recruiting ────────────────────────────────────────────
  bamboohr: 'hr_recruiting', workable: 'hr_recruiting', greenhouse: 'hr_recruiting',
  lever: 'hr_recruiting', personio: 'hr_recruiting', gusto: 'hr_recruiting',
  deel: 'hr_recruiting', rippling: 'hr_recruiting', recruitee: 'hr_recruiting',

  // ── Design & Media ─────────────────────────────────────────────
  figma: 'design', canva: 'design', bannerbear: 'design',
  cloudinary: 'design', imgbb: 'design', unsplash: 'design',
  pexels: 'design', giphy: 'design',

  // ── Forms & Surveys ────────────────────────────────────────────
  typeform: 'forms_surveys', jotform: 'forms_surveys', surveymonkey: 'forms_surveys',
  googleforms: 'forms_surveys', tally: 'forms_surveys', formio: 'forms_surveys',
  wufoo: 'forms_surveys', form: 'forms_surveys', formstack: 'forms_surveys',

  // ── IoT & Hardware ─────────────────────────────────────────────
  mqtt: 'iot_hardware', homeassistant: 'iot_hardware', philipshue: 'iot_hardware',
};

/** Resolve the service domain of an n8n node from its type string. */
export function getServiceDomain(nodeType: string): N8nServiceDomain | undefined {
  const shortName = nodeType.replace(/^n8n-nodes-base\./, '').replace(/^@n8n\/n8n-nodes-langchain\./, '');
  // Strip Trigger/Tool suffix to match the base service name
  const baseName = shortName.replace(/Trigger$/, '').replace(/Tool$/, '');
  return SERVICE_DOMAINS[baseName.toLowerCase()]
    ?? SERVICE_DOMAINS[shortName.toLowerCase()]
    ?? undefined;
}

// ── Expression dependency parsing ────────────────────────────────────────

const EXPR_NODE_REF = /\$node\s*\[\s*['"]([^'"]+)['"]\s*\]/g;
const EXPR_ITEMS_REF = /\$items\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const EXPR_SHORTHAND_REF = /\$\(\s*['"]([^'"]+)['"]\s*\)/g;
const EXPR_ENV_REF = /\$env\.([A-Za-z_][A-Za-z0-9_]*)/g;
const EXPR_EXECUTION = /\$execution\b/;
const EXPR_WORKFLOW = /\$workflow\b/;
const EXPR_BINARY = /\$binary\b/;
const EXPR_INPUT = /\$input\b/;

export interface ExpressionInfo {
  nodeDeps: Set<string>;
  envVars: Set<string>;
  usesExecution: boolean;
  usesWorkflow: boolean;
  usesBinary: boolean;
  usesInput: boolean;
}

export function createExpressionInfo(): ExpressionInfo {
  return {
    nodeDeps: new Set(),
    envVars: new Set(),
    usesExecution: false,
    usesWorkflow: false,
    usesBinary: false,
    usesInput: false,
  };
}

/** Deep-parse a value tree for all expression patterns. */
export function parseExpressions(value: unknown, info: ExpressionInfo): void {
  if (typeof value === 'string') {
    let m: RegExpExecArray | null;
    const re1 = new RegExp(EXPR_NODE_REF.source, 'g');
    while ((m = re1.exec(value)) !== null) info.nodeDeps.add(m[1]);
    const re2 = new RegExp(EXPR_ITEMS_REF.source, 'g');
    while ((m = re2.exec(value)) !== null) info.nodeDeps.add(m[1]);
    const re3 = new RegExp(EXPR_SHORTHAND_REF.source, 'g');
    while ((m = re3.exec(value)) !== null) info.nodeDeps.add(m[1]);
    const re4 = new RegExp(EXPR_ENV_REF.source, 'g');
    while ((m = re4.exec(value)) !== null) info.envVars.add(m[1]);
    if (EXPR_EXECUTION.test(value)) info.usesExecution = true;
    if (EXPR_WORKFLOW.test(value)) info.usesWorkflow = true;
    if (EXPR_BINARY.test(value)) info.usesBinary = true;
    if (EXPR_INPUT.test(value)) info.usesInput = true;
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      parseExpressions(v, info);
    }
  }
}

/** Backward-compatible wrapper: extracts only node deps into a Set. */
export function extractExpressionDeps(value: unknown, deps: Set<string>): void {
  const info = createExpressionInfo();
  parseExpressions(value, info);
  for (const d of info.nodeDeps) deps.add(d);
}

/** Aggregate ExpressionInfo across all nodes in a workflow. */
export function extractWorkflowExpressionInfo(workflow: N8nWorkflow): ExpressionInfo {
  const info = createExpressionInfo();
  for (const node of workflow.nodes) {
    if (node.parameters) parseExpressions(node.parameters, info);
  }
  return info;
}

// ── Workflow complexity metrics ─────────────────────────────────────────

export interface WorkflowComplexity {
  nodeCount: number;
  connectionCount: number;
  maxDepth: number;
  branchingFactor: number;
  mergeCount: number;
  cyclomaticComplexity: number;
  triggerCount: number;
  hasLoop: boolean;
}

export function computeWorkflowComplexity(workflow: N8nWorkflow): WorkflowComplexity {
  const connections = extractConnections(workflow);
  const nodeCount = workflow.nodes.length;
  const connectionCount = connections.length;
  const triggerCount = workflow.nodes.filter(isTriggerNode).length;
  const mergeCount = workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.merge').length;

  // Cyclomatic complexity: count conditionals + 1
  let cyclomaticComplexity = 1;
  for (const node of workflow.nodes) {
    if (node.type === 'n8n-nodes-base.if'
      || node.type === 'n8n-nodes-base.switch'
      || node.type === 'n8n-nodes-base.filter') {
      cyclomaticComplexity++;
    }
  }

  // Build adjacency list for BFS
  const adj = new Map<string, string[]>();
  const incomingCount = new Map<string, number>();
  const outgoingCount = new Map<string, number>();
  for (const node of workflow.nodes) {
    adj.set(node.name, []);
    incomingCount.set(node.name, 0);
    outgoingCount.set(node.name, 0);
  }
  for (const conn of connections) {
    if (conn.connectionType !== 'main') continue;
    adj.get(conn.sourceNode)?.push(conn.targetNode);
    outgoingCount.set(conn.sourceNode, (outgoingCount.get(conn.sourceNode) ?? 0) + 1);
    incomingCount.set(conn.targetNode, (incomingCount.get(conn.targetNode) ?? 0) + 1);
  }

  // maxDepth: BFS from trigger nodes
  let maxDepth = 0;
  const triggers = workflow.nodes.filter(isTriggerNode);
  for (const trigger of triggers) {
    const visited = new Set<string>();
    const queue: Array<{ name: string; depth: number }> = [{ name: trigger.name, depth: 0 }];
    visited.add(trigger.name);
    while (queue.length > 0) {
      const { name, depth } = queue.shift()!;
      if (depth > maxDepth) maxDepth = depth;
      for (const next of (adj.get(name) ?? [])) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push({ name: next, depth: depth + 1 });
        }
      }
    }
  }

  // branchingFactor: avg outgoing for nodes that have >0 outgoing
  let totalOutgoing = 0;
  let nodesWithOutgoing = 0;
  for (const [, count] of outgoingCount) {
    if (count > 0) {
      totalOutgoing += count;
      nodesWithOutgoing++;
    }
  }
  const branchingFactor = nodesWithOutgoing > 0
    ? Math.round((totalOutgoing / nodesWithOutgoing) * 100) / 100
    : 0;

  // hasLoop: check if splitInBatches has a connection back to itself
  let hasLoop = false;
  for (const node of workflow.nodes) {
    if (node.type === 'n8n-nodes-base.splitInBatches') {
      const neighbors = adj.get(node.name) ?? [];
      // Check direct self-loop or indirect loop (node connects to something that connects back)
      if (neighbors.includes(node.name)) {
        hasLoop = true;
        break;
      }
      // Check indirect: any target of splitInBatches eventually connects back to it
      const visited = new Set<string>();
      const queue = [...neighbors];
      while (queue.length > 0) {
        const curr = queue.shift()!;
        if (curr === node.name) { hasLoop = true; break; }
        if (visited.has(curr)) continue;
        visited.add(curr);
        for (const next of (adj.get(curr) ?? [])) {
          if (!visited.has(next)) queue.push(next);
        }
      }
      if (hasLoop) break;
    }
  }

  return {
    nodeCount,
    connectionCount,
    maxDepth,
    branchingFactor,
    mergeCount,
    cyclomaticComplexity,
    triggerCount,
    hasLoop,
  };
}

// ── Disconnected node detection ─────────────────────────────────────────

export function findDisconnectedNodes(workflow: N8nWorkflow, connections: N8nConnection[]): N8nNode[] {
  const incoming = new Set<string>();
  const outgoing = new Set<string>();
  for (const conn of connections) {
    outgoing.add(conn.sourceNode);
    incoming.add(conn.targetNode);
  }

  return workflow.nodes.filter((node) => {
    // Skip triggers (naturally have no incoming)
    if (isTriggerNode(node)) return false;
    // Skip sticky notes
    if (node.type === STICKY_NOTE_TYPE) return false;
    // Disconnected if no incoming AND no outgoing
    return !incoming.has(node.name) && !outgoing.has(node.name);
  });
}

// ── Custom n8n node package detection ───────────────────────────────────

export interface CustomNodeDefinition {
  filePath: string;
  name: string;
  displayName: string;
  group: string[];
  version: number;
  credentialTypes: string[];
  parameterNames: string[];
  operationNames: string[];
}

const NODE_NAME_RE = /name\s*[:=]\s*['"]([^'"]+)['"]/;
const NODE_DISPLAY_NAME_RE = /displayName\s*[:=]\s*['"]([^'"]+)['"]/;
const NODE_GROUP_RE = /group\s*[:=]\s*\[([^\]]*)\]/;
const NODE_VERSION_RE = /version\s*[:=]\s*(\d+)/;
const NODE_CRED_TYPE_RE = /name\s*[:=]\s*['"]([^'"]+)['"]/g;
const NODE_CRED_BLOCK_RE = /credentials\s*[:=]\s*\[([\s\S]*?)\]/;
const NODE_PROP_NAME_RE = /name\s*[:=]\s*['"]([^'"]+)['"]/g;
const NODE_OPERATION_RE = /name\s*[:=]\s*['"]operation['"][\s\S]*?options\s*[:=]\s*\[([\s\S]*?)\]/;

export function extractCustomNodeDefinitions(ctx: ProjectContext): CustomNodeDefinition[] {
  const results: CustomNodeDefinition[] = [];
  const searchDirs = ['nodes', 'src/nodes', 'credentials'];

  for (const dir of searchDirs) {
    const fullDir = path.join(ctx.rootPath, dir);
    try {
      if (!fs.existsSync(fullDir) || !fs.statSync(fullDir).isDirectory()) continue;
      const files = collectNodeFiles(fullDir);
      for (const filePath of files) {
        try {
          const source = fs.readFileSync(filePath, 'utf-8');
          const def = parseCustomNodeSource(filePath, source);
          if (def) results.push(def);
        } catch { /* skip unreadable files */ }
      }
    } catch { /* skip inaccessible dirs */ }
  }

  return results;
}

function collectNodeFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...collectNodeFiles(fullPath));
      } else if (entry.name.endsWith('.node.ts')) {
        results.push(fullPath);
      }
    }
  } catch { /* ignore */ }
  return results;
}

function parseCustomNodeSource(filePath: string, source: string): CustomNodeDefinition | null {
  // Must contain INodeTypeDescription to be a valid custom node
  if (!source.includes('INodeTypeDescription')) return null;

  const nameMatch = NODE_NAME_RE.exec(source);
  const displayNameMatch = NODE_DISPLAY_NAME_RE.exec(source);
  if (!nameMatch) return null;

  const name = nameMatch[1];
  const displayName = displayNameMatch ? displayNameMatch[1] : name;

  // Group
  const groupMatch = NODE_GROUP_RE.exec(source);
  const group: string[] = [];
  if (groupMatch) {
    const groupStr = groupMatch[1];
    const groupItems = groupStr.match(/['"]([^'"]+)['"]/g);
    if (groupItems) {
      for (const g of groupItems) group.push(g.replace(/['"]/g, ''));
    }
  }

  // Version
  const versionMatch = NODE_VERSION_RE.exec(source);
  const version = versionMatch ? parseInt(versionMatch[1], 10) : 1;

  // Credential types from credentials block
  const credentialTypes: string[] = [];
  const credBlock = NODE_CRED_BLOCK_RE.exec(source);
  if (credBlock) {
    const re = new RegExp(NODE_CRED_TYPE_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(credBlock[1])) !== null) {
      credentialTypes.push(m[1]);
    }
  }

  // Parameter names from properties block (bracket-counting to handle nested arrays)
  const parameterNames: string[] = [];
  const propsStart = source.search(/properties\s*[:=]\s*\[/);
  if (propsStart >= 0) {
    const propsBlock = extractBalancedBracket(source, source.indexOf('[', propsStart));
    if (propsBlock) {
      // Match top-level { name: '...' } entries (depth=1 curly braces)
      const topLevelNameRe = /\{\s*name\s*[:=]\s*['"]([^'"]+)['"]/g;
      let m: RegExpExecArray | null;
      // Walk through and only match at bracket depth 0 (relative to propsBlock content)
      let depth = 0;
      let idx = 0;
      const content = propsBlock;
      while (idx < content.length) {
        const ch = content[idx];
        if (ch === '{' && depth === 0) {
          // Extract name from this top-level object
          const nameRe = /^\{\s*name\s*[:=]\s*['"]([^'"]+)['"]/;
          const slice = content.slice(idx);
          const nm = nameRe.exec(slice);
          if (nm) parameterNames.push(nm[1]);
        }
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        idx++;
      }
    }
  }

  // Operation names
  const operationNames: string[] = [];
  const opBlock = NODE_OPERATION_RE.exec(source);
  if (opBlock) {
    const re = new RegExp(NODE_PROP_NAME_RE.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(opBlock[1])) !== null) {
      operationNames.push(m[1]);
    }
  }

  return { filePath, name, displayName, group, version, credentialTypes, parameterNames, operationNames };
}

// ── Node category classification ─────────────────────────────────────────

export type N8nNodeCategory =
  | 'trigger' | 'code' | 'flow_control' | 'data_transform'
  | 'ai' | 'subworkflow' | 'http_request' | 'sticky_note' | 'action';

export function classifyNode(node: N8nNode): N8nNodeCategory {
  if (node.type === STICKY_NOTE_TYPE) return 'sticky_note';
  if (isTriggerNode(node)) return 'trigger';
  if (CODE_TYPES.has(node.type)) return 'code';
  if (FLOW_CONTROL_TYPES.has(node.type)) return 'flow_control';
  if (DATA_TRANSFORM_TYPES.has(node.type)) return 'data_transform';
  if (SUBWORKFLOW_TYPES.has(node.type)) return 'subworkflow';
  if (HTTP_REQUEST_TYPES.has(node.type)) return 'http_request';
  if (isAiNode(node)) return 'ai';
  return 'action'; // All service integrations (Slack, Postgres, Shopify, etc.) fall here
}

/** A node is a trigger if its type ends with Trigger, or is one of the known core triggers. */
export function isTriggerNode(node: N8nNode): boolean {
  const t = node.type;
  // Pattern: any type ending in "Trigger" (covers all 100+ service triggers)
  if (/Trigger$/i.test(t)) return true;
  // Core trigger types without "Trigger" in name
  if (t === 'n8n-nodes-base.webhook') return true;
  if (t === 'n8n-nodes-base.cron') return true;
  if (t === 'n8n-nodes-base.emailReadImap') return true;
  if (t === 'n8n-nodes-base.sseTrigger') return true;
  return false;
}

export function isAiNode(node: N8nNode): boolean {
  return node.type.startsWith('@n8n/n8n-nodes-langchain.')
    || node.type.includes('langchain');
}

// ── Framework role classification ────────────────────────────────────────

function classifyWorkflowRole(workflow: N8nWorkflow): string {
  const hasAi = workflow.nodes.some(isAiNode);
  const hasTrigger = workflow.nodes.some(isTriggerNode);
  const hasWebhook = workflow.nodes.some((n) => n.type === 'n8n-nodes-base.webhook');
  const hasSchedule = workflow.nodes.some((n) =>
    n.type === 'n8n-nodes-base.scheduleTrigger' || n.type === 'n8n-nodes-base.cron',
  );
  const isErrorHandler = workflow.nodes.some((n) => n.type === 'n8n-nodes-base.errorTrigger');
  const isSubWorkflow = workflow.nodes.some((n) =>
    n.type === 'n8n-nodes-base.executeWorkflowTrigger' || n.type === 'n8n-nodes-base.workflowTrigger',
  );

  if (isErrorHandler) return 'n8n_error_workflow';
  if (hasAi) return 'n8n_ai_workflow';
  if (isSubWorkflow) return 'n8n_subworkflow';
  if (hasWebhook) return 'n8n_webhook_workflow';
  if (hasSchedule) return 'n8n_scheduled_workflow';
  if (hasTrigger) return 'n8n_triggered_workflow';
  return 'n8n_workflow';
}

// ── Parsing ──────────────────────────────────────────────────────────────

export function parseN8nWorkflow(content: Buffer): N8nWorkflow | null {
  try {
    const json = JSON.parse(content.toString('utf-8'));
    if (json && Array.isArray(json.nodes) && json.connections && typeof json.connections === 'object') {
      return json as N8nWorkflow;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Connection extraction ────────────────────────────────────────────────

export function extractConnections(workflow: N8nWorkflow): N8nConnection[] {
  const connections: N8nConnection[] = [];
  for (const [sourceName, outputs] of Object.entries(workflow.connections)) {
    for (const [connType, outputConns] of Object.entries(outputs)) {
      for (let outputIdx = 0; outputIdx < outputConns.length; outputIdx++) {
        const targets = outputConns[outputIdx];
        if (!targets) continue;
        for (const target of targets) {
          connections.push({
            sourceNode: sourceName,
            sourceOutput: outputIdx,
            targetNode: target.node,
            targetInput: target.index,
            connectionType: connType,
          });
        }
      }
    }
  }
  return connections;
}

// ── Trigger extraction ───────────────────────────────────────────────────

export function extractTriggers(workflow: N8nWorkflow): N8nNode[] {
  return workflow.nodes.filter(isTriggerNode);
}

// ── Route extraction (webhooks, schedules, forms, workflow triggers) ─────

export function extractRoutes(workflow: N8nWorkflow): RawRoute[] {
  const routes: RawRoute[] = [];
  for (const node of workflow.nodes) {
    if (node.disabled) continue;

    // Webhook endpoints
    if (node.type === 'n8n-nodes-base.webhook' && node.parameters) {
      const webhookPath = (node.parameters.path as string) ?? '/';
      const method = ((node.parameters.httpMethod as string) ?? 'GET').toUpperCase();
      routes.push({
        method,
        uri: webhookPath.startsWith('/') ? webhookPath : `/${webhookPath}`,
        name: node.name,
        metadata: { n8nNodeType: node.type, webhookId: node.webhookId },
      });
    }

    // Form trigger endpoints
    if (node.type === 'n8n-nodes-base.formTrigger' && node.parameters) {
      const formPath = (node.parameters.path as string) ?? (node.parameters.formTitle as string) ?? '/form';
      routes.push({
        method: 'FORM',
        uri: formPath.startsWith('/') ? formPath : `/${formPath}`,
        name: node.name,
        metadata: { n8nNodeType: node.type },
      });
    }

    // Schedule triggers as CRON routes
    if ((node.type === 'n8n-nodes-base.scheduleTrigger' || node.type === 'n8n-nodes-base.cron') && node.parameters) {
      const rule = node.parameters.rule as Record<string, unknown> | undefined;
      const cronExpr = (node.parameters.cronExpression as string)
        ?? (rule ? JSON.stringify(rule) : 'schedule');
      routes.push({
        method: 'CRON',
        uri: cronExpr,
        name: node.name,
        metadata: { n8nNodeType: node.type },
      });
    }

    // Sub-workflow entry points
    if (node.type === 'n8n-nodes-base.executeWorkflowTrigger' || node.type === 'n8n-nodes-base.workflowTrigger') {
      routes.push({
        method: 'WORKFLOW',
        uri: `trigger:${node.name}`,
        name: node.name,
        metadata: { n8nNodeType: node.type },
      });
    }

    // Chat/MCP triggers
    if (node.type === '@n8n/n8n-nodes-langchain.chatTrigger'
      || node.type === '@n8n/n8n-nodes-langchain.manualChatTrigger') {
      routes.push({
        method: 'CHAT',
        uri: `/chat/${node.name.replace(/\s+/g, '-').toLowerCase()}`,
        name: node.name,
        metadata: { n8nNodeType: node.type },
      });
    }

    if (node.type === '@n8n/n8n-nodes-langchain.mcpTrigger') {
      routes.push({
        method: 'MCP',
        uri: `/mcp/${node.name.replace(/\s+/g, '-').toLowerCase()}`,
        name: node.name,
        metadata: { n8nNodeType: node.type },
      });
    }
  }
  return routes;
}

// ── Code node extraction ─────────────────────────────────────────────────

export function extractCodeNodes(workflow: N8nWorkflow): Array<{
  node: N8nNode;
  code: string;
  language: string;
  nodeDeps: string[];
}> {
  const results: Array<{ node: N8nNode; code: string; language: string; nodeDeps: string[] }> = [];
  for (const node of workflow.nodes) {
    if (!CODE_TYPES.has(node.type) || !node.parameters) continue;
    const code = (node.parameters.jsCode as string)
      ?? (node.parameters.functionCode as string)
      ?? (node.parameters.code as string)
      ?? (node.parameters.pythonCode as string)
      ?? '';
    if (!code.trim()) continue;

    const lang = (node.parameters.language as string) ?? 'javascript';
    const deps = new Set<string>();
    extractExpressionDeps(code, deps);
    results.push({ node, code, language: lang, nodeDeps: [...deps] });
  }
  return results;
}

// ── Sub-workflow extraction ──────────────────────────────────────────────

export function extractSubWorkflowCalls(workflow: N8nWorkflow): Array<{
  node: N8nNode;
  workflowId: string;
  source: 'id' | 'expression';
}> {
  const calls: Array<{ node: N8nNode; workflowId: string; source: 'id' | 'expression' }> = [];
  for (const node of workflow.nodes) {
    if (!SUBWORKFLOW_TYPES.has(node.type) || !node.parameters) continue;

    const rawId = node.parameters.workflowId;
    let wfId = '';
    let source: 'id' | 'expression' = 'id';

    if (typeof rawId === 'string') {
      wfId = rawId;
    } else if (rawId && typeof rawId === 'object') {
      const obj = rawId as Record<string, unknown>;
      wfId = (obj.value as string) ?? '';
      if (obj.__rl === true && obj.mode === 'expression') source = 'expression';
    }

    if (wfId) calls.push({ node, workflowId: wfId, source });
  }
  return calls;
}

// ── HTTP request extraction ──────────────────────────────────────────────

export function extractHttpRequests(workflow: N8nWorkflow): Array<{
  node: N8nNode;
  url: string;
  method: string;
  authentication?: string;
}> {
  const requests: Array<{ node: N8nNode; url: string; method: string; authentication?: string }> = [];
  for (const node of workflow.nodes) {
    if (!HTTP_REQUEST_TYPES.has(node.type) || !node.parameters) continue;
    const url = (node.parameters.url as string) ?? '';
    const method = ((node.parameters.method as string)
      ?? (node.parameters.requestMethod as string)
      ?? 'GET').toUpperCase();
    if (!url) continue;

    const authentication = node.parameters.authentication as string | undefined;
    requests.push({ node, url, method, ...(authentication ? { authentication } : {}) });
  }
  return requests;
}

// ── Sticky notes extraction ──────────────────────────────────────────────

export function extractStickyNotes(workflow: N8nWorkflow): Array<{
  node: N8nNode;
  content: string;
  width?: number;
  height?: number;
  color?: number;
}> {
  const notes: Array<{ node: N8nNode; content: string; width?: number; height?: number; color?: number }> = [];
  for (const node of workflow.nodes) {
    if (node.type !== STICKY_NOTE_TYPE || !node.parameters) continue;
    const content = (node.parameters.content as string) ?? '';
    if (!content.trim()) continue;
    notes.push({
      node,
      content,
      width: node.parameters.width as number | undefined,
      height: node.parameters.height as number | undefined,
      color: node.color ?? (node.parameters.color as number | undefined),
    });
  }
  return notes;
}

// ── AI node extraction ───────────────────────────────────────────────────

export type AiNodeRole = 'agent' | 'chain' | 'llm' | 'embedding' | 'memory'
  | 'vector_store' | 'retriever' | 'tool' | 'output_parser' | 'document_loader'
  | 'text_splitter' | 'reranker' | 'standalone';

export function classifyAiNode(nodeType: string): AiNodeRole {
  const t = nodeType.replace('@n8n/n8n-nodes-langchain.', '');
  if (t.startsWith('agent') || t === 'agent') return 'agent';
  if (t.startsWith('chain')) return 'chain';
  if (t.startsWith('lm') || t.startsWith('lmChat')) return 'llm';
  if (t.startsWith('embeddings')) return 'embedding';
  if (t.startsWith('memory')) return 'memory';
  if (t.startsWith('vectorStore')) return 'vector_store';
  if (t.startsWith('retriever')) return 'retriever';
  if (t.startsWith('tool') || t.endsWith('Tool')) return 'tool';
  if (t.startsWith('outputParser')) return 'output_parser';
  if (t.startsWith('document')) return 'document_loader';
  if (t.startsWith('textSplitter')) return 'text_splitter';
  if (t.startsWith('reranker')) return 'reranker';
  return 'standalone';
}

export function extractAiNodes(workflow: N8nWorkflow): Array<{
  node: N8nNode;
  role: AiNodeRole;
  model?: string;
}> {
  const results: Array<{ node: N8nNode; role: AiNodeRole; model?: string }> = [];
  for (const node of workflow.nodes) {
    if (!isAiNode(node)) continue;
    const role = classifyAiNode(node.type);
    let model: string | undefined;
    if (node.parameters) {
      model = (node.parameters.model as string)
        ?? (node.parameters.modelId as string)
        ?? (node.parameters.modelName as string)
        ?? undefined;
    }
    results.push({ node, role, ...(model ? { model } : {}) });
  }
  return results;
}

// ── Expression dependency extraction (workflow-wide) ─────────────────────

export function extractAllExpressionDeps(workflow: N8nWorkflow): Map<string, Set<string>> {
  const nodeDeps = new Map<string, Set<string>>();
  for (const node of workflow.nodes) {
    if (!node.parameters) continue;
    const deps = new Set<string>();
    extractExpressionDeps(node.parameters, deps);
    // Remove self-references
    deps.delete(node.name);
    if (deps.size > 0) {
      nodeDeps.set(node.name, deps);
    }
  }
  return nodeDeps;
}

// ── Credential extraction (full details) ─────────────────────────────────

export interface CredentialUsage {
  node: N8nNode;
  credentialType: string;
  credentialId: string | null;
  credentialName: string;
}

export function extractCredentialUsages(workflow: N8nWorkflow): CredentialUsage[] {
  const usages: CredentialUsage[] = [];
  for (const node of workflow.nodes) {
    if (!node.credentials) continue;
    for (const [credType, credRef] of Object.entries(node.credentials)) {
      const ref = credRef as N8nCredentialRef | undefined;
      usages.push({
        node,
        credentialType: credType,
        credentialId: ref?.id ?? null,
        credentialName: ref?.name ?? credType,
      });
    }
  }
  return usages;
}

// ── Flow control analysis ────────────────────────────────────────────────

export interface FlowControlInfo {
  node: N8nNode;
  controlType: 'conditional' | 'switch' | 'merge' | 'loop' | 'wait' | 'filter' | 'respond' | 'other';
  outputCount?: number;
  mergeMode?: string;
  batchSize?: number;
}

export function extractFlowControl(workflow: N8nWorkflow, connections: N8nConnection[]): FlowControlInfo[] {
  const results: FlowControlInfo[] = [];
  for (const node of workflow.nodes) {
    if (!FLOW_CONTROL_TYPES.has(node.type)) continue;

    const outputs = connections.filter((c) => c.sourceNode === node.name);
    const maxOutput = outputs.reduce((max, c) => Math.max(max, c.sourceOutput), -1);

    let controlType: FlowControlInfo['controlType'] = 'other';
    let mergeMode: string | undefined;
    let batchSize: number | undefined;

    switch (node.type) {
      case 'n8n-nodes-base.if':
        controlType = 'conditional';
        break;
      case 'n8n-nodes-base.switch':
        controlType = 'switch';
        break;
      case 'n8n-nodes-base.merge':
        controlType = 'merge';
        mergeMode = (node.parameters?.mode as string) ?? 'append';
        break;
      case 'n8n-nodes-base.splitInBatches':
        controlType = 'loop';
        batchSize = (node.parameters?.batchSize as number) ?? 10;
        break;
      case 'n8n-nodes-base.wait':
        controlType = 'wait';
        break;
      case 'n8n-nodes-base.filter':
      case 'n8n-nodes-base.limit':
        controlType = 'filter';
        break;
      case 'n8n-nodes-base.respondToWebhook':
        controlType = 'respond';
        break;
    }

    results.push({
      node,
      controlType,
      outputCount: maxOutput + 1,
      ...(mergeMode ? { mergeMode } : {}),
      ...(batchSize ? { batchSize } : {}),
    });
  }
  return results;
}

// ── Plugin ───────────────────────────────────────────────────────────────

export class N8nPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'n8n',
    version: '2.0.0',
    priority: 30,
    category: 'tooling',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    if (ctx.packageJson) {
      const deps = {
        ...(ctx.packageJson.dependencies as Record<string, string> | undefined),
        ...(ctx.packageJson.devDependencies as Record<string, string> | undefined),
      };
      if (Object.keys(deps).some((k) =>
        k.startsWith('n8n-nodes') || k === 'n8n-workflow' || k === 'n8n-core',
      )) {
        return true;
      }
    }

    try {
      if (fs.existsSync(path.join(ctx.rootPath, '.n8n'))) return true;
    } catch { /* ignore */ }

    // Check for *.node.ts files (custom node development)
    const nodeDirs = ['nodes', 'src/nodes'];
    for (const dir of nodeDirs) {
      try {
        const fullDir = path.join(ctx.rootPath, dir);
        if (fs.existsSync(fullDir) && fs.statSync(fullDir).isDirectory()) {
          const files = collectNodeFiles(fullDir);
          if (files.length > 0) return true;
        }
      } catch { /* ignore */ }
    }

    const searchDirs = ['workflows', 'n8n', '.n8n', '.'];
    for (const dir of searchDirs) {
      try {
        const fullDir = path.join(ctx.rootPath, dir);
        if (!fs.existsSync(fullDir) || !fs.statSync(fullDir).isDirectory()) continue;
        const files = fs.readdirSync(fullDir).filter((f) => f.endsWith('.json'));
        for (const file of files.slice(0, 5)) {
          try {
            const content = fs.readFileSync(path.join(fullDir, file));
            if (parseN8nWorkflow(content)) return true;
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }

    return ctx.configFiles.some(
      (f) => f.includes('n8n') || f.includes('.n8n'),
    );
  }

  registerSchema() {
    return {
      nodeTypes: [
        { name: 'n8n_workflow' },
        { name: 'n8n_node' },
        { name: 'n8n_trigger' },
        { name: 'n8n_webhook' },
        { name: 'n8n_code_node' },
        { name: 'n8n_subworkflow_call' },
        { name: 'n8n_ai_node' },
        { name: 'n8n_flow_control' },
        { name: 'n8n_data_transform' },
        { name: 'n8n_sticky_note' },
      ],
      edgeTypes: [
        { name: 'n8n_connection', category: 'n8n', description: 'Data flow between workflow nodes' },
        { name: 'n8n_ai_connection', category: 'n8n', description: 'AI/LangChain typed connection (model, tool, memory, etc.)' },
        { name: 'n8n_error_connection', category: 'n8n', description: 'Error output branch connection' },
        { name: 'n8n_triggers', category: 'n8n', description: 'Trigger initiates workflow execution' },
        { name: 'n8n_webhook_route', category: 'n8n', description: 'Webhook endpoint exposed by workflow' },
        { name: 'n8n_calls_subworkflow', category: 'n8n', description: 'Node invokes another workflow' },
        { name: 'n8n_http_request', category: 'n8n', description: 'HTTP request to external service' },
        { name: 'n8n_uses_credential', category: 'n8n', description: 'Node references a credential' },
        { name: 'n8n_expression_dep', category: 'n8n', description: 'Implicit data dependency via expression ($node["Name"])' },
        { name: 'n8n_error_workflow', category: 'n8n', description: 'Workflow-level error handler reference' },
        { name: 'n8n_conditional_branch', category: 'n8n', description: 'Conditional branch output (IF true/false, Switch cases)' },
        { name: 'n8n_external_service', category: 'n8n', description: 'Node connects to an external service (database, API, SaaS)' },
        { name: 'n8n_shared_credential', category: 'n8n', description: 'Workflows coupled by shared credential usage' },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (language !== 'json' && !filePath.endsWith('.json')) {
      return ok({ status: 'ok', symbols: [] });
    }

    const workflow = parseN8nWorkflow(content);
    if (!workflow) {
      return ok({ status: 'ok', symbols: [] });
    }

    const connections = extractConnections(workflow);
    const role = classifyWorkflowRole(workflow);
    const tags = Array.isArray(workflow.tags)
      ? workflow.tags.map((t) => (typeof t === 'string' ? t : t.name))
      : [];
    const stickyNotes = extractStickyNotes(workflow);

    const result: FileParseResult = {
      status: 'ok',
      symbols: [],
      edges: [],
      routes: [],
      frameworkRole: role,
      metadata: {
        workflowName: workflow.name ?? path.basename(filePath, '.json'),
        workflowId: workflow.id,
        active: workflow.active ?? false,
        nodeCount: workflow.nodes.length,
        tags,
        settings: workflow.settings ?? {},
        hasPinData: !!(workflow.pinData && Object.keys(workflow.pinData).length > 0),
        hasStaticData: !!(workflow.staticData && Object.keys(workflow.staticData).length > 0),
        templateId: workflow.meta?.templateId,
        stickyNoteCount: stickyNotes.length,
        stickyNotes: stickyNotes.map((s) => ({
          name: s.node.name,
          content: s.content.slice(0, 500),
        })),
      },
    };

    const source = content.toString('utf-8');
    const nodeNameSet = new Set(workflow.nodes.map((n) => n.name));

    // ── Symbols: one per workflow node ──
    for (const node of workflow.nodes) {
      if (node.type === STICKY_NOTE_TYPE) continue; // skip stickies as symbols

      const category = classifyNode(node);
      const byteStart = findNodeByteOffset(source, node.name);
      const byteEnd = byteStart >= 0 ? byteStart + node.name.length + 10 : 0;

      const errorHandling: Record<string, unknown> = {};
      if (node.onError) errorHandling.onError = node.onError;
      if (node.continueOnFail) errorHandling.continueOnFail = true;
      if (node.retryOnFail) {
        errorHandling.retryOnFail = true;
        if (node.maxTries) errorHandling.maxTries = node.maxTries;
        if (node.waitBetweenTries) errorHandling.waitBetweenTries = node.waitBetweenTries;
      }

      const meta: Record<string, unknown> = {
        n8nNodeType: node.type,
        n8nNodeId: node.id ?? node.name,
        category,
        isDisabled: node.disabled ?? false,
        typeVersion: node.typeVersion,
        position: node.position,
      };

      if (Object.keys(errorHandling).length > 0) meta.errorHandling = errorHandling;
      if (node.notes) meta.notes = node.notes;
      if (node.credentials) {
        meta.credentials = Object.entries(node.credentials).map(([type, ref]) => ({
          type,
          id: (ref as N8nCredentialRef)?.id,
          name: (ref as N8nCredentialRef)?.name,
        }));
      }
      if (node.alwaysOutputData) meta.alwaysOutputData = true;
      if (node.executeOnce) meta.executeOnce = true;
      if (node.webhookId) meta.webhookId = node.webhookId;

      // AI-specific metadata
      if (isAiNode(node)) {
        meta.aiRole = classifyAiNode(node.type);
        if (node.parameters) {
          const model = (node.parameters.model as string)
            ?? (node.parameters.modelId as string)
            ?? (node.parameters.modelName as string);
          if (model) meta.aiModel = model;
        }
      }

      // Flow control metadata
      if (FLOW_CONTROL_TYPES.has(node.type)) {
        const nodeConns = connections.filter((c) => c.sourceNode === node.name);
        const maxOutput = nodeConns.reduce((max, c) => Math.max(max, c.sourceOutput), -1);
        meta.outputCount = maxOutput + 1;
        if (node.type === 'n8n-nodes-base.merge' && node.parameters) {
          meta.mergeMode = (node.parameters.mode as string) ?? 'append';
        }
        if (node.type === 'n8n-nodes-base.splitInBatches' && node.parameters) {
          meta.batchSize = (node.parameters.batchSize as number) ?? 10;
        }
      }

      // Service domain for external dependency tracking
      const domain = getServiceDomain(node.type);
      if (domain) meta.serviceDomain = domain;

      const symbol: RawSymbol = {
        symbolId: `${filePath}::${node.name}#constant`,
        name: node.name,
        kind: 'constant',
        signature: `[n8n:${node.type}${node.typeVersion ? '@' + node.typeVersion : ''}] ${node.name}`,
        byteStart: Math.max(byteStart, 0),
        byteEnd: Math.max(byteEnd, 0),
        metadata: meta,
      };
      result.symbols.push(symbol);
    }

    // ── Edges: typed connections ──
    for (const conn of connections) {
      if (!nodeNameSet.has(conn.sourceNode) || !nodeNameSet.has(conn.targetNode)) continue;
      // Skip sticky note connections (shouldn't exist but be safe)
      const srcNode = workflow.nodes.find((n) => n.name === conn.sourceNode);
      if (srcNode?.type === STICKY_NOTE_TYPE) continue;

      const isAiConn = AI_CONNECTION_TYPES.has(conn.connectionType);
      let edgeType = 'n8n_connection';

      if (isAiConn) {
        edgeType = 'n8n_ai_connection';
      }

      result.edges!.push({
        sourceSymbolId: `${filePath}::${conn.sourceNode}#constant`,
        targetSymbolId: `${filePath}::${conn.targetNode}#constant`,
        edgeType,
        metadata: {
          sourceOutput: conn.sourceOutput,
          targetInput: conn.targetInput,
          connectionType: conn.connectionType,
          ...(isAiConn ? { aiConnectionType: conn.connectionType } : {}),
        },
      });
    }

    // ── Edges: conditional branch labeling ──
    for (const node of workflow.nodes) {
      if (node.type === 'n8n-nodes-base.if') {
        const nodeConns = connections.filter(
          (c) => c.sourceNode === node.name && c.connectionType === 'main',
        );
        for (const conn of nodeConns) {
          result.edges!.push({
            sourceSymbolId: `${filePath}::${node.name}#constant`,
            targetSymbolId: `${filePath}::${conn.targetNode}#constant`,
            edgeType: 'n8n_conditional_branch',
            metadata: {
              branch: conn.sourceOutput === 0 ? 'true' : 'false',
              outputIndex: conn.sourceOutput,
            },
          });
        }
      } else if (node.type === 'n8n-nodes-base.switch') {
        const nodeConns = connections.filter(
          (c) => c.sourceNode === node.name && c.connectionType === 'main',
        );
        for (const conn of nodeConns) {
          result.edges!.push({
            sourceSymbolId: `${filePath}::${node.name}#constant`,
            targetSymbolId: `${filePath}::${conn.targetNode}#constant`,
            edgeType: 'n8n_conditional_branch',
            metadata: {
              branch: `case_${conn.sourceOutput}`,
              outputIndex: conn.sourceOutput,
            },
          });
        }
      }
    }

    // ── Edges: trigger → first connected nodes ──
    const triggers = extractTriggers(workflow);
    for (const trigger of triggers) {
      const triggerConns = connections.filter((c) => c.sourceNode === trigger.name);
      for (const conn of triggerConns) {
        result.edges!.push({
          sourceSymbolId: `${filePath}::${trigger.name}#constant`,
          targetSymbolId: `${filePath}::${conn.targetNode}#constant`,
          edgeType: 'n8n_triggers',
          metadata: { triggerType: trigger.type },
        });
      }
    }

    // ── Routes: all discoverable endpoints ──
    result.routes = extractRoutes(workflow);

    // ── Edges: sub-workflow calls ──
    const subWorkflowCalls = extractSubWorkflowCalls(workflow);
    for (const call of subWorkflowCalls) {
      result.edges!.push({
        sourceSymbolId: `${filePath}::${call.node.name}#constant`,
        edgeType: 'n8n_calls_subworkflow',
        metadata: { targetWorkflowId: call.workflowId, source: call.source },
      });
    }

    // ── Edges: HTTP requests ──
    const httpRequests = extractHttpRequests(workflow);
    for (const req of httpRequests) {
      result.edges!.push({
        sourceSymbolId: `${filePath}::${req.node.name}#constant`,
        edgeType: 'n8n_http_request',
        metadata: {
          url: req.url,
          method: req.method,
          ...(req.authentication ? { authentication: req.authentication } : {}),
        },
      });
    }

    // ── Edges: credential references (full detail) ──
    const credUsages = extractCredentialUsages(workflow);
    for (const usage of credUsages) {
      result.edges!.push({
        sourceSymbolId: `${filePath}::${usage.node.name}#constant`,
        edgeType: 'n8n_uses_credential',
        metadata: {
          credentialType: usage.credentialType,
          credentialId: usage.credentialId,
          credentialName: usage.credentialName,
        },
      });
    }

    // ── Edges: external service dependencies ──
    const serviceDomainSet = new Set<string>();
    for (const node of workflow.nodes) {
      const domain = getServiceDomain(node.type);
      if (domain) {
        serviceDomainSet.add(domain);
        result.edges!.push({
          sourceSymbolId: `${filePath}::${node.name}#constant`,
          edgeType: 'n8n_external_service',
          metadata: { serviceDomain: domain, service: node.type.replace(/^n8n-nodes-base\./, '') },
        });
      }
    }
    if (serviceDomainSet.size > 0) {
      result.metadata!.serviceDomains = [...serviceDomainSet].sort();
    }

    // ── Edges: expression-based data dependencies ──
    const exprDeps = extractAllExpressionDeps(workflow);
    for (const [nodeName, deps] of exprDeps) {
      for (const dep of deps) {
        if (!nodeNameSet.has(dep)) continue;
        result.edges!.push({
          sourceSymbolId: `${filePath}::${dep}#constant`,
          targetSymbolId: `${filePath}::${nodeName}#constant`,
          edgeType: 'n8n_expression_dep',
          metadata: { referencedNode: dep },
        });
      }
    }

    // ── Metadata: expression info (envVars, usesExecution, usesBinary) ──
    const exprInfo = extractWorkflowExpressionInfo(workflow);
    if (exprInfo.envVars.size > 0) result.metadata!.envVars = [...exprInfo.envVars];
    if (exprInfo.usesExecution) result.metadata!.usesExecution = true;
    if (exprInfo.usesBinary) result.metadata!.usesBinary = true;

    // ── Metadata: workflow complexity ──
    result.metadata!.complexity = computeWorkflowComplexity(workflow);

    // ── Metadata: disconnected nodes ──
    const disconnected = findDisconnectedNodes(workflow, connections);
    if (disconnected.length > 0) {
      result.metadata!.disconnectedNodes = disconnected.map((n) => n.name);
    }

    // ── Edges: workflow-level error workflow reference ──
    if (workflow.settings?.errorWorkflow) {
      result.edges!.push({
        edgeType: 'n8n_error_workflow',
        metadata: {
          sourceWorkflow: workflow.name ?? filePath,
          targetWorkflowId: workflow.settings.errorWorkflow,
        },
      });
    }

    return ok(result);
  }

  resolveEdges(ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    const edges: RawEdge[] = [];

    const allFiles = ctx.getAllFiles();
    const workflowFiles = allFiles.filter((f) => f.path.endsWith('.json'));

    // Build maps for cross-file resolution
    const workflowByName = new Map<string, { fileId: number; path: string }>();
    const workflowById = new Map<string, { fileId: number; path: string }>();
    const credentialUsers = new Map<string, Array<{ fileId: number; path: string; nodeName: string }>>();

    for (const file of workflowFiles) {
      const content = ctx.readFile(file.path);
      if (!content) continue;
      const wf = parseN8nWorkflow(Buffer.from(content));
      if (!wf) continue;

      if (wf.name) workflowByName.set(wf.name, { fileId: file.id, path: file.path });
      if (wf.id) workflowById.set(wf.id, { fileId: file.id, path: file.path });

      // Track credential usage across workflows
      const creds = extractCredentialUsages(wf);
      for (const cred of creds) {
        if (!cred.credentialId) continue;
        const key = `${cred.credentialType}:${cred.credentialId}`;
        if (!credentialUsers.has(key)) credentialUsers.set(key, []);
        credentialUsers.get(key)!.push({ fileId: file.id, path: file.path, nodeName: cred.node.name });
      }
    }

    // Resolve sub-workflow + error-workflow edges
    for (const file of workflowFiles) {
      const content = ctx.readFile(file.path);
      if (!content) continue;
      const wf = parseN8nWorkflow(Buffer.from(content));
      if (!wf) continue;

      // Sub-workflow resolution
      const calls = extractSubWorkflowCalls(wf);
      for (const call of calls) {
        const target = workflowByName.get(call.workflowId) ?? workflowById.get(call.workflowId);
        if (!target) continue;

        const symbols = ctx.getSymbolsByFile(target.fileId);
        if (symbols.length > 0) {
          edges.push({
            sourceSymbolId: `${file.path}::${call.node.name}#constant`,
            targetSymbolId: symbols[0].symbolId,
            edgeType: 'n8n_calls_subworkflow',
            resolved: true,
            metadata: {
              targetWorkflowId: call.workflowId,
              targetFile: target.path,
              source: call.source,
            },
          });
        }
      }

      // Error workflow resolution
      if (wf.settings?.errorWorkflow) {
        const target = workflowById.get(wf.settings.errorWorkflow)
          ?? workflowByName.get(wf.settings.errorWorkflow);
        if (target) {
          const symbols = ctx.getSymbolsByFile(target.fileId);
          if (symbols.length > 0) {
            edges.push({
              sourceSymbolId: `${file.path}::${wf.nodes[0]?.name}#constant`,
              targetSymbolId: symbols[0].symbolId,
              edgeType: 'n8n_error_workflow',
              resolved: true,
              metadata: {
                sourceWorkflow: wf.name ?? file.path,
                targetWorkflowId: wf.settings.errorWorkflow,
                targetFile: target.path,
              },
            });
          }
        }
      }
    }

    // ── Shared credential edges ──
    for (const [credKey, users] of credentialUsers) {
      if (users.length < 2) continue;
      // Group by file path
      const byFile = new Map<string, Array<{ fileId: number; path: string; nodeName: string }>>();
      for (const u of users) {
        if (!byFile.has(u.path)) byFile.set(u.path, []);
        byFile.get(u.path)!.push(u);
      }
      const filePaths = [...byFile.keys()];
      if (filePaths.length < 2) continue;
      const [credType, credId] = credKey.split(':');
      // Emit edge between first user in each file pair
      for (let i = 0; i < filePaths.length; i++) {
        for (let j = i + 1; j < filePaths.length; j++) {
          const userA = byFile.get(filePaths[i])![0];
          const userB = byFile.get(filePaths[j])![0];
          edges.push({
            sourceSymbolId: `${userA.path}::${userA.nodeName}#constant`,
            targetSymbolId: `${userB.path}::${userB.nodeName}#constant`,
            edgeType: 'n8n_shared_credential',
            resolved: true,
            metadata: {
              credentialType: credType,
              credentialId: credId,
              sourceFile: userA.path,
              targetFile: userB.path,
            },
          });
        }
      }
    }

    return ok(edges);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function findNodeByteOffset(source: string, nodeName: string): number {
  const escaped = nodeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`"name"\\s*:\\s*"${escaped}"`);
  const m = re.exec(source);
  return m ? m.index : -1;
}

/** Extract content of a balanced bracket pair starting at `start` (which should be '[' or '{'). */
function extractBalancedBracket(source: string, start: number): string | null {
  if (start < 0 || start >= source.length) return null;
  const open = source[start];
  const close = open === '[' ? ']' : open === '{' ? '}' : null;
  if (!close) return null;
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === open) depth++;
    else if (source[i] === close) {
      depth--;
      if (depth === 0) return source.slice(start + 1, i);
    }
  }
  return null;
}
