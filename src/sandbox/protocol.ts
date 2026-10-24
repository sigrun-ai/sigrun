/** The newline-delimited JSON wire shared by the worker and its client. */

import {
	ExecutionError,
	FileError,
	type ShellOutputSkip,
	type WatchChange,
} from "@earendil-works/pi-durable/env";

export type DecodedValue =
	| null
	| boolean
	| number
	| string
	| Uint8Array
	| { $handle: number }
	| DecodedValue[]
	| { [key: string]: DecodedValue };

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

export type Request = { id: number; op: string; args: JsonValue[] };
export type WireError = {
	kind: "file" | "exec";
	code: string;
	message: string;
	path?: string;
};
export type Reply =
	| { id: number; ok: true; value: JsonValue }
	| { id: number; ok: false; error: WireError };
export type Event =
	| {
			id: number;
			event: "output";
			stream: "stdout" | "stderr";
			text: string;
			skipped?: ShellOutputSkip;
	  }
	| {
			id: number;
			event: "watch";
			change: JsonValue;
	  }
	| {
			id: number;
			event: "command";
			pid: number;
			phase: "start" | "end";
	  };
export type Message = Reply | Event;

/** Encode binary without ambiguity; undefined void results become null. */
export function encodeValue(value: unknown): JsonValue {
	if (value === undefined || value === null) return null;
	if (value instanceof Uint8Array) {
		return { $bytes: Buffer.from(value).toString("base64") };
	}
	if (typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("non-finite number on sandbox wire");
		return value;
	}
	if (Array.isArray(value)) return value.map(encodeValue);
	if (typeof value === "object") {
		const result: Record<string, JsonValue> = {};
		for (const [key, item] of Object.entries(value)) {
			if (item !== undefined) result[key] = encodeValue(item);
		}
		return result;
	}
	throw new TypeError(`unsupported sandbox wire value: ${typeof value}`);
}

/** Decode binary; handle sentinels remain plain objects for the client to own. */
export function decodeValue(value: JsonValue): DecodedValue {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(decodeValue);
	if ("$bytes" in value) {
		if (Object.keys(value).length !== 1 || typeof value.$bytes !== "string") {
			throw new TypeError("invalid $bytes value on sandbox wire");
		}
		return new Uint8Array(Buffer.from(value.$bytes, "base64"));
	}
	if ("$handle" in value) {
		if (
			Object.keys(value).length !== 1 ||
			typeof value.$handle !== "number" ||
			!Number.isSafeInteger(value.$handle) ||
			value.$handle <= 0
		) {
			throw new TypeError("invalid $handle value on sandbox wire");
		}
		return value;
	}
	const result: Record<string, DecodedValue> = {};
	for (const [key, item] of Object.entries(value)) result[key] = decodeValue(item);
	return result;
}

export function encodeMessage(message: Request | Message): string {
	return `${JSON.stringify(encodeValue(message))}\n`;
}

export function decodeMessage(line: string): Message {
	const value: unknown = JSON.parse(line);
	if (typeof value !== "object" || value === null || !("id" in value)) {
		throw new TypeError("invalid sandbox message");
	}
	const id = value.id;
	if (typeof id !== "number" || !Number.isSafeInteger(id)) {
		throw new TypeError("invalid sandbox message id");
	}
	if ("event" in value) {
		if (value.event === "output") {
			// SAFETY: the id was checked above; stream and text are checked below.
			const event = value as unknown as Event & { event: "output" };
			if (
				(event.stream !== "stdout" && event.stream !== "stderr") ||
				typeof event.text !== "string"
			) {
				throw new TypeError("invalid sandbox output event");
			}
			return event;
		}
		if (value.event === "command" && "pid" in value && typeof value.pid === "number" &&
			"phase" in value && (value.phase === "start" || value.phase === "end")) {
			// SAFETY: id, numeric pid and the two command phases were checked.
			return value as unknown as Event;
		}
		if (value.event === "watch" && "change" in value) {
			// SAFETY: id, event and change presence were checked above.
			return value as unknown as Event;
		}
		throw new TypeError("invalid sandbox event");
	}
	if (!("ok" in value) || typeof value.ok !== "boolean") {
		throw new TypeError("invalid sandbox reply");
	}
	if (value.ok) {
		if (!("value" in value)) throw new TypeError("sandbox reply has no value");
		// SAFETY: id, ok and value presence were checked above.
		return value as unknown as Reply;
	}
	if (!("error" in value)) throw new TypeError("sandbox failure has no error");
	const error = value.error as Partial<WireError>;
	if (
		(error.kind !== "file" && error.kind !== "exec") ||
		typeof error.code !== "string" ||
		typeof error.message !== "string" ||
		(error.path !== undefined && typeof error.path !== "string")
	) {
		throw new TypeError("invalid sandbox error");
	}
	// SAFETY: id, ok=false and every required error field were checked above.
	return value as unknown as Reply;
}

export function wireError(error: unknown, fallbackKind: "file" | "exec" = "file"): WireError {
	if (error instanceof FileError) {
		return {
			kind: "file",
			code: error.code,
			message: error.message,
			...(error.path === undefined ? {} : { path: error.path }),
		};
	}
	if (error instanceof ExecutionError) {
		return { kind: "exec", code: error.code, message: error.message };
	}
	const message = error instanceof Error ? error.message : String(error);
	return { kind: fallbackKind, code: fallbackKind === "exec" ? "unknown" : "invalid", message };
}

export function errorReply(
	id: number,
	error: unknown,
	fallbackKind: "file" | "exec" = "file",
): Reply {
	return { id, ok: false, error: wireError(error, fallbackKind) };
}

export function decodeError(error: WireError): FileError | ExecutionError {
	return error.kind === "file"
		? new FileError(
				error.code as ConstructorParameters<typeof FileError>[0],
				error.message,
				error.path,
			)
		: new ExecutionError(
				error.code as ConstructorParameters<typeof ExecutionError>[0],
				error.message,
			);
}

export function decodeWatchChange(value: DecodedValue): WatchChange {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError("invalid watcher change");
	}
	if ("error" in value) {
		const candidate = value.error;
		if (
			typeof candidate !== "object" ||
			candidate === null ||
			Array.isArray(candidate) ||
			candidate instanceof Uint8Array ||
			"$handle" in candidate
		) {
			throw new TypeError("invalid watcher error");
		}
		const kind = candidate.kind;
		const code = candidate.code;
		const message = candidate.message;
		const path = candidate.path;
		if (
			kind !== "file" ||
			typeof code !== "string" ||
			typeof message !== "string" ||
			(path !== undefined && typeof path !== "string")
		) {
			throw new TypeError("invalid watcher error");
		}
		return {
			error: new FileError(code as ConstructorParameters<typeof FileError>[0], message, path),
		};
	}
	if ("overflow" in value && value.overflow === true) return { overflow: true };
	if (
		"paths" in value &&
		Array.isArray(value.paths) &&
		value.paths.every((path) => typeof path === "string")
	) {
		return { paths: value.paths };
	}
	throw new TypeError("invalid watcher change");
}
