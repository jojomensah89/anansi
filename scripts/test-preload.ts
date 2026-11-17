/**
 * Runs before every test file (see bunfig.toml).
 *
 * React DOM and Base UI inspect the environment when their modules first load.
 * The shared test module cache means a server-rendering test can otherwise
 * initialize them before a component test installs jsdom. Initialize both
 * against the same browser-like globals here, then restore the test process.
 */
import { installDom } from "../apps/web/src/lib/test-dom.ts";

const dom = installDom();
try {
	await import("react-dom/client");
	await import("@base-ui/utils/useIsoLayoutEffect");
} finally {
	dom.restore();
}
