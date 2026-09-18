/**
 * Phase 2B-0 experimental identity probe (NOT enabled on live gateway).
 * Would register who_am_i tool reading host-trusted ctx.requesterSenderId.
 * Kept as design artifact only — enabling requires openclaw.json entry + gateway restart.
 */
export default {
  id: "phase2b0-identity-probe",
  name: "Phase2B-0 Identity Probe",
  description: "Temporary who_am_i probe for requester identity (experimental)",
  register(api) {
    api.registerTool((ctx) => ({
      name: "who_am_i",
      label: "Who Am I",
      description:
        "Return host-trusted requester identity fields for Phase 2B-0 probe. Do not invent identity.",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        const payload = {
          probe: "phase2b0-identity-probe",
          requesterSenderId: ctx?.requesterSenderId ?? null,
          agentAccountId: ctx?.agentAccountId ?? null,
          sessionKey: ctx?.sessionKey ?? null,
          messageChannel: ctx?.messageChannel ?? null,
          note:
            "If requesterSenderId is null, this run has no host-trusted requester (typical for shared gateway token / cron / heartbeat).",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        };
      },
    }));
  },
};
