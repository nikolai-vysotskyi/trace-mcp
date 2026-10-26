import { describe, expect, it } from 'vitest';
import {
  Boto3Plugin,
  classifyOperation,
  extractBoto3Calls,
  extractEnvVarNames,
  toPascalCase,
} from '../../../src/indexer/plugins/integration/tooling/boto3/index.js';
import type { ProjectContext } from '../../../src/plugin-api/types.js';

function pyProject(requirementsTxt: string): ProjectContext {
  return { rootPath: '/nonexistent', requirementsTxt } as ProjectContext;
}

async function extract(code: string, filePath = 'app/main.py', language = 'python') {
  const plugin = new Boto3Plugin();
  const r = await plugin.extractNodes(filePath, Buffer.from(code), language);
  if (!r.isOk()) throw new Error(JSON.stringify(r._unsafeUnwrapErr()));
  return r._unsafeUnwrap();
}

describe('Boto3Plugin Helpers', () => {
  it('converts snake_case methods to AWS PascalCase operations', () => {
    expect(toPascalCase('get_object')).toBe('GetObject');
    expect(toPascalCase('put_object')).toBe('PutObject');
    expect(toPascalCase('list_objects_v2')).toBe('ListObjectsV2');
    expect(toPascalCase('get_parameter')).toBe('GetParameter');
    expect(toPascalCase('get_parameters_by_path')).toBe('GetParametersByPath');
    expect(toPascalCase('start_job_run')).toBe('StartJobRun');
    expect(toPascalCase('invoke')).toBe('Invoke');
    expect(toPascalCase('send_message')).toBe('SendMessage');
  });

  it('classifies operations correctly into read, write, delete, list', () => {
    expect(classifyOperation('get_object')).toBe('read');
    expect(classifyOperation('head_bucket')).toBe('read');
    expect(classifyOperation('describe_jobs')).toBe('read');
    expect(classifyOperation('list_objects_v2')).toBe('list');
    expect(classifyOperation('put_object')).toBe('write');
    expect(classifyOperation('start_job_run')).toBe('write');
    expect(classifyOperation('invoke')).toBe('write');
    expect(classifyOperation('delete_object')).toBe('delete');
    expect(classifyOperation('abort_multipart_upload')).toBe('delete');
  });

  it('extracts env var names without saving any values', () => {
    const code = `
      region = os.getenv("AWS_REGION")
      bucket = os.environ.get("S3_BUCKET_NAME")
      key = os.environ["OBJECT_KEY"]
    `;
    const names = extractEnvVarNames(code);
    expect(names).toEqual(['AWS_REGION', 'S3_BUCKET_NAME', 'OBJECT_KEY']);
  });
});

describe('Boto3Plugin Manifest and Detection', () => {
  const plugin = new Boto3Plugin();

  it('declares correct manifest', () => {
    expect(plugin.manifest.name).toBe('boto3');
    expect(plugin.manifest.category).toBe('tooling');
    expect(plugin.manifest.priority).toBe(40);
  });

  it('registers edge types in schema', () => {
    const schema = plugin.registerSchema();
    const names = schema.edgeTypes.map((e) => e.name);
    expect(names).toContain('aws_call');
    expect(names).toContain('aws_client');
  });

  it('detects boto3 or botocore in requirements.txt', () => {
    expect(plugin.detect(pyProject('boto3==1.35.36'))).toBe(true);
    expect(plugin.detect(pyProject('botocore>=1.35.0'))).toBe(true);
    expect(plugin.detect(pyProject('requests==2.31.0'))).toBe(false);
  });
});

describe('Boto3Plugin Node and Role Extraction', () => {
  it('skips non-Python files', async () => {
    const r = await extract('const s3 = boto3.client("s3");', 'app.ts', 'typescript');
    expect(r.symbols.length).toBe(0);
    expect(r.edges).toEqual([]);
    expect(r.frameworkRole).toBeUndefined();
  });

  it('tags boto3_client when client or session is created', async () => {
    const r = await extract(`
import boto3
s3 = boto3.client("s3")
`);
    expect(r.frameworkRole).toBe('boto3_client');
  });

  it('tags boto3_usage when boto3 is imported without creating clients in the file', async () => {
    const r = await extract(`
import boto3
from botocore.exceptions import ClientError

def handle_error(e):
    if isinstance(e, ClientError):
        pass
`);
    expect(r.frameworkRole).toBe('boto3_usage');
  });
});

describe('Boto3Plugin Direct AWS Call Extraction', () => {
  it('extracts S3 client calls with literal bucket and key', async () => {
    const code = `
import boto3

s3 = boto3.client('s3')

def fetch():
    return s3.get_object(Bucket="data-bucket", Key="users/123.json")

def upload(payload):
    s3.put_object(Bucket="data-bucket", Key="users/123.json", Body=payload)
`;
    const r = await extract(code);
    expect(r.edges).toHaveLength(2);

    const getCall = r.edges!.find((e) => e.metadata?.method === 'get_object');
    expect(getCall).toBeDefined();
    expect(getCall?.targetSymbolId).toBe('aws:s3:GetObject');
    expect(getCall?.metadata?.service).toBe('s3');
    expect(getCall?.metadata?.operation).toBe('GetObject');
    expect(getCall?.metadata?.op).toBe('read');
    expect(getCall?.metadata?.bucket).toBe('data-bucket');
    expect(getCall?.metadata?.key).toBe('users/123.json');
    expect(getCall?.metadata?.resource).toBe('data-bucket');
    expect(getCall?.metadata?.resourceType).toBe('bucket');

    const putCall = r.edges!.find((e) => e.metadata?.method === 'put_object');
    expect(putCall).toBeDefined();
    expect(putCall?.targetSymbolId).toBe('aws:s3:PutObject');
    expect(putCall?.metadata?.op).toBe('write');
    expect(r.symbols.map((symbol) => symbol.symbolId)).toContain('aws:s3:PutObject');
    expect(r.symbols.map((symbol) => symbol.symbolId)).toContain('aws:s3:GetObject');
  });

  it('extracts S3 resource Bucket and download_file calls', async () => {
    const code = `
import boto3

s3_res = boto3.resource('s3')

def sync_bucket():
    bucket = s3_res.Bucket('asset-store')
    bucket.upload_file('/tmp/local.png', 'images/logo.png')
`;
    const r = await extract(code);
    const uploadEdge = r.edges!.find((e) => e.metadata?.method === 'upload_file');
    expect(uploadEdge).toBeDefined();
    expect(uploadEdge?.targetSymbolId).toBe('aws:s3:UploadFile');
    expect(uploadEdge?.metadata?.service).toBe('s3');
  });

  it('extracts SSM Parameter Store calls with Name/Path and env vars', async () => {
    const code = `
import os
import boto3

ssm = boto3.client('ssm', region_name=os.getenv('AWS_REGION'))

def load_config():
    param = ssm.get_parameter(Name='/prod/analytics/dsn', WithDecryption=True)
    paths = ssm.get_parameters_by_path(Path='/prod/analytics', Recursive=True)
    return param
`;
    const r = await extract(code);
    expect(r.edges).toHaveLength(2);

    const getParam = r.edges!.find((e) => e.metadata?.method === 'get_parameter');
    expect(getParam).toBeDefined();
    expect(getParam?.targetSymbolId).toBe('aws:ssm:GetParameter');
    expect(getParam?.metadata?.service).toBe('ssm');
    expect(getParam?.metadata?.op).toBe('read');
    expect(getParam?.metadata?.parameter).toBe('/prod/analytics/dsn');
    expect(getParam?.metadata?.resource).toBe('/prod/analytics/dsn');
    expect(getParam?.metadata?.resourceType).toBe('parameter');
    expect(getParam?.metadata?.envVars).toContain('AWS_REGION');

    const byPath = r.edges!.find((e) => e.metadata?.method === 'get_parameters_by_path');
    expect(byPath).toBeDefined();
    expect(byPath?.targetSymbolId).toBe('aws:ssm:GetParametersByPath');
    expect(byPath?.metadata?.parameter).toBe('/prod/analytics');
  });

  it('extracts Glue job and crawler operations', async () => {
    const code = `
import boto3

glue = boto3.client('glue')

def run_pipeline():
    run_id = glue.start_job_run(JobName='nightly-customer-etl')
    status = glue.get_job_run(JobName='nightly-customer-etl', RunId=run_id['JobRunId'])
    return status
`;
    const r = await extract(code);
    expect(r.edges).toHaveLength(2);

    const startJob = r.edges!.find((e) => e.metadata?.method === 'start_job_run');
    expect(startJob).toBeDefined();
    expect(startJob?.targetSymbolId).toBe('aws:glue:StartJobRun');
    expect(startJob?.metadata?.service).toBe('glue');
    expect(startJob?.metadata?.op).toBe('write');
    expect(startJob?.metadata?.job).toBe('nightly-customer-etl');
    expect(startJob?.metadata?.resourceType).toBe('job');

    const getJob = r.edges!.find((e) => e.metadata?.method === 'get_job_run');
    expect(getJob).toBeDefined();
    expect(getJob?.targetSymbolId).toBe('aws:glue:GetJobRun');
    expect(getJob?.metadata?.op).toBe('read');
  });

  it('extracts Lambda invocation calls with FunctionName', async () => {
    const code = `
import boto3

client = boto3.client('lambda')

def trigger():
    client.invoke(FunctionName='image-resizer', Payload='{}')
`;
    const r = await extract(code);
    expect(r.edges).toHaveLength(1);
    const edge = r.edges![0];
    expect(edge.targetSymbolId).toBe('aws:lambda:Invoke');
    expect(edge.metadata?.service).toBe('lambda');
    expect(edge.metadata?.operation).toBe('Invoke');
    expect(edge.metadata?.op).toBe('write');
    expect(edge.metadata?.function).toBe('image-resizer');
    expect(edge.metadata?.resource).toBe('image-resizer');
    expect(edge.metadata?.resourceType).toBe('function');
  });

  it('extracts class instance clients (self.client)', async () => {
    const code = `
import boto3

class OrderService:
    def __init__(self):
        self.sqs = boto3.client('sqs')

    def enqueue(self, msg):
        self.sqs.send_message(QueueUrl='https://sqs.aws/orders', MessageBody=msg)
`;
    const r = await extract(code);
    expect(r.edges).toHaveLength(1);
    const edge = r.edges![0];
    expect(edge.targetSymbolId).toBe('aws:sqs:SendMessage');
    expect(edge.metadata?.service).toBe('sqs');
    expect(edge.metadata?.op).toBe('write');
    expect(edge.metadata?.queue).toBe('https://sqs.aws/orders');
  });

  it('handles session-based client creation', async () => {
    const code = `
import boto3

session = boto3.Session(region_name='eu-central-1')
secrets = session.client('secretsmanager')

def fetch_secret():
    return secrets.get_secret_value(SecretId='prod/api/token')
`;
    const r = await extract(code);
    expect(r.edges).toHaveLength(1);
    const edge = r.edges![0];
    expect(edge.targetSymbolId).toBe('aws:secretsmanager:GetSecretValue');
    expect(edge.metadata?.service).toBe('secretsmanager');
    expect(edge.metadata?.secret).toBe('prod/api/token');
  });

  it('handles botocore.session client creation', async () => {
    const code = `
import botocore.session

session = botocore.session.get_session()
s3 = session.create_client('s3')

def get_doc():
    return s3.get_object(Bucket='docs-bucket', Key='manual.pdf')
`;
    const r = await extract(code);
    expect(r.edges).toHaveLength(1);
    expect(r.edges![0].targetSymbolId).toBe('aws:s3:GetObject');
  });

  it('prevents false positives: untracked objects calling get_object do NOT emit edges', async () => {
    const code = `
class Repository:
    def __init__(self):
        self.db = LocalDb()

    def find(self):
        # Local non-boto method calls that share AWS method names
        obj = self.db.get_object("key")
        param = self.db.get_parameter("param")
        self.db.invoke("fn")
        return obj
`;
    const r = await extract(code);
    expect(r.edges).toHaveLength(0);
  });

  it('prevents false positives on unrelated classes reusing the same attribute name in the same file', async () => {
    const code = `
import boto3

class S3Writer:
    def __init__(self):
        self.s3 = boto3.client('s3')

    def write(self, bucket, key, body):
        self.s3.put_object(Bucket=bucket, Key=key, Body=body)

class CacheClient:
    """Unrelated in-memory cache wrapper — nothing to do with AWS."""
    def __init__(self, backend):
        self.s3 = backend

    def write(self, bucket, key, body):
        self.s3.put_object(Bucket=bucket, Key=key, Body=body)
`;
    const r = await extract(code);
    expect(r.edges).toHaveLength(1);
    expect(r.edges![0].targetSymbolId).toBe('aws:s3:PutObject');
    expect(r.edges![0].metadata?.line).toBe(9);
  });

  it('prevents false positives on unrelated functions reusing the same variable name in the same file', async () => {
    const code = `
import boto3

def sync_s3():
    client = boto3.client('s3')
    client.put_object(Bucket='my-bucket', Key='k')

def sync_cache():
    client = MemoryCache()
    client.put_object(Bucket='my-bucket', Key='k')
`;
    const r = await extract(code);
    expect(r.edges).toHaveLength(1);
    expect(r.edges![0].targetSymbolId).toBe('aws:s3:PutObject');
    expect(r.edges![0].metadata?.line).toBe(6);
  });
});
