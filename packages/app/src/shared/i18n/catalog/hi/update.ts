export const update = {
  staleRoots: 'MCP क्लाइंट अब भी v{{version}} चला रहे हैं',
  staleRootsTitle:
    'आपके एडिटर trace-mcp को {{pkgDir}} से चलाते हैं, जहाँ v{{version}} है। वह कॉपी किसी दूसरे npm से इंस्टॉल हुई थी, इसलिए इस ऐप के अपडेट से उसमें कुछ नहीं बदला — जब तक वह अपडेट नहीं होती, हर MCP क्लाइंट पुराना सर्वर ही इस्तेमाल करता रहेगा।\n\nटर्मिनल से अपडेट करें:\n{{command}}',
  copyStaleRootCommand: 'अपडेट कमांड कॉपी करें',

  duplicateApps: 'एक से अधिक बार इंस्टॉल है',
  duplicateApp: '{{path}} · v{{version}}',
  duplicateAppRunning: '{{path}} · v{{version}} — अभी चल रही है',
  duplicateAppsTitle:
    'इस Mac पर trace-mcp की एक से अधिक प्रतियाँ हैं:\n\n{{list}}\n\nकेवल वही प्रति अपडेट होती है जिसे आप खोलते हैं, इसलिए अगली बार आप जो शुरू करेंगे वही आपका संस्करण तय करेगी। जिस प्रति का उपयोग करते हैं उसे रखें और दूसरी को ट्रैश में डालें — या दूसरी को एक बार खोलकर उसे स्वयं अपडेट होने दें।',
  revealDuplicateApp: 'दूसरी प्रति Finder में दिखाएँ',

  headerVersion: 'वर्ज़न {{version}}',
  headerChecking: 'जाँच हो रही है…',
  headerAvailable: 'वर्ज़न {{version}} उपलब्ध',
  headerUpToDate: 'अप टू डेट · {{when}} जाँचा गया',
  headerDaemonAvailable: 'डेमॉन अपडेट उपलब्ध · v{{version}}',
  headerBothAvailable: 'ऐप और डेमॉन दोनों के अपडेट उपलब्ध',

  cardReadyTitle: 'v{{version}} तैयार',
  cardReadySubtitle: 'इंस्टॉल के लिए रीस्टार्ट करें · v{{current}}',
  cardRestart: 'इंस्टॉल के लिए रीस्टार्ट करें',
  cardAvailableTitle: 'v{{version}} उपलब्ध',
  cardAvailableSubtitle: 'अभी v{{current}} · {{when}} जाँचा गया',
  cardUpdate: 'अपडेट',
  cardUpdating: 'अपडेट हो रहा है…',

  settingsTitle: 'अपडेट',
  settingsAppRow: 'ऐप',
  settingsDaemonRow: 'डेमॉन',
  settingsCheck: 'अपडेट देखें',
} as const;
