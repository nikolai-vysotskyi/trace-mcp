/**
 * PythonMLPlugin — detects PyTorch, HuggingFace Transformers, scikit-learn,
 * and sentence-transformers.
 *
 * Extracts:
 * - Model definitions: classes that subclass nn.Module
 * - Model loading: AutoModel.from_pretrained / torch.load / joblib.load /
 *   SentenceTransformer('...') / CrossEncoder('...')
 * - Training hooks: .fit(), .train(), model.compile()
 * - Inference hooks: .predict(), .forward(), pipeline(), .encode()
 */
import { ok, type TraceMcpResult } from '../../../../../errors.js';
import type {
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  FileParseResult,
  RawEdge,
  ResolveContext,
} from '../../../../../plugin-api/types.js';
import { hasAnyPythonDep } from '../../_shared/python-deps.js';

const PACKAGES = ['torch', 'transformers', 'scikit-learn', 'sentence-transformers'] as const;

const IMPORT_RE =
  /^\s*(?:from\s+(?:torch|transformers|sklearn|sentence_transformers)(?:\.\w+)*\s+import|import\s+(?:torch|transformers|sklearn|sentence_transformers))\b/m;

// SentenceTransformer('all-MiniLM-L6-v2') / CrossEncoder('...')
const SENTENCE_TRANSFORMER_RE =
  /\b(SentenceTransformer|CrossEncoder)\s*\(\s*(?:f|r|b)?["']([^"']+)["']/g;

// class Foo(nn.Module): | class Foo(torch.nn.Module): | class Foo(PreTrainedModel):
const MODULE_SUBCLASS_RE =
  /^\s*class\s+([A-Z]\w+)\s*\(\s*(?:[\w.]*\.)?(?:nn\.Module|Module|PreTrainedModel|LightningModule)\b/gm;

// AutoModel.from_pretrained('name') | AutoTokenizer.from_pretrained('name')
const FROM_PRETRAINED_RE =
  /\b(\w+)\s*\.\s*from_pretrained\s*\(\s*(?:f|r|b)?["']([^"']+)["']/g;

// torch.load('path') | torch.save(obj, 'path')
const TORCH_IO_RE = /\btorch\s*\.\s*(load|save)\s*\(/g;

// HuggingFace pipeline('task', model='...') / pipeline('task')
const PIPELINE_RE =
  /\bpipeline\s*\(\s*(?:f|r|b)?["']([^"']+)["'](?:\s*,\s*model\s*=\s*["']([^"']+)["'])?/g;

// .fit(X, y) / .predict(X) — sklearn-style (broad match, gated by import)
const FIT_RE = /\b(\w+)\s*\.\s*fit\s*\(/g;
const PREDICT_RE = /\b(\w+)\s*\.\s*predict(?:_proba|_log_proba)?\s*\(/g;

// joblib.load / joblib.dump (sklearn model persistence)
const JOBLIB_IO_RE = /\bjoblib\s*\.\s*(load|dump)\s*\(/g;

export class PythonMLPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'python-ml',
    version: '1.0.0',
    priority: 40,
    category: 'tooling',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    return hasAnyPythonDep(ctx, PACKAGES);
  }

  registerSchema() {
    return {
      edgeTypes: [
        { name: 'ml_model_load', category: 'ml', description: 'Model load/serialize (from_pretrained, torch.load, joblib.load)' },
        { name: 'ml_model_class', category: 'ml', description: 'Class subclasses nn.Module / PreTrainedModel' },
        { name: 'ml_train', category: 'ml', description: 'Model training call (.fit, .train, pipeline())' },
        { name: 'ml_predict', category: 'ml', description: 'Model inference call (.predict, .forward, pipeline())' },
      ],
    };
  }

  extractNodes(
    filePath: string,
    content: Buffer,
    language: string,
  ): TraceMcpResult<FileParseResult> {
    if (language !== 'python') {
      return ok({ status: 'ok', symbols: [] });
    }

    const source = content.toString('utf-8');
    const hasImport = IMPORT_RE.test(source);
    if (!hasImport && !source.includes('from_pretrained') && !source.includes('nn.Module')) {
      return ok({ status: 'ok', symbols: [] });
    }

    const result: FileParseResult = { status: 'ok', symbols: [], edges: [] };
    const findLine = (idx: number) => source.slice(0, idx).split('\n').length;

    for (const m of source.matchAll(MODULE_SUBCLASS_RE)) {
      result.edges!.push({
        edgeType: 'ml_model_class',
        metadata: { className: m[1], filePath, line: findLine(m.index ?? 0) },
      });
    }

    for (const m of source.matchAll(FROM_PRETRAINED_RE)) {
      result.edges!.push({
        edgeType: 'ml_model_load',
        metadata: { loader: m[1], model: m[2], kind: 'from_pretrained', filePath, line: findLine(m.index ?? 0) },
      });
    }

    for (const m of source.matchAll(SENTENCE_TRANSFORMER_RE)) {
      result.edges!.push({
        edgeType: 'ml_model_load',
        metadata: { loader: m[1], model: m[2], kind: 'sentence_transformer', filePath, line: findLine(m.index ?? 0) },
      });
    }

    for (const m of source.matchAll(TORCH_IO_RE)) {
      result.edges!.push({
        edgeType: 'ml_model_load',
        metadata: { loader: 'torch', kind: m[1], filePath, line: findLine(m.index ?? 0) },
      });
    }

    for (const m of source.matchAll(JOBLIB_IO_RE)) {
      result.edges!.push({
        edgeType: 'ml_model_load',
        metadata: { loader: 'joblib', kind: m[1], filePath, line: findLine(m.index ?? 0) },
      });
    }

    for (const m of source.matchAll(PIPELINE_RE)) {
      result.edges!.push({
        edgeType: 'ml_predict',
        metadata: { task: m[1], model: m[2] ?? '', kind: 'pipeline', filePath, line: findLine(m.index ?? 0) },
      });
    }

    // .fit / .predict — only emit when sklearn/torch imported to avoid false positives on generic .fit calls
    if (hasImport) {
      for (const m of source.matchAll(FIT_RE)) {
        result.edges!.push({
          edgeType: 'ml_train',
          metadata: { receiver: m[1], filePath, line: findLine(m.index ?? 0) },
        });
      }
      for (const m of source.matchAll(PREDICT_RE)) {
        result.edges!.push({
          edgeType: 'ml_predict',
          metadata: { receiver: m[1], filePath, line: findLine(m.index ?? 0) },
        });
      }
    }

    if (result.edges!.length > 0) {
      result.frameworkRole = 'ml_code';
    } else if (hasImport) {
      result.frameworkRole = 'ml_import';
    }

    return ok(result);
  }

  resolveEdges(_ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }
}
