/**
 * The tab model (tabs+skills Task 1): every web UI view is a TAB. The
 * rail renders one tab per view; each tab remembers the route it was
 * last seen on (sessionStorage, key `sigrun.tabs`) so switching back
 * lands where the user left off. Pure — the App wires it to the hash
 * router.
 */

import { describe, expect, test } from "vitest";
import { parseHash, routeHash } from "../App";
import { stubSessionStorage } from "../test-utils";
import { TAB_MEMORY_KEY, TabMemory, tabOfRoute } from "./tabs";

describe("tab routes", () => {
	test("parseHash parses #/c/<id> into a chat route carrying the conversation id", () => {
		expect(parseHash("#/c")).toEqual({ kind: "chat" });
		expect(parseHash("#/c/12")).toEqual({ kind: "chat", conversationId: 12 });
		// A non-numeric id segment is garbage → the plain chat default.
		expect(parseHash("#/c/abc")).toEqual({ kind: "chat" });
		expect(parseHash("#/c/")).toEqual({ kind: "chat" });
	});

	test("routeHash serializes the conversation id", () => {
		expect(routeHash({ kind: "chat" })).toBe("#/c");
		expect(routeHash({ kind: "chat", conversationId: 12 })).toBe("#/c/12");
	});

	test("tabOfRoute maps every route kind to its tab", () => {
		expect(tabOfRoute({ kind: "chat" })).toBe("chats");
		expect(tabOfRoute({ kind: "chat", conversationId: 3 })).toBe("chats");
		expect(tabOfRoute({ kind: "settings" })).toBe("settings");
		expect(tabOfRoute({ kind: "settings", section: "interface" })).toBe(
			"settings",
		);
		// Core views are ext routes on the `core` slug; skills and jobs are
		// their own tabs, any other core view maps like an ext view.
		expect(
			tabOfRoute({ kind: "ext", slug: "core", id: "skills", params: {} }),
		).toBe("skills");
		expect(
			tabOfRoute({ kind: "ext", slug: "core", id: "jobs", params: {} }),
		).toBe("jobs");
		expect(
			tabOfRoute({ kind: "ext", slug: "core", id: "escalations", params: {} }),
		).toBe("ext:core/escalations");
		// The parsed forms agree (the hash IS the route).
		expect(tabOfRoute(parseHash("#/ext/core/skills"))).toBe("skills");
		expect(tabOfRoute(parseHash("#/ext/curator/curator"))).toBe(
			"ext:curator/curator",
		);
	});
});

describe("TabMemory", () => {
	test("routeFor returns each tab's default hash before any remember", () => {
		stubSessionStorage();
		const memory = new TabMemory();
		expect(memory.routeFor("chats")).toBe("#/c");
		expect(memory.routeFor("skills")).toBe("#/ext/core/skills");
		expect(memory.routeFor("jobs")).toBe("#/ext/core/jobs");
		expect(memory.routeFor("settings")).toBe("#/settings");
		expect(memory.routeFor("ext:curator/curator")).toBe(
			"#/ext/curator/curator",
		);
	});

	test("the remembered hash wins once recorded, and the store mirrors to sessionStorage", () => {
		const storage = stubSessionStorage();
		const memory = new TabMemory();
		const skillsHash = `#/ext/core/skills?params=${encodeURIComponent('{"skill":"acme-deploy"}')}`;
		memory.remember("skills", skillsHash);
		memory.remember("chats", "#/c/2");
		expect(memory.routeFor("skills")).toBe(skillsHash);
		expect(memory.routeFor("chats")).toBe("#/c/2");
		// The mirror: a fresh instance over the same store rehydrates.
		const mirrored = storage.getItem(TAB_MEMORY_KEY);
		expect(mirrored).not.toBeNull();
		expect(JSON.parse(mirrored as string)).toEqual({
			skills: skillsHash,
			chats: "#/c/2",
		});
		expect(new TabMemory().routeFor("skills")).toBe(skillsHash);
		// Untouched tabs keep their defaults.
		expect(new TabMemory().routeFor("settings")).toBe("#/settings");
	});

	test("a missing or garbage store never breaks the defaults", () => {
		const storage = stubSessionStorage();
		storage.setItem(TAB_MEMORY_KEY, "not json");
		const memory = new TabMemory();
		expect(memory.routeFor("skills")).toBe("#/ext/core/skills");
		storage.setItem(TAB_MEMORY_KEY, '["array"]');
		expect(new TabMemory().routeFor("chats")).toBe("#/c");
	});
});
