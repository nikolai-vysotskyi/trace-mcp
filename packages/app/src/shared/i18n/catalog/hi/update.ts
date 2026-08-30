export const update = {
  staleRoots: 'MCP क्लाइंट अब भी v{{version}} चला रहे हैं',
  staleRootsTitle:
    'आपके एडिटर trace-mcp को {{pkgDir}} से चलाते हैं, जहाँ v{{version}} है। वह कॉपी किसी दूसरे npm से इंस्टॉल हुई थी, इसलिए इस ऐप के अपडेट से उसमें कुछ नहीं बदला — जब तक वह अपडेट नहीं होती, हर MCP क्लाइंट पुराना सर्वर ही इस्तेमाल करता रहेगा।\n\nटर्मिनल से अपडेट करें:\n{{command}}',
  copyStaleRootCommand: 'अपडेट कमांड कॉपी करें',

  headerVersion: 'वर्ज़न {{version}}',
  headerChecking: 'जाँच हो रही है…',
  headerAvailable: 'वर्ज़न {{version}} उपलब्ध',
  headerUpToDate: 'अप टू डेट · {{when}} जाँचा गया',

  cardReadyTitle: 'v{{version}} तैयार',
  cardReadySubtitle: 'इंस्टॉल के लिए रीस्टार्ट करें · v{{current}}',
  cardRestart: 'इंस्टॉल के लिए रीस्टार्ट करें',
  cardAvailableTitle: 'v{{version}} उपलब्ध',
  cardAvailableSubtitle: 'अभी v{{current}} · {{when}} जाँचा गया',
  cardUpdate: 'अपडेट',
  cardUpdating: 'अपडेट हो रहा है…',
} as const;
