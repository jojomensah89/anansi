export function readZipEntries(buffer: Buffer): Map<string, Buffer>;

export function collectConfiguredCredentialValues(
	dotenvValues: Record<string, string | undefined>,
	environmentValues: Record<string, string | undefined>,
): Array<{ name: string; value: string }>;

export function validatePublicArtifactContents(
	files: Map<string, Buffer>,
	credentials?: Array<{ name: string; value: string }>,
): void;
