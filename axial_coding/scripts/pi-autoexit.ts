/**
 * Auto-exit for code.py jobs.
 *
 * code.py opens pi's normal UI for each coding job and waits for pi to exit before starting the
 * next one. This extension quits pi once the agent has settled AND every output file the job must
 * produce exists (paths in CODING_JOB_OUTPUTS, separated by the OS path delimiter). If an output
 * is missing, pi stays open so you can intervene; quit it yourself to continue.
 */

import { existsSync } from "node:fs";
import { delimiter } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GRACE_MS = 3000; // time to see the final reply before pi closes

export default function (pi: ExtensionAPI) {
	const outputs = (process.env.CODING_JOB_OUTPUTS ?? "").split(delimiter).filter(Boolean);

	pi.on("agent_settled", async (_event, ctx) => {
		const missing = outputs.filter((p) => !existsSync(p));
		if (missing.length > 0) {
			ctx.ui.notify(`Job outputs missing: ${missing.join(", ")}. Continue the chat, or quit pi to move on.`, "warning");
			return;
		}
		ctx.ui.notify(`Job finished; closing pi in ${GRACE_MS / 1000}s…`, "info");
		await new Promise((resolve) => setTimeout(resolve, GRACE_MS));
		ctx.shutdown();
	});
}
