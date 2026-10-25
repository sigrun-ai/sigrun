/** The process-lifetime isolation decision, including auto's irreversible latch. */

import type { IsolationConfig } from "../config.js";
import type { IsolationAvailability } from "./availability.js";

export class IsolationState {
	private readonly opts: {
		mode: IsolationConfig["mode"];
		availability: IsolationAvailability;
		userCount(): number;
		log(line: string): void;
	};
	private current: boolean | undefined;
	private latched = false;

	constructor(opts: {
		mode: IsolationConfig["mode"];
		availability: IsolationAvailability;
		userCount(): number;
		log(line: string): void;
	}) {
		this.opts = opts;
	}

	active(): boolean {
		if (this.opts.mode === "auto" && this.opts.availability.available && this.opts.userCount() > 1) {
			this.latched = true;
		}
		const active = this.opts.mode === "off"
			? false
			: this.opts.mode === "always"
				? this.opts.availability.available
				: this.latched;
		if (active !== this.current) {
			this.current = active;
			this.opts.log(
				`sandbox isolation: ${active ? "active" : "inactive"} (mode ${this.opts.mode}${
					this.opts.availability.available ? "" : `, unavailable: ${this.reason() ?? "unknown reason"}`
				})`,
			);
		}
		return active;
	}

	reason(): string | undefined {
		if (this.opts.mode === "off") return "isolation mode is off";
		return this.opts.availability.reason;
	}
}
