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
} as const;
