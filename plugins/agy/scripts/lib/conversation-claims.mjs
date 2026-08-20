// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateStorageRoot } from "./state.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const OWNER_FILE_PATTERN = /^owner-([0-9a-f]{32})\.json$/;
const PENDING_DIR_PATTERN = /^([0-9a-f]{64})\.pending-(\d+)-([0-9a-f]{32})$/;

function pruneExpiredPendingClaims(directory) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  const now = Date.now();
  for (const entry of entries) {
    const match = entry.isDirectory() ? PENDING_DIR_PATTERN.exec(entry.name) : null;
    if (!match || Number(match[2]) > now) {
      continue;
    }
    const pendingDir = path.join(directory, entry.name);
    const ownerFile = path.join(pendingDir, `owner-${match[3]}.json`);
    try {
      fs.unlinkSync(ownerFile);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        continue;
      }
    }
    try {
      fs.rmdirSync(pendingDir);
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error?.code)) {
        throw error;
      }
    }
  }
}

function ensureClaimsDir() {
  const directory = path.join(resolveStateStorageRoot(), "conversation-claims");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Best effort on filesystems without POSIX mode support.
  }
  pruneExpiredPendingClaims(directory);
  return directory;
}

function resolveClaimDir(conversationId) {
  const key = createHash("sha256").update(String(conversationId)).digest("hex");
  return path.join(ensureClaimsDir(), key);
}

function readClaim(claimDir) {
  try {
    const ownerFile = fs.readdirSync(claimDir).find((name) => OWNER_FILE_PATTERN.test(name)) ?? null;
    let owner = null;
    if (ownerFile) {
      try {
        owner = JSON.parse(fs.readFileSync(path.join(claimDir, ownerFile), "utf8"));
      } catch {
        // A creator may still be filling its exclusively named owner file.
      }
    }
    return { claimDir, ownerFile, owner };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function claimIsStale(claim) {
  const owner = claim.owner;
  if (!owner || typeof owner !== "object") {
    return true;
  }
  const expiresAt = Date.parse(owner.expiresAt ?? "");
  return !Number.isFinite(expiresAt) || Date.now() >= expiresAt;
}

function removeObservedClaim(claim) {
  if (claim.ownerFile) {
    try {
      fs.unlinkSync(path.join(claim.claimDir, claim.ownerFile));
    } catch (error) {
      if (error?.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }
  try {
    fs.rmdirSync(claim.claimDir);
    return true;
  } catch (error) {
    if (["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error?.code)) {
      return false;
    }
    throw error;
  }
}

function writeOwnerFile(claimDir, ownerFile, owner) {
  const filePath = path.join(claimDir, ownerFile);
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(owner, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the original write error.
      }
    }
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
  fs.closeSync(descriptor);
}

export function claimConversation(cwd, conversationId, jobId, options = {}) {
  if (!conversationId) {
    return null;
  }
  const expiresAt = Date.parse(options.expiresAt ?? "");
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error("Conversation claims require a future execution deadline.");
  }
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const claimDir = resolveClaimDir(conversationId);
  const token = randomBytes(16).toString("hex");
  const ownerFile = `owner-${token}.json`;
  const pendingDir = `${claimDir}.pending-${expiresAt}-${token}`;
  const createdAt = Date.now();
  const owner = {
    version: 1,
    token,
    conversationId,
    jobId,
    workspaceRoot,
    createdAt: new Date(createdAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString()
  };

  let installed = false;
  try {
    fs.mkdirSync(pendingDir, { mode: 0o700 });
    writeOwnerFile(pendingDir, ownerFile, owner);

    while (true) {
      let existing;
      try {
        fs.renameSync(pendingDir, claimDir);
        installed = true;
        return owner;
      } catch (error) {
        existing = readClaim(claimDir);
        if (!existing) {
          throw error;
        }
      }

      if (!claimIsStale(existing)) {
        const ownerJob = existing.owner?.jobId ? ` by job ${existing.owner.jobId}` : "";
        throw new Error(
          `Antigravity conversation ${conversationId} is already being continued${ownerJob}. Wait for it to finish or cancel it first.`
        );
      }
      removeObservedClaim(existing);
    }
  } finally {
    if (!installed) {
      try {
        fs.unlinkSync(path.join(pendingDir, ownerFile));
      } catch {
        // Preserve the acquisition result.
      }
      try {
        fs.rmdirSync(pendingDir);
      } catch {
        // Preserve the acquisition result.
      }
    }
  }
}

export function assertConversationClaim(cwd, conversationId, jobId, options = {}) {
  if (!conversationId) {
    return;
  }
  const expectedExpiry = new Date(options.expiresAt ?? "").toISOString();
  const claim = readClaim(resolveClaimDir(conversationId));
  if (
    !claim ||
    claim.owner?.jobId !== jobId ||
    claim.owner?.workspaceRoot !== resolveWorkspaceRoot(cwd) ||
    claim.owner?.expiresAt !== expectedExpiry ||
    claimIsStale(claim)
  ) {
    throw new Error(
      `Antigravity conversation ${conversationId} is no longer claimed by job ${jobId}; the delayed worker will not start.`
    );
  }
}

export function releaseConversation(cwd, conversationId, jobId) {
  if (!conversationId) {
    return;
  }
  const claim = readClaim(resolveClaimDir(conversationId));
  if (
    !claim ||
    claim.owner?.jobId !== jobId ||
    claim.owner?.workspaceRoot !== resolveWorkspaceRoot(cwd)
  ) {
    return;
  }
  removeObservedClaim(claim);
}
