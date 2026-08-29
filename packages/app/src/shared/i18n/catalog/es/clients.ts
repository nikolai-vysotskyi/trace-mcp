export const clients = {
  title: 'Clientes MCP',
  refresh: 'Actualizar los clientes',

  supported: 'Clientes compatibles',
  sessions: 'Sesiones activas',
  detecting: 'Detectando clientes',
  loadingSessions: 'Cargando las sesiones',

  daemonDownTitle: 'Daemon inaccesible',
  daemonDownSubtitle:
    'Los clientes de trace-mcp se conectan a través del daemon local. Arráncalo para verlos y configurarlos.',
  startDaemon: 'Arrancar el daemon',
  starting: 'Arrancando…',

  noSessionsTitle: 'No hay sesiones activas',
  noSessionsSubtitle: 'Aquí aparece una sesión cuando un cliente se conecta al daemon.',
  unnamedSession: 'Sesión sin nombre',

  sessionActive: 'Activa',
  sessionIdle: 'Inactiva',
  sessionStale: 'Caducada',

  connected: 'Conectado',
  connect: 'Conectar',
  connecting: 'Conectando…',
  updateAvailable: 'Actualización disponible',
  update: 'Actualizar',
  updating: 'Actualizando…',
  driftedField: 'Campo desviado: {{field}}',
  setUpManually: 'Configurar a mano…',
  hideSteps: 'Ocultar los pasos',

  enforcementLevel: 'Nivel de aplicación',
  levelBase: 'Básico',
  levelBaseHint: 'Solo CLAUDE.md — reglas de enrutado orientativas',
  levelStandard: 'Estándar',
  levelStandardHint: 'CLAUDE.md y hooks',
  levelMax: 'Máximo',
  levelMaxHint: 'CLAUDE.md, hooks y tweakcc — recomendado',
} as const;
