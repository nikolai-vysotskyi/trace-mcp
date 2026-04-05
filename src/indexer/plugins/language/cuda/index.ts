/**
 * CUDA Language Plugin — regex-based symbol extraction.
 *
 * Extracts: __global__, __device__, __host__ functions, structs, enums, constants, and import edges.
 * Extends C/C++ with CUDA-specific qualifiers.
 */
import { createRegexLanguagePlugin } from '../regex-base.js';
import type { LanguagePlugin } from '../../../../plugin-api/types.js';

const _plugin = createRegexLanguagePlugin({
  name: 'cuda',
  language: 'cuda',
  extensions: ['.cu', '.cuh'],
  symbolPatterns: [
    // __global__ void kernelName(
    { kind: 'function', pattern: /^\s*__global__\s+[\w\s*&]+\s+(\w+)\s*\(/gm, meta: { kernel: true } },
    // __device__ returnType funcName(
    { kind: 'function', pattern: /^\s*__device__\s+[\w\s*&]+\s+(\w+)\s*\(/gm, meta: { device: true } },
    // __host__ __device__ or __host__ funcName(
    { kind: 'function', pattern: /^\s*__host__\s+(?:__device__\s+)?[\w\s*&]+\s+(\w+)\s*\(/gm },
    // regular function definitions (returnType funcName()
    { kind: 'function', pattern: /^(?!.*(?:__global__|__device__|__host__))\s*(?:static\s+|inline\s+|extern\s+)*[\w:*&<>]+\s+(\w+)\s*\([^)]*\)\s*\{/gm },
    // struct Name {
    { kind: 'class', pattern: /^\s*(?:typedef\s+)?struct\s+(\w+)/gm },
    // enum Name {
    { kind: 'enum', pattern: /^\s*(?:typedef\s+)?enum\s+(\w+)/gm },
    // class Name
    { kind: 'class', pattern: /^\s*class\s+(\w+)/gm },
    // #define NAME
    { kind: 'constant', pattern: /^\s*#define\s+(\w+)/gm },
    // __constant__ type name
    { kind: 'variable', pattern: /^\s*__constant__\s+[\w\s*&]+\s+(\w+)/gm, meta: { constant_mem: true } },
    // __shared__ type name
    { kind: 'variable', pattern: /^\s*__shared__\s+[\w\s*&]+\s+(\w+)/gm, meta: { shared_mem: true } },
  ],
  importPatterns: [
    // #include "file" or <file>
    { pattern: /^\s*#include\s+[<"]([^>"]+)[>"]/gm },
  ],
});

export const CudaLanguagePlugin = class implements LanguagePlugin {
  manifest = _plugin.manifest;
  supportedExtensions = _plugin.supportedExtensions;
  supportedVersions = _plugin.supportedVersions;
  extractSymbols = _plugin.extractSymbols;
};
