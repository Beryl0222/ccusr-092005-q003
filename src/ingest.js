import { GrowthService } from "./service.js";
import { EventLog } from "./ledger.js";

// 把既有工作室与课程记录纳入服务。每条记录以自身 id 作为 command_id，
// 重复导入返回首次结果，不产生重复事件（重复提交结果一致）。
export function ingest(seed, log = new EventLog()) {
  const svc = new GrowthService(log);
  const ctx = { confirmationPairs: new Map(), assignments: [] };

  for (const r of seed.records) {
    dispatch(svc, r, ctx);
  }
  // 双确认需要引用结论 id，统一在证据全部导入、结论全部产生之后落确认事件。
  for (const pair of ctx.confirmationPairs.values()) {
    recordJointConfirmation(svc, pair);
  }
  // 建班放在最后，保证排班时证据、确认、规则版本都已就位。
  for (const pending of ctx.assignments) {
    svc.assignShift(
      { shift_id: pending.shift_id, at: pending.at },
      `cmd:${pending.id}`
    );
  }
  return { log, service: svc };
}

function dispatch(svc, r, ctx) {
  const cmd = `cmd:${r.id}`;
  switch (r.kind) {
    case "org":
      svc.registerOrg(
        { org_id: r.id, name: r.name, org_type: r.org_type, at: r.at },
        cmd
      );
      break;
    case "rule":
      svc.publishRule({ version: r.version, at: r.at }, cmd);
      break;
    case "studio":
      svc.registerStudio(
        {
          studio_id: r.id,
          org_id: r.org_id,
          name: r.name,
          craft: r.craft,
          mentor_slots: r.mentor_slots,
          required_skills: r.required_skills,
          at: r.at,
        },
        cmd
      );
      break;
    case "course":
      svc.defineCourse(
        {
          course_id: r.id,
          school_org_id: r.school_org_id,
          title: r.title,
          stages: r.stages,
          objectives: r.objectives,
          at: r.at,
        },
        cmd
      );
      break;
    case "person":
      svc.enrollPerson(
        { person_id: r.id, name: r.name, org_id: r.org_id, contact: r.contact, at: r.at },
        cmd
      );
      break;
    case "mentor_appointment":
      svc.appointMentor({ studio_id: r.studio_id, person_id: r.person_id, at: r.at }, cmd);
      break;
    case "position":
      svc.definePosition(
        {
          position_id: r.id,
          studio_id: r.studio_id,
          title: r.title,
          required_skills: r.required_skills,
          at: r.at,
        },
        cmd
      );
      break;
    case "evidence":
      svc.submitEvidence({ ...r }, cmd);
      break;
    case "joint_confirmation":
      ctx.confirmationPairs.set(r.id, r);
      break;
    case "consent":
      svc.grantConsent(
        {
          consent_id: r.consent_id,
          person_id: r.person_id,
          target_org_id: r.target_org_id,
          scope: r.scope,
          at: r.at,
        },
        cmd
      );
      break;
    case "shift":
      svc.openShift(
        {
          shift_id: r.shift_id,
          position_id: r.position_id,
          mentor_id: r.mentor_id,
          start: r.start,
          end: r.end,
          at: r.at,
        },
        cmd
      );
      break;
    case "assignment":
      ctx.assignments.push(r);
      break;
    default:
      throw new Error(`未知记录类型：${r.kind}`);
  }
}

function recordJointConfirmation(svc, r) {
  const state = svc.state;
  const conclusion = [...state.conclusions.values()]
    .filter((c) => c.person_id === r.person_id && c.unit === r.unit && c.status === "active")
    .at(-1);
  if (!conclusion) throw new Error(`双确认找不到现行结论：${r.person_id}/${r.unit}`);
  svc.confirm(
    {
      confirmation_id: `${r.id}:school`,
      conclusion_id: conclusion.conclusion_id,
      org_id: r.school_org_id,
      at: r.at,
    },
    `cmd:${r.id}:school`
  );
  svc.confirm(
    {
      confirmation_id: `${r.id}:studio`,
      conclusion_id: conclusion.conclusion_id,
      org_id: r.studio_org_id,
      at: r.at,
    },
    `cmd:${r.id}:studio`
  );
}
