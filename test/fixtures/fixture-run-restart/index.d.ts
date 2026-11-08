import type { ConversationId, SubmissionId } from "@earendil-works/pi-durable";

export interface RunRestartRecord {
	readonly conversationId: ConversationId;
	readonly inputs: SubmissionId[];
	readonly inputTexts: string[];
	readonly replayed: boolean;
	readonly outcome: "answered" | "unanswered";
}

export declare const events: RunRestartRecord[];
export declare const blocked: boolean;
export declare const entered: number;
export declare function resetRunRestartFixture(): void;
export declare function blockRunSettled(): void;
export declare function waitForBlockedRunSettled(): Promise<void>;
export declare function releaseRunSettled(): void;

declare function createRunRestartFixture(): unknown;
export default createRunRestartFixture;
