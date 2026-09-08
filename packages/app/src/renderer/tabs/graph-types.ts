export interface GraphExplorerGPUHandle {
  focusNode: (id: string) => boolean;
}

export interface GraphGPUSettings {
  scope: string;
  granularity: 'file' | 'symbol';
  hideIsolated: boolean;
  symbolKinds: string;
  maxNodes: string;
  colorBy: 'community' | 'language' | 'framework_role';
  showLabels: boolean;
  showFPS: boolean;
  bottlenecks: boolean;
  stressTest: boolean;
}

export const DEFAULT_GRAPH_GPU_SETTINGS: GraphGPUSettings = {
  scope: 'project',
  granularity: 'file',
  hideIsolated: true,
  symbolKinds: '',
  maxNodes: '',
  colorBy: 'community',
  showLabels: true,
  showFPS: false,
  bottlenecks: false,
  stressTest: false,
};
