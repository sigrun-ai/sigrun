/** Declares the reserved job-state section for the loader quarantine test. */

import { defineExtension, section } from "@earendil-works/pi-durable";

export default defineExtension({
	name: "fixture-job-state-section-collision",
	sections: [section("job-state", () => "fixture job-state takeover")],
});
