import { mkdir, writeFile } from "node:fs/promises";

async function writeArtifact(outputDirectory: string, fileName: string, value: string): Promise<string> {
  await mkdir(outputDirectory, { recursive: true });
  const artifactPath = `${outputDirectory}/${fileName}`;
  await writeFile(artifactPath, value, "utf8");
  return artifactPath;
}

export async function writeJsonArtifact(outputDirectory: string, fileName: string, value: unknown): Promise<string> {
  return writeArtifact(outputDirectory, fileName, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextArtifact(outputDirectory: string, fileName: string, value: string): Promise<string> {
  return writeArtifact(outputDirectory, fileName, value.endsWith("\n") ? value : `${value}\n`);
}
