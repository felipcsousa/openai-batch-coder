const SENSITIVE_PATH_PATTERNS = [
  /(^|\/)\.env(\.|$)?/i,
  /(^|\/)id_rsa$/i,
  /(^|\/)id_ed25519$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.pypirc$/i,
  /(^|\/)credentials(\.json|\.yml|\.yaml|\.toml)?$/i,
  /(^|\/)secrets?(\.|\/|$)/i,
];

const SENSITIVE_CONTENT_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bghp_[A-Za-z0-9_]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /-----BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/,
  /\b[A-Z0-9_]*(SECRET|TOKEN|PASSWORD|API_KEY)\s*=\s*['"]?[^'"\s]{8,}/i,
];

export function scanManifestForSensitiveData(manifest) {
  const findings = [];
  for (const file of manifest.files ?? []) {
    const sensitivePath = SENSITIVE_PATH_PATTERNS.find((pattern) => pattern.test(file.path));
    if (sensitivePath) {
      findings.push({
        kind: "sensitive_path",
        path: file.path,
        message: `Blocked sensitive-looking path: ${file.path}`,
      });
      continue;
    }
    const sensitiveContent = SENSITIVE_CONTENT_PATTERNS.find((pattern) =>
      pattern.test(file.content ?? ""),
    );
    if (sensitiveContent) {
      findings.push({
        kind: "sensitive_content",
        path: file.path,
        message: `Blocked sensitive-looking content in: ${file.path}`,
      });
    }
  }
  return findings;
}

export function assertManifestIsSafe(manifest, { allowSensitive = false } = {}) {
  const findings = scanManifestForSensitiveData(manifest);
  if (findings.length > 0 && !allowSensitive) {
    const details = findings.map((finding) => `${finding.kind}:${finding.path}`).join(", ");
    const error = new Error(`manifest contains sensitive data; pass --allow-sensitive to override: ${details}`);
    error.findings = findings;
    throw error;
  }
  return findings;
}
