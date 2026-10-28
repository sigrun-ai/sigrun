/** Test-only provider: the prompt carries a deterministic tool script. */

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

const faux = fauxProvider({ provider: "boundary", models: [{ id: "m", contextWindow: 128_000 }] });

function userText(context) {
	const input = context.messages.findLast((message) => message.role === "user");
	if (typeof input?.content === "string") return input.content;
	return input?.content.filter((part) => part.type === "text").map((part) => part.text).join("") ?? "";
}

// The queue is process-wide while conversations are per-conversation:
// each conversation's tool round shifts TWO entries (tool call, final
// text), so the provider re-arms itself after every scripted answer.
const scriptedToolCall = (context) => {
	const script = JSON.parse(userText(context));
	return fauxAssistantMessage(
		script.calls.map((call) => fauxToolCall(call.name, call.args, { id: call.id })),
		{ stopReason: "toolUse" },
	);
};
const rearm = () => {
	faux.appendResponses([
		scriptedToolCall,
		(context) => {
			rearm();
			return fauxAssistantMessage("boundary turn complete");
		},
	]);
};
rearm();

export default function createBoundaryProvider() {
	return { name: "boundary-faux", providers: [{ provider: faux.provider }] };
}
