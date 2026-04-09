/**
 * Service Detector — discovers services from Docker Compose, K8s manifests, or directory names.
 */

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger.js';
import { ROOT_MARKERS } from '../project-root.js';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor', '.svn', '__pycache__', '.tox']);

interface DetectedService {
  name: string;
  repoRoot: string;
  serviceType: 'http' | 'grpc' | 'graphql' | 'worker' | 'monolith';
  detectionSource: 'docker-compose' | 'k8s' | 'workspace' | 'manual';
  projectGroup?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Detect services from repo roots.
 * Strategy order:
 *   1. Docker Compose — explicit service definitions
 *   2. Workspace structure — monorepo with project-group subdirs (org/project/service hierarchy)
 *   3. Fallback — treat root as a single monolith
 */
export function detectServices(repoRoots: string[]): DetectedService[] {
  const services: DetectedService[] = [];

  for (const root of repoRoots) {
    const absRoot = path.resolve(root);

    // 1. Docker Compose
    const composeServices = detectFromDockerCompose(absRoot);
    if (composeServices.length > 0) {
      services.push(...composeServices);
      continue;
    }

    // 2. Workspace structure (monorepo: root/group/service/)
    const workspaceServices = detectFromWorkspaceStructure(absRoot);
    if (workspaceServices.length > 0) {
      services.push(...workspaceServices);
      continue;
    }

    // 3. Fallback: treat as single service
    services.push({
      name: path.basename(absRoot),
      repoRoot: absRoot,
      serviceType: 'monolith',
      detectionSource: 'workspace',
    });
  }

  return services;
}

/**
 * Detect services from a multi-level workspace structure:
 *   root/
 *     <group>/         ← project group (e.g. "fair", "thewed")
 *       <service>/     ← service with ROOT_MARKER (e.g. "frontend", "backend")
 *
 * Returns services only when at least 2 groups or 2 services are found,
 * to avoid false-positives on flat projects.
 */
function detectFromWorkspaceStructure(root: string): DetectedService[] {
  let groupEntries: fs.Dirent[];
  try {
    groupEntries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const services: DetectedService[] = [];

  for (const groupEntry of groupEntries) {
    if (!groupEntry.isDirectory()) continue;
    if (groupEntry.name.startsWith('.') || SKIP_DIRS.has(groupEntry.name)) continue;

    const groupDir = path.join(root, groupEntry.name);
    const groupName = groupEntry.name;

    let childEntries: fs.Dirent[];
    try {
      childEntries = fs.readdirSync(groupDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const childEntry of childEntries) {
      if (!childEntry.isDirectory()) continue;
      if (childEntry.name.startsWith('.') || SKIP_DIRS.has(childEntry.name)) continue;

      const childDir = path.join(groupDir, childEntry.name);
      if (hasRootMarker(childDir)) {
        services.push({
          name: `${groupName}/${childEntry.name}`,
          repoRoot: childDir,
          serviceType: 'monolith',
          detectionSource: 'workspace',
          projectGroup: groupName,
        });
      }
    }
  }

  // Only use this strategy if we found a genuine multi-service structure
  const groupsFound = new Set(services.map((s) => s.projectGroup)).size;
  if (groupsFound >= 2 || services.length >= 3) {
    logger.debug({ count: services.length, groups: groupsFound, root }, 'Detected services from workspace structure');
    return services;
  }

  return [];
}

function hasRootMarker(dir: string): boolean {
  for (const marker of ROOT_MARKERS) {
    if (fs.existsSync(path.join(dir, marker))) return true;
  }
  return false;
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
