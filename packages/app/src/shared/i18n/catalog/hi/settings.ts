export const settings = {
  title: 'सेटिंग्स',
  back: 'वापस',
  moreActions: 'और क्रियाएँ',
  search: 'सेटिंग्स खोजें',
  copyDaemon: 'डेमन की जानकारी कॉपी करें',
  editConfigFile: 'कॉन्फ़िग फ़ाइल संपादित करें…',
  noMatches: '“{{query}}” से कोई सेटिंग मेल नहीं खाती।',

  'group.general': 'सामान्य',
  'group.intelligence': 'इंटेलिजेंस',
  'group.quality': 'क्वालिटी और सिक्योरिटी',
  'group.infrastructure': 'इंफ़्रास्ट्रक्चर',
  'group.development': 'डेवलपमेंट',
  'group.monitoring': 'मॉनिटरिंग',
  'group.advanced': 'एडवांस्ड',

  'daemon.title': 'डेमन',
  'daemon.state': 'चल रहा है',
  'daemon.summary': 'चल रहा है · पोर्ट {{port}} · अपटाइम {{uptime}}',
  'uptime.seconds': '{{value}}s',
  'uptime.minutes': '{{value}}m',
  'uptime.hours': '{{value}}h',
  'uptime.hoursMinutes': '{{hours}}h {{minutes}}m',

  'app.title': 'ऐप',
  'app.language': 'भाषा',
  'appearance.theme': 'थीम',

  'empty.loading': 'सेटिंग्स लोड हो रही हैं…',
  'empty.unreadableTitle': 'सेटिंग्स पढ़ी नहीं जा सकीं',
  'empty.unreadableBody':
    'डेमन चल रहा है पर उसने अपना कॉन्फ़िग नहीं लौटाया। उसे दोबारा चालू करने से आमतौर पर यह ठीक हो जाता है।',
  'empty.unreachableTitle': 'डेमन उपलब्ध नहीं',
  'empty.unreachableBody':
    'सेटिंग्स डेमन की कॉन्फ़िग फ़ाइल में रहती हैं, इसलिए उसके चालू होने तक वे पढ़ी नहीं जा सकतीं।',
  'empty.starting': 'शुरू हो रहा है…',
  'empty.restart': 'डेमन दोबारा चालू करें',
  'empty.start': 'डेमन चालू करें',

  modified: 'बदला हुआ',
  issues_one: '{{count}} समस्या',
  issues_other: '{{count}} समस्याएँ',

  reset: 'रीसेट',
  resetSection: 'इस सेक्शन को डिफ़ॉल्ट पर लाएँ',
  notSet: 'सेट नहीं',
  'field.aria': '{{label}}: {{value}}',
  'field.ariaUnset': '{{label}}: सेट नहीं',
  invalidJson: 'अमान्य JSON',

  'models.select': 'मॉडल चुनें…',
  'models.filter': 'मॉडल फ़िल्टर करें',
  'models.loading': 'मॉडल लोड हो रहे हैं…',
  'models.retry': 'फिर से',
  'models.none': 'कोई मॉडल नहीं मिला',
  'models.noMatches': 'कोई मेल नहीं',
  'models.clear': 'चयन हटाएँ',
  'models.type': 'या मॉडल का नाम टाइप करें…',
  'models.typeAria': 'मॉडल का नाम टाइप करें',
  'models.failed': 'मॉडल लाने में विफल',
  'models.httpError': '{{provider}}: {{status}}',
  'models.authError': '{{provider}}: {{status}} (API key जाँचें)',

  'projects.title': 'प्रति-प्रोजेक्ट ओवरराइड',
  'projects.intro':
    'खास प्रोजेक्ट के लिए ग्लोबल सेटिंग्स बदलें। मान ग्लोबल कॉन्फ़िग के ऊपर मर्ज होते हैं।',
  'projects.done': 'हो गया',
  'projects.edit': 'संपादित करें',
  'projects.remove': 'हटाएँ',
  'projects.apply': 'लागू करें',
  'projects.add': 'जोड़ें',
  'projects.pathAria': 'प्रोजेक्ट पाथ',
  'projects.overridesAria': '{{path}} के ओवरराइड',

  'diff.title': 'लंबित बदलाव',
  'diff.hide': 'छिपाएँ',
  'bar.hasErrors': 'सहेजने से पहले ऊपर की समस्याएँ ठीक करें',
  'bar.saved': 'सहेजा गया',
  'bar.saveFailed': 'सहेजा नहीं जा सका — डेमन ने बदलाव अस्वीकार किया',
  'bar.unsaved_one': '{{count}} बिना सहेजा बदलाव',
  'bar.unsaved_other': '{{count}} बिना सहेजे बदलाव',
  'bar.hideChanges': 'बदलाव छिपाएँ',
  'bar.reviewChanges': 'बदलाव देखें',
  'bar.discard': 'छोड़ दें',
  'bar.saving': 'सहेजा जा रहा है…',
  'bar.save': 'सहेजें',

  'activity.title': 'AI गतिविधि',
  'activity.armed': 'आप जो अगली प्रोजेक्ट विंडो खोलेंगे, वह Activity → AI calls पर खुलेगी।',
  'activity.idle': 'हाल की embed, LLM और rerank रिक्वेस्ट प्रोजेक्ट विंडो में Activity के नीचे रहती हैं।',
  'activity.ready': 'तैयार',
  'activity.open': 'अगली बार वहीं खोलें',

  'validate.boolean': 'true या false होना चाहिए',
  'validate.number': 'संख्या होनी चाहिए',
  'validate.min': 'न्यूनतम: {{min}}',
  'validate.max': 'अधिकतम: {{max}}',
  'validate.string': 'स्ट्रिंग होनी चाहिए',
  'validate.tooLong': 'बहुत लंबा (अधिकतम {{max}} अक्षर)',
  'validate.pattern': 'इससे मेल खाना चाहिए: {{pattern}}',
  'validate.oneOf': 'इनमें से एक होना चाहिए: {{options}}',
  'validate.list': 'सूची होनी चाहिए',
  'validate.json': 'मान्य JSON होना चाहिए (स्ट्रिंग नहीं)',

  'schema._root.label': 'सामान्य',
  'schema._root.description': 'ऑटो-अपडेट और शीर्ष-स्तरीय सेटिंग्स',
  'schema.ai.label': 'AI और embeddings',
  'schema.ai.description':
    'सिमैंटिक सर्च, सारांश और intent वर्गीकरण के लिए AI प्रोवाइडर',
  'schema.security.label': 'सिक्योरिटी',
  'schema.security.description': 'सीक्रेट पहचान और फ़ाइल सीमाएँ',
  'schema.predictive.label': 'प्रेडिक्टिव विश्लेषण',
  'schema.predictive.description': 'बग पूर्वानुमान, टेक-डेट स्कोरिंग, change risk',
  'schema.intent.label': 'Intent और डोमेन',
  'schema.intent.description': 'डोमेन वर्गीकरण और ऑटो-टैगिंग',
  'schema.runtime.label': 'रनटाइम ट्रेसिंग (OTLP)',
  'schema.runtime.description': 'OpenTelemetry span ingestion और trace विश्लेषण',
  'schema.topology.label': 'क्रॉस-रिपो टोपोलॉजी',
  'schema.topology.description': 'सबप्रोजेक्ट और क्रॉस-सर्विस डिपेंडेंसी ट्रैकिंग',
  'schema.lsp.label': 'LSP enrichment',
  'schema.lsp.description': 'Language Server Protocol से कंपाइलर-स्तर call graph resolution',
  'schema.quality_gates.label': 'क्वालिटी गेट',
  'schema.quality_gates.description': 'कमिट और PR पर स्वचालित क्वालिटी जाँच',
  'schema.tools.label': 'टूल एक्सपोज़र',
  'schema.tools.description': 'कौन से MCP टूल और कैसे दिखें, यह तय करें',
  'schema.ignore.label': 'Ignore नियम',
  'schema.ignore.description': 'इंडेक्सिंग के दौरान छोड़ने के लिए अतिरिक्त डायरेक्टरी और पैटर्न',
  'schema.frameworks.label': 'फ़्रेमवर्क',
  'schema.frameworks.description': 'फ़्रेमवर्क-विशिष्ट सेटिंग्स (Laravel वगैरह)',
  'schema.logging.label': 'लॉगिंग',
  'schema.logging.description': 'फ़ाइल लॉगिंग और रोटेशन',
  'schema.watch.label': 'फ़ाइल वॉचर',
  'schema.watch.description': 'फ़ाइल बदलने पर अपने आप reindex',

  'schema.f.enabled': 'चालू',
  'schema.f.baseUrl': 'Base URL',
  'schema.f.apiKey': 'API key',
  'schema.f.inferenceModel': 'Inference मॉडल',
  'schema.f.fastModel': 'Fast मॉडल',
  'schema.f.embeddingModel': 'Embedding मॉडल',
  'schema.f.rerankerModel': 'Reranker मॉडल',
  'schema.f.autoDetect': 'सर्वर अपने आप पहचानें',
  'schema.f.batchSize': 'Batch साइज़',

  'schema._root.auto_update.label': 'ऑटो-अपडेट',
  'schema._root.interval.label': 'अपडेट जाँच अंतराल (घंटे)',
  'schema._root.logLevel.label': 'डेमन लॉग स्तर',

  'schema.ai.provider.label': 'प्रोवाइडर',
  'schema.ai.provider.description':
    'onnx = लोकल, बिना कॉन्फ़िग। ollama/lmstudio = लोकल, मॉडल चुनने की सुविधा के साथ। gemini = Google Generative Language API (कंज़्यूमर, AIza key)। vertex = Google Vertex AI (GCP, OAuth bearer token + project/location)। voyage = केवल Voyage AI embeddings। बाकी = क्लाउड API।',
  'schema.ai.embedding.label': 'Embeddings इस्तेमाल करें',
  'schema.ai.embedding.description':
    'सिमैंटिक सर्च और reranking के लिए वेक्टर embeddings बनाएँ। बंद करने पर inference चलती रहेगी, सिमैंटिक सर्च बंद हो जाएगी।',
  'schema.ai.inference.label': 'Inference इस्तेमाल करें',
  'schema.ai.inference.description':
    'सारांश, intent वर्गीकरण और Ask के लिए LLM कॉल करें। बंद करने पर embeddings चलती रहेंगी, सभी LLM कॉल छूट जाएँगी।',
  'schema.ai.fast_inference.label': 'Fast inference इस्तेमाल करें',
  'schema.ai.fast_inference.description':
    'कम-लेटेंसी कामों के लिए fast मॉडल इस्तेमाल करें। बंद होने पर fast-path कॉलर को खाली जवाब मिलते हैं — डीबग के अलावा इसे चालू रखें।',

  'schema.ai.ollama.base_url.description':
    'Ollama सर्वर endpoint। दूसरे होस्ट या पोर्ट पर चल रहा हो तो बदलें।',
  'schema.ai.lmstudio.base_url.description': 'LM Studio का लोकल सर्वर endpoint।',
  'schema.ai.openai.base_url.description':
    'OpenAI API endpoint। Azure OpenAI या संगत प्रोवाइडर के लिए बदलें।',
  'schema.ai.openai.api_key.description': 'ज़रूरी। या OPENAI_API_KEY env var सेट करें।',
  'schema.ai.anthropic.api_key.description':
    'console.anthropic.com से Anthropic API key। या ANTHROPIC_API_KEY env var सेट करें।',
  'schema.ai.gemini.api_key.description':
    'ai.google.dev से Google Generative Language API key (AIza से शुरू)। या GEMINI_API_KEY env var सेट करें। GCP/Vertex के लिए इसकी जगह "vertex" प्रोवाइडर चुनें।',
  'schema.ai.vertex.api_key.label': 'Access token',
  'schema.ai.vertex.api_key.description':
    'OAuth2 bearer token (अल्पकालिक, ~1 घंटा)। इससे बनाएँ: gcloud auth print-access-token। या GOOGLE_ACCESS_TOKEN env var सेट करें।',
  'schema.ai.vertex.project.label': 'GCP प्रोजेक्ट',
  'schema.ai.vertex.project.description':
    'Vertex AI होस्ट करने वाला Google Cloud project ID। या GOOGLE_CLOUD_PROJECT env var सेट करें।',
  'schema.ai.vertex.location.label': 'GCP लोकेशन',
  'schema.ai.vertex.location.description':
    'Vertex AI रीजन (जैसे us-central1, europe-west4, asia-northeast1)। या GOOGLE_CLOUD_LOCATION env var सेट करें।',
  'schema.ai.voyage.base_url.description': 'Voyage AI endpoint। आमतौर पर डिफ़ॉल्ट ही।',
  'schema.ai.voyage.api_key.description':
    'dash.voyageai.com से Voyage API key। या VOYAGE_API_KEY env var सेट करें। केवल embeddings — inference नहीं।',
  'schema.ai.mistral.base_url.description': 'Mistral API endpoint।',
  'schema.ai.mistral.api_key.description':
    'console.mistral.ai से Mistral API key। या MISTRAL_API_KEY env var सेट करें।',
  'schema.ai.groq.base_url.description': 'Groq API endpoint।',
  'schema.ai.groq.api_key.description': 'console.groq.com से Groq API key। या GROQ_API_KEY env var सेट करें।',
  'schema.ai.together.base_url.description': 'Together AI API endpoint।',
  'schema.ai.together.api_key.description':
    'api.together.ai से Together API key। या TOGETHER_API_KEY env var सेट करें।',
  'schema.ai.deepseek.base_url.description': 'DeepSeek API endpoint।',
  'schema.ai.deepseek.api_key.description':
    'platform.deepseek.com से DeepSeek API key। या DEEPSEEK_API_KEY env var सेट करें।',
  'schema.ai.xai.base_url.description': 'xAI (Grok) API endpoint।',
  'schema.ai.xai.api_key.description': 'console.x.ai से xAI API key। या XAI_API_KEY env var सेट करें।',

  'schema.ai.ollama.inference_model.description': 'सारांश और intent वर्गीकरण के लिए LLM।',
  'schema.ai.ollama.fast_model.description':
    'कम-लेटेंसी कामों के लिए छोटा/तेज़ LLM। न मिलने पर inference मॉडल पर लौटता है।',
  'schema.ai.ollama.embedding_model.description':
    'सिमैंटिक सर्च के लिए embedding मॉडल। embedding_dimensions से मेल खाना चाहिए।',
  'schema.ai.ollama.reranker_model.description': 'खोज परिणामों के re-ranking के लिए cross-encoder।',
  'schema.ai.lmstudio.inference_model.description': 'LM Studio में लोड किया गया LLM।',
  'schema.ai.lmstudio.fast_model.description': 'कम-लेटेंसी कामों के लिए तेज़ LLM।',
  'schema.ai.lmstudio.embedding_model.description': 'LM Studio में लोड किया गया embedding मॉडल।',
  'schema.ai.openai.inference_model.description': 'सारांश और intent वर्गीकरण के लिए LLM।',
  'schema.ai.openai.fast_model.description': 'तेज़/सस्ता LLM। न मिलने पर inference मॉडल पर लौटता है।',
  'schema.ai.openai.embedding_model.description':
    'text-embedding-3-small (सस्ता) या text-embedding-3-large (ज़्यादा सटीक)।',
  'schema.ai.anthropic.inference_model.description': 'सारांश और तर्क के लिए Claude मॉडल।',
  'schema.ai.anthropic.fast_model.description': 'कम-लेटेंसी कामों के लिए सबसे तेज़ Claude मॉडल।',
  'schema.ai.gemini.inference_model.description': 'सारांश के लिए Gemini मॉडल।',
  'schema.ai.gemini.fast_model.description': 'कम-लेटेंसी कामों के लिए तेज़ Gemini मॉडल।',
  'schema.ai.gemini.embedding_model.description':
    'Gemini embedding मॉडल। text-embedding-004 (768d) अनुशंसित है।',
  'schema.ai.vertex.inference_model.description':
    'सारांश के लिए Vertex पर होस्ट मॉडल (जैसे gemini-2.5-flash, gemini-2.5-pro)।',
  'schema.ai.vertex.fast_model.description': 'कम-लेटेंसी कामों के लिए तेज़ Vertex मॉडल।',
  'schema.ai.vertex.embedding_model.description':
    'Vertex embedding मॉडल (जैसे text-embedding-005 768d, gemini-embedding-001 3072d)।',
  'schema.ai.voyage.embedding_model.description':
    'Voyage embedding मॉडल। voyage-code-3 (1024d) सोर्स कोड के लिए बना है।',
  'schema.ai.mistral.inference_model.description': 'सारांश के लिए Mistral LLM।',
  'schema.ai.mistral.fast_model.description': 'तेज़ Mistral मॉडल।',
  'schema.ai.mistral.embedding_model.description': 'Mistral embedding मॉडल (1024d)।',
  'schema.ai.groq.inference_model.description': 'Groq पर होस्ट LLM। बेहद तेज़ inference।',
  'schema.ai.groq.fast_model.description': 'कम-लेटेंसी कामों के लिए सबसे तेज़ Groq मॉडल।',
  'schema.ai.groq.embedding_model.description': 'Groq embedding मॉडल।',
  'schema.ai.together.inference_model.description': 'Together पर होस्ट LLM।',
  'schema.ai.together.fast_model.description': 'तेज़ Together मॉडल।',
  'schema.ai.together.embedding_model.description': 'Together embedding मॉडल।',
  'schema.ai.deepseek.inference_model.description': 'सारांश और तर्क के लिए DeepSeek V3।',
  'schema.ai.deepseek.fast_model.description': 'DeepSeek का तेज़ मॉडल।',
  'schema.ai.xai.inference_model.description': 'सारांश के लिए Grok मॉडल।',
  'schema.ai.xai.fast_model.description': 'तेज़ Grok मॉडल।',
  'schema.ai.onnx.embedding_model.description':
    'लोकल embeddings के लिए ONNX मॉडल। डिफ़ॉल्ट बिना किसी सेटअप के काम करता है।',

  'schema.ai.dimensions.label': 'Embedding dimensions',
  'schema.ai.dimensions.description':
    'वेक्टर का आकार। मॉडल से मेल खाना चाहिए (MiniLM के लिए 384, nomic/Gemini/Vertex text-embedding-005 के लिए 768, Mistral/voyage-code-3 के लिए 1024, OpenAI के लिए 1536, gemini-embedding-001 के लिए 3072)।',
  'schema.ai.summarize.label': 'इंडेक्स करते समय सारांश बनाएँ',
  'schema.ai.summarize.description':
    'इंडेक्सिंग के दौरान सामान्य भाषा में सारांश बनाएँ। इसके लिए inference मॉडल वाला प्रोवाइडर चाहिए।',
  'schema.ai.summarize_batch.label': 'सारांश batch साइज़',
  'schema.ai.summarize_batch.description': 'हर batch में एक साथ कितने सिंबल का सारांश बने।',
  'schema.ai.summarize_kinds.label': 'सारांश के प्रकार',
  'schema.ai.summarize_kinds.description': 'किन तरह के सिंबल का सारांश बनाया जाए।',
  'schema.ai.concurrency.label': 'समानांतरता',
  'schema.ai.concurrency.description': 'समानांतर AI रिक्वेस्ट। Ollama के लिए OLLAMA_NUM_PARALLEL से मिलाएँ।',

  'schema.security.secret_patterns.label': 'सीक्रेट पैटर्न',
  'schema.security.max_file_size.label': 'अधिकतम फ़ाइल आकार (bytes)',
  'schema.security.max_files.label': 'प्रति प्रोजेक्ट अधिकतम फ़ाइलें',

  'schema.predictive.cache_ttl.label': 'कैश TTL (मिनट)',
  'schema.predictive.git_since.label': 'Git इतिहास (दिन)',
  'schema.predictive.module_depth.label': 'मॉड्यूल गहराई',
  'schema.predictive.weights.label': 'वेट',
  'schema.predictive.weights.description': 'बग/डेट/रिस्क स्कोरिंग के वेट',

  'schema.intent.auto_classify.label': 'इंडेक्स करते समय अपने आप वर्गीकरण',
  'schema.intent.domain_hints.label': 'डोमेन संकेत',
  'schema.intent.domain_hints.description': '{ "domain": ["path/**"] }',
  'schema.intent.custom_domains.label': 'कस्टम डोमेन',
  'schema.intent.custom_domains.description': '[{ name, path_patterns }]',

  'schema.runtime.port.label': 'OTLP पोर्ट',
  'schema.runtime.host.label': 'OTLP होस्ट',
  'schema.runtime.max_body.label': 'अधिकतम body bytes',
  'schema.runtime.max_span_age.label': 'अधिकतम span आयु (दिन)',
  'schema.runtime.max_aggregate_age.label': 'अधिकतम aggregate आयु (दिन)',
  'schema.runtime.prune_interval.label': 'Prune अंतराल',
  'schema.runtime.fqn_attributes.label': 'FQN attributes',
  'schema.runtime.route_patterns.label': 'रूट पैटर्न',

  'schema.topology.auto_detect.label': 'रिपो अपने आप पहचानें',
  'schema.topology.auto_discover.label': 'सबप्रोजेक्ट अपने आप खोजें',
  'schema.topology.repos.label': 'अतिरिक्त रिपो पाथ',
  'schema.topology.contract_globs.label': 'Contract globs',

  'schema.lsp.enabled.description': 'इंडेक्सिंग के बाद LSP enrichment पास चालू करें',
  'schema.lsp.auto_detect.description':
    'उपलब्ध LSP सर्वर अपने आप पहचानें (tsserver, pyright, gopls, rust-analyzer)',
  'schema.lsp.max_servers.label': 'अधिकतम समानांतर सर्वर',
  'schema.lsp.max_servers.description': 'समानांतर LSP सर्वर प्रोसेस की सीमा',
  'schema.lsp.timeout.label': 'Enrichment टाइमआउट (ms)',
  'schema.lsp.timeout.description': 'पूरे LSP enrichment पास का टाइमआउट',
  'schema.lsp.batch_size.description': 'हर batch में प्रोसेस होने वाले सिंबल',
  'schema.lsp.servers.label': 'सर्वर ओवरराइड',
  'schema.lsp.servers.description':
    '{ "typescript": { "command": "npx", "args": ["typescript-language-server", "--stdio"], "timeout_ms": 30000 } }',

  'schema.quality_gates.fail_on.label': 'इस पर फ़ेल करें',
  'schema.quality_gates.rules.label': 'नियम',
  'schema.quality_gates.rules.description': 'नियमों की सीमाएँ और गंभीरता',

  'schema.tools.preset.label': 'प्रीसेट',
  'schema.tools.include.label': 'ये टूल शामिल करें',
  'schema.tools.exclude.label': 'ये टूल हटाएँ',
  'schema.tools.description_verbosity.label': 'विवरण की विस्तार-मात्रा',
  'schema.tools.instructions_verbosity.label': 'निर्देशों की विस्तार-मात्रा',
  'schema.tools.meta_fields.label': 'Meta फ़ील्ड',
  'schema.tools.compact_schemas.label': 'कॉम्पैक्ट schemas',
  'schema.tools.compact_schemas.description':
    'टोकन खर्च घटाने के लिए टूल schemas से एडवांस्ड पैरामीटर हटाएँ (~42%)',
  'schema.tools.descriptions.label': 'कस्टम विवरण',
  'schema.tools.descriptions.description': '{ "tool_name": "description" }',

  'schema.ignore.directories.label': 'डायरेक्टरी',
  'schema.ignore.patterns.label': 'पैटर्न',

  'schema.frameworks.config.label': 'कॉन्फ़िगरेशन',
  'schema.frameworks.config.description': 'फ़्रेमवर्क ओवरराइड',

  'schema.logging.file.label': 'फ़ाइल लॉगिंग चालू करें',
  'schema.logging.path.label': 'लॉग फ़ाइल का पाथ',
  'schema.logging.level.label': 'लॉग स्तर',
  'schema.logging.max_size.label': 'अधिकतम लॉग आकार (MB)',

  'schema.watch.debounce.label': 'Debounce (ms)',

  /* ── Setup wizard ── */
  'app.setupWizard': "प्रारंभिक सेटअप विज़ार्ड",
  'app.runSetupWizard': "विज़ार्ड चलाएं…",
} as const;
