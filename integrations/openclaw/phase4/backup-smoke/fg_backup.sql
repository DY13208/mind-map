--
-- PostgreSQL database dump
--

\restrict ouY3g56dHP8FoBPJy3bRhJslawHpePmCjb1p6iFmTCTI86pSVV0dVHB4MOaQoYp

-- Dumped from database version 16.14
-- Dumped by pg_dump version 16.14

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Data for Name: knowledge_docmost_mappings; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.knowledge_docmost_mappings (id, room_id, topic_key, slot, owner, canonical_path, docmost_space_id, docmost_page_id, content_hash, last_synced_version, title, created_at, updated_at, deleted_at) FROM stdin;
2	room-2yaz570x	README	standard	mindmap	README.md	01a0aeac-881d-799a-9e6d-e902b4a54bd9	01a0b23d-70aa-7385-a3dc-4a75ddce090b	752568a96c3b48f8e69e4ed2a64340b9a99d29be65a0ce2c051269f8b3506523	34	画布1 · 标准知识	2026-09-18 01:59:26.148211+00	2026-09-18 01:59:26.148211+00	\N
3	room-2yaz570x	branches/7e3aac59-4a3c-4e17-8d75-14357b80ff40.md	standard	mindmap	branches/7e3aac59-4a3c-4e17-8d75-14357b80ff40.md	01a0aeac-881d-799a-9e6d-e902b4a54bd9	01a0b23d-7118-7ab8-a888-f64cf1907fb5	c18a6b2ccb75ad6b1bb2408256b474acee3d0d6f63ccf180e1959211ee42545c	34	P：品牌目标 · 标准知识	2026-09-18 01:59:26.265659+00	2026-09-18 01:59:26.265659+00	\N
4	room-2yaz570x	branches/9bea1fe8-9716-4e6a-b009-60e1d541a39e.md	standard	mindmap	branches/9bea1fe8-9716-4e6a-b009-60e1d541a39e.md	01a0aeac-881d-799a-9e6d-e902b4a54bd9	01a0b23d-7178-7a3d-bc07-e5c2ca958073	447c0270ea2978d671a9ce89091620d6735a00716da4d988515ef336a5e05d90	34	P：购销存循环 · 标准知识	2026-09-18 01:59:26.355042+00	2026-09-18 01:59:26.355042+00	\N
5	room-2yaz570x	branches/e15ca6e8-a0e0-4da0-94ab-37d42fc6ed96.md	standard	mindmap	branches/e15ca6e8-a0e0-4da0-94ab-37d42fc6ed96.md	01a0aeac-881d-799a-9e6d-e902b4a54bd9	01a0b23d-71cd-7168-baea-545fb019181e	0321c0ae08198f09127546ce4128175e253b742840708c6c8ecb10aa866c0c35	34	P：品牌战略 · 标准知识	2026-09-18 01:59:26.424634+00	2026-09-18 01:59:26.424634+00	\N
6	room-2yaz570x	branches/04655d24-cb10-4ff5-9a46-f9e768475fc2.md	standard	mindmap	branches/04655d24-cb10-4ff5-9a46-f9e768475fc2.md	01a0aeac-881d-799a-9e6d-e902b4a54bd9	01a0b23d-7216-7208-b0f7-a676f3859815	0363fbb84d0d4d71782f16cc661b8a0955ce4418a5a6109f4830b5e263e0fbb8	34	P：渠道运营 · 标准知识	2026-09-18 01:59:26.509561+00	2026-09-18 01:59:26.509561+00	\N
7	room-2yaz570x	branches/8ec88f39-9a70-40cc-9aac-52ae0500f50e.md	standard	mindmap	branches/8ec88f39-9a70-40cc-9aac-52ae0500f50e.md	01a0aeac-881d-799a-9e6d-e902b4a54bd9	01a0b23d-7272-7ab4-8d48-37597890ce53	cdec1cad7c9d110d97a9752676e8ff2a8fb75c3223bbe4231f47a660955c1317	34	P：品牌营销 · 标准知识	2026-09-18 01:59:26.602731+00	2026-09-18 01:59:26.602731+00	\N
8	room-2yaz570x	e2e-legacy-topic	human	human	branches/e2e-legacy.md	01a0aeac-881d-799a-9e6d-e902b4a54bd9	01a0b23d-7318-712f-a69f-583695d54d15	legacy		E2E旧混合页	2026-09-18 01:59:26.754564+00	2026-09-18 01:59:26.754564+00	\N
9	room-2yaz570x	e2e-legacy-topic	standard	mindmap	branches/e2e-legacy.md	01a0aeac-881d-799a-9e6d-e902b4a54bd9	01a0b23d-734c-78d1-b0eb-dad3ed1e3bad	std	e2e	E2E Legacy · 标准知识	2026-09-18 01:59:26.807178+00	2026-09-18 01:59:27.542053+00	2026-09-18 01:59:27.542053+00
10	room-2yaz570x	e2e-wrong-map	standard	mindmap	branches/e2e-wrong.md	01a0aeac-881d-799a-9e6d-e902b4a54bd9	01a0b23d-73ab-7c35-a694-90db6bc083d3	rebound	e2e	E2E Wrong · 标准知识	2026-09-18 01:59:26.861709+00	2026-09-18 01:59:27.558304+00	2026-09-18 01:59:27.558304+00
12	room-6b5wc9z3	README	standard	mindmap	README.md	01a0aeac-881d-799a-9e6d-e902b4a54bd9	\N			room-B standard seed	2026-09-18 07:39:12.348145+00	2026-09-18 07:39:12.348145+00	\N
13	room-2yaz570x	phase3-ai-topic	ai	ai		01a0aeac-881d-799a-9e6d-e902b4a54bd9	01a0b376-b1ce-7179-a33d-6faab55d28dd	ceaa20c8d55e428752f60b598bf89f31aafe3aa2d21f10d30cfe6ddcd5170843	ai-1789717327450	Phase3 AI	2026-09-18 07:41:35.804351+00	2026-09-18 07:42:07.450895+00	\N
15	room-6b5wc9z3	phase3-ai-topic	ai	ai		01a0aeac-881d-799a-9e6d-e902b4a54bd9	01a0b377-2d01-750e-bdd2-e390a4a2cf7d	7961369acad33728b2afb391bb35684d7e31f2df0cbe189866536be341e86bdc	ai-1789717327140	phase3-ai-topic · AI 整理	2026-09-18 07:42:07.14104+00	2026-09-18 07:42:07.14104+00	\N
20	room-2yaz570x	openwiki:branches/8ec88f39-9a70-40cc-9aac-52ae0500f50e	ai	ai		01a0aeac-881d-799a-9e6d-e902b4a54bd9	01a0b377-33c2-70c9-84f7-71b0130d439a	fed117ce84fd1071c93605d7a1c74c1f9575a7fc69bf53ee2573d46a05902924	ai-1789724702585	8ec88f39-9a70-40cc-9aac-52ae0500f50e · AI 整理	2026-09-18 07:42:08.848722+00	2026-09-18 09:45:02.586338+00	\N
21	room-2yaz570x	openwiki:branches/9bea1fe8-9716-4e6a-b009-60e1d541a39e	ai	ai		01a0aeac-881d-799a-9e6d-e902b4a54bd9	01a0b377-340b-7c7b-84ba-5ad48b4e87d4	ae9c7a35decd27f395a204ff249f2682ba055500f649ae72e17260bf0e9b05ec	ai-1789724702795	9bea1fe8-9716-4e6a-b009-60e1d541a39e · AI 整理	2026-09-18 07:42:08.922461+00	2026-09-18 09:45:02.795991+00	\N
23	room-2yaz570x	README	ai	ai		01a0aeac-881d-799a-9e6d-e902b4a54bd9	01a0b377-39f1-7f96-8fb1-4646f4ad2a87	ef95e3c7725e7f9cda5a5321367e6df341510312953043f95adcb69e5fee2fb2	ai-1789725417377	README · AI 整理	2026-09-18 07:42:10.501032+00	2026-09-18 09:56:57.379804+00	\N
22	room-2yaz570x	openwiki:branches/e15ca6e8-a0e0-4da0-94ab-37d42fc6ed96	ai	ai		01a0aeac-881d-799a-9e6d-e902b4a54bd9	01a0b377-3476-7baa-90ff-cca8cac76d4a	9f608a54c0684bbc3954f87886d9f3fc006845e345cb87933eae95d5f10a5c25	ai-1789719131640	e15ca6e8-a0e0-4da0-94ab-37d42fc6ed96 · AI 整理	2026-09-18 07:42:09.105397+00	2026-09-18 08:12:11.641004+00	\N
24	room-2yaz570x	phase4-ai-topic	ai	ai		01a0aeac-881d-799a-9e6d-e902b4a54bd9	01a0b391-abcb-7439-a027-58944cdbbc4d	8ae5d7bc890219c25dbef679efd3fa85ef5f4f620daeec3163af830e4ced31ee	ai-1789724700007	phase4-ai-topic · AI 整理	2026-09-18 08:11:03.600825+00	2026-09-18 09:45:00.010027+00	\N
17	room-2yaz570x	openwiki:README	ai	ai		01a0aeac-881d-799a-9e6d-e902b4a54bd9	01a0b377-3198-79b2-84bd-d6298d8f90e1	365aeb03d615577c9d265823b32089b3cc38254546a09a04ea302e659d3916b8	ai-1789724701551	README · AI 整理	2026-09-18 07:42:08.30062+00	2026-09-18 09:45:01.551624+00	\N
18	room-2yaz570x	openwiki:branches/04655d24-cb10-4ff5-9a46-f9e768475fc2	ai	ai		01a0aeac-881d-799a-9e6d-e902b4a54bd9	01a0b377-3231-72f6-9f9e-787fc7a1da16	c00ed10bfcd6e2e7e0dc1cf0b0a7de5ab0a506bcdf711197ed41ef38ecf93cfc	ai-1789724701945	04655d24-cb10-4ff5-9a46-f9e768475fc2 · AI 整理	2026-09-18 07:42:08.464567+00	2026-09-18 09:45:01.946294+00	\N
19	room-2yaz570x	openwiki:branches/7e3aac59-4a3c-4e17-8d75-14357b80ff40	ai	ai		01a0aeac-881d-799a-9e6d-e902b4a54bd9	01a0b377-3322-7160-8c06-d60627869724	0929b4abaf16e7da131518cffcde854dcc1da49f89364d2ba38a9917e98fa654	ai-1789724702314	7e3aac59-4a3c-4e17-8d75-14357b80ff40 · AI 整理	2026-09-18 07:42:08.707136+00	2026-09-18 09:45:02.315538+00	\N
\.


--
-- Data for Name: knowledge_openwiki_jobs; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.knowledge_openwiki_jobs (job_id, room_id, requester_user_id, status, queued_at, started_at, finished_at, output_hash, docmost_publish_status, error, result_json, lock_token, updated_at) FROM stdin;
2ac50f05-06b4-4064-92fd-dd29b84e511c	room-2yaz570x	phase3-user-a	succeeded	2026-09-18 08:11:04.14603+00	2026-09-18 08:12:09.417+00	2026-09-18 08:12:11.676+00	1c46a13c32c05dc38d434e48381f3b2ce050e068a444883fbdcda6d07dde172a|9fb7fa112340d9848978bd29e9366dc2a31b460dd4394150d05be713f7f2eb3e|9196312e69a44a9fb0b4f335e0cf5fbdafc6760fd713c73abb4d51fb97623d8b|5996a5463ecba02cb0e163acf644eea6be893df644db30c923b7ce40e9eeea9c|e1622a3cf156a1ea1279371e4a24a399212131dd0a9c94edae5a5d87808e1f4a|8b35401f1c641892d4ef44dac2a015954d2a92942a883b900634ffffee26e127	ok	\N	{"failures": [], "published": [{"hash": "1c46a13c32c05dc38d434e48381f3b2ce050e068a444883fbdcda6d07dde172a", "pageId": "01a0b377-3198-79b2-84bd-d6298d8f90e1", "topicKey": "openwiki:README"}, {"hash": "9fb7fa112340d9848978bd29e9366dc2a31b460dd4394150d05be713f7f2eb3e", "pageId": "01a0b377-3231-72f6-9f9e-787fc7a1da16", "topicKey": "openwiki:branches/04655d24-cb10-4ff5-9a46-f9e768475fc2"}, {"hash": "9196312e69a44a9fb0b4f335e0cf5fbdafc6760fd713c73abb4d51fb97623d8b", "pageId": "01a0b377-3322-7160-8c06-d60627869724", "topicKey": "openwiki:branches/7e3aac59-4a3c-4e17-8d75-14357b80ff40"}, {"hash": "5996a5463ecba02cb0e163acf644eea6be893df644db30c923b7ce40e9eeea9c", "pageId": "01a0b377-33c2-70c9-84f7-71b0130d439a", "topicKey": "openwiki:branches/8ec88f39-9a70-40cc-9aac-52ae0500f50e"}, {"hash": "e1622a3cf156a1ea1279371e4a24a399212131dd0a9c94edae5a5d87808e1f4a", "pageId": "01a0b377-340b-7c7b-84ba-5ad48b4e87d4", "topicKey": "openwiki:branches/9bea1fe8-9716-4e6a-b009-60e1d541a39e"}, {"hash": "8b35401f1c641892d4ef44dac2a015954d2a92942a883b900634ffffee26e127", "pageId": "01a0b377-3476-7baa-90ff-cca8cac76d4a", "topicKey": "openwiki:branches/e15ca6e8-a0e0-4da0-94ab-37d42fc6ed96"}], "outputHash": "1c46a13c32c05dc38d434e48381f3b2ce050e068a444883fbdcda6d07dde172a|9fb7fa112340d9848978bd29e9366dc2a31b460dd4394150d05be713f7f2eb3e|9196312e69a44a9fb0b4f335e0cf5fbdafc6760fd713c73abb4d51fb97623d8b|5996a5463ecba02cb0e163acf644eea6be893df644db30c923b7ce40e9eeea9c|e1622a3cf156a1ea1279371e4a24a399212131dd0a9c94edae5a5d87808e1f4a|8b35401f1c641892d4ef44dac2a015954d2a92942a883b900634ffffee26e127"}	\N	2026-09-18 08:12:11.677846+00
0a3e63ee-5acb-4520-839f-b31dea2d204e	room-2yaz570x	phase3-user-a	failed	2026-09-18 09:45:00.633168+00	2026-09-18 09:56:44.959+00	2026-09-18 10:22:11.669278+00	\N	pending	| reclaimed_stale_running	\N	\N	2026-09-18 10:22:11.669278+00
d5159cca-b3a3-454a-8244-a6e142e7f0b5	room-2yaz570x	phase3-user-a	failed	2026-09-18 11:01:24.290643+00	2026-09-18 11:01:24.297+00	2026-09-18 11:01:24.433+00	\N	skipped	openwiki_cli_failed	\N	\N	2026-09-18 11:01:24.433872+00
\.


--
-- Name: knowledge_docmost_mappings_id_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.knowledge_docmost_mappings_id_seq', 39, true);


--
-- PostgreSQL database dump complete
--

\unrestrict ouY3g56dHP8FoBPJy3bRhJslawHpePmCjb1p6iFmTCTI86pSVV0dVHB4MOaQoYp