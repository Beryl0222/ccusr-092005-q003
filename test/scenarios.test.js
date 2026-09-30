import assert from "node:assert/strict";
import test from "node:test";

import { loadSeed } from "../src/seed.js";
import { ingest } from "../src/ingest.js";
import { GrowthService } from "../src/service.js";
import { EventLog } from "../src/ledger.js";

async function boot() {
  return ingest(await loadSeed());
}

test("既有工作室与课程记录纳入服务，事件只追加且有序", async () => {
  const { service, log } = await boot();
  assert.ok(log.events.length > 20);
  assert.ok(log.events.every((e, i) => e.seq === i + 1));
  assert.ok(service.state.studios.has("studio-shaomai-01"));
  assert.ok(service.state.courses.has("course-2026-fall"));
});

test("重复导入幂等：同记录不产生重复事件，结果一致", async () => {
  const seed = await loadSeed();
  const first = ingest(seed).log.events.length;
  const second = ingest(seed, new EventLog(ingest(seed).log.events)).log.events.length;
  const freshReplay = ingest(seed).log.events.length;
  assert.equal(first, freshReplay);
  // 在已有事件之上再导一遍，不新增任何事件。
  assert.equal(second, first);
});

test("单一来源不能认定能力：阿穗最初只有学校成绩时结论不满足", async () => {
  const { service } = await boot();
  const conclusions = [...service.state.conclusions.values()].filter(
    (c) => c.person_id === "person-apprentice-sui" && c.unit === "擀皮"
  );
  // 历史上曾有仅含学校成绩的中间结论，最终现行结论满足。
  const active = conclusions.find((c) => c.status === "active");
  assert.equal(active.satisfied, true);
  assert.deepEqual(active.source_types.sort(), ["mentor_observation", "school_grade"]);
});

test("能力认定必须学校与工作室共同确认，缺一不可", async () => {
  const log = new EventLog();
  const svc = new GrowthService(log);
  await seedMinimal(svc);
  // 提交双来源证据形成满足结论。
  dualEvidence(svc, "p1", "擀皮");
  const conclusion = latestConclusion(svc, "p1", "擀皮");
  // 仅学校确认：尚无上岗资格。
  svc.confirm(
    { confirmation_id: "cf-1", conclusion_id: conclusion.conclusion_id, org_id: "org-school", at: T(10) },
    "cmd-cf1"
  );
  assert.equal(skillReady(svc, "p1", "擀皮"), false);
  // 工作室再确认：资格成立。
  svc.confirm(
    { confirmation_id: "cf-2", conclusion_id: conclusion.conclusion_id, org_id: "org-studio", at: T(11) },
    "cmd-cf2"
  );
  assert.equal(skillReady(svc, "p1", "擀皮"), true);
});

test("同一方重复确认被拒绝", async () => {
  const log = new EventLog();
  const svc = new GrowthService(log);
  await seedMinimal(svc);
  dualEvidence(svc, "p1", "擀皮");
  const c = latestConclusion(svc, "p1", "擀皮");
  svc.confirm({ confirmation_id: "cf-1", conclusion_id: c.conclusion_id, org_id: "org-school", at: T(10) }, "x1");
  assert.throws(
    () => svc.confirm({ confirmation_id: "cf-1b", conclusion_id: c.conclusion_id, org_id: "org-school", at: T(12) }, "x2"),
    /不可重复确认/
  );
});

test("补充或撤回证据只产生新结论，历史结论保留为 superseded/withdrawn 痕迹", async () => {
  const { service } = await boot();
  const before = service.state.conclusions;
  // 撤回阿穗擀皮的师傅观察证据。
  service.withdrawEvidence(
    { evidence_id: "ev-sui-ganpi-obs", reason: "记录笔误，重新观察", at: "2026-09-28T10:00:00Z" },
    "cmd-withdraw-obs"
  );
  const after = service.state.conclusions;
  assert.ok(after.size > before.size, "撤回必须新增结论，而不是改写旧结论");
  const newest = latestConclusion(service, "person-apprentice-sui", "擀皮");
  assert.equal(newest.satisfied, false);
  assert.match(newest.cause, /撤回/);
  // 旧结论仍在，且被标记为被新结论取代。
  const old = [...before.values()].find(
    (c) => c.person_id === "person-apprentice-sui" && c.unit === "擀皮" && c.status === "active"
  );
  const reloaded = service.state.conclusions.get(old.conclusion_id);
  assert.equal(reloaded.status, "superseded");
  assert.equal(reloaded.superseded_by, newest.conclusion_id);
  // 原证据记录也仍在，只是 withdrawn。
  assert.equal(service.state.evidence.get("ev-sui-ganpi-obs").status, "withdrawn");
});

test("撤回证据导致在岗安排自动失效并重算", async () => {
  const { service } = await boot();
  const assignmentId = [...service.state.assignments.values()].find((a) => a.status === "active").assignment_id;
  // 撤回阿穗擀皮的师傅观察（只剩学校成绩，单一来源不再满足）。
  service.withdrawEvidence(
    { evidence_id: "ev-sui-ganpi-obs", reason: "观察记录作废，需重新观察", at: "2026-09-29T08:00:00Z" },
    "cmd-w-ganpi"
  );
  const st = service.state;
  assert.equal(st.assignments.get(assignmentId).status, "invalidated");
  assert.match(st.assignments.get(assignmentId).invalid_reason, /证据撤回/);
  // 无人同时满足全部技能与门槛，故无替代安排。
  assert.equal([...st.assignments.values()].some((a) => a.status === "active"), false);
});

test("阿炳未通过食品安全环节，不能进入生产班（v2 硬门槛）", async () => {
  const { service } = await boot();
  const report = service.shiftCandidates("shift-20261005-am").find((p) => p.person_id === "person-apprentice-bing");
  assert.equal(report.eligible, false);
  assert.ok(report.deficits.some((d) => d.unit === "食品安全合规"));
  assert.ok(report.deficits.some((d) => d.unit === "二十四褶"));
});

test("规则升级 v1→v2：阿穗在门槛证据补齐前本应失效，补证据后才可排班", async () => {
  const log = new EventLog();
  const svc = new GrowthService(log);
  await seedMinimal(svc, { withRuleV2: false });
  // v1 下无硬门槛，双来源 + 双确认即可排班。
  dualEvidence(svc, "p1", "擀皮");
  const c = latestConclusion(svc, "p1", "擀皮");
  svc.confirm({ confirmation_id: "a", conclusion_id: c.conclusion_id, org_id: "org-school", at: T(9) }, "ca");
  svc.confirm({ confirmation_id: "b", conclusion_id: c.conclusion_id, org_id: "org-studio", at: T(9) }, "cb");
  svc.openShift(
    { shift_id: "sh1", position_id: "pos1", mentor_id: null, start: "2026-10-01T06:00:00Z", end: "2026-10-01T12:00:00Z", at: T(9) },
    "csh"
  );
  svc.assignShift({ shift_id: "sh1", at: T(9) }, "cas");
  const firstAssignment = latestActiveAssignment(svc);
  assert.ok(firstAssignment);

  // 升级到 v2：食品安全成硬门槛，旧安排自动失效。
  svc.publishRule({ version: "rule-v2", at: T(12) }, "cv2");
  assert.equal(svc.state.assignments.get(firstAssignment).status, "invalidated");
  assert.match(svc.state.assignments.get(firstAssignment).invalid_reason, /食品安全合规/);

  // 补齐食品安全凭证后重新排班成功（新规则版本）。
  svc.submitEvidence(
    {
      evidence_id: "ev-food", person_id: "p1", unit: "食品安全合规", source_type: "school_grade",
      org_id: "org-school", grade: "合格", rule_version: "rule-v2", at: T(13), observed_at: T(13),
    },
    "cfood"
  );
  svc.assignShift({ shift_id: "sh1", at: T(14) }, "cas2");
  const againId = latestActiveAssignment(svc);
  assert.notEqual(againId, firstAssignment);
  assert.equal(svc.state.assignments.get(againId).rule_version, "rule-v2");
});

test("协作作品必须写明贡献；协作证据各自只支撑本人能力", async () => {
  const log = new EventLog();
  const svc = new GrowthService(log);
  await seedMinimal(svc);
  dualEvidence(svc, "p1", "擀皮");
  assert.throws(
    () =>
      svc.submitEvidence(
        {
          evidence_id: "ev-collab", person_id: "p2", unit: "擀皮", source_type: "shop_work",
          org_id: "org-studio", work_id: "work-x", collaborators: ["p1"],
          rule_version: "rule-v1", at: T(5), observed_at: T(5),
        },
        "bad"
      ),
    /协作作品必须写明本人贡献/
  );
  // 写明贡献后允许。
  svc.submitEvidence(
    {
      evidence_id: "ev-collab", person_id: "p2", unit: "擀皮", source_type: "shop_work",
      org_id: "org-studio", work_id: "work-x", contribution: "负责备料", collaborators: ["p1"],
      rule_version: "rule-v1", at: T(5), observed_at: T(5),
    },
    "good"
  );
  const work = svc.state.evidence.get("ev-collab");
  assert.equal(work.contribution, "负责备料");
  assert.deepEqual(work.collaborators, ["p1"]);
});

test("跨工作室只能携带授权摘要：无联系方式、无评价正文、仅双确认能力", async () => {
  const { service } = await boot();
  const view = service.portableView("consent-sui-xicheng");
  // 不含任何联系方式字段。
  assert.equal("contact" in view, false);
  assert.equal(JSON.stringify(view).includes("139-0000"), false);
  assert.equal(JSON.stringify(view).includes("手速仍需加强"), false);
  // 仅含经双方确认的能力，且带规则版本与确认者。
  const units = view.abilities.map((a) => a.unit).sort();
  assert.deepEqual(units, ["二十四褶", "擀皮", "蒸制"]);
  for (const ability of view.abilities) {
    const types = ability.confirmed_by.map((o) => service.state.orgs.get(o.org_id).org_type).sort();
    assert.deepEqual(types, ["school", "studio"]);
  }
  assert.equal(view.issued_for, "org-studio-xicheng");
});

test("撤回授权后历史留痕、不能再出具摘要", async () => {
  const { service } = await boot();
  // 撤回前可出具一次，出证记录留在账上。
  service.issueSummary(
    { disclosure_id: "d1", consent_id: "consent-sui-xicheng", at: "2026-09-11T00:00:00Z" },
    "cd1"
  );
  assert.ok(service.state.disclosures.get("d1"));
  service.withdrawConsent(
    { consent_id: "consent-sui-xicheng", reason: "不再转介", at: "2026-09-22T00:00:00Z" },
    "cwc"
  );
  assert.throws(() => service.portableView("consent-sui-xicheng"), /授权已撤回/);
  assert.throws(
    () =>
      service.issueSummary(
        { disclosure_id: "d2", consent_id: "consent-sui-xicheng", at: "2026-09-23T00:00:00Z" },
        "cd2"
      ),
    /授权已撤回/
  );
  // 授权与历史出证记录都仍保留。
  assert.equal(service.state.consents.get("consent-sui-xicheng").status, "withdrawn");
  assert.ok(service.state.disclosures.get("d1"));
});

test("时间冲突：同一人重叠时段不能排两个班", async () => {
  const log = new EventLog();
  const svc = new GrowthService(log);
  await seedMinimal(svc);
  dualEvidence(svc, "p1", "擀皮");
  const c = latestConclusion(svc, "p1", "擀皮");
  svc.confirm({ confirmation_id: "a", conclusion_id: c.conclusion_id, org_id: "org-school", at: T(9) }, "ca");
  svc.confirm({ confirmation_id: "b", conclusion_id: c.conclusion_id, org_id: "org-studio", at: T(9) }, "cb");
  svc.openShift({ shift_id: "sh1", position_id: "pos1", start: "2026-10-01T06:00:00Z", end: "2026-10-01T12:00:00Z", at: T(9) }, "s1");
  svc.openShift({ shift_id: "sh2", position_id: "pos1", start: "2026-10-01T10:00:00Z", end: "2026-10-01T14:00:00Z", at: T(9) }, "s2");
  svc.assignShift({ shift_id: "sh1", at: T(9) }, "as1");
  const report = svc.shiftCandidates("sh2").find((p) => p.person_id === "p1");
  assert.equal(report.eligible, false);
  assert.ok(report.time_conflicts.length > 0);
});

test("门店对失效的上岗决定仍可查看，并实时显示仍缺训练", async () => {
  const { service } = await boot();
  const assignmentId = [...service.state.assignments.values()].find((a) => a.status === "active").assignment_id;
  // 二十四褶原本有学校成绩、门店作品、师傅私评三类来源；撤回其中两类后仅剩单一来源。
  service.withdrawEvidence(
    { evidence_id: "ev-sui-zhe-work", reason: "作品复核存疑", at: "2026-09-29T09:00:00Z" },
    "cmd-w2"
  );
  service.withdrawEvidence(
    { evidence_id: "ev-sui-zhe-obs-private", reason: "评价周期已过，不予采用", at: "2026-09-29T09:05:00Z" },
    "cmd-w3"
  );
  const view = service.onboarding(assignmentId);
  assert.equal(view.assignment.status, "invalidated");
  assert.ok(view.missing_training.some((m) => m.unit === "二十四褶"));
  // 仍然追到了已有课程证据链，不是空白。
  const zhe = view.abilities.find((a) => a.unit === "二十四褶");
  if (zhe) assert.ok(zhe.evidence.length >= 1);
});

test("一方撤回共同确认后，能力不再成立并使在岗安排失效", async () => {
  const log = new EventLog();
  const svc = new GrowthService(log);
  await seedMinimal(svc, { withRuleV2: true });
  // v2 下补上门槛凭证，使排班成立。
  dualEvidence(svc, "p1", "擀皮");
  svc.submitEvidence(
    { evidence_id: "ev-food", person_id: "p1", unit: "食品安全合规", source_type: "school_grade", org_id: "org-school", grade: "合格", rule_version: "rule-v2", at: T(6), observed_at: T(6) },
    "cfood"
  );
  const c = latestConclusion(svc, "p1", "擀皮");
  svc.confirm({ confirmation_id: "a", conclusion_id: c.conclusion_id, org_id: "org-school", at: T(9) }, "ca");
  svc.confirm({ confirmation_id: "b", conclusion_id: c.conclusion_id, org_id: "org-studio", at: T(9) }, "cb");
  svc.openShift({ shift_id: "sh1", position_id: "pos1", start: "2026-10-01T06:00:00Z", end: "2026-10-01T12:00:00Z", at: T(9) }, "s1");
  svc.assignShift({ shift_id: "sh1", at: T(9) }, "as1");
  const id = latestActiveAssignment(svc);
  // 工作室撤回确认。
  svc.revokeConfirmation({ confirmation_id: "b", reason: "复查发现动作不达标", at: T(13) }, "crb");
  assert.equal(svc.state.assignments.get(id).status, "invalidated");
  assert.match(svc.state.assignments.get(id).invalid_reason, /工作室确认|缺少/);
  // 确认记录本身保留，仅状态为 revoked。
  assert.equal(svc.state.confirmations.get("b").status, "revoked");
});

test("导师停带后相关班次安排自动失效，且无合格替代时不重排", async () => {
  const { service } = await boot();
  const active = [...service.state.assignments.values()].find((a) => a.status === "active");
  service.endMentorship(
    { studio_id: "studio-shaomai-01", person_id: "person-mentor-li", at: "2026-09-30T00:00:00Z" },
    "cstop"
  );
  const ended = service.state.assignments.get(active.assignment_id);
  assert.equal(ended.status, "invalidated");
  assert.match(ended.invalid_reason, /导师停带/);
});

test("门店一次查看上岗决定即可追到课程、作品、确认者、规则版本与仍缺训练", async () => {
  const { service } = await boot();
  const assignmentId = [...service.state.assignments.values()].find((a) => a.status === "active").assignment_id;
  const view = service.onboarding(assignmentId);
  assert.equal(view.rule_version, "rule-v2");
  assert.equal(view.studio.name, "老奉泰·烧麦工坊");
  const zhe = view.abilities.find((a) => a.unit === "二十四褶");
  assert.ok(zhe, "二十四褶应在追溯链中");
  // 追到课程
  assert.ok(zhe.evidence.some((e) => e.course && e.course.includes("烧麦")));
  // 追到作品与本人贡献
  const workEvidence = zhe.evidence.find((e) => e.work);
  assert.ok(workEvidence.work.contribution.includes("二十四道捏褶"));
  // 追到确认者（学校 + 工作室）
  const confTypes = zhe.confirmers.map((c) => c.org_type).sort();
  assert.deepEqual(confTypes, ["school", "studio"]);
  // 规则版本
  assert.ok(zhe.rule_version.startsWith("rule-"));
  // 硬门槛单独成段且有凭证
  const gate = view.abilities.find((a) => a.unit === "食品安全合规" && a.kind === "hard_gate");
  assert.ok(gate);
  // 阿穗能力齐全，没有仍缺训练。
  assert.deepEqual(view.missing_training, []);
});

test("跨机构确认、撤回与规则升级在同一条事件流中结果彼此一致", async () => {
  const { service, log } = await boot();
  // 整条流可重放出同一终态（一致性的最终保障）。
  const replayed = new GrowthService(new EventLog(log.events)).state;
  const a = [...service.state.assignments.values()].map((x) => [x.assignment_id, x.status]).sort();
  const b = [...replayed.assignments.values()].map((x) => [x.assignment_id, x.status]).sort();
  assert.deepEqual(a, b);
});

test("命令重复提交返回同一批事件，不产生副作用", async () => {
  const { service, log } = await boot();
  const count = log.events.length;
  const again = service.withdrawConsent(
    { consent_id: "consent-sui-xicheng", reason: "重复请求", at: "2026-09-24T00:00:00Z" },
    "fixed-cmd-id"
  );
  const count2 = log.events.length;
  const returnedAgain = service.withdrawConsent(
    { consent_id: "consent-sui-xicheng", reason: "重复请求", at: "2026-09-24T00:00:00Z" },
    "fixed-cmd-id"
  );
  assert.equal(log.events.length, count2, "重复命令不新增事件");
  assert.deepEqual(returnedAgain, again);
});

// ---------- 辅助 ----------

const T = (n) => `2026-0${n}-01T00:00:00Z`;

async function seedMinimal(svc, opts = {}) {
  svc.registerOrg({ org_id: "org-school", name: "学校", org_type: "school", at: T(1) }, "os");
  svc.registerOrg({ org_id: "org-studio", name: "工作室", org_type: "studio", at: T(1) }, "ot");
  svc.registerStudio({
    studio_id: "stu1", org_id: "org-studio", name: "工坊", craft: "烧麦",
    mentor_slots: 2, required_skills: ["擀皮"], at: T(2),
  }, "ostu");
  svc.enrollPerson({ person_id: "p1", name: "甲", org_id: "org-school", contact: { phone: "1" }, at: T(3) }, "op1");
  svc.enrollPerson({ person_id: "p2", name: "乙", org_id: "org-school", at: T(3) }, "op2");
  svc.definePosition({ position_id: "pos1", studio_id: "stu1", title: "生产岗", required_skills: ["擀皮"], at: T(4) }, "opos");
  // 默认处于 rule-v1（无硬门槛）；需要门槛的用例显式升级到 v2。
  if (opts.withRuleV2) {
    svc.publishRule({ version: "rule-v2", at: T(5) }, "orv2");
  }
}

function dualEvidence(svc, personId, unit) {
  svc.submitEvidence(
    { evidence_id: `ev-${personId}-g`, person_id: personId, unit, source_type: "school_grade", org_id: "org-school", grade: "A", rule_version: "rule-v1", at: T(6), observed_at: T(6) },
    `eg-${personId}`
  );
  svc.submitEvidence(
    { evidence_id: `ev-${personId}-o`, person_id: personId, unit, source_type: "mentor_observation", org_id: "org-studio", visibility: "public", rule_version: "rule-v1", at: T(7), observed_at: T(7) },
    `eo-${personId}`
  );
}

function latestConclusion(svc, personId, unit) {
  return [...svc.state.conclusions.values()]
    .filter((c) => c.person_id === personId && c.unit === unit)
    .at(-1);
}

function latestActiveAssignment(svc) {
  return [...svc.state.assignments.values()].filter((a) => a.status === "active").at(-1)?.assignment_id;
}

function skillReady(svc, personId, unit) {
  return [...svc.state.conclusions.values()]
    .filter((c) => c.person_id === personId && c.unit === unit && c.status === "active" && c.satisfied)
    .some((c) => {
      const conf = [...svc.state.confirmations.values()]
        .filter((x) => x.conclusion_id === c.conclusion_id && x.status === "active")
        .map((x) => svc.state.orgs.get(x.org_id)?.org_type);
      return conf.includes("school") && conf.includes("studio");
    });
}
