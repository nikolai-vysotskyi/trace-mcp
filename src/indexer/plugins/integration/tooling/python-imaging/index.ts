/**
 * PythonImagingPlugin — detects image I/O libraries (pillow/PIL, opencv, imageio)
 * and extracts image read/write edges with file-path targets.
 */
import { ok, type TraceMcpResult } from '../../../../../errors.js';
import type {
  FileParseResult,
  FrameworkPlugin,
  PluginManifest,
  ProjectContext,
  RawEdge,
  ResolveContext,
} from '../../../../../plugin-api/types.js';
import { hasAnyPythonDep } from '../../_shared/python-deps.js';

const PACKAGES = ['pillow', 'opencv-python', 'opencv-python-headless', 'imageio'] as const;

const IMPORT_RE =
  /^\s*(?:from\s+(?:PIL|cv2|imageio)(?:\.\w+)*\s+import|import\s+(?:PIL|cv2|imageio)(?:\s+as\s+\w+)?)\b/m;

// PIL / Pillow: Image.open('path'), Image.save('path'), ImageOps.*
const PIL_OPEN_RE = /\bImage\s*\.\s*open\s*\(\s*(?:f|r|b)?["']([^"']+)["']/g;
const PIL_SAVE_RE = /\.save\s*\(\s*(?:f|r|b)?["']([^"']+)["']/g;

// OpenCV: cv2.imread('path'), cv2.imwrite('path', img), cv2.VideoCapture('path')
const CV2_IMREAD_RE = /\bcv2\s*\.\s*imread\s*\(\s*(?:f|r|b)?["']([^"']+)["']/g;
const CV2_IMWRITE_RE = /\bcv2\s*\.\s*imwrite\s*\(\s*(?:f|r|b)?["']([^"']+)["']/g;
const CV2_VIDEO_RE = /\bcv2\s*\.\s*VideoCapture\s*\(\s*(?:f|r|b)?["']([^"']+)["']/g;
const CV2_DNN_RE = /\bcv2\s*\.\s*dnn\s*\.\s*readNet\w*\s*\(\s*(?:f|r|b)?["']([^"']+)["']/g;

// imageio: imageio.imread('path'), imageio.imwrite('path', img), imageio.mimread(...)
const IMAGEIO_READ_RE =
  /\bimageio\s*\.\s*(?:imread|mimread|volread|mvolread)\s*\(\s*(?:f|r|b)?["']([^"']+)["']/g;
const IMAGEIO_WRITE_RE =
  /\bimageio\s*\.\s*(?:imwrite|mimwrite|volwrite|mvolwrite)\s*\(\s*(?:f|r|b)?["']([^"']+)["']/g;

export class PythonImagingPlugin implements FrameworkPlugin {
  manifest: PluginManifest = {
    name: 'python-imaging',
    version: '1.0.0',
    priority: 45,
    category: 'tooling',
    dependencies: [],
  };

  detect(ctx: ProjectContext): boolean {
    return hasAnyPythonDep(ctx, PACKAGES);
  }

  registerSchema() {
    return {
      edgeTypes: [
        {
          name: 'image_io',
          category: 'imaging',
          description: 'Image / video read or write (PIL, OpenCV, imageio)',
        },
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
    if (
      !hasImport &&
      !source.includes('Image.open') &&
      !source.includes('cv2.') &&
      !source.includes('imageio.')
    ) {
      return ok({ status: 'ok', symbols: [] });
    }

    const result: FileParseResult = { status: 'ok', symbols: [], edges: [] };
    const findLine = (idx: number) => source.slice(0, idx).split('\n').length;

    const push = (
      library: string,
      direction: 'read' | 'write',
      target: string,
      idx: number,
      extra: Record<string, unknown> = {},
    ) => {
      result.edges!.push({
        edgeType: 'image_io',
        metadata: { library, direction, target, filePath, line: findLine(idx), ...extra },
      });
    };

    for (const m of source.matchAll(PIL_OPEN_RE)) push('pillow', 'read', m[1], m.index ?? 0);
    // PIL .save() — only emit if PIL imported (generic .save pattern otherwise too noisy)
    if (/\b(?:PIL|Image)\b/.test(source)) {
      for (const m of source.matchAll(PIL_SAVE_RE)) push('pillow', 'write', m[1], m.index ?? 0);
    }

    for (const m of source.matchAll(CV2_IMREAD_RE)) push('opencv', 'read', m[1], m.index ?? 0);
    for (const m of source.matchAll(CV2_IMWRITE_RE)) push('opencv', 'write', m[1], m.index ?? 0);
    for (const m of source.matchAll(CV2_VIDEO_RE))
      push('opencv', 'read', m[1], m.index ?? 0, { kind: 'video' });
    for (const m of source.matchAll(CV2_DNN_RE))
      push('opencv', 'read', m[1], m.index ?? 0, { kind: 'dnn_model' });

    for (const m of source.matchAll(IMAGEIO_READ_RE)) push('imageio', 'read', m[1], m.index ?? 0);
    for (const m of source.matchAll(IMAGEIO_WRITE_RE)) push('imageio', 'write', m[1], m.index ?? 0);

    if (result.edges!.length > 0) {
      result.frameworkRole = 'imaging_io';
    } else if (hasImport) {
      result.frameworkRole = 'imaging_import';
    }

    return ok(result);
  }

  resolveEdges(_ctx: ResolveContext): TraceMcpResult<RawEdge[]> {
    return ok([]);
  }
}
