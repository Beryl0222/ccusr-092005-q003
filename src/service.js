// 学徒成长与岗位衔接领域服务
//
// 设计要点：
//   - 一切变化只追加事件（见 events.js），状态由事件折叠得到；
//   - 学校成绩、课程目标、师傅观察、门店作品各自带来源标识进入证据表，互不覆盖；
//   - 能力认定是学校与工作室按"当时规则版本"共同确认的决定，撤回/补充证据
//     只会产生一条取代旧结论的新决定，旧决定保留在历史里；
//   - 学徒转机构只能凭本人授权导出能力摘要，联系方式与未公开评价不进入摘要；
//   - 班次按"当前能力 + 食品安全 + 时间不冲突"匹配；导师停带或工坊停产时
//     既有安排作废并自动重算。

import { EventLog } from "./events.js";
import { LATEST_RULE_VERSION, RULE_VERSIONS, evaluateSkill, ruleAt } from "./rules.js";

const uid = (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

export function reduce(events) {
  const state = {
    studios: new Map(),
    courses: new Map(),
    apprentices: new Map(),
    mentors: new Map(),
    evidences: new Map(),
    works: new Map(),
    foodSafety: new Map(),
    decisions: new Map(), // apprenticeId|skill -> [decision...]，末尾为当前结论
    consents: new Map(),
    exports: [],
    shifts: new Map(),
  };

  const currentDecision = (apprenticeId, skill) => {
    const list = state.decisions.get(`${apprenticeId}|${skill}`);
    return list && list.length ? list[list.length - 1] : null;
  };

  for (const event of events) {
    const p = event.payload;
    switch (event.type) {
      case "StudioRegistered":
        state.studios.set(p.studioId, { ...p, paused: false });
        break;
      case "CourseRegistered":
        state.courses.set(p.courseId, p);
        break;
      case "ApprenticeEnrolled":
        state.apprentices.set(p.apprenticeId, {
          id: p.apprenticeId,
          name: p.name,
          courseId: p.courseId ?? null,
          // 联系方式属于敏感信息，参与存储但绝不进入可移植摘要
          contact: p.contact ?? {},
        });
        break;
      case "MentorAssigned":
        state.mentors.set(p.mentorId, { ...p, active: true });
        break;
      case "MentorStopped": {
        const mentor = state.mentors.get(p.mentorId);
        if (mentor) mentor.active = false;
        // 导师停带后，其名下未完成班次挂起，等待重新指派导师
        for (const shift of state.shifts.values()) {
          if (shift.mentorId === p.mentorId && !shift.mentorSuspended) {
            shift.mentorSuspended = true;
          }
        }
        break;
      }
      case "ShiftMentorReplaced": {
        const shift = state.shifts.get(p.shiftId);
        if (shift) {
          shift.mentorId = p.mentorId;
          shift.mentorSuspended = false;
        }
        break;
      }
      case "ProductionPaused": {
        const studio = state.studios.get(p.studioId);
        if (studio) studio.paused = true;
        break;
      }
      case "ProductionResumed": {
        const studio = state.studios.get(p.studioId);
        if (studio) studio.paused = false;
        break;
      }
      case "EvidenceSubmitted":
        state.evidences.set(p.evidenceId, {
          ...p,
          withdrawn: false,
          withdrawnReason: null,
        });
        break;
      case "EvidenceWithdrawn": {
        const evidence = state.evidences.get(p.evidenceId);
        if (evidence) {
          evidence.withdrawn = true;
          evidence.withdrawnReason = p.reason ?? null;
        }
        break;
      }
      case "WorkRecorded":
        state.works.set(p.workId, { workId: p.workId, title: p.title, shopRef: p.shopRef, contributors: [] });
        break;
      case "ContributionRecorded": {
        const work = state.works.get(p.workId);
        if (work) {
          work.contributors.push({
            apprenticeId: p.apprenticeId,
            skill: p.skill,
            contribution: p.contribution,
            attestedBy: p.attestedBy,
            evidenceId: p.evidenceId,
          });
        }
        state.evidences.set(p.evidenceId, {
          evidenceId: p.evidenceId,
          apprenticeId: p.apprenticeId,
          skill: p.skill,
          sourceType: "shop_work",
          sourceRef: p.workId,
          detail: `作品《${work ? work.title : p.workId}》贡献：${p.contribution}`,
          workId: p.workId,
          contribution: p.contribution,
          submittedBy: p.attestedBy,
          withdrawn: false,
          withdrawnReason: null,
        });
        break;
      }
      case "FoodSafetyCleared":
        state.foodSafety.set(p.apprenticeId, { cleared: true, ref: p.ref, at: event.at });
        break;
      case "FoodSafetyRevoked":
        state.foodSafety.set(p.apprenticeId, { cleared: false, ref: p.ref, revokedReason: p.reason, at: event.at });
        break;
      case "DecisionRecorded": {
        const key = `${p.apprenticeId}|${p.skill}`;
        if (!state.decisions.has(key)) state.decisions.set(key, []);
        state.decisions.get(key).push(p);
        break;
      }
      case "ConsentGranted":
        state.consents.set(p.consentId, { ...p, active: true });
        break;
      case "ConsentRevoked": {
        const consent = state.consents.get(p.consentId);
        if (consent) consent.active = false;
        break;
      }
      case "SummaryExported":
        state.exports.push(p);
        break;
      case "ShiftOpened":
        state.shifts.set(p.shiftId, { ...p, assignments: [], mentorSuspended: false });
        break;
      case "AssignmentRecorded": {
        const shift = state.shifts.get(p.shiftId);
        if (shift) {
          shift.assignments.push({ ...p, void: false, voidReason: null });
        }
        break;
      }
      case "AssignmentsVoided": {
        for (const shift of state.shifts.values()) {
          for (const assignment of shift.assignments) {
            if (p.assignmentIds.includes(assignment.assignmentId)) {
              assignment.void = true;
              assignment.voidReason = p.reason;
            }
          }
        }
        break;
      }
      default:
        break;
    }
  }

  return { ...state, currentDecision };
}

export class ApprenticeshipService {
  constructor(log = new EventLog()) {
    this.log = log;
    this.state = reduce(log.events);
  }

  // ---- 基础登记 ----

  registerStudio(studio) {
    this.log.append("StudioRegistered", studio);
    return this._sync().studios.get(studio.studioId);
  }

  registerCourse(course) {
    this.log.append("CourseRegistered", course);
    return this._sync().courses.get(course.courseId);
  }

  enroll(apprentice) {
    this.log.append("ApprenticeEnrolled", apprentice);
    return this._sync().apprentices.get(apprentice.apprenticeId);
  }

  assignMentor(mentor) {
    this.log.append("MentorAssigned", mentor);
    return this._sync().mentors.get(mentor.mentorId);
  }

  openShift(shift) {
    this.log.append("ShiftOpened", { capacity: 1, ...shift });
    return this._sync().shifts.get(shift.shiftId);
  }

  // ---- 证据：四源各自保留出处 ----

  submitEvidence(input) {
    const evidenceId = input.evidenceId ?? uid("ev");
    const sourceRef = input.sourceRef ?? uid("ref");
    const idempotencyKey =
      input.idempotencyKey ?? `${input.apprenticeId}|${input.skill}|${input.sourceType}|${sourceRef}`;
    const before = this.log.length;
    this.log.append(
      "EvidenceSubmitted",
      {
        evidenceId,
        apprenticeId: input.apprenticeId,
        skill: input.skill,
        sourceType: input.sourceType,
        sourceRef,
        detail: input.detail ?? "",
        submittedBy: input.submittedBy,
      },
      { idempotencyKey, at: input.at }
    );
    this._sync();
    // 重复提交返回同一事件，不触发新结论
    if (this.log.length !== before + 1) {
      return { evidenceId, duplicated: true };
    }
    if (input.reconsider !== false) {
      this._reconsider(input.apprenticeId, input.skill, input.at, { trigger: "evidence_submitted" });
    }
    return { evidenceId, duplicated: false };
  }

  // 撤回证据只追加撤回事件，并产生新结论；历史证据与历史结论都保留。
  withdrawEvidence(evidenceId, { reason, at } = {}) {
    const evidence = this.state.evidences.get(evidenceId);
    if (!evidence) throw new Error(`证据 ${evidenceId} 不存在`);
    if (evidence.withdrawn) return { duplicated: true };
    this.log.append("EvidenceWithdrawn", { evidenceId, reason }, { at });
    this._sync();
    this._reconsider(evidence.apprenticeId, evidence.skill, at, {
      trigger: "evidence_withdrawn",
      withdrawnEvidence: evidenceId,
    });
    return { duplicated: false };
  }

  recordWork(work) {
    this.log.append("WorkRecorded", work, { at: work.at });
    this._sync();
  }

  // 协作作品必须逐人写明贡献，贡献本身是工作室侧证据。
  recordContribution({ workId, apprenticeId, skill, contribution, attestedBy, at }) {
    const evidenceId = uid("ev");
    this.log.append(
      "ContributionRecorded",
      { workId, apprenticeId, skill, contribution, attestedBy, evidenceId },
      { at }
    );
    this._sync();
    this._reconsider(apprenticeId, skill, at, { trigger: "contribution_recorded" });
    return evidenceId;
  }

  clearFoodSafety(apprenticeId, { ref, at }) {
    this.log.append("FoodSafetyCleared", { apprenticeId, ref }, { at });
    this._sync();
  }

  revokeFoodSafety(apprenticeId, { ref, reason, at }) {
    this.log.append("FoodSafetyRevoked", { apprenticeId, ref, reason }, { at });
    this._sync();
  }

  // ---- 能力认定：校室按当时规则共同确认 ----

  // 直接发起认定（例如跨机构确认）。两边确认人缺一不可。
  confirmCompetence(apprenticeId, skill, options = {}) {
    return this._decide(apprenticeId, skill, options);
  }

  _reconsider(apprenticeId, skill, at, context) {
    const previous = this.state.currentDecision(apprenticeId, skill);
    // 从未共同确认过的能力，证据变化时先不自动生成结论（等待双方确认）。
    if (!previous) return null;
    // 补充证据可能使"不足"变"达标"，但升级必须由校室重新共同确认；
    // 只有撤回证据导致的降级才自动产生新结论。
    if (context.trigger !== "evidence_withdrawn" && previous.result !== "confirmed") return null;
    return this._decide(apprenticeId, skill, {
      at,
      ruleVersion: previous.ruleVersion, // 按原规则重算；规则升级需显式发起
      confirmers: previous.confirmers,
      context,
    });
  }

  _decide(apprenticeId, skill, options = {}) {
    const at = options.at ?? new Date().toISOString();
    const rule = options.ruleVersion ? RULE_VERSIONS[options.ruleVersion] : ruleAt(at);
    const confirmers = options.confirmers;
    if (!confirmers?.school?.org || !confirmers?.studio?.org) {
      throw new Error("能力认定必须由学校与工作室双方共同确认");
    }

    const evidences = [...this.state.evidences.values()].filter(
      (e) => e.apprenticeId === apprenticeId && e.skill === skill
    );
    const evaluation = evaluateSkill(skill, evidences, rule);
    const previous = this.state.currentDecision(apprenticeId, skill);
    const decisionId = uid("dec");

    this.log.append(
      "DecisionRecorded",
      {
        decisionId,
        apprenticeId,
        skill,
        result: evaluation.satisfied ? "confirmed" : "insufficient",
        ruleVersion: rule.version,
        missing: evaluation.missing,
        confirmers,
        basedOn: evidences.filter((e) => !e.withdrawn).map((e) => e.evidenceId),
        withdrawnSince:
          context_trigger(options) === "evidence_withdrawn" ? options.context.withdrawnEvidence : null,
        supersedes: previous?.decisionId ?? null,
        reason: options.reason ?? null,
      },
      { at }
    );
    this._sync();
    return this.state.currentDecision(apprenticeId, skill);
  }

  // 规则升级：对已认定能力按新版本重新确认，旧结论保留并被新结论取代。
  upgradeConfirmation(apprenticeId, skill, options = {}) {
    return this._decide(apprenticeId, skill, {
      ...options,
      ruleVersion: options.ruleVersion ?? LATEST_RULE_VERSION,
      context: { trigger: "rule_upgrade" },
    });
  }

  // ---- 授权与可移植能力摘要 ----

  grantConsent({ apprenticeId, scope, toStudioId = null, at }) {
    const consentId = uid("con");
    this.log.append("ConsentGranted", { consentId, apprenticeId, scope, toStudioId }, { at });
    this._sync();
    return consentId;
  }

  revokeConsent(consentId, { at } = {}) {
    const consent = this.state.consents.get(consentId);
    if (!consent) throw new Error(`授权 ${consentId} 不存在`);
    this.log.append("ConsentRevoked", { consentId }, { at });
    this._sync();
  }

  // 转出摘要：仅含学徒已授权且当前有效的能力结论。
  // 联系方式、未公开评价（观察细节）一律不进入摘要。
  exportSummary(apprenticeId, { consentId, toStudioId, at }) {
    const consent = this.state.consents.get(consentId);
    if (!consent || !consent.active || consent.apprenticeId !== apprenticeId) {
      throw new Error("授权无效或已撤回，无法导出能力摘要");
    }
    if (consent.toStudioId && consent.toStudioId !== toStudioId) {
      throw new Error("授权目的工作室与导出目标不一致");
    }
    const apprentice = this.state.apprentices.get(apprenticeId);
    const skills = [];
    for (const skill of consent.scope) {
      const decision = this.state.currentDecision(apprenticeId, skill);
      if (decision?.result === "confirmed") {
        skills.push({
          skill,
          ruleVersion: decision.ruleVersion,
          confirmedBy: {
            school: decision.confirmers.school.org,
            studio: decision.confirmers.studio.org,
          },
        });
      }
    }
    const summary = {
      type: "PortableAbilitySummary",
      apprenticeId,
      name: apprentice.name,
      toStudioId,
      skills,
      exportedAt: at ?? new Date().toISOString(),
      consentId,
    };
    const exportId = uid("exp");
    this.log.append("SummaryExported", { exportId, ...summary }, { at: summary.exportedAt });
    this._sync();
    return { exportId, summary };
  }

  // 接收方工作室在授权撤回后看到的可访问摘要（撤回即失效）。
  accessibleExportsFor(toStudioId) {
    return this.state.exports
      .filter((e) => e.toStudioId === toStudioId)
      .filter((e) => this.state.consents.get(e.consentId)?.active)
      .map(({ exportId, apprenticeId, name, skills, exportedAt, consentId }) => ({
        exportId,
        apprenticeId,
        name,
        skills,
        exportedAt,
        consentId,
      }));
  }

  // ---- 班次匹配 ----

  // 评估某学徒对某班次的匹配情况，并把决定（无论是否上岗）落事件。
  evaluateAssignment(shiftId, apprenticeId, { at } = {}) {
    const shift = this.state.shifts.get(shiftId);
    if (!shift) throw new Error(`班次 ${shiftId} 不存在`);
    const rule = ruleAt(at ?? shift.start);
    const trace = this.eligibilityTrace(shiftId, apprenticeId, { at, rule });
    const assignmentId = uid("asg");
    this.log.append(
      "AssignmentRecorded",
      {
        assignmentId,
        shiftId,
        studioId: shift.studioId,
        apprenticeId,
        result: trace.eligible ? "assigned" : "rejected",
        reasons: trace.reasons,
        trace: trace.snapshot,
      },
      { at }
    );
    this._sync();
    return this.state.shifts.get(shiftId).assignments.at(-1);
  }

  // 一次上岗决定追到：课程/作品等证据、确认者、规则版本、仍缺训练。
  eligibilityTrace(shiftId, apprenticeId, { at, rule = ruleAt((at ?? new Date().toISOString())) } = {}) {
    const shift = this.state.shifts.get(shiftId);
    const reasons = [];
    if (this.state.studios.get(shift.studioId)?.paused) reasons.push("工坊已暂停生产");
    if (shift.mentorSuspended || (shift.mentorId && this.state.mentors.get(shift.mentorId)?.active === false)) {
      reasons.push("班次导师已停带，待重新指派");
    }
    const skillResults = shift.requiredSkills.map((skill) => {
      const decision = this.state.currentDecision(apprenticeId, skill);
      const confirmed = decision?.result === "confirmed";
      if (!confirmed) {
        reasons.push(`能力《${skill}》尚未认定`);
      }
      const evidences = (decision?.basedOn ?? [])
        .map((id) => this.state.evidences.get(id))
        .filter(Boolean)
        .map((e) => ({
          evidenceId: e.evidenceId,
          sourceType: e.sourceType,
          sourceRef: e.sourceRef,
          // 门店追溯能定位课程与作品，但不暴露未公开评价原文
          kind:
            e.sourceType === "course_objective" || e.sourceType === "school_grade"
              ? "课程记录"
              : e.sourceType === "shop_work"
                ? "门店作品"
                : "现场记录",
        }));
      return {
        skill,
        confirmed,
        ruleVersion: decision?.ruleVersion ?? null,
        confirmers: decision?.confirmers ?? null,
        evidences,
        missingTraining:
          decision?.result === "insufficient"
            ? describeMissing(skill, decision.missing)
            : confirmed
              ? []
              : ["尚未取得任何共同确认"],
      };
    });

    const fs = this.state.foodSafety.get(apprenticeId);
    const foodSafetyCleared = fs?.cleared === true;
    if (rule.requireFoodSafety && !foodSafetyCleared) {
      reasons.push("尚未通过食品安全环节");
    }

    const conflict = this._timeConflict(shift, apprenticeId);
    if (conflict) reasons.push(`与已安排班次 ${conflict} 时间冲突`);

    return {
      eligible: reasons.length === 0,
      reasons,
      snapshot: {
        ruleVersion: rule.version,
        foodSafetyCleared,
        skillResults,
        conflictingShift: conflict,
      },
    };
  }

  _timeConflict(shift, apprenticeId) {
    for (const other of this.state.shifts.values()) {
      if (other.shiftId === shift.shiftId) continue;
      for (const assignment of other.assignments) {
        if (
          !assignment.void &&
          assignment.result === "assigned" &&
          assignment.apprenticeId === apprenticeId &&
          overlaps(shift, other)
        ) {
          return other.shiftId;
        }
      }
    }
    return null;
  }

  // 导师停带：其名下班次的现有安排全部失效，班次挂起等待重新指派导师。
  mentorStopped(mentorId, { reason = "导师停带", at } = {}) {
    this.log.append("MentorStopped", { mentorId }, { at });
    this._sync();
    const shiftIds = [...this.state.shifts.values()]
      .filter((s) => s.mentorId === mentorId)
      .map((s) => s.shiftId);
    this._voidAssignments(shiftIds, reason, at);
    // 挂起班次不立即重算：导师缺位时岗位不成立
    return { suspendedShifts: shiftIds };
  }

  // 为挂起班次重新指派导师，之后自动重算安排。
  replaceShiftMentor(shiftId, mentorId, { at } = {}) {
    const shift = this.state.shifts.get(shiftId);
    if (!shift) throw new Error(`班次 ${shiftId} 不存在`);
    this.log.append("ShiftMentorReplaced", { shiftId, mentorId }, { at });
    this._sync();
    return this.recalculate([shiftId], { at });
  }

  // 工坊暂停生产：其全部未开始班次的安排失效。
  productionPaused(studioId, { reason = "工坊暂停生产", at } = {}) {
    this.log.append("ProductionPaused", { studioId }, { at });
    this._sync();
    const shiftIds = [...this.state.shifts.values()]
      .filter((s) => s.studioId === studioId && (!at || s.start >= at))
      .map((s) => s.shiftId);
    this._voidAssignments(shiftIds, reason, at);
    // 暂停期间不重算
    return { suspendedShifts: shiftIds };
  }

  // 恢复生产后自动重算此前失效的安排。
  productionResumed(studioId, { at } = {}) {
    this.log.append("ProductionResumed", { studioId }, { at });
    this._sync();
    const shiftIds = [...this.state.shifts.values()]
      .filter((s) => s.studioId === studioId && !s.mentorSuspended)
      .map((s) => s.shiftId);
    return this.recalculate(shiftIds, { at });
  }

  _voidAssignments(shiftIds, reason, at) {
    const assignmentIds = [];
    for (const id of shiftIds) {
      const shift = this.state.shifts.get(id);
      for (const assignment of shift.assignments) {
        if (!assignment.void && assignment.result === "assigned") assignmentIds.push(assignment.assignmentId);
      }
    }
    if (assignmentIds.length) {
      this.log.append("AssignmentsVoided", { assignmentIds, reason, shiftIds }, { at });
      this._sync();
    }
    return assignmentIds;
  }

  // 作废后自动重算：在能力达标、食品安全通过、时间不冲突的人中重新匹配。
  recalculate(shiftIds, { at } = {}) {
    const results = [];
    for (const shiftId of shiftIds) {
      const shift = this.state.shifts.get(shiftId);
      if (!shift || shift.mentorSuspended) continue;
      if (this.state.studios.get(shift.studioId)?.paused) continue;
      if (at && shift.start < at) continue;
      const assigned = shift.assignments.filter((a) => !a.void && a.result === "assigned");
      const free = shift.capacity - assigned.length;
      if (free <= 0) continue;
      const candidates = [...this.state.apprentices.keys()].sort();
      for (const apprenticeId of candidates) {
        if (assigned.some((a) => a.apprenticeId === apprenticeId)) continue;
        const trace = this.eligibilityTrace(shiftId, apprenticeId, { at: at ?? shift.start });
        if (!trace.eligible) continue;
        const assignmentId = uid("asg");
        this.log.append(
          "AssignmentRecorded",
          {
            assignmentId,
            shiftId,
            studioId: shift.studioId,
            apprenticeId,
            result: "assigned",
            reasons: [],
            trace: trace.snapshot,
            auto: true,
          },
          { at }
        );
        this._sync();
        assigned.push({ apprenticeId });
        results.push({ shiftId, apprenticeId, assignmentId });
        if (assigned.length >= shift.capacity) break;
      }
    }
    return results;
  }

  // 门店查看：一次上岗决定的完整追溯视图。
  viewAssignment(assignmentId) {
    for (const shift of this.state.shifts.values()) {
      const assignment = shift.assignments.find((a) => a.assignmentId === assignmentId);
      if (assignment) {
        return {
          assignmentId,
          shift: { shiftId: shift.shiftId, station: shift.station, start: shift.start, end: shift.end },
          apprenticeId: assignment.apprenticeId,
          result: assignment.result,
          void: assignment.void,
          voidReason: assignment.voidReason,
          trace: assignment.trace,
        };
      }
    }
    return null;
  }

  _sync() {
    this.state = reduce(this.log.events);
    return this.state;
  }
}

function context_trigger(options) {
  return options.context?.trigger ?? null;
}

function describeMissing(skill, missing) {
  if (!missing || missing.length === 0) return [];
  return missing.map((side) => (side === "school" ? `《${skill}》缺学校侧证据` : `《${skill}》缺工作室侧证据`));
}

function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}
