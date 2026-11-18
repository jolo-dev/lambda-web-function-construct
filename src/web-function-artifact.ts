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
	utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function isWithinRoot(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const NORMALIZED_TIMESTAMP = new Date("1980-01-01T00:00:00.000Z");

interface StagingState {
	activeDirectories: Set<string>;
	totalBytes: number;
}

function copyArtifactEntry(
	source: string,
	destination: string,
	root: string,
	state: StagingState,
	copyFile: (source: string, destination: string) => void,
): void {
	const sourceInfo = lstatSync(source);
	const resolvedSource = sourceInfo.isSymbolicLink() ? realpathSync(source) : source;
	if (!isWithinRoot(root, realpathSync(resolvedSource))) {
		throw new Error(`Artifact symlink escapes artifact root: ${source}`);
	}

	const info = lstatSync(resolvedSource);
	if (info.isDirectory()) {
		const canonicalDirectory = realpathSync(resolvedSource);
		if (state.activeDirectories.has(canonicalDirectory)) {
			throw new Error(`Artifact directory symlink cycle detected: ${source}`);
		}
		state.activeDirectories.add(canonicalDirectory);
		mkdirSync(destination, { recursive: true, mode: info.mode });
		try {
			for (const entry of readdirSync(resolvedSource).sort()) {
				copyArtifactEntry(
					path.join(resolvedSource, entry),
					path.join(destination, entry),
					root,
					state,
					copyFile,
				);
			}
		} finally {
			state.activeDirectories.delete(canonicalDirectory);
		}
		chmodSync(destination, info.mode & 0o7777);
		utimesSync(destination, NORMALIZED_TIMESTAMP, NORMALIZED_TIMESTAMP);
	} else if (info.isFile()) {
		if (info.size > MAX_UNCOMPRESSED_BYTES - state.totalBytes) {
			throw new Error("Artifact exceeds the 512 MiB uncompressed size limit");
		}
		state.totalBytes += info.size;
		mkdirSync(path.dirname(destination), { recursive: true });
		copyFile(resolvedSource, destination);
		chmodSync(destination, info.mode & 0o7777);
		utimesSync(destination, NORMALIZED_TIMESTAMP, NORMALIZED_TIMESTAMP);
	} else {
		throw new Error(`Unsupported non-regular artifact entry: ${source}`);
	}
}

/** Stage an artifact with contained symlinks resolved, then ZIP the staged root. */
function collectArchivePaths(directory: string, root = directory): string[] {
	const paths: string[] = [];
	for (const entry of readdirSync(directory).sort()) {
		const fullPath = path.join(directory, entry);
		const relativePath = path.relative(root, fullPath).split(path.sep).join("/");
		if (lstatSync(fullPath).isDirectory()) {
			paths.push(`${relativePath}/`, ...collectArchivePaths(fullPath, root));
		} else {
			paths.push(relativePath);
		}
	}
	return paths;
}

export function zipArtifactDirectory(
	directory: string,
	outputZip: string,
	runZip: (args: string[], cwd: string, input: string) => void = (args, cwd, input) => {
		execFileSync("zip", args, { cwd, input });
	},
	copyFile: (source: string, destination: string) => void = copyFileSync,
): string {
	rmSync(outputZip, { force: true });
	let stagingDirectory: string | undefined;
	try {
		const root = realpathSync(directory);
		stagingDirectory = mkdtempSync(path.join(tmpdir(), "pawl-web-artifact-"));
		const stagedRoot = path.join(stagingDirectory, "package");
		const state: StagingState = { activeDirectories: new Set(), totalBytes: 0 };
		copyArtifactEntry(root, stagedRoot, root, state, copyFile);
		try {
			const input = collectArchivePaths(stagedRoot).join("\n");
			runZip(["-X", "-q", outputZip, "-@"], stagedRoot, input);
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
