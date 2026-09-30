import { fold } from "./projection.js";
import { evaluate, ruleAt, SKILL_CATALOG } from "./catalog.js";

// 成长与岗位衔接领域服务。
// 不变量：
//  1. 证据各带来源（学校成绩 / 师傅观察 / 门店作品），任何一方都不能单独等同于能力。
//  2. 能力结论只追加：补充或撤回证据产生新结论，旧结论保留并标记被取代。
//  3. 能力认定须由学校与工作室按当时规则版本共同确认，双方缺一不可。
//  4. 跨工作室只携带本人授权的能力摘要，联系方式与未公开评价不外出。
//  5. 班次只安排能力满足（含硬门槛）且时间不冲突的人；导师停带、工坊暂停、
//     证据撤回、确认撤销、规则升级时，受影响安排自动失效并重算。
export class GrowthService {
  constructor(log) {
    this.log = log;
  }

  get state() {
    return fold(this.log.events);
  }

  // 重放"已落库事件 + 本批尚未提交事件"，使同一命令内的联动决策基于最新状态。
  #replay(events) {
    return fold([...this.log.events, ...events]);
  }

  #run(commandId, build) {
    if (commandId && this.log.hasCommand(commandId)) {
      return this.log.commit(commandId, []);
    }
    const events = build(this.state);
    return this.log.commit(commandId, events);
  }

  static event(type, payload) {
    return { type, payload };
  }

  // ---------- 机构与人员 ----------

  registerOrg(input, commandId) {
    return this.#run(commandId ?? input.command_id, (s) => {
      if (s.orgs.has(input.org_id)) throw new Error("机构已存在");
      if (!["school", "studio"].includes(input.org_type)) {
        throw new Error("机构类型须为 school 或 studio");
      }
      return [
        GrowthService.event("OrganizationRegistered", {
          org_id: input.org_id,
          name: input.name,
          org_type: input.org_type,
          at: input.at,
        }),
      ];
    });
  }

  registerStudio(input, commandId) {
    return this.#run(commandId ?? input.command_id, (s) => {
      if (s.studios.has(input.studio_id)) throw new Error("工作室已存在");
      const org = s.orgs.get(input.org_id);
      if (!org || org.org_type !== "studio") throw new Error("缺少对应工作室机构");
      return [
        GrowthService.event("StudioRegistered", {
          studio_id: input.studio_id,
          org_id: input.org_id,
          name: input.name,
          craft: input.craft,
          mentor_slots: input.mentor_slots ?? 0,
          required_skills: input.required_skills ?? [],
          at: input.at,
        }),
      ];
    });
  }

  appointMentor(input, commandId) {
    return this.#run(commandId ?? input.command_id, (s) => {
      if (!s.studios.has(input.studio_id)) throw new Error("工作室不存在");
      if (!s.persons.has(input.person_id)) throw new Error("人员不存在");
      return [
        GrowthService.event("MentorAppointed", {
          studio_id: input.studio_id,
          person_id: input.person_id,
          at: input.at,
        }),
      ];
    });
  }

  endMentorship(input, commandId) {
    // 导师停带：停带事件 + 由其指导的班次安排全部自动失效并重算。
    return this.#run(commandId ?? input.command_id, (s) => {
      const events = [
        GrowthService.event("MentorshipEnded", {
          studio_id: input.studio_id,
          person_id: input.person_id,
          at: input.at,
        }),
      ];
      this.#syncAssignments(events, input.at, {
        studioId: input.studio_id,
        mentorId: input.person_id,
        reason: "导师停带",
      });
      return events;
    });
  }

  pauseProduction(input, commandId) {
    // 工坊暂停：全部在班安排失效；暂停期间不产生新安排。
    return this.#run(commandId ?? input.command_id, (s) => {
      const events = [
        GrowthService.event("ProductionPaused", {
          studio_id: input.studio_id,
          at: input.at,
        }),
      ];
      this.#syncAssignments(events, input.at, {
        studioId: input.studio_id,
        reason: "工坊暂停生产",
      });
      return events;
    });
  }

  resumeProduction(input, commandId) {
    // 复工后重新计算：开放班次若已无现行安排，则按当前规则重新排班。
    return this.#run(commandId ?? input.command_id, (s) => {
      const events = [
        GrowthService.event("ProductionResumed", {
          studio_id: input.studio_id,
          at: input.at,
        }),
      ];
      this.#reopenShifts(events, input.studio_id, input.at);
      return events;
    });
  }

  enrollPerson(input, commandId) {
    return this.#run(commandId ?? input.command_id, (s) => {
      if (s.persons.has(input.person_id)) throw new Error("人员已登记");
      if (!s.orgs.has(input.org_id)) throw new Error("所属机构不存在");
      return [
        GrowthService.event("PersonEnrolled", {
          person_id: input.person_id,
          name: input.name,
          org_id: input.org_id,
          contact: input.contact ?? {},
          at: input.at,
        }),
      ];
    });
  }

  defineCourse(input, commandId) {
    return this.#run(commandId ?? input.command_id, (s) => {
      if (s.courses.has(input.course_id)) throw new Error("课程已存在");
      if (!s.orgs.has(input.school_org_id)) throw new Error("学校机构不存在");
      return [
        GrowthService.event("CourseDefined", {
          course_id: input.course_id,
          school_org_id: input.school_org_id,
          title: input.title,
          stages: input.stages ?? [],
          objectives: input.objectives ?? [],
          at: input.at,
        }),
      ];
    });
  }

  definePosition(input, commandId) {
    return this.#run(commandId ?? input.command_id, (s) => {
      if (s.positions.has(input.position_id)) throw new Error("岗位已存在");
      return [
        GrowthService.event("PositionDefined", {
          position_id: input.position_id,
          studio_id: input.studio_id,
          title: input.title,
          required_skills: input.required_skills ?? [],
          at: input.at,
        }),
      ];
    });
  }

  openShift(input, commandId) {
    return this.#run(commandId ?? input.command_id, (s) => {
      if (s.shifts.has(input.shift_id)) throw new Error("班次已存在");
      const position = s.positions.get(input.position_id);
      if (!position) throw new Error("岗位不存在");
      return [
        GrowthService.event("ShiftOpened", {
          shift_id: input.shift_id,
          position_id: input.position_id,
          studio_id: position.studio_id,
          mentor_id: input.mentor_id ?? null,
          start: input.start,
          end: input.end,
          status: "open",
          at: input.at,
        }),
      ];
    });
  }

  publishRule(input, commandId) {
    // 规则只能整体发布新版本；已形成的结论永远保留其当时的规则版本。
    return this.#run(commandId ?? input.command_id, (s) => {
      if (s.rules.has(input.version)) throw new Error("规则版本已存在");
      const rule = ruleAt(input.version);
      const events = [
        GrowthService.event("RulePublished", {
          ...rule,
          published_at: input.at,
        }),
      ];
      // 规则升级后，按门槛重新核对全部在岗安排，不满足的失效并重算。
      this.#syncAssignments(events, input.at, {
        reason: `规则升级至${input.version}`,
        ruleVersion: input.version,
      });
      return events;
    });
  }

  // ---------- 证据与结论 ----------

  submitEvidence(input, commandId) {
    return this.#run(commandId ?? input.command_id, (s) => {
      const person = s.persons.get(input.person_id);
      if (!person) throw new Error("人员不存在");
      if (!SKILL_CATALOG[input.unit]) throw new Error(`未知能力项：${input.unit}`);
      const rule = this.#rule(s, input.rule_version);
      if (!rule.source_weight[input.source_type]) {
        throw new Error(`未知证据来源：${input.source_type}`);
      }
      if (!s.orgs.has(input.org_id)) throw new Error("证据来源机构不存在");
      if (s.evidence.has(input.evidence_id)) throw new Error("证据编号已存在");

      // 同一作品多人协作：已有他人提交同一作品，或本人登记了协作者，必须写明贡献。
      const collaborators = input.collaborators ?? [];
      if (input.work_id) {
        const otherAuthors = [...s.evidence.values()].filter(
          (e) => e.work_id === input.work_id && e.person_id !== input.person_id
        );
        if ((otherAuthors.length > 0 || collaborators.length > 0) && !input.contribution) {
          throw new Error("协作作品必须写明本人贡献");
        }
      }
      // mentor_observation 可标记 visibility=private：仍可作为认定证据，
      // 但摘要与外发口径不输出任何评价正文（见 #buildSummary）。

      const events = [
        GrowthService.event("EvidenceSubmitted", {
          evidence_id: input.evidence_id,
          person_id: input.person_id,
          unit: input.unit,
          source_type: input.source_type,
          org_id: input.org_id,
          course_id: input.course_id ?? null,
          stage: input.stage ?? null,
          work_id: input.work_id ?? null,
          work_title: input.work_title ?? null,
          contribution: input.contribution ?? null,
          collaborators,
          grade: input.grade ?? null,
          visibility: input.visibility ?? "public",
          observed_at: input.observed_at ?? input.at,
          at: input.at,
        }),
      ];

      // 新证据立即按当前规则产生新结论（结论可能仍为"未满足"，等待更多来源）。
      this.#deriveConclusion(
        events,
        input.person_id,
        input.unit,
        input.at,
        rule.version,
        `证据 ${input.evidence_id} 提交`
      );
      return events;
    });
  }

  withdrawEvidence(input, commandId) {
    // 撤回证据不删除原记录：证据标记 withdrawn，并就同一能力产生一条新结论。
    return this.#run(commandId ?? input.command_id, (s) => {
      const evidence = s.evidence.get(input.evidence_id);
      if (!evidence) throw new Error("证据不存在");
      if (evidence.status !== "active") throw new Error("证据已失效");
      const rule = this.#rule(s, input.rule_version);
      const events = [
        GrowthService.event("EvidenceWithdrawn", {
          evidence_id: input.evidence_id,
          person_id: evidence.person_id,
          at: input.at,
          reason: input.reason,
        }),
      ];
      this.#deriveConclusion(
        events,
        evidence.person_id,
        evidence.unit,
        input.at,
        rule.version,
        `证据 ${input.evidence_id} 撤回：${input.reason}`
      );
      this.#syncAssignments(events, input.at, {
        personId: evidence.person_id,
        reason: `证据撤回（${input.reason}）`,
      });
      return events;
    });
  }

  #nextId(events, prefix, type) {
    const existed = this.log.events.filter((e) => e.type === type).length;
    const inBatch = events.filter((e) => e.type === type).length;
    return `${prefix}-${existed + inBatch + 1}`;
  }

  #deriveConclusion(events, personId, unit, at, ruleVersion, cause) {
    // 基于"已落库 + 本批"重放，本批刚提交/撤回的证据已反映在状态中。
    const s = this.#replay(events);
    const active = [...s.evidence.values()].filter(
      (e) => e.person_id === personId && e.unit === unit && e.status === "active"
    );
    const result = evaluate(ruleVersion, unit, active);
    const conclusionId = this.#nextId(events, `conclusion-${personId}-${unit}`, "ConclusionDerived");
    events.push(
      GrowthService.event("ConclusionDerived", {
        conclusion_id: conclusionId,
        person_id: personId,
        unit,
        rule_version: ruleVersion,
        satisfied: result.satisfied,
        weight: result.weight,
        source_types: result.source_types,
        missing_sources: result.missing,
        evidence_ids: active.map((e) => e.evidence_id),
        cause,
        at,
      })
    );
    return conclusionId;
  }

  // ---------- 双机构共同确认 ----------

  confirm(input, commandId) {
    return this.#run(commandId ?? input.command_id, (s) => {
      const conclusion = s.conclusions.get(input.conclusion_id);
      if (!conclusion) throw new Error("结论不存在");
      if (conclusion.status !== "active") throw new Error("结论已被新结论取代");
      const org = s.orgs.get(input.org_id);
      if (!org) throw new Error("确认机构不存在");
      if (!["school", "studio"].includes(org.org_type)) {
        throw new Error("只有学校与工作室可以确认能力");
      }
      const mine = [...s.confirmations.values()].find(
        (c) => c.conclusion_id === input.conclusion_id && c.org_id === input.org_id && c.status === "active"
      );
      if (mine) throw new Error("该机构已确认此结论，不可重复确认");
      const events = [
        GrowthService.event("ConfirmationRecorded", {
          confirmation_id: input.confirmation_id,
          conclusion_id: input.conclusion_id,
          person_id: conclusion.person_id,
          unit: conclusion.unit,
          org_id: input.org_id,
          org_type: org.org_type,
          at: input.at,
        }),
      ];
      return events;
    });
  }

  revokeConfirmation(input, commandId) {
    // 一方撤回确认不删除确认记录，只令其失效；能力可能因此不再成立，安排随之重算。
    return this.#run(commandId ?? input.command_id, (s) => {
      const confirmation = s.confirmations.get(input.confirmation_id);
      if (!confirmation) throw new Error("确认不存在");
      if (confirmation.status !== "active") throw new Error("确认已失效");
      const events = [
        GrowthService.event("ConfirmationRevoked", {
          confirmation_id: input.confirmation_id,
          conclusion_id: confirmation.conclusion_id,
          org_id: confirmation.org_id,
          at: input.at,
          reason: input.reason,
        }),
      ];
      this.#syncAssignments(events, input.at, {
        personId: confirmation.person_id,
        reason: `确认撤销（${input.reason}）`,
      });
      return events;
    });
  }

  // ---------- 授权与可携带摘要 ----------

  grantConsent(input, commandId) {
    return this.#run(commandId ?? input.command_id, (s) => {
      if (!s.persons.has(input.person_id)) throw new Error("人员不存在");
      if (!s.orgs.has(input.target_org_id)) throw new Error("目标机构不存在");
      const active = [...s.consents.values()].find(
        (c) => c.person_id === input.person_id && c.target_org_id === input.target_org_id && c.status === "granted"
      );
      if (active) throw new Error("已存在有效授权");
      return [
        GrowthService.event("ConsentGranted", {
          consent_id: input.consent_id,
          person_id: input.person_id,
          target_org_id: input.target_org_id,
          scope: input.scope ?? "confirmed_abilities",
          at: input.at,
        }),
      ];
    });
  }

  withdrawConsent(input, commandId) {
    return this.#run(commandId ?? input.command_id, (s) => {
      const consent = s.consents.get(input.consent_id);
      if (!consent) throw new Error("授权不存在");
      if (consent.status !== "granted") throw new Error("授权已撤回");
      return [
        GrowthService.event("ConsentWithdrawn", {
          consent_id: input.consent_id,
          person_id: consent.person_id,
          target_org_id: consent.target_org_id,
          at: input.at,
          reason: input.reason,
        }),
      ];
    });
  }

  // 出具跨工作室摘要：只含本人授权范围内、经双方确认的能力；
  // 不含联系方式，不含未公开（visibility=private）评价，不含未确认结论。
  issueSummary(input, commandId) {
    return this.#run(commandId ?? input.command_id, (s) => {
      const consent = s.consents.get(input.consent_id);
      if (!consent) throw new Error("授权不存在");
      if (consent.status !== "granted") throw new Error("授权已撤回，不能出具摘要");
      const summary = this.#buildSummary(s, consent);
      return [
        GrowthService.event("SummaryIssued", {
          disclosure_id: input.disclosure_id,
          consent_id: input.consent_id,
          person_id: consent.person_id,
          target_org_id: consent.target_org_id,
          units: summary.abilities.map((a) => a.unit),
          at: input.at,
        }),
      ];
    });
  }

  #buildSummary(s, consent) {
    const person = s.persons.get(consent.person_id);
    const abilities = [];
    for (const conclusion of s.conclusions.values()) {
      if (conclusion.person_id !== person.person_id) continue;
      if (conclusion.status !== "active" || !conclusion.satisfied) continue;
      const confirmed = this.#confirmers(s, conclusion);
      if (!confirmed.complete) continue;
      // 摘要只载"能力已认定"这一事实与确认者、规则版本；
      // 不输出任何证据/评价正文，因此未公开评价与联系方式均无外出口径。
      abilities.push({
        unit: conclusion.unit,
        rule_version: conclusion.rule_version,
        confirmed_at: confirmed.at,
        confirmed_by: confirmed.orgs.map((o) => ({ org_id: o.org_id, name: o.name })),
      });
    }
    return {
      person_id: person.person_id,
      name: person.name,
      // 刻意不含 contact；调用方拿到的对象里没有任何联系方式字段。
      scope: consent.scope,
      issued_for: consent.target_org_id,
      abilities,
    };
  }

  // ---------- 排班 ----------

  assignShift(input, commandId) {
    return this.#run(commandId ?? input.command_id, (s) => {
      const shift = s.shifts.get(input.shift_id);
      if (!shift) throw new Error("班次不存在");
      if (shift.status !== "open") throw new Error("班次已关闭");
      const events = [];
      const id = this.#assignIfPossible(events, shift, input.at, "人工排班");
      if (!id) throw new Error("当前没有满足条件的人选");
      return events;
    });
  }

  #assignIfPossible(events, shift, at, reason, ruleVersion) {
    // 始终基于"已落库 + 本批"的最新重放挑选人选，本批内的新安排/失效都会被计入。
    const s = this.#replay(events);
    const version = ruleVersion ?? this.#rule(s).version;
    const candidate = this.#eligiblePersons(s, shift, { ruleVersion: version })[0];
    if (!candidate) return null;
    const assignmentId = this.#nextId(events, `assignment-${shift.shift_id}`, "AssignmentCreated");
    events.push(
      GrowthService.event("AssignmentCreated", {
        assignment_id: assignmentId,
        shift_id: shift.shift_id,
        position_id: shift.position_id,
        studio_id: shift.studio_id,
        person_id: candidate.person_id,
        rule_version: candidate.rule_version,
        required_units: candidate.required_units,
        reason,
        at,
      })
    );
    return assignmentId;
  }

  #eligiblePersons(s, shift, opts = {}) {
    const studio = s.studios.get(shift.studio_id);
    const version = opts.ruleVersion ?? this.#rule(s).version;
    if (!studio || studio.status !== "active") return [];
    if (shift.mentor_id && !studio.mentors.includes(shift.mentor_id)) return [];

    const out = [];
    for (const person of s.persons.values()) {
      const report = this.#qualification(s, person.person_id, shift, version);
      if (report.eligible) {
        out.push({
          person_id: person.person_id,
          rule_version: version,
          required_units: report.required_units,
        });
      }
    }
    return out;
  }

  // 岗位要求分两类：
  //  - 技能项（擀皮、二十四褶……）：须有"满足"结论且经学校与工作室共同确认；
  //  - 硬门槛（食品安全合规）：规则直接规定，有任一有效证据即通过，不参与多源加权。
  #qualification(s, personId, shift, ruleVersion, ignoreAssignmentId = null) {
    const rule = ruleAt(ruleVersion);
    const position = s.positions.get(shift.position_id);
    const skillUnits = position?.required_skills ?? [];
    const gateUnits = rule.hard_gate;
    const deficits = [];
    for (const unit of skillUnits) {
      const r = this.#confirmedSkill(s, personId, unit);
      if (!r.ok) deficits.push({ unit, reason: r.reason });
    }
    for (const unit of gateUnits) {
      const has = this.#activeEvidenceOf(s, personId).some((e) => e.unit === unit);
      if (!has) deficits.push({ unit, reason: "硬门槛未通过：尚未取得有效凭证" });
    }
    const conflicts = this.#timeConflicts(s, personId, shift, ignoreAssignmentId);
    return {
      eligible: deficits.length === 0 && conflicts.length === 0,
      deficits,
      conflicts: conflicts.map((a) => a.assignment_id),
      required_units: [...new Set([...skillUnits, ...gateUnits])],
      rule_version: rule.version,
    };
  }

  #confirmedSkill(s, personId, unit) {
    let latest = null;
    for (const conclusion of s.conclusions.values()) {
      if (conclusion.person_id === personId && conclusion.unit === unit) latest = conclusion;
    }
    if (!latest || latest.status !== "active") {
      return { ok: false, reason: "尚无结论" };
    }
    if (!latest.satisfied) {
      const missing = latest.missing_sources?.length
        ? `仍缺来源：${latest.missing_sources.join("、")}`
        : "证据不足";
      return { ok: false, reason: missing };
    }
    const confirmed = this.#confirmers(s, latest);
    if (!confirmed.complete) {
      return { ok: false, reason: `缺少${confirmed.missingSide === "school" ? "学校" : "工作室"}确认` };
    }
    return { ok: true, conclusion: latest, confirmed };
  }

  #activeEvidenceOf(s, personId) {
    return [...s.evidence.values()].filter(
      (e) => e.person_id === personId && e.status === "active"
    );
  }

  #confirmers(s, conclusion) {
    const rows = [...s.confirmations.values()].filter(
      (c) => c.conclusion_id === conclusion.conclusion_id && c.status === "active"
    );
    const orgs = rows.map((c) => s.orgs.get(c.org_id)).filter(Boolean);
    const types = new Set(orgs.map((o) => o.org_type));
    const complete = types.has("school") && types.has("studio");
    const missingSide = !types.has("school") ? "school" : !types.has("studio") ? "studio" : null;
    return {
      complete,
      missingSide,
      orgs,
      at: rows.map((r) => r.at).sort().at(-1),
    };
  }

  #timeConflicts(s, personId, shift, ignoreAssignmentId = null) {
    return [...s.assignments.values()].filter((a) => {
      if (a.status !== "active" || a.person_id !== personId) return false;
      if (ignoreAssignmentId && a.assignment_id === ignoreAssignmentId) return false;
      const other = s.shifts.get(a.shift_id);
      if (!other) return false;
      return other.start < shift.end && shift.start < other.end;
    });
  }

  #syncAssignments(events, at, opts) {
    // 重放本批已产生的事件（暂停、撤回、新结论、规则发布等），据此核对现行安排。
    const s = this.#replay(events);
    const ruleVersion = opts.ruleVersion ?? this.#rule(s).version;
    // 第一阶段：找出所有不再成立的安排，先写失效事件（历史留下失效原因）。
    const invalidated = [];
    for (const assignment of [...s.assignments.values()]) {
      if (assignment.status !== "active") continue;
      if (opts.personId && assignment.person_id !== opts.personId) continue;
      if (opts.studioId && assignment.studio_id !== opts.studioId) continue;
      const shift = s.shifts.get(assignment.shift_id);
      if (!shift) continue;
      if (opts.mentorId && shift.mentor_id !== opts.mentorId) continue;

      // 逐能力复核（含新规则门槛）与时间、工坊、导师状态复核。
      const report = this.#qualification(
        s,
        assignment.person_id,
        shift,
        ruleVersion,
        assignment.assignment_id
      );
      const failed = report.deficits.map((d) => `${d.unit}（${d.reason}）`);
      if (report.conflicts.length > 0) failed.push("时间冲突");
      const studio = s.studios.get(assignment.studio_id);
      if (studio?.status === "paused") failed.push("工坊暂停生产");
      if (studio && shift.mentor_id && !studio.mentors.includes(shift.mentor_id)) {
        failed.push("导师停带");
      }
      if (failed.length === 0) continue;

      const event = GrowthService.event("AssignmentInvalidated", {
        assignment_id: assignment.assignment_id,
        shift_id: assignment.shift_id,
        person_id: assignment.person_id,
        replacement_assignment_id: null,
        reason: `${opts.reason ?? "条件变化"}：${failed.join("；")}`,
        at,
      });
      events.push(event);
      invalidated.push({ shift, studio, event });
    }
    // 第二阶段：失效之后立即重算；仍在生产的工坊若有合格人选，产生新安排并回填链接。
    for (const { shift, studio, event } of invalidated) {
      if (!studio || studio.status !== "active") continue;
      const replacementId = this.#assignIfPossible(
        events,
        shift,
        at,
        `原安排失效后重算（${opts.reason ?? "条件变化"}）`,
        ruleVersion
      );
      event.payload.replacement_assignment_id = replacementId;
    }
  }

  // 复工后，为该工坊所有"没有现行安排"的开放班次重新排班。
  #reopenShifts(events, studioId, at) {
    const s = this.#replay(events);
    for (const shift of s.shifts.values()) {
      if (shift.studio_id !== studioId || shift.status !== "open") continue;
      const covered = [...s.assignments.values()].some(
        (a) => a.shift_id === shift.shift_id && a.status === "active"
      );
      if (covered) continue;
      // 重放会把本批刚建的安排也算进去，因此不会重复排同一班次。
      this.#assignIfPossible(events, shift, at, "工坊复工后重算");
    }
  }

  #rule(s, version) {
    const v = version ?? s.current_rule ?? "rule-v1";
    return ruleAt(v);
  }

  // ---------- 读模型 ----------

  // 门店一次查询：上岗决定 → 课程、作品、确认者、规则版本、仍缺训练全链路。
  onboarding(assignmentId) {
    const s = this.state;
    const assignment = s.assignments.get(assignmentId);
    if (!assignment) throw new Error("上岗决定不存在");
    const shift = s.shifts.get(assignment.shift_id);
    const position = s.positions.get(assignment.position_id);
    const studio = s.studios.get(assignment.studio_id);
    const person = s.persons.get(assignment.person_id);
    const rule = ruleAt(assignment.rule_version);

    const trace = [];
    const missing = [];
    const skillUnits = position?.required_skills ?? [];
    const gateUnits = rule.hard_gate;
    for (const unit of skillUnits) {
      const ability = this.#confirmedSkill(s, person.person_id, unit);
      if (!ability.ok) {
        missing.push({ unit, reason: ability.reason });
        continue;
      }
      const c = ability.conclusion;
      const evidence = c.evidence_ids.map((id) => {
        const e = s.evidence.get(id);
        return {
          evidence_id: id,
          source_type: e.source_type,
          source_org: s.orgs.get(e.org_id)?.name,
          course: e.course_id ? s.courses.get(e.course_id)?.title ?? e.course_id : null,
          stage: e.stage,
          grade: e.grade,
          work: e.work_id
            ? { work_id: e.work_id, title: e.work_title, contribution: e.contribution }
            : null,
          observed_at: e.observed_at,
        };
      });
      trace.push({
        unit,
        kind: "skill",
        conclusion_id: c.conclusion_id,
        rule_version: c.rule_version,
        derived_at: c.at,
        satisfied: c.satisfied,
        confirmers: ability.confirmed.orgs.map((o) => ({
          org_id: o.org_id,
          name: o.name,
          org_type: o.org_type,
        })),
        evidence,
      });
    }
    for (const unit of gateUnits) {
      const gateEvidence = this.#activeEvidenceOf(s, person.person_id).filter((e) => e.unit === unit);
      if (gateEvidence.length === 0) {
        missing.push({ unit, reason: "硬门槛未通过：尚未取得有效凭证" });
        continue;
      }
      trace.push({
        unit,
        kind: "hard_gate",
        rule_version: rule.version,
        evidence: gateEvidence.map((e) => ({
          evidence_id: e.evidence_id,
          source_type: e.source_type,
          source_org: s.orgs.get(e.org_id)?.name,
          observed_at: e.observed_at,
        })),
      });
    }

    return {
      assignment: {
        assignment_id: assignment.assignment_id,
        status: assignment.status,
        decided_at: assignment.at,
        reason: assignment.reason,
        invalidated_at: assignment.invalidated_at ?? null,
        invalid_reason: assignment.invalid_reason ?? null,
        replaced_by: assignment.replacement_assignment_id,
      },
      shift: { shift_id: shift.shift_id, start: shift.start, end: shift.end },
      position: position?.title,
      studio: { studio_id: studio.studio_id, name: studio.name, craft: studio.craft },
      person: { person_id: person.person_id, name: person.name },
      rule_version: assignment.rule_version,
      abilities: trace,
      missing_training: missing,
    };
  }

  shiftCandidates(shiftId) {
    const s = this.state;
    const shift = s.shifts.get(shiftId);
    if (!shift) throw new Error("班次不存在");
    const version = this.#rule(s).version;
    return [...s.persons.values()].map((person) => {
      const report = this.#qualification(s, person.person_id, shift, version);
      return {
        person_id: person.person_id,
        name: person.name,
        eligible: report.eligible,
        deficits: report.deficits,
        time_conflicts: report.conflicts,
      };
    });
  }

  portableView(consentId) {
    const s = this.state;
    const consent = s.consents.get(consentId);
    if (!consent) throw new Error("授权不存在");
    if (consent.status !== "granted") throw new Error("授权已撤回");
    return this.#buildSummary(s, consent);
  }
}
