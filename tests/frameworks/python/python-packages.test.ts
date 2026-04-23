import { describe, it, expect } from 'vitest';
import { PythonHttpClientsPlugin } from '../../../src/indexer/plugins/integration/tooling/python-http/index.js';
import { OpenAIPythonPlugin } from '../../../src/indexer/plugins/integration/tooling/openai-py/index.js';
import { PythonMLPlugin } from '../../../src/indexer/plugins/integration/tooling/python-ml/index.js';
import { PythonScientificPlugin } from '../../../src/indexer/plugins/integration/tooling/python-scientific/index.js';
import { PythonImagingPlugin } from '../../../src/indexer/plugins/integration/tooling/python-imaging/index.js';
import { PythonAsyncPlugin } from '../../../src/indexer/plugins/integration/tooling/python-async/index.js';
import { AttrsPyPlugin } from '../../../src/indexer/plugins/integration/tooling/attrs-py/index.js';
import { TqdmPyPlugin } from '../../../src/indexer/plugins/integration/tooling/tqdm-py/index.js';
import { Jinja2Plugin } from '../../../src/indexer/plugins/integration/view/jinja2/index.js';

type AnyPlugin =
  | PythonHttpClientsPlugin
  | OpenAIPythonPlugin
  | PythonMLPlugin
  | PythonScientificPlugin
  | PythonImagingPlugin
  | PythonAsyncPlugin
  | AttrsPyPlugin
  | TqdmPyPlugin
  | Jinja2Plugin;

async function extract(plugin: AnyPlugin, code: string, filePath = 'app/main.py', language = 'python') {
  const r = await plugin.extractNodes!(filePath, Buffer.from(code), language);
  if (!r.isOk()) throw new Error(JSON.stringify(r._unsafeUnwrapErr()));
  return r._unsafeUnwrap();
}

describe('PythonHttpClientsPlugin', () => {
  const plugin = new PythonHttpClientsPlugin();

  it('manifest', () => {
    expect(plugin.manifest.name).toBe('python-http');
    expect(plugin.manifest.category).toBe('tooling');
  });

  it('skips non-Python', async () => {
    const r = await extract(plugin, 'requests.get("/x")', 'app.ts', 'typescript');
    expect(r.symbols!.length).toBe(0);
    expect(r.edges ?? []).toEqual([]);
  });

  it('extracts requests.get / requests.post', async () => {
    const r = await extract(plugin, `
import requests
def fetch():
    r = requests.get("https://api.example.com/users")
    requests.post("https://api.example.com/users", json={"name": "x"})
`);
    expect(r.frameworkRole).toBe('http_client');
    const urls = r.edges!.map(e => e.metadata?.url);
    expect(urls).toContain('https://api.example.com/users');
    const methods = r.edges!.map(e => e.metadata?.method);
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
  });

  it('extracts httpx calls', async () => {
    const r = await extract(plugin, `
import httpx
r = httpx.get("https://x.com/a")
`);
    expect(r.edges!.some(e => e.metadata?.library === 'httpx' && e.metadata?.method === 'GET')).toBe(true);
  });

  it('extracts aiohttp session calls', async () => {
    const r = await extract(plugin, `
import aiohttp
async def go():
    async with aiohttp.ClientSession() as session:
        async with session.get("https://x.com/b") as resp:
            return await resp.text()
`);
    expect(r.edges!.some(e => e.metadata?.library === 'aiohttp' && e.metadata?.method === 'GET')).toBe(true);
  });

  it('skips files with no http imports', async () => {
    const r = await extract(plugin, 'print("hi")');
    expect(r.edges ?? []).toEqual([]);
  });
});

describe('OpenAIPythonPlugin', () => {
  const plugin = new OpenAIPythonPlugin();

  it('manifest', () => {
    expect(plugin.manifest.name).toBe('openai-py');
  });

  it('extracts chat.completions.create with model', async () => {
    const r = await extract(plugin, `
from openai import OpenAI
client = OpenAI()
resp = client.chat.completions.create(model="gpt-4o-mini", messages=[])
`);
    expect(r.frameworkRole).toBe('llm_client');
    const e = r.edges!.find(x => x.metadata?.kind === 'chat');
    expect(e).toBeDefined();
    expect(e!.metadata?.model).toBe('gpt-4o-mini');
  });

  it('extracts embeddings.create', async () => {
    const r = await extract(plugin, `
import openai
openai.embeddings.create(model="text-embedding-3-small", input="hi")
`);
    expect(r.edges!.some(e => e.metadata?.kind === 'embedding')).toBe(true);
  });

  it('handles legacy ChatCompletion API', async () => {
    const r = await extract(plugin, `
import openai
openai.ChatCompletion.create(model="gpt-3.5-turbo", messages=[])
`);
    expect(r.edges!.some(e => e.metadata?.kind === 'chat')).toBe(true);
  });
});

describe('Jinja2Plugin', () => {
  const plugin = new Jinja2Plugin();

  it('manifest', () => {
    expect(plugin.manifest.name).toBe('jinja2');
    expect(plugin.manifest.category).toBe('view');
  });

  it('marks .j2 files as jinja2 templates', async () => {
    const r = await extract(plugin, '<h1>{{ title }}</h1>', 'templates/index.html.j2', 'unknown');
    expect(r.frameworkRole).toBe('jinja2_template');
  });

  it('extracts env.get_template', async () => {
    const r = await extract(plugin, `
from jinja2 import Environment
env = Environment()
tpl = env.get_template("page.html")
`);
    expect(r.edges!.some(e => e.metadata?.template === 'page.html' && e.metadata?.via === 'get_template')).toBe(true);
  });

  it('extracts render_template (Flask)', async () => {
    const r = await extract(plugin, `
from flask import render_template
def view():
    return render_template("users/list.html", users=[])
`);
    expect(r.edges!.some(e => e.metadata?.template === 'users/list.html' && e.metadata?.via === 'render_template')).toBe(true);
  });
});

describe('PythonMLPlugin', () => {
  const plugin = new PythonMLPlugin();

  it('manifest', () => {
    expect(plugin.manifest.name).toBe('python-ml');
  });

  it('extracts nn.Module subclasses', async () => {
    const r = await extract(plugin, `
import torch.nn as nn
class MyNet(nn.Module):
    def forward(self, x):
        return x
`);
    expect(r.edges!.some(e => e.edgeType === 'ml_model_class' && e.metadata?.className === 'MyNet')).toBe(true);
  });

  it('extracts from_pretrained calls', async () => {
    const r = await extract(plugin, `
from transformers import AutoModel, AutoTokenizer
m = AutoModel.from_pretrained("bert-base-uncased")
t = AutoTokenizer.from_pretrained("bert-base-uncased")
`);
    const loads = r.edges!.filter(e => e.edgeType === 'ml_model_load');
    expect(loads.length).toBeGreaterThanOrEqual(2);
    expect(loads.some(e => e.metadata?.model === 'bert-base-uncased' && e.metadata?.loader === 'AutoModel')).toBe(true);
  });

  it('extracts pipeline() calls', async () => {
    const r = await extract(plugin, `
from transformers import pipeline
clf = pipeline("sentiment-analysis", model="distilbert-base-uncased")
`);
    expect(r.edges!.some(e => e.metadata?.kind === 'pipeline' && e.metadata?.task === 'sentiment-analysis')).toBe(true);
  });

  it('extracts .fit on sklearn estimators', async () => {
    const r = await extract(plugin, `
from sklearn.linear_model import LogisticRegression
clf = LogisticRegression()
clf.fit(X, y)
p = clf.predict(X)
`);
    expect(r.edges!.some(e => e.edgeType === 'ml_train')).toBe(true);
    expect(r.edges!.some(e => e.edgeType === 'ml_predict')).toBe(true);
  });

  it('extracts SentenceTransformer model loads', async () => {
    const r = await extract(plugin, `
from sentence_transformers import SentenceTransformer, CrossEncoder
model = SentenceTransformer("all-MiniLM-L6-v2")
cross = CrossEncoder("cross-encoder/ms-marco-MiniLM-L-6-v2")
embeddings = model.encode(["hello world"])
`);
    const loads = r.edges!.filter(e => e.edgeType === 'ml_model_load' && e.metadata?.kind === 'sentence_transformer');
    expect(loads.length).toBe(2);
    expect(loads.some(e => e.metadata?.loader === 'SentenceTransformer' && e.metadata?.model === 'all-MiniLM-L6-v2')).toBe(true);
    expect(loads.some(e => e.metadata?.loader === 'CrossEncoder')).toBe(true);
  });
});

describe('PythonScientificPlugin', () => {
  const plugin = new PythonScientificPlugin();

  it('extracts numpy allocators', async () => {
    const r = await extract(plugin, `
import numpy as np
a = np.array([1,2,3])
b = np.zeros((3,3))
c = np.random.randn(10)
`);
    const apis = r.edges!.map(e => e.metadata?.api);
    expect(apis).toContain('array');
    expect(apis).toContain('zeros');
  });

  it('detects scipy submodules', async () => {
    const r = await extract(plugin, `
import scipy
from scipy import optimize, signal
x = scipy.stats.norm.pdf(0)
`);
    const submods = r.edges!.filter(e => e.metadata?.library === 'scipy').map(e => e.metadata?.submodule);
    expect(submods).toContain('stats');
  });

  it('detects skimage submodules', async () => {
    const r = await extract(plugin, `
from skimage import io, filters
img = io.imread("x.png")
`);
    const submods = r.edges!.filter(e => e.metadata?.library === 'scikit-image').map(e => e.metadata?.submodule);
    expect(submods.length).toBeGreaterThan(0);
  });
});

describe('PythonImagingPlugin', () => {
  const plugin = new PythonImagingPlugin();

  it('extracts PIL.Image.open', async () => {
    const r = await extract(plugin, `
from PIL import Image
img = Image.open("photo.jpg")
img.save("out.png")
`);
    expect(r.edges!.some(e => e.metadata?.library === 'pillow' && e.metadata?.direction === 'read' && e.metadata?.target === 'photo.jpg')).toBe(true);
    expect(r.edges!.some(e => e.metadata?.library === 'pillow' && e.metadata?.direction === 'write')).toBe(true);
  });

  it('extracts cv2 imread/imwrite', async () => {
    const r = await extract(plugin, `
import cv2
img = cv2.imread("a.jpg")
cv2.imwrite("b.jpg", img)
`);
    expect(r.edges!.some(e => e.metadata?.library === 'opencv' && e.metadata?.direction === 'read')).toBe(true);
    expect(r.edges!.some(e => e.metadata?.library === 'opencv' && e.metadata?.direction === 'write')).toBe(true);
  });

  it('extracts imageio operations', async () => {
    const r = await extract(plugin, `
import imageio
img = imageio.imread("a.png")
imageio.imwrite("b.png", img)
`);
    expect(r.edges!.some(e => e.metadata?.library === 'imageio' && e.metadata?.direction === 'read')).toBe(true);
    expect(r.edges!.some(e => e.metadata?.library === 'imageio' && e.metadata?.direction === 'write')).toBe(true);
  });
});

describe('PythonAsyncPlugin', () => {
  const plugin = new PythonAsyncPlugin();

  it('extracts aiofiles.open with mode', async () => {
    const r = await extract(plugin, `
import aiofiles
async def read():
    async with aiofiles.open("/tmp/x.txt", "r") as f:
        return await f.read()
`);
    const e = r.edges!.find(x => x.edgeType === 'async_file_io');
    expect(e).toBeDefined();
    expect(e!.metadata?.target).toBe('/tmp/x.txt');
    expect(e!.metadata?.mode).toBe('r');
  });

  it('extracts anyio primitives', async () => {
    const r = await extract(plugin, `
import anyio
async def main():
    async with anyio.create_task_group() as tg:
        tg.start_soon(worker)
    await anyio.sleep(1)
`);
    const apis = r.edges!.filter(e => e.edgeType === 'async_primitive').map(e => e.metadata?.api);
    expect(apis).toContain('create_task_group');
    expect(apis).toContain('sleep');
  });
});

describe('AttrsPyPlugin', () => {
  const plugin = new AttrsPyPlugin();

  it('extracts @attrs.define classes', async () => {
    const r = await extract(plugin, `
import attrs
@attrs.define
class Point:
    x: int
    y: int
`);
    expect(r.edges!.some(e => e.edgeType === 'attrs_class' && e.metadata?.className === 'Point')).toBe(true);
  });

  it('extracts @attr.s classes', async () => {
    const r = await extract(plugin, `
import attr
@attr.s(auto_attribs=True)
class User:
    name: str = attr.ib()
`);
    expect(r.edges!.some(e => e.edgeType === 'attrs_class' && e.metadata?.className === 'User')).toBe(true);
  });
});

describe('TqdmPyPlugin', () => {
  const plugin = new TqdmPyPlugin();

  it('extracts tqdm and trange', async () => {
    const r = await extract(plugin, `
from tqdm import tqdm, trange
for i in tqdm(range(10)):
    pass
for j in trange(5):
    pass
`);
    expect((r.edges ?? []).length).toBeGreaterThanOrEqual(2);
    expect(r.frameworkRole).toBe('progress_instrumentation');
  });

  it('skips files without tqdm import', async () => {
    const r = await extract(plugin, `
def tqdm(x): return x
for i in tqdm(range(10)): pass
`);
    expect(r.edges ?? []).toEqual([]);
  });
});
