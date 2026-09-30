// 状态投影：从第 1 条事件顺序重放。投影结果只用于读取，所有变更仍须通过新事件完成。
// 历史记录一律保留：撤回、作废、被取代都只是新增状态字段，原有条目不删除。

export function fold(events) {
  const state = {
    orgs: new Map(),
    studios: new Map(),
    persons: new Map(),
    courses: new Map(),
    positions: new Map(),
    shifts: new Map(),
    evidence: new Map(),
    conclusions: new Map(),
    confirmations: new Map(),
    consents: new Map(),
    assignments: new Map(),
    rules: new Map(),
    disclosures: new Map(),
    timeline: [],
  };

  for (const event of events) {
    const p = event.payload;
    switch (event.type) {
      case "OrganizationRegistered":
        state.orgs.set(p.org_id, { ...p });
        break;
      case "StudioRegistered":
        state.studios.set(p.studio_id, {
          studio_id: p.studio_id,
          name: p.name,
          craft: p.craft,
          mentor_slots: p.mentor_slots,
          required_skills: p.required_skills ?? [],
          status: "active",
          mentors: [],
        });
        break;
      case "MentorAppointed":
        state.studios.get(p.studio_id)?.mentors.push(p.person_id);
        break;
      case "MentorshipEnded": {
        const studio = state.studios.get(p.studio_id);
        if (studio) {
          studio.mentors = studio.mentors.filter((m) => m !== p.person_id);
          studio.mentor_ended_at = p.at;
        }
        break;
      }
      case "ProductionPaused": {
        const studio = state.studios.get(p.studio_id);
        if (studio) {
          studio.status = "paused";
          studio.paused_at = p.at;
        }
        break;
      }
      case "ProductionResumed": {
        const studio = state.studios.get(p.studio_id);
        if (studio) {
          studio.status = "active";
          studio.resumed_at = p.at;
        }
        break;
      }
      case "PersonEnrolled":
        state.persons.set(p.person_id, {
          person_id: p.person_id,
          name: p.name,
          org_id: p.org_id,
          // 联系方式属于敏感信息，只存在于本投影，摘要外发时显式排除。
          contact: p.contact ?? {},
        });
        break;
      case "CourseDefined":
        state.courses.set(p.course_id, { ...p });
        break;
      case "PositionDefined":
        state.positions.set(p.position_id, { ...p });
        break;
      case "ShiftOpened":
        state.shifts.set(p.shift_id, { ...p, status: "open" });
        break;
      case "RulePublished":
        state.rules.set(p.version, { ...p });
        state.current_rule = p.version;
        break;
      case "EvidenceSubmitted":
        state.evidence.set(p.evidence_id, {
          ...p,
          status: "active",
          withdrawals: [],
        });
        break;
      case "EvidenceWithdrawn": {
        const e = state.evidence.get(p.evidence_id);
        if (e) {
          e.status = "withdrawn";
          e.withdrawals.push({ at: p.at, reason: p.reason });
        }
        break;
      }
      case "ConclusionDerived": {
        // 同一人同一能力的旧结论被标记取代，但条目本身保留，可追溯。
        for (const old of state.conclusions.values()) {
          if (
            old.person_id === p.person_id &&
            old.unit === p.unit &&
            old.status === "active"
          ) {
            old.status = "superseded";
            old.superseded_by = p.conclusion_id;
          }
        }
        state.conclusions.set(p.conclusion_id, {
          ...p,
          status: "active",
        });
        break;
      }
      case "ConfirmationRecorded":
        state.confirmations.set(p.confirmation_id, {
          ...p,
          status: "active",
        });
        break;
      case "ConfirmationRevoked": {
        const c = state.confirmations.get(p.confirmation_id);
        if (c) {
          c.status = "revoked";
          c.revoked_at = p.at;
          c.revoke_reason = p.reason;
        }
        break;
      }
      case "ConsentGranted":
        state.consents.set(p.consent_id, { ...p, status: "granted" });
        break;
      case "ConsentWithdrawn": {
        const c = state.consents.get(p.consent_id);
        if (c) {
          c.status = "withdrawn";
          c.withdrawn_at = p.at;
          c.withdraw_reason = p.reason;
        }
        break;
      }
      case "SummaryIssued":
        // 每次出证单独留痕；撤回授权后历史出证记录仍在，但 portableView 拒绝再次出具。
        state.disclosures.set(p.disclosure_id, { ...p });
        break;
      case "AssignmentCreated":
        state.assignments.set(p.assignment_id, { ...p, status: "active" });
        {
          const shift = state.shifts.get(p.shift_id);
          if (shift) shift.assignment_id = p.assignment_id;
        }
        break;
      case "AssignmentInvalidated": {
        const a = state.assignments.get(p.assignment_id);
        if (a) {
          a.status = "invalidated";
          a.invalidated_at = p.at;
          a.invalid_reason = p.reason;
          a.replacement_assignment_id = p.replacement_assignment_id;
        }
        const shift = state.shifts.get(a?.shift_id);
        if (shift) {
          shift.assignment_id = p.replacement_assignment_id ?? null;
        }
        break;
      }
      default:
        throw new Error(`未知事件类型：${event.type}`);
    }
    state.timeline.push(event.seq);
  }

  return state;
}
