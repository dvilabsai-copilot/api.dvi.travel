# Client-Ready Hotspot Decision Report

Generated: 2026-04-10T07:51:54.846Z
Input runner artifact: C:\wamp64\www\dvi_fullstack\api.dvi.travel\verification-e2e\automation\artifacts\south-india-hotspot-analysis-1775807361587.json
Input server log: c:/wamp64/www/dvi_fullstack/api.dvi.travel/hotspot-debug-server.log

## Per-Itinerary / Per-Run Summary
| Scenario | Run | Quote ID | Plan ID | Total | Selected | Rejected | Deferred | Duplicate | Closed@Visit | DayMismatch | NoWindow | OptionalClosedSkip | P1 Selected | P1 Rejected | P1 Deferred |
|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| TN-Coast-Chennai-Mahabalipuram-Pondicherry | 1 | DVI202604208 | 246 | 109 | 34 | 73 | 2 | 41 | 27 | 0 | 5 | 14 | 3 | 4 | 0 |
| TN-Coast-Chennai-Mahabalipuram-Pondicherry | 2 | DVI202604209 | 247 | 109 | 34 | 73 | 2 | 41 | 27 | 0 | 5 | 14 | 3 | 4 | 0 |
| Kerala-Trivandrum-Munnar-Alleppey | 1 | DVI202604210 | 248 | 73 | 23 | 47 | 3 | 13 | 10 | 0 | 24 | 2 | 2 | 2 | 1 |
| Kerala-Trivandrum-Munnar-Alleppey | 2 | DVI202604211 | 249 | 73 | 23 | 47 | 3 | 13 | 10 | 0 | 24 | 2 | 2 | 2 | 1 |
| Karnataka-Bengaluru-Mysuru-Ooty | 1 | DVI202604212 | 250 | 88 | 19 | 65 | 4 | 25 | 40 | 0 | 0 | 40 | 2 | 3 | 0 |
| Karnataka-Bengaluru-Mysuru-Ooty | 2 | DVI202604213 | 251 | 88 | 19 | 65 | 4 | 25 | 40 | 0 | 0 | 40 | 2 | 3 | 0 |
| AP-Telangana-Tirupati-Hyderabad | 1 | DVI202604214 | 252 | 159 | 30 | 121 | 8 | 60 | 27 | 0 | 34 | 20 | 2 | 7 | 1 |
| AP-Telangana-Tirupati-Hyderabad | 2 | DVI202604215 | 253 | 159 | 30 | 121 | 8 | 60 | 27 | 0 | 34 | 20 | 2 | 7 | 1 |
| Mixed-Chennai-Tirupati-Hyderabad-Mahabalipuram | 1 | DVI202604216 | 254 | 130 | 27 | 99 | 4 | 49 | 26 | 0 | 24 | 13 | 3 | 4 | 0 |
| Mixed-Chennai-Tirupati-Hyderabad-Mahabalipuram | 2 | DVI202604217 | 255 | 130 | 27 | 99 | 4 | 49 | 26 | 0 | 24 | 13 | 3 | 4 | 0 |

## TN-Coast-Chennai-Mahabalipuram-Pondicherry :: Run 1 :: DVI202604208

### Day-wise Breakdown
| Day | Source | Destination | Selected | Rejected | Deferred |
|---:|---|---|---:|---:|---:|
| 1 | Chennai | Mahabalipuram | 11 | 13 | 0 |
| 2 | Mahabalipuram | Pondicherry | 2 | 1 | 0 |
| 3 | Pondicherry | Pondicherry | 9 | 6 | 1 |
| 4 | Pondicherry | Pondicherry | 4 | 11 | 0 |
| 5 | Pondicherry | Chennai | 3 | 23 | 0 |
| 6 | Chennai | Chennai | 5 | 19 | 1 |

### Client-Ready Examples (Real Hotspots Only)
- Mahabalipuram - priority 1 - attempted 09:04:00 to 13:04:00 - open 06:00:00 to 18:00:00 - SELECTED
- Mahabalipuram - priority 3 - attempted 13:57:00 to 14:57:00 - open 10:00:00 to 18:00:00 - SELECTED
- Pondicherry Airport - priority 7 - attempted 13:31:00 to 14:01:00 - open 09:00:00 to 18:00:00 - SELECTED
- Pondicherry Airport - priority 0 - attempted 16:13:00 to 16:33:00 - open 00:00:00 to 23:59:59 - SELECTED
- Mahabalipuram - priority 2 - attempted 13:37:00 to 15:07:00 - closes at --:-- - REJECTED

## TN-Coast-Chennai-Mahabalipuram-Pondicherry :: Run 2 :: DVI202604209

### Day-wise Breakdown
| Day | Source | Destination | Selected | Rejected | Deferred |
|---:|---|---|---:|---:|---:|
| 1 | Chennai | Mahabalipuram | 11 | 13 | 0 |
| 2 | Mahabalipuram | Pondicherry | 2 | 1 | 0 |
| 3 | Pondicherry | Pondicherry | 9 | 6 | 1 |
| 4 | Pondicherry | Pondicherry | 4 | 11 | 0 |
| 5 | Pondicherry | Chennai | 3 | 23 | 0 |
| 6 | Chennai | Chennai | 5 | 19 | 1 |

### Client-Ready Examples (Real Hotspots Only)
- Mahabalipuram - priority 1 - attempted 09:04:00 to 13:04:00 - open 06:00:00 to 18:00:00 - SELECTED
- Mahabalipuram - priority 3 - attempted 13:57:00 to 14:57:00 - open 10:00:00 to 18:00:00 - SELECTED
- Pondicherry Airport - priority 7 - attempted 13:31:00 to 14:01:00 - open 09:00:00 to 18:00:00 - SELECTED
- Pondicherry Airport - priority 0 - attempted 16:13:00 to 16:33:00 - open 00:00:00 to 23:59:59 - SELECTED
- Mahabalipuram - priority 2 - attempted 13:37:00 to 15:07:00 - closes at --:-- - REJECTED

## Kerala-Trivandrum-Munnar-Alleppey :: Run 1 :: DVI202604210

### Day-wise Breakdown
| Day | Source | Destination | Selected | Rejected | Deferred |
|---:|---|---|---:|---:|---:|
| 1 | Trivandrum | Munnar | 6 | 8 | 0 |
| 2 | Munnar | Munnar | 6 | 0 | 0 |
| 3 | Munnar | Alleppey | 3 | 7 | 0 |
| 4 | Alleppey | Alleppey | 6 | 2 | 0 |
| 5 | Alleppey | Kochi | 2 | 30 | 3 |

### Client-Ready Examples (Real Hotspots Only)
- Munnar - priority 1 - attempted 09:57:00 to 10:17:00 - open 08:00:00 to 19:00:00 - SELECTED
- Munnar - priority 2 - attempted 10:23:00 to 10:43:00 - open 06:00:00 to 21:00:00 - SELECTED
- Munnar - priority 3 - attempted 11:36:00 to 14:36:00 - open 07:00:00 to 16:00:00 - SELECTED
- Munnar - priority 4 - attempted 15:11:00 to 16:11:00 - open 09:00:00 to 17:00:00 - SELECTED
- Munnar - priority 5 - attempted 16:29:00 to 17:29:00 - open 09:30:00 to 18:30:00 - SELECTED
- Munnar - priority 6 - attempted 17:59:00 to 18:44:00 - open 09:00:00 to 20:00:00 - SELECTED
- Trivandrum - priority 6 - attempted 07:57:00 to 09:27:00 - closes at --:-- - REJECTED
- Trivandrum - priority 11 - attempted 18:17:00 to 19:17:00 - closes at --:-- - REJECTED
- Trivandrum - priority 14 - attempted 21:38:00 to 23:38:00 - closes at 18:00:00 - REJECTED
- Alleppey - priority 0 - attempted 15:38:00 to 18:38:00 - closes at 18:00:00 - REJECTED
- Alleppey - priority 0 - attempted 19:45:00 to 20:45:00 - closes at 16:30:00 - REJECTED
- Alleppey - priority 0 - attempted 13:41:00 to 14:41:00 - opens at 09:00:00 - DEFERRED

## Kerala-Trivandrum-Munnar-Alleppey :: Run 2 :: DVI202604211

### Day-wise Breakdown
| Day | Source | Destination | Selected | Rejected | Deferred |
|---:|---|---|---:|---:|---:|
| 1 | Trivandrum | Munnar | 6 | 8 | 0 |
| 2 | Munnar | Munnar | 6 | 0 | 0 |
| 3 | Munnar | Alleppey | 3 | 7 | 0 |
| 4 | Alleppey | Alleppey | 6 | 2 | 0 |
| 5 | Alleppey | Kochi | 2 | 30 | 3 |

### Client-Ready Examples (Real Hotspots Only)
- Munnar - priority 1 - attempted 09:57:00 to 10:17:00 - open 08:00:00 to 19:00:00 - SELECTED
- Munnar - priority 2 - attempted 10:23:00 to 10:43:00 - open 06:00:00 to 21:00:00 - SELECTED
- Munnar - priority 3 - attempted 11:36:00 to 14:36:00 - open 07:00:00 to 16:00:00 - SELECTED
- Munnar - priority 4 - attempted 15:11:00 to 16:11:00 - open 09:00:00 to 17:00:00 - SELECTED
- Munnar - priority 5 - attempted 16:29:00 to 17:29:00 - open 09:30:00 to 18:30:00 - SELECTED
- Munnar - priority 6 - attempted 17:59:00 to 18:44:00 - open 09:00:00 to 20:00:00 - SELECTED
- Trivandrum - priority 6 - attempted 07:57:00 to 09:27:00 - closes at --:-- - REJECTED
- Trivandrum - priority 11 - attempted 18:17:00 to 19:17:00 - closes at --:-- - REJECTED
- Trivandrum - priority 14 - attempted 21:38:00 to 23:38:00 - closes at 18:00:00 - REJECTED
- Alleppey - priority 0 - attempted 15:38:00 to 18:38:00 - closes at 18:00:00 - REJECTED
- Alleppey - priority 0 - attempted 19:45:00 to 20:45:00 - closes at 16:30:00 - REJECTED
- Alleppey - priority 0 - attempted 13:41:00 to 14:41:00 - opens at 09:00:00 - DEFERRED

## Karnataka-Bengaluru-Mysuru-Ooty :: Run 1 :: DVI202604212

### Day-wise Breakdown
| Day | Source | Destination | Selected | Rejected | Deferred |
|---:|---|---|---:|---:|---:|
| 3 | Mysuru | Ooty | 6 | 5 | 1 |
| 4 | Ooty | Ooty | 6 | 18 | 1 |
| 5 | Ooty | Coimbatore | 4 | 30 | 2 |
| 6 | Coimbatore | Coimbatore | 3 | 12 | 0 |

### Client-Ready Examples (Real Hotspots Only)
- Ooty - priority 1 - attempted 10:00:00 to 11:00:00 - open 09:00:00 to 18:00:00 - SELECTED
- Ooty - priority 2 - attempted 11:18:00 to 12:18:00 - open 07:00:00 to 18:30:00 - SELECTED
- Ooty - priority 3 - attempted 12:28:00 to 13:28:00 - open 07:00:00 to 18:30:00 - SELECTED
- Ooty - priority 3 - attempted 13:47:00 to 14:47:00 - open 09:00:00 to 18:00:00 - SELECTED
- Ooty - priority 5 - attempted 14:59:00 to 15:59:00 - open 09:00:00 to 18:30:00 - SELECTED
- Ooty - priority 19 - attempted 16:21:00 to 17:51:00 - open 09:00:00 to 19:00:00 - SELECTED
- Ooty - priority 6 - attempted 17:44:00 to 21:44:00 - closes at --:-- - REJECTED
- Ooty - priority 21 - attempted 18:27:00 to 19:27:00 - closes at --:-- - REJECTED
- Ooty - priority 0 - attempted 17:59:00 to 19:59:00 - closes at 05:30:00 - REJECTED
- Ooty - priority 0 - attempted 17:59:00 to 19:29:00 - closes at 18:30:00 - REJECTED
- Ooty - priority 0 - attempted 17:55:00 to 18:55:00 - closes at --:-- - REJECTED
- Ooty - priority 6 - attempted 10:52:00 to 14:52:00 - closes at --:-- - REJECTED
- Ooty - priority 20 - attempted 18:17:00 to 19:17:00 - opens at 20:00:00 - DEFERRED
- Ooty - priority 0 - attempted 10:56:00 to 12:26:00 - opens at 09:15:00 - DEFERRED
- Ooty - priority 0 - attempted 09:05:00 to 10:35:00 - opens at 09:15:00 - DEFERRED

## Karnataka-Bengaluru-Mysuru-Ooty :: Run 2 :: DVI202604213

### Day-wise Breakdown
| Day | Source | Destination | Selected | Rejected | Deferred |
|---:|---|---|---:|---:|---:|
| 3 | Mysuru | Ooty | 6 | 5 | 1 |
| 4 | Ooty | Ooty | 6 | 18 | 1 |
| 5 | Ooty | Coimbatore | 4 | 30 | 2 |
| 6 | Coimbatore | Coimbatore | 3 | 12 | 0 |

### Client-Ready Examples (Real Hotspots Only)
- Ooty - priority 1 - attempted 10:00:00 to 11:00:00 - open 09:00:00 to 18:00:00 - SELECTED
- Ooty - priority 2 - attempted 11:18:00 to 12:18:00 - open 07:00:00 to 18:30:00 - SELECTED
- Ooty - priority 3 - attempted 12:28:00 to 13:28:00 - open 07:00:00 to 18:30:00 - SELECTED
- Ooty - priority 3 - attempted 13:47:00 to 14:47:00 - open 09:00:00 to 18:00:00 - SELECTED
- Ooty - priority 5 - attempted 14:59:00 to 15:59:00 - open 09:00:00 to 18:30:00 - SELECTED
- Ooty - priority 19 - attempted 16:21:00 to 17:51:00 - open 09:00:00 to 19:00:00 - SELECTED
- Ooty - priority 6 - attempted 17:44:00 to 21:44:00 - closes at --:-- - REJECTED
- Ooty - priority 21 - attempted 18:27:00 to 19:27:00 - closes at --:-- - REJECTED
- Ooty - priority 0 - attempted 17:59:00 to 19:59:00 - closes at 05:30:00 - REJECTED
- Ooty - priority 0 - attempted 17:59:00 to 19:29:00 - closes at 18:30:00 - REJECTED
- Ooty - priority 0 - attempted 17:55:00 to 18:55:00 - closes at --:-- - REJECTED
- Ooty - priority 6 - attempted 10:52:00 to 14:52:00 - closes at --:-- - REJECTED
- Ooty - priority 20 - attempted 18:17:00 to 19:17:00 - opens at 20:00:00 - DEFERRED
- Ooty - priority 0 - attempted 10:56:00 to 12:26:00 - opens at 09:15:00 - DEFERRED
- Ooty - priority 0 - attempted 09:05:00 to 10:35:00 - opens at 09:15:00 - DEFERRED

## AP-Telangana-Tirupati-Hyderabad :: Run 1 :: DVI202604214

### Day-wise Breakdown
| Day | Source | Destination | Selected | Rejected | Deferred |
|---:|---|---|---:|---:|---:|
| 1 | Tirupati | Hyderabad | 7 | 7 | 0 |
| 2 | Hyderabad | Hyderabad | 6 | 4 | 2 |
| 3 | Hyderabad | Hyderabad | 7 | 43 | 2 |
| 4 | Hyderabad | Tirupati | 6 | 21 | 4 |
| 5 | Tirupati | Tirupati | 3 | 23 | 0 |
| 6 | Tirupati | Tirupati | 1 | 23 | 0 |

### Client-Ready Examples (Real Hotspots Only)

## AP-Telangana-Tirupati-Hyderabad :: Run 2 :: DVI202604215

### Day-wise Breakdown
| Day | Source | Destination | Selected | Rejected | Deferred |
|---:|---|---|---:|---:|---:|
| 1 | Tirupati | Hyderabad | 7 | 7 | 0 |
| 2 | Hyderabad | Hyderabad | 6 | 4 | 2 |
| 3 | Hyderabad | Hyderabad | 7 | 43 | 2 |
| 4 | Hyderabad | Tirupati | 6 | 21 | 4 |
| 5 | Tirupati | Tirupati | 3 | 23 | 0 |
| 6 | Tirupati | Tirupati | 1 | 23 | 0 |

### Client-Ready Examples (Real Hotspots Only)

## Mixed-Chennai-Tirupati-Hyderabad-Mahabalipuram :: Run 1 :: DVI202604216

### Day-wise Breakdown
| Day | Source | Destination | Selected | Rejected | Deferred |
|---:|---|---|---:|---:|---:|
| 1 | Chennai | Tirupati | 11 | 13 | 0 |
| 3 | Hyderabad | Hyderabad | 7 | 43 | 2 |
| 4 | Hyderabad | Mahabalipuram | 5 | 19 | 2 |
| 5 | Mahabalipuram | Chennai | 3 | 1 | 0 |
| 6 | Chennai | Chennai | 1 | 23 | 0 |

### Client-Ready Examples (Real Hotspots Only)
- Mahabalipuram - priority 1 - attempted 09:04:00 to 13:04:00 - open 06:00:00 to 18:00:00 - SELECTED
- Mahabalipuram - priority 3 - attempted 13:57:00 to 14:57:00 - open 10:00:00 to 18:00:00 - SELECTED
- Mahabalipuram - priority 4 - attempted 15:51:00 to 16:21:00 - open 00:00:00 to 23:59:59 - SELECTED
- Mahabalipuram - priority 2 - attempted 13:37:00 to 15:07:00 - closes at --:-- - REJECTED

## Mixed-Chennai-Tirupati-Hyderabad-Mahabalipuram :: Run 2 :: DVI202604217

### Day-wise Breakdown
| Day | Source | Destination | Selected | Rejected | Deferred |
|---:|---|---|---:|---:|---:|
| 1 | Chennai | Tirupati | 11 | 13 | 0 |
| 3 | Hyderabad | Hyderabad | 7 | 43 | 2 |
| 4 | Hyderabad | Mahabalipuram | 5 | 19 | 2 |
| 5 | Mahabalipuram | Chennai | 3 | 1 | 0 |
| 6 | Chennai | Chennai | 1 | 23 | 0 |

### Client-Ready Examples (Real Hotspots Only)
- Mahabalipuram - priority 1 - attempted 09:04:00 to 13:04:00 - open 06:00:00 to 18:00:00 - SELECTED
- Mahabalipuram - priority 3 - attempted 13:57:00 to 14:57:00 - open 10:00:00 to 18:00:00 - SELECTED
- Mahabalipuram - priority 4 - attempted 15:51:00 to 16:21:00 - open 00:00:00 to 23:59:59 - SELECTED
- Mahabalipuram - priority 2 - attempted 13:37:00 to 15:07:00 - closes at --:-- - REJECTED

## Artifact Files
- JSON: C:\wamp64\www\dvi_fullstack\api.dvi.travel\verification-e2e\automation\artifacts\client-decision-report-1775807514847.json
- CSV: C:\wamp64\www\dvi_fullstack\api.dvi.travel\verification-e2e\automation\artifacts\client-decision-report-matrix-1775807514847.csv
- Markdown: C:\wamp64\www\dvi_fullstack\api.dvi.travel\verification-e2e\automation\artifacts\client-decision-report-1775807514847.md
