export const ask = {
  title: 'Ask',

  noProviderTitle: 'AI प्रोवाइडर जोड़ें',
  noProviderSubtitle:
    'Ask आपके दिए मॉडल से इस प्रोजेक्ट के सवालों के जवाब देता है। चालू करने के लिए सेटिंग्स में एक जोड़ें।',
  openAiSettings: 'AI सेटिंग्स खोलें',

  chats: 'चैट',
  newChat: 'नई चैट',
  noChats: 'अभी कोई चैट नहीं।',
  untitled: 'बिना शीर्षक',
  deleteChat: 'चैट हटाएँ (⌫)',
  connectingProvider: 'जुड़ रहे हैं…',
  noProvider: 'कोई प्रोवाइडर नहीं',

  showContextPanel: 'कॉन्टेक्स्ट पैनल दिखाएँ',
  hideContextPanel: 'कॉन्टेक्स्ट पैनल छिपाएँ',
  showContext: 'कॉन्टेक्स्ट दिखाएँ',
  hideContext: 'कॉन्टेक्स्ट छिपाएँ',
  loadingChat: 'चैट लोड हो रही है',
  conversation: 'बातचीत',

  emptyTitle: 'इस कोडबेस के बारे में कुछ भी पूछें',
  emptySubtitle:
    'जवाब इंडेक्स किए गए ग्राफ़ पर आधारित होते हैं — इस प्रोजेक्ट की फ़ाइलें, सिंबल और decisions।',
  slashCommands: 'स्लैश कमांड',
  slashFind: 'नाम से सिंबल खोजें',
  slashImpact: 'किसी सिंबल का change impact दिखाएँ',
  slashScan: 'सिक्योरिटी स्कैन चलाएँ (OWASP मुख्य findings)',
  suggestionAuth: 'auth कैसे काम करता है?',
  suggestionPlugins: 'प्लगइन सिस्टम समझाएँ',
  suggestionRoutes: 'API रूट कहाँ हैं?',

  retrieving: 'कोडबेस में खोज रहे हैं',
  thinking: 'सोच रहे हैं',
  sendAgain: 'फिर भेजें',

  composerLabel: 'इस प्रोजेक्ट के बारे में पूछें',
  composerPlaceholder: 'इस प्रोजेक्ट के बारे में पूछें, या कमांड के लिए / टाइप करें',
  stopGenerating: 'जेनरेट करना रोकें',
  sendMessage: 'संदेश भेजें',
  sendShortcut: 'भेजें (⌘↵)',
  copyCode: 'कोड कॉपी करें',
  copied: 'कॉपी हो गया',

  context: 'कॉन्टेक्स्ट',
  noContextTitle: 'अभी कोई कॉन्टेक्स्ट नहीं',
  noContextSubtitle:
    'संदेश भेजने के बाद मॉडल ने जो फ़ाइलें, सिंबल और decisions पढ़े, वे यहाँ दिखेंगे। स्लैश कमांड कॉन्टेक्स्ट नहीं लाते।',
  filesRead: 'पढ़ी गई फ़ाइलें',
  noFilesRead: 'कोई फ़ाइल नहीं पढ़ी गई।',
  symbolsRead: 'पढ़े गए सिंबल',
  decisionsConsulted: 'देखे गए decisions',

  loadSessionFailed: 'सेशन लोड नहीं हो सका',
  createSessionFailed: 'सेशन नहीं बन सका',
  noSession: 'चैट सेशन शुरू नहीं हो सका',
  slashFailed: 'स्लैश कमांड विफल',
  unknownError: 'अज्ञात एरर',
} as const;
