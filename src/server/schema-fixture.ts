/**
 * The captured-schema fixture (spec §5 "Captured schema", Task 9a Step 1).
 *
 * The §5 server serializes pi-durable's native `ConversationView` verbatim —
 * there is no sigrun-side projection — so the wire contract sigrun's clients
 * (webui) compile against is exactly upstream's view shape. Upstream churn
 * must surface as a TEST FAILURE, not a runtime surprise: the shape of a real
 * `ConversationView` (keys + value types, never literal values) is captured
 * into {@link VIEW_SCHEMA} (mirrored into `test/fixtures/view-schema.json`;
 * the drift test asserts the two are the same value) and
 * `test/schema-drift.test.ts` re-captures a live hermetic view and asserts it
 * still matches.
 *
 * `GET /v1/meta` serves {@link SCHEMA_VERSION} — the sha256 of the fixture's
 * canonical JSON — so a webui can refuse to render on mismatch (fail loud).
 * The hash is computed from {@link VIEW_SCHEMA} at module load, never stored:
 * the constant and the hash cannot drift apart.
 *
 * The fixture is captured from ONE deterministic hermetic scenario (root
 * conversation, one settled faux turn) with a fixed provider/model id
 * (`faux/m`): shape keys that are dictionaries keyed by dynamic names
 * (`docs["pi.usage"].models`) therefore appear literally. The drift test
 * replays exactly that scenario. Shape variants that the scenario does not
 * exercise (tool-call entries, compaction summaries, busy inboxes) are out of
 * fixture scope; drift on the shared structures (EntryRecord base fields,
 * Message, the built-in docs) still trips the wire.
 */

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { ConversationView } from "@earendil-works/pi-durable";

/**
 * The pinned pi-durable package version, reported as `GET /v1/meta`
 * `harnessVersion`. Read from the installed package's manifest through
 * `createRequire` (a bundler-stable CJS require of the exported
 * `./package.json` subpath), so a dependency bump moves it without a source
 * edit — the fixture and this version both follow the pin.
 */
export const HARNESS_VERSION: string = createRequire(import.meta.url)(
	"@earendil-works/pi-durable/package.json",
).version as string;

/**
 * The SERVER's own version (the sigrun package manifest) — surfaced by
 * `/v1/meta` and the boot log so an operator quotes what they run in a
 * bug report. Same bundler-stable createRequire shape as
 * {@link HARNESS_VERSION}.
 */
export const SIGRUN_VERSION: string = createRequire(import.meta.url)(
	"../../package.json",
).version as string;

/** One leaf or node of a structural snapshot: value TYPES, never values. */
export type Shape =
	| { readonly kind: "null" }
	| { readonly kind: "boolean" }
	| { readonly kind: "number" }
	| { readonly kind: "string" }
	| {
			readonly kind: "array";
			/** The distinct element shapes observed, in canonical order. */
			readonly variants: readonly Shape[];
	  }
	| {
			readonly kind: "object";
			/** Present fields only; absence is per observed variant. */
			readonly fields: Readonly<Record<string, Shape>>;
	  };

const NULL: Shape = { kind: "null" };
const BOOLEAN: Shape = { kind: "boolean" };
const NUMBER: Shape = { kind: "number" };
const STRING: Shape = { kind: "string" };

/** Canonical JSON of a shape: object keys sorted at every depth. */
export function canonicalJson(shape: Shape): string {
	// The projection keeps the `kind` discriminators, so `JSON.parse` of the
	// result is the same Shape again (round-trip safe — dedupe and hashing
	// below rely on that).
	const project = (value: Shape): unknown => {
		switch (value.kind) {
			case "array":
				// Variants are already canonically ordered (see mergeVariants).
				return { kind: "array", variants: value.variants.map(project) };
			case "object": {
				const fields: Record<string, unknown> = {};
				for (const key of Object.keys(value.fields).sort()) {
					fields[key] = project(value.fields[key] as Shape);
				}
				return { kind: "object", fields };
			}
			default:
				return value;
		}
	};
	return JSON.stringify(project(shape));
}

function shapeOfValue(value: unknown): Shape {
	if (value === null) return NULL;
	switch (typeof value) {
		case "boolean":
			return BOOLEAN;
		case "number":
			return NUMBER;
		case "string":
			return STRING;
		case "object":
			if (Array.isArray(value)) {
				return { kind: "array", variants: mergeVariants(value.map(shapeOfValue)) };
			}
			const fields: Record<string, Shape> = {};
			for (const [key, entry] of Object.entries(value)) {
				if (entry !== undefined) fields[key] = shapeOfValue(entry);
			}
			return { kind: "object", fields };
		default:
			throw new Error(
				`ConversationView contains a non-JSON value of type ${typeof value}`,
			);
	}
}

/** Distinct shapes, deduped by canonical JSON and ordered by it. */
function mergeVariants(shapes: readonly Shape[]): Shape[] {
	const distinct = new Map<string, Shape>();
	for (const shape of shapes) {
		const key = canonicalJson(shape);
		if (!distinct.has(key)) distinct.set(key, shape);
	}
	return [...distinct.entries()]
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([, shape]) => shape);
}

/**
 * Serialize one live `ConversationView` into its structural shape.
 *
 * Arrays record the SET of distinct element shapes (not one merged shape), so
 * heterogeneous arrays — `entries` (pi.user / pi.system / pi.assistant),
 * `model` (user / system / assistant messages) — keep per-variant field
 * presence, and a field moving between variants or appearing anew fails the
 * fixture match instead of being averaged away.
 */
export function captureViewShape(view: ConversationView): Shape {
	return shapeOfValue(view as unknown as JsonRecord);
}

type JsonRecord = { readonly [key: string]: unknown };

/** sha256 hex of a string. */
function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * The captured fixture: the shape of a real root-conversation `ConversationView`
 * after one settled turn, captured from the pinned `@earendil-works/pi-durable`
 * (see `test/fixtures/view-schema.json` — the same value as a committed file,
 * and `test/schema-drift.test.ts` fails if the two ever diverge).
 */
export const VIEW_SCHEMA: Shape = {
	"kind": "object",
	"fields": {
		"conversation": {
			"kind": "object",
			"fields": {
				"id": {
					"kind": "number"
				}
			}
		},
		"entries": {
			"kind": "array",
			"variants": [
				{
					"kind": "object",
					"fields": {
						"model": {
							"kind": "array",
							"variants": [
								{
									"kind": "object",
									"fields": {
										"role": {
											"kind": "string"
										},
										"content": {
											"kind": "array",
											"variants": [
												{
													"kind": "object",
													"fields": {
														"type": {
															"kind": "string"
														},
														"text": {
															"kind": "string"
														}
													}
												}
											]
										},
										"api": {
											"kind": "string"
										},
										"provider": {
											"kind": "string"
										},
										"model": {
											"kind": "string"
										},
										"usage": {
											"kind": "object",
											"fields": {
												"input": {
													"kind": "number"
												},
												"output": {
													"kind": "number"
												},
												"cacheRead": {
													"kind": "number"
												},
												"cacheWrite": {
													"kind": "number"
												},
												"totalTokens": {
													"kind": "number"
												},
												"cost": {
													"kind": "object",
													"fields": {
														"input": {
															"kind": "number"
														},
														"output": {
															"kind": "number"
														},
														"cacheRead": {
															"kind": "number"
														},
														"cacheWrite": {
															"kind": "number"
														},
														"total": {
															"kind": "number"
														}
													}
												}
											}
										},
										"stopReason": {
											"kind": "string"
										},
										"timestamp": {
											"kind": "number"
										}
									}
								}
							]
						},
						"kind": {
							"kind": "string"
						},
						"id": {
							"kind": "number"
						},
						"conversationId": {
							"kind": "number"
						},
						"byTaskId": {
							"kind": "number"
						}
					}
				},
				{
					"kind": "object",
					"fields": {
						"model": {
							"kind": "array",
							"variants": [
								{
									"kind": "object",
									"fields": {
										"role": {
											"kind": "string"
										},
										"content": {
											"kind": "string"
										},
										"sections": {
											"kind": "object",
											"fields": {
												"identity": {
													"kind": "string"
												},
												"persona": {
													"kind": "string"
												},
												"codemode": {
													"kind": "string"
												},
												"long-term-memory": {
													"kind": "string"
												}
											}
										},
										"toolsAdded": {
											"kind": "array",
											"variants": [
												{
													"kind": "object",
													"fields": {
														"name": {
															"kind": "string"
														},
														"description": {
															"kind": "string"
														},
														"parameters": {
															"kind": "object",
															"fields": {
																"type": {
																	"kind": "string"
																},
																"required": {
																	"kind": "array",
																	"variants": [
																		{
																			"kind": "string"
																		}
																	]
																},
																"properties": {
																	"kind": "object",
																	"fields": {
																		"code": {
																			"kind": "object",
																			"fields": {
																				"type": {
																					"kind": "string"
																				},
																				"description": {
																					"kind": "string"
																				}
																			}
																		}
																	}
																}
															}
														},
														"constrainedSampling": {
															"kind": "object",
															"fields": {
																"type": {
																	"kind": "string"
																},
																"variants": {
																	"kind": "object",
																	"fields": {
																		"openai_lark": {
																			"kind": "string"
																		}
																	}
																}
															}
														}
													}
												},
												{
													"kind": "object",
													"fields": {
														"name": {
															"kind": "string"
														},
														"description": {
															"kind": "string"
														},
														"parameters": {
															"kind": "object",
															"fields": {
																"type": {
																	"kind": "string"
																},
																"required": {
																	"kind": "array",
																	"variants": [
																		{
																			"kind": "string"
																		}
																	]
																},
																"properties": {
																	"kind": "object",
																	"fields": {
																		"command": {
																			"kind": "object",
																			"fields": {
																				"type": {
																					"kind": "string"
																				},
																				"description": {
																					"kind": "string"
																				}
																			}
																		},
																		"timeout": {
																			"kind": "object",
																			"fields": {
																				"type": {
																					"kind": "string"
																				},
																				"description": {
																					"kind": "string"
																				}
																			}
																		}
																	}
																}
															}
														}
													}
												},
												{
													"kind": "object",
													"fields": {
														"name": {
															"kind": "string"
														},
														"description": {
															"kind": "string"
														},
														"parameters": {
															"kind": "object",
															"fields": {
																"type": {
																	"kind": "string"
																},
																"required": {
																	"kind": "array",
																	"variants": [
																		{
																			"kind": "string"
																		}
																	]
																},
																"properties": {
																	"kind": "object",
																	"fields": {
																		"path": {
																			"kind": "object",
																			"fields": {
																				"type": {
																					"kind": "string"
																				},
																				"description": {
																					"kind": "string"
																				}
																			}
																		},
																		"content": {
																			"kind": "object",
																			"fields": {
																				"type": {
																					"kind": "string"
																				},
																				"description": {
																					"kind": "string"
																				}
																			}
																		}
																	}
																}
															}
														}
													}
												},
												{
													"kind": "object",
													"fields": {
														"name": {
															"kind": "string"
														},
														"description": {
															"kind": "string"
														},
														"parameters": {
															"kind": "object",
															"fields": {
																"type": {
																	"kind": "string"
																},
																"required": {
																	"kind": "array",
																	"variants": [
																		{
																			"kind": "string"
																		}
																	]
																},
																"properties": {
																	"kind": "object",
																	"fields": {
																		"title": {
																			"kind": "object",
																			"fields": {
																				"type": {
																					"kind": "string"
																				},
																				"description": {
																					"kind": "string"
																				}
																			}
																		},
																		"tree": {
																			"kind": "object",
																			"fields": {
																				"description": {
																					"kind": "string"
																				}
																			}
																		},
																		"data": {
																			"kind": "object",
																			"fields": {
																				"description": {
																					"kind": "string"
																				}
																			}
																		}
																	}
																}
															}
														}
													}
												},
												{
													"kind": "object",
													"fields": {
														"name": {
															"kind": "string"
														},
														"description": {
															"kind": "string"
														},
														"parameters": {
															"kind": "object",
															"fields": {
																"type": {
																	"kind": "string"
																},
																"required": {
																	"kind": "array",
																	"variants": [
																		{
																			"kind": "string"
																		}
																	]
																},
																"properties": {
																	"kind": "object",
																	"fields": {
																		"path": {
																			"kind": "object",
																			"fields": {
																				"type": {
																					"kind": "string"
																				},
																				"description": {
																					"kind": "string"
																				}
																			}
																		},
																		"edits": {
																			"kind": "object",
																			"fields": {
																				"type": {
																					"kind": "string"
																				},
																				"items": {
																					"kind": "object",
																					"fields": {
																						"type": {
																							"kind": "string"
																						},
																						"required": {
																							"kind": "array",
																							"variants": [
																								{
																									"kind": "string"
																								}
																							]
																						},
																						"properties": {
																							"kind": "object",
																							"fields": {
																								"oldText": {
																									"kind": "object",
																									"fields": {
																										"type": {
																											"kind": "string"
																										},
																										"description": {
																											"kind": "string"
																										}
																									}
																								},
																								"newText": {
																									"kind": "object",
																									"fields": {
																										"type": {
																											"kind": "string"
																										},
																										"description": {
																											"kind": "string"
																										}
																									}
																								}
																							}
																						}
																					}
																				},
																				"description": {
																					"kind": "string"
																				}
																			}
																		}
																	}
																}
															}
														}
													}
												},
												{
													"kind": "object",
													"fields": {
														"name": {
															"kind": "string"
														},
														"description": {
															"kind": "string"
														},
														"parameters": {
															"kind": "object",
															"fields": {
																"type": {
																	"kind": "string"
																},
																"required": {
																	"kind": "array",
																	"variants": [
																		{
																			"kind": "string"
																		}
																	]
																},
																"properties": {
																	"kind": "object",
																	"fields": {
																		"entryId": {
																			"kind": "object",
																			"fields": {
																				"type": {
																					"kind": "string"
																				},
																				"description": {
																					"kind": "string"
																				}
																			}
																		},
																		"ops": {
																			"kind": "object",
																			"fields": {
																				"type": {
																					"kind": "string"
																				},
																				"items": {
																					"kind": "object",
																					"fields": {}
																				},
																				"description": {
																					"kind": "string"
																				}
																			}
																		}
																	}
																}
															}
														}
													}
												},
												{
													"kind": "object",
													"fields": {
														"name": {
															"kind": "string"
														},
														"description": {
															"kind": "string"
														},
														"parameters": {
															"kind": "object",
															"fields": {
																"type": {
																	"kind": "string"
																},
																"required": {
																	"kind": "array",
																	"variants": [
																		{
																			"kind": "string"
																		}
																	]
																},
																"properties": {
																	"kind": "object",
																	"fields": {
																		"path": {
																			"kind": "object",
																			"fields": {
																				"type": {
																					"kind": "string"
																				},
																				"description": {
																					"kind": "string"
																				}
																			}
																		},
																		"offset": {
																			"kind": "object",
																			"fields": {
																				"type": {
																					"kind": "string"
																				},
																				"description": {
																					"kind": "string"
																				}
																			}
																		},
																		"limit": {
																			"kind": "object",
																			"fields": {
																				"type": {
																					"kind": "string"
																				},
																				"description": {
																					"kind": "string"
																				}
																			}
																		}
																	}
																}
															}
														}
													}
												},
												{
													"kind": "object",
													"fields": {
														"name": {
															"kind": "string"
														},
														"description": {
															"kind": "string"
														},
														"parameters": {
															"kind": "object",
															"fields": {
																"type": {
																	"kind": "string"
																},
																"required": {
																	"kind": "array",
																	"variants": [
																		{
																			"kind": "string"
																		}
																	]
																},
																"properties": {
																	"kind": "object",
																	"fields": {
																		"query": {
																			"kind": "object",
																			"fields": {
																				"type": {
																					"kind": "string"
																				},
																				"description": {
																					"kind": "string"
																				}
																			}
																		},
																		"limit": {
																			"kind": "object",
																			"fields": {
																				"type": {
																					"kind": "string"
																				},
																				"description": {
																					"kind": "string"
																				}
																			}
																		}
																	}
																}
															}
														}
													}
												},
												{
													"kind": "object",
													"fields": {
														"name": {
															"kind": "string"
														},
														"description": {
															"kind": "string"
														},
														"parameters": {
															"kind": "object",
															"fields": {
																"type": {
																	"kind": "string"
																},
																"required": {
																	"kind": "array",
																	"variants": [
																		{
																			"kind": "string"
																		}
																	]
																},
																"properties": {
																	"kind": "object",
																	"fields": {
																		"name": {
																			"kind": "object",
																			"fields": {
																				"type": {
																					"kind": "string"
																				},
																				"description": {
																					"kind": "string"
																				}
																			}
																		}
																	}
																}
															}
														}
													}
												},
												{
													"kind": "object",
													"fields": {
														"name": {
															"kind": "string"
														},
														"description": {
															"kind": "string"
														},
														"parameters": {
															"kind": "object",
															"fields": {
																"type": {
																	"kind": "string"
																},
																"required": {
																	"kind": "array",
																	"variants": [
																		{
																			"kind": "string"
																		}
																	]
																},
																"properties": {
																	"kind": "object",
																	"fields": {
																		"pattern": {
																			"kind": "object",
																			"fields": {
																				"type": {
																					"kind": "string"
																				},
																				"description": {
																					"kind": "string"
																				}
																			}
																		},
																		"path": {
																			"kind": "object",
																			"fields": {
																				"type": {
																					"kind": "string"
																				},
																				"description": {
																					"kind": "string"
																				}
																			}
																		}
																	}
																}
															}
														}
													}
												},
												{
													"kind": "object",
													"fields": {
														"name": {
															"kind": "string"
														},
														"description": {
															"kind": "string"
														},
														"parameters": {
															"kind": "object",
															"fields": {
																"type": {
																	"kind": "string"
																},
																"properties": {
																	"kind": "object",
																	"fields": {
																		"path": {
																			"kind": "object",
																			"fields": {
																				"type": {
																					"kind": "string"
																				},
																				"description": {
																					"kind": "string"
																				}
																			}
																		}
																	}
																}
															}
														}
													}
												}
											]
										},
										"timestamp": {
											"kind": "number"
										}
									}
								}
							]
						},
						"kind": {
							"kind": "string"
						},
						"id": {
							"kind": "number"
						},
						"conversationId": {
							"kind": "number"
						},
						"byTaskId": {
							"kind": "number"
						}
					}
				},
				{
					"kind": "object",
					"fields": {
						"model": {
							"kind": "array",
							"variants": [
								{
									"kind": "object",
									"fields": {
										"role": {
											"kind": "string"
										},
										"content": {
											"kind": "string"
										},
										"timestamp": {
											"kind": "number"
										}
									}
								}
							]
						},
						"kind": {
							"kind": "string"
						},
						"id": {
							"kind": "number"
						},
						"conversationId": {
							"kind": "number"
						}
					}
				}
			]
		},
		"docs": {
			"kind": "object",
			"fields": {
				"pi.agent": {
					"kind": "object",
					"fields": {
						"model": {
							"kind": "object",
							"fields": {
								"provider": {
									"kind": "string"
								},
								"modelId": {
									"kind": "string"
								}
							}
						}
					}
				},
				"pi.live": {
					"kind": "object",
					"fields": {}
				},
				"pi.inbox": {
					"kind": "object",
					"fields": {
						"items": {
							"kind": "array",
							"variants": []
						}
					}
				},
				"pi.provider": {
					"kind": "object",
					"fields": {
						"sessionId": {
							"kind": "string"
						}
					}
				},
				"pi.usage": {
					"kind": "object",
					"fields": {
						"models": {
							"kind": "object",
							"fields": {
								"faux/m": {
									"kind": "object",
									"fields": {
										"input": {
											"kind": "number"
										},
										"output": {
											"kind": "number"
										},
										"cacheRead": {
											"kind": "number"
										},
										"cacheWrite": {
											"kind": "number"
										},
										"totalTokens": {
											"kind": "number"
										},
										"cost": {
											"kind": "object",
											"fields": {
												"input": {
													"kind": "number"
												},
												"output": {
													"kind": "number"
												},
												"cacheRead": {
													"kind": "number"
												},
												"cacheWrite": {
													"kind": "number"
												},
												"total": {
													"kind": "number"
												}
											}
										}
									}
								}
							}
						},
						"tools": {
							"kind": "object",
							"fields": {}
						}
					}
				}
			}
		}
	}
};

/**
 * The fixture's schema version: sha256 of {@link VIEW_SCHEMA}'s canonical
 * JSON. Upstream drift that changes any captured key or value type changes
 * the fixture, which changes this hash — `GET /v1/meta` serves it and the
 * webui refuses to render on string inequality (fail loud, spec §5).
 */
export const SCHEMA_VERSION: string = sha256(canonicalJson(VIEW_SCHEMA));
