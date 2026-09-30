import type {
  HistoryInvalidationReason,
  ResumePlan,
  SessionIdentity,
} from "./index.js";

export interface ResumeAvailability {
  /** IDs attest actual owned resident state or independently verified persistence. */
  residentSessionId?: string;
  persistedSessionId?: string;
  invalidated?: HistoryInvalidationReason;
  /** Hashes of native assistant output/results core already reconciled with Claude. */
  acknowledgedAppendDigests?: readonly string[];
}

/** A pure decision: no disk probing, input replay, process creation or hidden caches. */
export function resolveResumePlan(
  previous: SessionIdentity | undefined,
  next: SessionIdentity,
  availability: ResumeAvailability,
): ResumePlan {
  const rebuild = (reason: string): ResumePlan =>
    next.history.messages.length === 0
      ? { mode: "fresh", restoration: "none", reason }
      : {
          mode: "replay",
          restoration: "user-history-replay",
          replayTranscript: next.history.messages,
          reason,
        };

  if (availability.invalidated) {
    return rebuild(`history invalidated: ${availability.invalidated}`);
  }
  if (!previous?.claudeSessionId) {
    return rebuild("no authoritative Claude session identity");
  }
  if (
    previous.sessionId !== next.sessionId ||
    previous.branchId !== next.branchId ||
    previous.historyRevision !== next.historyRevision ||
    previous.driver !== next.driver ||
    previous.cwd !== next.cwd ||
    previous.configurationDigest !== next.configurationDigest
  ) {
    return rebuild(
      "session, history revision or effective configuration changed",
    );
  }

  const before = previous.history.messageDigests;
  const after = next.history.messageDigests;
  if (
    before.length !== previous.history.messages.length ||
    after.length !== next.history.messages.length
  ) {
    return rebuild(
      "history fingerprint does not cover the complete transcript",
    );
  }
  if (before.some((digest, index) => after[index] !== digest)) {
    return rebuild("host history is not an extension of acknowledged history");
  }
  const appended = after.slice(before.length);
  const acknowledged = availability.acknowledgedAppendDigests ?? [];
  if (
    appended.length !== acknowledged.length ||
    appended.some((digest, index) => acknowledged[index] !== digest)
  ) {
    return rebuild("appended history has not been reconciled with Claude");
  }

  const claudeSessionId = previous.claudeSessionId;
  if (availability.residentSessionId === claudeSessionId) {
    return {
      mode: "resident",
      restoration: "native-resident",
      claudeSessionId,
      reason: "resident state matches complete acknowledged host history",
    };
  }
  if (availability.persistedSessionId === claudeSessionId) {
    return {
      mode: "resume",
      restoration: "native-persisted",
      claudeSessionId,
      reason: "verified persistence matches complete acknowledged host history",
    };
  }
  return rebuild("Claude persistence has not been verified");
}
