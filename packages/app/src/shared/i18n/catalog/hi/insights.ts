export const insights = {
  title: 'Insights',
  reportPicker: 'रिपोर्ट',
  run: 'चलाएँ',
  refresh: 'रीफ़्रेश',
  running: 'चल रहा है…',
  runAction: '{{action}} {{report}}',
  unknownError: 'अज्ञात एरर',
  errorInit: 'डेमन के साथ सेशन शुरू नहीं हो सका (HTTP {{status}})।',
  errorNoSession: 'डेमन ने सेशन शुरू किया पर उसका नाम नहीं दिया।',
  errorHttp: 'रिपोर्ट की रिक्वेस्ट विफल रही (HTTP {{status}})। {{detail}}',
  errorToolFailed: 'रिपोर्ट नहीं चली।',

  reportDriftTitle: 'CLAUDE.md drift',
  reportDriftDescription: 'एजेंट कॉन्फ़िग फ़ाइलों में पुराने पाथ और मृत सिंबल संदर्भ।',
  reportPagerankTitle: 'सबसे केंद्रीय फ़ाइलें',
  reportPagerankDescription:
    'import ग्राफ़ पर PageRank के अनुसार सबसे केंद्रीय फ़ाइलें।',
  reportRiskTitle: 'रिस्क हॉटस्पॉट',
  reportRiskDescription: 'ऐसी फ़ाइलें जिनमें जटिलता भी ज़्यादा है और git churn भी।',

  runningDrift: 'एजेंट कॉन्फ़िग को इंडेक्स से मिलाया जा रहा है…',
  runningPagerank: 'import केंद्रीयता के अनुसार फ़ाइलें रैंक की जा रही हैं…',
  runningRisk: 'जटिलता और git churn का मिलान हो रहा है…',

  emptyTitle: 'बताने लायक कुछ नहीं',
  emptyBody: 'यह रिपोर्ट खाली आई — फ़िलहाल प्रोजेक्ट में इससे कुछ मेल नहीं खाता।',

  noDescription: '(कोई विवरण नहीं)',
  rowIssue: '{{location}} — {{issue}}',
  rowFix: 'सुधार: {{fix}}',
  rowScore: 'स्कोर {{score}}',
  rowHotspot: 'जटिलता {{complexity}} · {{commits}} कमिट',
  rowHotspotConfidence: 'जटिलता {{complexity}} · {{commits}} कमिट · {{confidence}}',

  reportStartupTitle: 'शुरुआती संदर्भ',
  reportStartupDescription:
    'आपके पहले संदेश से पहले ही हर सत्र किसके लिए भुगतान करता है, उसकी लागत क्या है, और किस वजह से वह दो बार चुकाना पड़ता है। यह इसी Mac के सत्र लॉग से पढ़ा जाता है; कुछ भी कहीं नहीं भेजा जाता।',
  runningStartup: 'आपके सत्र लॉग में शुरुआती ब्लॉक मापा जा रहा है…',

  startupBlockRow: 'शुरुआती ब्लॉक — {{tokens}} टोकन',
  startupBlockDetail: 'मध्यमान · p10 {{p10}} · p90 {{p90}} · {{days}} दिनों में {{sessions}} सत्र',
  startupCostRow: 'शुरुआत की लागत — {{usd}}',
  startupCostDetail: '{{days}} दिनों में इनपुट पर खर्च हुए {{total}} में से',
  startupSourceRow: '{{source}} — {{tokens}} टोकन',
  startupSourceDetail: '{{sessions}} सत्रों में मापा गया',
  startupResidualDetail:
    'अलग-अलग नहीं दिखाया जा सकता — सिस्टम प्रॉम्प्ट, टूल स्कीमा और CLAUDE.md कभी सत्र लॉग में नहीं आते',
  startupRebuildRow: 'कैश दोबारा बना: {{cause}} — {{events}} बार',
  startupRebuildDetail: 'वही टोकन कैश से पढ़ने की तुलना में {{usd}} अतिरिक्त',
  startupServerRow: '{{server}} — {{sessions}} शुरुआती ब्लॉक में',
  startupServerDetail: '{{calls}} बार बुलाया गया',

  sourceResidual: 'सिस्टम प्रॉम्प्ट, टूल स्कीमा और निर्देश',
  sourceSkills: 'स्किल सूची',
  sourceDeferredTools: 'स्थगित टूल की सूची',
  sourceAgentListing: 'एजेंट सूची',
  sourceMcpInstructions: 'MCP सर्वर निर्देश',
  sourceMemory: 'मेमोरी फ़ाइलें',
  sourceOther: 'अन्य प्रविष्टियाँ',
  sourceHook: 'हुक: {{name}}',

  causeCompact: 'संदर्भ संक्षिप्त हुआ',
  causeTtlExpiry: 'संदेशों के बीच कैश की अवधि खत्म हुई',
  causeModelSwitch: 'मॉडल बदला',
  causeToolsChanged: 'टूल का सेट बदला',
  causeListingChanged: 'स्किल या एजेंट सूची बदली',
  causeUnexplained: 'कारण पहचाना नहीं गया',

  recUnusedMcpServer: 'MCP सर्वर {{target}} — कभी नहीं बुलाया गया',
  recUnusedSkill: 'स्किल {{target}} — कभी इस्तेमाल नहीं हुई',
  recDuplicateInstructions: '{{target}} में निर्देशों का दोहराया गया पाठ',
  recDetail:
    '{{days}} दिनों में {{total}} में से {{sessions}} शुरुआतों में · हर बार {{tokens}} टोकन · {{usd}}',
  recBadge: 'अप्रयुक्त',
} as const;
