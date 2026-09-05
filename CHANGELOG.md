# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).


## [3.19.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.18.0...v3.19.0) (2026-09-05)


### Features

* **app:** ship the reworked icon and retire the bitmap generator (TRA-780) ([#949](https://github.com/nikolai-vysotskyi/trace-mcp/issues/949)) ([6f6c413](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6f6c4137f96534726e17f98e42f3b7c991acb0ad))


### Bug Fixes

* **app:** a KPI baseline needs an age, and its caption has to keep one (TRA-960) ([#974](https://github.com/nikolai-vysotskyi/trace-mcp/issues/974)) ([7465060](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7465060ed09683a16c561619641cb6b8be442794))
* **app:** tell a busy daemon from a missing one (TRA-939) ([#963](https://github.com/nikolai-vysotskyi/trace-mcp/issues/963)) ([d88864d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d88864d480c48b15a9f41cd5f0b22cc27bc510be))
* **app:** the Chinese guard card stops calling itself two names (TRA-953) ([#975](https://github.com/nikolai-vysotskyi/trace-mcp/issues/975)) ([c8976d7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c8976d70155e0580e2b0e25a5fb707a1aa37de5e))
* **app:** the Index card states one condition, not two (TRA-964) ([#980](https://github.com/nikolai-vysotskyi/trace-mcp/issues/980)) ([89449e6](https://github.com/nikolai-vysotskyi/trace-mcp/commit/89449e6b1034282be4fcc7e39609f0487c722e5e))
* **daemon:** share TopologyStore/DecisionStore/StateEngine across the whole daemon, not per project ([#954](https://github.com/nikolai-vysotskyi/trace-mcp/issues/954)) ([a9429c7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a9429c7a5bf7a07702494afa724722077ec876be))
* **daemon:** stop a running daemon from overriding the session's preset (TRA-951) ([#967](https://github.com/nikolai-vysotskyi/trace-mcp/issues/967)) ([345043c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/345043c285da52ac71f413752a4f3a76db82ac6c))
* **indexer:** index the metadata-existence checks in edge resolvers ([#952](https://github.com/nikolai-vysotskyi/trace-mcp/issues/952)) ([1fe7a70](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1fe7a70f633d1f5e0144c2dcc7309af804369711))
* **indexer:** stop rebuilding the TS/JS call-edge universe with an N+1 per symbol (TRA-923) ([#961](https://github.com/nikolai-vysotskyi/trace-mcp/issues/961)) ([699ec36](https://github.com/nikolai-vysotskyi/trace-mcp/commit/699ec3611040cb6ac5157944f23fae0155f7e871))
* **launcher:** reprobe past an app runtime shim whose target is gone ([#982](https://github.com/nikolai-vysotskyi/trace-mcp/issues/982)) ([3e749a0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3e749a02b3e2bbaa8fca9174c1b3fbdc034ba963))
* **server:** scope instructions to the session's advertised tool surface ([#947](https://github.com/nikolai-vysotskyi/trace-mcp/issues/947)) ([b34b1ba](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b34b1bac422ace610a38ef6ce6b2771201028037))
* **tools:** publish get_change_impact's optional params as actually optional (TRA-962) ([#979](https://github.com/nikolai-vysotskyi/trace-mcp/issues/979)) ([d021ede](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d021edea336e50aab1e93dd3038fd9a36f378fe9))


### Performance

* **app:** measure and fix time to first useful paint, per screen ([#955](https://github.com/nikolai-vysotskyi/trace-mcp/issues/955)) ([f977d75](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f977d75fe1cb95164e062a652ab76155cd602dcd))
* **indexer:** make a reindex that finds nothing cost nothing (TRA-935) ([#964](https://github.com/nikolai-vysotskyi/trace-mcp/issues/964)) ([0066fcf](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0066fcf5480ae1c5f7a2391781123c7edf3d183c))
* **indexer:** stop probing every manifest name with its own syscall ([#950](https://github.com/nikolai-vysotskyi/trace-mcp/issues/950)) ([f5fdb5e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f5fdb5ec598da4fdc34f5e80fa59e73e84d60cae))
* **savings:** close the response-token measurement tail and stop crediting mutations (TRA-945) ([#965](https://github.com/nikolai-vysotskyi/trace-mcp/issues/965)) ([27f6808](https://github.com/nikolai-vysotskyi/trace-mcp/commit/27f6808552179ceb104bfa21121daedf44ba39f7))
* **session:** measure the per-session baseline instead of guessing at it (TRA-925) ([#962](https://github.com/nikolai-vysotskyi/trace-mcp/issues/962)) ([f27a723](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f27a723e8011744ce9252b6d62f907db071b950f))
* **tools:** stop three tools answering more than they were asked (TRA-952) ([#969](https://github.com/nikolai-vysotskyi/trace-mcp/issues/969)) ([93b3f7c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/93b3f7c5ac49f01e0bdc100daebe9241bd5949f0))


### Documentation

* **antipatterns:** record TRA-944 decision — leave detectMemoryLeak's LIKE group unindexed ([#960](https://github.com/nikolai-vysotskyi/trace-mcp/issues/960)) ([01b62d1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/01b62d1bb219b9ba1ee1d7483464aec0cfc95ad7))
* **comparisons:** read the largest table entry at source for the first time ([#945](https://github.com/nikolai-vysotskyi/trace-mcp/issues/945)) ([7f320dc](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7f320dc97799593f4ae09e9aff7370ff7cb9fe42))
* **comparisons:** the session-memory entry does not index code — it delegates ([#948](https://github.com/nikolai-vysotskyi/trace-mcp/issues/948)) ([44af510](https://github.com/nikolai-vysotskyi/trace-mcp/commit/44af510fa473c16f042e986f5e150eb6f00b4cda))
* make the home page eligible for the code graph mcp cluster ([#966](https://github.com/nikolai-vysotskyi/trace-mcp/issues/966)) ([8fcf9ff](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8fcf9ff59e296304df80ac6edb4b603a6e27c443))
* **ops:** inventory every persistent state change trace-mcp makes on a machine ([#953](https://github.com/nikolai-vysotskyi/trace-mcp/issues/953)) ([2f49b39](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2f49b3927eb75c78b460870fe690382b8d6232e1))
* **ops:** keep the issue-search readout in the private ledger, not the public one ([#958](https://github.com/nikolai-vysotskyi/trace-mcp/issues/958)) ([60e6637](https://github.com/nikolai-vysotskyi/trace-mcp/commit/60e6637f5ce4d8122c3df4d5062e8b7405811508))
* **ops:** record best-of-mcp-servers [#384](https://github.com/nikolai-vysotskyi/trace-mcp/issues/384), the third-party plugin surface, and how both were found (TRA-909) ([#938](https://github.com/nikolai-vysotskyi/trace-mcp/issues/938)) ([61ba971](https://github.com/nikolai-vysotskyi/trace-mcp/commit/61ba971acb2644ccb2807eb7d417b231f1b1cf7a))
* **ops:** two new list submissions and what the second seed of the competitor-README search returns (TRA-915) ([#941](https://github.com/nikolai-vysotskyi/trace-mcp/issues/941)) ([03af5f5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/03af5f5831cfeb773337ce947056771df312e2f9))
* recapture the app screenshots so the dark frame stops photographing the harness (TRA-958) ([#978](https://github.com/nikolai-vysotskyi/trace-mcp/issues/978)) ([ad03c8d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ad03c8de9dce980c83afce34182aea7d055fbaa2))
* refresh the app screenshots and correct a stale checklist claim (TRA-955) ([#970](https://github.com/nikolai-vysotskyi/trace-mcp/issues/970)) ([e8f1ee3](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e8f1ee31d5c14edd13321038ca66dc9996f1fd2c))


### Tests

* **design-tokens:** cover parseColor edge cases directly ([#971](https://github.com/nikolai-vysotskyi/trace-mcp/issues/971)) ([964a943](https://github.com/nikolai-vysotskyi/trace-mcp/commit/964a943108a010e2a15bcc3a328ce45b6dce2567))
* **launcher:** give the node-probe tests a budget that clears CI contention ([#973](https://github.com/nikolai-vysotskyi/trace-mcp/issues/973)) ([ab14512](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ab1451241609d75727cd4c4f2243447171b05a64))
* **manifests:** anchor the PR-benchmark exemption to the claim, not its neighbourhood (TRA-883) ([#914](https://github.com/nikolai-vysotskyi/trace-mcp/issues/914)) ([8ef271a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8ef271a09cd1ad8a1eebaf1207c63dff08ef2e8d))

## [3.18.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.17.1...v3.18.0) (2026-09-05)


### Features

* **analytics:** apply and roll back startup-context recommendations (TRA-769) ([#869](https://github.com/nikolai-vysotskyi/trace-mcp/issues/869)) ([e7760a6](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e7760a6c908a6334eaf2e5488d59f0f408f103e6))
* **analytics:** watch the startup block for growth and notify with one number (TRA-865) ([#907](https://github.com/nikolai-vysotskyi/trace-mcp/issues/907)) ([c2f806c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c2f806c8e8648d4f8fba00fd5d32ca383ea5029b))
* **app:** vector masters and a build script for the app icon (TRA-780) ([#925](https://github.com/nikolai-vysotskyi/trace-mcp/issues/925)) ([c308387](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c30838728375c64579b4cfbaedbc87d1462645a1))
* **docs:** the README download buttons fill the column on a phone (TRA-863) ([#901](https://github.com/nikolai-vysotskyi/trace-mcp/issues/901)) ([7ea2915](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7ea29150e32ac42f759e1c9ccdfe8f775617753e))
* **indexer:** resolve Ruby require/require_relative import edges (TRA-900) ([#934](https://github.com/nikolai-vysotskyi/trace-mcp/issues/934)) ([5d0ce9b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5d0ce9b7bcda841592f042e256583c7dd7415fbf))
* **state:** register the SKILL.state protocol as an MCP prompt (TRA-799) ([#859](https://github.com/nikolai-vysotskyi/trace-mcp/issues/859)) ([71ff604](https://github.com/nikolai-vysotskyi/trace-mcp/commit/71ff604d60fff23e9719af781402dd1435048c33))
* **tools:** per-call compute ceiling for heavy graph traversals ([#894](https://github.com/nikolai-vysotskyi/trace-mcp/issues/894)) ([2a54f5b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2a54f5bf6dc5c0b6167c8b0dfd4c8d6f3bbf816a))


### Bug Fixes

* **ai:** stop retrying a dead embedding endpoint forever, and stop logging a total failure as "completed" (TRA-812) ([#906](https://github.com/nikolai-vysotskyi/trace-mcp/issues/906)) ([9767f13](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9767f13a0019cc51abea22cdef70377f925bc5da))
* **analytics:** gate active_users.month while the window is still filling, and give the savings tripwire a receiver (TRA-843) ([#891](https://github.com/nikolai-vysotskyi/trace-mcp/issues/891)) ([cf5dbba](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cf5dbbaa24d70a83b7ce228705202c1158fe66af))
* **ci:** only a claimed issue collides in check-duplicate-pr (TRA-856) ([#897](https://github.com/nikolai-vysotskyi/trace-mcp/issues/897)) ([7ef5278](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7ef5278ecab5058888733d994514d3e25946e76c))
* **daemon:** attribute SIGTERM shutdowns with process-side exit context (TRA-809) ([#871](https://github.com/nikolai-vysotskyi/trace-mcp/issues/871)) ([2fdb122](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2fdb122a75d04939a1de5b4549b192f132b517d1))
* **daemon:** never index or watch a dangerous project root (TRA-893) ([#923](https://github.com/nikolai-vysotskyi/trace-mcp/issues/923)) ([b6ed7ec](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b6ed7ece5276d893c389a2af3a4ae8002bdc5e00))
* **daemon:** record who asks for every daemon stop (TRA-850) ([#893](https://github.com/nikolai-vysotskyi/trace-mcp/issues/893)) ([b43c1ca](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b43c1cad52230604276c355572b34bcceba5398b))
* **daemon:** stop the file watcher before awaiting the initial index on shutdown ([#881](https://github.com/nikolai-vysotskyi/trace-mcp/issues/881)) ([f420df4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f420df477f03e1be1d309355fa9a8152d4659737))
* **docs:** dark-appearance app screenshots for the landing gallery (TRA-851) ([#898](https://github.com/nikolai-vysotskyi/trace-mcp/issues/898)) ([e2ef85b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e2ef85bd444e4446b7ef8b2ab6ebd464ab022928))
* **guard:** move server↔hook sentinels out of $TMPDIR (TRA-869) ([#908](https://github.com/nikolai-vysotskyi/trace-mcp/issues/908)) ([d1612ac](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d1612ac8232d2a8aa4c24fcefcf5db54b3b3c03a))
* **indexer:** resolve C/C++ imports, the next language after Rust (TRA-832) ([#895](https://github.com/nikolai-vysotskyi/trace-mcp/issues/895)) ([dd1d948](https://github.com/nikolai-vysotskyi/trace-mcp/commit/dd1d94809ad0d385c09d0607660b942e93716dfd))
* **launcher:** pick the newest package backup, not the first one listed (TRA-881) ([#916](https://github.com/nikolai-vysotskyi/trace-mcp/issues/916)) ([1cf6c2b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1cf6c2bf5a04ffe9e143fbac693f5516d079634f))
* **launcher:** stop a throwaway TRACE_MCP_HOME from breaking the real MCP launcher path ([#937](https://github.com/nikolai-vysotskyi/trace-mcp/issues/937)) ([4120383](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4120383bed51cf470715babb6a305f554ab699f1))
* **mirror:** exempt spill reads, make the rewrite byte-deterministic (TRA-860) ([#903](https://github.com/nikolai-vysotskyi/trace-mcp/issues/903)) ([76b923b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/76b923b96457aba419f05b301b352d3dbccb300b))
* **scripts:** stop verify-upgrade-path.mjs from bouncing the real daemon (TRA-890) ([#921](https://github.com/nikolai-vysotskyi/trace-mcp/issues/921)) ([7c8f0b7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7c8f0b77d5fb2175149e86e4a612bd12bc9184f4))
* **tools:** report dropped fs events in get_index_health (TRA-813) ([#875](https://github.com/nikolai-vysotskyi/trace-mcp/issues/875)) ([73e772d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/73e772d5b24908b73309e1babf24e0066af12f3a))
* **watcher:** stop() must wait for a handler that already started (TRA-808) ([#866](https://github.com/nikolai-vysotskyi/trace-mcp/issues/866)) ([8d852b5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8d852b56f649c5a35a87eff5329dccfb288c81bb))


### Performance

* **app:** stop freezing the whole app for the length of a daemon restart (TRA-806) ([#867](https://github.com/nikolai-vysotskyi/trace-mcp/issues/867)) ([13375dd](https://github.com/nikolai-vysotskyi/trace-mcp/commit/13375dd3180195c34e1661288eb00a9007081254))
* **app:** time the synchronous half of every UI action, and record the 3.17.0 baseline (TRA-835) ([#904](https://github.com/nikolai-vysotskyi/trace-mcp/issues/904)) ([a600fff](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a600fff7e1ba22c3dab0f40297e239b16d9b8d39))
* **daemon:** release idle extract workers instead of holding ~420 MB forever (TRA-811) ([#874](https://github.com/nikolai-vysotskyi/trace-mcp/issues/874)) ([2972aee](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2972aeeecc837c0136e0d92cf5b266fb36660c42))
* **savings:** score token savings against the measured response, not a constant (TRA-880) ([#915](https://github.com/nikolai-vysotskyi/trace-mcp/issues/915)) ([f41969d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f41969de144e505df44c8a1d6533c6096ad25217))


### Documentation

* **comparisons:** profile the largest unread peer, take its measurement discipline ([#940](https://github.com/nikolai-vysotskyi/trace-mcp/issues/940)) ([e58c653](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e58c6533704de6fc12c34a15fb8d40054e80f9cc))
* **comparisons:** profile the last unread large peer at source, file the two mechanisms worth taking ([#880](https://github.com/nikolai-vysotskyi/trace-mcp/issues/880)) ([8e9773b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8e9773b8864a1ac3fb43d0feb4ff4782a01291cb))
* **comparisons:** record the discipline gap as closed, not open ([#944](https://github.com/nikolai-vysotskyi/trace-mcp/issues/944)) ([507719a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/507719a806e514fbf285ad3ca2336e4b9dc069b0))
* **design-web:** correct §1a — the wordmark is Space Mono Bold outlined, not redrawn ([#873](https://github.com/nikolai-vysotskyi/trace-mcp/issues/873)) ([502ef6e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/502ef6e9a2435507edbdf1e1e4d786d5f076c18c))
* guard the searchable name after the trace rename (TRA-879) ([#911](https://github.com/nikolai-vysotskyi/trace-mcp/issues/911)) ([f964514](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f9645147cd47039c98166ceb876881003c389b4f))
* guard the visible home page copy carries trace-mcp (TRA-907) ([#929](https://github.com/nikolai-vysotskyi/trace-mcp/issues/929)) ([86dea72](https://github.com/nikolai-vysotskyi/trace-mcp/commit/86dea7237797695828a23cea282317ef45435a1f))
* **init:** route agents to the SKILL.state tools (TRA-884) ([#913](https://github.com/nikolai-vysotskyi/trace-mcp/issues/913)) ([32aaadc](https://github.com/nikolai-vysotskyi/trace-mcp/commit/32aaadc6ec251586be35fe9c611e4827d77f590e))
* link the six /vs/ pages from the README; record the TRA-905 index-coverage decision ([#931](https://github.com/nikolai-vysotskyi/trace-mcp/issues/931)) ([b6be106](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b6be106f3ffbf3568023ff118d377e61026ddc2e))
* **ops:** index-coverage ledger — 11 of 24 pages unindexed, nothing crawled since 08-29 (TRA-791) ([#854](https://github.com/nikolai-vysotskyi/trace-mcp/issues/854)) ([cb1abbe](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cb1abbedb415a2328f42261a0b4ed1394e4f6939))
* **ops:** move the confidential half of ops/ to a private repo ([#917](https://github.com/nikolai-vysotskyi/trace-mcp/issues/917)) ([5ffd1ec](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5ffd1ec50218c39be4aa476cea5256b2d389a972))
* **ops:** name the category — one claim, two doors, and the share we may claim (TRA-906) ([#933](https://github.com/nikolai-vysotskyi/trace-mcp/issues/933)) ([7257442](https://github.com/nikolai-vysotskyi/trace-mcp/commit/72574424dc05408df1344ea7a90bdfc304971293))
* **ops:** record the ai-tooling evaluation and our one-time correction (TRA-857) ([#900](https://github.com/nikolai-vysotskyi/trace-mcp/issues/900)) ([721ee96](https://github.com/nikolai-vysotskyi/trace-mcp/commit/721ee9623372be0d81e9051e4bb8ae48c003afe9))
* **ops:** redact the names [#917](https://github.com/nikolai-vysotskyi/trace-mcp/issues/917) left in the public ledger ([#922](https://github.com/nikolai-vysotskyi/trace-mcp/issues/922)) ([00c8d36](https://github.com/nikolai-vysotskyi/trace-mcp/commit/00c8d366aec1c36aa1e63cbac3e60963487ac626))
* **ops:** resolve the two remaining backend-slot doors, record an outside benchmark that went against the category (TRA-872) ([#909](https://github.com/nikolai-vysotskyi/trace-mcp/issues/909)) ([28e8444](https://github.com/nikolai-vysotskyi/trace-mcp/commit/28e8444a61e5aece528c00fc4fd165b4836677d2))
* **ops:** the same referrer finding, second occurrence in the same file ([#924](https://github.com/nikolai-vysotskyi/trace-mcp/issues/924)) ([59e50ed](https://github.com/nikolai-vysotskyi/trace-mcp/commit/59e50edc0ace1c2ea958c3e640e3de1add8e6524))
* **ops:** user-signal run 2026-09-05 — code search as a channel, first external evaluation ([#882](https://github.com/nikolai-vysotskyi/trace-mcp/issues/882)) ([67a5152](https://github.com/nikolai-vysotskyi/trace-mcp/commit/67a5152dfe9e519f1ea2ac64a279f9cef3d44e10))
* **perf:** preregister and version-stamp every published benchmark (TRA-920) ([#943](https://github.com/nikolai-vysotskyi/trace-mcp/issues/943)) ([1cb706f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1cb706f3b87551dfc65e5dd224f1691d1de8e76b))
* restate every published savings number on the corrected basis (TRA-904) ([#935](https://github.com/nikolai-vysotskyi/trace-mcp/issues/935)) ([8277782](https://github.com/nikolai-vysotskyi/trace-mcp/commit/82777821b129f3ac691224a49fa715eefc80a3a5))
* **roadmap:** revision 2026-09-05 — the savings counter was an identity, presets move 3.5% of the block (TRA-898) ([#927](https://github.com/nikolai-vysotskyi/trace-mcp/issues/927)) ([eed47d9](https://github.com/nikolai-vysotskyi/trace-mcp/commit/eed47d924fd8ce678de29b2e12407bf9d49f18b0))
* **seo:** retarget the telemetry page at the 'mcp tracing' query (TRA-897) ([#926](https://github.com/nikolai-vysotskyi/trace-mcp/issues/926)) ([0bae384](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0bae38456f7065fb45c5709cddcc9c762c9cb7cf))
* **seo:** stop conceding a benchmark we now have on three /vs/ pages (TRA-876) ([#910](https://github.com/nikolai-vysotskyi/trace-mcp/issues/910)) ([1912101](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1912101d3d192e20b3500fc9acbce715303c564a))
* **site:** add Team section ([#920](https://github.com/nikolai-vysotskyi/trace-mcp/issues/920)) ([f726ddf](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f726ddf86ebbccfc02b9ca8b3eadbe1fd5950dfa))


### Tests

* **indexer:** stop the crash-loop dedup case from depending on any timer (TRA-885) ([#918](https://github.com/nikolai-vysotskyi/trace-mcp/issues/918)) ([f3ab9ac](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f3ab9ac330adc6d4ceb682293d59b28cff7929f1))
* **indexer:** stop the crash-loop dedup case from running the idle timer ([#912](https://github.com/nikolai-vysotskyi/trace-mcp/issues/912)) ([bc16f24](https://github.com/nikolai-vysotskyi/trace-mcp/commit/bc16f24d9e78b35950e53c78360b45cfa5b25c15))
* measure the mechanical share of real agent edits (TRA-862 gate — fails) ([#905](https://github.com/nikolai-vysotskyi/trace-mcp/issues/905)) ([f94bdba](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f94bdba3bd442ba0559f5031fc5675938196859c))
* **tools:** enforce cross-tool routing hints with a family drift gate (TRA-842) ([#888](https://github.com/nikolai-vysotskyi/trace-mcp/issues/888)) ([997526a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/997526aead844669633f0a54e8ceff00b0d11723))


### Chores

* **security:** deny-by-default token permissions in ga4-snapshot + scanner-config ledger (TRA-903) ([#928](https://github.com/nikolai-vysotskyi/trace-mcp/issues/928)) ([d82b279](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d82b2791552a7026a0d90b2585c12e8f31867b51))


### CI/CD

* **release:** attach provenance bundles and an SPDX SBOM to releases (TRA-902) ([#932](https://github.com/nikolai-vysotskyi/trace-mcp/issues/932)) ([dc81079](https://github.com/nikolai-vysotskyi/trace-mcp/commit/dc8107987d755ba6f5aab65aba674240c4745430))

## [3.17.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.17.0...v3.17.1) (2026-09-04)


### Bug Fixes

* **daemon:** stop reporting requested shutdowns as exit=1 (TRA-849) ([#890](https://github.com/nikolai-vysotskyi/trace-mcp/issues/890)) ([52e7e67](https://github.com/nikolai-vysotskyi/trace-mcp/commit/52e7e67a0adad5a82db2d71aee7f0b6ff975fe56))
* **docs:** a narrow banner cut so the README header stays readable on a phone (TRA-827) ([#877](https://github.com/nikolai-vysotskyi/trace-mcp/issues/877)) ([f0c0858](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f0c0858b44190b11547a03c223311782fa38d214))
* **hooks:** let Bash fall back when trace-mcp is unreachable (TRA-845) ([#889](https://github.com/nikolai-vysotskyi/trace-mcp/issues/889)) ([52c1531](https://github.com/nikolai-vysotskyi/trace-mcp/commit/52c153150d9bc8400a5ff22041cf959480d80620))
* **launcher:** refuse to heal launcher.env when the path is not a regular file ([#883](https://github.com/nikolai-vysotskyi/trace-mcp/issues/883)) ([73227a1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/73227a1079e6eebf2062a7f9a6d6664e85a200ca))
* **release:** import the Developer ID certificate ourselves (TRA-844) ([#887](https://github.com/nikolai-vysotskyi/trace-mcp/issues/887)) ([cc24562](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cc245627bdf22335b76882ce1ef4dfe470eea21a))
* **state:** bound the global state.db instead of growing it forever (TRA-830) ([#879](https://github.com/nikolai-vysotskyi/trace-mcp/issues/879)) ([5694c23](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5694c231f7c4d1eac2a8399bf5d200d879a26b35))
* **watcher:** reconcile the index when the OS drops fs events ([#892](https://github.com/nikolai-vysotskyi/trace-mcp/issues/892)) ([846f17b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/846f17bf160004d84f9fa32e86c682a80c289ecc))


### Documentation

* **design-web:** an un-paired app screenshot is a finding, not a milder pair bug (TRA-851) ([#885](https://github.com/nikolai-vysotskyi/trace-mcp/issues/885)) ([6443a53](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6443a5365f42fa55f08ac1e34f69edf92b290e71))
* **ops:** record claude-code-templates in the distribution ledger (TRA-846) ([#886](https://github.com/nikolai-vysotskyi/trace-mcp/issues/886)) ([5417a07](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5417a07e8ece1e9da50b70329d4cb3ba0dd88952))
* **ops:** tokenomics listing merged, third arrivals window, backend-slot door class ([#884](https://github.com/nikolai-vysotskyi/trace-mcp/issues/884)) ([6c038f1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6c038f1b007a76553d7a9ec8d3cbc53a2bc0d6b8))
* regenerate the config index after db.path lost its default (TRA-810) ([#870](https://github.com/nikolai-vysotskyi/trace-mcp/issues/870)) ([a007163](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a007163365400a885d7957f9e1f526e59d6b3572))

## [3.17.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.16.0...v3.17.0) (2026-09-04)


### Features

* **analytics:** startup-context audit — what every session pays for before the first message ([#843](https://github.com/nikolai-vysotskyi/trace-mcp/issues/843)) ([b82c43d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b82c43d8cb7588e211c8d44418159d2e3170aeef))
* **analytics:** startup-text compressor — drop what the block already says (TRA-770) ([#845](https://github.com/nikolai-vysotskyi/trace-mcp/issues/845)) ([8a820f6](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8a820f6ec149b39ea03d787911aa7604c76ffeef))
* **app:** split app and daemon updates into independent checks ([#790](https://github.com/nikolai-vysotskyi/trace-mcp/issues/790)) ([93cc4e5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/93cc4e519af9629ce41f1dee59d4e3a3efb50453))
* **distribution:** publish the site URL to the MCP registry and npm (TRA-792) ([#855](https://github.com/nikolai-vysotskyi/trace-mcp/issues/855)) ([d0b3791](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d0b3791cc43f69a12cf1673870300a55a78b813a))
* **mirror:** default the Read/Bash window to 24/12, add an opt-in char cap (TRA-750) ([#832](https://github.com/nikolai-vysotskyi/trace-mcp/issues/832)) ([83ce1bb](https://github.com/nikolai-vysotskyi/trace-mcp/commit/83ce1bbd26dece7255836f605740b9e4bc0aad69))
* **site:** red means danger, not brand — monochrome CTA and chrome (TRA-739) ([#840](https://github.com/nikolai-vysotskyi/trace-mcp/issues/840)) ([78ecb0f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/78ecb0fb12694d3194f54a6ba7c3142e515cc8b3))


### Bug Fixes

* **app:** a number stops breaking in half, and a Korean word stops splitting (TRA-803) ([#865](https://github.com/nikolai-vysotskyi/trace-mcp/issues/865)) ([150a59f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/150a59fd0a623a161c2c3df4c545d7968b367192))
* **app:** clamp the sheet to the window so the first-run actions stay reachable (TRA-794) ([#856](https://github.com/nikolai-vysotskyi/trace-mcp/issues/856)) ([c018e52](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c018e520e9d087da2788b9c86dfe4114909f6420))
* **app:** the German KPI label no longer truncates and the wizard uses the app's informal tone (TRA-591) ([#838](https://github.com/nikolai-vysotskyi/trace-mcp/issues/838)) ([cc5916f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cc5916fef638ed7faac86e12c7210ddcd71a8659))
* **docs:** correct the stale tool/resource counts in the README diagram (TRA-608) ([#830](https://github.com/nikolai-vysotskyi/trace-mcp/issues/830)) ([a3ef5b7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a3ef5b707af6bb365a5138c395a7cf2e0236b184))
* **docs:** regenerate config-index after db.path lost its schema default ([e8b5064](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e8b5064f753134c2ddbb05ced99b383bd32f589d))
* **docs:** regenerate llms-full.txt alongside the config index ([81f9a6d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/81f9a6d1adf2910ceb757eba06d5239575318a68))
* **docs:** regenerate stale sitemap lastmod ([#858](https://github.com/nikolai-vysotskyi/trace-mcp/issues/858)) ([58d8f04](https://github.com/nikolai-vysotskyi/trace-mcp/commit/58d8f04b5cfd6d7be12e722da835a6875ffa6562))
* **docs:** stop the sitemap guard failing on merge-date drift (TRA-800) ([#862](https://github.com/nikolai-vysotskyi/trace-mcp/issues/862)) ([868dae8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/868dae844631f3eea55dfb4b3437b86d26b0bbe5))
* **hooks:** port the guard v2 navigation gate to Windows (TRA-757) ([#836](https://github.com/nikolai-vysotskyi/trace-mcp/issues/836)) ([cbe59bf](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cbe59bfee1e2d2327af9aed8b26522c47f7280dc))
* **launcher:** an unreadable launcher.env must not kill the server (TRA-797) ([#861](https://github.com/nikolai-vysotskyi/trace-mcp/issues/861)) ([1b4bdcd](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1b4bdcd35b9edab575d1d276a59e32dfdea95b19))
* **launcher:** refuse to start the server on an unsupported node (TRA-755) ([#831](https://github.com/nikolai-vysotskyi/trace-mcp/issues/831)) ([9ca72dd](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9ca72dd8030bf7898a1dbbddfc9b616b7119858b))
* **launcher:** resolve node from a prefix only pkg_roots knows (TRA-742) ([#833](https://github.com/nikolai-vysotskyi/trace-mcp/issues/833)) ([7343980](https://github.com/nikolai-vysotskyi/trace-mcp/commit/734398071eea2bffe45bcd01f6c7dae9ed54065d))
* **server:** report the attached stdio session so the guard stops degrading (TRA-773) ([#846](https://github.com/nikolai-vysotskyi/trace-mcp/issues/846)) ([8f62854](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8f628548f57ae70dede0ce926b60515ae0f8713e))
* **server:** the client-profile notice was an instruction, not a note (TRA-796) ([#860](https://github.com/nikolai-vysotskyi/trace-mcp/issues/860)) ([1051fda](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1051fda34d2a386081efb03ff479f8d81a2cbef0))
* **state:** sweep orphaned tmp files in state subdirectories (TRA-783) ([#849](https://github.com/nikolai-vysotskyi/trace-mcp/issues/849)) ([0b6e428](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0b6e428ab6d48b1a7cfba47d67df4408d7b47f2d))
* **tools:** report the real index path in get_index_health (TRA-802) ([#864](https://github.com/nikolai-vysotskyi/trace-mcp/issues/864)) ([7a22fc2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7a22fc289f3779cfa50f189d4782f5f191d98e92))
* **web:** left-align comparison table cells kramdown centres (TRA-741) ([#821](https://github.com/nikolai-vysotskyi/trace-mcp/issues/821)) ([6305636](https://github.com/nikolai-vysotskyi/trace-mcp/commit/630563674af21417d1d38156c8426f4e6da34b60))


### Documentation

* benchmark_project is an estimator, not measured tool output (TRA-762) ([#837](https://github.com/nikolai-vysotskyi/trace-mcp/issues/837)) ([6299383](https://github.com/nikolai-vysotskyi/trace-mcp/commit/62993836dd98ca2b6934c40ff51f7fd3acfea304))
* **comparisons:** give CodeGraphContext a real hub summary (TRA-768) ([#847](https://github.com/nikolai-vysotskyi/trace-mcp/issues/847)) ([8905aa4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8905aa47cfabe74aae8a5a6d0b169e0626bbdb56))
* **comparisons:** give each head-to-head peer real coverage on the hub (TRA-767) ([#842](https://github.com/nikolai-vysotskyi/trace-mcp/issues/842)) ([3494fdb](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3494fdb9e26fc740b144d979434eb631f050cf73))
* **design-web:** the wordmark is the logo — grid, step, minimum size, lockups ([#848](https://github.com/nikolai-vysotskyi/trace-mcp/issues/848)) ([6287b6a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6287b6a71c4fe450a569112246de2fe1eba5f24d))
* generate a complete config index, and fix the preset-default claim (TRA-801) ([#863](https://github.com/nikolai-vysotskyi/trace-mcp/issues/863)) ([57762d4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/57762d49032e11c59c6bf7dc5c614202f4f7ddc9))
* **ops:** measured ledger of client start-block levers (TRA-771) ([#844](https://github.com/nikolai-vysotskyi/trace-mcp/issues/844)) ([accd5b4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/accd5b4735eb69d2b4cd52eaa54cf96098d58df7))
* **ops:** put the measured benchmark into the launch drafts (TRA-722) ([#813](https://github.com/nikolai-vysotskyi/trace-mcp/issues/813)) ([a842a7a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a842a7a96b22055dd0c3be65b4ba55abf989266e))
* **ops:** user-signal run 2026-09-03 — the ping is the channel, and by_client is 90% pre-fix (TRA-745) ([#824](https://github.com/nikolai-vysotskyi/trace-mcp/issues/824)) ([f7363aa](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f7363aaf3339bc5e087aaf7e5c99d63aa4fa1769))
* **seo:** structured data, citable comparison hub, and number-drift guards (TRA-419) ([#841](https://github.com/nikolai-vysotskyi/trace-mcp/issues/841)) ([586d016](https://github.com/nikolai-vysotskyi/trace-mcp/commit/586d01698965a6a4b18358bc1e8dbb30989f2a41))
* **site:** cobalt accent instead of red, README header as a generated banner ([#839](https://github.com/nikolai-vysotskyi/trace-mcp/issues/839)) ([b69cc0f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b69cc0fb4a0b2bdb6f97d92e10af6792b86aa65d))


### Chores

* **app-deps:** bump fast-uri and @xmldom/xmldom to patched versions ([#852](https://github.com/nikolai-vysotskyi/trace-mcp/issues/852)) ([1f4fca2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1f4fca2d03917e606afb40a920eed0790f1c28d2))
* **security:** scope ga4-snapshot permissions to the job, document alert triage ([#818](https://github.com/nikolai-vysotskyi/trace-mcp/issues/818)) ([531dcad](https://github.com/nikolai-vysotskyi/trace-mcp/commit/531dcad53bf9ed0970516f68721830d5dfa1efe9))


### CI/CD

* make the audit gate depend on advisories, not on npm's uptime ([#853](https://github.com/nikolai-vysotskyi/trace-mcp/issues/853)) ([4c38b3d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4c38b3d7253b3707feb350c14e76ca5e4e2e3f7b))
* unblock the board — audit job timeouts, and the docs lastmod master is red on ([#850](https://github.com/nikolai-vysotskyi/trace-mcp/issues/850)) ([a968ef8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a968ef81b7d6a282f1ff3708f866e3dd6701e7c3))

## [3.16.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.15.0...v3.16.0) (2026-09-03)


### Features

* **analytics:** publish the client-reporting gate in adoption.yml (TRA-748) ([#827](https://github.com/nikolai-vysotskyi/trace-mcp/issues/827)) ([70fa3ef](https://github.com/nikolai-vysotskyi/trace-mcp/commit/70fa3ef7fbc151d4ad9237a0133c5b9cb9e18bb1))
* **docs:** rebuild the first screen of the site and the README around one download (TRA-738) ([#819](https://github.com/nikolai-vysotskyi/trace-mcp/issues/819)) ([d2a8df9](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d2a8df93d93e590667fb171f538f9ba92e0db7d4))


### Bug Fixes

* **app:** the theme switcher applies without a restart (TRA-754) ([#828](https://github.com/nikolai-vysotskyi/trace-mcp/issues/828)) ([ac22e43](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ac22e430a409bfce2b8f7abdbe0411adb11f7b1b))
* **doctor:** stop flagging trace-mcp's own tool names as competitor directives ([a6b1017](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a6b1017c94fef6ef9cd6b56f1458f43bd367e3f5))
* **security:** patch fast-uri/qs advisories and enforce the audit invariant in CI (TRA-733) ([#817](https://github.com/nikolai-vysotskyi/trace-mcp/issues/817)) ([502168c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/502168cedef99acbb3c950f27528fc922449dcf3))


### Documentation

* **roadmap:** calls is a GA4 custom dimension, not a metric ([#826](https://github.com/nikolai-vysotskyi/trace-mcp/issues/826)) ([051b81b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/051b81bd9f53c08ea29c4f74cba6a7d585277725))

## [3.15.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.14.0...v3.15.0) (2026-09-03)


### Features

* **app:** detect a second installed trace-mcp.app bundle (TRA-692) ([#798](https://github.com/nikolai-vysotskyi/trace-mcp/issues/798)) ([04cfd79](https://github.com/nikolai-vysotskyi/trace-mcp/commit/04cfd797a8e7192e2263c4bc8c4b68787ecd0a2c))
* **app:** surface a second installed app copy in the app menu (TRA-692) ([d4c3f25](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d4c3f252e1ed1f294e87fbbd7bc79e619f0b0f8d))
* **app:** WindowTabBar becomes a real tab bar (TRA-700) ([#807](https://github.com/nikolai-vysotskyi/trace-mcp/issues/807)) ([e996dc2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e996dc261bdda77395ff07bd97b4f5a45a3dc957))
* **guard:** guard v2 — intervene only where the win is measured (TRA-711) ([#810](https://github.com/nikolai-vysotskyi/trace-mcp/issues/810)) ([f80bedd](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f80beddb4d1d5c5a39f252f46b0418c2cd2b143a))
* **hooks:** Read/Bash output mirror prototype (TRA-725, E1') ([#815](https://github.com/nikolai-vysotskyi/trace-mcp/issues/815)) ([40d5b32](https://github.com/nikolai-vysotskyi/trace-mcp/commit/40d5b327d716bb907b04acc4b8bff6a15e130034))
* **plugins:** add Agent Plugins v1.0.0 root manifest and MCP config (TRA-634) ([#791](https://github.com/nikolai-vysotskyi/trace-mcp/issues/791)) ([ea5c285](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ea5c28591b991b6b30ed34448156ce1d72ba7db5))


### Bug Fixes

* **analytics:** keep session ingestion current and make staleness visible (TRA-695) ([#802](https://github.com/nikolai-vysotskyi/trace-mcp/issues/802)) ([26ae439](https://github.com/nikolai-vysotskyi/trace-mcp/commit/26ae439d0d9c4da09637e5a7195c2d1bfd1dbf90))
* collect ~/.trace-mcp state that nothing ever swept (TRA-702) ([#804](https://github.com/nikolai-vysotskyi/trace-mcp/issues/804)) ([fc4d12e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fc4d12e46e39095f96a625c9720c307d7bb305ae))
* **daemon:** name the dropped dangerous root instead of re-asking for a hint (TRA-720) ([#814](https://github.com/nikolai-vysotskyi/trace-mcp/issues/814)) ([f1b0ec9](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f1b0ec988319db3eda42db2c61b2e80917dc66af))
* **daemon:** report cleanup-tier failures on project removal (TRA-559) ([#797](https://github.com/nikolai-vysotskyi/trace-mcp/issues/797)) ([17a3f12](https://github.com/nikolai-vysotskyi/trace-mcp/commit/17a3f1229ee4e0196e647f0807c222a4a944cd9e))
* **hooks:** strip CRLF from mirror hook output on Windows (TRA-743) ([#822](https://github.com/nikolai-vysotskyi/trace-mcp/issues/822)) ([cb03a86](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cb03a86be59ae6291fd18313b20123a8329e6e4e))
* **indexer:** stop mangling hyphenated CMake targets and add_subdirectory edges (TRA-622) ([#750](https://github.com/nikolai-vysotskyi/trace-mcp/issues/750)) ([d7667ba](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d7667ba868132060f457bebd26267b6df36fbf17))
* **launcher:** resolve cli.js independently of the selected node (TRA-701) ([#806](https://github.com/nikolai-vysotskyi/trace-mcp/issues/806)) ([e9df75d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e9df75d0aaf18efe006084c7691a9b533506f196))
* **launcher:** stop the legacy bin path freezing at its install-time shim (TRA-716) ([#809](https://github.com/nikolai-vysotskyi/trace-mcp/issues/809)) ([2a37a19](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2a37a192600fa2ff77a8a6bbad79a6f165f8ee04))
* **migration:** copy files byte-for-byte, not through a UTF-8 string (TRA-732) ([#816](https://github.com/nikolai-vysotskyi/trace-mcp/issues/816)) ([a4897c8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a4897c81a2787e4385a3f66cccee893afeb18475))
* **navigation:** resolve cwd-relative paths to the indexed file (TRA-693) ([#800](https://github.com/nikolai-vysotskyi/trace-mcp/issues/800)) ([833206a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/833206a822a17888dede22ecade2e5f745414cc9))
* **serve:** keep daemon auto-spawn off the stdio handshake path ([#805](https://github.com/nikolai-vysotskyi/trace-mcp/issues/805)) ([e6f3b67](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e6f3b6743d04490c3b0418847855d400e12ad509))
* **serve:** move auto-update off the MCP initialize path (TRA-703) ([#808](https://github.com/nikolai-vysotskyi/trace-mcp/issues/808)) ([ff2ebd7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ff2ebd7cb4c99be93760ecf2781957060b013b78))
* **web:** sweep the scroll hint, the one label nothing measured (TRA-564) ([#794](https://github.com/nikolai-vysotskyi/trace-mcp/issues/794)) ([478cdfe](https://github.com/nikolai-vysotskyi/trace-mcp/commit/478cdfe4d0d22dd0b9903cca5d1ea14ab0273361))


### Performance

* **app:** code-split the four secondary project tabs out of startup (TRA-593) ([#792](https://github.com/nikolai-vysotskyi/trace-mcp/issues/792)) ([39b3376](https://github.com/nikolai-vysotskyi/trace-mcp/commit/39b33760074224fd47f2d76b1b575e7014414fa8))
* **hooks:** detach the reindex dispatch so an edit never waits on the daemon ([#801](https://github.com/nikolai-vysotskyi/trace-mcp/issues/801)) ([5d7b516](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5d7b5160fe91807acd6eeb2f66ad212800f8ccac))


### Documentation

* **comparisons:** refresh peer facts and record this pass's source reads ([#777](https://github.com/nikolai-vysotskyi/trace-mcp/issues/777)) ([a7d08f1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a7d08f1fd2044992b16351b06fca010c2b138d61))
* competitor-vs-competitor page — Repomix vs codegraph ([#795](https://github.com/nikolai-vysotskyi/trace-mcp/issues/795)) ([34ffdf8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/34ffdf885d3e8dd628d9051c4e0bee495dcd13e0))
* **migration:** update docs, generators, and distribution ledger for the trace transition (TRA-615) ([#717](https://github.com/nikolai-vysotskyi/trace-mcp/issues/717)) ([40d1623](https://github.com/nikolai-vysotskyi/trace-mcp/commit/40d162310d7ce9b182c2d883a3f83414014d19fc))
* **seo:** link source files by GitHub URL instead of paths that 404 on the site ([#793](https://github.com/nikolai-vysotskyi/trace-mcp/issues/793)) ([85fbfde](https://github.com/nikolai-vysotskyi/trace-mcp/commit/85fbfde6db2b8be3b10181cbe6069d6949cc1551))
* **state:** say that trace_state_* is off the default surface (TRA-723) ([#811](https://github.com/nikolai-vysotskyi/trace-mcp/issues/811)) ([6db8777](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6db87772a9bedd9f7af9c0f8dc836ac2024e1f87))


### Tests

* **presets:** guard every preset's tools/list budget, not just the listed ones (TRA-719) ([#812](https://github.com/nikolai-vysotskyi/trace-mcp/issues/812)) ([039b64b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/039b64b2a8f928651f71eb514fef144eb661867e))


### CI/CD

* verify the Windows update path on a real install ([#775](https://github.com/nikolai-vysotskyi/trace-mcp/issues/775)) ([460ef4d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/460ef4d7b6b8fb47c19ea7796c4d735111aa6ea7))

## [3.14.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.13.0...v3.14.0) (2026-09-02)


### Features

* **docs:** publish the saved-token counter on the homepage and in the README ([#774](https://github.com/nikolai-vysotskyi/trace-mcp/issues/774)) ([0f56830](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0f56830fc39b1dbc73bfd43aa40f37baf44b3a8e))
* **tools:** ship the router preset and make batch-as-door deliberate (TRA-675) ([#785](https://github.com/nikolai-vysotskyi/trace-mcp/issues/785)) ([2ce3d20](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2ce3d20ac63960f13c0208a1b74dcf8cc8da62b6))


### Bug Fixes

* **search:** honor glob wildcards in search's file_pattern filter (TRA-676) ([#784](https://github.com/nikolai-vysotskyi/trace-mcp/issues/784)) ([4c9a77a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4c9a77a681bad7959a4c27112bfec9f88e629e62))


### Documentation

* **app:** warn app builds &lt;=3.10.0 they must reinstall (TRA-687) ([#786](https://github.com/nikolai-vysotskyi/trace-mcp/issues/786)) ([54f97f0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/54f97f0454b581c1785cb1586d49a7810dc82491))
* correct Multica agent mcp_config semantics ([#789](https://github.com/nikolai-vysotskyi/trace-mcp/issues/789)) ([a5e903a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a5e903af677e52df0537ab4700218ff093e1dd3d))
* lead with the benchmark measured on other people's code (TRA-647) ([#752](https://github.com/nikolai-vysotskyi/trace-mcp/issues/752)) ([4ee6b22](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4ee6b2258bc14655143875499881dcd21a2968bc))

## [3.13.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.12.0...v3.13.0) (2026-09-02)


### Features

* **tools:** explain empty results with a capped, data-derived note (TRA-680) ([#779](https://github.com/nikolai-vysotskyi/trace-mcp/issues/779)) ([024c76b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/024c76bc3dc724b46cf24858db8dd7ea13ce156f))


### Bug Fixes

* **site:** generate llms-full.txt, guard llms.txt against page drift (TRA-681) ([#780](https://github.com/nikolai-vysotskyi/trace-mcp/issues/780)) ([21cfc5b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/21cfc5b6aef7110fdd8d64dcef1eb49be457afc2))


### Performance

* **app:** let the Graph tab go quiet when nobody is watching (TRA-683) ([#783](https://github.com/nikolai-vysotskyi/trace-mcp/issues/783)) ([0c79f0e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0c79f0e240b13602fee54928993ea19da38945e5))
* **app:** reconcile both TRA-617 passes, measure the app offscreen, price the idle Graph tab ([#781](https://github.com/nikolai-vysotskyi/trace-mcp/issues/781)) ([942a206](https://github.com/nikolai-vysotskyi/trace-mcp/commit/942a206ba230f1560c00327c041af6ff77c574e8))


### Documentation

* add TechArticle schema to three pages and guard it in CI ([#776](https://github.com/nikolai-vysotskyi/trace-mcp/issues/776)) ([64214fb](https://github.com/nikolai-vysotskyi/trace-mcp/commit/64214fb5de52c7cc76dac5e08685acb6283b1131))
* **ops:** add third-party roundup surface class to distribution ledger ([#782](https://github.com/nikolai-vysotskyi/trace-mcp/issues/782)) ([59d3159](https://github.com/nikolai-vysotskyi/trace-mcp/commit/59d315915e6d28d36f2ecc611beb3a4327c7b85b))

## [3.12.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.11.0...v3.12.0) (2026-09-02)


### Features

* **app:** first-run setup wizard with MCP client detection and project guessing (TRA-439) ([#710](https://github.com/nikolai-vysotskyi/trace-mcp/issues/710)) ([bb75a32](https://github.com/nikolai-vysotskyi/trace-mcp/commit/bb75a322e3b708bccd5aaba42d96b3c4cbdfc6d3))
* **app:** flag legacy trace-mcp client entries and offer a one-click Migrate (TRA-614) ([#724](https://github.com/nikolai-vysotskyi/trace-mcp/issues/724)) ([3564a74](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3564a7472178de4bab664803c83acab1405a2079))
* **core,cli:** trace bin alias, McpServer identity, config paths, and client auto-migration (TRA-611) ([#730](https://github.com/nikolai-vysotskyi/trace-mcp/issues/730)) ([88eb73c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/88eb73cb23fac943f08ed94b83dfdc21d4dc1fd2))
* **eval:** measure SKILL.state savings on real sessions, not constants (TRA-600) ([#765](https://github.com/nikolai-vysotskyi/trace-mcp/issues/765)) ([310bbe2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/310bbe20eb15fb85fa7ce5ba3a7e927002d1d5ff))
* **state:** implement SKILL.state linear context engine (TRA-596) ([#715](https://github.com/nikolai-vysotskyi/trace-mcp/issues/715)) ([cdb5e5e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cdb5e5ee365791c1baefe9a1bf9eebf863be27f6))
* **telemetry:** put a funnel behind active installs (TRA-645) ([#745](https://github.com/nikolai-vysotskyi/trace-mcp/issues/745)) ([8196084](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8196084095a72cee172fea9b5c46564241e582ae))
* **telemetry:** read the ping's `calls` to measure use, not just setup (TRA-673) ([#773](https://github.com/nikolai-vysotskyi/trace-mcp/issues/773)) ([4e51fe6](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4e51fe68bc74769b972ee994025ad822dcc64f57))
* **telemetry:** report daemon starts and unclean stops in the daily ping (TRA-671) ([#770](https://github.com/nikolai-vysotskyi/trace-mcp/issues/770)) ([9b5a186](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9b5a186066213316245c227b06ccd1643ea0fd45))
* **telemetry:** report the active preset and advertised tool count, and fix the client-name clobber ([#748](https://github.com/nikolai-vysotskyi/trace-mcp/issues/748)) ([be1fb53](https://github.com/nikolai-vysotskyi/trace-mcp/commit/be1fb536952550df18944b375b112ff80e692740))
* **web:** cut the hero to one download and one command (TRA-609) ([#718](https://github.com/nikolai-vysotskyi/trace-mcp/issues/718)) ([d175595](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d1755950104b967619df19bb98708af102e4135d))


### Bug Fixes

* **analytics,hooks,plugins:** recognize trace as a trace-mcp server key (TRA-641) ([#755](https://github.com/nikolai-vysotskyi/trace-mcp/issues/755)) ([8a566c5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8a566c52d0228d70c5d494a70fd2466cbf9d7cad))
* **app:** a badge tint is opaque, so its measured contrast is the one it renders ([#731](https://github.com/nikolai-vysotskyi/trace-mcp/issues/731)) ([30dfca8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/30dfca8311809602b9360adce739af47e4f8f7bf))
* **app:** a file row shows its location whole or not at all (TRA-504) ([#725](https://github.com/nikolai-vysotskyi/trace-mcp/issues/725)) ([063c03b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/063c03b68839ec824467d567d05b9fe2ee195450))
* **app:** enable custom WindowTabBar across all platforms including macOS ([#716](https://github.com/nikolai-vysotskyi/trace-mcp/issues/716)) ([fd80d97](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fd80d973d437fca46adbdb9492879b091ebea82d))
* **app:** Project Overview states a section failure once, without inventing a cause (TRA-662) ([#762](https://github.com/nikolai-vysotskyi/trace-mcp/issues/762)) ([e55bd35](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e55bd3519cea97e7d9f1a51cac2484e119755444))
* **app:** spawn the CLI through a real executable on Windows (TRA-638) ([#738](https://github.com/nikolai-vysotskyi/trace-mcp/issues/738)) ([dae0869](https://github.com/nikolai-vysotskyi/trace-mcp/commit/dae08694d588213fe324b6143b32c16360c1b276))
* **app:** the guard card says "not running" once, and says what to do about it (TRA-490) ([#759](https://github.com/nikolai-vysotskyi/trace-mcp/issues/759)) ([e66fa3c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e66fa3c2d28e30702953c2c241bf8f8c90eff159))
* **ci:** exempt the release PR from the duplicate-work guard ([#736](https://github.com/nikolai-vysotskyi/trace-mcp/issues/736)) ([aca4e98](https://github.com/nikolai-vysotskyi/trace-mcp/commit/aca4e98b17e5ee689b2bdb9bc39d5cace7b1ca18))
* **db:** don't crash reindex on cross-file ORM associations (TRA-663) ([#763](https://github.com/nikolai-vysotskyi/trace-mcp/issues/763)) ([dc0b2e8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/dc0b2e86b17e2cf437972cb3f97b9bb2f84d52b6))
* **docs:** date sitemap pages by author date, not committer date (TRA-637) ([#729](https://github.com/nikolai-vysotskyi/trace-mcp/issues/729)) ([b2636ca](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b2636ca5e2302e84ccd3cb3b146d64396ca30c63))
* **indexer:** stop mangling multi-target .PHONY lines into one symbol (TRA-618) ([#721](https://github.com/nikolai-vysotskyi/trace-mcp/issues/721)) ([3b3c6a0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3b3c6a05b1c85d6b502f2f2c718eab39461dd6cd))
* **indexer:** stop truncating CMake include/find_package/add_subdirectory paths (TRA-670) ([#772](https://github.com/nikolai-vysotskyi/trace-mcp/issues/772)) ([4227a09](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4227a09ad68650c5a8420e7c35667ebbcf47de4f))
* **indexer:** support framework and manifest detection in monorepos ([#705](https://github.com/nikolai-vysotskyi/trace-mcp/issues/705)) ([#711](https://github.com/nikolai-vysotskyi/trace-mcp/issues/711)) ([9eaf1dd](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9eaf1dd3ad7a30c85dba5e4710236eeadf83a194))
* **init:** migrate legacy mcp__trace-mcp__ tool prefix in settings.json (TRA-650) ([#756](https://github.com/nikolai-vysotskyi/trace-mcp/issues/756)) ([699581d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/699581ddd33f144f0825cea6348edfe12a9c85e6))
* **release:** sign, notarize and staple the macOS DMG container ([#728](https://github.com/nikolai-vysotskyi/trace-mcp/issues/728)) ([e25a41d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e25a41d992b5a2f8cacb45d0db3f555a92e1eb0c))
* **scripts:** resolve the CLI state dir instead of hardcoding ~/.trace-mcp (TRA-667) ([#767](https://github.com/nikolai-vysotskyi/trace-mcp/issues/767)) ([e56f457](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e56f45738fca31ef98ce0eddca4a5da1ae7c0030))
* **server:** fall back to the default preset, not the full surface, on an unknown preset name (TRA-648) ([#753](https://github.com/nikolai-vysotskyi/trace-mcp/issues/753)) ([185e5f4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/185e5f4949c2b34ab7c68a87412295511273711a))
* **tests:** use file:// URLs for the trace-home subprocess harness (TRA-672) ([#769](https://github.com/nikolai-vysotskyi/trace-mcp/issues/769)) ([e0c2d99](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e0c2d99eaebddc86a898383a7e68c0d76af4c1ed))
* **update:** align Windows NSIS naming, fail-closed channel manifest audit, per-bundle running detection (TRA-592) ([#742](https://github.com/nikolai-vysotskyi/trace-mcp/issues/742)) ([0428744](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0428744f08459ab6701ce84744149f402a933c26))
* **web:** drive the homepage footer from docs_nav, and guard it (TRA-629) ([#733](https://github.com/nikolai-vysotskyi/trace-mcp/issues/733)) ([53a5045](https://github.com/nikolai-vysotskyi/trace-mcp/commit/53a5045cc2d8b6e62d0d1dcd62845a1cf519cb79))
* **web:** make the landing footer's doc list read down, and pull /Contact up ([#739](https://github.com/nikolai-vysotskyi/trace-mcp/issues/739)) ([648633c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/648633c3c8d055b3524b9b90e1734fc9c7cc74bb))
* **web:** raise --text-disabled and dark --accent to clear 4.5:1 (TRA-539) ([#719](https://github.com/nikolai-vysotskyi/trace-mcp/issues/719)) ([5857eba](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5857eba0f5fba074031642848e7ff41d09984444))
* **web:** stack the hero's two mono caps rows on a phone (TRA-607) ([#771](https://github.com/nikolai-vysotskyi/trace-mcp/issues/771)) ([2ef0977](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2ef0977f7e95e3cebe6a1af5068be232412ef605))


### Performance

* **app:** stop staging 132 MB the embedded daemon cannot reach (TRA-605) ([#743](https://github.com/nikolai-vysotskyi/trace-mcp/issues/743)) ([d434224](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d4342243a2082f2f502ed3170fe2df9ff6e2b9f1))
* **bench:** measure trace-mcp → trace token savings across 4 tokenizers (TRA-613) ([#720](https://github.com/nikolai-vysotskyi/trace-mcp/issues/720)) ([b41dc35](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b41dc3546763f31c54951912425b1b05a32abcb4))
* **tools:** land role-based tool presets with re-measured budgets (TRA-603, TRA-601) ([#732](https://github.com/nikolai-vysotskyi/trace-mcp/issues/732)) ([3d415e0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3d415e0cf8b6bb0026aafec2c4331e8c1d05f277))


### Documentation

* **config:** document Multica workspace agent MCP preset wiring (TRA-604) ([#747](https://github.com/nikolai-vysotskyi/trace-mcp/issues/747)) ([f3f2399](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f3f2399a6384cbe2121f62a2e56ccc0358619168))
* **configuration:** warn that --preset needs a release that has it (TRA-664) ([#764](https://github.com/nikolai-vysotskyi/trace-mcp/issues/764)) ([374248e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/374248e84516f3a353fda463fbb7f2c152398d27))
* **contributing:** record why master's protection is not strict ([#751](https://github.com/nikolai-vysotskyi/trace-mcp/issues/751)) ([ab73e39](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ab73e3969a1328bebe11acbe8fceb0c6af37ee3a))
* decide the trace rename — command, not project (TRA-644) ([#741](https://github.com/nikolai-vysotskyi/trace-mcp/issues/741)) ([2d8e305](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2d8e3057816f7423acf5c4c721f41e3aba12a380))
* link the docs pages into four topical clusters ([#757](https://github.com/nikolai-vysotskyi/trace-mcp/issues/757)) ([6f92234](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6f9223481cc000c16bf348d6894eb991bcae1da4))
* **ops:** two new agent-reachable directory doors, four closed with reasons (TRA-623) ([#722](https://github.com/nikolai-vysotskyi/trace-mcp/issues/722)) ([7d6be87](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7d6be87da916c693fd27263c76b85337c9271642))
* point the state-directory and CLI references at what the code actually does (TRA-666) ([#766](https://github.com/nikolai-vysotskyi/trace-mcp/issues/766)) ([2d05cb7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2d05cb79c252d104cadc99e3023c64fb0be67cef))
* read the PR-benchmark counts from the data file, not by hand ([#760](https://github.com/nikolai-vysotskyi/trace-mcp/issues/760)) ([b24b15b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b24b15bd51ab2bfd4d415d552ed94835a0d2c07c))
* refresh app screenshots at v3.11.0 (TRA-630) ([#746](https://github.com/nikolai-vysotskyi/trace-mcp/issues/746)) ([f0728a0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f0728a017859a4735b61dc579185f49684782f84))
* **roadmap:** activation measures setup, not use — read `calls` by client (TRA-668) ([#768](https://github.com/nikolai-vysotskyi/trace-mcp/issues/768)) ([bc97bb0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/bc97bb000a6c6da701f978fe9316f57d5739f6d9))
* **roadmap:** add the evidence item — the one outside measurement is on no entry surface (TRA-616) ([#749](https://github.com/nikolai-vysotskyi/trace-mcp/issues/749)) ([18f71e4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/18f71e4685345f1a65e4adc59f3f8765f6ada4e8))
* **roadmap:** record the State Engine positioning question (TRA-616) ([#754](https://github.com/nikolai-vysotskyi/trace-mcp/issues/754)) ([c322823](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c322823a5ef49bd71bd8946fd7f4943dda40e6b5))
* **roadmap:** revise for v3.11.0 — presets supersede tool consolidation, adoption is live (TRA-625) ([#740](https://github.com/nikolai-vysotskyi/trace-mcp/issues/740)) ([f47ad89](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f47ad890ebc0324566cc69cf0e29a6f5d05781f1))


### Tests

* **app:** give the AskTab lazy-import test a timeout that fits what it loads ([#734](https://github.com/nikolai-vysotskyi/trace-mcp/issues/734)) ([64b14a1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/64b14a12e62772f0af74820bda235b2236d110c8))
* **app:** wait for the guessed-project card before clicking Change folder (TRA-640) ([#761](https://github.com/nikolai-vysotskyi/trace-mcp/issues/761)) ([9e18e75](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9e18e75585a3f4a6851a1e7b240ee7908642cc1d))


### CI/CD

* fail when waiting_for_release is set against an unmerged PR (TRA-659) ([#758](https://github.com/nikolai-vysotskyi/trace-mcp/issues/758)) ([036c558](https://github.com/nikolai-vysotskyi/trace-mcp/commit/036c558c4f945d6190dc75acc09ac03d60cbc579))
* **release:** gate the Apple signing secrets behind a branch-protected environment ([#737](https://github.com/nikolai-vysotskyi/trace-mcp/issues/737)) ([dfd7bbd](https://github.com/nikolai-vysotskyi/trace-mcp/commit/dfd7bbd4727eba78913ae196c77ba16a71cad06f))

## [3.11.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.10.0...v3.11.0) (2026-09-01)


### Features

* **topology,memory:** add stale root pruning to topology.db and decisions.db (TRA-595) ([#714](https://github.com/nikolai-vysotskyi/trace-mcp/issues/714)) ([edb2fc8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/edb2fc88a79a6fc45ec413b5e1f11b5458cc8792))


### Bug Fixes

* **app:** clamp KpiTile label and comparison spans to preserve TILE_H (TRA-492) ([#713](https://github.com/nikolai-vysotskyi/trace-mcp/issues/713)) ([b4549ac](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b4549acd2900d2867ccd1fea7318d27d1881b875))
* **app:** remove broken native macOS tab bar under hiddenInset (TRA-587) ([#708](https://github.com/nikolai-vysotskyi/trace-mcp/issues/708)) ([891b1d8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/891b1d8efbe3d7f94809a3742388ae2887ae6c8b))
* **app:** resolve autoUpdater dynamic export and wrap long menu header status text ([#707](https://github.com/nikolai-vysotskyi/trace-mcp/issues/707)) ([c0b3083](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c0b3083074805488137fd63e6c6abdfa87277711))
* **init:** update tool routing table and stale hint references (TRA-579) ([#712](https://github.com/nikolai-vysotskyi/trace-mcp/issues/712)) ([b6b02ae](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b6b02ae49362aa8b3e74ee072a2144524ea33b2b))

## [3.10.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.9.0...v3.10.0) (2026-08-31)


### Features

* **app:** the app installs and repairs its own daemon (TRA-438) ([#692](https://github.com/nikolai-vysotskyi/trace-mcp/issues/692)) ([b8dd908](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b8dd9086838aa882f110668fab974ff92f9e3202))
* **bench:** measure PR-review context cost on 60 real merged PRs (TRA-534) ([#699](https://github.com/nikolai-vysotskyi/trace-mcp/issues/699)) ([aeb5080](https://github.com/nikolai-vysotskyi/trace-mcp/commit/aeb5080f58164f75ddff4bf193074991077d6563))
* **docs:** lead with the signed DMG on the site and in the README ([#697](https://github.com/nikolai-vysotskyi/trace-mcp/issues/697)) ([219dc3b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/219dc3be6d3935c410f30a43c1efc6bd431e653f))


### Bug Fixes

* **ci:** stop compiling better-sqlite3 — use its bundled prebuilds (TRA-567) ([#700](https://github.com/nikolai-vysotskyi/trace-mcp/issues/700)) ([d9f2a1e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d9f2a1ecd1d0c67b64da59f6bae9faf775bd82ea))
* **config:** rewrite the pre-v3.3 `tools.preset: "full"` default on upgrade (TRA-538) ([#693](https://github.com/nikolai-vysotskyi/trace-mcp/issues/693)) ([e8cc9dc](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e8cc9dc4a7d0353799c367d5fcabe5d85bd777f0))
* **indexer:** resolve Rust imports, the next language after Java (TRA-565) ([#698](https://github.com/nikolai-vysotskyi/trace-mcp/issues/698)) ([98ef908](https://github.com/nikolai-vysotskyi/trace-mcp/commit/98ef9086200e3b222f320bb829848ca3f73645a6))
* **release:** demote an unverified release out of `latest` (TRA-566) ([#701](https://github.com/nikolai-vysotskyi/trace-mcp/issues/701)) ([cf3afd1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cf3afd1421f8d2db30ebce9425306a2cc954b209))
* **site:** light-mode disabled text was measured against the wrong background ([#695](https://github.com/nikolai-vysotskyi/trace-mcp/issues/695)) ([90aaaa1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/90aaaa1b1e8445565bc2633b1f45e025b868bca3))


### Tests

* **update:** verify the upgrade path against real releases (TRA-562) ([#694](https://github.com/nikolai-vysotskyi/trace-mcp/issues/694)) ([a7de2d2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a7de2d26ce01d1d3718905d195757d80641aab03))

## [3.9.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.8.0...v3.9.0) (2026-08-30)


### Features

* **app:** move macOS to electron-updater and delete the staged-zip updater (TRA-437) ([#689](https://github.com/nikolai-vysotskyi/trace-mcp/issues/689)) ([b525048](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b5250484842085d0e08d481c56d13d2e894df72a))


### Documentation

* **ops:** rebalance the GitHub repo topics; note the Reddit referrer (TRA-393) ([#691](https://github.com/nikolai-vysotskyi/trace-mcp/issues/691)) ([d747bf9](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d747bf913e3a18cc0d402a4e2df7bfa201d01fb6))


### Tests

* **app:** cover the restart-budget guard where checkHealth calls it (TRA-558) ([#688](https://github.com/nikolai-vysotskyi/trace-mcp/issues/688)) ([eb94851](https://github.com/nikolai-vysotskyi/trace-mcp/commit/eb94851bf02f1b20a9e705966e32ea58304f50d9))

## [3.8.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.7.0...v3.8.0) (2026-08-30)


### Features

* **analytics:** price the saved-token counter server-side, capped for inflation ([#682](https://github.com/nikolai-vysotskyi/trace-mcp/issues/682)) ([fe5027c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fe5027c8825f4920ad9a901eae303af3a43dd4ae))
* **app:** sign and notarize macOS builds, ship DMG per architecture ([#584](https://github.com/nikolai-vysotskyi/trace-mcp/issues/584)) ([61c07d3](https://github.com/nikolai-vysotskyi/trace-mcp/commit/61c07d34cad901cee627ed2402705fe4afc16ae1))


### Bug Fixes

* **app:** a "starting" daemon must not refill the restart budget (TRA-543) ([#683](https://github.com/nikolai-vysotskyi/trace-mcp/issues/683)) ([b2aaecf](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b2aaecf2de048ffaf3c3451a1167d5fbb373b912))
* **daemon:** a losing spawn can no longer report the live daemon as dead (TRA-525) ([#663](https://github.com/nikolai-vysotskyi/trace-mcp/issues/663)) ([248374e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/248374e8bc624c8e4da547b83fe7668a77f673ce))
* **update:** re-check whether the app is running per bundle (TRA-555) ([#687](https://github.com/nikolai-vysotskyi/trace-mcp/issues/687)) ([03ebf63](https://github.com/nikolai-vysotskyi/trace-mcp/commit/03ebf635c212932cd18702db67e2751c13b15566))
* **update:** update every installed bundle, not just the resolved one (TRA-535) ([#672](https://github.com/nikolai-vysotskyi/trace-mcp/issues/672)) ([26d3eed](https://github.com/nikolai-vysotskyi/trace-mcp/commit/26d3eedb397323f6a5c167643d14ed16cd68d344))


### Documentation

* **ops:** draft the Reddit material (TRA-393) ([#656](https://github.com/nikolai-vysotskyi/trace-mcp/issues/656)) ([cc6a40e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cc6a40e662cf018101ecbdc19561ac92e93c65c7))
* **vs:** read Serena's source, correct four rows in its favour (TRA-547) ([#684](https://github.com/nikolai-vysotskyi/trace-mcp/issues/684)) ([391b90a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/391b90a878d6dd4c5bf2ea791a04c14fc5466859))

## [3.7.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.6.0...v3.7.0) (2026-08-30)


### Features

* **ops:** daily GA4 adoption snapshot into docs/_data/adoption.yml ([#673](https://github.com/nikolai-vysotskyi/trace-mcp/issues/673)) ([ecbf963](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ecbf9636f69b465e966318610b2f0db4a81b7452))
* **telemetry:** add client and timezone dimensions to the daily ping ([#659](https://github.com/nikolai-vysotskyi/trace-mcp/issues/659)) ([db7e288](https://github.com/nikolai-vysotskyi/trace-mcp/commit/db7e2884f2fbd83969910835c1a1123ee4aa2264))
* **telemetry:** country, model and indexed-repo count; drop raw timezone ([#667](https://github.com/nikolai-vysotskyi/trace-mcp/issues/667)) ([984b264](https://github.com/nikolai-vysotskyi/trace-mcp/commit/984b264b57c7d9c13b4838fc82f1a50bdb38350b))
* **telemetry:** install type, previous version and machine class ([#671](https://github.com/nikolai-vysotskyi/trace-mcp/issues/671)) ([549765e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/549765ee9ab32d23992a82412fc72403b031021a))


### Bug Fixes

* **app:** a project tab must not hold a daemon socket while it is off screen ([#670](https://github.com/nikolai-vysotskyi/trace-mcp/issues/670)) ([8d5d88f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8d5d88fdfe754ea5b6697df39e5908c95e217bf2))
* **app:** delete the 20px segmented control, not its latest victim (TRA-522) ([#658](https://github.com/nikolai-vysotskyi/trace-mcp/issues/658)) ([242d5d6](https://github.com/nikolai-vysotskyi/trace-mcp/commit/242d5d64a3999ffe08f140791b3df36a8b4c8519))
* **app:** one focus ring per control, on the control's own boundary (TRA-521) ([#662](https://github.com/nikolai-vysotskyi/trace-mcp/issues/662)) ([acb4dd1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/acb4dd1e9d19507a98c8fc25f7359ad4547270ee))
* **app:** stop the daemon restart loop the wedged guard was meant to stop (TRA-543) ([#681](https://github.com/nikolai-vysotskyi/trace-mcp/issues/681)) ([13e6aa7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/13e6aa7e601ed04afe419b80a60ab9c0df0dd2e6))
* **app:** the graph filter popover stays inside the graph pane ([#661](https://github.com/nikolai-vysotskyi/trace-mcp/issues/661)) ([e6a398d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e6a398d6cf022d1bfe44739c2a543425c5184fe1))
* **app:** the tab bar is 20px, not 36 — lights back on the tab centre line (TRA-523) ([#664](https://github.com/nikolai-vysotskyi/trace-mcp/issues/664)) ([00e4c0f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/00e4c0f8b12834a8aac4dddd6606035116ab46ce))
* **ci:** publish the adoption snapshot to a data branch, not a PR ([#678](https://github.com/nikolai-vysotskyi/trace-mcp/issues/678)) ([d6a937f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d6a937ff1e940eaa93e09fd575ef18d4e77a85c3))
* **ci:** route the adoption snapshot through a PR, not a push to master ([#674](https://github.com/nikolai-vysotskyi/trace-mcp/issues/674)) ([7dd1b63](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7dd1b638f861962a298cd22163583aef149a2150))
* **daemon:** decision rows survived project removal in every build (TRA-542) ([#680](https://github.com/nikolai-vysotskyi/trace-mcp/issues/680)) ([a0c251d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a0c251d2b9b4efbee07cfe6d941163a0b0cec1bc))
* **docs:** the sitemap generator stops revising published dates backwards ([#652](https://github.com/nikolai-vysotskyi/trace-mcp/issues/652)) ([2d2b577](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2d2b5775870c4f7f01174491efa4bc082fa4eb2f))
* **registry:** stop agent workdirs leaking into the registry and topology store (TRA-527) ([#660](https://github.com/nikolai-vysotskyi/trace-mcp/issues/660)) ([15bce03](https://github.com/nikolai-vysotskyi/trace-mcp/commit/15bce031f0f4bb60edd187492dbdca534f4a146c))
* restore what [#659](https://github.com/nikolai-vysotskyi/trace-mcp/issues/659) reverted, gate the shape that let it through (TRA-528) ([#665](https://github.com/nikolai-vysotskyi/trace-mcp/issues/665)) ([ccc3b45](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ccc3b45b5a38cb6635e2149e33b8bc392710aeb5))
* **svelte:** extract $props() destructuring as component props ([#668](https://github.com/nikolai-vysotskyi/trace-mcp/issues/668)) ([67ac07c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/67ac07c3dfd126b4b5f8d77c0ecb211e5f81bcbb))
* **web:** label, focus and keyboard-reach the landing quickstart terminal ([#676](https://github.com/nikolai-vysotskyi/trace-mcp/issues/676)) ([0ee5cb2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0ee5cb22119aa3062e1f59d86c71eeea7c410b07))


### Performance

* **app:** load the Ask tab's markdown stack with the tab (TRA-532) ([#669](https://github.com/nikolai-vysotskyi/trace-mcp/issues/669)) ([e503c66](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e503c664aac853c7a0c1bdec0461797bcb527c9a))


### Documentation

* **ops:** add user-signal ledger; exclude git clones from the adoption metric ([#679](https://github.com/nikolai-vysotskyi/trace-mcp/issues/679)) ([f777bd6](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f777bd604905606e02e2c56dea1f66b7a4ffeee5))


### CI/CD

* **codeql:** exclude the filesystem-taint rule family (TRA-518) ([#653](https://github.com/nikolai-vysotskyi/trace-mcp/issues/653)) ([2cb8656](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2cb86564f649bb025be4301d669dcf94f658490c))
* lockfile, Dependabot and CI coverage for packages/vscode-extension ([#654](https://github.com/nikolai-vysotskyi/trace-mcp/issues/654)) ([c892ada](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c892adae6a60fc2ae9329baceb53a182f94f7f4a))

## [3.6.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.5.2...v3.6.0) (2026-08-30)


### Features

* **clients:** report each client's current enforcement level (TRA-498) ([#637](https://github.com/nikolai-vysotskyi/trace-mcp/issues/637)) ([b99f2eb](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b99f2eb1c61239bb10dd099fe2eb5e9e72736fa0))
* **server:** tailor the advertised surface to the connected MCP client (TRA-513) ([#648](https://github.com/nikolai-vysotskyi/trace-mcp/issues/648)) ([a43f5d4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a43f5d40ca9a97e0733b09599daea33210b78fd2))


### Bug Fixes

* **app:** MCP clients — the row actions never ran, and six drifted rows took six clicks (TRA-497) ([#638](https://github.com/nikolai-vysotskyi/trace-mcp/issues/638)) ([ce47652](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ce47652c95c14a8b00fdd58807feb6ecc04f0898))
* **app:** Project Overview reads all three daemon states, not one (TRA-489) ([#632](https://github.com/nikolai-vysotskyi/trace-mcp/issues/632)) ([fc20f58](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fc20f584e112a653e92b023d64d19c507542c610))
* **app:** shorten the Russian KPI delta caption to one line (TRA-464) ([#630](https://github.com/nikolai-vysotskyi/trace-mcp/issues/630)) ([4bb6bbd](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4bb6bbdaca90649292bf10f97394046a8d082805))
* **app:** the KPI strip stops arguing with the banner above it (TRA-488) ([#627](https://github.com/nikolai-vysotskyi/trace-mcp/issues/627)) ([1ab017e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1ab017e411b1a5eff587ba1f58602ff4c99faa49))
* **app:** the sidebar file row leads with the filename, not the path (TRA-503) ([#640](https://github.com/nikolai-vysotskyi/trace-mcp/issues/640)) ([ed369ec](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ed369ec25ed1cec48339c989375efe0834661f07))
* **clients:** a global MCP registration no longer carries the caller's cwd (TRA-501) ([#639](https://github.com/nikolai-vysotskyi/trace-mcp/issues/639)) ([a107d87](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a107d87056b4401b3647260a9cbbf36eb93f12dd))
* **indexer:** resolve Java imports, the next language after Go (TRA-483) ([#623](https://github.com/nikolai-vysotskyi/trace-mcp/issues/623)) ([934b2ee](https://github.com/nikolai-vysotskyi/trace-mcp/commit/934b2ee7f8322e239784b49132a616fce0480787))
* **search:** scope the subproject fan-out to the requested project (TRA-470) ([#626](https://github.com/nikolai-vysotskyi/trace-mcp/issues/626)) ([724697f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/724697fd128292b521241c6c57024ab19abc4f88))
* **site:** a code block that scrolls says so, and every scroll region has a ring (TRA-508) ([#645](https://github.com/nikolai-vysotskyi/trace-mcp/issues/645)) ([cfd77ad](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cfd77ad2e3e74eb6f037d5e95086ca1b52e0b4f7))
* **tools:** get_untested_symbols reports the actionable tier by default (TRA-515) ([#650](https://github.com/nikolai-vysotskyi/trace-mcp/issues/650)) ([8f849f7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8f849f79c3e0408bfa97116219ee791e17a040a5))
* **update:** target the running bundle, reclaim orphaned staging ([#644](https://github.com/nikolai-vysotskyi/trace-mcp/issues/644)) ([33d716e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/33d716e116a04e278c737d58fa367808327d28cb))
* **workspace:** a dead daemon gets one verdict from the KPI strip, not two (TRA-495) ([#633](https://github.com/nikolai-vysotskyi/trace-mcp/issues/633)) ([267c2f4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/267c2f47c0eedb54fc7827bba9df1bc6dd4cde91))


### Documentation

* add the scip_resolved tier to the stale resolution-tier tables ([#628](https://github.com/nikolai-vysotskyi/trace-mcp/issues/628)) ([4b44a31](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4b44a318d8eeef02f5a2a89c56eb022cebf4fdc6))
* **comparisons:** profile the largest LSP-native peer, correct its debugger claim (TRA-511) ([#646](https://github.com/nikolai-vysotskyi/trace-mcp/issues/646)) ([dc13beb](https://github.com/nikolai-vysotskyi/trace-mcp/commit/dc13beb4948091fb2210538bd59c2eb672fa357a))
* **design:** a review run must isolate the daemon, not just the screen (TRA-502) ([#641](https://github.com/nikolai-vysotskyi/trace-mcp/issues/641)) ([3a1c30c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3a1c30c33be8faf3a499cad5c28e22341c78a398))
* fifth head-to-head page — trace-mcp vs Context Mode ([#629](https://github.com/nikolai-vysotskyi/trace-mcp/issues/629)) ([1932c80](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1932c80d773cc64fff68b662ed56ea6959a804cc))
* **ops:** draft the Show HN material (TRA-393) ([#625](https://github.com/nikolai-vysotskyi/trace-mcp/issues/625)) ([56da9b0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/56da9b04c2314252a3f1f073d7fbfb04b77b544b))
* **ops:** keep a ledger of what has actually been audited (TRA-505) ([#643](https://github.com/nikolai-vysotskyi/trace-mcp/issues/643)) ([6324c10](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6324c10e3369e0ccf4dbbf38546736f7ac322917))
* pin /perf/ with a permalink, undoing a soft 404 from [#635](https://github.com/nikolai-vysotskyi/trace-mcp/issues/635) ([#636](https://github.com/nikolai-vysotskyi/trace-mcp/issues/636)) ([af61b3a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/af61b3ade5adbd7f8b06c30c0825e2aeb3e65ed3))
* publish the tool index — 101 registered tools had no entry anywhere (TRA-505) ([#642](https://github.com/nikolai-vysotskyi/trace-mcp/issues/642)) ([c1b9b7f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c1b9b7f145cfe19a3fcf404af8ba7fed43515ddf))
* publish two orphan pages, noindex three internal ones ([#635](https://github.com/nikolai-vysotskyi/trace-mcp/issues/635)) ([fb4e037](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fb4e037ed809ef5547800cd2c6e4832d1aca6ea7))


### Tests

* **init:** cover the Hermes guard-hook installer (TRA-514) ([#649](https://github.com/nikolai-vysotskyi/trace-mcp/issues/649)) ([63e92af](https://github.com/nikolai-vysotskyi/trace-mcp/commit/63e92afc3fa0cc9d4215cfa9adc35129808036e2))
* skip POSIX exec-bit assertion on Windows in hermes-hooks ([#651](https://github.com/nikolai-vysotskyi/trace-mcp/issues/651)) ([f5f2e3c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f5f2e3cf97e09d5c3336c2772982800e055000d3))

## [3.5.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.5.1...v3.5.2) (2026-08-30)


### Bug Fixes

* **app:** the dashboard at rest marks nothing selected (TRA-475) ([#617](https://github.com/nikolai-vysotskyi/trace-mcp/issues/617)) ([9618479](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9618479f2a27cfe8ec320653ad7e5b48a0d299f6))
* **app:** the sidebar file list can no longer pulse a skeleton forever (TRA-478) ([#622](https://github.com/nikolai-vysotskyi/trace-mcp/issues/622)) ([40cb6e6](https://github.com/nikolai-vysotskyi/trace-mcp/commit/40cb6e6ebc3dca5e12f65f68950c05c0d7ee9fe8))


### Documentation

* a settled screenshot is not the only frame worth checking (TRA-465) ([#620](https://github.com/nikolai-vysotskyi/trace-mcp/issues/620)) ([f25bd54](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f25bd542674051a5a410c225d88bea153ccbf906))


### CI/CD

* fail a PR that duplicates an open PR on the same issue (TRA-476) ([#618](https://github.com/nikolai-vysotskyi/trace-mcp/issues/618)) ([87bf5fc](https://github.com/nikolai-vysotskyi/trace-mcp/commit/87bf5fc4a150ae632a37dcc13e003bd39fcf460d))

## [3.5.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.5.0...v3.5.1) (2026-08-30)


### Bug Fixes

* **app:** a baseline taken while the daemon was silent is not a baseline ([#602](https://github.com/nikolai-vysotskyi/trace-mcp/issues/602)) ([8319504](https://github.com/nikolai-vysotskyi/trace-mcp/commit/83195041baaa5db58a821baf00067865b8b739df))
* **app:** centre the daemon-down pane on Project Overview (TRA-469) ([#614](https://github.com/nikolai-vysotskyi/trace-mcp/issues/614)) ([14313a4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/14313a4a7eb4cc2b8ad12074125ecb5e3bc1be9b))
* **app:** point the quarantine command at the real install path ([#604](https://github.com/nikolai-vysotskyi/trace-mcp/issues/604)) ([c416638](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c416638f7da812b2fae4bdf472c7b9b58a09d65d))
* **app:** Project Overview says a dead daemon once, not six times (TRA-469) ([#611](https://github.com/nikolai-vysotskyi/trace-mcp/issues/611)) ([c5340ca](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c5340ca7d0ba15b661f91a4e0a02c903007189d3))
* **app:** the KPI strip is a grid of equal tracks, not a wrapping flexbox (TRA-467) ([#608](https://github.com/nikolai-vysotskyi/trace-mcp/issues/608)) ([f992cb5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f992cb5465d198ac2f59ac0940f65ba98ba1bca0))
* **app:** the projects table shades what its pinned column covers ([#596](https://github.com/nikolai-vysotskyi/trace-mcp/issues/596)) ([421c157](https://github.com/nikolai-vysotskyi/trace-mcp/commit/421c1576a1bda8639d0027ed849af927ee813144))
* **app:** the sidebar file list stops blaming the scope for a dead daemon (TRA-471) ([#615](https://github.com/nikolai-vysotskyi/trace-mcp/issues/615)) ([84ae30c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/84ae30cc6837833965c3ab4dce565e61bd8b99fc))
* **indexer:** reconcile scope on full reindex, keep git-ignored files out ([#610](https://github.com/nikolai-vysotskyi/trace-mcp/issues/610)) ([13d26bd](https://github.com/nikolai-vysotskyi/trace-mcp/commit/13d26bd6263ee4aa08c1806de5b33b38c195d59a))
* **site:** a scrollable table says so (TRA-461) ([#606](https://github.com/nikolai-vysotskyi/trace-mcp/issues/606)) ([fb9c5ee](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fb9c5ee95f89c7b0699e458984c415457ee25795))
* **workspace:** measure the pane before the first paint, not after it ([#612](https://github.com/nikolai-vysotskyi/trace-mcp/issues/612)) ([5fdc586](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5fdc5865d2a4774d2e74b010c1efadab10f335c6))
* **workspace:** two overlapping KPI sets stop wearing the grammar of a partition (TRA-459) ([#605](https://github.com/nikolai-vysotskyi/trace-mcp/issues/605)) ([6079be2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6079be2942a4ec7159abb0e6d452f94ce0c651bb))


### Documentation

* **ops:** Cline is not an agent-alone submission after all (TRA-393) ([#599](https://github.com/nikolai-vysotskyi/trace-mcp/issues/599)) ([ad54c57](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ad54c578d8d5b164bfa08c1c971f26a441313933))
* price the default tool surface on one basis everywhere (TRA-448) ([#597](https://github.com/nikolai-vysotskyi/trace-mcp/issues/597)) ([4cbd69f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4cbd69f7f03e17bff77a7e7d77b9bb1376bcb383))
* re-measure the standard tool surface on comparisons.md (TRA-455) ([#601](https://github.com/nikolai-vysotskyi/trace-mcp/issues/601)) ([94f69ef](https://github.com/nikolai-vysotskyi/trace-mcp/commit/94f69effc65c1be1b0fc6e1676e24417bf715f3b))
* **workspace:** two comments in Workspace.tsx that TRA-467 left behind ([#616](https://github.com/nikolai-vysotskyi/trace-mcp/issues/616)) ([ece028f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ece028fd16c3033e9c83ca9eac44155527790cdd))


### Chores

* **deps:** unblock i18next 26 + react-i18next 17, restore the commander hold ([#607](https://github.com/nikolai-vysotskyi/trace-mcp/issues/607)) ([af2985f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/af2985fe5bf7021ffc5b2e587399db733578dd31))

## [3.5.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.4.0...v3.5.0) (2026-08-29)


### Features

* **app:** a pop-up language picker with ten languages ([#594](https://github.com/nikolai-vysotskyi/trace-mcp/issues/594)) ([080f369](https://github.com/nikolai-vysotskyi/trace-mcp/commit/080f3698b3598e643b7e9a80cda0a977c400c5c3))
* **app:** ship Spanish and Simplified Chinese (TRA-389) ([#592](https://github.com/nikolai-vysotskyi/trace-mcp/issues/592)) ([3f76ab2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3f76ab20fcd0b9ed626e20bd827b12ef253d63a0))


### Bug Fixes

* **indexer:** resolve Go imports, stop the matrix overclaiming import edges (TRA-449) ([#593](https://github.com/nikolai-vysotskyi/trace-mcp/issues/593)) ([b32b5e0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b32b5e06f027b651985984e53da6c018234128bb))
* **site:** capability marks are monochrome text, not emoji (TRA-447) ([#591](https://github.com/nikolai-vysotskyi/trace-mcp/issues/591)) ([3ee72f1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3ee72f1e9caaa1474f8f56706b835f7c0b998622))
* **telemetry:** make GA4 count installs as active users, report tokens saved ([#585](https://github.com/nikolai-vysotskyi/trace-mcp/issues/585)) ([b0f7bab](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b0f7babb396e96385cf994f393c7bef0858bf2eb))
* **update:** trust the bundle's Info.plist over the version marker ([#589](https://github.com/nikolai-vysotskyi/trace-mcp/issues/589)) ([e2d4cdb](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e2d4cdb7460bed4549b6170e3808a8512298e2cd))


### Documentation

* bring the i18n docs back in line with what ships (TRA-379) ([#595](https://github.com/nikolai-vysotskyi/trace-mcp/issues/595)) ([6a5e412](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6a5e412ad0a975205020c2fb1a60e4674d5c1bd2))
* **ops:** verify the last four directories in the distribution ledger (TRA-393) ([#588](https://github.com/nikolai-vysotskyi/trace-mcp/issues/588)) ([0292de8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0292de871fdbbb40e70c0283f50b3e2580b64360))


### Tests

* **docs:** guard the default-surface claims on the vs/ comparison pages (TRA-427) ([#586](https://github.com/nikolai-vysotskyi/trace-mcp/issues/586)) ([05dc3dd](https://github.com/nikolai-vysotskyi/trace-mcp/commit/05dc3ddac67438f853b3f99662cb829cb09b7454))

## [3.4.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.3.0...v3.4.0) (2026-08-29)


### Features

* **app:** a Language row in the app menu and in Settings (TRA-388) ([#579](https://github.com/nikolai-vysotskyi/trace-mcp/issues/579)) ([d11b655](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d11b6558b8df01c4fdf990b1bf8867e3f1e564c7))


### Bug Fixes

* **app:** never swap a running bundle, never call an already-installed update stuck ([#581](https://github.com/nikolai-vysotskyi/trace-mcp/issues/581)) ([8349f7e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8349f7ea64345aa04220dcb044ad13ead504473e))
* **app:** put the sidebar update card on the Lattice layer ([#582](https://github.com/nikolai-vysotskyi/trace-mcp/issues/582)) ([ad9eaa7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ad9eaa78a8c932a71bb2964a758d74f5caca2545))
* **app:** the AppKit tab bar is 28px, not 36 — lights sat 4px low ([#583](https://github.com/nikolai-vysotskyi/trace-mcp/issues/583)) ([65105c5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/65105c54e71088e5b082be0fc5acd591955fae4c))


### Documentation

* add the trace-mcp vs codegraph head-to-head page (TRA-427) ([#578](https://github.com/nikolai-vysotskyi/trace-mcp/issues/578)) ([7343bf0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7343bf04b0bfffa36df20a1e09e13e75dd9ad58f))
* dead evidence anchor in skills/README + verified distribution-ledger rows (TRA-393) ([#575](https://github.com/nikolai-vysotskyi/trace-mcp/issues/575)) ([450a719](https://github.com/nikolai-vysotskyi/trace-mcp/commit/450a71917381f1bbe7483effa260bd8f2f3d2263))
* disambiguate tune_decision_weights vs tune_weights, record consolidation-retirement policy (TRA-205) ([#577](https://github.com/nikolai-vysotskyi/trace-mcp/issues/577)) ([a2f4342](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a2f4342c18cc1aae83391cf8251c8d61d57cbdef))
* the menu's control column is an inset, not an x coordinate (TRA-388) ([#580](https://github.com/nikolai-vysotskyi/trace-mcp/issues/580)) ([8fca8fe](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8fca8fef38fd0a0a7a66f6210e8e3b43d17ed431))

## [3.3.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.2.0...v3.3.0) (2026-08-29)


### Features

* **app:** i18n runtime, en/ru catalogues and a check against inline strings (TRA-379) ([#535](https://github.com/nikolai-vysotskyi/trace-mcp/issues/535)) ([e0ec6cc](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e0ec6cc287333d1c3c2ec941f99709ed73b3e979))
* **app:** read Settings, the config schema and the Guard panels from the catalogue (TRA-383) ([#541](https://github.com/nikolai-vysotskyi/trace-mcp/issues/541)) ([8b9072d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8b9072d3f660fdd247c03db83be53b39925d3a10))
* **app:** read the exploration tabs from the string catalogue (TRA-385) ([#545](https://github.com/nikolai-vysotskyi/trace-mcp/issues/545)) ([84ec15b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/84ec15b9dc176f37c9f2fe19e85ee93413e750ad))
* **app:** read the overview and activity tabs from the catalogue (TRA-384) ([#543](https://github.com/nikolai-vysotskyi/trace-mcp/issues/543)) ([79f2953](https://github.com/nikolai-vysotskyi/trace-mcp/commit/79f2953efdacc6620481d0c677eb1c653badf65b))
* **app:** read the workspace, sidebar, app shell and UI primitives from the catalogue (TRA-387) ([#568](https://github.com/nikolai-vysotskyi/trace-mcp/issues/568)) ([7d92325](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7d92325f1c6e7b7a4496eb478d85873e74994192))
* **app:** translate the application menu, the tray and the main-process dialog (TRA-386) ([#539](https://github.com/nikolai-vysotskyi/trace-mcp/issues/539)) ([1c7e737](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1c7e737d471c618993dd75e737b6f2408a00bf5a))
* **server:** progressive tool disclosure — minimal default + load_tools (TRA-402) ([#553](https://github.com/nikolai-vysotskyi/trace-mcp/issues/553)) ([4cccd8a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4cccd8aee24d1b6af15981769dc39578284b4533)), closes [#519](https://github.com/nikolai-vysotskyi/trace-mcp/issues/519)


### Bug Fixes

* **app:** bound the sidebar material against --surface in both appearances (TRA-369) ([#529](https://github.com/nikolai-vysotskyi/trace-mcp/issues/529)) ([c9b2ede](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c9b2ede58b6976770520983ca0929298cfe744a7))
* **app:** drive the app without taking the screen (TRA-403) ([#554](https://github.com/nikolai-vysotskyi/trace-mcp/issues/554)) ([66ed81b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/66ed81b43b90c3b425a773055ac4787ab502af2b))
* **app:** every unpackaged build runs as an accessory app (TRA-407) ([#559](https://github.com/nikolai-vysotskyi/trace-mcp/issues/559)) ([c1588c1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c1588c162f23ebdea1011e925b5c9394a60f03b0))
* **app:** give Insights' report picker a narrow form so every report stays reachable ([#534](https://github.com/nikolai-vysotskyi/trace-mcp/issues/534)) ([051716f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/051716ffe199c6f183bef82ad761711286a9f2c9))
* **app:** group the app menu by what an item does, and take the theme pill's proportions from the reference (TRA-376) ([#538](https://github.com/nikolai-vysotskyi/trace-mcp/issues/538)) ([2331b60](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2331b60114a38a7ea7d3e1d407a0976e552f4aaa))
* **app:** guard setActivationPolicy on darwin, give dev:electron the opt-out ([#567](https://github.com/nikolai-vysotskyi/trace-mcp/issues/567)) ([5acf89e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5acf89ec20f1f97a827768bfbeef53eca4a36ef8))
* **app:** honour TRACE_MCP_AGENT_RUN as well (TRA-403) ([#557](https://github.com/nikolai-vysotskyi/trace-mcp/issues/557)) ([3418e32](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3418e32f50a5b6f1c9144062264a18a8dd78dabf))
* **app:** one state for a slow daemon, and numbers that go stale instead of blank ([#550](https://github.com/nikolai-vysotskyi/trace-mcp/issues/550)) ([b16c320](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b16c320dde3ab29d0ddd0fa3f688e7a0f4d13dce))
* **app:** report a stale npm root only when MCP clients run it ([#537](https://github.com/nikolai-vysotskyi/trace-mcp/issues/537)) ([0d6f924](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0d6f9249ca023fa21b23a7e87e6eacfff738a0a1))
* **app:** the native tab bar is a second top band, not a replacement (TRA-399) ([#552](https://github.com/nikolai-vysotskyi/trace-mcp/issues/552)) ([29da930](https://github.com/nikolai-vysotskyi/trace-mcp/commit/29da93025220ad558c56b9f3a924977cb66363cf))
* **config:** index every registered language by default (TRA-400) ([#549](https://github.com/nikolai-vysotskyi/trace-mcp/issues/549)) ([1d5be08](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1d5be082011ee79d9cd43090eea5fcebdca65d84))
* **daemon:** enforce the loaded-project cap in steady state, not just at boot ([#572](https://github.com/nikolai-vysotskyi/trace-mcp/issues/572)) ([345ef7e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/345ef7eff2f213f0c7e19d22858e20b2a121eaf5))
* **daemon:** stop the health watchdog from killing a busy daemon (TRA-421) ([#573](https://github.com/nikolai-vysotskyi/trace-mcp/issues/573)) ([551d656](https://github.com/nikolai-vysotskyi/trace-mcp/commit/551d656c482713fbfcd4b17a7e0f7611835ba722))
* **docs:** install surfaces advertised the 99% peak as the token average (TRA-393) ([#542](https://github.com/nikolai-vysotskyi/trace-mcp/issues/542)) ([9adf592](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9adf592aad7b60a78e4b17fe571179ec889291c4))
* **docs:** name the seven tools retired in v2.0.0, and hint them at call time (TRA-412) ([#566](https://github.com/nikolai-vysotskyi/trace-mcp/issues/566)) ([50531b5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/50531b59d09924015f6ad2ce6b94f2d2689a5a34))
* **docs:** photograph the window, and refuse a frame without its chrome (TRA-390) ([#544](https://github.com/nikolai-vysotskyi/trace-mcp/issues/544)) ([7882ea1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7882ea1067b34f59dc96df88a55cc93a97ecf0f3))
* **indexer:** register the VHDL language plugin, publish a capability matrix ([#547](https://github.com/nikolai-vysotskyi/trace-mcp/issues/547)) ([255f425](https://github.com/nikolai-vysotskyi/trace-mcp/commit/255f4257e44fa696ef98a0c236b82d66441bebeb))
* **logger:** serialize Errors logged under the `error` key ([#571](https://github.com/nikolai-vysotskyi/trace-mcp/issues/571)) ([08df073](https://github.com/nikolai-vysotskyi/trace-mcp/commit/08df073092cc58f446db2e821f88d9dd42d94105))
* **registry:** stop persisting one-shot agent-run checkouts ([#548](https://github.com/nikolai-vysotskyi/trace-mcp/issues/548)) ([84f81a4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/84f81a4508bac763319a8101269c3ec6cbed1c35))
* **site:** give the landing page the accessibility layer the docs already have (TRA-408) ([#561](https://github.com/nikolai-vysotskyi/trace-mcp/issues/561)) ([a1cc98b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a1cc98bdd29d38bd26de3096ef788cb8c88b9393))
* **site:** show one appearance of the app screenshot, not both (TRA-390) ([#546](https://github.com/nikolai-vysotskyi/trace-mcp/issues/546)) ([6ebbbd5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6ebbbd560e806b21cfdb6f168f090836fb9c380e))
* **update:** stop re-downloading the version already installed ([#556](https://github.com/nikolai-vysotskyi/trace-mcp/issues/556)) ([dd40f40](https://github.com/nikolai-vysotskyi/trace-mcp/commit/dd40f405a3513d185f774a8692db92f2bb8e700d))


### Performance

* **app:** stop shipping react-i18next in app.asar, measure startup on the renderer's own clock (TRA-398) ([#551](https://github.com/nikolai-vysotskyi/trace-mcp/issues/551)) ([19efc6a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/19efc6a7d6ef8166019029b78040da337937533a))


### Documentation

* add ops/distribution.md, the external listings ledger ([#570](https://github.com/nikolai-vysotskyi/trace-mcp/issues/570)) ([d48318b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d48318baedeb79faa6098ef43eb805027c1de12b))
* correct stale tool-surface claims and unhardcode homepage counts ([#569](https://github.com/nikolai-vysotskyi/trace-mcp/issues/569)) ([ecb114d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ecb114d181b89b0bcda30d11027dc8b0311c5c90))
* correct the sidebar material's backdrop, with the shot matrix (TRA-404) ([#555](https://github.com/nikolai-vysotskyi/trace-mcp/issues/555)) ([75e7081](https://github.com/nikolai-vysotskyi/trace-mcp/commit/75e708167080a8be968c2758463a480a011e0dbd))
* measure the sidebar material without hijacking the desktop (TRA-404) ([#558](https://github.com/nikolai-vysotskyi/trace-mcp/issues/558)) ([48f1c16](https://github.com/nikolai-vysotskyi/trace-mcp/commit/48f1c169cfa49643919de85479a50d9ff1797242))
* reclassify GA4 telemetry credentials as public by design ([#532](https://github.com/nikolai-vysotskyi/trace-mcp/issues/532)) ([9cdccf9](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9cdccf9b4a09768f1978cbc4d0bc87649dd87799))
* rewrite the landing page and README framing in a plain voice (TRA-418) ([#574](https://github.com/nikolai-vysotskyi/trace-mcp/issues/574)) ([9af6469](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9af6469763e09089c9496f0ab17ef019040afbe8))
* **site:** put the documentation pages in the Nothing design system ([#540](https://github.com/nikolai-vysotskyi/trace-mcp/issues/540)) ([b4b87c7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b4b87c71f96e8374a63617c8e3237e18f28c0302))
* stop citing npm downloads — the count is mirror-inflated (TRA-413) ([#564](https://github.com/nikolai-vysotskyi/trace-mcp/issues/564)) ([fd29351](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fd29351c6a8bb2d316742fa75c7c47790857f0a5))
* two more surfaces sold a peak token number as the average (TRA-393) ([#562](https://github.com/nikolai-vysotskyi/trace-mcp/issues/562)) ([1bc3876](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1bc38761a1a32802b125aa8b504ee6dbb6a25c17))


### CI/CD

* **codeql:** exclude js/path-injection, encoding the TRA-301 decision (TRA-381) ([#533](https://github.com/nikolai-vysotskyi/trace-mcp/issues/533)) ([85f0dbb](https://github.com/nikolai-vysotskyi/trace-mcp/commit/85f0dbb6a6a2f55224949bf89ad0a606335244e6))
* drop nosemgrep-suppressed findings from the Semgrep SARIF (TRA-411) ([#563](https://github.com/nikolai-vysotskyi/trace-mcp/issues/563)) ([3fd91ab](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3fd91ab6ee8e42a7b29c9aaeeb2e8d1353f42325))
* fail on invisible Unicode in prose and AI provenance marks ([#565](https://github.com/nikolai-vysotskyi/trace-mcp/issues/565)) ([8416082](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8416082a12d1f6cfd943a6561af3d702c3f3ce40))
* run cross-platform tests on refactoring path changes ([#530](https://github.com/nikolai-vysotskyi/trace-mcp/issues/530)) ([aa24222](https://github.com/nikolai-vysotskyi/trace-mcp/commit/aa24222367c6d7a64bb0c45f8487cb8ea62a0ee9))

## [3.2.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.1.1...v3.2.0) (2026-08-29)


### Features

* **app:** bring the Graph Explorer overlay layer onto the design system (TRA-349) ([#505](https://github.com/nikolai-vysotskyi/trace-mcp/issues/505)) ([6c635bd](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6c635bd11fc87f1d379afaec9d50a43d917cca48))
* **app:** collapse the sidebar footer into one row that opens an app menu (TRA-363) ([#516](https://github.com/nikolai-vysotskyi/trace-mcp/issues/516)) ([2a94e45](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2a94e45237ebfe5eb5c6aed8979db695e39abdc5))
* **app:** one top band — the surface's toolbar shares the line with the sidebar toggle (TRA-354) ([#518](https://github.com/nikolai-vysotskyi/trace-mcp/issues/518)) ([e194fdb](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e194fdb39f786d315d3b1b69a6e6698cb04db46f))
* **app:** Theme is one menu row with an inline switcher (TRA-363) ([#522](https://github.com/nikolai-vysotskyi/trace-mcp/issues/522)) ([cdf6193](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cdf61937d72f40c10722e491f61d4ab302c73d7d))
* **app:** update Windows through electron-updater instead of the macOS zip path (TRA-360) ([#513](https://github.com/nikolai-vysotskyi/trace-mcp/issues/513)) ([b8352f5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b8352f5b90babddc4d4ca7443e7131dcec7ba409))
* **parser:** migrate to the web-tree-sitter 0.26 API (TRA-330) ([#498](https://github.com/nikolai-vysotskyi/trace-mcp/issues/498)) ([4e9b45c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4e9b45c8b0356374fea249510a9aa3fc77d2eedd))


### Bug Fixes

* **api:** return SQLite indexed_at as ISO-8601 UTC ([#520](https://github.com/nikolai-vysotskyi/trace-mcp/issues/520)) ([1f7ec66](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1f7ec66600f58c22fe4af5ea286c845f38060711))
* **app:** a glyph names the action — drop sparkles and speech bubbles (TRA-363) ([#525](https://github.com/nikolai-vysotskyi/trace-mcp/issues/525)) ([b4331cf](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b4331cfced37d6aac3873d97466bb78593d8d79a))
* **app:** correct TRA-355's contrast claim and repoint its guard at a live element ([#508](https://github.com/nikolai-vysotskyi/trace-mcp/issues/508)) ([61da73e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/61da73e17eba740e265d6effb37a58fd2d84f667))
* **app:** follow the app's Appearance in the native layer, and floor the sidebar material in light (TRA-369) ([#524](https://github.com/nikolai-vysotskyi/trace-mcp/issues/524)) ([37e7eba](https://github.com/nikolai-vysotskyi/trace-mcp/commit/37e7eba021aa944725cff152a90e9f00e4ec773c))
* **app:** put the traffic lights on the top band's centre line (TRA-370) ([#521](https://github.com/nikolai-vysotskyi/trace-mcp/issues/521)) ([8ead88c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8ead88c0f46ef51959ad3cba705b19d403ab146a))
* **app:** report global npm roots the update never touched (TRA-364) ([#515](https://github.com/nikolai-vysotskyi/trace-mcp/issues/515)) ([0ae6e61](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0ae6e61fae33a53d681976ff8d2c327fb85d2cc7))
* **app:** say the daemon is unreachable instead of "Failed to fetch" (TRA-356) ([#507](https://github.com/nikolai-vysotskyi/trace-mcp/issues/507)) ([564ad48](https://github.com/nikolai-vysotskyi/trace-mcp/commit/564ad48c38fd478cdfb63f6249e3b47001c4fdcb))
* **app:** stop a locally built .app from hijacking updates, and never call a stuck bundle "up to date" (TRA-357) ([#510](https://github.com/nikolai-vysotskyi/trace-mcp/issues/510)) ([d4f6e27](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d4f6e27d40f461dc2bc8a2f9db9b33c69363042f))
* **app:** stop the shared toolbar clipping its controls off-window ([#509](https://github.com/nikolai-vysotskyi/trace-mcp/issues/509)) ([e299f34](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e299f340837a2bb254baaaedf6364682ddd8b169))
* **daemon:** build each MCP session from a freshly loaded config (TRA-373) ([#526](https://github.com/nikolai-vysotskyi/trace-mcp/issues/526)) ([3498657](https://github.com/nikolai-vysotskyi/trace-mcp/commit/34986577b3b40c7f8ce69a2cb1fa3080f172ce59))
* **refactoring:** apply_move now rewrites ESM .js import specifiers (TRA-374) ([#527](https://github.com/nikolai-vysotskyi/trace-mcp/issues/527)) ([756d840](https://github.com/nikolai-vysotskyi/trace-mcp/commit/756d840d6c8152fe5d40103d7a4e85f6331ed040))
* **refactoring:** normalize path separators before collapsing barrel imports ([#528](https://github.com/nikolai-vysotskyi/trace-mcp/issues/528)) ([bef1e22](https://github.com/nikolai-vysotskyi/trace-mcp/commit/bef1e2267e394cf31f915f0c0d9b9dc285759dba))
* **tools:** make compact_schemas cover all 141 tools and stop hiding required params (TRA-346) ([#500](https://github.com/nikolai-vysotskyi/trace-mcp/issues/500)) ([70787a7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/70787a77dd3f982df8ed06fdfb0686d06092ab73))


### Documentation

* fix the framework/language counts on the install surfaces (TRA-361) ([#512](https://github.com/nikolai-vysotskyi/trace-mcp/issues/512)) ([639dc9d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/639dc9d0a46eb721f1dea1e763196cbdf37c3977))
* re-measure the advertised tool surface and correct the comparison (TRA-372) ([#523](https://github.com/nikolai-vysotskyi/trace-mcp/issues/523)) ([d41ed16](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d41ed16fb6994e0e802e406dc840f16ab75654af))
* **readme:** deep-link in-body doc references to trace-mcp.com pages ([#502](https://github.com/nikolai-vysotskyi/trace-mcp/issues/502)) ([221e941](https://github.com/nikolai-vysotskyi/trace-mcp/commit/221e941840622b24c1de7dadaa0cca2a122abf40))
* regenerate every screenshot from one seeded state (TRA-366) ([#517](https://github.com/nikolai-vysotskyi/trace-mcp/issues/517)) ([2783acf](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2783acfc231a20c4b96b742706d7d5f0100d7229))
* **seo:** per-competitor /vs/ pages, visible dates, token-usage guide (TRA-351) ([#504](https://github.com/nikolai-vysotskyi/trace-mcp/issues/504)) ([4c2fb1b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4c2fb1b9aa84b9ec59a36b1a3558b89eaba24a36))


### Tests

* **update:** prove the .app bundle actually moves on npm install (TRA-359) ([#511](https://github.com/nikolai-vysotskyi/trace-mcp/issues/511)) ([ec4a1d5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ec4a1d53a943087629f036d8c1eeddb6c5908357))


### CI/CD

* publish server.json to the official MCP Registry on release ([#503](https://github.com/nikolai-vysotskyi/trace-mcp/issues/503)) ([88c1beb](https://github.com/nikolai-vysotskyi/trace-mcp/commit/88c1beb1387b6841695f138724ed20281db02efa))
* **release:** do not publish to npm before the app artifacts exist (TRA-362) ([#514](https://github.com/nikolai-vysotskyi/trace-mcp/issues/514)) ([b4066b3](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b4066b369803a7b6077acfedfbb041ce9e2beed0))

## [3.1.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.1.0...v3.1.1) (2026-08-29)


### Bug Fixes

* **app:** abort the model-list fetch on unmount ([#493](https://github.com/nikolai-vysotskyi/trace-mcp/issues/493)) ([2164908](https://github.com/nikolai-vysotskyi/trace-mcp/commit/21649089921b96c81e6832d0d50e9d0c64a3bc3e))
* **app:** make quick open readable — paths and ⌘-hints were 1.88:1 (TRA-344) ([#496](https://github.com/nikolai-vysotskyi/trace-mcp/issues/496)) ([0483234](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0483234efc88aa540788c8ff0d3931f6aeb70013))
* **guard:** arm the coach grace period at registration, expire it in the hook (TRA-341) ([#492](https://github.com/nikolai-vysotskyi/trace-mcp/issues/492)) ([23bbf49](https://github.com/nikolai-vysotskyi/trace-mcp/commit/23bbf49c0939bc40e396e085c22b5ffb20425525))
* **scan_security:** kill the false positives whose guard sits above the sink ([#497](https://github.com/nikolai-vysotskyi/trace-mcp/issues/497)) ([1e67b71](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1e67b71c209f8f2a461043668b6843a7ac21419a))
* **tools:** actually strip param descriptions at minimal/none verbosity (TRA-345) ([#499](https://github.com/nikolai-vysotskyi/trace-mcp/issues/499)) ([aba9e20](https://github.com/nikolai-vysotskyi/trace-mcp/commit/aba9e20a3d49706f5a096215893b32c4c79fea0c))


### Documentation

* move language and framework counts into counts.yml (TRA-275) ([#495](https://github.com/nikolai-vysotskyi/trace-mcp/issues/495)) ([37d1b47](https://github.com/nikolai-vysotskyi/trace-mcp/commit/37d1b47a813bd411d8aa1bd3150bae743119b618))

## [3.1.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v3.0.0...v3.1.0) (2026-08-29)


### Features

* **app:** give the guard a UI on Project Overview (TRA-334) ([#490](https://github.com/nikolai-vysotskyi/trace-mcp/issues/490)) ([fdb4498](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fdb4498f8b0ab2d4f74736fca420ea461e4fde0e))


### Bug Fixes

* **security:** drop shells and symlink-following from local spawn/temp paths (TRA-337) ([#489](https://github.com/nikolai-vysotskyi/trace-mcp/issues/489)) ([eeb01d3](https://github.com/nikolai-vysotskyi/trace-mcp/commit/eeb01d3b0bc4daebb71f4f1999019cd9ae13f579))

## [3.0.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v2.3.0...v3.0.0) (2026-08-29)


### ⚠ BREAKING CHANGES

* Node 20 and 21 are no longer supported; Node >=22 is required.

### Features

* raise the Node floor to 22 and re-ground the dependabot ignores ([#482](https://github.com/nikolai-vysotskyi/trace-mcp/issues/482)) ([742565f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/742565ff8f4c2e263a2087a50bce0802a0749ff1))


### Bug Fixes

* **app:** close the last hit-target gaps found in the TRA-284 final walk ([#488](https://github.com/nikolai-vysotskyi/trace-mcp/issues/488)) ([5788340](https://github.com/nikolai-vysotskyi/trace-mcp/commit/57883408843ecc0c204f8cae2a003d220583f2d5))
* **daemon:** auto-deregister stale one-shot agent-run workdirs (TRA-335) ([#487](https://github.com/nikolai-vysotskyi/trace-mcp/issues/487)) ([205905c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/205905cc385ff6c688a4eeaf24c1403b548b23c2))
* **verify:** read embedding_meta as the KV table it actually is ([#485](https://github.com/nikolai-vysotskyi/trace-mcp/issues/485)) ([dae8004](https://github.com/nikolai-vysotskyi/trace-mcp/commit/dae80041b4c8b8f09d48bd76a9a5795bee2597bc))


### Refactoring

* **app:** retire the legacy palette — one token layer, no ghosts (TRA-315) ([#484](https://github.com/nikolai-vysotskyi/trace-mcp/issues/484)) ([9e52c1a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9e52c1aadef16409d639c60f30421825dcaf9bf0))

## [2.3.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v2.2.0...v2.3.0) (2026-08-29)


### Features

* **app:** migrate Notebook to the macOS 26 layer (TRA-310) ([#473](https://github.com/nikolai-vysotskyi/trace-mcp/issues/473)) ([04a5b28](https://github.com/nikolai-vysotskyi/trace-mcp/commit/04a5b28c5e9f51e1848333daeeb5d7bdc3edb466))


### Bug Fixes

* **app:** keep the Ask toolbar in the no-provider setup state (TRA-312) ([#475](https://github.com/nikolai-vysotskyi/trace-mcp/issues/475)) ([e1f9a5e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e1f9a5eeb056fec95d4b2a2983dab189bca2d4ed))
* **app:** make the workspace survive the 640x420 minimum window ([#480](https://github.com/nikolai-vysotskyi/trace-mcp/issues/480)) ([5e64c51](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5e64c51df333782e47abcb71cdb08e7fa1168421))
* **registry:** scope index-DB sharing to sequential use (TRA-304) ([#477](https://github.com/nikolai-vysotskyi/trace-mcp/issues/477)) ([663cdc6](https://github.com/nikolai-vysotskyi/trace-mcp/commit/663cdc6de73184c8b213623526f1e5dc7b0d408b))
* **registry:** stop the mtime cache serving a stale registry (TRA-326) ([#479](https://github.com/nikolai-vysotskyi/trace-mcp/issues/479)) ([c6cce05](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c6cce05147157832eb16fd6c280dac995b519f6e))


### Documentation

* **design:** title design PRs with a real Conventional Commits type ([#474](https://github.com/nikolai-vysotskyi/trace-mcp/issues/474)) ([3237a8f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3237a8f326ca9cefac5a3348c57400f6cb655da6))
* require the repo git identity for agent commits so license/cla resolves ([#478](https://github.com/nikolai-vysotskyi/trace-mcp/issues/478)) ([a2fc45c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a2fc45cce1a849de4bacd1534e06cdd4f73d4d35))


### Chores

* **ci:** record why each dependabot ignore exists (TRA-328) ([#481](https://github.com/nikolai-vysotskyi/trace-mcp/issues/481)) ([cc9600a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cc9600a1f098a4cb17f877b1af7320b1601d81cb))

## [2.2.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v2.1.0...v2.2.0) (2026-08-29)


### Features

* **app:** application menu, keyboard shortcuts and the text-selection fix (TRA-297) ([#471](https://github.com/nikolai-vysotskyi/trace-mcp/issues/471)) ([c2320d3](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c2320d38aa42cdac9cfa033ac78a2ec66503367a))
* **app:** put the sidebar footer on the row system, add Light/Dark/Auto (TRA-305) ([#464](https://github.com/nikolai-vysotskyi/trace-mcp/issues/464)) ([266f53f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/266f53f1e4ed1edbf2f3aacc9de89ae9f32389ed))
* **app:** rebuild Ask on the macOS 26 layer (TRA-312) ([#472](https://github.com/nikolai-vysotskyi/trace-mcp/issues/472)) ([7ab309d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7ab309d3981ccd7cb82401976e6096ea9674ecfd))
* **app:** rebuild Graph Explorer chrome and Insights on the macOS 26 layer (TRA-296) ([#468](https://github.com/nikolai-vysotskyi/trace-mcp/issues/468)) ([7df5742](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7df57427348e69d90a677cb6731e481d50f80e38))
* **app:** rebuild MCP clients, Settings and the onboarding sheet (TRA-295) ([#469](https://github.com/nikolai-vysotskyi/trace-mcp/issues/469)) ([407d4e1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/407d4e123420d093eaae464e2e8dfede267adb96))
* **app:** rebuild Project Overview on the macOS 26 layer (TRA-293) ([#463](https://github.com/nikolai-vysotskyi/trace-mcp/issues/463)) ([b995779](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b995779a93973abd9cf39847f2cb7f6501d27802))
* **app:** rebuild the workspace dashboard and project table on the macOS 26 layer (TRA-292) ([#461](https://github.com/nikolai-vysotskyi/trace-mcp/issues/461)) ([9b4bc0b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9b4bc0bdb1a024195aa7623e22fae4e9b7a901bd))


### Bug Fixes

* **app:** density pass — sidebar footer height, doubled pane inset, off-grid control padding (TRA-306) ([#467](https://github.com/nikolai-vysotskyi/trace-mcp/issues/467)) ([b1b5fbc](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b1b5fbc71ae1170dde9b2c4a3cae1823a2578e9e))
* **app:** distinguish a project the daemon forgot from one never indexed ([#465](https://github.com/nikolai-vysotskyi/trace-mcp/issues/465)) ([ab59ed6](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ab59ed657740a6dee45e0a4afe51a12a06d68114))


### Documentation

* write DESIGN.md, the design system this revision converged on (TRA-307) ([#466](https://github.com/nikolai-vysotskyi/trace-mcp/issues/466)) ([3ccfacf](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3ccfacfc87128ce789235ecff7dc175f6996891d))

## [2.1.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v2.0.3...v2.1.0) (2026-08-28)


### Features

* **app:** native vibrancy sidebar + hiddenInset window chrome (TRA-291) ([#453](https://github.com/nikolai-vysotskyi/trace-mcp/issues/453)) ([f914b2e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f914b2e6855e1e785f31db023184d188a8e2cb8a))
* **app:** rewrite the Lattice control primitives on a 20/24/28 capsule scale (TRA-290) ([#456](https://github.com/nikolai-vysotskyi/trace-mcp/issues/456)) ([1b51c52](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1b51c528b4e2a50b22b4569aa3799c595de26558))
* **app:** single macOS 26 token layer, type scale and 4pt geometry ([#458](https://github.com/nikolai-vysotskyi/trace-mcp/issues/458)) ([7cb93e3](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7cb93e380ef38cfd96c52bfccf89cb6cdfcb6093))


### Bug Fixes

* **ci:** give the three full-index jobs real timeout headroom (TRA-298) ([#460](https://github.com/nikolai-vysotskyi/trace-mcp/issues/460)) ([f007258](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f0072587d2ffaf5f2c6d3c3bed0e79e0a1df1f3f))
* **daemon:** require --allow-remote for a non-loopback bind (TRA-301) ([#459](https://github.com/nikolai-vysotskyi/trace-mcp/issues/459)) ([42f4f6b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/42f4f6b040910aa103aca3aad7c869dc73663fe5))
* **registry:** stable git-remote identity so repeat checkouts reuse one index (TRA-38) ([#450](https://github.com/nikolai-vysotskyi/trace-mcp/issues/450)) ([6148369](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6148369267bfb6b466df6c4f307c6a053fff656d))
* **security:** replace existsSync-then-read/write TOCTOU with safe helpers (TRA-256) ([#452](https://github.com/nikolai-vysotskyi/trace-mcp/issues/452)) ([0ef5fc2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0ef5fc298879ade96d5e538a7cd4d4a17d59847c))

## [2.0.3](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v2.0.2...v2.0.3) (2026-08-28)


### Bug Fixes

* **ci:** restore RELEASE_PLEASE_TOKEN, dropped by the [#438](https://github.com/nikolai-vysotskyi/trace-mcp/issues/438) squash-merge (TRA-171) ([#448](https://github.com/nikolai-vysotskyi/trace-mcp/issues/448)) ([40b8e15](https://github.com/nikolai-vysotskyi/trace-mcp/commit/40b8e15e113510f0104d9e45c279a7ff962922b1))
* **daemon:** ignore dangerous project hints instead of failing MCP startup (TRA-286) ([#449](https://github.com/nikolai-vysotskyi/trace-mcp/issues/449)) ([da0bd12](https://github.com/nikolai-vysotskyi/trace-mcp/commit/da0bd12cfb5b79b3d6003b051f158ed571a2b3d8))


### Performance

* **app:** add a fixed workload fixture for the three unmeasured desktop metrics (TRA-258) ([#446](https://github.com/nikolai-vysotskyi/trace-mcp/issues/446)) ([fd378da](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fd378da6a2fa2782413a2ade1531289516b52338))
* **daemon:** cap eager project loading at startup (TRA-278) ([#445](https://github.com/nikolai-vysotskyi/trace-mcp/issues/445)) ([8989741](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8989741882709c68b356a1d399f468a1d7661cdc))


### Chores

* **telemetry:** make active installs the adoption metric of record ([#438](https://github.com/nikolai-vysotskyi/trace-mcp/issues/438)) ([618df41](https://github.com/nikolai-vysotskyi/trace-mcp/commit/618df414286a5470446d089daf888b0c22e05630))

## [2.0.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v2.0.1...v2.0.2) (2026-08-28)


### Bug Fixes

* **ci:** use RELEASE_PLEASE_TOKEN so release PR checks fire automatically (TRA-171) ([64dc725](https://github.com/nikolai-vysotskyi/trace-mcp/commit/64dc7255fbab92c7a381c4b918968f0c4e922beb))
* **docs:** refresh stale sitemap lastmod and run the guard in CI (TRA-282) ([#444](https://github.com/nikolai-vysotskyi/trace-mcp/issues/444)) ([8c42271](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8c42271222e36e2310e5dc09891c074a04d06f28))
* **update:** recover an app bundle swap interrupted by a reboot (TRA-280) ([#442](https://github.com/nikolai-vysotskyi/trace-mcp/issues/442)) ([16c3a7f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/16c3a7f7a49a196f7bb77bba12a5dd5800ea45d5))

## [2.0.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v2.0.0...v2.0.1) (2026-08-28)


### Bug Fixes

* **app:** freeze Project and Actions columns in the workspace table (TRA-265) ([#429](https://github.com/nikolai-vysotskyi/trace-mcp/issues/429)) ([3cde321](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3cde321fd84d0d1087cc7b5512f0d0a44c5e6d3f))
* **daemon:** bound post-update forced reindex attempts (TRA-274) ([#439](https://github.com/nikolai-vysotskyi/trace-mcp/issues/439)) ([a9669a4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a9669a43a5165d5b72bf8bf49059a89d6e09e8c3))
* **docs:** our own surfaces said 85 framework integrations, the registry has 87 (TRA-272) ([#440](https://github.com/nikolai-vysotskyi/trace-mcp/issues/440)) ([30d4de7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/30d4de7a74bcf73de0adbe5fbfcfe4870b48cee8))
* **docs:** reconcile the README language count and guard every occurrence (TRA-272) ([#437](https://github.com/nikolai-vysotskyi/trace-mcp/issues/437)) ([cbd2aa5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cbd2aa59d2a47e3257af02504c49cad88f5ef5a1))


### Tests

* **docs:** count MCP tools recursively, not with a top-level glob (TRA-268) ([#433](https://github.com/nikolai-vysotskyi/trace-mcp/issues/433)) ([38751d0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/38751d0e82dd3f8e0db895bef928c8a8d52e53a6))


### CI/CD

* authenticate release-please with RELEASE_PLEASE_TOKEN (TRA-171) ([#436](https://github.com/nikolai-vysotskyi/trace-mcp/issues/436)) ([7b0fd3b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7b0fd3b469d6e74c2bd731844fe71ffce6a47508))

## [2.0.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.51.1...v2.0.0) (2026-08-28)


### ⚠ BREAKING CHANGES

* seven MCP tools are removed. Each was a deprecated alias for a superset tool that already covered it:

| Retired tool (1.x) | Replacement (2.0) |
|---|---|
| `pin_symbol { symbol_id }` | `pin { symbol_id }` |
| `pin_file { file_path }` | `pin { file_path }` |
| `search_with_mode { query, mode }` | `search { query, retriever: mode }` |
| `get_dead_exports { file_pattern }` | `get_dead_code { file_pattern, mode: "exports_only" }` |
| `get_untested_exports { file_pattern }` | `get_untested_symbols { file_pattern, scope: "exports_only" }` |
| `get_session_resume { max_sessions }` | `get_wake_up { scope: "resume", max_sessions }` |
| `get_project_memo { include_history, limit }` | `get_wake_up { scope: "project", include_history, history_limit }` |

Every call is expressible in the replacement without loss of behaviour or response shape. Full notes: [Migrating from 1.x](https://trace-mcp.com/tools-reference.html).

Two rarely-used `search` parameters were also removed: `fusion_weights` (per-channel weights now come from `~/.trace-mcp/tuning.jsonc`, written by `tune_weights`) and `fusion_debug`.

### Features

* retire the 7 deprecated consolidation aliases, cut the search schema (TRA-240) ([#415](https://github.com/nikolai-vysotskyi/trace-mcp/issues/415)) ([9459d4c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9459d4ce5cb305c2f89b5b7cee2cb7f4798fc1da))


### Bug Fixes

* **app:** don't render a failed metrics fetch as real zeros (TRA-264) ([#428](https://github.com/nikolai-vysotskyi/trace-mcp/issues/428)) ([7216174](https://github.com/nikolai-vysotskyi/trace-mcp/commit/721617451282b34845f8a0193a6f6de22a210dc9))
* **app:** make Compact denser, sort it like Table, keep the leading / in paths ([#430](https://github.com/nikolai-vysotskyi/trace-mcp/issues/430)) ([b577b9a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b577b9a69d539742373fb2ac4d8d36ed6bd986ec))
* **app:** make the guard onboarding dialog dismissable and quiet on first launch ([#423](https://github.com/nikolai-vysotskyi/trace-mcp/issues/423)) ([9fb47f9](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9fb47f9de9f86e7948a091ff0117c0b6c8361cfe))
* **daemon:** honour the tool preset on the daemon-backed path (TRA-250) ([#422](https://github.com/nikolai-vysotskyi/trace-mcp/issues/422)) ([bf7e3d7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/bf7e3d7f5eae75af43e2a4b8479983c568d3c53b))
* **daemon:** record why a silent exit happened (TRA-267) ([#432](https://github.com/nikolai-vysotskyi/trace-mcp/issues/432)) ([0c7b944](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0c7b94445601093b6ff92e0c3bfcccfc6e4a2774))
* **docs:** emit og:image on every docs page ([#418](https://github.com/nikolai-vysotskyi/trace-mcp/issues/418)) ([c000b28](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c000b28d924263f67aefea39fc3c4df3ff702e51))
* **docs:** link every doc page from the shared footer nav ([#419](https://github.com/nikolai-vysotskyi/trace-mcp/issues/419)) ([717e463](https://github.com/nikolai-vysotskyi/trace-mcp/commit/717e463ce600ff5c272da777f571794bd3b5b129))
* **docs:** refresh sitemap lastmod from git, link docs from README and homepage body ([#426](https://github.com/nikolai-vysotskyi/trace-mcp/issues/426)) ([20df40b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/20df40bd3bfd5ac704131bb47d904f7cae735667))


### Performance

* **app:** stop shipping node_modules in the artifact, add a perf baseline harness (TRA-257) ([#425](https://github.com/nikolai-vysotskyi/trace-mcp/issues/425)) ([fc47c10](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fc47c10f44eb539cbb01b0bb2e4ff633c59b7151))


### Documentation

* **comparisons:** deep-dive pass on the two largest peers + measured tool-surface cost ([#416](https://github.com/nikolai-vysotskyi/trace-mcp/issues/416)) ([4355601](https://github.com/nikolai-vysotskyi/trace-mcp/commit/435560154a679640a17222516fce2464855038fe))
* fix stale language/framework/tool counts in CLAUDE.md and skills (TRA-243) ([#420](https://github.com/nikolai-vysotskyi/trace-mcp/issues/420)) ([4de6258](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4de62586faccd6092fb944a4f9291907369509e5))
* fix the MCP registry manifest and preset sizes, guard both (TRA-259) ([#427](https://github.com/nikolai-vysotskyi/trace-mcp/issues/427)) ([3467d3f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3467d3f68766297a1f30f52ecc3cf929ff59f5f4))
* single source of truth for the MCP tool count (TRA-263) ([#431](https://github.com/nikolai-vysotskyi/trace-mcp/issues/431)) ([a9939d3](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a9939d3dead96f5d05fc072eea0f599e8b52e71f))


### Tests

* **cli:** cover openInBrowser's platform branches and error-swallow (TRA-247) ([#417](https://github.com/nikolai-vysotskyi/trace-mcp/issues/417)) ([fcdf086](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fcdf086f0bafea290f9ede397d7347692cb6ef4e))


### CI/CD

* **security:** scope CodeQL/Semgrep to shipped code and make Semgrep a real gate ([#424](https://github.com/nikolai-vysotskyi/trace-mcp/issues/424)) ([df8e241](https://github.com/nikolai-vysotskyi/trace-mcp/commit/df8e241faeeaa34900d657a3082af4f6b73aea60))

## [1.51.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.51.0...v1.51.1) (2026-08-28)


### Bug Fixes

* **guard:** add Windows system directories to the dangerous-root guard (TRA-236) ([#411](https://github.com/nikolai-vysotskyi/trace-mcp/issues/411)) ([33b5f1c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/33b5f1c06c09dd813a8dbe5c41d63d79e88a25f2))
* **hooks:** cut clock spawns in reindex hook, make stats-write flake diagnosable ([#412](https://github.com/nikolai-vysotskyi/trace-mcp/issues/412)) ([74ce12b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/74ce12bfa0a4fbbf794aedcc19ee7fb537818fac))


### Performance

* **tools:** stop paying full prose for deprecated consolidation aliases, guard schema size (TRA-239) ([#414](https://github.com/nikolai-vysotskyi/trace-mcp/issues/414)) ([1dcb962](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1dcb96266403589c388ad5d89a9f7ad705c41add))

## [1.51.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.50.0...v1.51.0) (2026-08-28)


### Features

* **plugins:** add click and marshmallow Python framework plugins ([#409](https://github.com/nikolai-vysotskyi/trace-mcp/issues/409)) ([6cca4a8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6cca4a8a995edf756545aa0827bfb51533d2cb0a))


### Bug Fixes

* **app:** don't render KPI zeros before metrics load; use color tokens ([#400](https://github.com/nikolai-vysotskyi/trace-mcp/issues/400)) ([c1e51d9](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c1e51d9c96ffbef367778c079c372fd88fa5075d))
* **app:** normalize daemon project_status progress payload ([#401](https://github.com/nikolai-vysotskyi/trace-mcp/issues/401)) ([deddbba](https://github.com/nikolai-vysotskyi/trace-mcp/commit/deddbba61233a564ad45314fbb546df1bab8bc05))
* **indexer:** converge coverage after major on-disk change (TRA-231) ([#406](https://github.com/nikolai-vysotskyi/trace-mcp/issues/406)) ([f3bf334](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f3bf334128e2ec855292c4908a0d51e58830663e))
* **mcp:** strip redundant $schema keyword from tools/list responses ([#398](https://github.com/nikolai-vysotskyi/trace-mcp/issues/398)) ([4f5482a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4f5482a9fa5bcf71791e864515d9776f6f8e7d65))
* **topology:** route subproject registration through the dangerous-root guard (TRA-232) ([#405](https://github.com/nikolai-vysotskyi/trace-mcp/issues/405)) ([03096b3](https://github.com/nikolai-vysotskyi/trace-mcp/commit/03096b389ced496744c2cc6cd9a10b68f5c36e09))


### Documentation

* **tools:** cross-link overlapping impact and risk tools ([#408](https://github.com/nikolai-vysotskyi/trace-mcp/issues/408)) ([ef54002](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ef5400265275df7fbf012454251077f9ec618cb0))


### Tests

* **tools:** extend schema-budget guard to conditionally-registered tools ([#407](https://github.com/nikolai-vysotskyi/trace-mcp/issues/407)) ([b1a725f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b1a725f7a4326ba45c491e6632fc26754f97961f))
* **topology:** gate POSIX-only dangerous-root fixtures off Windows ([#410](https://github.com/nikolai-vysotskyi/trace-mcp/issues/410)) ([2b9ba1f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2b9ba1f2092ebd8a8928672d4a3477034b801735))


### Chores

* **deps:** document commander v15 ignore in dependabot.yml ([#402](https://github.com/nikolai-vysotskyi/trace-mcp/issues/402)) ([b3dca9c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b3dca9ce0465cdb115aa806d5e491a9ab16076b2))

## [1.50.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.49.0...v1.50.0) (2026-08-27)


### Features

* **get_wake_up:** add scope param to unify with get_session_resume / get_project_memo (TRA-206) ([#395](https://github.com/nikolai-vysotskyi/trace-mcp/issues/395)) ([35d72df](https://github.com/nikolai-vysotskyi/trace-mcp/commit/35d72df0c90dd8c71d71b9d78ca52d664024950f))


### Bug Fixes

* **install-app:** verify SHA-256 before extracting or executing release assets (TRA-219) ([#397](https://github.com/nikolai-vysotskyi/trace-mcp/issues/397)) ([3fe0614](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3fe0614175b883701c1682590acd234040b3efea))

## [1.49.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.48.5...v1.49.0) (2026-08-27)


### Features

* **check_edit_safe:** add depth param to unify with assess_change_risk / get_change_impact (TRA-197) ([#392](https://github.com/nikolai-vysotskyi/trace-mcp/issues/392)) ([425a0c1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/425a0c1d434c5525dffc7c21c8c5aaa147c2ae0a))
* **get_dead_code:** add exports_only mode, alias get_dead_exports (TRA-199) ([#393](https://github.com/nikolai-vysotskyi/trace-mcp/issues/393)) ([290f7dc](https://github.com/nikolai-vysotskyi/trace-mcp/commit/290f7dcbdde5172757724d5eaa1e09b4e3b28d13))
* **get_untested_symbols:** add scope param, alias get_untested_exports (TRA-203) ([#394](https://github.com/nikolai-vysotskyi/trace-mcp/issues/394)) ([ef80540](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ef80540abb5c4bd1d791ae7e80265075272f5e35))
* **pins:** add unified pin tool, alias pin_file/pin_symbol (TRA-196) ([#391](https://github.com/nikolai-vysotskyi/trace-mcp/issues/391)) ([5035195](https://github.com/nikolai-vysotskyi/trace-mcp/commit/50351951d9ec688f1ec9f0595842c1c70c1acffd))
* **search:** add retriever param to unify with search_with_mode (TRA-200) ([#388](https://github.com/nikolai-vysotskyi/trace-mcp/issues/388)) ([2192dd3](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2192dd35494eef10c2750b145e27861fbf544baa))

## [1.48.5](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.48.4...v1.48.5) (2026-08-27)


### Bug Fixes

* point app auto-update at trace-mcp releases, not deleted trace-mcp-app-dist ([#386](https://github.com/nikolai-vysotskyi/trace-mcp/issues/386)) ([6c14f18](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6c14f18a1d6d78a780862c28c3527067c8ebb2ac))


### Documentation

* fix remaining stale comments about the deleted app-dist repo ([#387](https://github.com/nikolai-vysotskyi/trace-mcp/issues/387)) ([b47b0ad](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b47b0ad55a86dd3d80005659b528ec2433510b67))
* update roadmap — TRA-186 shipped, tool-consolidation scoping is next ([#384](https://github.com/nikolai-vysotskyi/trace-mcp/issues/384)) ([8007125](https://github.com/nikolai-vysotskyi/trace-mcp/commit/80071259bbd9a1c1d35a265440b099b1624aeb67))

## [1.48.4](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.48.3...v1.48.4) (2026-08-27)


### Performance

* **mcp:** trim per-param describe() text, add param-description budget guard (TRA-186) ([#380](https://github.com/nikolai-vysotskyi/trace-mcp/issues/380)) ([73942ec](https://github.com/nikolai-vysotskyi/trace-mcp/commit/73942ec8182158376c2bde8a7b84f2ccb38833d6))

## [1.48.3](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.48.2...v1.48.3) (2026-08-27)


### Performance

* **mcp:** trim heaviest tool descriptions to cut schema-load token tax (TRA-186) ([#377](https://github.com/nikolai-vysotskyi/trace-mcp/issues/377)) ([b2f3a09](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b2f3a095d0579dcab1e988ee5d060d5b14c3d3f7))

## [1.48.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.48.1...v1.48.2) (2026-08-27)


### Bug Fixes

* **app:** apply staged update on any quit, not just explicit Restart ([#376](https://github.com/nikolai-vysotskyi/trace-mcp/issues/376)) ([b817ef9](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b817ef9dd68ff86c457c1ca7fa827cbd22162eea))
* **daemon:** re-check npm registry periodically, not just at startup ([#372](https://github.com/nikolai-vysotskyi/trace-mcp/issues/372)) ([475cb69](https://github.com/nikolai-vysotskyi/trace-mcp/commit/475cb69fb40efdb9bd11ed0e86345dfacc641229))
* deep-glob fallback masked by unrelated global include pattern (TRA-184) ([#374](https://github.com/nikolai-vysotskyi/trace-mcp/issues/374)) ([803f7c3](https://github.com/nikolai-vysotskyi/trace-mcp/commit/803f7c3c00e9a690cab6185cb3b6d7160fb1a145))
* **registry:** reject /private/tmp as a project root (TRA-185) ([#373](https://github.com/nikolai-vysotskyi/trace-mcp/issues/373)) ([168e311](https://github.com/nikolai-vysotskyi/trace-mcp/commit/168e3118a46c56038e22fa37da852b9ec1abba1a))


### Documentation

* refresh product roadmap — 2 items shipped, add tool-schema tax (TRA-188) ([#375](https://github.com/nikolai-vysotskyi/trace-mcp/issues/375)) ([5bf51d9](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5bf51d9e55b7afe19773346595b74f8b656736f5))


### CI/CD

* switch release-PR auto-approve to a schedule trigger (TRA-171) ([#370](https://github.com/nikolai-vysotskyi/trace-mcp/issues/370)) ([2411bb2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2411bb22995ad39c2bb2b7ecbabf9d23de28c138))

## [1.48.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.48.0...v1.48.1) (2026-08-27)


### Bug Fixes

* unify language/framework/tool counts across marketing docs ([#369](https://github.com/nikolai-vysotskyi/trace-mcp/issues/369)) ([4e34e97](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4e34e97189d73b3ab8c944b3bf04825c197931ef))


### Documentation

* fix duplicate H1, untargeted titles, unscoped tables, dead-end internal links (TRA-173) ([#368](https://github.com/nikolai-vysotskyi/trace-mcp/issues/368)) ([61436ea](https://github.com/nikolai-vysotskyi/trace-mcp/commit/61436ea25c346c29ed478a5a9ad1d8e277dd8630))
* **site:** close AI-search (GEO) gaps — FAQPage schema, TechArticle dates, llms-full.txt (TRA-175) ([#367](https://github.com/nikolai-vysotskyi/trace-mcp/issues/367)) ([ac1f543](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ac1f543b70db3ff25dce5228611255c793d14bd0))


### CI/CD

* auto-approve release-please PR workflow runs (TRA-171) ([#365](https://github.com/nikolai-vysotskyi/trace-mcp/issues/365)) ([8007391](https://github.com/nikolai-vysotskyi/trace-mcp/commit/80073916fb5fc33a01136c823b363957eda1d3ad))

## [1.48.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.47.1...v1.48.0) (2026-08-27)


### Features

* add detail_level to get_feature_context / get_task_context (GH [#334](https://github.com/nikolai-vysotskyi/trace-mcp/issues/334)) ([#353](https://github.com/nikolai-vysotskyi/trace-mcp/issues/353)) ([9c30a2f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9c30a2f2fec6f13f39a5e1d1269e2abc554b814c))
* **ci:** SARIF upload for quality gates + security scan (TRA-127) ([#349](https://github.com/nikolai-vysotskyi/trace-mcp/issues/349)) ([a4c520f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a4c520f8e3239ba6f44d1fb799ce379034acc76d))
* **config:** add tools.default_detail_level global verbosity default (TRA-168) ([#364](https://github.com/nikolai-vysotskyi/trace-mcp/issues/364)) ([a78a9cd](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a78a9cd0b453d2aa39247c1627c118ddb982aa7c))
* **mcp:** add list_projects + call_project_tool cross-project relay (TRA-93) ([#357](https://github.com/nikolai-vysotskyi/trace-mcp/issues/357)) ([e1cde20](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e1cde20cf83192cd85d7c1100415ce4b3d7bfc2f))


### Bug Fixes

* **app:** migrate status dots to Lattice tokens, delete duplicate StatusDot ([#352](https://github.com/nikolai-vysotskyi/trace-mcp/issues/352)) ([a3045eb](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a3045eb62bf3d91477f5a024b649068969df3601))
* **app:** replace emoji glyphs + hardcoded colors with Lattice Icon/Badge ([#351](https://github.com/nikolai-vysotskyi/trace-mcp/issues/351)) ([f6268ac](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f6268acd905e9f6f759ec950ff23d1c7c491d12a))
* **doctor:** don't silently drop coverage when --fix removes overlap containers ([#338](https://github.com/nikolai-vysotskyi/trace-mcp/issues/338)) ([744cbf4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/744cbf4596591e8c9af99038a9156b39175542e4))
* **hooks:** catch recursive/pathless grep-cat in trace-mcp-guard ([#361](https://github.com/nikolai-vysotskyi/trace-mcp/issues/361)) ([408a85c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/408a85cf39180888a18ad4fc259601f53d674207))
* **init:** stop writing alwaysLoad:true, flag it as stale instead (TRA-142) ([#355](https://github.com/nikolai-vysotskyi/trace-mcp/issues/355)) ([18bb652](https://github.com/nikolai-vysotskyi/trace-mcp/commit/18bb652dc95f4250ea5c8c233654572b0af4d0dd))
* **release:** enforce Conventional Commit PR titles (TRA-104) ([#335](https://github.com/nikolai-vysotskyi/trace-mcp/issues/335)) ([933b9b1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/933b9b1ce01976be49d1366d854c6acb05fe52c8))
* replace insecure /tmp literal paths in test fixtures with /nonexistent (CodeQL js/insecure-temporary-file [#247](https://github.com/nikolai-vysotskyi/trace-mcp/issues/247)) ([#358](https://github.com/nikolai-vysotskyi/trace-mcp/issues/358)) ([4e0035f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4e0035fdfcf418a5b5508f87bdf15efe8076309d))
* resolve CodeQL js/redos and js/insecure-temporary-file alerts in source-reader.ts ([#356](https://github.com/nikolai-vysotskyi/trace-mcp/issues/356)) ([6939be2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6939be25deaec5dcdb1dd16ba2584799df408f26))
* resolve mocked project roots via path.resolve in call_project_tool tests ([#360](https://github.com/nikolai-vysotskyi/trace-mcp/issues/360)) ([a5f57ee](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a5f57ee4d6bd9e499b5573ca4db7d9e98b129a11))
* **site:** self-host fonts, fix heading order, contrast, a11y name mismatch ([#347](https://github.com/nikolai-vysotskyi/trace-mcp/issues/347)) ([b783e21](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b783e21b7634bc7be62ff3da64b38c8a7c10efaa))
* **test:** resolve mocked project paths via path.resolve on Windows (TRA-151) ([#359](https://github.com/nikolai-vysotskyi/trace-mcp/issues/359)) ([5410897](https://github.com/nikolai-vysotskyi/trace-mcp/commit/54108974a1219b17989028acb2da8645bc4b0163))


### Performance

* **memory:** batch git commit-lookup in decision staleness verification ([#348](https://github.com/nikolai-vysotskyi/trace-mcp/issues/348)) ([7652ef0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7652ef0bcc89cc0a93443d4a42bdbe76ac4430de))


### Documentation

* add product roadmap (TRA-124) ([#343](https://github.com/nikolai-vysotskyi/trace-mcp/issues/343)) ([b203e3f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b203e3fc4cb8d46d083295c7efd860dc7423d9c4))
* deep-dive the two flagged 60K+-star entrants (Graphify, Headroom) ([#362](https://github.com/nikolai-vysotskyi/trace-mcp/issues/362)) ([32d997d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/32d997dec1ee7f455a7822bb0416ccc0fb14fe81))
* document solo-maintainer review model ([#346](https://github.com/nikolai-vysotskyi/trace-mcp/issues/346)) ([6f149ef](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6f149efbeaaf23c00bbc70b29177c7be5c42fed7))
* refresh competitor star counts (verified via GitHub API) ([#344](https://github.com/nikolai-vysotskyi/trace-mcp/issues/344)) ([c660d44](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c660d446f8212c30ef3d4c8a42fe4ce47cf781d5))
* refresh competitor stars, add repo-context-mcp entrant, add profiling tracker (TRA-162) ([#363](https://github.com/nikolai-vysotskyi/trace-mcp/issues/363)) ([3d474fa](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3d474fa7822a3d1b1d82253a35fc68141efcd283))
* **security:** document code-scanning alert triage policy ([#350](https://github.com/nikolai-vysotskyi/trace-mcp/issues/350)) ([50c6bd6](https://github.com/nikolai-vysotskyi/trace-mcp/commit/50c6bd63fccfc512ef6c3c0963cb7bcbc5d9aa7e))
* **site:** link docs pages internally, fix sitemap, add llms.txt ([#345](https://github.com/nikolai-vysotskyi/trace-mcp/issues/345)) ([82b4262](https://github.com/nikolai-vysotskyi/trace-mcp/commit/82b4262d5e43a1429d0e3d7f7390b67ce71c2318))

## [1.47.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.47.0...v1.47.1) (2026-08-16)


### Bug Fixes

* **analytics:** surface _warnings when session data source is unreachable (TRA-76) ([#319](https://github.com/nikolai-vysotskyi/trace-mcp/issues/319)) ([74b49f1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/74b49f170aed0e6f3648080ba1f1220fe25015ed))
* **deps:** patch Dependabot alerts reintroduced by packages/app restore ([#309](https://github.com/nikolai-vysotskyi/trace-mcp/issues/309)) ([a1e13be](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a1e13bee34754b48391af4d4bd32e84ccf5a40d0))
* **watcher:** apply .gitignore filtering to file-watcher events (TRA-85) ([#327](https://github.com/nikolai-vysotskyi/trace-mcp/issues/327)) ([32dee04](https://github.com/nikolai-vysotskyi/trace-mcp/commit/32dee042ac8bb6a21cee018e68e6e779dd27f6d9))


### Chores

* add .gitattributes forcing LF line endings ([#326](https://github.com/nikolai-vysotskyi/trace-mcp/issues/326)) ([e19f512](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e19f5129e0619527e5064bc65dd12ac5c7f48076))

## [1.47.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.46.2...v1.47.0) (2026-08-09)


### Features

* **app:** port the Lattice design system foundation from Codechats, restyle the sidebar shell ([#281](https://github.com/nikolai-vysotskyi/trace-mcp/issues/281)) ([07948cc](https://github.com/nikolai-vysotskyi/trace-mcp/commit/07948cc7683180b72d94d66d2fcbd98070f992ec))
* **init:** add --scope project|global for MCP config target ([#282](https://github.com/nikolai-vysotskyi/trace-mcp/issues/282)) ([#284](https://github.com/nikolai-vysotskyi/trace-mcp/issues/284)) ([51be60d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/51be60dccb04ab116f5beff89c166946db84d709))
* **plugin:** add Codex CLI plugin, document one-step install in README ([#278](https://github.com/nikolai-vysotskyi/trace-mcp/issues/278)) ([8c17ce0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8c17ce0955dabe7246da560235dc2c04ba30c9cc))
* **telemetry:** anonymous opt-out active-install ping (GA4 Measurement Protocol) ([#280](https://github.com/nikolai-vysotskyi/trace-mcp/issues/280)) ([493152b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/493152bef4b40363aeddaa4bf1a11f80317cd955))


### Bug Fixes

* **config:** scaffold preset:standard in default global config (TRA-67) ([#305](https://github.com/nikolai-vysotskyi/trace-mcp/issues/305)) ([2c5a1bf](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2c5a1bf6065f691531906325bc063b53ee9432c2))
* **guard:** distinguish stdio vs http heartbeat, treat 0 sessions as dead ([#301](https://github.com/nikolai-vysotskyi/trace-mcp/issues/301)) ([167dc01](https://github.com/nikolai-vysotskyi/trace-mcp/commit/167dc01206e6894f6a3bcad45e007ef6c4af0080))
* **memory:** drop bare "over" from tech_choice mining pattern (TRA-34) ([#276](https://github.com/nikolai-vysotskyi/trace-mcp/issues/276)) ([a3b3c3e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a3b3c3eb88e1398d2b5f69342da7f98714658bdf))
* **memory:** scope mined-session count to project, not global ([#303](https://github.com/nikolai-vysotskyi/trace-mcp/issues/303)) ([c5f0754](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c5f0754c74bd29586a702e6486512986e96cba96))
* **memory:** scope session discovery to the target project (TRA-48) ([#293](https://github.com/nikolai-vysotskyi/trace-mcp/issues/293)) ([18fde5e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/18fde5ef21df597c0faa6cf4e07b2129b93d0013))
* **memory:** stop CLI mine defaulting stricter than the tuned reject floor ([#272](https://github.com/nikolai-vysotskyi/trace-mcp/issues/272)) ([08bb295](https://github.com/nikolai-vysotskyi/trace-mcp/commit/08bb2959ea0e28f03cdebf55386f58c5f06f46fd))
* **plugin:** bump .codex-plugin manifest versions to match package.json (1.46.2) ([#295](https://github.com/nikolai-vysotskyi/trace-mcp/issues/295)) ([13ecf04](https://github.com/nikolai-vysotskyi/trace-mcp/commit/13ecf0496f62c385db745c929c54901cc4bc005a))
* **registry:** doctor --fix-interactive handles registry issues too ([#291](https://github.com/nikolai-vysotskyi/trace-mcp/issues/291)) ([f10efa5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f10efa5c171d02c3da0d25476486640e4ebccbbc))
* **registry:** stamp lastIndexed on daemon-driven and CLI index runs (TRA-59) ([#302](https://github.com/nikolai-vysotskyi/trace-mcp/issues/302)) ([f100366](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f10036636b2252f53bbe1b28663ac7e4e7acf26d))
* **topology:** reject and self-heal filesystem-root subproject repo_root ([#273](https://github.com/nikolai-vysotskyi/trace-mcp/issues/273)) ([#275](https://github.com/nikolai-vysotskyi/trace-mcp/issues/275)) ([c595ccd](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c595ccd2590ff63f3e6ba3edff07ad21ffa40281))


### Documentation

* surface benchmark command and clarify synthetic estimate vs real savings ([#283](https://github.com/nikolai-vysotskyi/trace-mcp/issues/283)) ([581d458](https://github.com/nikolai-vysotskyi/trace-mcp/commit/581d4589d45fa022e140df3d205fd86b7e6b4b12)), closes [#277](https://github.com/nikolai-vysotskyi/trace-mcp/issues/277)


### Chores

* **deps:** bump undici and postcss overrides to close 6 Dependabot alerts ([#300](https://github.com/nikolai-vysotskyi/trace-mcp/issues/300)) ([353a3ce](https://github.com/nikolai-vysotskyi/trace-mcp/commit/353a3ce021bf96dfa20576558917164b78a82cba))
* **deps:** ignore better-sqlite3 major bumps (13.x prebuilds segfault) ([#296](https://github.com/nikolai-vysotskyi/trace-mcp/issues/296)) ([3974066](https://github.com/nikolai-vysotskyi/trace-mcp/commit/397406643c0e9e23cdb1aa14ea642ff74364a63c))

## [1.46.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.46.1...v1.46.2) (2026-07-29)


### Bug Fixes

* **init:** doctor false-positives on CLAUDE.md files that reject a competing tool ([#266](https://github.com/nikolai-vysotskyi/trace-mcp/issues/266)) ([54b47dc](https://github.com/nikolai-vysotskyi/trace-mcp/commit/54b47dc00c49d51e9eab03454811b3fb959dad5a))
* **memory:** reject narration noise in mined decisions (title_narration) ([#268](https://github.com/nikolai-vysotskyi/trace-mcp/issues/268)) ([42ba04f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/42ba04f991143a6af327c9b86551efc8373d4eca)), closes [#17](https://github.com/nikolai-vysotskyi/trace-mcp/issues/17)
* **registry:** doctor --fix/--dry-run clean up stale entries and overlaps ([#267](https://github.com/nikolai-vysotskyi/trace-mcp/issues/267)) ([513a177](https://github.com/nikolai-vysotskyi/trace-mcp/commit/513a1772cc59e29856bcb6b2cb328f7373f5659c))

## [1.46.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.46.0...v1.46.1) (2026-07-27)


### Bug Fixes

* auto-index unindexed files on get_outline NOT_FOUND miss ([#260](https://github.com/nikolai-vysotskyi/trace-mcp/issues/260)) ([0e4a807](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0e4a80731be7fe35ee21af1eaf9dfabc6b95af35))
* **config:** index .cs files at arbitrary .NET project roots ([#242](https://github.com/nikolai-vysotskyi/trace-mcp/issues/242)) ([ed2cdc1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ed2cdc1c77d64a9772581dc2ccf40ad7e499aa6b))
* **daemon:** retry transient transport errors in ProxyBackend.send ([#257](https://github.com/nikolai-vysotskyi/trace-mcp/issues/257)) ([22453de](https://github.com/nikolai-vysotskyi/trace-mcp/commit/22453de9d757e9088b864a8ab71c917f1bb38802))
* **init:** hide PowerShell console window in Windows launcher shim ([5ddd61a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5ddd61a3f6e621de252ff9bd1f53d2bc8a6c60b0))
* **quality:** get_changed_symbols base-branch auto-detection for non-main/master repos ([#258](https://github.com/nikolai-vysotskyi/trace-mcp/issues/258)) ([1393644](https://github.com/nikolai-vysotskyi/trace-mcp/commit/139364415a1c8c71abaa251c8dd187ad21197fd9))
* **tools:** default preset to standard (~50 tools), not full (~170) ([#259](https://github.com/nikolai-vysotskyi/trace-mcp/issues/259)) ([1c39322](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1c39322644691b8c3670c9c9087dc0127b150450))


### Chores

* **ci:** group github-actions dependabot updates ([#250](https://github.com/nikolai-vysotskyi/trace-mcp/issues/250)) ([c745589](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c745589c225398de425ac94d896d7fa70730b56c))
* **deps:** bump postcss to close Dependabot alert [#65](https://github.com/nikolai-vysotskyi/trace-mcp/issues/65) ([#261](https://github.com/nikolai-vysotskyi/trace-mcp/issues/261)) ([cb18080](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cb18080d070c8080818f4706424a6bef6dc4d00f))
* **deps:** patch 7 open Dependabot alerts via pnpm overrides ([#256](https://github.com/nikolai-vysotskyi/trace-mcp/issues/256)) ([4994510](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4994510113b55952ef722dce1aab1e90af4b7438))

## [1.46.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.45.3...v1.46.0) (2026-07-07)


### Features

* **init:** add KiloCode, Cline, Antigravity, Kimi MCP client auto-configuration ([ed20612](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ed206126724ec6525efc98a7b3e73fe8dfe11845)), closes [#76](https://github.com/nikolai-vysotskyi/trace-mcp/issues/76)


### Bug Fixes

* **daemon:** kill the restart war — session parent-death + SIGTERM bounded exit, /health "starting" during any indexing ([8dbea96](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8dbea96c2a421656ace117966549660b0afc2c8a)), closes [#236](https://github.com/nikolai-vysotskyi/trace-mcp/issues/236) [#237](https://github.com/nikolai-vysotskyi/trace-mcp/issues/237)

## [1.45.3](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.45.2...v1.45.3) (2026-07-06)


### Bug Fixes

* **init:** run Windows hooks through hidden PowerShell wrappers (no console flashing) ([aa2ce31](https://github.com/nikolai-vysotskyi/trace-mcp/commit/aa2ce31a7372e5e4493456b55a4b9055963fbb19)), closes [#230](https://github.com/nikolai-vysotskyi/trace-mcp/issues/230)

## [1.45.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.45.1...v1.45.2) (2026-07-06)


### Bug Fixes

* **memory:** tighten mined-decision quality gate (code spans, dangling tails, table remnants) ([1933076](https://github.com/nikolai-vysotskyi/trace-mcp/commit/19330762979fdc8e1349c2ebd10b985782eadeab)), closes [#233](https://github.com/nikolai-vysotskyi/trace-mcp/issues/233)

## [1.45.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.45.0...v1.45.1) (2026-07-06)


### Bug Fixes

* **memory:** reject truncated fragments in session decision mining ([78accf0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/78accf001ea4e7839318fefceac859ce5566e120)), closes [#231](https://github.com/nikolai-vysotskyi/trace-mcp/issues/231)

## [1.45.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.44.0...v1.45.0) (2026-07-04)


### Features

* **daemon:** idle project unload, per-connection SQLite memory caps, ancestor watcher restart ([a63fb66](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a63fb66159daf749d623511eda94a547defcd1e1))


### Bug Fixes

* **ai:** auto-detect Ollama embedding dimension + surface embed_repo failures ([68249bc](https://github.com/nikolai-vysotskyi/trace-mcp/commit/68249bc7f23e6949283c68707f5541aa20558a49)), closes [#223](https://github.com/nikolai-vysotskyi/trace-mcp/issues/223)
* **config:** preserve user-added keys when rewriting a project config section ([bfb5b93](https://github.com/nikolai-vysotskyi/trace-mcp/commit/bfb5b93ae159d7b62532c7f389bd6301729253e4))
* **daemon:** close topology.db handle in runSubprojectAutoSync (fd leak) ([27b2418](https://github.com/nikolai-vysotskyi/trace-mcp/commit/27b2418165eb2b815ba34d6dce6b8e5a3721cb6e))
* **dashboard:** deep-merge PUT /api/settings and preserve JSONC comments ([7510769](https://github.com/nikolai-vysotskyi/trace-mcp/commit/751076953f4e579f9a8b6cf7d28c81ffeacbf185)), closes [#221](https://github.com/nikolai-vysotskyi/trace-mcp/issues/221)
* **indexer:** electron & filament edges were silently dropped — rewrite + tests (3/3) ([fb84beb](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fb84beb04783c2d82846acc5704c8f8751583cf7))
* **indexer:** import TSNode locally in language helpers (keep re-export) ([8a6ee59](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8a6ee5955e31bf2f187aff74410f3cdf3be87531))
* **indexer:** import TSNode locally in language helpers instead of dead re-export ([dba6233](https://github.com/nikolai-vysotskyi/trace-mcp/commit/dba6233de793952c0af2257140638dfd17ead9fb))
* **indexer:** stop following directory symlinks during file discovery ([c6bda46](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c6bda462160397bdae910b0cc640a68ed63cfa63)), closes [#218](https://github.com/nikolai-vysotskyi/trace-mcp/issues/218)
* **init:** accept string content in withPs1Bom + align hooks test with BOM write path ([03a77ab](https://github.com/nikolai-vysotskyi/trace-mcp/commit/03a77abb138f6e5809de3a01a38581861b792266))
* **init:** write .ps1 launcher/hook artifacts with a UTF-8 BOM + ASCII-only templates ([66ba15c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/66ba15cb0d3d93fabfb9aa49709aaec8fe1838fd)), closes [#224](https://github.com/nikolai-vysotskyi/trace-mcp/issues/224)
* **tests:** type the unknown config section before member access in jsonc-merge test ([7872942](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7872942ffdda0e02693a485c2931c5422e2fa159))
* **types:** restore tsc gate (1/3) — core plugin-api types match runtime ([524bf06](https://github.com/nikolai-vysotskyi/trace-mcp/commit/524bf0645d6c86c4e9c210c12ef5e85803769f2a))
* **types:** restore tsc gate (2/3) — mechanical/drift/noise across 38 files ([33e9ed1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/33e9ed185f5ed677f85c7eac9935785f11013911))


### Performance

* **daemon:** cache registry reads + dedup consultation markers on the hot path ([bdce2a2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/bdce2a209211de5020b2eeb65eea3d6d262f1ab6))


### Refactoring

* **indexer:** extract extractAndPersist from IndexingPipeline (137 -&gt; 115 cyclomatic) ([7fd7b36](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7fd7b36c373bf67477645bab770b7a6c2699dda6))
* **memory-scheduler:** extract shared types into a dependency-free leaf module to break the resource-ops cycle ([93f983d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/93f983da2d5615936020c47dc74f5c09849ec90a))
* **memory:** extract MemorySchedulerResourceOps from MemoryScheduler ([f528d00](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f528d00dde43f5fd46878b5c5f6c43a000c95ab7))


### Documentation

* **taint-analysis:** reword example comment to avoid self-triggering the SQL-injection scanner ([cd68c36](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cd68c362263bfed287542770a3b749258f6f5639))


### Chores

* **quality-gates:** calibrate thresholds from today's cleanup + scanner review ([7e17144](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7e17144dec37a383d4d12052962510bbfba41d8d))


### CI/CD

* add tsc --noEmit typecheck gate to prevent type rot ([5cd4a03](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5cd4a03336386a882383b60b02d9f71b3fbe61ec))

## [1.44.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.43.3...v1.44.0) (2026-07-02)


### Features

* **analysis:** add get_file_health_timeline (complexity+coupling+churn merge) ([84a889d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/84a889d7cb501235fc61592bf1e468c02ca6bb1b))
* **analysis:** add get_graph_timeline (simplified commit-sampling tier) ([ee30168](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ee301681a6bed8d55c32ee1fa75a25af6ae7f66d))
* **analytics:** track semantic-degraded searches + near-duplicate rephrased queries ([a3becf2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a3becf221d05a1cb224409328a4b24f85267722d))
* **cfg:** model loop back-edges, loop-exit edges, and try/catch merge nodes ([8b58c13](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8b58c1350cf6b51e063f968604098d5702752e59))
* **daemon:** serve registered subprojects read-mostly (no watcher, ephemeral) ([208be4c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/208be4c866fd9d02c3e3017c752098def533328f))
* **daemon:** subproject-aware session binding ([#209](https://github.com/nikolai-vysotskyi/trace-mcp/issues/209)) ([bb96ecf](https://github.com/nikolai-vysotskyi/trace-mcp/commit/bb96ecf89062e43a1c2e72e14f0a7097dc75c444))
* **eval:** health-metric calibration harness + honest triage language ([caae2c9](https://github.com/nikolai-vysotskyi/trace-mcp/commit/caae2c9416f11839639ad43ba1f6ae9f99aca970))
* **iac:** K8s Resource nodes, multi-doc, Kustomize modules, compose build links ([391d03e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/391d03e1b0d94b261188e2faf7efe240796e6a4e))
* **iac:** resolve Kustomize/compose path-string imports to real manifest nodes ([4da5e48](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4da5e489b322d31bab0fb65f5ac6a2918a0db867))
* **memory:** decision staleness verification (Task 3) ([dce53ea](https://github.com/nikolai-vysotskyi/trace-mcp/commit/dce53ea27f5830d787d32639848240d3f50c95e4))
* **memory:** hybrid retrieval for decisions + tracked benchmark (Task 9) ([05cb7fb](https://github.com/nikolai-vysotskyi/trace-mcp/commit/05cb7fbf212a810203e59527fb2c66c86a8e60c4))
* **memory:** progressive disclosure of decisions (Task 12) ([1222cef](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1222cefc1b6c3d9abd1e30b927002e7c098e3b01))
* **memory:** search-time heat decay + auto-supersession (Task 11) ([6bcf60b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6bcf60b7798d64e152346c6c5ab1aa6d189c2bea))
* **quality:** SARIF 2.1.0 output for scan_security, detect_antipatterns, check_quality_gates ([37a0047](https://github.com/nikolai-vysotskyi/trace-mcp/commit/37a0047b584c245aa8d2aec469e3e18e49c48ff7))
* **quality:** type-aware taint pruning to cut false positives ([62a2a6a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/62a2a6a596cbdb6f133392a98ed7d816d252a632))
* **refactor:** re-enable extract_function with AST free-variable analysis ([296a2b8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/296a2b8ec39b96a0c55fa710dbd361c9c422b3ba))
* **refactor:** rebuild apply_codemod on ast-grep AST engine ([c3e823c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c3e823cdf1e1e9fd5aef1f9cdf0e820d234be951))
* **scip:** SCIP ingestion with scip_resolved edge tier ([3b5a970](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3b5a9707fd69d3dd7fab7d9b8b1417e51f3f22a4))
* **taint:** array-destructuring source + lock-in multi-hop/coercion regressions ([106eb5c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/106eb5c3d1f993c7cf9a4df6a2dca18d2aa9b344))
* **tools:** register get_federation_impact, get_file_health_timeline, get_graph_timeline ([1ebf5bc](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1ebf5bc665445589203d6b881371335292044ea4))


### Bug Fixes

* **cache:** scope pagerank + search caches per-DB (WeakMap), not by db.name ([24c42ec](https://github.com/nikolai-vysotskyi/trace-mcp/commit/24c42ec8ab3911afa37faa554e5a7aae902823ad))
* **cfg:** emit post-nested-block statement as its own node ([13ee9c1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/13ee9c1e9304e6413b650f9ad28761dd1b573746))
* **cfg:** stop mis-classifying do-prefixed identifiers as do-while loops ([3f7a8e0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3f7a8e03c24bca8010cc02f3cb9fbea1cb37d573))
* **codemod:** a pattern with zero matches is success, not an error ([6d1bc99](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6d1bc99360cd1e1723321f37855f5ab7d2e1a5c8))
* **codemod:** lazy-load @ast-grep/napi so a missing native binding degrades instead of crashing the server ([643e7d5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/643e7d5a16f4f975065641d0bebb2a97643c1eee))
* **daemon:** FK-recovery hard-resets index tables instead of looping ([848623d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/848623dcade32adfda08747a2c6b6f7cb5df6962))
* **extract-function:** stop misclassifying shadowed/multi-return slices, make confidence reflect it ([4175a41](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4175a419fd552c674546a490706f2ecf876ebc91))
* **hcl:** persist + resolve Terraform module source imports edge ([970a144](https://github.com/nikolai-vysotskyi/trace-mcp/commit/970a14450746e4697e65d49ff87aa0440e06771d))
* **indexer:** keep symbols_fts in sync on incremental reindex ([6807b0f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6807b0fef329d70cddb31cabfda608325cb08cdb))
* **indexer:** scope indexing to most-specific registered project ([#209](https://github.com/nikolai-vysotskyi/trace-mcp/issues/209)) ([32e2930](https://github.com/nikolai-vysotskyi/trace-mcp/commit/32e29305af171eb9e800274a572c46292ed25f9a))
* **memory:** break decision-store circular import via shared decision-types ([5892529](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5892529470a62ab84713de57706482c8d0102087))
* **memory:** decision retrieval bench script was broken and measuring stale data ([e6259b4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e6259b46530ba95328b73aba29ec927ad388ae7e))
* **memory:** fail open when decision verification throws internally ([3850eb9](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3850eb9f6cd2a7b49cc0c33301a1dae75f5e317d))
* **registry:** match extensionless language files by basename ([cfa018b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cfa018b7bed075904945e5746a5204989b661a97))
* revert 6 dead-code false positives from get_dead_code confidence-1.0 batch ([0a18f42](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0a18f42c10c56d9ee2ac7a039056873ac3701831))
* **sarif:** emit the canonical OASIS $schema URL, not a dead 404 ([511ef78](https://github.com/nikolai-vysotskyi/trace-mcp/commit/511ef788cb6dab9734b42a92179507ea2346aecd))
* **security:** eliminate 3x command injection in install-app.ts ([ff9eca6](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ff9eca6fb732dd207378d30b6db80338665a4ed4))
* **security:** eliminate command injection in ask --repo git clone ([b052f9a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b052f9a5155b2f270e2c1f15b5bcf006d460e4ac))
* **security:** validate table identifier before DDL in Vec0Index (CWE-89) ([6285f0b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6285f0b66c2fc9d6b6312d06056e212e389ddf0f))
* **session:** tighten unbatched-call hint, broaden tracked tool set ([fbccd6e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fbccd6e4ea96fa656ce1b96acc89a675e2028941))
* **taint:** line-aware type pruning to prevent hidden string-injection ([edb6815](https://github.com/nikolai-vysotskyi/trace-mcp/commit/edb68159b833d3897c0361b4098882e459715729))
* **taint:** propagate taint through string concat and template literals ([05194ee](https://github.com/nikolai-vysotskyi/trace-mcp/commit/05194eed5c32ccf164af484156ad7cb8fdb5be7a))
* **types:** narrow SearchResult | FlatSearchResult before _meta/_near_misses access ([76ef9ce](https://github.com/nikolai-vysotskyi/trace-mcp/commit/76ef9ce430e4b8f6e4d83c078a596e45b3f6cc9d))
* **types:** null-guard decisionStore inside nested closures in memory.ts ([ac98c3a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ac98c3a7dd84cee222b42ee8180a9f4d9ffa6021))
* **types:** remove invalid type assertion in updateCallSites ([739295b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/739295babaa6d5de128fda08224b4c9c0e4e1cda))
* **types:** replace zod v3 ZodEffects with v4 ZodPipe/ZodTransform ([22c5294](https://github.com/nikolai-vysotskyi/trace-mcp/commit/22c5294fe897eff39fa4197a95a48010945ada51))
* **types:** widen tsconfig rootDir to repo root to fix TS6059 ([f526ba3](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f526ba38fa0801a9b8d46c0fe79bc0f8569d6cf3))


### Performance

* **ai:** optional sqlite-vec ANN index for vector search ([256305f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/256305ff3bc8c936980ee1f4a776a2a22b31be2e))
* **analysis:** batch per-period churn queries in getGraphTimeline into one git call ([a3f846b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a3f846b69c1ecad068b4a6d8d037dbb722ffe567))
* **analysis:** cross-call cache for buildFileGraph + edge bottlenecks ([5f43b89](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5f43b890fda3fe00acc700a299c3fd1e73b8a4ab))
* **analytics:** replace tool_calls JOIN sessions with IN-subquery filter ([f76afa6](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f76afa6fd52e16b2da627f8babc7f3adfd41b92a))
* **complexity:** strip strings/comments once per symbol, not twice ([106dc58](https://github.com/nikolai-vysotskyi/trace-mcp/commit/106dc585b72bde913ac6f11460d679b52c7d5293))
* **context:** hoist repeated graph/file loads in context assembly ([42d5d33](https://github.com/nikolai-vysotskyi/trace-mcp/commit/42d5d33c633e25bac0c28dbe176e5cece7a6f1ca))
* **daemon:** grace-TTL release of idle project stores + idle heartbeat backoff ([9a3a3f4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9a3a3f4edd4f5428754aab99c97a80248243e009))
* **db:** add hot-path indexes idx_symbols_parent/exported, idx_edges_resolved (schema v30) ([cc49d47](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cc49d4788be30f48b16e7d4041c1e9ea5285cc1f))
* **indexer:** bulk-create symbol nodes per file batch (2N-&gt;1 statements) ([dbba80b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/dbba80bde8383c54c9e71681554145bc516075e6))
* **indexer:** evict per-batch file content cache to bound in-process RSS ([405f3ae](https://github.com/nikolai-vysotskyi/trace-mcp/commit/405f3aeb12647ef49376524b8894a584a205ae03))
* **memory:** batch decision-verification blob reads via git cat-file --batch ([a079eac](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a079eac39ea6f719a9db95dd6e198b3fce641858))
* **memory:** dedupe getStats() on the wake-up hot path ([02972d7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/02972d7eb57cf7108eb32ad6b2ec6a20bc9794fd))
* **memory:** memoize git subprocess spawns in decision verification ([28ba56c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/28ba56c071a4d5ca97240d943fa21ee841ce78b5))
* **scoring:** avoid expensive filtered COUNT in PageRank cache-hit check ([7d0e751](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7d0e7510613277b9a6520af0973222899693e5ca))
* **topology:** memoize endpoint-path normalization in linkClientCallsToEndpoints ([cd3a756](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cd3a7563f8e8a20cf460438a15e2b39b084349ba))
* **topology:** O(N^2)-&gt;O(N) cross-service edges; fix FK-safe repo removal ([c0140da](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c0140da1ea49106a2e7b84baa2ad08cfaa71d1ec))


### Refactoring

* **api:** split ask-sessions-routes dispatcher into per-route handlers ([a166ca7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a166ca7e18b7c0aa57be6a5e69db161d937a96c7))
* **api:** split memory-routes dispatcher into per-route handlers ([60bafa9](https://github.com/nikolai-vysotskyi/trace-mcp/commit/60bafa98766d093f54408022388e13ea486c4538))
* **eval:** extract main() helpers in calibrate-health-metrics (F -&gt; D) ([fe62553](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fe62553de6dc357d84d6fab14264864187d68ae1))
* **indexer:** extract FileCollector from IndexingPipeline.collectFiles ([9fc7bb2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9fc7bb28a1a1a4335427919aa44002d15e02cfa5))
* **indexer:** extract RenameDetector from IndexingPipeline.detectRenames ([2c72d9a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2c72d9a85797bbc8333d2e456a8071ffe59a2a5d))
* **lsp:** extract ensureFileOpen/enrichSymbol from enrichLanguage (cyclomatic 11 -&gt; 6) ([5337939](https://github.com/nikolai-vysotskyi/trace-mcp/commit/53379399383e3d5fbb1adf71da6249a5441b9ad6))
* **lsp:** extract logging/drain helpers from flushInternal (cyclomatic 10 -&gt; 5) ([17a158b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/17a158b72b49660a418c6433ce9b372a9becef6a))
* **lsp:** extract resolveServers helpers in config.ts (cyclomatic 19 -&gt; 1) ([693a22d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/693a22d7daf584d6eb6cc25842d84a97e906cbd4))
* **memory:** extract MemoOperations from DecisionStore god-class ([1ce07d2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1ce07d224e8c96ec2503ec4c4d13c8e9f3c78015))
* **memory:** extract MutationOperations (write-path) from DecisionStore ([5af82ad](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5af82ad43a7cc3989ede21b9316483ec74661339))
* **memory:** extract QueryOperations (read-path) from DecisionStore ([478f91b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/478f91b40b44b5c52bfb875c8dc2d1e210ab1c7e))
* **memory:** extract ReviewOperations from DecisionStore ([c88242f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c88242fb3cbaede41d1dc4a8f60ae8a6a59cc4d7))
* **memory:** extract SchedulerState + Consolidation ops from DecisionStore ([b68847f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b68847f3ac61f50177a518b02f9ce1bf93a16f71))
* **memory:** extract SessionOperations from DecisionStore ([7eca034](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7eca0341b73891691343bc107eeb0297ddee85a3))
* **python:** decompose PythonLanguagePlugin.extractClass into helpers (class cyclomatic 153 to 66) ([3562333](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3562333aaedcfc6f984c37cc5d432d2ce6b37a42))
* **server:** decompose installToolGate into tool-gate-helpers (cyclomatic 154 to 26) ([634078e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/634078ec85f94671cf8e6df2f8a392736c69cee1))
* **subproject:** extract contract resolution and source-service lookup in manager ([4f0a28e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4f0a28e65f5c06214ee2620a75031f822fbb3b8d))
* **subproject:** extract rename detection out of diffSchemas ([1e1feb5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1e1feb5e2440e079d06004251fd40befe25fe848))
* **subproject:** extract URL resolution and dedupe line-counting in scanner ([61268b5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/61268b5790c2c265b2ab9b0f6ba178d4ff152d99))
* **subproject:** split per-repo search logic out of subprojectSearch ([1690413](https://github.com/nikolai-vysotskyi/trace-mcp/commit/169041302a1cb04dbcbb3d221d3dff8eae185f9a))
* **tools:** extract get_context_bundle + get_feature_context into navigation/context-tools.ts ([b64478f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b64478fe3334fe5180ad5578ca6a51e889d47c80))
* **tools:** extract get_task_context into navigation/task-context-tools.ts ([89a2f4f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/89a2f4f8d441d9dd360e6d09a9ca8ccce0aa8fdb))
* **tools:** extract point-lookup tools into navigation/lookup-tools.ts ([b79a318](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b79a3183182fd40e6c09422fa7458f0f2f833bda))
* **tools:** extract search + suggest_queries into navigation/search-tools.ts ([ddc7cf8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ddc7cf8e601f6431bc4da6ee918422f34c490368))
* **tools:** hoist memo helpers out of registerMemoryTools closure ([b2cd23b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b2cd23b31197252e5463ca0bce40a0a6844470b9))
* **tools:** reduce registerNavigationTools to thin orchestrator (cyclomatic 183 -&gt; 1) ([bc292c7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/bc292c7fd2c51866477cdb340d8a15d82bd12758))
* **topology:** decompose TopologyStore god-class into per-entity modules (125 -&gt; 49) ([f2b3221](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f2b32219195fc9e6045f500fc55ec9a0c2fe9f23))


### Documentation

* fix CLAUDE.md/AGENTS.md drift (dead path, false-positive tool refs, oversized section) ([40a1b90](https://github.com/nikolai-vysotskyi/trace-mcp/commit/40a1b90809176627d0964ca8bf7953876d5731ee))
* reflect shipped gap-closures + adversarial validation findings ([4ae193b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4ae193ba1dd673fb324583cd3e0658ef18698808))
* refresh competitor comparison (June 2026) + new entrants ([cc5c332](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cc5c3327f9d5a3219de58ead6892cf015486f6f1))


### Tests

* **ai:** add AnthropicProvider unit tests ([b3152a8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b3152a8af04f5f1303b40ec448c9b8434f83c2c3))
* **ai:** add ask-shared.ts unit tests (resolveProvider, gatherContext, factories) ([35b1838](https://github.com/nikolai-vysotskyi/trace-mcp/commit/35b18387e737e034456179455546fd2135a37969))
* **ai:** add GeminiProvider unit tests ([4827f32](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4827f32778e7d9c5b7ef6997e35836163e2879de))
* **ai:** add OnnxProvider unit tests ([842501d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/842501d7dd04179f46eab744605cddfe555b4edf))
* **ai:** add OpenAIProvider unit tests ([e6fbe6a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e6fbe6a942702769431a44f0ee8829aeb98b1cd2))
* **api:** characterize ask-sessions-routes HTTP contract before split ([0c6afe3](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0c6afe3c8bcf8bc00b5ef59edcd1d0b0856b7349))
* **cli:** add behavioral coverage for clients and check commands ([cdf04e8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cdf04e8692329c0bffd5eda0fd249ca273f8345f))
* **cli:** add behavioral coverage for consent, bundles, status commands ([41fc3d6](https://github.com/nikolai-vysotskyi/trace-mcp/commit/41fc3d6844d475745ca744296f12ac11761aac5f))
* **cli:** add behavioral coverage for preflight, prune, remove commands ([78d8b87](https://github.com/nikolai-vysotskyi/trace-mcp/commit/78d8b87a5bbb3969762d2190de437a714ed86882))
* **codemod:** add CI smoke test for @ast-grep/napi native binding resolution ([a7980ab](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a7980ab42db3b6996228f47febb3913cdd6cba16))
* **eval:** widen MRR baseline tolerance to dataset granularity ([3479053](https://github.com/nikolai-vysotskyi/trace-mcp/commit/34790530256ef9eff7ddcd8fd8f0f8752cab8e41))
* **iac:** adversarial hardening for K8s/Kustomize/compose edge cases ([a0682a6](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a0682a65b68f9e2f7d8cb41d836b8aea965836bf))
* **lsp:** add unit tests for LspBridge orchestrator ([8f9482f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8f9482f8eee5f4956e0baa13db27709a7302c32b))
* **lsp:** add unit tests for LspClient JSON-RPC transport ([0617a15](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0617a1521a76837f11d99b2b9e4d2e01dd392ac3))
* **lsp:** add unit tests for LspEnrichmentPass ([392386c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/392386c6f12c84cfc9819d54de11a24b795e4c1f))
* **lsp:** add unit tests for LspServerManager lifecycle ([9666574](https://github.com/nikolai-vysotskyi/trace-mcp/commit/966657446dc6df051b060190703d72d094d4de68))
* **lsp:** add unit tests for symbol &lt;-&gt; LSP position mappers ([30e89ba](https://github.com/nikolai-vysotskyi/trace-mcp/commit/30e89bab420c41ab9077662ce7808b35ec51f31e))
* **memory:** adversarial supersession non-triggers (Task 11) ([e3ace69](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e3ace6915736f5bc1d9ab10898ef14331b163db6))
* **memory:** end-to-end heat-decay ranking with real timestamps (Task 11) ([cdc3e15](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cdc3e1548cb6d7d505d182b1c88d54c9c62028f3))
* **memory:** end-to-end staleness scenarios (file deletion, in-place edit) ([6dce0c8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6dce0c838e8224ff9007819df547707afc952d5f))
* **memory:** progressive-disclosure error handling + content-leak hardening (Task 12) ([5c8f198](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5c8f198e39c28e6de41b9a9b9d5fbc81f910ac62))
* **memory:** query_decisions hybrid retrieval wiring at the tool-handler level (Task 9) ([54d2a8a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/54d2a8a77707500c2c28b1b60cebed81a5c35516))
* **refactor:** fix extract_function preview fixture to a genuine single-return case ([cc799cc](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cc799cc4b20162dedc94b4f4973b9ce1d30ebe75))
* **refactor:** fix legacy zero-match assertion missed by the targeted re-run ([4268172](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4268172a25c96187166562c0e81200c43c350d68))
* **subproject:** add behavioral coverage for subproject-helpers.ts ([5462d6a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5462d6a3d35efebad74e2e636c773a4ec6fb5bb3))


### Chores

* **ai:** remove 5 unused retrieval-mode result interfaces ([541b9fb](https://github.com/nikolai-vysotskyi/trace-mcp/commit/541b9fb8d718c784314eb8eca5b9b25f623e7688))
* **deps:** bump hono 4.12.27 + js-yaml 4.3.0 via pnpm.overrides (security) ([9d26f76](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9d26f768394550b6d006ab3abfec9ed35f0c986b))
* **deps:** declare vite &gt;=8.0.16 override (fs.deny bypass + launch-editor NTLMv2 advisories) ([f348a80](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f348a80cdf90e2d3aae8762165660b32cc05587b))
* **deps:** override esbuild &gt;=0.28.1 (fixes dev-server arbitrary file read on Windows) ([51f1446](https://github.com/nikolai-vysotskyi/trace-mcp/commit/51f1446bcadad4f2833453f4b99e1aaa72b4d705))
* **deps:** override undici &gt;=7.28.0 (fixes SOCKS5 proxy pool cross-origin + TLS bypass advisories) ([14bcdd5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/14bcdd5e32679be40c7da2b1f0739d3a80ef3f5b))
* **deps:** tighten protobufjs override to &gt;=8.6.0 (fixes unknown-field memory amplification + property-shadowing advisories) ([d44aaba](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d44aabafeedea6558531847d23a76d59070523b4))
* **lsp:** remove TextDocumentPositionParams — orphaned by prior removal ([3472c41](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3472c416fbe5ee2f7c2684a022f4e0a4b4d8756d))
* **plugin:** sync manifest versions to 1.43.4 ([956902b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/956902bf95f35247c8be475cc345b7e7ae9ec739))
* **release:** 1.43.4 ([4998247](https://github.com/nikolai-vysotskyi/trace-mcp/commit/49982479d241afaf949c86ff4f321bccfb4e28ba))
* remove 5 verified-dead leaf exports ([f8066ac](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f8066acca5347ff0d69717c7bbe6873a0368af67))
* remove confirmed-dead exports from fresh dead-code sweep ([a862c06](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a862c06d6b13bfc7907a0c5dde50cd9324f34e39))
* remove dead extractCashierConfig cascade + WorkspaceResolver ([b2e9375](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b2e9375a37f40801efc7fe791a29a1ef7f42528b))
* remove verified dead code (4 symbols, confirmed via search_text) ([dbcff51](https://github.com/nikolai-vysotskyi/trace-mcp/commit/dbcff51ab0aae2ddf397082d2603d9a8f3bdf9cc))
* **ruby:** remove confirmed-dead filePathToModule and isAllCaps helpers ([cc9b90e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cc9b90e894640f605ef7ec976b24480960fc62e3))


### CI/CD

* add informational-only quality-gates report job ([a1b0f26](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a1b0f263c4d51fa070d1f7471e6041adc19db2aa))

## [1.43.3](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.43.2...v1.43.3) (2026-06-27)


### Bug Fixes

* **daemon:** seed initialize frame into swapped-in proxy backends ([#209](https://github.com/nikolai-vysotskyi/trace-mcp/issues/209)) ([90eee30](https://github.com/nikolai-vysotskyi/trace-mcp/commit/90eee306c8df3e5c2a9b3be5b4c2ffbfa824679a))

## [1.43.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.43.1...v1.43.2) (2026-06-25)


### Bug Fixes

* **daemon:** guard POST /api/projects against bare-container roots ([#209](https://github.com/nikolai-vysotskyi/trace-mcp/issues/209)) ([1e2b8e0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1e2b8e0b1550fc5421d25dfd619c9db3b92a0586))
* **daemon:** read-only local fallback — stop per-session full re-index ([#209](https://github.com/nikolai-vysotskyi/trace-mcp/issues/209)) ([8c28b65](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8c28b658de6db5ca2719fc13717232a67427525b))


### CI/CD

* **scorecard:** tolerate transient publish-results timeout ([#209](https://github.com/nikolai-vysotskyi/trace-mcp/issues/209)) ([d2f2a81](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d2f2a8104e23114b782662a306d4efaf5ef1ea9c))
* **windows:** drop node_modules cache on cross-platform job to fix realpath EPERM ([#209](https://github.com/nikolai-vysotskyi/trace-mcp/issues/209)) ([3f9a5ad](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3f9a5adb4b68d50b5d055878eac7d632f9803f32))

## [1.43.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.43.0...v1.43.1) (2026-06-16)


### Bug Fixes

* **daemon:** raise auto-spawn timeout 5s-&gt;20s to stop premature local fallback ([#209](https://github.com/nikolai-vysotskyi/trace-mcp/issues/209)) ([6b3a43e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6b3a43edc8e64e36bcd822de24650ba4bba1a586))
* **indexer:** skip postprocess on unchanged full reindex ([#209](https://github.com/nikolai-vysotskyi/trace-mcp/issues/209)) ([e108d4b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e108d4b4677171681808869116e58bf1016b78b4))

## [1.43.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.42.0...v1.43.0) (2026-06-15)


### Features

* **ai:** harden summarizer against prompt injection + configurable request body ([3f1f1dc](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3f1f1dc111615e45a0e09dabb62b46b2178748db))
* **hooks:** opt-in strict enforcement tier for the navigation guard ([0c1ceec](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0c1ceeccf2dc65ff939531e265e0d5014f605aa0))
* **indexer:** first-class Astro (.astro) language support ([25716b0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/25716b00ae984d623dae230dc6cb8350c9bd849a))
* **indexer:** refine sensitive-file detection (basename + secret-store dirs) ([8cc831d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8cc831d721e6ce8b003118cb5abe4c90b2dd1ed0))
* **lsp:** wire C# into LSP enrichment (csharp-ls auto-detect) ([2c80906](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2c80906101651efb893922094e85e4328186ffdb))
* **release:** publish provenance + get_symbol git-HEAD verification ([9a01450](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9a01450b79edb36829f30856d376b2eec9c0be61))
* **tools:** add check_edit_safe edit-safety preflight ([3539b0b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3539b0bb2ee2ff63968a97e9e8a279b9566bdc0c))


### Bug Fixes

* **daemon:** bounded reinit-retry covers 'Session expired' session loss ([#209](https://github.com/nikolai-vysotskyi/trace-mcp/issues/209)) ([3c23576](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3c235766468ab2c4de783d430e80ee424ec39007))
* **daemon:** don't auto-register a bare parent dir that only contains projects ([#209](https://github.com/nikolai-vysotskyi/trace-mcp/issues/209)) ([f7e228f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f7e228fa36e49483d7cdded41a0e66453c48ee06))
* **daemon:** keep /health responsive during warm-up; log shutdown reason ([4da4beb](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4da4bebdb98b9f730738cdc34bdc4a905446de66))
* **daemon:** proxy transparently re-initializes after daemon restart ([#209](https://github.com/nikolai-vysotskyi/trace-mcp/issues/209)) ([1d8d791](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1d8d7919135c76a7935f1304264f82ac80f7cd01))
* **daemon:** rotate daemon.log from inside the running daemon ([#209](https://github.com/nikolai-vysotskyi/trace-mcp/issues/209)) ([fa4f93a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fa4f93ac32119c23f46244a2f56591922d4603c9))
* **deps:** regenerate pnpm-lock.yaml after dependabot group merges ([3ab0ece](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3ab0ece64f55f78e2ad8fe5bd0af1e4675e8005a))
* **server:** process-wide safety net so one stray error doesn't drop the session ([bdc6b33](https://github.com/nikolai-vysotskyi/trace-mcp/commit/bdc6b33441a4aefa615e1a747ee9ab99d4e21ee2))
* **types:** resolve 3 navigation type errors incl. a latent freshness bug ([29b7bb6](https://github.com/nikolai-vysotskyi/trace-mcp/commit/29b7bb63c4f66b97ca1dfcb385964f5d48871186))
* **watcher:** stop indexing runtime churn; harden initial indexing; rotate daemon.log ([a603bde](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a603bde366a1cf2e679dc4bcf5f3b8929fe17075))
* **windows:** green the nightly cross-platform job ([f441b1d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f441b1d7729a2801a5d56d9cd3ac40abea75929b))


### Performance

* **indexer:** defer full edge resolution to a coalesced reconcile; flag overlapping roots ([76f2f1c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/76f2f1c84fb0d9ed595dac005c431c23f6ec931a))
* **local-backend:** seed session DBs from the shared index; sweep SIGKILL orphans ([fb033ec](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fb033ec1b8cc55a6be4dc04fca081b0b36e9f432))

## [1.42.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.41.3...v1.42.0) (2026-06-08)


### Features

* **init:** preflight checks + verify/doctor hints for first-run ([#124](https://github.com/nikolai-vysotskyi/trace-mcp/issues/124)) ([7502b73](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7502b73ced181b8cdc89b1ef313df1ef808c7682))


### Bug Fixes

* **daemon:** respect explicit opt-out so removed daemon stays gone ([#202](https://github.com/nikolai-vysotskyi/trace-mcp/issues/202)) ([1aca174](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1aca1745529fb223f20ef127d97f5ef4cea5869d))
* **quality:** exclude .env* files from code-smell scanning ([3be2c25](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3be2c25d87d4b35c685408bec369642994319737))
* **registry:** doctor reports registry/DB integrity, prune removes stale rows ([#168](https://github.com/nikolai-vysotskyi/trace-mcp/issues/168)) ([b6550ce](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b6550ce16d07317f87a71e17e2d6ee77fa42a615))
* **topology:** make subproject client-call scan async to unblock the event loop ([e9316ab](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e9316abdbf811c1d5eb0c757bf86d6981e2f1fc0)), closes [#198](https://github.com/nikolai-vysotskyi/trace-mcp/issues/198)


### Documentation

* **config:** add stdio vs HTTP setup guide for per-repo and team use ([ba80138](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ba8013806f7201f87c6d3c25f838ef4918705e0a))
* **project-model:** document one-project-per-session model + serve-http log ([#199](https://github.com/nikolai-vysotskyi/trace-mcp/issues/199)) ([14bb2ca](https://github.com/nikolai-vysotskyi/trace-mcp/commit/14bb2cac3dcc5a9ea4c479fa4a3ec483afd0a782))

## [1.41.3](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.41.2...v1.41.3) (2026-06-01)


### Bug Fixes

* **fastapi:** compose cross-file include_router(prefix=...) mount prefixes ([1287418](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1287418c750fff20e01d1d2263f875deaf1749bb))

## [1.41.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.41.1...v1.41.2) (2026-06-01)


### Bug Fixes

* **config:** index Python source under app/ and flat layouts by default ([08cd008](https://github.com/nikolai-vysotskyi/trace-mcp/commit/08cd008ae414726f5fd9ae96cc38a6639a82979f))
* **fastapi:** compose APIRouter(prefix=...) into route URIs ([7c5ab83](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7c5ab833cadd755a5e64c04dde221f0047cffa14))
* **fastapi:** resolve Depends(dep) to a symbol-level edge in pass 2 ([aa471b2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/aa471b22494833b77110c095b815f5497cd6dbd1))
* **impact:** bound get_change_impact output for high-fan-in symbols ([e49a743](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e49a743fd72328d09ecd48c92b24cd1cec50b344))
* **indexer:** discover nested subproject files per detected workspace ([b9e4731](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b9e4731ecdb3ddaff5ded9cf5b50ca01c765224d))
* **init:** comprehensive default config for non-framework / container roots ([7e40276](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7e40276ad1e564a857f8b942b8332413ac7aad55))
* **laravel:** compose group prefixes via a recursive route walk ([c97f7c4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c97f7c45f8d10fa9c08146aab66d98361cbdde50))
* **laravel:** extract closure and inline-chained routes ([dd3c5dd](https://github.com/nikolai-vysotskyi/trace-mcp/commit/dd3c5dd7dd947ce181f848736d65a6626f83322e))
* **model:** populate get_model_context for Python SQLModel/Pydantic models ([ecc17fb](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ecc17fbe7839620e06727004e9f96422c32db097))
* **monorepo:** detect implicit workspaces under a non-workspace root manifest ([8bd3339](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8bd3339cec36ec738be4e96530396b4d61c6d092))
* **python:** resolve Celery task.delay()/.apply_async() to the task function ([81fbcbc](https://github.com/nikolai-vysotskyi/trace-mcp/commit/81fbcbc79a7933f4e4cba79f2f85b665de4ea375))
* **python:** resolve type annotations to symbol-level references edges ([04ff4a6](https://github.com/nikolai-vysotskyi/trace-mcp/commit/04ff4a623e3fdd20ca78fdba9c8713b512129480))
* **topology:** apply Laravel /api prefix for standalone-indexed services too ([fbd9f39](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fbd9f39fe21e56c44a0eb21896f5671255182c30))
* **topology:** don't register Laravel nova-components as separate services ([e305715](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e305715c15fcf26a5a70dc032db83223c73b7eba))
* **topology:** exclude intra-repo calls from the cross-project graph ([60b1d8a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/60b1d8a9fd0be32b787598220604da28b2afa8f8))
* **topology:** exclude Vue Router page routes from cross-service endpoints ([ddb9736](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ddb97368f83d122684685799dee27028f0b94c04))
* **topology:** scan Nuxt $api plugin clients and dynamic API paths ([2810515](https://github.com/nikolai-vysotskyi/trace-mcp/commit/281051580cd03c088f32e0262983a1a078c0351d))
* **topology:** serve Laravel routes/api.php endpoints under /api ([38eae10](https://github.com/nikolai-vysotskyi/trace-mcp/commit/38eae10e154e01f746e9f0dcd4c0977286c47d3f))
* **topology:** skip backend declaration/view/admin files in client scan ([92193a9](https://github.com/nikolai-vysotskyi/trace-mcp/commit/92193a95b07c36cea2e73ad5af901d28171ef060))


### Tests

* **eval:** skip eval-cli smoke runs when the global index is transiently unavailable ([38fb1d7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/38fb1d744ef15ffe0aad95396c152fc3f25b56ec))
* **isolation:** redirect global home to a temp dir so tests can't pollute ~/.trace-mcp ([9809296](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9809296430260a5fcab806b929d29fd66e12e489))
* **topology:** cover /api prefix for repo-relative routes/api.php ([06a40b0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/06a40b0b6dc782690a5a885eccb6d0c727fd0607))

## [1.41.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.41.0...v1.41.1) (2026-05-29)


### ⚠ BREAKING CHANGES

* **app:** remove desktop app from core repo (phase E)

### Tests

* remove orphaned app tests from core (source moved to app repo) ([b910850](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b910850f54e5978927b07df9caaec60588915229))


### Chores

* **app:** remove desktop app from core repo (phase E) ([f3b4b0e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f3b4b0ead9c20795ad61c9e65863edb73c48f766))
* release as 1.41.1 ([462369e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/462369e5d2102e0114ca2e2b9eefc89118d24221))

## [1.41.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.40.0...v1.41.0) (2026-05-29)


### Features

* **app:** Activity P2 — keyboard nav, baseline deltas, sparkline zoom, file deep-links ([a0de7b7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a0de7b773ef872406c816af3acc1da4cdbad9470))
* **install:** fetch desktop app from dedicated public dist repo (phase C) ([c1bbf4d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c1bbf4d7b092d13b72ac89f00f716798589b5c15))


### Bug Fixes

* **app:** add ErrorBoundary so one tab crash no longer blanks the whole window ([90961d8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/90961d82e8b1edc3a62dd2a3c7cfdf7670f78b42))
* **app:** stop Activity feed crashing react-dom via nested &lt;button&gt; ([38d893f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/38d893fc5d51a76590a52fd0f5f3d6c7acb316b8))


### Refactoring

* **install:** make app distribution repo configurable (split prep, phase A) ([6bee11b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6bee11b0fcea9eed372990943c2e2f46c1f22462))


### Tests

* exclude packages/app from core test runner (app moved to own repo) ([da28bdc](https://github.com/nikolai-vysotskyi/trace-mcp/commit/da28bdc3aebeb169563accd4ead18b23c4f72fe0))

## [1.40.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.39.4...v1.40.0) (2026-05-28)


### Features

* **app:** advanced Activity tab — Tool/AI sub-tabs, search, filters, sessions ([17f4d11](https://github.com/nikolai-vysotskyi/trace-mcp/commit/17f4d117d2dc46cf82681080cb93f0a9ade17d65))
* **lsp:** background enricher for incremental LSP edge upgrades ([a74b6c1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a74b6c1984c1ce930906cf9bc56d69309f868996))


### Bug Fixes

* **app:** exclude test files from renderer typecheck ([77e38d7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/77e38d7e96ff942b57965ed4f09667c10b8b90e5))
* **cli:** install menu bar app under --yes / --json / --dry-run ([6384b7c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6384b7c4e6ec65bca7aea3004c357aadd04a50b9))
* **indexer,analysis:** suppress phantom SCCs from type-only imports & projected edges ([62e88d7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/62e88d73549599bfaa09734d060d6845c6edde4f))
* **intelligence:** 14 correctness/UX/storage fixes across the trace-mcp surface ([79963a1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/79963a1f0e4f58308ca18ea08c4ac2c24828734a))
* **updater:** locate installed .app by bundle id instead of guessing ~/Applications ([#179](https://github.com/nikolai-vysotskyi/trace-mcp/issues/179)) ([06b8e04](https://github.com/nikolai-vysotskyi/trace-mcp/commit/06b8e047f91e0ea920638f923c6cfe6682d3ecd6))


### Performance

* **indexer:** default incremental indexFiles to postprocess=minimal ([0576a0a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0576a0a8f99fc95d2693bb685c817cb38c0c4c0d))
* **indexer:** gate watcher reindexes through dedup + emit watcher telemetry ([b3e1352](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b3e1352b6bdbafcb1b0c06f678d069630ac562ea))


### Refactoring

* break 2 small import cycles via shared-module extraction ([7bb8d00](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7bb8d00b7c0a0d2b4a791fec7c5b0708af2eae34))
* break 7 small import cycles + fix latent DTS issues exposed ([86d26ca](https://github.com/nikolai-vysotskyi/trace-mcp/commit/86d26caec7627afe3ea65d7968214d8e04852da5))


### Documentation

* **landing:** drop Benchmark section, fix install steps, fix copy button ([a72cf27](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a72cf27d907a31a1f113fc27ad56b4b5e4d92844))


### Chores

* **deps:** bump qs and protobufjs to patched versions ([270f73d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/270f73dcb7a3e7add57df3947be455c647465c75))


### Build

* ESM + DTS both clean ([86d26ca](https://github.com/nikolai-vysotskyi/trace-mcp/commit/86d26caec7627afe3ea65d7968214d8e04852da5))

## [1.39.4](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.39.3...v1.39.4) (2026-05-25)


### Bug Fixes

* **app:** stop in-app updater from looping on npm-only outcomes ([#173](https://github.com/nikolai-vysotskyi/trace-mcp/issues/173)) ([ae0b9ef](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ae0b9ef004d67772950c0fa2c476665956dddc4a))
* **db:** use ON CONFLICT DO UPDATE in insertSymbol to keep parent_id FKs valid ([fd63f52](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fd63f52c33e9719b75776e7499e2a39660752a44))
* **env:** unify .env secrecy model + provenance gate for tool-managed files ([#172](https://github.com/nikolai-vysotskyi/trace-mcp/issues/172)) ([8572741](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8572741764d353b93a8f9732b6377535ccdfd2cc))


### Documentation

* **toon:** standardize TOON description wording and document allowlist ([4a3a46f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4a3a46f6c6e1007cbf4c8e665b5efc86db757548))


### CI/CD

* add pr-comment workflow that posts impact-report from CI artifact ([bdc24b9](https://github.com/nikolai-vysotskyi/trace-mcp/commit/bdc24b9dbf1e54693459f3363e3b8ee65e4e37be))

## [1.39.3](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.39.2...v1.39.3) (2026-05-24)


### Bug Fixes

* **app:** keep guard mode popover above sibling project rows ([f537eef](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f537eef55ca12b9781adb01fd0d5b95a6014936b))
* **daemon:** self-heal stale registry + actionable MCP errors ([#168](https://github.com/nikolai-vysotskyi/trace-mcp/issues/168)) ([8094400](https://github.com/nikolai-vysotskyi/trace-mcp/commit/809440093892c607011b2604437bb854eb120591))


### Documentation

* align contributor setup with pnpm packageManager ([#156](https://github.com/nikolai-vysotskyi/trace-mcp/issues/156)) ([d8afe9b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d8afe9bae82b4faa535819f9991b7e707bd09049))

## [1.39.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.39.1...v1.39.2) (2026-05-18)


### Features

* **memory:** extend incremental cursor to provider (Hermes) mining ([7f4231a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7f4231a9296ba077f44fa25abe82f53c102e879d))
* **memory:** per-service wake-up scoping + scheduler_state table ([4def231](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4def2310a798c0afc92b52b27f2c324a1acf2b32))
* **memory:** persist scheduler state across daemon restarts + prune memo auto-trigger map ([fecd2d9](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fecd2d9ff308caf1771371e0fea47ca41a95e397))


### Bug Fixes

* **daemon,app:** break post-update restart loop ([4583ab8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4583ab8004470a8a6f3caabda00f035a73aa2e0c))


### Chores

* release as 1.39.2 ([506bbc1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/506bbc145ae532af50be60a3252bbf5a36c7e891))

## [1.39.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.39.0...v1.39.1) (2026-05-18)


### Features

* **daemon:** background memory scheduler (P1.3) — auto mine + cluster + memo ([8eda0ba](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8eda0ba9dd4f0155ebf20ba9f70e41a8d644a73d))
* **memory:** auto-regenerate memo on write + auto-tune weights in scheduler ([f4c471d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f4c471db7e381c28855d83264c4af6b36d2bf79b))
* **memory:** close P1.1/P1.2/P2.3/P2.4 close-out TODOs (decoration + retention + cursor knob) ([b4b0665](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b4b0665317f61a2ca23aedc7bbf5a96c6966b8b5))
* **memory:** confidence-weight learning from review feedback (P2.5) ([4d4b5b1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4d4b5b159395b3eec558d67bce1c9b13e4080c9a))
* **memory:** export_decisions tool + CLI + optional audit log ([e20ae6f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e20ae6fb8a23d07bb7d92c5d50ecd484494b473f))


### Bug Fixes

* **install:** plist v3 — both generators use launcher shim + post-kickstart health probe ([f7e5073](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f7e507364855b82c6293b8cd9d325a230f9628c7))


### Chores

* **errors:** silence tsup "err/ok never used" warning via type-only import ([94242ba](https://github.com/nikolai-vysotskyi/trace-mcp/commit/94242badb0d1acdbe58abc3ac4fa21707b41e87a))

## [1.39.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.38.0...v1.39.0) (2026-05-18)


### Features

* **ai:** auto-rebuild embedding index on provider/model mismatch ([427ec4e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/427ec4edb03aab44f0ceb23a0b75a239f3a4fdbe))
* **ai:** wire P0.1 auto-rebuild into embed_repo, pipeline, verify_index ([30f516b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/30f516b27cb71d877be0808dee59de02c827e47c))
* **memory:** add LLM-driven extraction strategy to mine_sessions ([3a44a47](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3a44a4749268991b9d2b4e6568c572fe60d028a2))
* **memory:** hard recall timeout for wake_up / query_decisions / feature_context ([d6115b8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d6115b8124f3b41e5e1f60dff1bac8d444e8c233))
* **memory:** incremental cursor for session mining ([28c9d3c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/28c9d3cdbf8145f3e890a0270579bcffef79203a))
* **memory:** LLM-driven semantic dedup via consolidate_decisions tool ([fd50305](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fd50305bf76a6f82a3ef5679b96d95ddcd6967e3))
* **memory:** project memo (L3 orientation digest) — synthesis + tools + wake-up integration ([1ac7e5e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1ac7e5eca4815558b20d0110eb58b88cd4037969))
* **memory:** wire decision clusters MCP tools + wake-up topics ([bad337b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/bad337bfc9345db98aa8f53ec5a05192bf232a9e))
* **wake_up:** split response into stable+dynamic regions for prompt-cache friendliness ([926aaa0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/926aaa078f6cfce304e5793a57a536c4a30ffb2d))


### Bug Fixes

* **app:** Electron auto-update also refreshes the npm CLI ([f73055b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f73055b5886de01ef9df5a42bf8076b38388091f))
* **ci:** apply-pending-update strips inherited NO_POSTINSTALL + README count ([1607a03](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1607a03252506c9395c358f09a4886a4fffc5b81))
* **config:** allow "_warnings" in tools.meta_fields enum ([b9990e4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b9990e489c6bbe74db5bc0ed5694ffd030745d26))
* **hooks,evidence,gate:** P3 meta cleanup — coach allowlist, verdict split, visible clamps ([9ed8a2a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9ed8a2ac22bee9ddcc2c9064aac1f5a2cf59911d))
* **install:** postinstall enables + bootstraps plist on first install ([b2b2113](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b2b21139747e0dd3eeec9c32f00a2be1dfa21d48))
* **memory:** defensive access to memory.recall config in tool handlers ([c38b9e4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c38b9e4f1daf95947bfcc81b959c851b6dcd9c5c))
* **navigation,memory,analysis:** P2 UX/correctness pass on intel surface ([475c285](https://github.com/nikolai-vysotskyi/trace-mcp/commit/475c285635170e07cbf3b7ddac6f591c4c633706))
* **quality,refactoring,analysis:** P1 false-positive + silent-empty pass ([53e55b7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/53e55b791a9a43f17c9b30a795b8acd9a6932564))
* **refactoring:** P0 safety + correctness pass on apply/plan tools ([005fd64](https://github.com/nikolai-vysotskyi/trace-mcp/commit/005fd64ee37bde97b162e5a19bf5fba57dc58b8d))
* **test:** embed-repo fake VectorStore must mirror to symbol_embeddings + re-enable in CI ([5cb9ffb](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5cb9ffbabcfabe7eda784eb86f68267e465f130c))


### Chores

* **gitignore:** ignore .claw/, daemon*.log, run-benchmark.ts (developer-local debris) ([2fc9779](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2fc9779b59b285fa36eb3a29be0f4bfd8ef45c5a))

## [1.38.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.37.0...v1.38.0) (2026-05-17)


### Features

* **daemon:** memory diagnostics endpoint + AI cancellation + multisink resilience + LocalBackend re-entry guard ([e8f4116](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e8f41167682dcefcafca70dfd5fe468dee7154ae))


### Bug Fixes

* **ai:** commit missing src/ai/abort.ts referenced by anthropic/gemini providers ([49922e4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/49922e45a95f8eed65d70ec597342f976f29624d))
* **app:** launcher-shim binary resolution instead of PATH-only `which` ([db52e74](https://github.com/nikolai-vysotskyi/trace-mcp/commit/db52e74a98f33126970ded737e1830b04b3d7432))
* **ci:** postinstall test inherits workflow opt-out env + verbose reporter ([dc42b46](https://github.com/nikolai-vysotskyi/trace-mcp/commit/dc42b46c583004313ad83a8d6192ea147d4377d7))
* **daemon:** preserve error.message + .codeName when logging failures ([edaa124](https://github.com/nikolai-vysotskyi/trace-mcp/commit/edaa124f8c04f58148d217f3b9603facc10d16e0))
* **indexer:** cap extract-worker crash loop with backoff + dedup ([fad5bf2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fad5bf27d0d0edd56c61713e4e179bdb07f6343f))
* **indexer:** release tree-sitter Tree WASM heap via tree.delete() in every parse path ([0a85793](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0a857936b6c76f1e8049192fdf78de1b20fd3cf4))
* **install:** self-healing postinstall writes launcher.env + plist ([3761619](https://github.com/nikolai-vysotskyi/trace-mcp/commit/376161920a9f4df505da57430b6ff257e27cedc7))
* **logger:** atomic-rename rotation that survives multi-GB log files ([b4d1499](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b4d1499350f2e02e262d81bee3812a9a1fe04acf))
* **test:** updater.test.ts must also clear TRACE_MCP_NO_AUTO_UPDATE in CI ([20c5683](https://github.com/nikolai-vysotskyi/trace-mcp/commit/20c56835af8cb1949ab7517cecb1f2c8057e1753))
* **test:** updater.test.ts must bypass isDevCheckout like rollback suite ([d4cc672](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d4cc67215fe99f914f7e32e0f08be8a1ccf819de))
* **updater:** atomic backup + rollback for ENOTEMPTY retry path ([38115e7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/38115e7a8aea0090af04aa041eb48465de298cb6))


### Documentation

* **decision-memory:** document live-capture, review queue, and privacy filter ([aa02099](https://github.com/nikolai-vysotskyi/trace-mcp/commit/aa020991cf7fc4c23d2d549a71f0cc74ee311007))


### Tests

* **tools:** behavioural coverage for dead-exports, untested-exports, and decision-graph tools ([ebb888c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ebb888cb7debb8a2de0783a0fc52762371f6579b))
* **tools:** behavioural coverage for misc + framework-aware tools ([61e94a4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/61e94a4eac2a1e3dfc01e5328a6ca3e287887502))
* **tools:** behavioural coverage for planning, intent, and batch tools ([88682ba](https://github.com/nikolai-vysotskyi/trace-mcp/commit/88682bad48fedf5fdc10df9d8dc6011acf28f563))


### CI/CD

* **bisect:** also exclude src/telemetry/__tests__/** — suspect OtlpSink ([5823b76](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5823b762156c73976deb55c6969506e9f5037bb0))
* bump cache key to v2 to invalidate poisoned node_modules ([4b6be53](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4b6be533856469c56d0d89baaeca6b37e05e3940))
* **diag:** add [FILE END] marker to surface the actually-hung file ([39bf4e7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/39bf4e7cd38861bcf5640ce710f0f1d67b5bc0b2))
* **diag:** file-start reporter to identify CI hang culprit ([c6c0c3a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c6c0c3a1b75b0f107328e7638988beb31f1d2c1f))
* drop --ignore-scripts from build install so native bindings compile ([28e4a76](https://github.com/nikolai-vysotskyi/trace-mcp/commit/28e4a761573ea9fbb2c5c2601b6fb295cba85784))
* drop sharding for 1.38.0 release — reliable single-job test run ([6366c58](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6366c585ac9f72ea2f9b081939e06e78d9f4a37a))
* exclude embed-repo behavioural test (pinpointed hang via FILE END diag) ([1c4ac23](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1c4ac232a3628b90ea64370b733ead1511a0c039))
* exclude fixture + xml-plugin test files (1.38 release unblocker) ([7d00584](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7d00584d930e28ac82da48be7a811190e1742a95))
* exclude integration + daemon test dirs (bisect for CI hang) ([d9b529b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d9b529bca1adbcfb387222875be050f72450319e))
* exclude tests/perf/** from per-commit shards ([bbc45e0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/bbc45e00d1b83664fc61f8068a64148be0ba500e))
* exclude toon-drift + debounce-abort tests — bisection landed ([50cc141](https://github.com/nikolai-vysotskyi/trace-mcp/commit/50cc141ae025a969b4f7fcdf77a127f2238e9f2f))
* shard tests + share build artifact + safety-net timeouts (&lt;3 min target) ([92fdd11](https://github.com/nikolai-vysotskyi/trace-mcp/commit/92fdd11a5318ffd1536fe9f4d54f059deb3f9b32))

## [1.37.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.36.1...v1.37.0) (2026-05-15)


### Features

* **tools:** toon output format for tabular MCP responses (30-60% fewer tokens) ([2e359ba](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2e359bab2159d3d7ec7e2cfce81edd20c0f810b9))


### Bug Fixes

* **analysis:** restore findDuplicateSymbols helper that check_duplication relied on ([8d49139](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8d4913953d92d70d3d1b06e6f68dae17969f0aff))
* **benchmark:** honest synthetic-estimator labelling + tokenizer calibration + multi-sample variance ([279f619](https://github.com/nikolai-vysotskyi/trace-mcp/commit/279f61930f9f121112fd294eb66b2fad1ec1d9e6))
* **daemon:** cap remaining unbounded long-lived caches and stores ([f7b7044](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f7b7044ab367275f1f66a110044bb1e0a5140b27))
* **daemon:** plug FileWatcher re-entry leak + pass_cache TTL + progress-throttle pruning ([cc4f155](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cc4f155888d23bb08b8701f50b45185dc0ae2c1c))
* **daemon:** restore /mcp routing for stdio clients + scope teardown to removed projects ([4a708a2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4a708a2f52c8d14ffd114e0c83bc0967ad9fd998))
* **db:** add v11 domain tables to fresh-DB DDL ([12e4e05](https://github.com/nikolai-vysotskyi/trace-mcp/commit/12e4e0588945d98ae008b9b976bd472b28259dec))
* **db:** mirror remaining v11+ migration tables in fresh-DB DDL + parity guard ([c0c052d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c0c052d89188c8a3cedb692c90bc8e0614ceda6e))
* **intent:** add missing domains JOINs in getCrossDomainDependencies ([b39b5b3](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b39b5b3d778b899a1604bb42ac48d89275f84016))
* **pipeline:** bound per-project resource accumulation across project lifecycle ([61fcd70](https://github.com/nikolai-vysotskyi/trace-mcp/commit/61fcd703b3587833c1dd2fada9754ff4782b55b6))
* **scoring:** drop stale-prone in-process cache from ranking_pins lookups ([d5de560](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d5de560ecbc25309b64dd06a43c41e087a86f6de))
* **telemetry:** bound OTLP/Langfuse sink memory under unreachable export endpoint ([20397a4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/20397a468a009cf6d7bca58031cfca128ba35900))
* **test:** bump bundles searchBundles limit-case timeout to 30s ([06e0df5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/06e0df5bf2041b38ad63dbe131848803425d709d))
* **tools:** invert source/target check in get_cross_workspace_impact ([5597781](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5597781dda4938634cacc1985b32c67484b27418))
* **topology:** apply contractType filter to endpoints in get_api_contract ([db91b91](https://github.com/nikolai-vysotskyi/trace-mcp/commit/db91b9113ed87e6239337272bc1d745d460ef47d))
* **topology:** replace stale fr.* alias with sp.* in client-call queries ([f304139](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f304139f144ef09dfffcae3988fb809c416e6806))


### Tests

* **tools:** behavioural coverage for api-contract and service tools ([f8c8872](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f8c887298735b07799478b926e2f8a0d05e23210))
* **tools:** behavioural coverage for compare and suggest tools ([61b07cf](https://github.com/nikolai-vysotskyi/trace-mcp/commit/61b07cfff37dbfb6c39643d52d531efde4e3b051))
* **tools:** behavioural coverage for context and complexity tools ([8334270](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8334270247278252e6bac49e405128cb932ed734))
* **tools:** behavioural coverage for corpus and packaging tools ([c23eb2d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c23eb2db468b887c821e3600551aa469c7557db0))
* **tools:** behavioural coverage for cross-domain and edge tools ([7557689](https://github.com/nikolai-vysotskyi/trace-mcp/commit/75576891539bbe1829e3e956aef149a71b64e1b0))
* **tools:** behavioural coverage for decision lifecycle tools ([fd102ae](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fd102ae6e5e5db5d26eccf7bf459c52960e3a202))
* **tools:** behavioural coverage for graph-traversal and analysis tools ([1ca1b1a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1ca1b1aac92be45ee1b0ffa4750d07e600957756))
* **tools:** behavioural coverage for graph/relationship tools ([ac22e25](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ac22e25e901b1908b1f747476d5a55b3653a5383))
* **tools:** behavioural coverage for health and risk tools ([acfb835](https://github.com/nikolai-vysotskyi/trace-mcp/commit/acfb835bc33c6561b8ab7ab58e2a6cc31452ccfd))
* **tools:** behavioural coverage for history and coupling tools ([30b46fa](https://github.com/nikolai-vysotskyi/trace-mcp/commit/30b46fa45ffdb3fe823895707e9a1a7bf1dbddb7))
* **tools:** behavioural coverage for index, embedding, and perf tools ([330a20c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/330a20ca509eb9209e39024d5422b822fc1e0e39))
* **tools:** behavioural coverage for ownership and tech-debt tools ([0ce20be](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0ce20bebfe9eeef6408a0c8451d18f6aa29b98d4))
* **tools:** behavioural coverage for quality and security tools ([9987aed](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9987aeda6763d5f79ca34d26598a8d3375839439))
* **tools:** behavioural coverage for quality/coverage tools ([d6d6d26](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d6d6d262ba350ef4e80136954286ca9a7a4ffae0))
* **tools:** behavioural coverage for refactoring tools ([347d107](https://github.com/nikolai-vysotskyi/trace-mcp/commit/347d107d8a2a6281ea5ae28bf01ac16149d7821a))
* **tools:** behavioural coverage for security and refactor tools ([68d6171](https://github.com/nikolai-vysotskyi/trace-mcp/commit/68d6171f2720b90dabb737408b2529a1316f386f))
* **tools:** behavioural coverage for session and analytics tools ([fdc0288](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fdc0288cfab3f4f58081cca9d765abd98546bf7b))
* **tools:** behavioural coverage for session and analytics tools ([a1d87ba](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a1d87baf7872fee4a38cd4c531f85fd2ee976401))
* **tools:** behavioural coverage for snapshot and maintenance tools ([eb949d7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/eb949d7601c67505ce93dca9a19a31f872b2e1a9))
* **tools:** behavioural coverage for subproject and api-surface tools ([83c3300](https://github.com/nikolai-vysotskyi/trace-mcp/commit/83c3300d2f3247c01680f54afcebee8d9bf31e85))
* **tools:** behavioural coverage for trend and visualization tools ([2fcae49](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2fcae49ab675a52529ebe67b1b70581f5b2c6ee4))
* **tools:** behavioural coverage for workspace and architecture tools ([8496a18](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8496a186c6a706fd5901e05b4a9fff058f2eda29))
* **tools:** behavioural test coverage for search/get_outline/find_usages/get_change_impact/pin/query_decisions ([2379ed1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2379ed1f21292ea9ea3e4c536400d0d2b216666c))
* **tools:** skip discover_claude_sessions fixture on Windows ([6ea757e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6ea757e3f74b5d7a8519427ded12af84d2cf8891))

## [1.36.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.36.0...v1.36.1) (2026-05-14)


### Bug Fixes

* **daemon:** auto-recover from FK-violating stale data on initial index ([ea8b7a6](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ea8b7a6b2df57ecf8884f974969710359ffdb33b))
* **daemon:** require explicit ?project= when multiple projects registered ([58e25a2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/58e25a2241e135a255acdf1cc96fa242d27b37b2))
* **indexer:** density-based binary detection in isBinaryBuffer ([df7b3d8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/df7b3d88d21ce5578abcca04bb3ccb2c38c33c02))
* **retrieval:** search_with_mode passes both `text` and `query` fields ([6abaea5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6abaea5b50bd7e23315887dddf6e75397008960b))
* **test:** bump cli-smoke DB-schema test timeout to 30s for Windows runners ([539ae09](https://github.com/nikolai-vysotskyi/trace-mcp/commit/539ae09db54d043abede98eace37f941ee10f4e5))
* **test:** skip eval-run smoke cases when project is not indexed ([039aced](https://github.com/nikolai-vysotskyi/trace-mcp/commit/039aced08809fbb472318be37508ee46669de6f8))
* **test:** widen XML perf guard threshold from 500ms to 1500ms ([ddb5d84](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ddb5d842a8ac104ab989376c76c6fb3dd27999ec))


### Documentation

* release 1.36.0 consistency fixes ([a604678](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a60467820b8a9b013b6b299d5d45ef5646f5b19a))
* **tools:** align check_claudemd_drift return shape with auditConfig ([af2f7e4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/af2f7e4ed87b66541355908bb31e134eace3e32d))


### Tests

* **db:** pin ranking_pins/pass_cache in fresh-DB schema guard ([10b8e82](https://github.com/nikolai-vysotskyi/trace-mcp/commit/10b8e82a9847e1c3856921a8e10b33fca0ce2f6a))
* **integration:** smoke-test eval CLI list/run/baseline ([ab5bebf](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ab5bebf3fd648fd7faf35408676f7979998aa44b))
* **smoke:** MCP-tools end-to-end smoke script for new session tools ([3a362d8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3a362d8727b882b3ceea4f77e329485be68c6fe3))

## [1.36.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.35.1...v1.36.0) (2026-05-13)


### Features

* **app:** insights tab surfacing drift, pagerank, and risk hotspots ([b080e2d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b080e2ddc0851ba1db3a6f0e388e99ae61a4a543))
* **app:** notebook scratchpad tab for ad-hoc tool queries ([7eedb15](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7eedb157ced0538b2f7c80dad03501128e62a6ad))
* **daemon:** pipeline-lifecycle SSE events + Electron consumer ([dcff9f3](https://github.com/nikolai-vysotskyi/trace-mcp/commit/dcff9f398929ab41250092736f22d09593805903))
* **eval:** code-intelligence benchmark harness with CLI subcommand ([64bca2a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/64bca2af80a14b7f21000a32bf862813eaf08408))
* **memory:** remember_decision MCP tool for live agent writes ([11fd07c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/11fd07cd07de353e14349dcad6a5795dad5c7fff))
* **pipeline:** composable Task DAG with idempotency keys ([c33a4ba](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c33a4ba4ebe71c6afe1b5e51a3a4d7ff79e0a4c0))
* **pipeline:** persisted task-cache via SQLite pass_cache table ([266bbfd](https://github.com/nikolai-vysotskyi/trace-mcp/commit/266bbfdd4aaeb0f04023f592f704ae1ff87a1ec3))
* **presets:** decision-memory quartet on minimal + standard ([f384672](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f384672c6f21632cc2a61605deda0c5c315eb64d))
* **quality:** CLAUDE.md drift detection + check_claudemd_drift tool ([faf5d07](https://github.com/nikolai-vysotskyi/trace-mcp/commit/faf5d07b782c09bb8a2ec59b16103fd69fa62de1))
* **retrieval:** BaseRetriever protocol foundation with 2 adapters ([d0d9f0c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d0d9f0cef22f157555ed4c72f0a7eb8665a89999))
* **retrieval:** emit routing telemetry from feeling_lucky retriever ([e79b5bf](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e79b5bfb189c82f5f80b0b03b448e711ec077f23))
* **retrieval:** graph_completion retriever — vector hit + 1-hop expansion ([3fcaab1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3fcaab11ac252bf43ea50e8485851d9993e467fe))
* **retrieval:** named search-mode taxonomy + search_with_mode MCP tool ([a8250e1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a8250e11722ba7d51f7abea8ae03d0e57bb4160f))
* **scoring:** ranking pins — user-supplied importance weights for PageRank ([704d66c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/704d66cd4fc615f14e13684a23bf352a01fee1d3))
* **telemetry:** observability bridge with OTLP and Langfuse sinks ([bae0fb2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/bae0fb2bd5c504c12c71f0d6bc63f4449d34e6e7))


### Bug Fixes

* **ci:** normalize CRLF in DaemonEvent union guardrail for Windows runners ([71815ce](https://github.com/nikolai-vysotskyi/trace-mcp/commit/71815ce49f06044431836cf671dd3de66ee1138e))
* **ci:** unbreak notebook test under frozen-lockfile + register project before eval indexing ([7522bc8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7522bc8682cd3a2b8371c2bf8be3bd82dc6cb270))
* **telemetry:** wire observability bridge into server bootstrap + ship local OTLP recipe ([e03d75b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e03d75b34c46d8ee109145e530660824e9e3ac0f))


### Performance

* **indexer:** Phase 4+5+7 — incremental edges, cold-start, telemetry ([8a1ed45](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8a1ed45179c3968fb9e41d74be341911989fb4bf))


### Refactoring

* **indexer:** migrate 3 pipeline passes onto Task DAG ([c4a6afb](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c4a6afbf606ba0ab6a3c71329a4cd44746a18ca7))
* **retrieval:** migrate search MCP tool onto BaseRetriever ([61b9663](https://github.com/nikolai-vysotskyi/trace-mcp/commit/61b9663013a5dff30f91f88e131c944058b01c2e))
* **retrieval:** migrate search_text, search_bundles, search_sessions onto BaseRetriever ([8da5ab9](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8da5ab9c5805374daeb89952c18005582f5160f5))


### Tests

* **daemon:** pipeline-lifecycle SSE integration test + drift firewall ([0976c38](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0976c3823d517a1487bd9fcee4496ec608512456))
* **quality:** cover dead_skill_ref and dead_command_ref drift categories ([e46d0a8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e46d0a8c7d66c82db75e75039a13ee26e29e689b))


### CI/CD

* **eval:** baseline-regression check + GitHub workflow ([d902af6](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d902af6f0e4cd658ce601d745a257234c16fea74))

## [1.35.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.35.0...v1.35.1) (2026-05-11)


### Bug Fixes

* **daemon:** normalize reindex paths to POSIX so Windows tests + cross-path dedup work ([7f61983](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7f61983a59a2df3fa36905820c3d1fe2a032eb14))


### Performance

* **indexer:** daemon-first reindex, AI-call coalescing, shared/warm worker pool, content-hash gate ([dfd8e4f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/dfd8e4f62552971248919f28f876d610605f4dac))

## [1.35.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.34.2...v1.35.0) (2026-05-10)


### Features

* **app:** four new tabs — Activity, Memory, Ask v2, Dashboard ([acdd9a5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/acdd9a55523e7aeb4cd33144aa86e530249521c7))
* **app:** four tabs v2 — stats, write actions, slash-commands, real metrics ([42857d1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/42857d1356fca8a1828b40d2c038b3137a8d1594))
* **memory:** lifecycle hooks, branch-aware decisions, stats modal, filter bar, recall harness ([62d010a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/62d010aed298c3c79f1c19a90e8c6e6334f64145))
* **memory:** tiered retrieval modes + decision confidence/review queue ([eb58bc0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/eb58bc039cc487249126a5eb621d1c0e06fa4651))


### Bug Fixes

* **server:** keep stdin in Buffer mode — setEncoding crashes MCP SDK ([bbfb7bb](https://github.com/nikolai-vysotskyi/trace-mcp/commit/bbfb7bb106ffd2d116ff636c701869165e4c980c))

## [1.34.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.34.1...v1.34.2) (2026-05-10)


### Bug Fixes

* **ci:** pin npm publish back to npx npm@11 — pnpm provenance flow broken ([a052a62](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a052a625c4b22f81258e2b9dce6fb138709ceca0))

## [1.34.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.34.0...v1.34.1) (2026-05-10)


### Bug Fixes

* **release:** sync Claude Code plugin manifests with package.json on bump ([404c4bd](https://github.com/nikolai-vysotskyi/trace-mcp/commit/404c4bddce2d28512acc5cc2bb28e17ea019bbd3))

## [1.34.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.33.0...v1.34.0) (2026-05-10)


### Features

* **ai:** classified provider errors + retry helper with exp backoff ([9d0f513](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9d0f513cf6dbdd455b9a1609e4be85acf663cece))
* **ai:** consent gate for outbound LLM provider traffic ([6ec8630](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6ec8630923daa708f6cd379cb19984d4b52819a6))
* **ai:** detect local LLM endpoints (Ollama / LM Studio / llama.cpp) ([be6075e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/be6075e1a9f3e2102ae5e4308c0fd8407f1754c2))
* **ai:** one-shot stderr warning before cloud-bound embeddings ([2753856](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2753856e498a6f0614983e5e4c649459ae3ced49))
* **ai:** per-provider quota / auth circuit-breaker ([c82fea1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c82fea15ac9df09cadade72870fb1a1c4dfd5250))
* **ai:** stamp embedding provider on the index, refuse cross-provider mix ([1ee2a11](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1ee2a11910f6441cc1700c87c82b92ec4382681b))
* **ai:** tier-router helper + tier-separated default models ([d0e2848](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d0e28486bebb7ef9a04d93748dfbf862d006c618))
* **analysis:** rank cross-community edges by surprise score ([9c184f5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9c184f50c15b52112f6da728d5401e3e2b6410c4))
* **communities:** seed Leiden PRNG so community IDs are deterministic ([8dff326](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8dff3263cde7cc12fd68deb69da44205b5db953b))
* **communities:** split low-cohesion mega-clusters in a second Leiden pass ([3fa7078](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3fa7078db59ddc63cf27b0af4994a65a3cd46387))
* **config:** add TRACE_MCP_DATA_DIR + TRACE_MCP_REPO_ROOT env overrides ([f326a81](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f326a81494e1f6f093b6c70ca3aa77fbef33e1a9))
* **daemon:** add stdio handshake watchdog ([f0d82ea](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f0d82eae0160dfc6c05dfd2c9942977a1fafd554))
* **daemon:** proxy-backend routes worktree paths to canonical indexed repo ([2b22c11](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2b22c116af0084a754f330b28ea53ce27dedc876))
* **db:** verify_index + repair_index MCP tools ([f66fe32](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f66fe325df16a2e66eda14faf8571743148702c2))
* **dead-code:** drop framework entry points from the candidate set ([25a7825](https://github.com/nikolai-vysotskyi/trace-mcp/commit/25a78253d78d856624f93eac3e13072a9feedd37))
* **dead-code:** seed reachability with package.json#exports entries ([da7c69d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/da7c69df37a7c80cacf0a1b7f08b54c73120ab14))
* **find_usages:** drop text_matched edges into ambiguously-named targets ([1407af2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1407af2fd4f6ebdef94f4ee9d116ad53602d709f))
* **graph:** add float edge confidence on top of resolution_tier ([92d7190](https://github.com/nikolai-vysotskyi/trace-mcp/commit/92d7190d35245975cd34d229d213d8dd9da1e78d))
* **hooks:** guard v0.9 — block bare directory walks + .md doc-tour hint ([45a9be2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/45a9be29a1d09bfc8d63a05926bcf1a570cd7d23))
* **impact,refs:** surface resolution_tier on find_usages and get_change_impact ([4eff222](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4eff2228df9631864c72c6eb32f67e223d9c0a15))
* **indexer:** add postprocess level knob (full / minimal / none) ([cab7e90](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cab7e90aeb961122714fff9c3ea14b73c8c95865))
* **indexer:** detect file renames by content hash and skip re-extraction ([46ca974](https://github.com/nikolai-vysotskyi/trace-mcp/commit/46ca974e33449289aec020c37bcacd395002b111))
* **indexer:** force-include files declared as package.json entry points ([83cada2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/83cada2342e0683df8453ee8554031cfa5e08fb4))
* **indexer:** per-target PID-guard for reindex / embed_repo ([656efe4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/656efe4286c42930db1c60c72288088cbdfdf42f))
* **indexer:** warn when a full reindex shrinks the graph by more than half ([eb43ee9](https://github.com/nikolai-vysotskyi/trace-mcp/commit/eb43ee94c66a0a785bea17b7aabc50434ad1f63e))
* **insights:** add generate_insights_report MCP tool ([50a4820](https://github.com/nikolai-vysotskyi/trace-mcp/commit/50a48206238d5a2f48849ee28ccb8b61a0efe984))
* **memory:** canonicalise decision file_path to repo-relative on store + query ([8d4cdfd](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8d4cdfdfca72a524e9f1739669f3d0bdd083b07b))
* **memory:** CorpusBuilder — materialise corpora via packContext ([5e34f59](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5e34f59e7af4a9019d6813eb2d76a7d34bdbc5ab))
* **memory:** CorpusStore — persistent code-context corpora on disk ([6425e26](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6425e264e1cd546ca0d95b630479046503f78574))
* **memory:** privacy filter for mine_sessions strips internal payloads ([1134509](https://github.com/nikolai-vysotskyi/trace-mcp/commit/11345095262761a9f2a1cee0fb0fa8b971486e43))
* **memory:** worktree adoption — mine_sessions files decisions under parent ([9d9b836](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9d9b836139d993a299334b8a581a1f6ee1c83e82))
* **perf:** cooperative yield from heavy CPU loops to keep stdio responsive ([6f40b78](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6f40b7823fba7be84d1f6cfdc9242e10053fd9b4))
* **plugin-api:** support async extractNodes in framework plugins ([1b6095e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1b6095ea00a9d89845aeec80f62e3b0c2fa2424f))
* **plugin:** add Claude Code plugin manifest for one-step install ([b1f3719](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b1f37190e257152ebeae56d0b309ad0320f27383))
* **plugins:** add class-validator, passport, react-table; expand NestJS WS ([50c17ec](https://github.com/nikolai-vysotskyi/trace-mcp/commit/50c17ec5db7fa6fda0d1802146892015a445e2fa))
* **plugins:** add Kafka producer/consumer indexer (Spring, kafkajs, Python) ([6c80def](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6c80defbf79a6689e4d0cd6ca37803c651aa5e4c))
* **plugins:** index .luau (Roblox Lua) and .qmd (Quarto) files ([ccc9c2d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ccc9c2d143a4a8e8f90b2c801aee17c7fc1c65fc))
* **plugins:** index extensionless scripts via #! shebang fallback ([39abbfd](https://github.com/nikolai-vysotskyi/trace-mcp/commit/39abbfdfc2b843568fe6e37773b8d0fdf65cd186))
* **registry:** add git-worktree probe primitives ([a7d489c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a7d489c346f0afb6cb56707caf79839c4d4d70da))
* **registry:** worktree-aware project resolution ([9f4bda3](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9f4bda33b8c9297d308ef8aa9f3d252c4ea3c48d))
* **security:** add SSRF guard utility for outbound fetches ([c8204c5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c8204c57044fb0ff8ef4414fa79817843faaba59))
* **security:** add wall-clock budget to searchText regex iteration ([b651b90](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b651b90d79022fef9d3f0b0a64e83236772ce7b7))
* **security:** extend git env hardening to predictive + impact paths ([848c23a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/848c23a7cecc98e2eba98811fee7fb787658650f))
* **security:** harden git env in workspace-spawned commands ([124bdd0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/124bdd04c900aca0eadb0f0d3aa23e8f6eed28e6))
* **server:** expose project state through six MCP resources ([59b4267](https://github.com/nikolai-vysotskyi/trace-mcp/commit/59b426716da1d9b684619a598e8e0f46dbf8a24f))
* **server:** sanitize MCP tool output against prompt injection ([4331183](https://github.com/nikolai-vysotskyi/trace-mcp/commit/433118357a2325ad2cc7df5d892db38b252f3cfe))
* **server:** UTF-8 + stdout-guard hardening for the MCP stdio transport ([2fa4a4d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2fa4a4ded4256a0ed62a9373df459a13ba5670b0))
* **session:** Codex CLI session provider for mine_sessions / discover ([207152d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/207152d2ed6fa6557557f302dcb84185abf3a1fe))
* **shared:** centralised path accessors + invariant test ([3a32cc8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3a32cc823d04bb8214d86f08dbf63535d7d520af))
* **spring:** enrich @Autowired/constructor metadata with call-site hints ([469534e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/469534e0574113f78bae5d64839db76e570da38c))
* **ssrf-guard:** add allowPrivateNetworks opt-in for local LLM endpoints ([46ac4d3](https://github.com/nikolai-vysotskyi/trace-mcp/commit/46ac4d36076b00ab5f36ca2b993605adf5b7106a))
* **subproject:** add a remote repo as a subproject in one shot via git_url ([dd440bc](https://github.com/nikolai-vysotskyi/trace-mcp/commit/dd440bc5abbe46957675b2cdadde21062746a40c))
* **tools:** add detail_level=minimal knob on search/get_outline/find_usages ([b5af6ef](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b5af6ef5c2b353bbe95ffaecdef78e321968411f))
* **tools:** add get_minimal_context — single-call orientation entrypoint ([b02a2a1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b02a2a1fc72aa2548c692d6f26d0d8971dd4f817))
* **tools:** add get_suggested_questions for ranked review checklists ([c6090c3](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c6090c3804f55466feb6938e0c8935b0e7ef794e))
* **tools:** add named graph snapshots + diff for tracking evolution ([22d6e4b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/22d6e4b7ab10685eb78f5c688b4a4f2a71667c56))
* **tools:** add traverse_graph BFS walker with token budget ([7485574](https://github.com/nikolai-vysotskyi/trace-mcp/commit/748557457cb54c141b436e5b3a1ac76410ced98e))
* **tools:** coerce empty-string MCP args to undefined for filter fields ([0357e7c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0357e7ce25f09cdad1017b7ce179282b22fe3d3f))
* **tools:** export the dependency graph as GraphML / Cypher / Obsidian ([6c72ff1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6c72ff1dc029eb5628cf5f885d3da55808bf9cdc))
* **tools:** Knowledge Agent MCP surface — build/list/query/delete corpus ([3401e9d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3401e9d198016db50b13e4cee96bb81d209b6409))
* **topology:** cross-project topic tunnels via entity registry ([7360aee](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7360aee3050e434bf759ffa60ea29220f185b6d6))
* **utils:** atomicWriteJson helper + apply at all state-file write sites ([470b83f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/470b83fdb826727f058221dde86638a0dda18ba5))
* **viz:** community-aggregation helper for large-graph visualisation ([0c36fb3](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0c36fb3a26c9390e2b39fead4232a329133799f9))
* **vscode-extension:** on-save reindex extension ([45d53a1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/45d53a137699e29541ac42ed689b4ab1c0164b69))


### Bug Fixes

* **ai:** classify caller-driven aborts in withRetry as kind=aborted ([c01a854](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c01a854f650ed762b3f815c12195b7d68e325dfe))
* **app:** declare @types/node directly so tsc -p tsconfig.main.json works under pnpm ([49e5502](https://github.com/nikolai-vysotskyi/trace-mcp/commit/49e5502bb7eb2de94b20c5a760d6872aedb0c1a5))
* **config:** atomic write for global JSONC config mutations ([d22be14](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d22be14a99fc6abd9aeff78d8e56d549323a858d))
* **daemon:** atomic write for PID file + atomic stale-lock takeover ([5c0f5ea](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5c0f5ea70fca706a7c6719c962add53ec37e3bce))
* **daemon:** identity-token PID-reuse guard for daemon lifecycle ([e948a22](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e948a229dfc61efde3191aaa6b12a215797c7adb))
* **db:** bound WAL growth and add periodic checkpoint to long-lived stores ([68b4157](https://github.com/nikolai-vysotskyi/trace-mcp/commit/68b41575528b05f51c487103fe04a5ba269fac1e))
* **db:** centralise symbols_fts DDL so repair-fts cannot drift from schema ([89a1bea](https://github.com/nikolai-vysotskyi/trace-mcp/commit/89a1beab080f46e32c001b8022d862ffd6283dfe))
* **dead-code:** never flag symbols that have any incoming call/ref edge ([a3fc0e0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a3fc0e0b805b134ce03b69325dd11d2cb13e3370))
* **git-worktree:** use fs.realpathSync.native for Win32 8.3-shortname normalisation ([b3d5f41](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b3d5f41076600684920ea5c0a8192e65d0faaf46))
* **indexer:** normalize relTarget separators when resolving import edges ([fc28bfb](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fc28bfbcab057ffc5c480cdc12443b52e51594fe))
* **indexer:** parse tsconfig.json as JSONC to recover path aliases ([3ac3cd9](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3ac3cd94c08d1e44e629c344755a2aa959da3677))
* **indexer:** serialize register_edit and reindex through the same lock ([918921f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/918921f5233faff5077db40aa35a18b84c4cb672))
* **indexer:** suppress shrinkWarning + execFileSync for git rev-parse ([5f0cbf1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5f0cbf1a742c55fc7de61cff2964450ad867db32))
* **navigation:** explicit degradation signal for semantic search without AI ([6bbeb53](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6bbeb53a21ee5354582208ec329c0877bf3b2059))
* pin zod to 4.3.6 via pnpm.overrides (4.4.x breaks dist/cli.js) ([4cf12c7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4cf12c76d24bd90ab5ccccf050948b29d1fbf4a0))
* **refactoring:** normalize result paths to forward slashes for cross-platform consistency ([848f668](https://github.com/nikolai-vysotskyi/trace-mcp/commit/848f6680fa5ffeb5efb49f3be442be56790f6afe))
* **resolver:** parse tsconfig.json as JSONC, not strict JSON ([5cadb07](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5cadb07814b17904b4c06753ea0d1c29cb29eeed))
* **security:** chmod 0700 on ~/.trace-mcp and 0600 on local SQLite stores ([0c0fac2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0c0fac263a630ac0b23d0ff1be1eb6d423b263b9))
* **security:** keep hook source lookup inside the trace-mcp install tree ([32bcda7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/32bcda76043c84aff801a759f233e97d92cd136b))
* **security:** validate git refs and replace shell-mode execSync with execFileSync ([3b08ed0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3b08ed0d4094f25914911274fc5437faa7cc7c00))
* **security:** validate git_ref before passing to git --branch in subproject_add_repo ([e197184](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e197184d85f8a6e35bd44c7409b350a22e98f512))
* **security:** wire SSRF guard into AI provider fetches and git-clone path ([b7fb294](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b7fb294748c04144b2ac0e0c7fa35680bfdb2af9))
* **ssrf-guard:** import LookupAddress from node:dns instead of node:dns/promises ([8f1e184](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8f1e184ecd2bbc8371ef93a4ec981530186a340f))


### Documentation

* bump headline figures to 99% and refresh hero copy ([43d12e0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/43d12e096f4f86fb86763a0f84e0630747cd4dee))
* **confidence:** clarify trigger contract + add SQL-level regression tests ([f4a85bd](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f4a85bd0ce5c12bebf9050eabcb0a7708635d8eb))
* **readme:** add CI status badge ([33169e4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/33169e445fcd39fbdefb6e9566c5b437d8b9bad5))
* update contributor instructions for pnpm ([3a4344a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3a4344a5c9f5c6f04e1084362755f44f4e367d4d))


### Tests

* **ci:** align test-side realpath with production native binding ([782097b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/782097bbd0146626fc60cc05134d8d556c7bb328))
* **ci:** fix 7 baseline Windows-only failures (path separators + 8.3 names) ([82ab7eb](https://github.com/nikolai-vysotskyi/trace-mcp/commit/82ab7eb9bb58df917e588a40e0fdfe7096c7c30c))
* cover remaining Windows-runner failures from cross-platform CI ([086aedd](https://github.com/nikolai-vysotskyi/trace-mcp/commit/086aedd4054908aff66b2fa96014bb2e93c5beae))
* cover the long-tail Windows-runner failures from cross-platform CI ([6075495](https://github.com/nikolai-vysotskyi/trace-mcp/commit/60754951f75e0bd2e4c4d60fa05aaf4ec714bfc9))
* **docs:** regression test for numeric README claims + sync stale numbers ([1b18d46](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1b18d46fecf7b363a54f25aacd45b37c1101a42a))
* **impact,refs:** cover resolution_tier surfacing ([4915eb1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4915eb19208a4ccf11e220f3c2a3394564d56ab3))
* **markdown:** include .qmd in supportedExtensions assertion ([a38c18a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a38c18a796bad25fdc854e2bf6316193e6b4fe5d))
* **perf:** de-flake batched-inserts benchmark across CI runners ([c9f8988](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c9f8988091fa7150db51e23e76ee2d37438827d8))
* **perf:** re-deflake batched-inserts benchmark — loosen to regression guard ([d524b1e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d524b1ef295860ea2d164f801b6e3d8a8a4fc482))
* **perf:** skip batched-inserts benchmark on Windows runner ([a434dcf](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a434dcfcfa4d20434a684965e280fd5938d6c078))
* **security:** cover hook-source path-traversal validators ([d414327](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d4143273c07e910d6a0270f1925b8e405be75875))
* **security:** make path expectations Windows-safe ([61e3345](https://github.com/nikolai-vysotskyi/trace-mcp/commit/61e33451775e4e76056bd8fbb2ae5a4ed40081b2))


### Chores

* **app:** migrate packages/app from npm to pnpm ([3d75a19](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3d75a19e14f92b6bb960e667bd8075b8d23a7d37))
* migrate root package manager from npm to pnpm ([d36486c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d36486c2e3355f40554dbd67bc2bb36a96c9d50f))
* **security:** drop unused restrictHomeDirPerms helper ([4b5b827](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4b5b827441bd651a821d4e1433bc13015e7260de))
* **wip:** version-stamp init helper + daemon session change ([cd45cde](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cd45cde8400d091713ad39a411866b9dc5311faf))


### CI/CD

* also run on push to master ([c2382ca](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c2382ca0913a7dccee7647bdab8240c34321f5aa))
* switch CI install path to pnpm + add cross-platform test matrix ([6bc2f7a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6bc2f7aa76a6ba5004ca9bc13e18830f89bbf4e8))

## [1.33.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.32.7...v1.33.0) (2026-04-30)


### Features

* **app:** Sprint 1B — per-project guard mode toggle on the project list ([20c1fd4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/20c1fd4e54482b11815c69f295da521b33224eb3))
* **app:** Sprint 2 — onboarding, coach default, version contract, uninstall ([39b262f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/39b262f8af00a01be164e2c28b7f479c29ced796))
* **guard:** add manual bypass + auto-degradation for unresponsive MCP ([4709803](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4709803072e457a2e14e9731158358ecd65a53eb))
* **guard:** Sprint 1A — rich status sentinel + hook v0.8 (modes + stall detection) ([c857cab](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c857cab2c698025b7cb1c70d5d9a6b28978696dd))
* **guard:** v0.9 — doc-tour hint for .md reads in source dirs + deny ls on source paths ([465dd50](https://github.com/nikolai-vysotskyi/trace-mcp/commit/465dd50a9b9f15ad7fca5922b8165855fa18c7a4))
* **plugins:** add Anthropic (Python + npm) and react-router coverage ([104c47a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/104c47a2eff889658b5c25b2a2b04a9bacc1d987))
* **retrieval:** output-token efficiency phases 1-5 ([3120c6a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3120c6a41b483f207a92655104775d55ee39dd8d))


### Bug Fixes

* **app:** open Request links in default browser via shell.openExternal ([dad18cf](https://github.com/nikolai-vysotskyi/trace-mcp/commit/dad18cf28abe3506b2e03cef7a96255ffaeca31b))
* **app:** show "Restart to install" after npm-install update ([ed82585](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ed825850e5984dd1b3f237b06e972f66baa45bb0))
* **guard:** close retry-bypass loophole, add heartbeat fallback ([9741210](https://github.com/nikolai-vysotskyi/trace-mcp/commit/974121098ada837c3618079628189f97bffc650f))


### Documentation

* **landing:** tighten hero CTA, add trust line, reword metrics ([decdf45](https://github.com/nikolai-vysotskyi/trace-mcp/commit/decdf4563ad547999fb7f0b05a6a35aff0ae922a))


### Chores

* **guard:** cross-platform hook resolution + Sprint 2 cleanups ([937621a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/937621a7c7515600a5d4644419dd76eb11b301ef))

## [1.32.7](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.32.6...v1.32.7) (2026-04-29)


### Features

* **app:** MCP Clients screen — show "Update" when on-disk entry drifted ([eab5423](https://github.com/nikolai-vysotskyi/trace-mcp/commit/eab5423bc932c5b88f3334ef936dd715dae45bec))
* **init:** generic per-client config status + `trace-mcp clients status` ([ecee7e7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ecee7e7987cf832f5d2a24e502c2622dd29becc2))


### Bug Fixes

* **daemon:** keep registered projects on graceful shutdown ([fb40795](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fb40795e9ef15ff016a03847f8ec18d91e61b36c))
* **landing:** tighten hero, lift red CTA above the fold, move metrics to proof strip ([6255652](https://github.com/nikolai-vysotskyi/trace-mcp/commit/62556521a4a34cbfff6831c376fef7bdaaea8816))
* **mcp:** keep trace-mcp tools eager in Claude Code via alwaysLoad ([1e739ce](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1e739ce555c94fe51ffb46eabe5909c4e4603fb1))


### Chores

* release 1.32.7 ([128a6cc](https://github.com/nikolai-vysotskyi/trace-mcp/commit/128a6cc08d82309a3d533fb8012fd24beca7d494))

## [1.32.6](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.32.5...v1.32.6) (2026-04-29)


### Bug Fixes

* **app:** augment PATH + prefer existing node version for in-app updates ([5452d11](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5452d11d4f872316feb19749894918149e189957))

## [1.32.5](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.32.4...v1.32.5) (2026-04-28)


### Bug Fixes

* **daemon:** auto-register project on first MCP connect ([ac112c6](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ac112c6a4b563590c39e254bda9367f76dad46c8))

## [1.32.4](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.32.3...v1.32.4) (2026-04-28)


### Bug Fixes

* **cli:** import detectGuardHook + detectProject + missing types in init ([e293a78](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e293a780624362909d643029a1448acf49a1353f))

## [1.32.3](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.32.2...v1.32.3) (2026-04-28)


### Bug Fixes

* **cli:** import detectMcpClients in init command ([cd4871f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cd4871f31d4ea61ca787e8872305acf7ac147a04))
* **install:** drop simple-git-hooks from postinstall ([c3286d7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c3286d7e588fe0a3c47b5dac81b03b7cede21131))

## [1.32.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.32.1...v1.32.2) (2026-04-28)


### Bug Fixes

* **app:** coalesce remaining res.statusCode → number ?? 0 ([#116](https://github.com/nikolai-vysotskyi/trace-mcp/issues/116)) ([3482f8f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3482f8f21d350382a072c3b44a97588c5706e748))

## [1.32.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.32.0...v1.32.1) (2026-04-28)


### Bug Fixes

* **app:** drop duplicate resolveNpmBin/Root + tighten statusCode types ([#115](https://github.com/nikolai-vysotskyi/trace-mcp/issues/115)) ([627ec43](https://github.com/nikolai-vysotskyi/trace-mcp/commit/627ec4395319a4c4b747e7c81de768580760e339))


### Chores

* **landing:** bump 'up to 97%' to 'up to 99%' in remaining copy ([0fc5534](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0fc5534cfa80cb4473e27c51e103ddf32dbce47a))

## [1.32.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.31.0...v1.32.0) (2026-04-28)


### Features

* **docs:** full SEO meta, favicon set from electron tray icon, PWA manifest ([7217e11](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7217e11feab6d919e2335375da86490d030188c3))
* **homepage:** mobile above-the-fold CTA, trust badges, red primary CTA ([8b6a897](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8b6a89787f8b3bfa0e820d7d1fec045d3fd8ff8a))
* **init:** add AMP, Warp, Factory Droid MCP clients ([#111](https://github.com/nikolai-vysotskyi/trace-mcp/issues/111)) ([9235afb](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9235afb41e29b3cb3f3486cc58ffabdbcfa11223))
* recomputation narrative + knowledge-graph markdown indexing ([#112](https://github.com/nikolai-vysotskyi/trace-mcp/issues/112)) ([b68f61f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b68f61fd15c82d988a26e73099adbc6854852257))


### Bug Fixes

* **homepage:** eliminate horizontal scroll on mobile ([c97eab0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c97eab06468c84281829b15a10d50dc537cf4d05))
* **landing:** collapse hero to single column on mobile ([af7bb71](https://github.com/nikolai-vysotskyi/trace-mcp/commit/af7bb71c988bc9f75c67a63b5cec5ead45d78785))
* **landing:** mobile hero — make 40–50% the lead metric with a value-prop label ([589393f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/589393fea609fddeda0b73c4efca51f78b7a661e))
* **landing:** mobile hero — promote 99% as the single hero metric ([3a6475a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3a6475a82b375be56ccde51b9471beafd1594d2e))
* **landing:** mobile overflow on use cases grid and install terminal ([bb588cd](https://github.com/nikolai-vysotskyi/trace-mcp/commit/bb588cdaf1d2660d8940805e260fd7aa3b710c49))
* **landing:** split 'up to' off the giant Doto numeral on mobile ([fbce556](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fbce556441dd63fc87e5ceb6854bfa7d1f34722e))
* **merge:** drop duplicate imports + restore missing path import ([#113](https://github.com/nikolai-vysotskyi/trace-mcp/issues/113)) ([d06e42d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d06e42d26d187e1571b06adc0a67010087ed4a8c))


### Documentation

* **homepage:** restructure around "code intelligence layer for AI agents" positioning ([a99118d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a99118d662ecc3aa49a6c020bd99076c4965390e))
* **landing:** drop pilot CTAs, send users straight to install/repo ([6c44b7c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6c44b7c7daaa6ede4420e58f03346bd977966b42))
* **positioning:** reframe as optimization layer for LLM apps, honest token numbers ([3b552c3](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3b552c3506db658c932b07604e4f185c118645dd))
* **readme:** add Star History chart ([614cf32](https://github.com/nikolai-vysotskyi/trace-mcp/commit/614cf32d6819c7ba26cbd20ffd0c3fdd8fc020d7))


### Chores

* **ci:** hold off on electron major bumps ([861c75a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/861c75ac8f7808d9c413c0c1d58cfb66335e790f))
* **ci:** hold off on vite + plugin-react major bumps in app ([02cafac](https://github.com/nikolai-vysotskyi/trace-mcp/commit/02cafacb9ea67d8e2911c8b8dc7d7532bbad9442))
* **ci:** hold off on web-tree-sitter minor/major bumps ([45b303f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/45b303f1d6a4929e1e9c745d508cbaa7d562ae4e))
* **ci:** ignore major bumps for @types/node ([20702a3](https://github.com/nikolai-vysotskyi/trace-mcp/commit/20702a3141db964a46a8f3b632da17ae7b85858a))
* **ci:** include chore/ci/build in release-please changelog ([135e1ce](https://github.com/nikolai-vysotskyi/trace-mcp/commit/135e1ce8d8122c77c155fb9fbb66eb7eabc37a38))
* **deps:** bump typescript to 6.0.3 (root + app) ([#103](https://github.com/nikolai-vysotskyi/trace-mcp/issues/103)) ([836d4cf](https://github.com/nikolai-vysotskyi/trace-mcp/commit/836d4cfaae6cad0e081fd646a4f16e550ebfb480))
* **deps:** bump zod from 3.24 to 4.3.6 ([#105](https://github.com/nikolai-vysotskyi/trace-mcp/issues/105)) ([3e774ac](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3e774acd3971861429d8b1d6a123071fc013f73b))
* **security:** bump electron to 41.3.0, drop stale pnpm-lock ([#109](https://github.com/nikolai-vysotskyi/trace-mcp/issues/109)) ([4b45f87](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4b45f87a9e4e555f643f65a555516b7ef66af59a))
* **tooling:** introduce Biome as formatter (root) ([#110](https://github.com/nikolai-vysotskyi/trace-mcp/issues/110)) ([7149fa5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7149fa5886dd370ef13330ac1fea66128590e502))


### CI/CD

* **release:** sign Electron release artifacts with SLSA provenance ([#108](https://github.com/nikolai-vysotskyi/trace-mcp/issues/108)) ([1ac88ec](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1ac88ec15d7973346b2c9cc5e16367ee3290ea0a))
* **security:** add CodeQL, Semgrep, OSSF Scorecard, Dependabot ([f252ce2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f252ce2dc656a1e75b6a3d6436f1832587872ba9))
* **security:** pin all GitHub Actions by SHA, add top-level read perms ([71253c0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/71253c0c538eb9c73f3c1f8d54415467ab7a8972))

## [1.31.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.30.0...v1.31.0) (2026-04-24)


### Features

* **init:** Hermes Agent as a supported MCP client ([a8a19ef](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a8a19ef0e9e6ac39433d225f000cce8ffff22b32))
* **session-providers:** Hermes Agent session provider + SessionProvider interface ([b44edbc](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b44edbc0756566f7f5cc7fba69b3fd4d91a3fa5f))


### Bug Fixes

* **updater:** skip auto-update in dev checkouts ([a439fb6](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a439fb6fde700e2dd739f1f423b8232497d8d9e4))


### Refactoring

* **init:** extract shared md-block helper from claude-md.ts ([869f42f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/869f42f1cd25b072bf5f5b8a10720ec6ce37fa8e))


### Documentation

* **benchmark:** update with v1.30 results (92.8% reduction) ([15ea976](https://github.com/nikolai-vysotskyi/trace-mcp/commit/15ea976d75dfea258b0683cf3b562e963e77954e))

## [1.30.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.29.0...v1.30.0) (2026-04-23)


### Features

* **ai:** add Vertex AI and Voyage providers, retrieval task hint ([c566738](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c566738fc739dc5f023d13a5ee0ec957f12d3b11))
* **analysis:** symbol-level bottlenecks + Stress Test hotspots UI ([1ea7b7a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1ea7b7a5f54d2a62c5b6607733ece0808aca4369))
* **plugins:** add aws-s3 / supabase / sortable, Laravel sub-plugins, expanded coverage ([9586790](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9586790c1f4280d7341bca07f20925959e70e663))


### Bug Fixes

* **code-smells:** skip markdown and other non-code files ([1199783](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1199783281822653615f164777ba98e71d1bb656))
* **darwin:** prime amfid for prebuilt native modules ([f78e838](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f78e838b15b2fdf6860f7c1422e14da5d7bbd965))


### Refactoring

* **plugin-api:** add PluginRegistry.createWithDefaults factory ([e8964ac](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e8964acae941d053406ad864a8731b49b29381ae))


### Documentation

* **plan:** session-providers implementation plan ([f6b4d0a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f6b4d0ae545fd173e75eee62f9924866ffd7550e))

## [1.29.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.28.0...v1.29.0) (2026-04-22)


### Features

* **analysis:** edge bottlenecks + app Quality tab + bottleneck graph overlay ([872d535](https://github.com/nikolai-vysotskyi/trace-mcp/commit/872d5357217910f2403432b36d36052fb7fcf75f))
* **plugins:** add ioredis, jose, nodemailer, redis-py, gunicorn, uvicorn plugins ([522c43c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/522c43c931f9c455f695098332e037087fc146d9))
* **plugins:** expand php-ecosystem coverage to 12 more packages ([d87e621](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d87e621868739397ac0aeafba48c2eed9c10aba1))
* **quality:** add debug-artifact smell, size/complexity antipatterns, AST clone detector ([c05ac2b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c05ac2b5a2ae365320dd590acb24d1be7fa2c1a3))
* **server:** add tools.agent_behavior config for discipline rules ([8984118](https://github.com/nikolai-vysotskyi/trace-mcp/commit/89841185d684f1320e8bd36ceebcf5911845ac80))
* **subproject:** cross-service endpoint literal scan + Nuxt/httpx/aiohttp/urllib ([21537e0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/21537e0ec2c4819ecddca443935f55a4fb43437e))


### Bug Fixes

* **ai:** stamp embedding model+dim and reindex on mismatch ([2f2d923](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2f2d9237a43095f61bae9378c8233a518d71b7fe))
* **app:** harden pending-update lifecycle ([cd998d3](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cd998d362b49c65351ebdcb5416262ea17336bcc))
* **env-indexer:** strip **/.env* patterns from fast-glob ignore list ([d057ffe](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d057ffe6cb78cd8437a4d2c96a6582f6d93372f6))
* **hooks:** exempt .env.example/.env.sample templates from guard ([217e9ec](https://github.com/nikolai-vysotskyi/trace-mcp/commit/217e9eca95f0c9930a43a3812b1e28e41c968f91))


### Documentation

* add Max-tier agent behavior, app gallery, and refreshed comparisons ([10f29b7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/10f29b7041ec9d3c6aed4317b5db3580b2e819f3))

## [1.28.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.27.0...v1.28.0) (2026-04-21)


### Features

* **plugins:** add Python ecosystem integration plugins ([741b092](https://github.com/nikolai-vysotskyi/trace-mcp/commit/741b092910ed074a6add0a2a27696c30b649786e))


### Bug Fixes

* **indexer:** resolve asset imports and TS re-exports across the graph ([6f76025](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6f76025c8028347c3ce7329e7deb0be08028b131))


### Performance

* **app:** custom FPS overlay + disable halo to lift graph FPS ([3fa4038](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3fa4038cab5379608017bbbe0b1c1a936f499d17))
* **app:** re-enable GPU compositing for graph explorer ([6633456](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6633456805e9eddff7ea21fd90b52181d5ee4431))
* **app:** upgrade cosmos.gl to 3.0 beta and rework label placement ([601e069](https://github.com/nikolai-vysotskyi/trace-mcp/commit/601e0690ab94f328ee45ca0ba3bf98c3a62cb1a7))

## [1.27.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.26.0...v1.27.0) (2026-04-20)


### Features

* **app:** open selected graph node in installed IDE ([4ca5e22](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4ca5e22ff0dbe966c392f38e0a25712dff8e31c9))


### Bug Fixes

* **app:** robust Update button with scratch cleanup, --force, and visible errors ([9028793](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9028793c9a0eae2a5b5dc839403e08c765bb0d1f))
* **build:** bundle deps via createRequire to survive spaced install paths ([65e9f3f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/65e9f3f3f4c0ff622371c6d0de138b52038aa29f))
* **postinstall:** match new release asset naming (-arm64-mac.zip / -mac.zip) ([27200ba](https://github.com/nikolai-vysotskyi/trace-mcp/commit/27200bad183f1e425b4f6fa4f5c80ed7ce03412d))
* **updater:** pre-clean scratch dirs and back off on repeated failures ([b7a647c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b7a647c092450784013946f13e5110ad016cf70f))

## [1.26.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.25.0...v1.26.0) (2026-04-20)


### Features

* **ai:** per-capability gates and empty-string config hygiene ([ad7f5e8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ad7f5e857d6e1bbb2d0fde048cedf4e02a13dae7))
* **app:** Ollama control panel in Settings ([2e5d374](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2e5d37435ad62f892e45ea7018eb92f16e6b0076))
* **app:** tinted edge colors and camera-interaction lock in graph explorer ([7ca42db](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7ca42db50710837ce28d222da4795ed843c8b036))
* **init:** stable launcher shim for MCP registration ([1b6eb25](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1b6eb25ac1e8820afeb914c47e82747680425614))


### Bug Fixes

* **app:** capture streaming buffer before setState in AskTab ([558ebc7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/558ebc78235749b94332c45bc6714e9482512d5e))
* **daemon:** launchd bootstrap/kickstart + startup health wait ([c78115a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c78115a03b0722cdf7ac753e3e1c93e13d5d19f6))
* **db:** idempotent file upsert via ON CONFLICT ([1440d9f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1440d9fcc9f00edbd38d1fb3eaadbaf1c8688b53))
* **init:** drop stale {{tool_name}} template and clean up legacy hooks ([250d586](https://github.com/nikolai-vysotskyi/trace-mcp/commit/250d586d87606df03b7e403300d0b9df3c98d275))


### Documentation

* add dark-mode graph screenshot and refresh app images ([e3ab628](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e3ab6284bd6740edf1935736d191447db8812f61))


### Tests

* **launcher:** accept either probe failure on CI ([d83d14c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d83d14c16a671f02d77e738a206057558c5ba996))

## [1.25.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.24.0...v1.25.0) (2026-04-18)


### Features

* **app:** graph explorer expansion and renderer UI polish ([c763318](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c7633186e1dacacaa66d748f3290c01cbc8e54e5))
* **app:** hardened staged auto-update with SHA-256 + Gatekeeper ([757061a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/757061a8bba07f56acfdcc28671fe8dd0b6b19a7))
* **daemon:** unified lifecycle, idle auto-exit, and subdir→parent routing ([317a792](https://github.com/nikolai-vysotskyi/trace-mcp/commit/317a7923deea9b00cf274cc4e98a2e17b75d96c3))
* **indexer:** isolate workspaces in framework and file-projection edges ([1021f5b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1021f5b785215c9a0fe0c628e6caa8d93c37a5ab))
* **viz:** derive community labels from dominant path prefix ([b676c17](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b676c17bb30ce186ab2e7cdc041d2a8820cf0382))


### Performance

* **indexer:** parallel file extraction via worker pool ([a8f886d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a8f886df85c0503175f0c74c6cf3368d96d1d20f))


### Documentation

* README refresh, desktop app section, comparisons page ([a725773](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a725773699008e369b3350b83388d80ff458aa01))

## [1.24.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.23.1...v1.24.0) (2026-04-17)


### Features

* add landing page for trace-mcp.com ([a515c6c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a515c6c587c12388185d353d8c4899686fa88c0b))
* **ai:** track AI request activity + rename ollama default model ([259afe4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/259afe435d6972a8891fe4f676f306e709fac1b7))
* **app:** GPU-accelerated graph explorer (cosmos.gl) ([3ce00e2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3ce00e20b67dfc53e065cfabd7c5c10e417081d1))
* **blade:** extract script src asset references ([e250acc](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e250acc5dee1192f4a7782e26f4344e639fc0126))
* **daemon:** unified stdio session with proxy⇄full auto-switching ([52d5392](https://github.com/nikolai-vysotskyi/trace-mcp/commit/52d5392125debfa64d3999a50437d3897cae59b2))
* **indexer:** phantom externals + file-level projection + TS call/type edges ([69ce68e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/69ce68ec4ce8b39c40b292f6896d1685ca2b46ce))
* js-viz (Chart.js/vue-chartjs/marked) + php-ecosystem (symfony-dom-crawler/google-apiclient/laravel-ai) plugins ([cb61078](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cb61078aa1e043aeed617fdf95001e9b19778baa))
* **landing:** add ASK/GET examples, cross-language edge diagram, FAQ, use cases ([a5418c5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a5418c5ce1753f2deb8a0f96ff9b33485692c0a8))
* **laravel:** medialibrary + eloquent-sortable + composer Package Discovery ([35cb8b8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/35cb8b8de6908945b86c10b16fb6efaebbb2f621))
* **nextjs:** file-based entry point edges for App/Pages Router + metadata ([deca9b4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/deca9b4f171e57ef39452d86c682df88dba7592c))
* Nuxt 3/4 entry points, custom prefix parsing, improved detection ([a475856](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a4758563a6f5459ee356e3d1c85ce7795284c667))
* **nuxt:** middleware/layout/plugin/route auto-registration edges ([8401327](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8401327377ecec6b9de6d649e7c5cc27378a17cf))
* PHP call graph resolver — symbol-level calls/heritage edges ([653818f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/653818f9af4d87d1ff2549bd14b0d3a07701370f))
* PHP property and constant access edge resolution ([8f4f66f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8f4f66f74d7828c5eefb6fc28c44bab0d28017a9))
* PHP type-aware call resolution + class references ([f114291](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f1142918651f39283f6737a9d325b0c113edeaf0))
* scan Blade templates for PHP function calls + workspace-aware resolution ([928fec1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/928fec19dbf9eae2f15c8e63f7d48f97411987db))
* structural member_of edges + class-fallback for unresolved methods ([6ff4e88](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6ff4e889801b9e27059e3bc96aad25375a38cef1))
* Vue dynamic component references via TS/JS/Vue content scanning ([fcb8112](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fcb8112097ea212f7738bcfb96e3c3df6eb3b0d0))
* **vue:** Laravel Nova + Blade component entry points, SSR marker ([33e5f55](https://github.com/nikolai-vysotskyi/trace-mcp/commit/33e5f559d7f617c33e951fef28aa58707b3661d6))


### Bug Fixes

* **db:** schema v20 backfills seed edge types on existing DBs ([a1a5e6f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a1a5e6fe4c258d539e6988a6309a291de81ae078))
* eliminate client call scanner false positives ([7248443](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7248443a1a6605c3415b80c946ab37fc65fb4035))
* **init:** detect running Claude Desktop to avoid config overwrite ([6d02023](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6d02023cee31762a642a7843a2bbc84c2ee4945c))
* **landing:** dynamic version from npm registry + terminal whitespace ([1b0911f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1b0911ff4397e3d365ff9f52d9732c658ade823a))
* **landing:** improve readability — body text uses primary, headings beefed up ([0470041](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0470041cd6268834848fa4069219264f7fadb28d))
* make dir argument optional in index command, default to cwd ([cd7ee1e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cd7ee1e485a4b5f8abeb2eec8687eaebce6dacd5))
* self-first endpoint matching for client calls ([227d59d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/227d59dabd75a814271a7869a5a1afbc963246e4))
* strict project_group isolation — ungrouped services no longer leak ([5d828ee](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5d828ee63e617b46525662cb8e6dcbb308331da3))
* workspace assignment on fast path + broader default include patterns ([65d7433](https://github.com/nikolai-vysotskyi/trace-mcp/commit/65d743375e1beb7a7010a55f6cedb65d0448d17c))
* workspace naming, parent DB route fallback, and client_calls FK migration ([42517e0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/42517e0427f46245bf17a63d786bdc8d737ea8a3))


### Refactoring

* community labels show dominant dir, pack-context models/feature-scope use FTS ([a9d089e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a9d089e33ebfd2c4a9bb928781c8d0786c3cf472))
* redesign landing page in Nothing design system ([4f4bda1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4f4bda148c17b0d72dcb85f15d9da8d6f4998512))

## [1.23.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.23.0...v1.23.1) (2026-04-15)


### Bug Fixes

* **app:** remove unused trace-mcp runtime dependency ([7ac57c7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7ac57c7827b1d6358e80072cfeebc55be6c32629))

## [1.23.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.22.0...v1.23.0) (2026-04-15)


### Features

* add Anthropic, Gemini, and OpenAI-compatible AI providers ([960eb13](https://github.com/nikolai-vysotskyi/trace-mcp/commit/960eb1318ec897d7be4b98b22c9a3db0183daa16))
* add PHP import edge resolver for use statement resolution ([836d10a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/836d10a71ae2b379e25658f20093539a241f6b27))
* add service group management UI and API ([4646230](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4646230bf397476eae7072ab7c73a54c2465c973))
* **app:** add model-select and multiselect controls for AI settings ([25bb2bf](https://github.com/nikolai-vysotskyi/trace-mcp/commit/25bb2bf42084e9454bbc3e252ccfbfca442e4c80))


### Bug Fixes

* add workspace isolation to PHP import resolver ([5c8d9cf](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5c8d9cf4cda00e68a45cfccc7e79f6f572b0bb05))
* isolate cross-service endpoint matching by project_group ([0630908](https://github.com/nikolai-vysotskyi/trace-mcp/commit/06309081423a49fc13673adbd1a49bbffd69d7ec))
* prevent topology contract duplication, false endpoints, and stale edges ([79f2ad1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/79f2ad1d7b229da9daf564c1794e3bd23d61a3b5))


### Tests

* add tests for topology fixes and PHP import resolver ([11a4ddb](https://github.com/nikolai-vysotskyi/trace-mcp/commit/11a4ddbfe5c0dff5f5b9699bb03cdd788ee51803))

## [1.22.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.21.2...v1.22.0) (2026-04-15)


### Features

* add MCP ToolAnnotations to all tools for Glama TDQS scoring ([5be916b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5be916b2b648f03cd4fc92ea2d83a065dc84bfbc))
* add security context export for MCP server analysis ([7b685c4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7b685c49e48a2caa106c5af0b0138dda6513eba9))
* add stdio proxy mode and lifecycle management ([722579e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/722579e1f96f6bfc4e0ecea00884102bdd365b0d))
* redesign AskTab with provider setup CTA and settings deep-linking ([d55226e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d55226ee3610cdd46683ff00a7e0ebd6687f7131))


### Bug Fixes

* add pre-flight check in GraphExplorer to prevent raw error display ([eb1e06b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/eb1e06b633799c3f8b8329c42a78ca43ba948ce1))
* match LICENSE text to SPDX Elastic-2.0 canonical template ([717951d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/717951d35ac5a812d79afeb8a2c85dfec8b19dee))
* move frameRequested declaration before first use in visualize ([ee86d7b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ee86d7bb68e0f6ea66e0782dd8adbb9180e5a4d8))
* remove extra text from LICENSE for exact SPDX template match ([6b0a6e0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6b0a6e08151a86e87538c3e20f4e841b37b28f18))
* split license into standard ELv2 + ethical addendum ([0a9ccd3](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0a9ccd32b3026a7f679c754ed25fac845ceff12d))
* unset ELECTRON_RUN_AS_NODE in electron dev script ([1c2c21c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1c2c21cede2e4df820565e1e1ba8019a302bacc9))
* use valid SPDX license identifier for Elastic-2.0 ([11e128b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/11e128b399a07218109fedc0100be682093ed370))


### Documentation

* add usage guidelines and output format to all tool descriptions ([2b544a5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2b544a5cffee2209febbb4960d702d102880ae4a))

## [1.21.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.21.1...v1.21.2) (2026-04-14)


### Bug Fixes

* **ci:** pass --repo to gh commands in release notes step ([8b1b9a1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8b1b9a1aecb092d4da925ea01f7ed49f5b9d7652))

## [1.21.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.21.0...v1.21.1) (2026-04-14)


### Bug Fixes

* sync lock file and make serve the default command ([0e2dd5a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0e2dd5a635d13f62173378314c5e89131804c501))

## [1.21.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.20.1...v1.21.0) (2026-04-14)


### Features

* **ai:** add streaming inference and ask command with code context ([d96fe86](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d96fe8642e15388238981d760be50235c98b5b4c))
* **analytics:** expand known-packages catalog with deprecation tracking ([538e479](https://github.com/nikolai-vysotskyi/trace-mcp/commit/538e4793375abfb6ec30bdb85373de9a0e1c5c1e))
* **app:** add Windows platform support with custom tab bar and installer ([5ff2bda](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5ff2bda4c5e6e539b7cf95d8adeaecbfccce1c42))
* **app:** extract daemon-lifecycle module and auto-start daemon from tray ([a255a6e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a255a6ea209c18d65f66ab68ba040681cb3c53a6))
* **lang:** add 10 new language plugins (Ada, Apex, D, Nim, Pascal, PL/SQL, PowerShell, Solidity, Tcl, VHDL) ([42dca87](https://github.com/nikolai-vysotskyi/trace-mcp/commit/42dca878f89778a049f2a18ffbb80bdd42ccc619))
* **lang:** enhance regex-base with scope tracking, doc comments, and multi-line signatures ([1c6b6ae](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1c6b6ae52a1c744a98d9f43b43e06df09cb5f300))
* **lang:** improve regex-based plugins for Clojure, COBOL, Common Lisp, and 7 others ([354023b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/354023bcda01f885cc25e060270a3ea63cd15d26))
* rename "federation" to "subproject" across entire codebase ([a8ec5ab](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a8ec5ab8853049881d4bfb591faaa77f60a8aee2))
* **server:** add compact_schemas option to reduce tool schema token overhead ([b9f98ac](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b9f98ac1630d82c1a66457b523337566a5ace602))

## [Unreleased]

### Breaking Changes

* **rename: "federation" → "subproject"** — The concept formerly called "federation" is now "subproject". A subproject is any working repository that is part of your project's ecosystem: microservices, frontends, backends, shared libraries, CLI tools, etc. This affects:
  - CLI: `trace-mcp federation` → `trace-mcp subproject` (alias `sub`)
  - MCP tools: `get_federation_graph` → `get_subproject_graph`, `get_federation_impact` → `get_subproject_impact`, `federation_add_repo` → `subproject_add_repo`, `federation_sync` → `subproject_sync`, `get_federation_clients` → `get_subproject_clients`, `visualize_federation` → `visualize_subproject_topology`
  - Config: `topology.auto_federation` → `topology.auto_discover`
  - REST API: `/api/projects/federation` → `/api/projects/subprojects`
  - DB table: `federated_repos` → `subprojects` (auto-migrated)
  - Source directory: `src/federation/` → `src/subproject/`

## [1.20.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.20.0...v1.20.1) (2026-04-13)


### Bug Fixes

* resolve SQLite migration crashes and daemon PATH for launchd ([33ea80a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/33ea80ae96f34b8c941027c7164674be68cc2b90))

## [1.20.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.19.0...v1.20.0) (2026-04-13)


### Features

* add Class Hierarchy Analysis (CHA) for polymorphic call resolution ([#55](https://github.com/nikolai-vysotskyi/trace-mcp/issues/55)) ([7b193ca](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7b193ca67c95a12ea61beab8122df1b93b678d1e))


### Bug Fixes

* align get_tests_for with graph test_covers edges ([#56](https://github.com/nikolai-vysotskyi/trace-mcp/issues/56)) ([1cfde2e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1cfde2e6ba44653f7a44c5d650515dc58d1d9569))
* exclude CLI entry points from get_dead_exports false positives ([#53](https://github.com/nikolai-vysotskyi/trace-mcp/issues/53)) ([3abf971](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3abf971ed54ee609eee1b2ed5456f11c3ef5007c))
* resolve method calls on parameter-annotated instances ([#54](https://github.com/nikolai-vysotskyi/trace-mcp/issues/54)) ([46c3cbe](https://github.com/nikolai-vysotskyi/trace-mcp/commit/46c3cbe99884c24334a7b4f5d8c2c4966f6ceceb))

## [1.19.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.18.0...v1.19.0) (2026-04-12)


### Features

* add decision memory system for cross-session knowledge ([292a824](https://github.com/nikolai-vysotskyi/trace-mcp/commit/292a8246b415a11d2ba4fa9e411c67295d382e01))
* add Filament and Electron framework plugins ([dbf16fa](https://github.com/nikolai-vysotskyi/trace-mcp/commit/dbf16fa72fa56e2b3d0db6e2790100d130d4e68c))
* add move, change-signature, and plan-refactoring tools ([5e2f4ae](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5e2f4aea886e92a6023cbeb71cdc17594400f7bc))
* add technology coverage, service management, and UI improvements ([56817aa](https://github.com/nikolai-vysotskyi/trace-mcp/commit/56817aa0986fd9d627b19f67e243ccb0d2376ddd))
* scope federations to projects with auto-discovery ([ca430c6](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ca430c6f5acb3c85bad0fea03abc2e804691208e))


### Bug Fixes

* update tool registrations and fix visualize test assertions ([6d59011](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6d590118ca431f6df28a457f555e3d8d88502f01))


### Documentation

* update documentation for refactoring tools and decision memory ([423675d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/423675d9b057583ce305e83c98ea36e74b6d5d1d))

## [1.18.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.17.0...v1.18.0) (2026-04-12)


### Features

* pin app to macOS Dock after install ([85b2b63](https://github.com/nikolai-vysotskyi/trace-mcp/commit/85b2b633fe3aa2b5674281a09c17fd3cc2953afb))


### Bug Fixes

* include assets and icon in electron-builder package files ([ace9a85](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ace9a8577cf84f941a0219f5423594a05da13507))

## [1.17.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.16.1...v1.17.0) (2026-04-12)


### Features

* default to max enforcement level, add install-app CLI command with retry ([f156305](https://github.com/nikolai-vysotskyi/trace-mcp/commit/f1563058e69c23265ba8f83a934370158dd6bd9b))


### Bug Fixes

* handle nullable topoStore in visualize tool ([e955361](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e955361e95e0b04b238e0b985be82ee283e54178))

## [1.16.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.16.0...v1.16.1) (2026-04-12)


### Bug Fixes

* package.json ([4497e51](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4497e5160de456eb59fe599117e3c67f0273c878))
* resolve TypeScript errors in visualize modules ([10f846f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/10f846f75f53aa3c2422a30aae23a14c2bc31519))

## [1.16.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.15.2...v1.16.0) (2026-04-12)


### Features

* add CORS headers to HTTP server for Electron renderer ([9a39031](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9a3903122c45b7eb7a8d0fb241858de84a8c964e))


### Bug Fixes

* exclude vendor dirs from graph visualization and clear state on error ([73e46ef](https://github.com/nikolai-vysotskyi/trace-mcp/commit/73e46efd4223e907a6e9e0d65446801dff0ae428))
* simplify artifact upload glob and remove redundant arch from yml ([01a2660](https://github.com/nikolai-vysotskyi/trace-mcp/commit/01a266067841d40a56beaf3a9d8f1aeabc3fdaf0))

## [1.15.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.15.1...v1.15.2) (2026-04-12)


### Bug Fixes

* correct electron-builder artifact glob for macOS zip upload ([1c92616](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1c92616c40847d0d6c2a2e128a493277debc3aa8))

## [1.15.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.15.0...v1.15.1) (2026-04-12)


### Bug Fixes

* consolidate electron-builder config to prevent asar packaging failure ([02dfb8f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/02dfb8f6f3fc9625074dda98b7e4c327f751feb3))

## [1.15.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.14.1...v1.15.0) (2026-04-12)


### Features

* add --granularity, --symbol-kinds, --hide-isolated flags to CLI visualize ([ec71946](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ec719460b9ebf80da050e7e23bf06925e28776ae))
* async DB + pytest integration plugins ([48e0ab9](https://github.com/nikolai-vysotskyi/trace-mcp/commit/48e0ab916b54aede6f1b6c39fcbb6c0c25f8f347))
* clean topology data (federation, services) on project removal ([9fffa26](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9fffa2687bed9bc28ca83246fb8806d87a544b15))
* daemon mode — multi-project serve-http with REST API, SSE events, and stdio daemon awareness ([9900500](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9900500f25850270159f6cdff35a2f8589b8959a))
* Electron app — auto-updater, GPU crash recovery, file browser, federation panel ([95b6c79](https://github.com/nikolai-vysotskyi/trace-mcp/commit/95b6c798ff1f16184af95c283df27f5cef18c3d2))
* Electron app — redesigned icons, settings UI overhaul, clients tab, graph explorer improvements ([9232066](https://github.com/nikolai-vysotskyi/trace-mcp/commit/92320665764b96c1f62cf0ce536481cfa0e5fff5))
* federated graph visualization, session landmarks, daemon client naming ([c88a257](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c88a257e68bf3a8cc38380f5255c0ce21ead62aa))
* get_untested_symbols tool + per-symbol test reach in change impact ([7cb554c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7cb554ce62ec69c6419135ab62d62aae3bf369b5))
* graph visualization — light/dark theming, minimap, BFS highlight depth ([2f3bbc0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2f3bbc07ee9da2f7835e3145f6065201d5e26874))
* implicit workspace detection + per-workspace framework plugin activation ([6129f59](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6129f59bd5ac3401d9068cb56a487fa2f643bddb))
* LSP enrichment — 4-tier edge resolution confidence, schema v19, SQLite batch chunking ([acf0ec4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/acf0ec45152976f745ba912f61f9133922467785))
* menu bar app — Electron tray app, installer, init wizard integration, CI release workflow ([63bda06](https://github.com/nikolai-vysotskyi/trace-mcp/commit/63bda0679fa924156bfb0d9a52b0ebcd9cdcd428))
* Next.js plugin — optional catch-all routes, 2-level intercepting routes, route segment config, use client/cache directives ([8b39280](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8b392808acbcafb478a7f8c4bc5627b75f1815b5))
* Next.js plugin — src/ prefix support, new file conventions (forbidden, unauthorized, metadata, instrumentation, proxy) ([e623fd1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e623fd1ae9fcd96d512b2232fa551ef44f0a23a5))
* ONNX local embeddings + Signal Fusion search — zero-config semantic search with multi-channel WRR ranking ([b0ce8e3](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b0ce8e38b1815237f3bd95246a987b0eb25744a0))
* post-update migrations — auto-migrate hooks, config, CLAUDE.md, and reindex after version change ([aba1f9c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/aba1f9cc5292ff432d5b9ad8d3228fa2dabddd3d))
* Python language support — edge resolvers, CFG patterns, visibility, docstrings ([23953ed](https://github.com/nikolai-vysotskyi/trace-mcp/commit/23953ed892a5256d3de1f6bf44c87b0bb476e04c))
* symbol-level graph, isolated-node filter, monorepo federation fix ([8f3e55b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8f3e55ba8cd3ea44fe5a7ee3191c583df2d3d04a))
* workspace-aware module resolution + config exclude normalization ([0376ae1](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0376ae19aaa816670fb2830aeede03565988716f))


### Bug Fixes

* replace dynamic await import() with static http import in postinstall-app.mjs ([67330b9](https://github.com/nikolai-vysotskyi/trace-mcp/commit/67330b9d23bbb475dbfc0d01ba3caa3eddf9cfc8))
* set renders_component edge type category to 'nuxt' in NuxtPlugin ([967c613](https://github.com/nikolai-vysotskyi/trace-mcp/commit/967c61345014087ce418458fadfe210498048b65))
* visualize_graph file mode now seeds by symbol nodes, collapses to file edges ([e36e321](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e36e321d3805b36360866e23cbaf9bcd9e6f56bd))


### Performance

* eliminate redundant queries in graph visualization ([b4d7dfa](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b4d7dfa05260f40ee1fe9ca1825d420f3d28cf01))


### Refactoring

* extract setupProject, add REST API endpoints, consolidate CI ([3b6c23f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3b6c23fc26d5da8e483f62248360120078a6c8cf))
* extract shared resolveSymbolInput utility, improve tool robustness ([3fa2e0c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3fa2e0c228c13a83a92523a580c79662a65eafd3))


### Documentation

* update README, CLAUDE.md, configuration, and MCP instructions for LSP, ONNX, Signal Fusion, untested symbols ([5ed61af](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5ed61afc8f0f9e6bbb166fce4a660705eabec7a8))

## [1.14.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.14.0...v1.14.1) (2026-04-09)


### Refactoring

* Improve project root detection logic ([03ba367](https://github.com/nikolai-vysotskyi/trace-mcp/commit/03ba3673984f6efd33f3c71c853f4fc6f7fc317c))

## [1.14.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.13.0...v1.14.0) (2026-04-09)


### Features

* add workspace/monorepo fallback with deep glob patterns when root has no direct source files ([c62d89c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c62d89c80a0666e3d809854904f3994b723985e6))


### Bug Fixes

* use result.isErr() instead of result.ok for neverthrow Result check ([62edec8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/62edec879463ca9d03dff1cc8f3e601a3406eb07))

## [1.13.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.12.0...v1.13.0) (2026-04-09)


### Features

* add auto-updater with configurable check interval ([b26c851](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b26c8513a7b2fa761d639926d7fca11fbdd06f8a))
* add budget defaults, improve analytics and tool-gate ([ea48038](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ea48038de4d77d7fc240f01cba7d20813766a81c))
* add confidence levels and methodology disclosure to analytical tools ([dc6a9d8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/dc6a9d8122f6da0bff36d2d69acae8c1aca5eec4))
* add discover_claude_sessions for multi-project federation ([4bde3fe](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4bde3fecf77d81b762f5eb195cf98fbe2c86d60b))
* add git worktree support, visualize CLI command, and auto-update serve flow ([de755c3](https://github.com/nikolai-vysotskyi/trace-mcp/commit/de755c336a92c2cbab4c4b9cc902d644f20288f0))
* add pack-context strategies (core_first, compact) and budget reporting ([e539609](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e539609113c5ac426fa4282e04f2d46e41cebbfe))
* add plan_turn opening-move router with insertion-point suggestions ([9ee62bf](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9ee62bfca42d7fca92e445e27f441954d80be3b9))
* add semantic search modes, LRU result cache, and embed_repo tool ([b4002c2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b4002c260752cb6e0b7593308c0c979b2b92a3ba))
* add skills directory with trace-mcp usage guides ([ef37023](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ef37023f3a59b579b50d32d970720def964b198f))
* enrich empty-result evidence with isolation verdict and relation tool suggestions ([726e6a8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/726e6a8939186c8c58e69e4e8b96886ab21b9bb6))
* refactor Dart plugin and improve CSS/JSON/YAML/Python/Kotlin language plugins ([e19c338](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e19c3382c7a73b5870cc6ef7f0519041b4788f49))
* refactor federation manager into focused modules ([1d29a02](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1d29a02739356a25a9722433c1e25661ce6c2999))
* upgrade hooks to v0.6.0 with per-session repeat-read dedup ([8675b60](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8675b600698f77ec0d191570b3fb00f5aa98510b))


### Bug Fixes

* remove DENY_MARKER cycle from guard hook, write initial state on first deny ([1f96374](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1f96374753189c1cf4ba972a6fdd30b1e9eede0f))
* swap stat order in file_mtime to prevent multi-line output on Linux ([c5f6416](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c5f64167e144a415ad60a2ee2cdcf71f5fcbb14d))


### Refactoring

* remove file-watcher module ([dfe1e0d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/dfe1e0dc56cbd1f9c4f872f3577cea3e11ab03f8))


### Documentation

* update README with new tools and feature highlights ([7106537](https://github.com/nikolai-vysotskyi/trace-mcp/commit/71065378c6a66a0ed34172ba5d5b33fcd34a088e))

## [1.12.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.11.0...v1.12.0) (2026-04-07)


### Features

* add configurable file logging with rotation ([3215186](https://github.com/nikolai-vysotskyi/trace-mcp/commit/32151868998a9470713e90afa05c783994d9820c))
* add decorator/annotation extraction and filtering ([c0f6646](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c0f6646c48eaab9ca0f99fddbdd4a33e3a1f1b43))
* add Laravel Horizon, Cashier, Scout, and Socialite plugins ([24089c0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/24089c01435477efa855d1ba87779e8eae2f6fd4))
* add Tailwind CSS integration plugin ([bbbb2bb](https://github.com/nikolai-vysotskyi/trace-mcp/commit/bbbb2bb24e483db3c79ad220d75b220db7a1ef49))
* expand project root markers, add progress tables, improve evidence ([d6c77db](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d6c77db10d7d4930128c0141480ba2aa87bb504c))


### Documentation

* update README comparison table for accuracy ([aff2dd6](https://github.com/nikolai-vysotskyi/trace-mcp/commit/aff2dd6072404f477f3ad34cce2a2bfe67bf137a))

## [1.11.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.10.0...v1.11.0) (2026-04-07)


### Features

* add recursive multi-project technology coverage detection ([606d753](https://github.com/nikolai-vysotskyi/trace-mcp/commit/606d753b02bc4e0bdec03517fd0886dbba64c1a6))


### Refactoring

* Improve project root detection logic ([38d31e6](https://github.com/nikolai-vysotskyi/trace-mcp/commit/38d31e6e12cb392c123785ee04bc2471c3f7e38e))

## [1.10.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.9.0...v1.10.0) (2026-04-07)


### Features

* add CI project-aware reports with domain, ownership, and deployment analysis ([54a2efa](https://github.com/nikolai-vysotskyi/trace-mcp/commit/54a2efafc26b55b58a0b28b5d5a4bd3be1b34ed7))


### Refactoring

* extract federation manager helper methods ([e3739a2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e3739a2b14ce9b2ec5c1628d4413b91b07d7c549))
* extract indexer pipeline and file-persister helper methods ([e064db3](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e064db3683a43271676c448c270cdcbd631a7dcd))


### Tests

* add topology DB and contract parser tests ([c791bcc](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c791bccf683e3c4b527a6eb37e870e8eb2ffb34f))

## [1.9.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.8.0...v1.9.0) (2026-04-07)


### Features

* add advanced .traceignore ([2f2e5b5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2f2e5b531a8e777542a866aab1d65a7902785bba))
* add federation schema diffing, contract versioning, and federated search ([e43e590](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e43e590a1d618977a411bd5065362d00175d746f))
* add Junie, JetBrains AI Assistant, and Codex MCP client support ([c25aa38](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c25aa387e6833e161896fe205b46701b918012f4))
* add server PID tracking, improved status output, and tweakcc integration ([a7ec015](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a7ec01519c107036dfc08e47f2b4a9c8b70a6eed))
* migrate 16 language plugins from regex to tree-sitter ([3616b2d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3616b2db698947e488e637b24b5b461ec63147c6))


### Refactoring

* extract Laravel edge resolvers into sub-modules ([ca88696](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ca886968ade4691d025151f2011eb2955c4d0f80))


### Documentation

* strengthen apply_codemod enforcement rule in CLAUDE.md ([bd4e571](https://github.com/nikolai-vysotskyi/trace-mcp/commit/bd4e571218159fe42136171b68ad435ff67b01c2))
* update benchmarks to 11 categories and refresh tool counts to 120+ ([e2aa5cb](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e2aa5cb67d223c9faa3426c73c48961ba0e0c828))


### Tests

* add server tool-gate, explored-tracker, and consultation-markers tests ([703ef1b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/703ef1b007727e99739ec0a6057680dd04b06cc8))

## [1.8.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.7.0...v1.8.0) (2026-04-07)


### Features

* add JSONC-safe config read/write with migration support ([7ee246b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7ee246b7fbd8a8bba4078a3ccd4884561b626fc8))


### Performance

* optimize context bundle token efficiency ([53a5d38](https://github.com/nikolai-vysotskyi/trace-mcp/commit/53a5d385f0b5d5ed52c536bb982e10704635cd57))

## [1.7.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.6.1...v1.7.0) (2026-04-07)


### Features

* add benchmark scenarios for find_usages, context_bundle, type_hierarchy, tests_for ([d2a85d5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d2a85d53e8b2efd0d1e49e26874cf549d922c6a9))
* add indexing progress tracking with CLI status/remove commands ([ca1b539](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ca1b539f682ee5d57ef97a901e9e51e1d0b9c483))
* block Agent(Explore) subagents in guard hook v0.5.0 ([8796857](https://github.com/nikolai-vysotskyi/trace-mcp/commit/879685700b7888a0717f4c1017dbb19c5e965d74))
* seed JSONC config template with all parameters on first run ([5cb13fb](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5cb13fbd01bd2579dc30f35963ae162b702e9d7d))
* support async extractSymbols in LanguagePlugin interface ([3a92d9e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3a92d9e195d66a132acaddc01b736c4682c4ca72))


### Bug Fixes

* align benchmark SQL with normalized edge_types table ([2c7e472](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2c7e4720ee0f9085b05bbcb856693f14875174a4))
* correct TypeScript typing in hook entry filter callback ([47b4159](https://github.com/nikolai-vysotskyi/trace-mcp/commit/47b415941408e29753c6f90be2e19579b1e0da08))
* update prompt templates to match current API response shapes ([9e8cea2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9e8cea2a883c401751389dd14e60c356a10406cc))


### Documentation

* add tweakcc system prompt routing guide ([a5633c8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a5633c820a444f2d4ac5a710b7d2d96f35fbcbed))
* expand CLAUDE.md with Agent anti-pattern table and Read-before-Edit optimization ([7e4f930](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7e4f9303e531ff5f46ef7a5047712eb9895399c1))

## [1.6.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.6.0...v1.6.1) (2026-04-06)


### Bug Fixes

* deduplicate trigram batch by symbolId to prevent INSERT OR REPLACE conflicts ([2fd4dfa](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2fd4dfa30619521471874d76cdf7a70a971d0bdc))
* skip missing child directories in multi-root workspace builds ([270f114](https://github.com/nikolai-vysotskyi/trace-mcp/commit/270f1146e4c6d1bb3995c33975e1e33f196cb119))
* wrap CLI upgrade operations in try/catch for graceful error handling ([a481bb5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a481bb5dd555a8cbd7920bab40dec79c26438d72))

## [1.6.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.5.4...v1.6.0) (2026-04-06)


### Features

* add apply_codemod tool for bulk regex find-and-replace ([eeed93b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/eeed93b5651d5d089cd34dae123e34389db1d159))
* add multi-root project support ([858fc7f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/858fc7f1c5313b69bc7b1eb74a8f462a1902142c))


### Refactoring

* migrate from native tree-sitter to web-tree-sitter WASM ([3544f0b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3544f0b4e94098ad6274450794dd3ef80d7ab36a))

## [1.5.4](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.5.3...v1.5.4) (2026-04-06)


### Refactoring

* Update hook finding logic ([7f5f4e5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7f5f4e55971aa7fbf21e4d031be6544f753b127b))

## [1.5.3](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.5.2...v1.5.3) (2026-04-06)


### Bug Fixes

* **ci:** use npx npm@11 for publish instead of global npm upgrade ([4d82eb7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4d82eb7fd3ea23361d85822e6e826ce8eb8a4e0f))

## [1.5.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.5.1...v1.5.2) (2026-04-06)


### Bug Fixes

* **ci:** move TSUP_TARGET to job-level env and install latest npm for OIDC ([b671be6](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b671be6375f197ca3635f8d89421e025c8397b39))

## [1.5.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.5.0...v1.5.1) (2026-04-06)


### Bug Fixes

* **ci:** set node22 tsup target for npm OIDC publish compatibility ([ebb45f7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ebb45f78798687032b4c29340895910ddd5561b2))

## [1.5.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.4.1...v1.5.0) (2026-04-06)


### Features

* add .traceignore support and shared ignore-pattern parser ([0eae92d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0eae92dfad64096590e4a36a49c9c007309c5334))
* add AI concurrency config, expand known packages, simplify CI ([0025c57](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0025c5711b3161a0dbdfbb8cb2f50b25bce322b7))
* add consultation markers, explored tracker, and guard hook v0.4.0 ([eb87a86](https://github.com/nikolai-vysotskyi/trace-mcp/commit/eb87a864a152fe53cc49e8a54ee9267a42f0532b))
* add duplication checking guidance to tools and instructions ([53779fd](https://github.com/nikolai-vysotskyi/trace-mcp/commit/53779fd2daa5ebde372f4769ce2b07fa8c23fd1d))
* add memory leak detector and inter-procedural taint analysis ([aa752fd](https://github.com/nikolai-vysotskyi/trace-mcp/commit/aa752fd5f5c97a4a5bfa330af2bfe39edd168bb7))
* add session dedup, resume, and adaptive token budget ([628a6bc](https://github.com/nikolai-vysotskyi/trace-mcp/commit/628a6bca5ebeee6184947396d5cede1fcd4fb389))
* add session snapshot, precompact hook, and worktree hooks ([fd0a0f2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fd0a0f25a0b3c3228c0d7419e9c5972c42d3e154))
* enhance init with competing tool cleanup and error handling ([4f6aa4a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4f6aa4a4cd4b02719ab49c6ad25314d11b4980ec))


### Bug Fixes

* **ci:** improve risk scoring and split code/non-code file sections ([2325f82](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2325f82626d2012aa94750572771020a53718ec6))
* **ci:** use last release tag as base for impact report ([e9d12bf](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e9d12bf0f9c4cb4172820c8b1276ceb8cce8cee9))
* improve dead export detection accuracy ([e4d8728](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e4d87286f41cbddb98eb18d6fedcee013c838ae6))
* store original export names in import specifiers across all languages ([4d92110](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4d92110c071e0f397b05a3cd1b10b7176d533f20))


### Refactoring

* extract pipeline file persistence and edge resolution ([cf91a9f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cf91a9f0919189fb550e308781d7f01080bf7bf2))
* extract server tool registration into modular register files ([80baf81](https://github.com/nikolai-vysotskyi/trace-mcp/commit/80baf81835fff26cd6681f5bd7aa55094e3b811e))
* extract shared test utilities into tests/test-utils.ts ([13938c4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/13938c4fda8fb8592e02d115fa3a9df48df9b0be))
* extract Store into repository pattern ([0f43ee2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0f43ee27b1d3537d6af88a8256cfef4b69952638))
* narrow export visibility and minor cleanups across codebase ([fc79331](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fc79331da7069c5a40e94162c80d9c50d1e97ec5))
* remove dead code and narrow export visibility ([ff2c930](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ff2c9309460b4085d9a27cfe1133004419a1fd67))
* reorganize source tree into domain subdirectories ([279f583](https://github.com/nikolai-vysotskyi/trace-mcp/commit/279f583a0ff1b449d85dc617f49a0c2d9c2a53ff))


### Documentation

* add token reduction stat to README tagline ([00dc91f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/00dc91f860458975cd16f536b900d949ede4dbee))
* update README with comparison tables, benchmarks, and .traceignore ([4b8d84a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4b8d84a988c4fdafe9e6089a01d39d1a9e7e2307))


### Tests

* add tests for init, runtime, tools, and AI pipeline ([9219e2d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9219e2d0e8a07091f60f94d01002a87848e3eb34))
* expand conflict-detector coverage with fixture-based tests ([8db3009](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8db3009f795eed581a680a0b6e72cf27cb8df30f))

## [1.4.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.4.0...v1.4.1) (2026-04-05)


### Bug Fixes

* **ci:** upgrade to Node 24 and conditionally upgrade npm ([d0484df](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d0484df53617330f90c5e6eb08b2a4723fecf5bc))

## [1.4.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.3.1...v1.4.0) (2026-04-05)


### Features

* add token optimization guidance to server instructions and hints ([7487bfc](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7487bfc09b4c2193bdd8d6b2179798b920751fff))

## [1.3.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.3.0...v1.3.1) (2026-04-05)


### Bug Fixes

* **ci:** restore npm upgrade for Trusted Publishing OIDC support ([d4e1d92](https://github.com/nikolai-vysotskyi/trace-mcp/commit/d4e1d9252d23da731111d670947bf93d726a285d))

## [1.3.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.2.2...v1.3.0) (2026-04-05)


### Features

* add 10 integration plugins (mcp-sdk, raw-sql, commander, tree-sitter, etc.) ([a89feef](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a89feefad8905c6ad0f00c046c3ec264b847438b))
* enriched change impact with risk scoring, breaking changes, and diff-aware mode ([511b474](https://github.com/nikolai-vysotskyi/trace-mcp/commit/511b474a001bad8a2a8f3ce08017f3aadc233228))
* reduce tool calls and token waste across 7 optimizations ([24ff690](https://github.com/nikolai-vysotskyi/trace-mcp/commit/24ff690e379884116cb3ecb5a41425a5482f7b96))
* safer conflict resolution — comment-out instead of delete, scope to selected clients ([8308564](https://github.com/nikolai-vysotskyi/trace-mcp/commit/830856407a10bab28efb7aa5ffdf10c1bf2950cf))
* scan .github/workflows in project context discovery ([3411e8a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3411e8acc644aad1d8a2a06bd9cc4b73b0ccce08))
* token efficiency improvements + .env security guard ([1b22425](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1b224251a4464208d1b7fed67ef90b6b04d19934))
* Windows support for guard and reindex hooks ([edaaaf5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/edaaaf5c7ef4ab6fb977a6fc47f3d6e1930b6346))


### Bug Fixes

* **ci:** bump Node from 20 to 22 to fix tsup DTS build ([1ceb6d5](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1ceb6d5e6c20d9a0d05e9762dedc787aec62d320))

## [1.2.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.2.1...v1.2.2) (2026-04-05)


### Bug Fixes

* **ci:** auto-trigger CI on release-please PR branches ([caa4edf](https://github.com/nikolai-vysotskyi/trace-mcp/commit/caa4edfdc5a081811f1b4ffea2a4e577ae1f3dba))

## [1.2.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.2.0...v1.2.1) (2026-04-05)


### Bug Fixes

* merge import specifiers on conflict instead of silently dropping ([cd02674](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cd026745c95df8258a88a37d0ce174333c38930e))
* restore parseError used by 20 language/integration plugins ([579c1fa](https://github.com/nikolai-vysotskyi/trace-mcp/commit/579c1fa3cba63c8c71ec7aacefbb6469d37aafba))

## [1.2.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.1.0...v1.2.0) (2026-04-05)


### Features

* add analytics system with benchmarks and session tracking ([8a6650c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8a6650ccd54bbdffb66176bce93c244fe50508c2))
* add bundle management, file watcher, and health check CLI ([220bc9c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/220bc9cea4b5f3b80773fa6d8ac77b9925e4ae31))
* add claw-code MCP client support ([0559ba8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0559ba85c7db7347419e09bd113debe266718d1d))
* add quality gates, taint analysis, and evidence tools ([23bf3a2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/23bf3a2bc850efb4aedc3b8c029be71515c9f4ee))
* integrate new features into server, CLI, and config ([fbaf1d7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fbaf1d7a268ed9e4297efb502edb28d913242570))


### Bug Fixes

* **ci:** support impact reports for release-please auto-PRs ([1bd53ac](https://github.com/nikolai-vysotskyi/trace-mcp/commit/1bd53ac31fa703f6e2f5439693630acd381263ca))


### Performance Improvements

* optimize indexer with concurrent extraction and FTS5 batch mode ([c19273f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c19273f1646805f86db4186a18cb84769de13560))

## [1.1.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.0.11...v1.1.0) (2026-04-05)


### Features

* add code smells scanner, consolidate imports, improve tool routing docs ([9a2b66e](https://github.com/nikolai-vysotskyi/trace-mcp/commit/9a2b66ef3fb7251a24ac7e852f6bfe3444fb5feb))

## [1.0.11](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.0.10...v1.0.11) (2026-04-05)


### Bug Fixes

* **deps:** suppress tree-sitter peer dependency warnings ([0c5b030](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0c5b030884f33aab41d0895ae0321cdf3c092c9f))
* **server:** remove duplicate plan_batch_change tool registration ([0e1143d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0e1143d9db58e28fca92dcf391826448de800086))

## [1.0.10](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.0.9...v1.0.10) (2026-04-05)


### Bug Fixes

* **db:** add missing workspace/is_cross_ws columns in migration v9 ([8b263bd](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8b263bd131940566f739187a0187df10ddcb8288))

## [1.0.9](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.0.8...v1.0.9) (2026-04-05)


### Bug Fixes

* **ci:** upgrade npm for Trusted Publishing OIDC support (requires &gt;=10.9.2) ([21069cc](https://github.com/nikolai-vysotskyi/trace-mcp/commit/21069ccd9a0a0736fda8d05ff6bdc7920167bc18))

## [1.0.8](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.0.7...v1.0.8) (2026-04-05)


### Bug Fixes

* **ci:** restore registry-url for npm OIDC auth ([c2c66aa](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c2c66aae7d6ca052d4d3a1bac55d3274c20db83b))

## [1.0.7](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.0.6...v1.0.7) (2026-04-05)


### Bug Fixes

* **ci:** remove registry-url to let npm use OIDC for Trusted Publishing ([a361917](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a361917aac5f029339f23914cf045c4612b18eb6))

## [1.0.6](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.0.5...v1.0.6) (2026-04-05)


### Bug Fixes

* **ci:** use npm Trusted Publishing (OIDC) instead of NPM_TOKEN ([fe83e53](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fe83e532821dea5a7f484fd5b7e9006dffc1cc4a))

## [1.0.5](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.0.4...v1.0.5) (2026-04-05)


### Bug Fixes

* **ci:** sync package-lock.json with fastest-levenshtein dependency ([638e87a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/638e87aab073002a744e1a6cbc9c16d681756701))

## [1.0.4](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.0.3...v1.0.4) (2026-04-05)


### Bug Fixes

* **ci:** add .npmrc with legacy-peer-deps for tree-sitter conflicts ([bcf5c78](https://github.com/nikolai-vysotskyi/trace-mcp/commit/bcf5c786b2189162f560d24e37901343eff6760c))

## [1.0.3](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.0.2...v1.0.3) (2026-04-05)


### Bug Fixes

* **ci:** chain publish job to release-please via outputs ([09c0be3](https://github.com/nikolai-vysotskyi/trace-mcp/commit/09c0be37bd0aabcedfac384489a9d57065faf7b0))

## [1.0.2](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.0.1...v1.0.2) (2026-04-05)


### Bug Fixes

* **ci:** trigger publish on GitHub Release instead of tag push ([90dfb5d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/90dfb5d756f4560adcc0bd1a009d9fd0b951db7e))

## [1.0.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v1.0.0...v1.0.1) (2026-04-05)


### Bug Fixes

* fix allowList key casing in .clabot for cla-assistant ([6ca67a9](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6ca67a95970bee6a19f4ec8603d15f32c7947e6d))

## [1.0.0](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v0.1.1...v1.0.0) (2026-04-05)


### ⚠ BREAKING CHANGES

* get_task_context replaces manual chaining of search → get_symbol → get_context_bundle as the recommended workflow for AI agents starting work on a task. Server instructions updated to route agents to this tool first.

### Features

* add 23 new analysis tools — control flow, dataflow, SBOM, security, co-changes, history ([0ba05dc](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0ba05dccc100005e97915fcbdcfe630150d7dc6a))
* add 24 new language plugins and improve existing parsers ([c527bdd](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c527bdde16ea9f347d4a68c48fbd4748eb69ccf0))
* add get_task_context — graph-aware context engine for AI agents ([fb7594f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/fb7594f464aa407ce69a4c597949b96ecbd13fd5))
* CI/PR change impact reports — blast radius, risk scores, test gaps ([b88a2bf](https://github.com/nikolai-vysotskyi/trace-mcp/commit/b88a2bf8b773b13048a5351c1c47bf3c0152e6aa))
* doctor command, conflict detection, init improvements ([ef57785](https://github.com/nikolai-vysotskyi/trace-mcp/commit/ef57785f705249709cdbda418119562ee761367a))
* enhance existing tools — call-graph, components, events, flow, introspect, model ([e68c344](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e68c344295dff7e95db96d472fcee643069c4326))
* federation system — cross-repo graph linking and fuzzy search ([54e0008](https://github.com/nikolai-vysotskyi/trace-mcp/commit/54e0008e5e6bff6643ceb1aaefe4fca700ee35ee))
* PostToolUse auto-reindex hook + index-file command ([dd31cc9](https://github.com/nikolai-vysotskyi/trace-mcp/commit/dd31cc949dbe0d20b5ccbe0a74afb579c9f67cbb))
* runtime improvements, session tracking, savings telemetry, prompt system ([44e7cdf](https://github.com/nikolai-vysotskyi/trace-mcp/commit/44e7cdffc17cb6b329fed0b03aaefe51e807bc0c))

## [0.1.1](https://github.com/nikolai-vysotskyi/trace-mcp/compare/v0.1.0...v0.1.1) (2026-04-04)


### Features

* 11 self-development MCP tools + TypeScript heritage graph + ESM import resolution ([01b34d4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/01b34d4488b32d189e0d9ca22c48c23b37febfe1))
* 15 new analysis tools — graph, git, complexity, dead code, rename safety ([0e39503](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0e39503844c0f835630371de1134babce8cfe4d9))
* 34 new language plugins + version feature detection ([631f938](https://github.com/nikolai-vysotskyi/trace-mcp/commit/631f938b47a5a437a0940daeaaec7913fe68a16f))
* 5 new MCP tools + search async upgrade ([e93c247](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e93c24793014e4e6390e1a66c5f5ce603dc43a6b))
* add monorepo support, external plugins, E2E tests ([3e08490](https://github.com/nikolai-vysotskyi/trace-mcp/commit/3e084905bf40a8ca6e55cd009fed3222f2a8a16b))
* add NestJS, Next.js, Express framework plugins ([2d45fca](https://github.com/nikolai-vysotskyi/trace-mcp/commit/2d45fca196743de9f2033d17dc330e2ddba4862d))
* add optional AI semantic search (Ollama + vector store) ([6088a0c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6088a0c0420170d30e3af26736b65105a4b19346))
* **ai:** OpenAI embedding provider ([a880ad7](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a880ad780a60bba97c7c201ac089e7abd0dbb9aa))
* call graph tests, hybrid search tests, seed edge types fix, PageRank cache fix ([6364f79](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6364f79ae7520c07132184a23caddf0a5bc33689))
* core infra — TS heritage extraction, store introspection, watcher debounce ([44247f8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/44247f84ef76b94384dde265294e356d6ce02441))
* DB schema v12, BM25 tuning, pipeline batching, binary/gitignore filtering ([7f203b9](https://github.com/nikolai-vysotskyi/trace-mcp/commit/7f203b9850b96f8de3ee968b6b80a1092954cd53))
* expand MCP server — 30+ new tool registrations, improved descriptions ([5c4778d](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5c4778d0e3bc8524cb4d654a7c8964fb413a9b87))
* file watcher + hot-reload indexing in CLI ([6037836](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6037836dd157216059ad53181700f853a072bf11))
* Gin, Echo, Angular, Svelte integration plugins ([e7fb8f8](https://github.com/nikolai-vysotskyi/trace-mcp/commit/e7fb8f86c86e2f408b3f1a87b2e2b1d9545991f1))
* global config, project registry, CLI init/add/upgrade commands ([dbfc4cf](https://github.com/nikolai-vysotskyi/trace-mcp/commit/dbfc4cf523384d4d6987a1b29a6a7740e20778f7))
* Laravel sub-plugins, new tools, Expo Router, integration tests ([6c10709](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6c10709733cb413dcc46bfa235465f1c957bbac9))
* **laravel:** Filament v3 plugin — resources, panels, widgets, relation managers ([8ecece4](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8ecece4b39763830a09e8b77495a74a948f2df65))
* **laravel:** Livewire v2/v3 plugin integration ([dde7fb0](https://github.com/nikolai-vysotskyi/trace-mcp/commit/dde7fb0fb7b68819d730ed05d53f4be42d63bb06))
* Mongoose, Sequelize, React Native plugins + 4 new tools ([8571d81](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8571d8199c7d88c29989db4f0b808c076462cd1d))
* Nova, Expo Router, find_references + integration tests ([88a741c](https://github.com/nikolai-vysotskyi/trace-mcp/commit/88a741ce11851fe8e54703c0600817fefcd368ca))
* organize integration plugins into category subdirectories ([6e3e42f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6e3e42fb5a8fa794fe12027fa94c90fd5f43c999))
* perf optimizations, Java extends fix, new plugins (Go/Kotlin/Rails/Zod) ([c07ed57](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c07ed57366614109aa8fd006b02e537e6d7b07e8))
* predictive intelligence, intent classification, runtime tracing, topology ([0a9f9d9](https://github.com/nikolai-vysotskyi/trace-mcp/commit/0a9f9d9f5e1d49124f5da29a501cb931f6e4777e))
* Prisma, TypeORM, Drizzle, GraphQL plugins + ORM e2e tests ([8e94a0a](https://github.com/nikolai-vysotskyi/trace-mcp/commit/8e94a0ab69ec8c26bf46338442d0cd38a689ba86))
* Python ecosystem — Django, Flask, FastAPI, Celery, DRF, Pydantic, SQLAlchemy ([acdcaf2](https://github.com/nikolai-vysotskyi/trace-mcp/commit/acdcaf262e876b3104f329e2c09db6337fc06abe))
* reorganize plugin system — versioned languages, categorized integrations ([c7d60c6](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c7d60c6eede249e9440b920a149cd4d9d604c354))
* security hardening, batch DB ops, dependency graph, dead export detection ([6eda537](https://github.com/nikolai-vysotskyi/trace-mcp/commit/6eda537c9fbef32064bfd38e8887be33255ce6bc))
* Spring/Rails plugins, platform-specific RN edges, expanded dynamic tool registration ([96d543b](https://github.com/nikolai-vysotskyi/trace-mcp/commit/96d543b8272e5a24ed42c8f6dd53bfc746cc2996))
* testing framework plugin + edge types for test coverage analysis ([36271b9](https://github.com/nikolai-vysotskyi/trace-mcp/commit/36271b9e19d9ed4c30a27b2a303c4e80198aa292))
* tRPC, Fastify, Socket.io, Zustand, React plugins + Django registration + fixes ([5988e93](https://github.com/nikolai-vysotskyi/trace-mcp/commit/5988e9310d8bf828d029c0e8765ff93c585a66de))
* wire EmbeddingPipeline into CLI serve command ([4ecaa40](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4ecaa4055c51ba616ff95690ec147f74d5e673ce))
* zustand/redux state tool, security utils, dead-exports/references/hierarchy tests ([a3c0f5f](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a3c0f5f438ff8683f1d77b7bcb56a565fe0b0bb6))


### Bug Fixes

* add missing handler/metadata fields to RouteRow and null-check file_id ([4d942bf](https://github.com/nikolai-vysotskyi/trace-mcp/commit/4d942bf2f8e54ab76012ed658e4bace866c55d36))
* align n8n plugin tests with current implementation ([cda3915](https://github.com/nikolai-vysotskyi/trace-mcp/commit/cda3915223f4302ed9fb44b2748b04427853b80d))
* Inertia edge resolution + integration tests exposing real bugs ([c6fc041](https://github.com/nikolai-vysotskyi/trace-mcp/commit/c6fc041d795bf7867a152ae6dd47123bc702a375))
* Kotlin heritage regex + Go/n8n/tRPC improvements ([a649977](https://github.com/nikolai-vysotskyi/trace-mcp/commit/a649977f353a040ab16b8711698a599a127c5fc2))
* ORM-specific edge type resolution in pipeline ([62c7905](https://github.com/nikolai-vysotskyi/trace-mcp/commit/62c7905d5360c6a8582c141bb2f5f5c0f5e0e020))

## [0.1.0] — 2026-04-04

### Added

- **Core engine** — TypeScript AST parser, dependency graph builder, SQLite-backed symbol store
- **MCP server** with 15+ tools: `search`, `get_symbol`, `get_call_graph`, `get_change_impact`, `find_usages`, `get_feature_context`, `get_tests_for`, `get_project_map`, and more
- **CLI** with `index`, `serve`, and `watch` commands
- **File watcher** — hot-reload indexing with debounce

#### Language plugins
- **TypeScript/JavaScript** — heritage extraction, ESM import resolution
- **Python** — Django, Flask, FastAPI, Celery, DRF, Pydantic, SQLAlchemy
- **Go** — version-aware feature detection
- **Java** — extends/implements extraction, Spring Boot plugin
- **Kotlin** — heritage regex, version features
- **Ruby** — Rails plugin, version features
- **CSS** — version feature detection

#### Framework & integration plugins
- **Laravel** — Livewire v2/v3, Filament v3, Nova, Blade, Inertia, sub-plugins
- **Vue / Nuxt** — component graph, Inertia edge resolution
- **React / React Native** — platform-specific edges, Expo Router
- **Next.js / Express / NestJS / Fastify** — route & middleware extraction
- **tRPC / GraphQL / Socket.io** — API edge types
- **Prisma / TypeORM / Drizzle / Mongoose / Sequelize** — ORM-specific edges
- **Zustand / Redux** — state management tool
- **Zod** — schema validation edges
- **n8n** — workflow plugin (25 tests)
- **Testing frameworks** — edge types for test coverage analysis

#### Infrastructure
- **AI semantic search** — Ollama + OpenAI embedding providers, vector store
- **Security hardening** — input validation, security utils
- **Batch DB operations** — optimized SQLite writes
- **Monorepo support** — workspace detection, cross-package edges
- **External plugin system** — dynamic tool registration
- **Plugin reorganization** — versioned languages, categorized integrations

### Fixed

- Inertia edge resolution in integration tests
- Bootstrap routing path normalization
- ORM-specific edge type resolution in pipeline
- Kotlin heritage regex parsing
- Go/n8n/tRPC integration improvements
- Missing `handler`/`metadata` fields in `RouteRow` + null-check `file_id`
- n8n plugin test alignment with implementation
- Seed edge types fix, PageRank cache fix

### Changed

- Pipeline performance optimizations
- Deterministic watcher tests
- Search upgraded to async

[0.1.0]: https://github.com/nicovell3/trace-mcp/releases/tag/v0.1.0
