// 能力目录与认定规则。规则只能新版本化，不能改旧版本——历史结论永远按当时规则解释。
//
// sourceWeight：每类证据来源的权重，单一来源即使满分也不能独立认定，
// 必须满足 minimumSources 且来源类型互不相同（学校成绩 / 师傅观察 / 门店作品
// 互不相认的根因即在于此）。
export const RULE_VERSIONS = {
  "rule-v1": {
    version: "rule-v1",
    effective_from: "2026-01-01",
    source_weight: { school_grade: 1, mentor_observation: 1, shop_work: 1 },
    minimum_weight: 2,
    minimum_sources: 2,
    hard_gate: [],
  },
  "rule-v2": {
    version: "rule-v2",
    effective_from: "2026-09-01",
    source_weight: { school_grade: 1, mentor_observation: 1, shop_work: 1 },
    minimum_weight: 2,
    minimum_sources: 2,
    // v2 新增：进入生产班前，食品安全合规为硬性门槛，任何权重都不能替代。
    hard_gate: ["食品安全合规"],
  },
};

export const SKILL_CATALOG = {
  "擀皮": { unit: "擀皮" },
  "二十四褶": { unit: "二十四褶" },
  "蒸制": { unit: "蒸制" },
  "食品安全合规": { unit: "食品安全合规" },
};

export function ruleAt(version) {
  const rule = RULE_VERSIONS[version];
  if (!rule) throw new Error(`未知规则版本：${version}`);
  return rule;
}

// 某能力在给定规则版本下，依据一组有效证据进行评估。
// evidence 条目：{ source_type, unit, weight? }
export function evaluate(ruleVersion, unit, evidence) {
  const rule = typeof ruleVersion === "string" ? ruleAt(ruleVersion) : ruleVersion;
  const relevant = evidence.filter((e) => e.unit === unit);
  const bySource = new Map();
  for (const e of relevant) {
    const w = e.weight ?? rule.source_weight[e.source_type] ?? 0;
    bySource.set(e.source_type, Math.max(bySource.get(e.source_type) ?? 0, w));
  }
  const weight = [...bySource.values()].reduce((a, b) => a + b, 0);
  const sourceTypes = [...bySource.keys()];
  const satisfied =
    weight >= rule.minimum_weight && sourceTypes.length >= rule.minimum_sources;
  return {
    unit,
    rule_version: rule.version,
    satisfied,
    weight,
    source_types: sourceTypes,
    missing: satisfied ? [] : missingSources(rule, sourceTypes),
  };
}

function missingSources(rule, present) {
  const all = Object.keys(rule.source_weight);
  const need = rule.minimum_sources - present.length;
  return need <= 0 ? [] : all.filter((s) => !present.includes(s)).slice(0, need);
}

// 硬性门槛是否通过（如 v2 的食品安全合规）。
export function gatesOpen(ruleVersion, evidence) {
  const rule = typeof ruleVersion === "string" ? ruleAt(ruleVersion) : ruleVersion;
  const blocked = [];
  for (const gate of rule.hard_gate) {
    const has = evidence.some((e) => e.unit === gate);
    if (!has) blocked.push(gate);
  }
  return { open: blocked.length === 0, blocked };
}
