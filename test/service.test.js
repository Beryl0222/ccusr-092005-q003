import assert from "node:assert/strict";
import test from "node:test";

import { resetSeq } from "../src/events.js";
import { ingestSeed } from "../src/ingest.js";
import { ApprenticeshipService, reduce } from "../src/service.js";

const SCHOOL = { org: "东城技能培训学校", by: "教务处" };
const STUDIO = { org: "老字号大师工作室", by: "王大师" };
const STUDIO2 = { org: "城西分号大师工作室", by: "李大师" };

async function seeded() {
  resetSeq();
  const svc = new ApprenticeshipService();
  await ingestSeed(svc);
  return svc;
}

const apprenticeA = {
  apprenticeId: "appr-a",
  name: "阿麦",
  courseId: "course-2026-fall",
  contact: { phone: "138-0000-0001", address: "东街1号" },
};
const apprenticeB = {
  apprenticeId: "appr-b",
  name: "阿包",
  courseId: "course-2026-fall",
  contact: { phone: "138-0000-0002" },
};

function submitBothSides(svc, apprenticeId, skill, { schoolRef = "成绩单", studioRef = "观察记录" } = {}) {
  svc.submitEvidence({
    apprenticeId,
    skill,
    sourceType: "school_grade",
    sourceRef: schoolRef,
    detail: "课程考核合格",
    submittedBy: SCHOOL.by,
    at: "2026-09-20T08:00:00.000Z",
  });
  svc.submitEvidence({
    apprenticeId,
    skill,
    sourceType: "mentor_observation",
    sourceRef: studioRef,
    detail: "师傅现场观察：手法稳定（未公开评价）",
    submittedBy: STUDIO.by,
    at: "2026-09-20T09:00:00.000Z",
  });
}

test("种子数据：既有工作室与课程被纳入服务并保留稳定标识", async () => {
  const svc = await seeded();
  assert.deepEqual([...svc.state.studios.keys()], ["studio-shaomai-01"]);
  assert.deepEqual([...svc.state.courses.keys()], ["course-2026-fall"]);
  assert.deepEqual(svc.state.studios.get("studio-shaomai-01").requiredSkills, ["擀皮", "二十四褶", "蒸制"]);
});

test("烧麦学徒：三源互不相认时不认定；补齐两侧证据后由校室共同确认", async () => {
  const svc = await seeded();
  svc.enroll(apprenticeA);

  // 只有学校成绩，师傅观察与门店作品尚未对接
  svc.submitEvidence({
    apprenticeId: "appr-a",
    skill: "二十四褶",
    sourceType: "school_grade",
    sourceRef: "成绩单#42",
    submittedBy: SCHOOL.by,
    at: "2026-09-20T08:00:00.000Z",
  });

  const first = svc.confirmCompetence(
    "appr-a",
    "二十四褶",
    { at: "2026-09-21T00:00:00.000Z", confirmers: { school: SCHOOL, studio: STUDIO } }
  );
  assert.equal(first.result, "insufficient");
  assert.deepEqual(first.missing, ["studio"]);
  assert.equal(first.ruleVersion, "v2");

  // 补上师傅观察与门店作品（工作室侧）
  submitBothSides(svc, "appr-a", "二十四褶", { schoolRef: "成绩单#42" });
  const second = svc.confirmCompetence(
    "appr-a",
    "二十四褶",
    { at: "2026-09-22T00:00:00.000Z", confirmers: { school: SCHOOL, studio: STUDIO } }
  );
  assert.equal(second.result, "confirmed");
  assert.equal(second.supersedes, first.decisionId);

  // 历史结论仍在，且新结论是链尾
  const chain = svc.state.decisions.get("appr-a|二十四褶");
  assert.equal(chain.length, 2);
  assert.equal(chain[0].result, "insufficient");
});

test("认定必须校室双方共同确认，单方确认被拒绝", async () => {
  const svc = await seeded();
  svc.enroll(apprenticeA);
  assert.throws(
    () => svc.confirmCompetence("appr-a", "擀皮", { confirmers: { school: SCHOOL } }),
    /双方共同确认/
  );
});

test("证据各带来源：成绩、观察、课程目标、作品互不覆盖", async () => {
  const svc = await seeded();
  svc.enroll(apprenticeA);
  submitBothSides(svc, "appr-a", "擀皮");
  const evs = [...svc.state.evidences.values()];
  assert.equal(evs.length, 2);
  assert.deepEqual(new Set(evs.map((e) => e.sourceType)), new Set(["school_grade", "mentor_observation"]));
});

test("同一证据重复提交幂等，不产生重复事件、不重复出结论", async () => {
  const svc = await seeded();
  svc.enroll(apprenticeA);
  submitBothSides(svc, "appr-a", "蒸制");
  svc.confirmCompetence("appr-a", "蒸制", {
    at: "2026-09-22T00:00:00.000Z",
    confirmers: { school: SCHOOL, studio: STUDIO },
  });
  const eventsBefore = svc.log.length;

  const r1 = svc.submitEvidence({
    apprenticeId: "appr-a",
    skill: "蒸制",
    sourceType: "school_grade",
    sourceRef: "成绩单",
    submittedBy: SCHOOL.by,
    at: "2026-09-23T08:00:00.000Z",
  });
  const r2 = svc.submitEvidence({
    apprenticeId: "appr-a",
    skill: "蒸制",
    sourceType: "school_grade",
    sourceRef: "成绩单",
    submittedBy: SCHOOL.by,
    at: "2026-09-23T09:00:00.000Z",
  });
  assert.equal(r1.duplicated, true);
  assert.equal(r2.duplicated, true);
  assert.equal(svc.log.length, eventsBefore);
});

test("撤回证据只产生新结论：能力转为不足，但历史证据与历史结论保留", async () => {
  const svc = await seeded();
  svc.enroll(apprenticeA);
  submitBothSides(svc, "appr-a", "二十四褶");
  const confirmed = svc.confirmCompetence("appr-a", "二十四褶", {
    at: "2026-09-22T00:00:00.000Z",
    confirmers: { school: SCHOOL, studio: STUDIO },
  });
  const studioEvidence = [...svc.state.evidences.values()].find((e) => e.sourceType === "mentor_observation");

  svc.withdrawEvidence(studioEvidence.evidenceId, {
    reason: "观察记录归属另一学徒，门店申请撤回",
    at: "2026-09-25T00:00:00.000Z",
  });

  const chain = svc.state.decisions.get("appr-a|二十四褶");
  assert.equal(chain.length, 2);
  const next = chain.at(-1);
  assert.equal(next.result, "insufficient");
  assert.equal(next.supersedes, confirmed.decisionId);
  assert.equal(next.withdrawnSince, studioEvidence.evidenceId);
  // 历史没有被抹掉
  assert.equal(chain[0].result, "confirmed");
  assert.equal(svc.state.evidences.get(studioEvidence.evidenceId).withdrawn, true);
  assert.ok(svc.log.events.some((e) => e.type === "EvidenceWithdrawn"));
});

test("协作作品逐人写明贡献：有署名贡献者计入，旁观者不计", async () => {
  const svc = await seeded();
  svc.enroll(apprenticeA);
  svc.enroll(apprenticeB);
  svc.recordWork({ workId: "work-77", title: "秋分宴客烧麦", shopRef: "门店2号蒸柜", at: "2026-09-18T10:00:00.000Z" });

  // 学校侧先具备
  svc.submitEvidence({
    apprenticeId: "appr-b",
    skill: "擀皮",
    sourceType: "school_grade",
    sourceRef: "成绩单#58",
    submittedBy: SCHOOL.by,
    at: "2026-09-18T08:00:00.000Z",
  });

  // 阿麦独立完成二十四褶；阿包仅协助备料，擀皮由阿麦完成
  svc.recordContribution({
    workId: "work-77",
    apprenticeId: "appr-a",
    skill: "二十四褶",
    contribution: "独立捏制全部二十四褶",
    attestedBy: STUDIO.by,
    at: "2026-09-18T12:00:00.000Z",
  });
  svc.recordContribution({
    workId: "work-77",
    apprenticeId: "appr-a",
    skill: "擀皮",
    contribution: "擀制成品皮 40 张",
    attestedBy: STUDIO.by,
    at: "2026-09-18T12:05:00.000Z",
  });
  svc.recordContribution({
    workId: "work-77",
    apprenticeId: "appr-b",
    skill: "备料",
    contribution: "称量糯米与肉馅",
    attestedBy: STUDIO.by,
    at: "2026-09-18T12:10:00.000Z",
  });

  // 阿包的擀皮没有任何本人贡献证据 → 工作室侧缺失
  svc.submitEvidence({
    apprenticeId: "appr-a",
    skill: "擀皮",
    sourceType: "school_grade",
    sourceRef: "成绩单#43",
    submittedBy: SCHOOL.by,
    at: "2026-09-18T07:00:00.000Z",
  });
  const decA = svc.confirmCompetence("appr-a", "擀皮", {
    at: "2026-09-19T00:00:00.000Z",
    confirmers: { school: SCHOOL, studio: STUDIO },
  });
  const decB = svc.confirmCompetence("appr-b", "擀皮", {
    at: "2026-09-19T00:00:00.000Z",
    confirmers: { school: SCHOOL, studio: STUDIO },
  });
  assert.equal(decA.result, "confirmed");
  assert.equal(decB.result, "insufficient");
  assert.deepEqual(decB.missing, ["studio"]);
});

test("规则升级：v1 下的认定保留 v1 版本号；按 v2 重确认后历史可溯且可能失效", async () => {
  const svc = await seeded();
  svc.enroll(apprenticeA);
  // v1 时期仅凭学校成绩即认定
  svc.submitEvidence({
    apprenticeId: "appr-a",
    skill: "擀皮",
    sourceType: "school_grade",
    sourceRef: "成绩单#43",
    submittedBy: SCHOOL.by,
    at: "2026-09-05T08:00:00.000Z",
  });
  const v1dec = svc.confirmCompetence("appr-a", "擀皮", {
    at: "2026-09-06T00:00:00.000Z",
    ruleVersion: "v1",
    confirmers: { school: SCHOOL, studio: STUDIO },
  });
  assert.equal(v1dec.result, "confirmed");
  assert.equal(v1dec.ruleVersion, "v1");

  // 升级到 v2：缺工作室侧 → 新结论不足，旧 v1 结论仍在链上
  const v2dec = svc.upgradeConfirmation("appr-a", "擀皮", {
    at: "2026-09-16T00:00:00.000Z",
    confirmers: { school: SCHOOL, studio: STUDIO },
  });
  assert.equal(v2dec.ruleVersion, "v2");
  assert.equal(v2dec.result, "insufficient");
  assert.equal(svc.state.decisions.get("appr-a|擀皮")[0].ruleVersion, "v1");
});

test("食品安全：未通过者不能进生产班；通过后可匹配", async () => {
  const svc = await seeded();
  svc.enroll(apprenticeB);
  for (const skill of ["擀皮", "二十四褶", "蒸制"]) {
    submitBothSides(svc, "appr-b", skill);
    svc.confirmCompetence("appr-b", skill, {
      at: "2026-09-22T00:00:00.000Z",
      confirmers: { school: SCHOOL, studio: STUDIO },
    });
  }
  svc.assignMentor({ mentorId: "mentor-wang", name: "王大师", studioId: "studio-shaomai-01" });
  const shiftId = "shift-1001";
  svc.openShift({
    shiftId,
    studioId: "studio-shaomai-01",
    mentorId: "mentor-wang",
    station: "2号蒸柜",
    start: "2026-10-01T01:00:00.000Z",
    end: "2026-10-01T05:00:00.000Z",
    requiredSkills: ["擀皮", "二十四褶", "蒸制"],
  });

  const rejected = svc.evaluateAssignment(shiftId, "appr-b", { at: "2026-09-26T00:00:00.000Z" });
  assert.equal(rejected.result, "rejected");
  assert.ok(rejected.reasons.includes("尚未通过食品安全环节"));

  svc.clearFoodSafety("appr-b", { ref: "食安考核2026-09", at: "2026-09-27T00:00:00.000Z" });
  const assigned = svc.evaluateAssignment(shiftId, "appr-b", { at: "2026-09-27T01:00:00.000Z" });
  assert.equal(assigned.result, "assigned");
});

test("时间冲突：同一时间只能匹配不冲突的班次", async () => {
  const svc = await seeded();
  svc.enroll(apprenticeB);
  for (const skill of ["擀皮", "二十四褶", "蒸制"]) {
    submitBothSides(svc, "appr-b", skill);
    svc.confirmCompetence("appr-b", skill, {
      at: "2026-09-22T00:00:00.000Z",
      confirmers: { school: SCHOOL, studio: STUDIO },
    });
  }
  svc.clearFoodSafety("appr-b", { ref: "食安考核", at: "2026-09-23T00:00:00.000Z" });
  svc.assignMentor({ mentorId: "mentor-wang", studioId: "studio-shaomai-01" });
  svc.openShift({
    shiftId: "shift-morning",
    studioId: "studio-shaomai-01",
    mentorId: "mentor-wang",
    station: "2号蒸柜",
    start: "2026-10-02T01:00:00.000Z",
    end: "2026-10-02T05:00:00.000Z",
    requiredSkills: ["擀皮", "二十四褶", "蒸制"],
  });
  svc.openShift({
    shiftId: "shift-overlap",
    studioId: "studio-shaomai-01",
    mentorId: "mentor-wang",
    station: "3号蒸柜",
    start: "2026-10-02T04:00:00.000Z",
    end: "2026-10-02T08:00:00.000Z",
    requiredSkills: ["擀皮", "二十四褶", "蒸制"],
  });
  assert.equal(svc.evaluateAssignment("shift-morning", "appr-b").result, "assigned");
  const second = svc.evaluateAssignment("shift-overlap", "appr-b");
  assert.equal(second.result, "rejected");
  assert.ok(second.reasons.some((r) => r.includes("时间冲突")));
});

test("门店一次查看即可追到课程、作品、确认者、规则版本及仍缺训练", async () => {
  const svc = await seeded();
  svc.enroll(apprenticeA);
  svc.submitEvidence({
    apprenticeId: "appr-a",
    skill: "二十四褶",
    sourceType: "course_objective",
    sourceRef: "course-2026-fall#独立制作",
    detail: "课程目标：独立制作阶段",
    submittedBy: SCHOOL.by,
    at: "2026-09-10T00:00:00.000Z",
  });
  svc.recordWork({ workId: "work-9", title: "节气礼盒烧麦", shopRef: "门店展柜", at: "2026-09-19T10:00:00.000Z" });
  svc.recordContribution({
    workId: "work-9",
    apprenticeId: "appr-a",
    skill: "二十四褶",
    contribution: "独立捏制",
    attestedBy: STUDIO.by,
    at: "2026-09-19T12:00:00.000Z",
  });
  const dec = svc.confirmCompetence("appr-a", "二十四褶", {
    at: "2026-09-20T00:00:00.000Z",
    confirmers: { school: SCHOOL, studio: STUDIO },
  });
  svc.clearFoodSafety("appr-a", { ref: "食安考核", at: "2026-09-21T00:00:00.000Z" });
  svc.assignMentor({ mentorId: "mentor-wang", studioId: "studio-shaomai-01" });
  svc.openShift({
    shiftId: "shift-900",
    studioId: "studio-shaomai-01",
    mentorId: "mentor-wang",
    station: "展柜岗",
    start: "2026-10-03T01:00:00.000Z",
    end: "2026-10-03T05:00:00.000Z",
    requiredSkills: ["二十四褶"],
  });
  const asg = svc.evaluateAssignment("shift-900", "appr-a", { at: "2026-09-22T00:00:00.000Z" });
  assert.equal(asg.result, "assigned");

  const view = svc.viewAssignment(asg.assignmentId);
  const skillLine = view.trace.skillResults[0];
  assert.equal(skillLine.confirmed, true);
  assert.equal(skillLine.ruleVersion, "v2");
  assert.equal(skillLine.confirmers.school.org, SCHOOL.org);
  assert.equal(skillLine.confirmers.studio.org, STUDIO.org);
  const kinds = skillLine.evidences.map((e) => e.kind);
  assert.ok(kinds.includes("课程记录"));
  assert.ok(kinds.includes("门店作品"));
  // 追溯不含未公开评价原文与联系方式
  assert.equal(JSON.stringify(view).includes("未公开评价"), false);
  assert.equal(JSON.stringify(view).includes("138-0000"), false);
  assert.equal(dec.decisionId, svc.state.currentDecision("appr-a", "二十四褶").decisionId);
});

test("仍缺训练：能力未认定的上岗决定明确列出缺失侧", async () => {
  const svc = await seeded();
  svc.enroll(apprenticeA);
  svc.assignMentor({ mentorId: "mentor-wang", studioId: "studio-shaomai-01" });
  svc.openShift({
    shiftId: "shift-x",
    studioId: "studio-shaomai-01",
    mentorId: "mentor-wang",
    station: "2号蒸柜",
    start: "2026-10-04T01:00:00.000Z",
    end: "2026-10-04T05:00:00.000Z",
    requiredSkills: ["擀皮"],
  });
  const rejected = svc.evaluateAssignment("shift-x", "appr-a", { at: "2026-09-26T00:00:00.000Z" });
  assert.equal(rejected.result, "rejected");
  const line = rejected.trace.skillResults[0];
  assert.equal(line.confirmed, false);
  assert.ok(line.missingTraining.includes("尚未取得任何共同确认"));
});

test("转机构携带：仅导出本人授权的能力摘要，联系方式与未公开评价不流出", async () => {
  const svc = await seeded();
  svc.enroll(apprenticeA);
  submitBothSides(svc, "appr-a", "擀皮");
  submitBothSides(svc, "appr-a", "二十四褶");
  for (const skill of ["擀皮", "二十四褶"]) {
    svc.confirmCompetence("appr-a", skill, {
      at: "2026-09-22T00:00:00.000Z",
      confirmers: { school: SCHOOL, studio: STUDIO },
    });
  }
  // 学徒只授权携带"擀皮"
  const consentId = svc.grantConsent({
    apprenticeId: "appr-a",
    scope: ["擀皮"],
    toStudioId: "studio-chengxi",
    at: "2026-09-28T00:00:00.000Z",
  });
  const { summary } = svc.exportSummary("appr-a", {
    consentId,
    toStudioId: "studio-chengxi",
    at: "2026-09-28T01:00:00.000Z",
  });
  assert.deepEqual(summary.skills.map((s) => s.skill), ["擀皮"]);
  assert.equal("contact" in summary, false);
  assert.equal(JSON.stringify(summary).includes("138-0000"), false);
  assert.equal(JSON.stringify(summary).includes("未公开评价"), false);
  assert.equal(summary.skills[0].confirmedBy.school, SCHOOL.org);

  // 授权撤回后，接收方不再能访问该摘要
  const visible = svc.accessibleExportsFor("studio-chengxi");
  assert.equal(visible.length, 1);
  svc.revokeConsent(consentId, { at: "2026-09-29T00:00:00.000Z" });
  assert.deepEqual(svc.accessibleExportsFor("studio-chengxi"), []);
  // 撤回后再次导出被拒绝
  assert.throws(
    () => svc.exportSummary("appr-a", { consentId, toStudioId: "studio-chengxi" }),
    /授权无效或已撤回/
  );
});

test("导出目标与授权目的工作室不一致时拒绝", async () => {
  const svc = await seeded();
  svc.enroll(apprenticeA);
  const consentId = svc.grantConsent({
    apprenticeId: "appr-a",
    scope: [],
    toStudioId: "studio-chengxi",
    at: "2026-09-28T00:00:00.000Z",
  });
  assert.throws(
    () => svc.exportSummary("appr-a", { consentId, toStudioId: "studio-other" }),
    /目的工作室/
  );
});

test("跨机构确认：双方机构与确认人都记录在结论上", async () => {
  const svc = await seeded();
  svc.enroll(apprenticeA);
  submitBothSides(svc, "appr-a", "蒸制");
  const dec = svc.confirmCompetence("appr-a", "蒸制", {
    at: "2026-09-22T00:00:00.000Z",
    confirmers: { school: SCHOOL, studio: STUDIO2 },
  });
  assert.equal(dec.result, "confirmed");
  assert.equal(dec.confirmers.studio.org, "城西分号大师工作室");
});

function fullyQualified(svc, apprenticeId) {
  svc.enroll({ ...(apprenticeId === "appr-a" ? apprenticeA : apprenticeB) });
  for (const skill of ["擀皮", "二十四褶", "蒸制"]) {
    submitBothSides(svc, apprenticeId, skill);
    svc.confirmCompetence(apprenticeId, skill, {
      at: "2026-09-22T00:00:00.000Z",
      confirmers: { school: SCHOOL, studio: STUDIO },
    });
  }
  svc.clearFoodSafety(apprenticeId, { ref: "食安考核", at: "2026-09-23T00:00:00.000Z" });
}

test("导师停带：在班安排自动失效、班次挂起；重新指派导师后自动重算", async () => {
  const svc = await seeded();
  fullyQualified(svc, "appr-a");
  svc.assignMentor({ mentorId: "mentor-wang", studioId: "studio-shaomai-01" });
  svc.openShift({
    shiftId: "shift-s1",
    studioId: "studio-shaomai-01",
    mentorId: "mentor-wang",
    station: "2号蒸柜",
    start: "2026-10-05T01:00:00.000Z",
    end: "2026-10-05T05:00:00.000Z",
    requiredSkills: ["擀皮", "二十四褶", "蒸制"],
  });
  const asg = svc.evaluateAssignment("shift-s1", "appr-a", { at: "2026-09-26T00:00:00.000Z" });
  assert.equal(asg.result, "assigned");

  svc.mentorStopped("mentor-wang", { at: "2026-09-30T00:00:00.000Z" });
  const voided = svc.viewAssignment(asg.assignmentId);
  assert.equal(voided.void, true);
  assert.equal(voided.voidReason, "导师停带");
  assert.equal(svc.state.shifts.get("shift-s1").mentorSuspended, true);
  // 挂起期间评估任何人都不上岗
  assert.equal(
    svc.eligibilityTrace("shift-s1", "appr-a", { at: "2026-09-30T01:00:00.000Z" }).eligible,
    false
  );

  // 新导师到任后自动重算，阿麦重新上岗，旧安排仍保留作废记录
  svc.assignMentor({ mentorId: "mentor-zhao", name: "赵大师", studioId: "studio-shaomai-01" });
  const recalced = svc.replaceShiftMentor("shift-s1", "mentor-zhao", { at: "2026-09-30T02:00:00.000Z" });
  assert.equal(recalced.length, 1);
  assert.equal(recalced[0].apprenticeId, "appr-a");
  const shift = svc.state.shifts.get("shift-s1");
  assert.equal(shift.assignments.length, 2);
  assert.equal(shift.assignments[0].void, true);
  assert.equal(shift.assignments[1].void, false);
});

test("工坊暂停生产：安排失效；复工后自动重算，停产期间不排人", async () => {
  const svc = await seeded();
  fullyQualified(svc, "appr-a");
  svc.assignMentor({ mentorId: "mentor-wang", studioId: "studio-shaomai-01" });
  svc.openShift({
    shiftId: "shift-p1",
    studioId: "studio-shaomai-01",
    mentorId: "mentor-wang",
    station: "2号蒸柜",
    start: "2026-10-06T01:00:00.000Z",
    end: "2026-10-06T05:00:00.000Z",
    requiredSkills: ["擀皮", "二十四褶", "蒸制"],
  });
  const asg = svc.evaluateAssignment("shift-p1", "appr-a", { at: "2026-09-26T00:00:00.000Z" });

  svc.productionPaused("studio-shaomai-01", { at: "2026-10-05T00:00:00.000Z" });
  assert.equal(svc.viewAssignment(asg.assignmentId).void, true);
  assert.equal(
    svc.eligibilityTrace("shift-p1", "appr-a", { at: "2026-10-05T01:00:00.000Z" }).eligible,
    false
  );

  const recalced = svc.productionResumed("studio-shaomai-01", { at: "2026-10-05T12:00:00.000Z" });
  assert.equal(recalced.length, 1);
  assert.equal(recalced[0].apprenticeId, "appr-a");
});

test("重算只选能力满足且食安通过、时间不冲突的人：不合格者不会被排进班", async () => {
  const svc = await seeded();
  // appr-a 完全合格；appr-b 能力齐全但未过食安
  fullyQualified(svc, "appr-a");
  svc.enroll(apprenticeB);
  for (const skill of ["擀皮", "二十四褶", "蒸制"]) {
    submitBothSides(svc, "appr-b", skill);
    svc.confirmCompetence("appr-b", skill, {
      at: "2026-09-22T00:00:00.000Z",
      confirmers: { school: SCHOOL, studio: STUDIO },
    });
  }
  svc.assignMentor({ mentorId: "mentor-wang", studioId: "studio-shaomai-01" });
  svc.openShift({
    shiftId: "shift-r",
    studioId: "studio-shaomai-01",
    mentorId: "mentor-wang",
    station: "2号蒸柜",
    start: "2026-10-07T01:00:00.000Z",
    end: "2026-10-07T05:00:00.000Z",
    capacity: 2,
    requiredSkills: ["擀皮", "二十四褶", "蒸制"],
  });
  svc.productionPaused("studio-shaomai-01", { at: "2026-10-01T00:00:00.000Z" });
  const recalced = svc.productionResumed("studio-shaomai-01", { at: "2026-10-02T00:00:00.000Z" });
  assert.deepEqual(recalced.map((r) => r.apprenticeId), ["appr-a"]);
});

test("事件日志只增：任何撤回、升级、作废都不删除或改写既有事件", async () => {
  const svc = await seeded();
  fullyQualified(svc, "appr-a");
  svc.assignMentor({ mentorId: "mentor-wang", studioId: "studio-shaomai-01" });
  svc.openShift({
    shiftId: "shift-audit",
    studioId: "studio-shaomai-01",
    mentorId: "mentor-wang",
    station: "2号蒸柜",
    start: "2026-10-08T01:00:00.000Z",
    end: "2026-10-08T05:00:00.000Z",
    requiredSkills: ["擀皮", "二十四褶", "蒸制"],
  });
  const asg = svc.evaluateAssignment("shift-audit", "appr-a");
  const evidence = [...svc.state.evidences.values()][0];
  const snapshot = svc.log.events.map((e) => ({ ...e, payload: { ...e.payload } }));
  const lengthBefore = svc.log.length;

  svc.withdrawEvidence(evidence.evidenceId, { reason: "审计撤回", at: "2026-10-01T00:00:00.000Z" });
  svc.mentorStopped("mentor-wang", { at: "2026-10-02T00:00:00.000Z" });

  assert.ok(svc.log.length > lengthBefore);
  // 前序事件逐一保持不变
  for (let i = 0; i < snapshot.length; i++) {
    assert.deepEqual(svc.log.events[i], snapshot[i]);
  }
  // 折叠重放与当前状态一致
  const replayed = reduce(svc.log.events);
  const voidAgain = [...replayed.shifts.get("shift-audit").assignments].find((a) => a.assignmentId === asg.assignmentId);
  assert.equal(voidAgain.void, true);
});
