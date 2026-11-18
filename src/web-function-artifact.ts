import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";

function isWithinRoot(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertNoEscapingSymlinks(root: string, directory: string): void {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const entryPath = path.join(directory, entry.name);
		const metadata = lstatSync(entryPath);
		if (metadata.isSymbolicLink()) {
			const target = realpathSync(entryPath);
			if (!isWithinRoot(root, target)) {
				throw new Error(`Artifact symlink escapes artifact root: ${entryPath}`);
			}
		} else if (metadata.isDirectory()) {
			assertNoEscapingSymlinks(root, entryPath);
		}
	}
}

/** ZIP a directory from its root after checking that its symlinks stay contained. */
export function zipArtifactDirectory(
	directory: string,
	outputZip: string,
	runZip: (args: string[], cwd: string) => void = (args, cwd) => {
		execFileSync("zip", args, { cwd });
	},
): string {
	rmSync(outputZip, { force: true });
	const root = realpathSync(directory);
	assertNoEscapingSymlinks(root, root);
	try {
		runZip(["-q", "-r", outputZip, "."], root);
	} catch (err) {
		rmSync(outputZip, { force: true });
		throw new Error(`Failed to zip artifact directory "${directory}"`, { cause: err });
	}
	return outputZip;
}
