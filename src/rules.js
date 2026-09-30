// 能力认定规则按版本保存。认定结论必须记录作出时适用的规则版本；
// 规则升级只影响升级后的新结论，历史结论保留原版本号，不被改写。
//
// v1（2026-09-01）：单一证据即可认定，不强制食品安全环节。
// v2（2026-09-15）：
//   - 每项能力须同时具备"教学侧"与"工作室侧"两类来源（共同确认）；
//   - 上岗前必须通过食品安全环节；
//   - 协作作品只按本人实际贡献计入。

export const RULE_VERSIONS = {
  "v1": {
    version: "v1",
    effective_from: "2026-09-01T00:00:00.000Z",
    label: "首版规则：单一来源可认定",
    requireDualSource: false,
    requireFoodSafety: false,
  },
  "v2": {
    version: "v2",
    effective_from: "2026-09-15T00:00:00.000Z",
    label: "校室共同确认 + 食品安全准入 + 协作按贡献计",
    requireDualSource: true,
    requireFoodSafety: true,
  },
};

export const LATEST_RULE_VERSION = "v2";

// 来源归属：学校成绩与课程目标属教学侧；师傅观察、门店作品属工作室侧。
export const SOURCE_SIDE = {
  school_grade: "school",
  course_objective: "school",
  mentor_observation: "studio",
  shop_work: "studio",
  food_safety: "school",
};

export function ruleAt(at, known = RULE_VERSIONS) {
  let chosen = null;
  for (const rule of Object.values(known)) {
    if (rule.effective_from <= at && (!chosen || rule.effective_from > chosen.effective_from)) {
      chosen = rule;
    }
  }
  if (!chosen) {
    throw new Error(`日期 ${at} 没有适用的规则版本`);
  }
  return chosen;
}

// 评估单个能力目标在给定规则下的满足情况。
// evidences: [{ skill, sourceType, weight, withdrawn }]
export function evaluateSkill(skill, evidences, rule) {
  const active = evidences.filter((e) => e.skill === skill && !e.withdrawn);
  const supporting = active.filter((e) => (e.weight ?? 1) > 0);

  if (!rule.requireDualSource) {
    return { skill, satisfied: supporting.length > 0, missing: [], rule: rule.version };
  }

  const sides = new Set(supporting.map((e) => SOURCE_SIDE[e.sourceType]).filter(Boolean));
  const missing = [];
  if (!sides.has("school")) missing.push("school");
  if (!sides.has("studio")) missing.push("studio");
  return { skill, satisfied: missing.length === 0, missing, rule: rule.version };
}
