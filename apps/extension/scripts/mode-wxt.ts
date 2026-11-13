import { spawnSync } from "node:child_process";

/**
 * Run WXT in a named build mode: `bun scripts/mode-wxt.ts store build`.
 *
 * The mode is set here, in the package script, so a repository .env can never
 * turn a public build into another kind of artifact.
 */
const MODES = ["public", "private", "store"];
const COMMANDS = ["build", "zip"];

const [mode, command, ...args] = process.argv.slice(2);
if (!mode || !MODES.includes(mode) || !command || !COMMANDS.includes(command)) {
	throw new Error(`Use mode-wxt.ts with ${MODES.join(", ")} and ${COMMANDS.join(" or ")}`);
}

const result = spawnSync(process.execPath, ["run", "wxt", command, ...args], {
	stdio: "inherit",
	env: {
		...process.env,
		ANANSI_EXTENSION_BUILD_MODE: mode,
	},
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
