import { execFileSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function isWithinRoot(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function copyArtifactEntry(
	source: string,
	destination: string,
	root: string,
	activeDirectories: Set<string>,
): void {
	const sourceInfo = lstatSync(source);
	const resolvedSource = sourceInfo.isSymbolicLink() ? realpathSync(source) : source;
	if (!isWithinRoot(root, realpathSync(resolvedSource))) {
		throw new Error(`Artifact symlink escapes artifact root: ${source}`);
	}

	const info = lstatSync(resolvedSource);
	if (info.isDirectory()) {
		const canonicalDirectory = realpathSync(resolvedSource);
		if (activeDirectories.has(canonicalDirectory)) {
			throw new Error(`Artifact directory symlink cycle detected: ${source}`);
		}
		activeDirectories.add(canonicalDirectory);
		mkdirSync(destination, { recursive: true, mode: info.mode });
		try {
			for (const entry of readdirSync(resolvedSource)) {
				copyArtifactEntry(
					path.join(resolvedSource, entry),
					path.join(destination, entry),
					root,
					activeDirectories,
				);
			}
		} finally {
			activeDirectories.delete(canonicalDirectory);
		}
		chmodSync(destination, info.mode & 0o777);
	} else if (info.isFile()) {
		mkdirSync(path.dirname(destination), { recursive: true });
		copyFileSync(resolvedSource, destination);
		chmodSync(destination, info.mode & 0o777);
	} else {
		throw new Error(`Unsupported non-regular artifact entry: ${source}`);
	}
}

/** Stage an artifact with contained symlinks resolved, then ZIP the staged root. */
export function zipArtifactDirectory(
	directory: string,
	outputZip: string,
	runZip: (args: string[], cwd: string) => void = (args, cwd) => {
		execFileSync("zip", args, { cwd });
	},
): string {
	rmSync(outputZip, { force: true });
	let stagingDirectory: string | undefined;
	try {
		const root = realpathSync(directory);
		stagingDirectory = mkdtempSync(path.join(tmpdir(), "pawl-web-artifact-"));
		const stagedRoot = path.join(stagingDirectory, "package");
		copyArtifactEntry(root, stagedRoot, root, new Set());
		try {
			runZip(["-q", "-r", outputZip, "."], stagedRoot);
		} catch (err) {
			throw new Error(`Failed to zip artifact directory "${directory}"`, { cause: err });
		}
		return outputZip;
	} catch (err) {
		rmSync(outputZip, { force: true });
		throw err;
	} finally {
		if (stagingDirectory) rmSync(stagingDirectory, { recursive: true, force: true });
	}
}
