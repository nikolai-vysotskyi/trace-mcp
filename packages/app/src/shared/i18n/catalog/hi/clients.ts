export const clients = {
  title: 'MCP क्लाइंट',
  refresh: 'क्लाइंट रीफ़्रेश करें',

  supported: 'समर्थित क्लाइंट',
  sessions: 'सक्रिय सेशन',
  detecting: 'क्लाइंट खोजे जा रहे हैं',
  loadingSessions: 'सेशन लोड हो रहे हैं',

  daemonDownTitle: 'डेमन उपलब्ध नहीं',
  daemonDownSubtitle:
    'trace-mcp क्लाइंट लोकल डेमन से जुड़ते हैं। उन्हें देखने और सेट करने के लिए इसे चालू करें।',
  startDaemon: 'डेमन चालू करें',
  starting: 'शुरू हो रहा है…',

  noSessionsTitle: 'कोई सक्रिय सेशन नहीं',
  noSessionsSubtitle: 'जब कोई क्लाइंट डेमन से जुड़ता है, सेशन यहाँ दिखता है।',
  unnamedSession: 'बिना नाम का सेशन',

  sessionActive: 'सक्रिय',
  sessionIdle: 'निष्क्रिय',
  sessionStale: 'पुराना',

  connected: 'जुड़ा हुआ',
  connect: 'जोड़ें',
  connecting: 'जुड़ रहे हैं…',
  updateAvailable: 'अपडेट उपलब्ध',
  update: 'अपडेट',
  updating: 'अपडेट हो रहा है…',
  driftedField: 'बदला हुआ फ़ील्ड: {{field}}',
  setUpManually: 'खुद सेट करें…',
  hideSteps: 'चरण छिपाएँ',

  enforcementLevel: 'एनफ़ोर्समेंट स्तर',
  levelBase: 'Base',
  levelBaseHint: 'केवल CLAUDE.md — सॉफ़्ट रूटिंग नियम',
  levelStandard: 'Standard',
  levelStandardHint: 'CLAUDE.md और hooks',
  levelMax: 'Max',
  levelMaxHint: 'CLAUDE.md, hooks और tweakcc — अनुशंसित',
} as const;
