import { spawnSync } from "node:child_process";

const [command, ...args] = process.argv.slice(2);
if (!command || !["dev", "build", "zip"].includes(command)) {
	throw new Error("Use private-wxt.ts with dev, build, or zip");
}

const result = spawnSync(process.execPath, ["run", "wxt", command, ...args], {
	stdio: "inherit",
	env: {
		...process.env,
		ANANSI_EXTENSION_BUILD_MODE: "private",
	},
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
