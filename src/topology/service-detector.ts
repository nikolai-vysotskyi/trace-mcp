/**
 * Service Detector — discovers services from Docker Compose, K8s manifests, or directory names.
 */

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';

interface DetectedService {
  name: string;
  repoRoot: string;
  serviceType: 'http' | 'grpc' | 'graphql' | 'worker' | 'monolith';
  detectionSource: 'docker-compose' | 'k8s' | 'workspace' | 'manual';
  metadata?: Record<string, unknown>;
}

/**
 * Detect services from repo roots.
 * Tries Docker Compose first, then falls back to treating each root as a single service.
 */
export function detectServices(repoRoots: string[]): DetectedService[] {
  const services: DetectedService[] = [];

  for (const root of repoRoots) {
    const absRoot = path.resolve(root);

    // Try Docker Compose
    const composeServices = detectFromDockerCompose(absRoot);
    if (composeServices.length > 0) {
      services.push(...composeServices);
      continue;
    }

    // Fallback: treat as single service
    services.push({
      name: path.basename(absRoot),
      repoRoot: absRoot,
      serviceType: 'monolith',
      detectionSource: 'workspace',
    });
  }

  return services;
}

function detectFromDockerCompose(root: string): DetectedService[] {
  const composeFiles = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
  let composePath: string | undefined;

  for (const f of composeFiles) {
    const p = path.join(root, f);
    if (fs.existsSync(p)) {
      composePath = p;
      break;
    }
  }

  if (!composePath) return [];

  try {
    const content = fs.readFileSync(composePath, 'utf-8');
    const services: DetectedService[] = [];

    // Simple YAML parsing for docker-compose services (no yaml dependency)
    // Looking for top-level "services:" block
    const lines = content.split('\n');
    let inServices = false;
    let servicesIndent = 0;
    let childIndent: number | null = null; // detected from first child

    for (const line of lines) {
      const trimmed = line.trimStart();
      const indent = line.length - trimmed.length;

      if (!inServices && /^services\s*:/.test(trimmed) && indent === 0) {
        inServices = true;
        servicesIndent = indent;
        childIndent = null;
        continue;
      }

      if (inServices) {
        if (trimmed.length === 0 || trimmed.startsWith('#')) continue;

        // New top-level key → end of services block
        if (indent <= servicesIndent) break;

        // Detect child indent from first non-empty child line
        if (childIndent === null) {
          childIndent = indent;
        }

        // Service name: line at child indent level ending with ':'
        if (indent === childIndent && trimmed.endsWith(':') && !trimmed.startsWith('#')) {
          const serviceName = trimmed.slice(0, -1).trim();
          if (serviceName && !serviceName.includes(' ')) {
            services.push({
              name: serviceName,
              repoRoot: root,
              serviceType: 'http',
              detectionSource: 'docker-compose',
              metadata: { composePath },
            });
          }
        }
      }
    }

    if (services.length > 0) {
      logger.debug({ count: services.length, composePath }, 'Detected services from docker-compose');
    }

    return services;
  } catch (e) {
    logger.warn({ error: e, composePath }, 'Failed to parse docker-compose');
    return [];
  }
}
